// CLI 面（./opendweb-plugin）：命令清单 + run。命令与钩子共享 wizard 核心。
// status 为只读盘点（spec 场景：`opendweb cf status` 派发）：plan / 配置文件
// 条目 / 插件锁定记录；--verify 才触网做端到端自检。
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSetup, verifyExposure, planExposure, type ExposureMode } from "./wizard.js";
import { runInteractiveSetup } from "./tui.js";

/** 宿主 parseCommandArgs 产出的参数袋（已按清单声明解析） */
type Args = Record<string, unknown>;

/** args 窄化小工具：清单声明了 string 的键才可能是 string */
const str = (args: Args, key: string): string | undefined => (typeof args[key] === "string" ? (args[key] as string) : undefined);
const bool = (args: Args, key: string): boolean => args[key] === true;

/** 宿主 CLI 面契约（plugin-contract.mjs 的 zod 清单形态） */
interface CommandSpec {
  name: string;
  description: string;
  args: {
    type: "object";
    properties: Record<string, { type: "string" | "number" | "boolean" }>;
    required?: string[];
  };
}

/** 宿主 dispatchPluginCommand 提供的 run 上下文 */
export interface RunContext {
  command: string;
  args: Args;
  log: (line?: string) => void;
  cwd: string;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}

export default {
  name: "cf",
  apiVersion: 1,
  commands: [
    {
      name: "setup",
      description:
        "wire a Cloudflare Tunnel to this server: push ingress via API, route DNS, write opendweb.config.toml, verify end-to-end; run without --hostname on a terminal for the guided wizard",
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
      description:
        "read-only exposure state: plan, config file entries, plugin lock record; add --verify for an end-to-end check",
      args: {
        type: "object",
        properties: {
          hostname: { type: "string" },
          mode: { type: "string" },
          verify: { type: "boolean" },
        },
      },
    },
  ] satisfies CommandSpec[],
  async run({ command, args, log, cwd }: RunContext): Promise<{ exit: number } | void> {
    const mode: ExposureMode = args.mode === "single" ? "single" : "dual";
    if (command === "plan") {
      const plan = planExposure({ hostname: str(args, "hostname") ?? "", mode });
      log(`mode:        ${plan.mode}`);
      log(`gateway:     ${plan.gatewayHost} (${plan.publicGatewayUrl})`);
      log(`relay:       ${plan.relayHost} (${plan.publicRelayUrl})`);
      return { exit: 0 };
    }
    if (command === "verify") {
      const plan = planExposure({ hostname: str(args, "hostname") ?? "", mode });
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
      if (wantsInteractive({ interactive: bool(args, "interactive"), hostname: str(args, "hostname") }, process.stdin.isTTY === true)) {
        const config = readConfigState(cwd);
        const cfOpts = config?.cfOptions ?? {};
        const suggested = str(args, "hostname") ?? hostnameFromUrl(config?.publicGatewayUrl);
        return runInteractiveSetup({
          cwd,
          tokenEnvName: str(args, "token-env") ?? cfOpts.tokenEnv ?? "TUNNEL_TOKEN",
          suggestedHostname: suggested ?? undefined,
          suggestedMode:
            args.mode === "single" || (args.mode === undefined && cfOpts.mode === "single") ? "single" : "dual",
          suggestedAction: bool(args, "dry-run") ? "dry" : "apply",
          forceDryRun: bool(args, "dry-run"),
          skipVerify: bool(args, "skip-verify"),
        });
      }
      const hostname = str(args, "hostname");
      if (!hostname) {
        throw new Error(`--hostname is required (or pass --interactive / run from a terminal for the guided wizard)`);
      }
      const tokenEnv = str(args, "token-env") ?? "TUNNEL_TOKEN";
      const token = process.env[tokenEnv];
      if (!token && !bool(args, "dry-run")) {
        throw new Error(`missing ${tokenEnv} in the environment; copy the tunnel token from Zero Trust -> Networks -> Tunnels`);
      }
      await runSetup({
        token: token ?? "dry-run-token",
        ...(str(args, "api-token") !== undefined ? { apiToken: str(args, "api-token") } : {}),
        hostname,
        mode,
        cwd,
        tokenEnvName: tokenEnv,
        dryRun: bool(args, "dry-run"),
        skipVerify: bool(args, "skip-verify"),
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
 */
export function wantsInteractive(args: { interactive?: boolean | undefined; hostname?: string | undefined }, isTTY: boolean): boolean {
  return args.interactive === true || (!args.hostname && isTTY);
}

/**
 * status 命令：hostname 取 --hostname 或配置文件 server.publicGatewayUrl，
 * 均无则 plan 段显示 unknown（其余段照常展示）。零网络副作用（--verify 除外）。
 */
async function runStatus({ args, mode, log, cwd }: { args: Args; mode: ExposureMode; log: (line?: string) => void; cwd: string }): Promise<{ exit: number }> {
  const config = readConfigState(cwd);
  const hostname = str(args, "hostname") ?? hostnameFromUrl(config?.publicGatewayUrl);
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
  if (bool(args, "verify")) {
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

interface PluginEntrySummary {
  name?: string;
  options?: { tokenEnv?: string; mode?: string };
}

interface ConfigSummary {
  server: { publicGatewayUrl?: string; publicRelayUrl?: string };
  plugins: Array<string | PluginEntrySummary>;
}

interface CfOptions {
  tokenEnv?: string;
  mode?: "single" | "dual";
}

interface ConfigState {
  path: string;
  publicGatewayUrl: string | null;
  publicRelayUrl: string | null;
  cfEntry: boolean;
  cfOptions: CfOptions;
}

/**
 * 读取 cwd 的配置文件摘要（只读展示 + 引导预填；正式解析归 CLI 的
 * config-file 模块）。TOML 用最小扫描（核心零依赖；交互引导层才依赖
 * @clack/prompts）；解析不了的字段显示为缺省而非报错。cfOptions = cf
 * 插件 [[plugins]] 条目的 options 摘要（tokenEnv/mode，flag > config >
 * default 的 config 层）。
 */
function readConfigState(cwd: string): ConfigState | null {
  for (const name of ["opendweb.config.toml", "opendweb.config.json"]) {
    const p = path.join(cwd, name);
    if (!existsSync(p)) continue;
    let summary: ConfigSummary;
    try {
      summary = name.endsWith(".json") ? jsonSummary(readFileSync(p, "utf8")) : tomlSummary(readFileSync(p, "utf8"));
    } catch {
      summary = { server: {}, plugins: [] };
    }
    const cfEntry = (summary.plugins.find((e) => typeof e === "object" && e?.name === "cf" && e.options) ??
      null) as PluginEntrySummary | null;
    return {
      path: p,
      publicGatewayUrl: summary.server.publicGatewayUrl ?? null,
      publicRelayUrl: summary.server.publicRelayUrl ?? null,
      cfEntry: summary.plugins.some((e) => e === "cf" || (typeof e === "object" && e?.name === "cf")),
      cfOptions: cfEntry ? cfOptionsOf(cfEntry.options) : {},
    };
  }
  return null;
}

/** cf options 摘要：只取引导关心的两个键，形态不符即忽略 */
function cfOptionsOf(options: PluginEntrySummary["options"]): CfOptions {
  if (typeof options !== "object" || options === null) return {};
  const out: CfOptions = {};
  if (typeof options.tokenEnv === "string" && options.tokenEnv !== "") out.tokenEnv = options.tokenEnv;
  if (options.mode === "single" || options.mode === "dual") out.mode = options.mode;
  return out;
}

function jsonSummary(text: string): ConfigSummary {
  const parsed = JSON.parse(text) as Partial<{ server: ConfigSummary["server"]; plugins: unknown }>;
  return { server: parsed?.server ?? {}, plugins: Array.isArray(parsed?.plugins) ? (parsed.plugins as ConfigSummary["plugins"]) : [] };
}

/**
 * TOML 最小扫描：server 的公网 URL 赋值行 + [[plugins]] 表数组条目
 * （name/options 的 tokenEnv/mode；数组简写形态退化为裸名）。行式状态机
 * ——比嵌套正则可预测（\s*$ 类贪婪会在块内换行处误截断）。
 */
function tomlSummary(text: string): ConfigSummary {
  const server: ConfigSummary["server"] = {};
  for (const key of ["publicGatewayUrl", "publicRelayUrl"] as const) {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m").exec(text);
    const v = m?.[1];
    if (v !== undefined) server[key] = v;
  }
  const plugins: ConfigSummary["plugins"] = [];
  let current: PluginEntrySummary | null = null;
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
      const arrBody = arr?.[1];
      if (arrBody !== undefined) {
        for (const part of arrBody.split(",")) {
          const s = part.trim().replace(/^"|"$/g, "");
          if (s) plugins.push(s);
        }
      }
      continue;
    }
    const kv = /^\s*(name|tokenEnv|mode)\s*=\s*"([^"]*)"/.exec(line);
    const kvKey = kv?.[1];
    const kvVal = kv?.[2];
    if (kvKey === undefined || kvVal === undefined) continue;
    if (kvKey === "name") current.name = kvVal;
    else {
      current.options = current.options ?? {};
      (current.options as Record<string, string>)[kvKey] = kvVal;
    }
  }
  if (current?.name !== undefined) plugins.push(current);
  return { server, plugins };
}

/** 插件锁定记录（与 CLI 同源：DWEB_HOME ?? ~/.opendweb/plugins.json） */
function readLockRecord(): { package: string; version: string } | null {
  const home = process.env.DWEB_HOME ?? path.join(os.homedir(), ".opendweb");
  try {
    const parsed = JSON.parse(readFileSync(path.join(home, "plugins.json"), "utf8")) as {
      cf?: { package: string; version: string };
    };
    return parsed?.cf ?? null;
  } catch {
    return null;
  }
}

function hostnameFromUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string" || url === "") return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

function relativeTo(cwd: string, p: string): string {
  return p.startsWith(`${cwd}${path.sep}`) ? p.slice(cwd.length + 1) : p;
}
