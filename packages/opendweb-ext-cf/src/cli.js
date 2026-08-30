// CLI 面（./opendweb-plugin）：命令清单 + run。命令与钩子共享 wizard 核心。
// status 为只读盘点（spec 场景：`opendweb cf status` 派发）：plan / 配置文件
// 条目 / 插件锁定记录；--verify 才触网做端到端自检。
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSetup, verifyExposure, planExposure } from "./wizard.js";
import { runInteractiveSetup } from "./tui.mjs";

export default {
  name: "cf",
  apiVersion: 1,
  commands: [
    {
      name: "setup",
      description: "wire a Cloudflare Tunnel to this server: push ingress via API, route DNS, write opendweb.config.toml, verify end-to-end; run without --hostname on a terminal for the guided wizard",
      args: {
        type: "object",
        properties: {
          "token-env": { type: "string" },
          hostname: { type: "string" },
          mode: { type: "string" },
          "dry-run": { type: "boolean" },
          "skip-verify": { type: "boolean" },
          interactive: { type: "boolean" },
        },
      },
    },
    {
      name: "verify",
      description: "end-to-end check: fetch the public services.json and assert the advertised relay URL",
      args: {
        type: "object",
        properties: { hostname: { type: "string" }, mode: { type: "string" } },
        required: ["hostname"],
      },
    },
    {
      name: "plan",
      description: "show the exposure plan (hosts, URLs, ingress rules) without touching anything",
      args: {
        type: "object",
        properties: { hostname: { type: "string" }, mode: { type: "string" } },
        required: ["hostname"],
      },
    },
    {
      name: "status",
      description: "read-only exposure state: plan, config file entries, plugin lock record; add --verify for an end-to-end check",
      args: {
        type: "object",
        properties: {
          hostname: { type: "string" },
          mode: { type: "string" },
          verify: { type: "boolean" },
        },
      },
    },
  ],
  async run({ command, args, log, cwd, stdout = process.stdout, stderr = process.stderr }) {
    const mode = args.mode === "single" ? "single" : "dual";
    if (command === "plan") {
      const plan = planExposure({ hostname: args.hostname, mode });
      log(`mode:        ${plan.mode}`);
      log(`gateway:     ${plan.gatewayHost} (${plan.publicGatewayUrl})`);
      log(`relay:       ${plan.relayHost} (${plan.publicRelayUrl})`);
      return { exit: 0 };
    }
    if (command === "verify") {
      const plan = planExposure({ hostname: args.hostname, mode });
      const v = await verifyExposure({ publicGatewayUrl: plan.publicGatewayUrl, expectedRelayUrl: plan.publicRelayUrl });
      if (!v.ok) {
        throw new Error(v.error);
      }
      log(`ok: ${plan.publicGatewayUrl}/services.json advertises ${plan.publicRelayUrl}`);
      return { exit: 0 };
    }
    if (command === "status") {
      return runStatus({ args, mode, log, cwd });
    }
    if (command === "setup") {
      // 引导模式（TUI）：显式 --interactive，或终端下缺 --hostname 自动进入。
      // 预填优先级 flag > config（cf 插件的 options）> default
      if (wantsInteractive(args, process.stdin.isTTY === true)) {
        const config = readConfigState(cwd);
        const cfOpts = config?.cfOptions ?? {};
        const suggested = args.hostname ?? hostnameFromUrl(config?.publicGatewayUrl);
        return runInteractiveSetup({
          cwd,
          tokenEnvName: args["token-env"] ?? cfOpts.tokenEnv ?? "TUNNEL_TOKEN",
          suggestedHostname: suggested ?? undefined,
          suggestedMode: args.mode === "single" || (args.mode === undefined && cfOpts.mode === "single") ? "single" : "dual",
          suggestedAction: args["dry-run"] ? "dry" : "apply",
          forceDryRun: args["dry-run"] === true,
          skipVerify: Boolean(args["skip-verify"]),
        });
      }
      if (!args.hostname) {
        throw new Error(`--hostname is required (or pass --interactive / run from a terminal for the guided wizard)`);
      }
      const tokenEnv = args["token-env"] ?? "TUNNEL_TOKEN";
      const token = process.env[tokenEnv];
      if (!token && !args["dry-run"]) {
        throw new Error(`missing ${tokenEnv} in the environment; copy the tunnel token from Zero Trust -> Networks -> Tunnels`);
      }
      await runSetup({
        token: token ?? "dry-run-token",
        hostname: args.hostname,
        mode,
        cwd,
        tokenEnvName: tokenEnv,
        dryRun: Boolean(args["dry-run"]),
        skipVerify: Boolean(args["skip-verify"]),
        log,
      });
      return { exit: 0 };
    }
    return { exit: 2 };
  },
};

/**
 * setup 引导模式的进入条件：显式 --interactive 恒进（管道/脚本可驱动）；
 * 否则仅当「终端 && 缺 --hostname」时自动进入（裸 `opendweb cf setup` 即引导）。
 * @param {{ interactive?: boolean, hostname?: string }} args
 * @param {boolean} isTTY
 * @returns {boolean}
 */
export function wantsInteractive(args, isTTY) {
  return args.interactive === true || (!args.hostname && isTTY);
}

/**
 * status 命令：hostname 取 --hostname 或配置文件 server.publicGatewayUrl，
 * 均无则 plan 段显示 unknown（其余段照常展示）。零网络副作用（--verify 除外）。
 */
