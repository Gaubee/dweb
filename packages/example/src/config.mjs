// Persistent config (~/.opendweb/config.json) + priority resolution
// (design D6): flag > env > file > default, per-key whole-value override.
// File perms: dir 0700 / file 0600 (best effort on Windows); loads tighten
// over-wide permissions with a WARNING; writes are tmp+rename atomic.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { CliError, UsageError } from "./errors.mjs";
import { parseDurationMs, assertDurationRange, expandTilde } from "./args.mjs";

export const CONFIG_KEYS = ["relay", "proxy", "data", "inviteTtlMs", "joinTimeoutMs"];
export const N0_RELAY_URL = "https://relay.iroh.network";
export const TTL_MIN_MS = 1000;
export const TTL_MAX_MS = 30 * 24 * 60 * 60 * 1000; // 30d
export const JOIN_TIMEOUT_MIN_MS = 1000;
export const JOIN_TIMEOUT_MAX_MS = 10 * 60 * 1000; // 10m
export const DEFAULT_INVITE_TTL_MS = 60 * 60 * 1000; // 60m (0.2 default)
export const DEFAULT_JOIN_TIMEOUT_MS = 30_000;

const PROXY_VALUES = ["auto", "on", "off"];
const IS_WIN = process.platform === "win32";

/**
 * @param {string} v
 * @returns {boolean}
 */
export function isHttpUrl(v) {
  if (typeof v !== "string" || v === "") return false;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * @param {{ HOME?: string, USERPROFILE?: string }} [env]
 * @returns {{ dir: string, file: string }}
 */
export function configPaths(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const dir = path.join(home, ".opendweb");
  return { dir, file: path.join(dir, "config.json") };
}

/**
 * Split a comma-separated env URL list: filter empty items, dedupe, keep order.
 * @param {string | undefined} raw
 * @returns {string[]}
 */
export function parseEnvUrlList(raw) {
  if (raw === undefined || raw === "") return [];
  const seen = new Set();
  const out = [];
  for (const item of raw.split(",")) {
    const v = item.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * Validate the parsed config object shape. Throws CliError with the frozen
 * `error: invalid config file <path>: <reason>` message on any problem
 * (unknown key, wrong type, out-of-range value).
 * @param {unknown} obj
 * @param {string} filePath
 */
export function validateConfigObject(obj, filePath) {
  const bad = (reason) => new CliError(`error: invalid config file ${filePath}: ${reason}`);
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw bad("expected a JSON object");
  }
  for (const key of Object.keys(obj)) {
    if (!CONFIG_KEYS.includes(key)) {
      throw bad(`unknown key "${key}" (known: ${CONFIG_KEYS.join(", ")})`);
    }
  }
  const o = /** @type {Record<string, unknown>} */ (obj);
  if (o.relay !== undefined) {
    const list = Array.isArray(o.relay) ? o.relay : [o.relay];
    if (typeof o.relay !== "string" && !Array.isArray(o.relay)) {
      throw bad("relay must be a string or an array of http(s) URLs");
    }
    if (Array.isArray(o.relay) && o.relay.length === 0) {
      throw bad("relay must be a non-empty string or a non-empty array of http(s) URLs");
    }
    for (const [i, v] of list.entries()) {
      if (typeof v !== "string" || !isHttpUrl(v)) {
        throw bad(`relay${Array.isArray(o.relay) ? `[${i}]` : ""} is not a valid http(s) URL: ${String(v)}`);
      }
    }
  }
  if (o.proxy !== undefined && !PROXY_VALUES.includes(/** @type {string} */ (o.proxy))) {
    throw bad(`proxy must be one of auto|on|off, got: ${String(o.proxy)}`);
  }
  if (o.data !== undefined && (typeof o.data !== "string" || o.data === "")) {
    throw bad("data must be a non-empty string");
  }
  if (o.inviteTtlMs !== undefined) {
    const v = o.inviteTtlMs;
    if (typeof v !== "number" || !Number.isFinite(v) || v < TTL_MIN_MS || v > TTL_MAX_MS) {
      throw bad(`inviteTtlMs out of range (1s..30d): ${String(v)}`);
    }
  }
  if (o.joinTimeoutMs !== undefined) {
    const v = o.joinTimeoutMs;
    if (typeof v !== "number" || !Number.isFinite(v) || v < JOIN_TIMEOUT_MIN_MS || v > JOIN_TIMEOUT_MAX_MS) {
      throw bad(`joinTimeoutMs out of range (1s..10m): ${String(v)}`);
    }
  }
}

/**
 * Load (and validate) the config file. Tightens over-wide permissions on
 * POSIX and returns warnings; missing file is an empty config.
 * @param {string} filePath
 * @returns {{ config: Record<string, unknown>, warnings: string[] }}
 */
export function loadConfigFile(filePath) {
  const warnings = [];
  if (!fs.existsSync(filePath)) return { config: {}, warnings };
  if (!IS_WIN) {
    const dir = path.dirname(filePath);
    try {
      const dirMode = fs.statSync(dir).mode & 0o777;
      if (dirMode & 0o077) {
        fs.chmodSync(dir, 0o700);
        warnings.push(`config directory permissions were too open; tightened to 0700 (${dir})`);
      }
    } catch {
      /* best effort */
    }
    try {
      const fileMode = fs.statSync(filePath).mode & 0o777;
      if (fileMode & 0o077) {
        fs.chmodSync(filePath, 0o600);
        warnings.push(`config file permissions were too open; tightened to 0600 (${filePath})`);
      }
    } catch {
      /* best effort */
    }
  }
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    throw new CliError(`error: cannot read config file ${filePath}: ${e.message}`);
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new CliError(`error: invalid config file ${filePath}: ${e.message}`);
  }
  validateConfigObject(obj, filePath);
  return { config: obj, warnings };
}

/**
 * Atomic tmp+rename write with 0600 file / 0700 directory.
 * @param {string} filePath
 * @param {Record<string, unknown>} obj
 */
export function writeConfigFileAtomic(filePath, obj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!IS_WIN) {
    try {
      fs.chmodSync(dir, 0o700); // mkdir mode is umask-masked; enforce explicitly
    } catch {
      /* best effort */
    }
  }
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
    if (!IS_WIN) fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw new CliError(`error: cannot write config file ${filePath}: ${e.message}`);
  }
}

