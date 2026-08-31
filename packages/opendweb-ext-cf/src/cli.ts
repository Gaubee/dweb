// CLI 面（./opendweb-plugin）：{name, apiVersion, commands, run}。1.0.0 命令面：
// setup（交互发现式向导 / 非交互幂等 provision）、verify、plan、status（零网络
// 盘点，--verify 除外）、login/logout（OAuth 浏览器登录态管理）。
import path from "node:path";
import os from "node:os";
import { exec } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { planExposure, verifyExposure, type ExposureMode } from "./route-model.js";
import { runInteractiveSetup } from "./tui.js";
import { getApiToken, loadStoredAuth, saveStoredAuth, clearStoredAuth, resolveClientId, loginFlow, CF_OAUTH } from "./auth.js";
import { createGateway } from "./cf-client.js";
import { provision } from "./provision.js";
import { pickZoneForHostname } from "./index.js";

type Args = Record<string, unknown>;
const str = (a: Args, k: string): string | undefined => {
  const v = a[k];
  return typeof v === "string" && v !== "" ? v : undefined;
};
const bool = (a: Args, k: string): boolean => a[k] === true;

interface CommandSpec {
  name: string;
  description: string;
  args: { type: "object"; properties: Record<string, { type: "string" | "number" | "boolean" }>; required?: string[] };
}

const COMMANDS: CommandSpec[] = [
  {
    name: "setup",
    description: "interactive exposure wizard (auth -> zone -> tunnel -> ingress/DNS/config), or non-interactive with --hostname",
    args: {
      type: "object",
      properties: {
        hostname: { type: "string" },
        mode: { type: "string" },
        "dry-run": { type: "boolean" },
        "skip-verify": { type: "boolean" },
        interactive: { type: "boolean" },
        "token-env": { type: "string" },
      },
    },
  },
  {
    name: "verify",
    description: "end-to-end check via the public services.json",
    args: { type: "object", properties: { hostname: { type: "string" } }, required: ["hostname"] },
  },
  {
    name: "plan",
    description: "print the exposure plan and ingress rules (no side effects)",
    args: { type: "object", properties: { hostname: { type: "string" }, mode: { type: "string" } }, required: ["hostname"] },
  },
  {
    name: "status",
    description: "read-only local status (config, plan, plugin lock, auth session)",
    args: { type: "object", properties: { hostname: { type: "string" }, mode: { type: "string" }, verify: { type: "boolean" } } },
  },
  { name: "login", description: "log in with Cloudflare (browser, OAuth)", args: { type: "object", properties: {} } },
  { name: "logout", description: "forget the saved Cloudflare session", args: { type: "object", properties: {} } },
];

interface RunContext {
  command: string;
  args: Args;
  log: (line?: string) => void;
  cwd: string;
  stdout?: { write(s: string): void };
  stderr?: { write(s: string): void };
}

function dwebHome(): string {
  return process.env.DWEB_HOME ?? path.join(os.homedir(), ".opendweb");
}