async function runStatus({ args, mode, log, cwd }) {
  const config = readConfigState(cwd);
  const hostname = args.hostname ?? hostnameFromUrl(config?.publicGatewayUrl);
  log(`config:   ${config ? relativeTo(cwd, config.path) : "not found (opendweb.config.toml|.json)"}`);
  if (hostname === null) {
    log("plan:     unknown (pass --hostname or set server.publicGatewayUrl in the config)");
  } else {
    const plan = planExposure({ hostname, mode });
    log(`plan:     mode ${plan.mode}`);
    log(`gateway:  ${plan.gatewayHost} (${plan.publicGatewayUrl})`);
    log(`relay:    ${plan.relayHost} (${plan.publicRelayUrl})`);
  }
  log(`plugin:   ${config?.cfEntry ? "cf declared in the config" : "cf entry missing in the config (cf setup writes it)"}`);
  const lock = readLockRecord();
  log(`lock:     ${lock ? `cf ${lock.package}@${lock.version}` : "cf not in the plugin lockfile"}`);
  if (args.verify) {
    if (hostname === null) {
      throw new Error("status --verify needs --hostname or server.publicGatewayUrl");
    }
    const plan = planExposure({ hostname, mode });
    const v = await verifyExposure({ publicGatewayUrl: plan.publicGatewayUrl, expectedRelayUrl: plan.publicRelayUrl });
    if (!v.ok) throw new Error(v.error);
    log(`verify:   ok (${plan.publicGatewayUrl}/services.json)`);
  }
  return { exit: 0 };
}

/**
 * 读取 cwd 的配置文件摘要（只读展示 + 引导预填；正式解析归 CLI 的
 * config-file 模块）。TOML 用最小扫描（核心零依赖；交互引导层才依赖
 * @clack/prompts）；解析不了的字段显示为缺省而非报错。cfOptions = cf
 * 插件 [[plugins]] 条目的 options 摘要（tokenEnv/mode，flag > config >
 * default 的 config 层）。
 */
function readConfigState(cwd) {
  for (const name of ["opendweb.config.toml", "opendweb.config.json"]) {
    const p = path.join(cwd, name);
    if (!existsSync(p)) continue;
    let summary;
    try {
      summary = name.endsWith(".json")
        ? jsonSummary(readFileSync(p, "utf8"))
        : tomlSummary(readFileSync(p, "utf8"));
    } catch {
      summary = { server: {}, plugins: [] };
    }
    const cfEntry = summary.plugins.find((e) => e?.name === "cf" && e.options) ?? null;
    return {
      path: p,
      publicGatewayUrl: summary.server.publicGatewayUrl ?? null,
      publicRelayUrl: summary.server.publicRelayUrl ?? null,
      cfEntry: summary.plugins.some((e) => e === "cf" || e?.name === "cf"),
      cfOptions: cfEntry ? cfOptionsOf(cfEntry.options) : {},
    };
  }
  return null;
}

/** cf options 摘要：只取引导关心的两个键，形态不符即忽略 */
function cfOptionsOf(options) {
  if (typeof options !== "object" || options === null) return {};
  const out = {};
  if (typeof options.tokenEnv === "string" && options.tokenEnv !== "") out.tokenEnv = options.tokenEnv;
  if (options.mode === "single" || options.mode === "dual") out.mode = options.mode;
  return out;
}

function jsonSummary(text) {
  const parsed = JSON.parse(text);
  return { server: parsed?.server ?? {}, plugins: Array.isArray(parsed?.plugins) ? parsed.plugins : [] };
}

/**
 * TOML 最小扫描：server 的公网 URL 赋值行 + [[plugins]] 表数组条目
 * （name/options 的 tokenEnv/mode；数组简写形态退化为裸名）。行式状态机
 * ——比嵌套正则可预测（\s*$ 类贪婪会在块内换行处误截断）。
 */
function tomlSummary(text) {
  const server = {};
  for (const key of ["publicGatewayUrl", "publicRelayUrl"]) {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m").exec(text);
    if (m) server[key] = m[1];
  }
  const plugins = [];
  let current = null;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t === "[[plugins]]") {
      if (current?.name !== undefined) plugins.push(current);
      current = {};
      continue;
    }
    if (t === "[plugins.options]") continue; // 归属当前 current（kv 行足够区分）
    if (t.startsWith("[")) {
      // 其它表（如 [server]）：结束当前 plugins 条目
      if (current?.name !== undefined) plugins.push(current);
      current = null;
      continue;
    }
    if (current === null) {
      const arr = /^\s*"?plugins"?\s*=\s*\[(.*)\]/.exec(line);
      if (arr) {
        for (const part of arr[1].split(",")) {
          const s = part.trim().replace(/^"|"$/g, "");
          if (s) plugins.push(s);
        }
      }
      continue;
    }
    const kv = /^\s*(name|tokenEnv|mode)\s*=\s*"([^"]*)"/.exec(line);
    if (!kv) continue;
    if (kv[1] === "name") current.name = kv[2];
    else {
      current.options = current.options ?? {};
      current.options[kv[1]] = kv[2];
    }
  }
  if (current?.name !== undefined) plugins.push(current);
  return { server, plugins };
}

/** 插件锁定记录（与 CLI 同源：DWEB_HOME ?? ~/.opendweb/plugins.json） */
function readLockRecord() {
  const home = process.env.DWEB_HOME ?? path.join(os.homedir(), ".opendweb");
  try {
    const parsed = JSON.parse(readFileSync(path.join(home, "plugins.json"), "utf8"));
    return parsed?.cf ?? null;
  } catch {
    return null;
  }
}

function hostnameFromUrl(url) {
  if (typeof url !== "string" || url === "") return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

function relativeTo(cwd, p) {
  return p.startsWith(`${cwd}${path.sep}`) ? p.slice(cwd.length + 1) : p;
}