/**
 * Resolve effective settings. `flags` values are already parsed/validated
 * (durations in ms, proxy enum checked); env/file errors throw here.
 * @param {{ flags?: { data?: string, relay?: string[], proxy?: string, ttlMs?: number, joinTimeoutMs?: number }, env?: Record<string, string | undefined>, file?: Record<string, unknown> }} input
 * @returns {{
 *   data: { value: string, source: string },
 *   relay: { mode: "disabled" | "custom" | "n0", urls: string[], source: string },
 *   proxy: { value: "auto" | "on" | "off", source: string },
 *   inviteTtlMs: { value: number, source: string },
 *   joinTimeoutMs: { value: number, source: string },
 * }}
 */
export function resolveSettings({ flags = {}, env = process.env, file = {} } = {}) {
  // ---- data -------------------------------------------------------------
  const data =
    flags.data !== undefined
      ? { value: flags.data, source: "flag" }
      : env.DWEB_DATA
        ? { value: env.DWEB_DATA, source: "env" }
        : file.data !== undefined
          ? { value: /** @type {string} */ (file.data), source: "file" }
          : { value: "~/.dweb-example", source: "default" };

  // ---- relay ------------------------------------------------------------
  /** @type {{ mode: "disabled" | "custom" | "n0", urls: string[], source: string }} */
  let relay;
  if (flags.relay && flags.relay.length > 0) {
    relay = { mode: "custom", urls: [...flags.relay], source: "flag" };
  } else if (env.DWEB_RELAY !== undefined && env.DWEB_RELAY !== "") {
    const v = env.DWEB_RELAY;
    if (v === "disabled") {
      relay = { mode: "disabled", urls: [], source: "env" };
    } else if (v === "n0") {
      relay = { mode: "n0", urls: [N0_RELAY_URL], source: "env" };
    } else if (v === "custom") {
      const urls = parseEnvUrlList(env.DWEB_RELAY_URLS);
      if (urls.length === 0) {
        throw new CliError("error: DWEB_RELAY=custom requires DWEB_RELAY_URLS");
      }
      relay = { mode: "custom", urls, source: "env" };
    } else {
      throw new CliError(`error: invalid DWEB_RELAY value: ${v} (expected disabled|custom|n0)`);
    }
  } else if (env.DWEB_RELAY_URLS !== undefined) {
    // DWEB_RELAY absent but URLS present: implicit custom.
    const urls = parseEnvUrlList(env.DWEB_RELAY_URLS);
    if (urls.length === 0) {
      throw new CliError("error: DWEB_RELAY_URLS is set but contains no usable URL");
    }
    relay = { mode: "custom", urls, source: "env" };
  } else if (file.relay !== undefined) {
    const list = Array.isArray(file.relay) ? file.relay : [file.relay];
    const seen = new Set();
    const urls = [];
    for (const v of list) {
      if (!seen.has(v)) {
        seen.add(v);
        urls.push(v);
      }
    }
    relay = { mode: "custom", urls, source: "file" };
  } else {
    relay = { mode: "disabled", urls: [], source: "default" };
  }

  // ---- proxy ------------------------------------------------------------
  /** @type {{ value: string, source: string }} */
  let proxy;
  if (flags.proxy !== undefined) {
    proxy = { value: flags.proxy, source: "flag" }; // validated at flag extraction
  } else if (env.DWEB_PROXY !== undefined && env.DWEB_PROXY !== "") {
    if (!PROXY_VALUES.includes(env.DWEB_PROXY)) {
      throw new CliError(`error: invalid DWEB_PROXY value: ${env.DWEB_PROXY} (expected auto|on|off)`);
    }
    proxy = { value: env.DWEB_PROXY, source: "env" };
  } else if (file.proxy !== undefined) {
    proxy = { value: /** @type {string} */ (file.proxy), source: "file" };
  } else {
    proxy = { value: "auto", source: "default" };
  }

  // ---- invite ttl ---------------------------------------------------------
  const inviteTtlMs =
    flags.ttlMs !== undefined
      ? { value: flags.ttlMs, source: "flag" }
      : file.inviteTtlMs !== undefined
        ? { value: /** @type {number} */ (file.inviteTtlMs), source: "file" }
        : { value: DEFAULT_INVITE_TTL_MS, source: "default" };

  // ---- join timeout -------------------------------------------------------
  const joinTimeoutMs =
    flags.joinTimeoutMs !== undefined
      ? { value: flags.joinTimeoutMs, source: "flag" }
      : file.joinTimeoutMs !== undefined
        ? { value: /** @type {number} */ (file.joinTimeoutMs), source: "file" }
        : { value: DEFAULT_JOIN_TIMEOUT_MS, source: "default" };

  return {
    data,
    relay,
    proxy: /** @type {any} */ (proxy),
    inviteTtlMs,
    joinTimeoutMs,
  };
}

