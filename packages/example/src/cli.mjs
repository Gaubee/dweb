#!/usr/bin/env node
// dweb example CLI -- reference client for @jixo/opendweb-client-sdk.
//
// connectivity-ux-hardening (v0.2):
//  - config file (~/.opendweb/config.json) + flag > env > file > default
//  - bootstrap state machine: relay URL normalization -> proxy decision ->
//    gateway /services.json address resolution (design D2)
//  - invite TTL default 60m with duration suffixes, --allow-relayless escape
//  - join failures surface stable error codes (error[join/<CODE>])
//  - every user-facing string is English and ASCII (dynamic values escaped)
//
// Old-SDK compatibility (0.1.0 binary): relayStatus(), relay-* events and the
// invite() options argument are feature-detected / additive so this CLI keeps
// running against the pre-0.2 native module during the transition.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { createRequire } from "node:module";

import { UsageError, CliError } from "./errors.mjs";
import { asciiEscape } from "./ascii.mjs";
import { parseArgv, parseDurationMs, assertDurationRange, expandTilde } from "./args.mjs";
import {
  CONFIG_KEYS,
  TTL_MIN_MS,
  TTL_MAX_MS,
  JOIN_TIMEOUT_MIN_MS,
  JOIN_TIMEOUT_MAX_MS,
  configPaths,
  loadConfigFile,
  writeConfigFileAtomic,
  resolveSettings,
  configListLines,
  relayDisplay,
  configSetValue,
} from "./config.mjs";
import { bootstrapRelay, probeRelayUrls } from "./relay-resolve.mjs";

const require = createRequire(import.meta.url);
const { Fabric } = require("@jixo/opendweb-client-sdk");

// ---------------------------------------------------------------------------
// printers (ASCII discipline: whole line escaped, one line per message)
// ---------------------------------------------------------------------------

function printWarning(text) {
  console.error("WARNING: " + asciiEscape(text));
}

function printErrorLine(line) {
  console.error(asciiEscape(line));
}

// ---------------------------------------------------------------------------
// option specs (design D8)
// ---------------------------------------------------------------------------

const GLOBAL_SPEC = {
  data: { type: "string", tilde: true },
  relay: { type: "multi" },
  proxy: { type: "string" },
  "join-timeout": { type: "string" },
};

const COMMAND_SPEC = {
  invite: {
    ttl: { type: "string" },
    for: { type: "string" },
    "allow-relayless": { type: "boolean" },
  },
};

const PROXY_VALUES = ["auto", "on", "off"];

/**
 * Find the index of the command token: the first token that is not an option.
 * Option values are skipped using the GLOBAL spec (command-first usage; a
 * command-specific option before the command is not supported).
 * @param {string[]} argv
 * @returns {number}
 */
function findCommandIndex(argv) {
  let i = 0;
  while (i < argv.length) {
    const t = argv[i];
    if (t === "--") return i + 1 < argv.length ? i + 1 : -1;
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = (eq >= 0 ? t.slice(2, eq) : t.slice(2)).trim();
      const decl = GLOBAL_SPEC[name];
      if (eq < 0 && decl && decl.type !== "boolean") i += 2;
      else i += 1;
      continue;
    }
    return i;
  }
  return -1;
}

const argv = process.argv.slice(2);
const cmdIndex = findCommandIndex(argv);
let command = "help";
let rest = [];
if (cmdIndex < 0 && argv.length > 0) {
  printErrorLine("error: missing command; run with no arguments for help");
  process.exit(2);
}
if (cmdIndex >= 0) {
  command = argv[cmdIndex];
  rest = argv.filter((_, i) => i !== cmdIndex);
}
const spec = { ...GLOBAL_SPEC, ...(COMMAND_SPEC[command] ?? {}) };
/** @type {{ options: Record<string, any>, positionals: string[] }} */
let parsed = { options: {}, positionals: [] };
try {
  parsed = parseArgv(rest, spec, { homedir: os.homedir() });
} catch (e) {
  if (e instanceof CliError) {
    printErrorLine(e.message);
    process.exit(e.exitCode);
  }
  throw e;
}
const positionals = parsed.positionals;

/**
 * @returns {{ data?: string, relay?: string[], proxy?: string, ttlMs?: number, joinTimeoutMs?: number }}
 */
