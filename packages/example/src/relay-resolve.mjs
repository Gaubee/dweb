// Bootstrap address resolution (design D2 step 3) + the full state machine
// wiring (normalize -> proxy decision -> per-candidate resolve).
//
// Fallback is narrow: ONLY 404 or 200-with-non-JSON marks a candidate as a
// 0.1.0 legacy bare relay URL. Timeouts, 5xx and other 4xx are hard errors
// (`error: gateway <url> unreachable (...)`), never a silent fallback.

import { CliError } from "./errors.mjs";
import { isHttpUrl } from "./config.mjs";
import { httpGet, decideProxyPolicy } from "./proxy.mjs";

/**
 * Step 1: normalize raw relay config values. Every item must be an http(s)
 * URL; anything else is a configuration error. Dedupes, keeps order.
 * @param {string[]} urls
 * @returns {string[]}
 */
export function normalizeRelayInput(urls) {
  const seen = new Set();
  const out = [];
  for (const v of urls) {
    if (!isHttpUrl(v)) throw new CliError(`error: invalid relay URL: ${v}`);
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/** @param {string} u */
function servicesUrl(u) {
  return u.replace(/\/+$/, "") + "/services.json";
}

/**
 * Resolve ONE raw candidate. Throws on malformed manifest (hard error per D2);
 * probeRelayUrls normalizes per-item. Outcomes:
 *  - gateway : services.json parsed, relay enabled with a usable URL
 *  - legacy  : 404 or 200-non-JSON -> bare 0.1.0 relay URL
 *  - disabled: gateway reachable but relay disabled / url null / no relay entry
 *  - unreachable: transport-level failure or 5xx/non-404 4xx (hard error)
 * @param {string} url
 * @param {{ policy?: "none" | "from-env", httpGet?: typeof httpGet, timeoutMs?: number, env?: Record<string, string | undefined> }} [opts]
 * @returns {Promise<{ kind: "gateway" | "legacy", url: string } | { kind: "disabled", warning: string } | { kind: "unreachable", reason: string }>}
 */
export async function resolveOneRelay(url, opts = {}) {
  const { policy = "none", httpGet: doGet = httpGet, timeoutMs = 3000, env = process.env } = opts;
  const r = await doGet(servicesUrl(url), { policy, timeoutMs, env });
  if (!r.ok) return { kind: "unreachable", reason: r.reason };
  if (r.status === 404) return { kind: "legacy", url };
  if (r.status !== 200) return { kind: "unreachable", reason: `http ${r.status}` };
  let manifest = null;
  let parseOk = false;
  try {
    const parsed = JSON.parse(r.body);
    parseOk = true;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      manifest = parsed;
    }
  } catch {
    /* non-JSON body -> legacy (D2 冻结的唯一 200 回退形态) */
  }
  if (!parseOk) return { kind: "legacy", url };
  // R4 P1-4：合法 JSON 但非 manifest 对象（数组/标量/null）= 网关协议错误，
  // 不再静默当作旧 relay 回退（只有响应体不是 JSON 才允许 legacy）。
  if (manifest === null) {
    throw new Error(`gateway ${url} returned JSON but not a services manifest`);
  }
  // R7 P1-2：required-field 校验——合法 JSON 对象但缺失/非数组 services 是
  // malformed manifest（硬错误），不得静默降级为 disabled 掩盖部署错误。
  if (!Array.isArray(manifest.services)) {
    throw new Error(
      `gateway ${url} returned invalid services manifest: services must be an array`,
    );
  }
  const services = manifest.services;
  // Duplicate service names: first entry wins (server-side warns).
  const entry = services.find(
    (/** @type {any} */ s) => s !== null && typeof s === "object" && s.name === "relay",
  );
  if (!entry) return { kind: "disabled", warning: `gateway ${url} lists no relay service` };
  if (entry.enabled === false) {
    return { kind: "disabled", warning: `gateway ${url} reports relay disabled` };
  }
  if (typeof entry.url !== "string" || !isHttpUrl(entry.url)) {
    return { kind: "disabled", warning: `relay entry has no reachable url (gateway ${url})` };
  }
  return { kind: "gateway", url: entry.url };
}

/**
 * Step 3 for a full candidate list. Per-item independent resolution; any
 * unreachable candidate fails the whole startup (no partial rescue). Result
 * URL list is deduped. All-disabled candidate sets yield mode "disabled".
 * @param {string[]} candidates
 * @param {{ policy?: "none" | "from-env", httpGet?: typeof httpGet, timeoutMs?: number, env?: Record<string, string | undefined> }} [opts]
 * @returns {Promise<{ mode: "custom" | "disabled", urls: string[], warnings: string[] }>}
 */
export async function resolveRelayUrls(candidates, opts = {}) {
  const outcomes = await Promise.all(candidates.map((u) => resolveOneRelay(u, opts)));
  const urls = [];
  const warnings = [];
  let sawDisabledSignal = false;
  let sawDisabledEntry = false;
  const seen = new Set();
  for (let i = 0; i < outcomes.length; i++) {
    const oc = outcomes[i];
    if (oc.kind === "gateway" || oc.kind === "legacy") {
      if (!seen.has(oc.url)) {
        seen.add(oc.url);
        urls.push(oc.url);
      }
    } else if (oc.kind === "disabled") {
      sawDisabledSignal = true;
      if (oc.warning.includes("reports relay disabled") || oc.warning.includes("lists no relay service")) {
        sawDisabledEntry = true;
      }
      warnings.push(`${oc.warning}; ignoring this candidate`);
    } else {
      throw new CliError(`error: gateway ${candidates[i]} unreachable (${oc.reason})`);
    }
  }
  if (urls.length === 0 && sawDisabledSignal) {
    // Every candidate reports the relay disabled (or without a usable URL):
    // enter disabled mode; the canonical summary line only for real
    // disabled-entry cases (nullable-url cases keep their per-item warning).
    if (sawDisabledEntry) warnings.push("gateway reports relay disabled; running without relay");
    return { mode: "disabled", urls: [], warnings };
  }
  return { mode: "custom", urls, warnings };
}

/**
 * The complete D2 state machine, driven by resolved settings. Produces the
 * SDK-facing relay options and the explicit httpProxy policy (decided before
 * Fabric construction; iroh itself never reads proxy env vars).
 *
 * - disabled: no requests at all, policy none
 * - n0: uses the official iroh relay, no public-availability probing
 * - custom: normalize -> proxy decision -> per-candidate resolve
 * @param {{ relay: { mode: string, urls: string[] }, proxy: { value: "auto" | "on" | "off" } }} settings
 * @param {{ env?: Record<string, string | undefined>, httpGet?: typeof httpGet }} [opts]
 * @returns {Promise<{ relayOpts: { mode: string, urls?: string[] }, httpProxy: "none" | "from-env", warnings: string[] }>}
 */
export async function bootstrapRelay(settings, opts = {}) {
  const { env = process.env, httpGet: doGet = httpGet } = opts;
  const relay = settings.relay;
  // n0/disabled 在 proxy 决策之前短路（P1-3）：官方 relay/禁用不探测，
  // policy 恒 none——proxy=on 不应在这两种模式下报错。
  if (relay.mode === "n0") {
    return { relayOpts: { mode: "n0" }, httpProxy: "none", warnings: [] };
  }
  if (relay.mode !== "custom") {
    return { relayOpts: { mode: "disabled" }, httpProxy: "none", warnings: [] };
  }
  const candidates = normalizeRelayInput(relay.urls);
  const proxy = await decideProxyPolicy(candidates, {
    proxySetting: settings.proxy.value,
    env,
    httpGet: doGet,
  });
  const resolved = await resolveRelayUrls(candidates, { policy: proxy.policy, httpGet: doGet, env });
  const relayOpts =
    resolved.mode === "disabled"
      ? { mode: "disabled" }
      : { mode: "custom", urls: resolved.urls };
  return {
    relayOpts,
    httpProxy: proxy.policy === "from-env" ? "from-env" : "none",
    warnings: [...proxy.warnings, ...resolved.warnings],
  };
}

/**
 * Probe used by `config set relay`: per-URL bootstrap resolution + reachability
 * with individual outcome reporting (the write itself happens in config.mjs /
 * cli.mjs -- syntax errors must have been rejected before any write).
 * @param {string[]} urls
 * @param {{ proxySetting?: "auto" | "on" | "off", env?: Record<string, string | undefined>, httpGet?: typeof httpGet }} [opts]
 * @returns {Promise<{ lines: string[], warnings: string[], allOk: boolean }>}
 */
export async function probeRelayUrls(urls, opts = {}) {
  const { proxySetting = "auto", env = process.env, httpGet: doGet = httpGet } = opts;
  const proxy = await decideProxyPolicy(urls, { proxySetting, env, httpGet: doGet });
  const warnings = [...proxy.warnings];
  /** @type {string[]} */
  const lines = [];
  let allOk = true;
  // R8 P1-2b：逐项归一——schema 硬错误（malformed manifest 等）在每个 URL
  // 上转为失败 outcome（saved but unreachable WARNING），不整体 reject——
  // D2 事务契约：写入后逐项报告、非零退出。
  const outcomes = await Promise.all(
    urls.map(async (u) => {
      try {
        return await resolveOneRelay(u, { policy: proxy.policy, httpGet: doGet, env });
      } catch (err) {
        return { kind: "unreachable", reason: `invalid manifest: ${err.message}` };
      }
    }),
  );
  for (let i = 0; i < urls.length; i++) {
    const oc = outcomes[i];
    if (oc.kind === "gateway") {
      lines.push(`saved: ${urls[i]} (gateway -> ${oc.url})`);
    } else if (oc.kind === "legacy") {
      lines.push(`saved: ${urls[i]} (legacy relay)`);
    } else if (oc.kind === "disabled") {
      allOk = false;
      warnings.push(`saved but unreachable: ${urls[i]} (${oc.warning})`);
    } else {
      allOk = false;
      warnings.push(`saved but unreachable: ${urls[i]} (${oc.reason})`);
    }
  }
  return { lines, warnings, allOk };
}