export default {
  name: "cf",
  apiVersion: 1 as const,
  commands: COMMANDS,
  async run({ command, args, log, cwd }: RunContext): Promise<{ exit: number }> {
    const mode: ExposureMode = str(args, "mode") === "single" ? "single" : "dual";
    if (command === "login") {
      const clientId = resolveClientId(undefined, process.env);
      if (clientId === null) {
        throw new Error(
          "browser login is not configured: create an OAuth client at dash.cloudflare.com (Manage Account -> OAuth clients, redirect URI " +
            `http://127.0.0.1:${CF_OAUTH.callbackPort}/callback) and export CF_OAUTH_CLIENT_ID, or use an API token (CLOUDFLARE_API_TOKEN) instead`,
        );
      }
      log("opening the browser for Cloudflare authorization...");
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      const tokens = await loginFlow({ clientId, openBrowser: (url) => void exec(`${opener} ${JSON.stringify(url)}`) });
      if (tokens.refreshToken === undefined) throw new Error("no refresh token returned (offline_access scope missing?)");
      await saveStoredAuth(dwebHome(), {
        refreshToken: tokens.refreshToken,
        clientId,
        accessToken: tokens.accessToken,
        ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
      });
      log("logged in (session saved; refresh handled automatically)");
      return { exit: 0 };
    }
    if (command === "logout") {
      await clearStoredAuth(dwebHome(), async (p) => { const { rm } = await import("node:fs/promises"); await rm(p, { force: true }); });
      log("session forgotten");
      return { exit: 0 };
    }
    if (command === "plan") {
      const hostname = str(args, "hostname");
      if (!hostname) throw new Error("plan requires --hostname");
      const plan = planExposure({ hostname, mode });
      log(`mode:    ${plan.mode}`);
      log(`gateway: ${plan.gatewayHost} (${plan.publicGatewayUrl})`);
      log(`relay:   ${plan.relayHost} (${plan.publicRelayUrl})`);
      return { exit: 0 };
    }
    if (command === "verify") {
      const hostname = str(args, "hostname");
      if (!hostname) throw new Error("verify requires --hostname");
      const plan = planExposure({ hostname, mode });
      const v = await verifyExposure({ publicGatewayUrl: plan.publicGatewayUrl, expectedRelayUrl: plan.publicRelayUrl });
      if (!v.ok) throw new Error(v.error);
      log(`ok: ${plan.publicGatewayUrl}/services.json advertises ${plan.publicRelayUrl}`);
      return { exit: 0 };
    }
    if (command === "status") {
      return runStatus({ args, mode, log, cwd });
    }
    if (command === "setup") {
      const isTTY = Boolean(process.stdin.isTTY);
      if (wantsInteractive(
        {
          interactive: bool(args, "interactive"),
          ...(str(args, "hostname") !== undefined ? { hostname: str(args, "hostname") } : {}),
        },
        isTTY,
      )) {
        const config = readConfigState(cwd);
        const cfOpts = config?.cfOptions ?? {};
        const suggested = str(args, "hostname") ?? hostnameFromUrl(config?.publicGatewayUrl);
        const tokenEnv = str(args, "token-env") ?? cfOpts.tokenEnv ?? "TUNNEL_TOKEN";
        return runInteractiveSetup({
          cwd,
          tokenEnvName: tokenEnv,
          ...(suggested !== undefined && suggested !== null ? { suggestedHostname: suggested } : {}),
          ...(cfOpts.mode !== undefined ? { suggestedMode: cfOpts.mode } : {}),
          forceDryRun: bool(args, "dry-run"),
          skipVerify: bool(args, "skip-verify"),
        });
      }
      // 非交互：env/登录态 -> 幂等 provision
      const hostname = str(args, "hostname");
      if (!hostname) throw new Error("--hostname is required (or --interactive / a terminal for the wizard)");
      const home = dwebHome();
      const apiToken = await getApiToken(home, { env: process.env, stored: await loadStoredAuth(home) });
      if (apiToken === null) {
        throw new Error("not authenticated: `opendweb cf login` or set CLOUDFLARE_API_TOKEN");
      }
      const client = await createGateway(apiToken);
      const zone = await pickZoneForHostname(client, hostname);
      await provision({
        client,
        hostname,
        mode,
        zone,
        tunnel: { kind: "auto" },
        cwd,
        dryRun: bool(args, "dry-run"),
        skipVerify: bool(args, "skip-verify"),
      });
      return { exit: 0 };
    }
    throw new Error(`unknown command: ${command}`);
  },
};

export function wantsInteractive(args: { interactive?: boolean | undefined; hostname?: string | undefined }, isTTY: boolean): boolean {
  return args.interactive === true || (!args.hostname && isTTY);
}

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
  const auth = await loadStoredAuth(dwebHome());
  log(`auth:     ${auth !== null ? "browser session saved (cf login)" : process.env.CLOUDFLARE_API_TOKEN ? "CLOUDFLARE_API_TOKEN is set" : "none (cf login or CLOUDFLARE_API_TOKEN)"}`);
  const anchors = [config?.cfOptions as { accountId?: string; zoneId?: string; tunnelId?: string } | undefined];
  const a = anchors[0];
  log(`tunnel:   ${a?.tunnelId ? `anchor ${a.tunnelId}${a.zoneId ? ` (zone ${a.zoneId})` : ""}` : "no resource anchors in the config (run cf setup)"}`);
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
  /** 1.0.0 资源锚点（renderConfigToml 写入 [plugins.options]；status 展示用） */
  accountId?: string;
  zoneId?: string;
  tunnelId?: string;
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

/** cf options 摘要：取引导/盘点关心的键（tokenEnv/mode + 资源锚点），形态不符即忽略 */
function cfOptionsOf(options: PluginEntrySummary["options"]): CfOptions {
  if (typeof options !== "object" || options === null) return {};
  const out: CfOptions = {};
  if (typeof options.tokenEnv === "string" && options.tokenEnv !== "") out.tokenEnv = options.tokenEnv;
  if (options.mode === "single" || options.mode === "dual") out.mode = options.mode;
  for (const anchor of ["accountId", "zoneId", "tunnelId"] as const) {
    const v = (options as Record<string, unknown>)[anchor];
    if (typeof v === "string" && v !== "") out[anchor] = v;
  }
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
    const kv = /^\s*(name|tokenEnv|mode|accountId|zoneId|tunnelId)\s*=\s*"([^"]*)"/.exec(line);
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