function extractFlags() {
  /** @type {any} */
  const flags = {};
  if (parsed.options.data !== undefined) flags.data = parsed.options.data;
  if (Array.isArray(parsed.options.relay) && parsed.options.relay.length > 0) {
    flags.relay = parsed.options.relay;
  }
  if (parsed.options.proxy !== undefined) {
    if (!PROXY_VALUES.includes(parsed.options.proxy)) {
      throw new CliError(
        `error: invalid --proxy value: ${parsed.options.proxy} (expected auto|on|off)`,
      );
    }
    flags.proxy = parsed.options.proxy;
  }
  if (parsed.options.ttl !== undefined) {
    const ms = parseDurationMs(parsed.options.ttl, "--ttl");
    assertDurationRange(ms, TTL_MIN_MS, TTL_MAX_MS, "--ttl", "1s..30d");
    flags.ttlMs = Math.round(ms);
  }
  if (parsed.options["join-timeout"] !== undefined) {
    const ms = parseDurationMs(parsed.options["join-timeout"], "--join-timeout");
    assertDurationRange(ms, JOIN_TIMEOUT_MIN_MS, JOIN_TIMEOUT_MAX_MS, "--join-timeout", "1s..10m");
    flags.joinTimeoutMs = Math.round(ms);
  }
  return flags;
}

// ---------------------------------------------------------------------------
// join / invite error presentation (contracts/error-matrix.md)
// ---------------------------------------------------------------------------

/** @type {{ [kebab: string]: { code: string, advice: (detail?: string, secs?: number) => string } }} */
const JOIN_CODES = {
  "token-invalid": {
    code: "TOKEN_INVALID",
    advice: () => "the invite token is malformed or has a bad signature; ask the inviter for a new one",
  },
  "token-expired": {
    code: "TOKEN_EXPIRED",
    advice: () => "the invite token has expired; ask the inviter for a new one",
  },
  "wrong-fabric": {
    code: "WRONG_FABRIC",
    // 内核 DirFabricMismatch 的消息已含两 fabric 短标识与 "use a fresh --data
    // directory" 指引——advice 仅在内核消息缺失时补默认文案，避免重复拼接。
    advice: (d) => d || "data dir belongs to a different fabric; use a fresh --data directory",
  },
  "no-reachable-path": {
    code: "NO_REACHABLE_PATH",
    advice: () =>
      "the token carries no relay URL and no direct addresses (likely signed without a relay); ask the inviter to re-sign with a relay configured",
  },
  "relay-offline": {
    code: "RELAY_OFFLINE",
    advice: () => "configured relay(es) are unreachable; check the server or network",
  },
  "dial-failed": {
    code: "DIAL_FAILED",
    advice: (d) =>
      `could not reach the issuer: ${d || "connection failed"}; verify network paths and direct addresses`,
  },
  "dial-timeout": {
    code: "DIAL_TIMEOUT",
    advice: (_d, secs) =>
      `issuer did not respond within ${secs}s (relay online: issuer likely offline; invites must be redeemed while the inviter is running)`,
  },
  "token-consumed": {
    code: "TOKEN_CONSUMED",
    advice: () => "this invite token was already used; invites are single-use",
  },
};

const EXEMPT_CODES = {
  "missing-identity": "data dir has no identity; run init first",
  corrupted: "roster file is corrupted; see the data directory",
  "roster-io": "failed to read/write roster; check disk and permissions",
};

/** @type {{ [kebab: string]: { code: string, advice: () => string } }} */
const INVITE_CODES = {
  "invite-without-relay": {
    code: "INVITE_WITHOUT_RELAY",
    advice: () =>
      "no relay configured; set one via 'config set relay <url>' or pass --allow-relayless for an out-of-band reachable path",
  },
};

/**
 * Map an SDK error (kebab-prefixed message, contracts/client-sdk.d.ts.md) to
 * its stable CLI line. Returns null for unclassified errors.
 * @param {unknown} err
 * @param {{ joinTimeoutSeconds: number }} ctx
 * @returns {string | null}
 */
function classifySdkError(err, ctx) {
  const m = /^\[([a-z0-9-]+)\]\s*(.*)$/.exec(String(err?.message ?? ""));
  if (!m) return null;
  const [, kebab, detail] = m;
  const join = JOIN_CODES[kebab];
  if (join) return `error[join/${join.code}]: ${join.advice(detail, ctx.joinTimeoutSeconds)}`;
  const invite = INVITE_CODES[kebab];
  if (invite) return `error[invite/${invite.code}]: ${invite.advice()}`;
  const exempt = EXEMPT_CODES[kebab];
  if (exempt) return `error[${kebab}]: ${exempt}${detail ? ` (${detail})` : ""}`;
  return null;
}

// ---------------------------------------------------------------------------
// fabric helpers
// ---------------------------------------------------------------------------