/**
 * @param {{ mode: string, urls: string[] }} relay
 * @returns {string}
 */
export function relayDisplay(relay) {
  if (relay.mode === "disabled") return "disabled";
  if (relay.mode === "n0") return `n0 ${N0_RELAY_URL}`;
  return relay.urls.join(",");
}

/**
 * @param {ReturnType<typeof resolveSettings>} settings
 * @returns {string[]}
 */
export function configListLines(settings) {
  const rows = [
    ["relay", relayDisplay(settings.relay), settings.relay.source],
    ["proxy", settings.proxy.value, settings.proxy.source],
    ["data", settings.data.value, settings.data.source],
    ["inviteTtlMs", String(settings.inviteTtlMs.value), settings.inviteTtlMs.source],
    ["joinTimeoutMs", String(settings.joinTimeoutMs.value), settings.joinTimeoutMs.source],
  ];
  const w = Math.max(...rows.map((r) => r[0].length));
  return rows.map(([k, v, s]) => `${k.padEnd(w)} = ${v} (${s})`);
}

/**
 * Validate + coerce one `config set <key> <value>` write.
 * @param {string} key
 * @param {string[]} values
 * @param {{ homedir?: string }} [ctx]
 * @returns {Record<string, unknown>} partial object to merge into the file
 */
export function configSetValue(key, values, ctx = {}) {
  const homedir = ctx.homedir ?? os.homedir();
  if (key === "relay") {
    if (values.length === 0) {
      throw new CliError("error: config set relay requires at least one URL");
    }
    for (const v of values) {
      if (!isHttpUrl(v)) throw new CliError(`error: invalid relay URL: ${v}`);
    }
    const seen = new Set();
    const urls = values.filter((v) => (seen.has(v) ? false : (seen.add(v), true)));
    return { relay: urls.length === 1 ? urls[0] : urls };
  }
  if (values.length !== 1) {
    throw new UsageError(`error: config set ${key} takes exactly one value`);
  }
  const v = values[0];
  if (key === "proxy") {
    if (!PROXY_VALUES.includes(v)) {
      throw new CliError(`error: invalid proxy value: ${v} (expected auto|on|off)`);
    }
    return { proxy: v };
  }
  if (key === "data") {
    if (v === "") throw new CliError("error: invalid data value: empty string");
    return { data: expandTilde(v, homedir) };
  }
  if (key === "inviteTtlMs") {
    const ms = parseDurationMs(v, "inviteTtlMs");
    assertDurationRange(ms, TTL_MIN_MS, TTL_MAX_MS, "inviteTtlMs", "1s..30d");
    return { inviteTtlMs: Math.round(ms) };
  }
  if (key === "joinTimeoutMs") {
    const ms = parseDurationMs(v, "joinTimeoutMs");
    assertDurationRange(ms, JOIN_TIMEOUT_MIN_MS, JOIN_TIMEOUT_MAX_MS, "joinTimeoutMs", "1s..10m");
    return { joinTimeoutMs: Math.round(ms) };
  }
  throw new CliError(`error: unknown config key: ${key} (known: ${CONFIG_KEYS.join(", ")})`);
}