let effectiveJoinTimeoutMs = 30000;

function shortId(id) {
  return id.slice(0, 8);
}

/**
 * @param {{ dataDir: string, relay: any, httpProxy: string, joinTimeoutMs: number }} baseOpts
 */
async function openFabric(baseOpts) {
  const rosterExists = fs.existsSync(path.join(baseOpts.dataDir, "roster.facts"));
  if (!rosterExists) {
    throw new CliError(
      `error: data dir ${baseOpts.dataDir} is not an initialized fabric; run init or join first`,
    );
  }
  return Fabric.open(baseOpts);
}

// ---------------------------------------------------------------------------
// config subcommand
// ---------------------------------------------------------------------------

/**
 * @param {string[]} args positionals after "config"
 * @param {{ settings: ReturnType<typeof resolveSettings>, paths: { dir: string, file: string }, file: Record<string, unknown> }} ctx
 */
async function runConfigCommand(args, ctx) {
  const { settings, paths, file } = ctx;
  const sub = args[0];
  const restArgs = args.slice(1);
  const knownKeys = CONFIG_KEYS.join(", ");
  if (sub === "list") {
    for (const line of configListLines(settings)) console.log(asciiEscape(line));
    return;
  }
  if (sub === "get") {
    const key = restArgs[0];
    if (!key) throw new UsageError(`error: config get requires a key (known: ${knownKeys})`);
    if (!CONFIG_KEYS.includes(key)) {
      throw new CliError(`error: unknown config key: ${key} (known: ${knownKeys})`);
    }
    const value =
      key === "relay"
        ? relayDisplay(settings.relay)
        : key === "proxy"
          ? settings.proxy.value
          : key === "data"
            ? settings.data.value
            : key === "inviteTtlMs"
              ? String(settings.inviteTtlMs.value)
              : String(settings.joinTimeoutMs.value);
    console.log(asciiEscape(String(value)));
    return;
  }
  if (sub === "set") {
    const key = restArgs[0];
    if (!key) throw new UsageError(`error: config set requires a key (known: ${knownKeys})`);
    const patch = configSetValue(key, restArgs.slice(1), { homedir: os.homedir() });
    // Syntax checks passed: write first (offline pre-fill is legal), then probe.
    writeConfigFileAtomic(paths.file, { ...file, ...patch });
    if (key === "relay") {
      const urls = Array.isArray(patch.relay) ? patch.relay : [patch.relay];
      const probe = await probeRelayUrls(urls, { proxySetting: settings.proxy.value });
      for (const line of probe.lines) console.log(asciiEscape(line));
      for (const w of probe.warnings) printWarning(w);
      if (!probe.allOk) process.exitCode = 1;
      return;
    }
    const v = patch[key];
    console.log(asciiEscape(`set ${key} = ${typeof v === "object" ? JSON.stringify(v) : String(v)}`));
    return;
  }
  if (sub === "unset") {
    const key = restArgs[0];
    if (!key) throw new UsageError(`error: config unset requires a key (known: ${knownKeys})`);
    if (restArgs.length > 1) throw new UsageError("error: config unset takes exactly one key");
    if (!CONFIG_KEYS.includes(key)) {
      throw new CliError(`error: unknown config key: ${key} (known: ${knownKeys})`);
    }
    if (file[key] !== undefined) {
      const next = { ...file };
      delete next[key];
      writeConfigFileAtomic(paths.file, next);
    }
    console.log(`unset ${key}`);
    return;
  }
  throw new UsageError(
    `error: unknown config subcommand: ${sub ?? ""} (known: list, get, set, unset)`,
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  if (command === "help") {
    printHelp();
    return;
  }

  const paths = configPaths();
  const { config: file, warnings: fileWarnings } = loadConfigFile(paths.file);
  for (const w of fileWarnings) printWarning(w);

  const settings = resolveSettings({ flags: extractFlags(), env: process.env, file });
  effectiveJoinTimeoutMs = settings.joinTimeoutMs.value;
  const dataDir = path.resolve(expandTilde(settings.data.value, os.homedir()));

  if (command === "config") {
    await runConfigCommand(positionals, { settings, paths, file });
    return;
  }

  const boot = await bootstrapRelay(settings);
  for (const w of boot.warnings) printWarning(w);

  const baseOpts = {
    dataDir,
    relay: boot.relayOpts,
    httpProxy: boot.httpProxy,
    joinTimeoutMs: settings.joinTimeoutMs.value,
  };
  fs.mkdirSync(dataDir, { recursive: true });

  switch (command) {
    case "init": {
      const fabric = await Fabric.createRoot(baseOpts);
      console.log(`fabric initialized`);
      console.log(`  endpoint-id : ${fabric.endpointId}`);
      console.log(`  fabric-id   : ${await fabric.fabricIdHex()}`);
      console.log(`  data-dir    : ${asciiEscape(dataDir)}`);
      await fabric.shutdown();
      break;
    }
    case "id": {
      const fabric = await openFabric(baseOpts);
      console.log(fabric.endpointId);
      await fabric.shutdown();
      break;
    }
    case "info": {
      const fabric = await openFabric(baseOpts);
      console.log(`endpoint-id : ${fabric.endpointId}`);
      console.log(`fabric-id   : ${await fabric.fabricIdHex()}`);
      await fabric.shutdown();
      break;
    }
    case "invite": {
      const fabric = await openFabric(baseOpts);
      const allowRelayless = parsed.options["allow-relayless"] === true;
      if (allowRelayless) {
        printWarning(
          "token has no relay path; the caller is responsible for providing an out-of-band reachable path to the issuer",
        );
      }
      const token = await fabric.invite(
        settings.inviteTtlMs.value,
        parsed.options.for ?? null,
        allowRelayless ? { allowRelayless: true } : undefined,
      );
      console.log(token);
      await fabric.shutdown();
      break;
    }
    case "join": {
      const token = positionals[0];
      if (!token?.startsWith("dweb1.")) {
        throw new CliError("error: join requires a dweb1. invite token as argument");
      }
      const fabric = await Fabric.joinWithToken(baseOpts, token);
      console.log(`joined fabric ${await fabric.fabricIdHex()}`);
      console.log(`  endpoint-id : ${fabric.endpointId}`);
      console.log(`  members     : ${(await fabric.members()).length}`);
      await fabric.shutdown();
      break;
    }
    case "members": {
      const fabric = await openFabric(baseOpts);
      const members = await fabric.members();
      console.log(`${members.length} member(s):`);
      for (const m of members) {
        const self = m.endpointId === fabric.endpointId ? " (self)" : "";
        const name = m.displayName ? ` ${m.displayName}` : "";
        console.log(asciiEscape(`  ${m.endpointId}${name}${self}`));
      }
      await fabric.shutdown();
      break;
    }
    case "connect": {
      const target = positionals[0];
      if (!target) throw new CliError("error: connect requires an endpointId argument");
      const fabric = await openFabric(baseOpts);
      await fabric.connect(target);
      console.log(`connected ${shortId(target)} (${await fabric.linkStatus(target)})`);
      await fabric.shutdown();
      break;
    }
    case "send": {
      const [to, ...words] = positionals;
      if (!to || words.length === 0) {
        throw new CliError("error: send requires an endpointId and a text message");
      }
      const fabric = await openFabric(baseOpts);
      const text = words.join(" ");
      await fabric.connect(to);
      await fabric.send(to, Buffer.from(text, "utf8"));
      console.log(`sent ${Buffer.byteLength(text)} bytes to ${shortId(to)}`);
      await fabric.shutdown();
      break;
    }
    case "name": {
      const display = positionals[0];
      if (display === undefined) {
        throw new CliError("error: name requires a display name argument");
      }
      const fabric = await openFabric(baseOpts);
      await fabric.setDisplayName(display);
      console.log(asciiEscape(`display name set: ${display}`));
      await fabric.shutdown();
      break;
    }
    case "revoke": {
      const target = positionals[0];
      if (!target) throw new CliError("error: revoke requires an endpointId argument");
      const fabric = await openFabric(baseOpts);
      await fabric.revoke(target);
      console.log(`revoked ${shortId(target)}`);
      await fabric.shutdown();
      break;
    }
    case "chat": {
      const fabric = await openFabric(baseOpts);

      // Snapshot FIRST, then subscribe (design D4: initial state never comes
      // from events). Feature-detect: 0.1.0 binaries lack relayStatus().
      /** @type {boolean | null} */
      let relayOnline = null;
      /** @type {string | null} */
      let relaySnapshotLine = null;
      if (typeof fabric.relayStatus === "function") {
        const st = await fabric.relayStatus();
        if (st && st.mode !== "disabled") {
          relayOnline = st.online === true;
          if (st.online === true) {
            // P1-5（R3）：不打印配置首项冒充实际可达项——快照无选中 URL，
            // 打印候选数量（真实选中项语义属 activeUrl 提案，见 contracts）
            relaySnapshotLine = `relay: online (${st.urls.length} candidate${st.urls.length === 1 ? "" : "s"})`;
          } else {
            relaySnapshotLine = null;
            printWarning(
              `relay offline (last error: ${asciiEscape(st.lastError ?? "unknown")}) -- direct connections only; invites will fail until a relay is reachable`,
            );
          }
        }
      }

      fabric.on((ev) => {
        if (ev.type === "message") {
          console.log(`[${shortId(ev.from)}] ${ev.data.toString("utf8")}`);
        } else if (ev.type === "peer-connected") {
          console.log(`-- ${shortId(ev.endpointId)} connected (${ev.endpointId})`);
        } else if (ev.type === "peer-disconnected") {
          console.log(`-- ${shortId(ev.endpointId)} disconnected`);
        } else if (ev.type === "relay-online") {
          if (relayOnline !== true) {
            relayOnline = true;
            const n = Array.isArray(ev.relay?.urls) ? ev.relay.urls.length : 0;
            console.log(`relay: online (${n} candidate${n === 1 ? "" : "s"}) -- recovered`);
          }
        } else if (ev.type === "relay-offline") {
          if (relayOnline !== false) {
            relayOnline = false;
            printWarning(
              "relay offline -- direct connections only; invites will fail until a relay is reachable",
            );
          }
        }
      });

      console.log(`chat ready as ${fabric.endpointId} (${asciiEscape(dataDir)})`);
      if (relaySnapshotLine) console.log(relaySnapshotLine);

      const members = await fabric.members();
      for (const m of members) {
        if (m.endpointId !== fabric.endpointId) {
          fabric
            .connect(m.endpointId)
            .catch((e) => printErrorLine(`connect ${shortId(m.endpointId)}: ${e.message}`));
        }
      }
      const rl = readline.createInterface({ input: process.stdin, terminal: false });
      rl.on("line", (line) => {
        const text = line.trim();
        if (!text) return;
        (async () => {
          const peers = (await fabric.members()).filter((m) => m.endpointId !== fabric.endpointId);
          await Promise.all(
            peers.map((p) =>
              fabric
                .connect(p.endpointId)
                .then(() => fabric.send(p.endpointId, Buffer.from(text, "utf8")))
                .catch((e) => printErrorLine(`send to ${shortId(p.endpointId)}: ${e.message}`)),
            ),
          );
          console.log(`[me] ${text}`);
        })();
      });
      // chat stays in the foreground until Ctrl+C
      await new Promise(() => {});
      break;
    }
    default:
      throw new UsageError(`error: unknown command: ${command} (run with no arguments for help)`);
  }
}

function printHelp() {
  console.log(`dweb-example -- fabric networking example CLI

commands:
  init                          create a new fabric (this node becomes root)
  id / info                     print identity
  invite [--ttl <dur>] [--for <endpointId>] [--allow-relayless]
                                issue an invite token (root only)
  join <token>                  redeem an invite token (issuer must be online)
  members                       list members
  connect <endpointId>          connect to a member
  send <endpointId> <text...>   send a text message
  chat                          interactive chat (connects to all members)
  name <display>                set display name
  revoke <endpointId>           revoke a member (root only)
  config <list|get|set|unset>   manage persistent config (~/.opendweb/config.json)

options:
  --data <dir>                  data directory (default ~/.dweb-example)
  --relay <url> [...]           relay candidate(s): gateway URL or bare relay URL
  --proxy <auto|on|off>         proxy policy (default auto)
  --join-timeout <dur>          join deadline (default 30s, range 1s..10m)
  --ttl <dur>                   invite ttl (default 60m, range 1s..30d)

durations accept 30s / 15m / 2h / 1d suffixes; bare numbers are milliseconds.

environment:
  DWEB_DATA                     data directory
  DWEB_RELAY=disabled|custom|n0 relay mode
  DWEB_RELAY_URLS=<url,...>     relay URLs (custom mode)
  DWEB_PROXY=auto|on|off        proxy policy

config keys: relay (url or url array), proxy, data, inviteTtlMs, joinTimeoutMs
priority: CLI flag > environment > config file > built-in default`);
}

main().catch((e) => {
  if (e instanceof UsageError || e instanceof CliError) {
    printErrorLine(e.message);
    process.exit(e.exitCode);
  }
  const joinLine = classifySdkError(e, {
    joinTimeoutSeconds: Math.max(1, Math.round(effectiveJoinTimeoutMs / 1000)),
  });
  if (joinLine) {
    printErrorLine(joinLine);
    process.exit(1);
  }
  printErrorLine(`error: ${e?.message ?? String(e)}`);
  process.exit(1);
});
