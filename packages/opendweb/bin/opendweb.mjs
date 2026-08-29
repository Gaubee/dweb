#!/usr/bin/env node
// opendweb CLI — 顶层入口。server 命令启动自托管服务端（gateway: rendezvous + healthz +
// services.json；另起 iroh relay）。用户面输出全 ASCII（design D1/D10）：横幅/帮助/错误均为英文。
// 用法：
//   opendweb server [--gateway <bind>] [--relay <bind>] [--no-relay] [--trust-proxy]
//                   [--public-gateway <url>] [--public-relay <url>]
//   环境变量 DWEB_GATEWAY_BIND 同义；DWEB_PUBLIC_GATEWAY_URL / DWEB_PUBLIC_RELAY_URL
//   为反代/隧道部署的公网入口公告（public-exposure）。
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadMarketplace, marketplaceAdd, marketplaceRemove } from "../src/marketplace.mjs";
import { resolveAdaptive, wantsPluginHelp } from "../src/plugin-resolve.mjs";
import { dispatchPluginCommand, renderPluginHelp } from "../src/plugin-contract.mjs";
import { pluginAdd, pluginRemove, pluginList } from "../src/plugin-registry.mjs";
import { discoverConfig, loadConfigFile } from "../src/config-file.mjs";
import { loadDeclaredPlugins, fireHook } from "../src/plugin-runtime.mjs";
import { CliExit } from "../src/util.mjs";

// 动态值 ASCII 纪律（D10）：UTF-8 字节小写 \xNN，控制字符同转义保一行一错误
function asciiEscape(v) {
  const s = String(v);
  let out = "";
  for (const b of Buffer.from(s, "utf8")) {
    out += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, "0")}`;
  }
  return out;
}

const require = createRequire(import.meta.url);
const PLATFORMS = ["darwin-arm64", "win32-x64"];
const SUPPORTED = `${process.platform}-${process.arch}`;
if (!PLATFORMS.includes(SUPPORTED)) {
  console.error(
    `opendweb: platform ${SUPPORTED} is not supported yet. v0.2 ships ${PLATFORMS.join(" / ")}; use the docker image ghcr.io/gaubee/dweb for server deployments.`,
  );
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const VERSION = pkg.version;

/**
 * IPv4 点分四段数值升序比较（task 9.2 冻结语义，与 Rust 侧统一）：
 * 逐段按数值比较，"9.0.0.1" 必须排在 "10.0.0.2" 之前（字符串字典序则相反）。
 * @param {string} a
 * @param {string} b
 */
function compareIPv4Numeric(a, b) {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < 4; i++) {
    const d = (Number(pa[i]) || 0) - (Number(pb[i]) || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 枚举本机全部非 loopback IPv4（去重、按点分四段数值升序排序，task 9.2
 * 冻结的跨侧统一语义；Rust 侧对齐由 server 批次负责）。横幅 Network 节
 * 与 services.json 回退地址共用「首个 = 数值最小」的取值语义。
 * @param {NodeJS.Dict<os.NetworkInterfaceInfo[]>} [interfaces]
 * @returns {string[]}
 */
export function networkIPv4s(interfaces = os.networkInterfaces()) {
  const addrs = [];
  for (const list of Object.values(interfaces ?? {})) {
    for (const ni of list ?? []) {
      if ((ni.family === "IPv4" || ni.family === 4) && !ni.internal) addrs.push(ni.address);
    }
  }
  return [...new Set(addrs)].sort(compareIPv4Numeric);
}

/**
 * 拆解 bind 串 "host:port"（支持 "[ipv6]:port" 括号形态）。
 * @param {string} bind
 */
export function splitBind(bind) {
  const bracket = /^\[(.+)\](?::(\d+))?$/.exec(bind);
  if (bracket) {
    return { host: bracket[1], port: bracket[2] !== undefined ? Number(bracket[2]) : undefined };
  }
  const i = bind.lastIndexOf(":");
  if (i === -1) return { host: bind, port: undefined };
  const port = Number(bind.slice(i + 1));
  if (Number.isInteger(port)) return { host: bind.slice(0, i), port };
  return { host: bind, port: undefined };
}

/**
 * 公网 URL 校验 + 规范化（public-exposure D2，与 Rust validate_public_url 同规；
 * R2 P1-1/P1-3 对齐）：`http(s)://host[:port]`；scheme 大小写不敏感并归一为
 * 小写；host 仅限 ASCII 字母/数字/`.`/`-`（或括号 IPv6）；拒绝空白与非
 * ASCII、path（尾随单个 "/" 先剥除）、query、fragment、userinfo、空端口与
 * 1-65535 之外的端口。返回 canonical 形态字符串，非法返回 null。
 * @param {string} value
 * @returns {string | null}
 */
export function normalizePublicUrl(value) {
  const raw = String(value);
  const v = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  // 纯可打印 ASCII：scheme/host/port 合法字符均为 ASCII；与 Rust 侧的显式
  // 拒绝保持一致（空格/控制字符/unicode host 不得进入公告）
  if (!/^[\x21-\x7e]+$/.test(v)) return null;
  // host 字符集排除 ':' —— 否则贪婪匹配会吞掉端口段绕过端口校验（如 ex.com:0）
  const m = /^(https?):\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::(\d+))?$/i.exec(v);
  if (!m) return null;
  const port = m[3];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return null;
  // 括号形态必须是合法 IPv6（net.isIP 判定；与 Rust parse::<Ipv6Addr> 同规）
  if (m[2].startsWith("[")) {
    if (isIp6Literal(m[2].slice(1, -1)) === false) return null;
  }
  // 端口 canonical 重建为十进制整数：前导零必须剥除（":00001" → ":1"，
  // 与 Rust 侧 u32 重建一致——双入口同规）
  return `${m[1].toLowerCase()}://${m[2]}${port !== undefined ? `:${Number(port)}` : ""}`;
}

/**
 * 合法 IPv6 字面量判定（net.isIP 的懒加载包装，避免顶层引入 node:net）。
 * @param {string} inner
 * @returns {boolean}
 */
function isIp6Literal(inner) {
  return netIsIP(inner) === 6;
}
let netIsIPFn = null;
function netIsIP(v) {
  if (netIsIPFn === null) {
    // createRequire 惰性加载，保持模块顶层依赖面不变
    netIsIPFn = createRequire(import.meta.url)("node:net").isIP;
  }
  return netIsIPFn(v);
}

/**
 * 公网 URL 校验（错误消息包装）：返回 null = 合法，否则错误消息。
 * @param {string} value
 * @param {string} label
 * @returns {string | null}
 */
export function validatePublicUrl(value, label) {
  const raw = String(value);
  if (normalizePublicUrl(raw) === null) {
    return `invalid ${label}: ${raw} (expected http(s)://host[:port], no path/query/fragment)`;
  }
  return null;
}

/**
 * 解析 server 子命令参数。优先级 flag > env > config file > default
 * （plugin-marketplace D4：config 层插入在 env 之后；configServer 由静态
 * 配置文件解析而来，schema 已校验类型）。--gateway 为 canonical；
 * 支持 "--opt value" 与 "--opt=value" 双形式；未知选项报错（退出码 2）。
 * （plugin-marketplace D4：config 层插入在 env 之后；configServer 由静态
 * 配置文件解析而来，schema 已校验类型）。--gateway 为 canonical；
 * 支持 "--opt value" 与 "--opt=value" 双形式；未知选项报错（退出码 2）。
 * @param {string[]} argv process.argv.slice(3)（"server" 之后）
 * @param {Record<string, string|undefined>} [env]
 * @param {{ gatewayBind?: string, relayBind?: string, relayEnabled?: boolean, trustProxy?: boolean, publicGatewayUrl?: string, publicRelayUrl?: string }} [configServer]
 * @returns {{ gatewayBind: string, relayBind: string, relayEnabled: boolean, trustProxy: boolean, publicGatewayUrl: string | null, publicRelayUrl: string | null } | { error: string }}
 */
export function resolveServerArgs(argv, env = process.env, configServer = {}) {
  /** @type {Record<string, string|boolean|undefined>} */
  const opts = {};
  const VALUE_OPTS = new Set(["--gateway", "--relay", "--public-gateway", "--public-relay"]);
  const FLAG_OPTS = new Set(["--no-relay", "--trust-proxy"]);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const eq = token.indexOf("=");
    const name = eq === -1 ? token : token.slice(0, eq);
    if (!VALUE_OPTS.has(name) && !FLAG_OPTS.has(name)) {
      return { error: `unknown option ${name}` };
    }
    if (FLAG_OPTS.has(name)) {
      opts[name] = true;
      continue;
    }
    let value = eq === -1 ? undefined : token.slice(eq + 1);
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) return { error: `missing value for ${name}` };
    }
    opts[name] = value;
  }
  // flag > env > config > default（config 只在 env 未给出时生效）
  const gatewayBind =
    opts["--gateway"] ?? env.DWEB_GATEWAY_BIND ?? configServer.gatewayBind ?? "0.0.0.0:8787";
  const relayBind =
    opts["--relay"] ?? env.DWEB_RELAY_HTTP_BIND ?? configServer.relayBind ?? "0.0.0.0:3340";
  // 开关链：--no-relay > env(DWEB_RELAY_ENABLED false/0/off) > config > true
  const relayEnabled = !opts["--no-relay"]
    && !["false", "0", "off"].includes(env.DWEB_RELAY_ENABLED ?? "true")
    && (configServer.relayEnabled ?? true);
  const trustProxy = Boolean(opts["--trust-proxy"])
    || env.DWEB_TRUST_PROXY === "1"
    || (configServer.trustProxy ?? false);
  const rawPublicGateway =
    opts["--public-gateway"] ?? env.DWEB_PUBLIC_GATEWAY_URL ?? configServer.publicGatewayUrl ?? null;
  const rawPublicRelay =
    opts["--public-relay"] ?? env.DWEB_PUBLIC_RELAY_URL ?? configServer.publicRelayUrl ?? null;
  if (rawPublicGateway !== null) {
    const err = validatePublicUrl(rawPublicGateway, "public gateway url");
    if (err) return { error: err };
  }
  if (rawPublicRelay !== null) {
    const err = validatePublicUrl(rawPublicRelay, "public relay url");
    if (err) return { error: err };
  }
  return {
    gatewayBind,
    relayBind,
    relayEnabled,
    trustProxy,
    // canonical 形态（scheme 小写、无尾随 "/"）——与 Rust 侧重建语义一致
    publicGatewayUrl: rawPublicGateway === null ? null : normalizePublicUrl(rawPublicGateway),
    publicRelayUrl: rawPublicRelay === null ? null : normalizePublicUrl(rawPublicRelay),
  };
}

/**
 * vite 风格启动横幅（全 ASCII，码位 < 128；design D1）。设置公网覆盖时
 * 追加 Public 节（public-exposure D5/D6），并把配置入口指引切换为公网地址。
 * 动态值纪律（D10）：所有非字面量输出（version/Local host/port/Network ip/
 * Public URL/服务表 port）一律经 asciiEscape，禁止裸插值。
 * @param {{ version: string, gatewayBind: string, relayBind: string, relayEnabled: boolean, ips: string[], publicGatewayUrl?: string | null, publicRelayUrl?: string | null }} input
 */
export function buildBanner({ version, gatewayBind, relayBind, relayEnabled, ips, publicGatewayUrl = null, publicRelayUrl = null }) {
  const { host, port } = splitBind(gatewayBind);
  const relay = splitBind(relayBind);
  const unspecified = host === "0.0.0.0" || host === "::" || host === "";
  const localHost = unspecified ? "localhost" : host;
  const portText = port === undefined ? "-" : String(port);
  const relayPortText = relay.port === undefined ? "-" : String(relay.port);
  // 枚举函数已去重；此处再防御一次（规格：无遗漏、无重复）
  const uniqueIps = [...new Set(ips)];

  const lines = [];
  lines.push(`  * opendweb server v${asciiEscape(version)}`);
  lines.push(`  > Local:   http://${asciiEscape(localHost)}:${asciiEscape(portText)}`);
  if (uniqueIps.length === 0) {
    // 全部网卡不可枚举时打印占位行而非省略
    lines.push(`  > Network: (no non-loopback IPv4 found)`);
  } else {
    lines.push(`  > Network: http://${asciiEscape(uniqueIps[0])}:${asciiEscape(portText)}`);
    for (const ip of uniqueIps.slice(1)) {
      lines.push(`             http://${asciiEscape(ip)}:${asciiEscape(portText)}`);
    }
  }
  // Public 节：反代/隧道部署下这才是跨网客户端的配置入口（未设置的条目不出现）
  if (publicGatewayUrl !== null || publicRelayUrl !== null) {
    if (publicGatewayUrl !== null) {
      lines.push(`  > Public:  gateway ${asciiEscape(publicGatewayUrl)}`);
    }
    if (publicRelayUrl !== null) {
      const prefix = publicGatewayUrl === null ? "  > Public:  " : "             ";
      lines.push(`${prefix}relay   ${asciiEscape(publicRelayUrl)}`);
    }
  }
  lines.push("");
  if (publicGatewayUrl !== null || publicRelayUrl !== null) {
    lines.push("  Use the Public URLs as the config entry for clients (Network");
    lines.push("  addresses above still work on the local network).");
  } else {
    lines.push("  Use any Network address as the single config entry for clients.");
  }
  lines.push("");
  const rows = [
    ["gateway", portText, "entry point"],
    ["rendezvous", portText, "merged into gateway"],
    ["relay", relayPortText, relayEnabled ? "enabled" : "disabled"],
  ].map(([name, p, state]) => [name, asciiEscape(p), state]);
  const wName = Math.max("NAME".length, ...rows.map((r) => r[0].length)) + 3;
  const wPort = Math.max("PORT".length, ...rows.map((r) => r[1].length)) + 3;
  lines.push(`    ${"NAME".padEnd(wName)}${"PORT".padEnd(wPort)}STATE`);
  for (const [name, p, state] of rows) {
    lines.push(`    ${name.padEnd(wName)}${p.padEnd(wPort)}${state}`);
  }
  lines.push("");
  lines.push("  Press Ctrl+C to stop");
  return lines.join("\n");
}

/**
 * readiness 探测基址：unspecified bind（0.0.0.0/::）换 127.0.0.1；
 * 裸 IPv6 host 加括号。
 * @param {string} bind
 * @returns {string}
 */
function probeBindBase(bind) {
  const { host, port } = splitBind(bind);
  const h = host === "0.0.0.0" || host === "::" || host === "" ? "127.0.0.1" : host;
  const bracketed = h.includes(":") ? `[${h}]` : h;
  return `http://${bracketed}:${port ?? 8787}`;
}

/**
 * gateway /healthz 就绪探测（R2 P1-2 readiness 门）；超时抛错（子进程仍
 * 存活但永不就绪属异常态，由调用方 stop 后上抛）。
 * @param {string} base
 * @param {number} [timeoutMs]
 */
async function waitForGatewayReady(base, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return { ready: true };
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not become healthy within ${timeoutMs}ms (${base}/healthz)`);
}

// ---------------------------------------------------------------------------
// 命令分发（plugin-marketplace D2）：builtin 恒优先，其余首 token 走自适应
// 插件解析；`use <name>` 为显式等价形（纯转发，无附加语义）。
// ---------------------------------------------------------------------------

/** 用户级 CLI 状态目录（DWEB_HOME 覆盖，供测试隔离） */
function dwebHome() {
  return process.env.DWEB_HOME ?? path.join(os.homedir(), ".opendweb");
}

async function marketplaceGlobs() {
  const { globs } = await loadMarketplace({
    fs: await import("node:fs/promises"),
    path: path.join(dwebHome(), "marketplace.json"),
  });
  return globs;
}

/** 继承 stdio 的子进程执行（包管理器安装/卸载的输出直通用户） */
function spawnInherit(cmd, args, { cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit" });
    child.on("error", () => resolve({ code: null, stderr: `${cmd}: command not found` }));
    child.on("exit", (c) => resolve({ code: c ?? 0, stderr: "" }));
  });
}

async function runServer(rest) {
  // --config <path>：静态配置的显式覆盖（非 server 选项，先剥离再解析）
  let configFlag;
  const serverArgv = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--config") {
      configFlag = rest[++i];
      if (configFlag === undefined) throw new CliExit("missing value for --config", 2);
      continue;
    }
    serverArgv.push(rest[i]);
  }
  // 静态配置发现与解析（零执行；plugin-marketplace D4）
  const configPath = discoverConfig({
    cwd: process.cwd(),
    explicit: configFlag,
    existsSync: (p) => fs.existsSync(p),
  });
  const config = configPath
    ? await loadConfigFile({
        path: configPath,
        validateUrl: (v) => validatePublicUrl(v, "config server url"),
      })
    : null;
  const resolved = resolveServerArgs(serverArgv, process.env, config?.server ?? {});
  if ("error" in resolved) {
    console.error(`error: ${asciiEscape(resolved.error)}`);
    process.exit(2);
  }

  // 插件装载与 preStart（plugin-marketplace D5：失败阻断）
  const plugins =
    config && config.plugins.length > 0
      ? await loadDeclaredPlugins({
          plugins: config.plugins,
          globs: await marketplaceGlobs(),
          cwd: process.cwd(),
        })
      : [];
  const pre = await fireHook({
    plugins,
    hook: "server.preStart",
    payload: { server: { ...resolved } },
  });
  if (pre.failures.length > 0) process.exit(1);
  const final = applyServerOverrides(resolved, pre.merged);

  const { startServer } = await import("@jixo/opendweb-server-binary");
  const server = await startServer({
    gatewayBind: final.gatewayBind,
    relayBind: final.relayBind,
    relayEnabled: final.relayEnabled,
    trustProxy: final.trustProxy,
    publicGatewayUrl: final.publicGatewayUrl ?? undefined,
    publicRelayUrl: final.publicRelayUrl ?? undefined,
  });
  // R2 P1-2：先等 gateway 就绪（或子进程退出）再打横幅——子进程因端口冲突/
  // 环境问题秒退时，不打印伪成功横幅；错误转发 stderr 且退出码保留。
  const probeBase = probeBindBase(final.gatewayBind);
  let ready;
  try {
    ready = await Promise.race([
      waitForGatewayReady(probeBase),
      server.exited.then((code) => ({ exited: code })),
    ]);
  } catch (e) {
    await server.stop();
    throw e;
  }
  if (ready && typeof ready.exited === "number") {
    // 根因已由 wrapper 实时转发（R3 P2：不回放 stderrTail，避免重复）；
    // 此处只补 CLI 自身的错误摘要与退出码
    console.error(`error: server exited unexpectedly (code ${ready.exited})`);
    // 退出码 0 的"秒退"同样是异常态（server 不应自行退出），归一为 1
    process.exit(ready.exited === 0 ? 1 : ready.exited);
  }

  // postReady（失败降级 WARNING；结果可带 bannerLines 扩展横幅）
  const post = await fireHook({
    plugins,
    hook: "server.postReady",
    payload: {
      server: { ...final },
      gatewayUrl: probeBase,
      publicGatewayUrl: final.publicGatewayUrl,
      publicRelayUrl: final.publicRelayUrl,
    },
  });
  for (const f of post.failures) {
    console.error(`WARNING[plugin/${asciiEscape(f.name)}]: postReady failed (${asciiEscape(f.error)})`);
  }

  console.log(
    buildBanner({
      version: VERSION,
      gatewayBind: final.gatewayBind,
      relayBind: final.relayBind,
      relayEnabled: final.relayEnabled,
      ips: networkIPv4s(),
      publicGatewayUrl: final.publicGatewayUrl,
      publicRelayUrl: final.publicRelayUrl,
    }),
  );
  for (const line of [...pre.bannerLines, ...post.bannerLines]) {
    console.log(`  ${line}`);
  }

  const shutdown = async () => {
    // preStop：尽力执行（失败仅 WARNING），再停 server
    const preStop = await fireHook({ plugins, hook: "server.preStop", payload: { server: { ...final } } });
    for (const f of preStop.failures) {
      console.error(`WARNING[plugin/${asciiEscape(f.name)}]: preStop failed (${asciiEscape(f.error)})`);
    }
    server.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  const code = await server.exited;
  process.exit(code ?? 0);
}

/** preStart 覆写合并：键白名单 + 同规校验（URL 走 normalizePublicUrl） */
function applyServerOverrides(resolved, merged) {
  if (!merged || Object.keys(merged).length === 0) return resolved;
  const out = { ...resolved };
  for (const [key, value] of Object.entries(merged)) {
    switch (key) {
      case "gatewayBind":
      case "relayBind":
        if (typeof value !== "string" || value.length === 0) throw new CliExit(`preStart override ${key} must be a non-empty string`, 2);
        out[key] = value;
        break;
      case "relayEnabled":
      case "trustProxy":
        if (typeof value !== "boolean") throw new CliExit(`preStart override ${key} must be a boolean`, 2);
        out[key] = value;
        break;
      case "publicGatewayUrl":
      case "publicRelayUrl": {
        const err = validatePublicUrl(String(value), `preStart override ${key}`);
        if (err) throw new CliExit(err, 2);
        out[key] = normalizePublicUrl(String(value));
        break;
      }
      default:
        throw new CliExit(`preStart override has unknown key: ${key}`, 2);
    }
  }
  return out;
}

async function runMarketplace(rest) {
  const [sub, ...args] = rest;
  const fsp = await import("node:fs/promises");
  const mpPath = path.join(dwebHome(), "marketplace.json");
  await fsp.mkdir(dwebHome(), { recursive: true });
  if (sub === "list" || sub === undefined) {
    const { globs } = await loadMarketplace({ fs: fsp, path: mpPath });
    console.log(globs.join("\n"));
    return 0;
  }
  if (sub === "add") {
    if (args.length === 0) throw new CliExit("usage: opendweb marketplace add \"npm:<glob>, ...\"", 2);
    const { added, globs } = await marketplaceAdd({ fs: fsp, path: mpPath, input: args.join(" ") });
    console.log(added.length > 0 ? `added: ${added.join(", ")}` : "no new globs (already present)");
    console.log(globs.join("\n"));
    return 0;
  }
  if (sub === "remove") {
    if (args.length === 0) throw new CliExit("usage: opendweb marketplace remove \"npm:<glob>, ...\"", 2);
    const { removed, globs } = await marketplaceRemove({ fs: fsp, path: mpPath, input: args.join(" ") });
    console.log(`removed: ${removed.join(", ")}`);
    console.log(globs.join("\n"));
    return 0;
  }
  throw new CliExit(`unknown marketplace subcommand: ${sub} (add | list | remove)`, 2);
}

async function runPlugin(rest) {
  const [sub, name] = rest;
  const fsp = await import("node:fs/promises");
  const lockPath = path.join(dwebHome(), "plugins.json");
  await fsp.mkdir(dwebHome(), { recursive: true });
  if (sub === "list" || sub === undefined) {
    const records = await pluginList(lockPath);
    if (records.length === 0) {
      console.log("(no plugins installed)");
      return 0;
    }
    for (const r of records) console.log(`${r.name}  ${r.package}@${r.version}`);
    return 0;
  }
  if (sub === "add") {
    if (!name) throw new CliExit("usage: opendweb plugin add <name>", 2);
    const { pkg, version } = await pluginAdd({
      name,
      globs: await marketplaceGlobs(),
      cwd: process.cwd(),
      lockPath,
      existsSync: (p) => fs.existsSync(p),
      run: spawnInherit,
    });
    console.log(`installed: ${name} (${pkg}@${version})`);
    return 0;
  }
  if (sub === "remove") {
    if (!name) throw new CliExit("usage: opendweb plugin remove <name>", 2);
    const { pkg } = await pluginRemove({
      name,
      cwd: process.cwd(),
      lockPath,
      existsSync: (p) => fs.existsSync(p),
      run: spawnInherit,
    });
    console.log(`removed: ${name} (${pkg})`);
    return 0;
  }
  throw new CliExit(`unknown plugin subcommand: ${sub} (add | list | remove)`, 2);
}

/** `opendweb setup`：按配置清单序执行全部 setup 钩子并聚合（D5） */
async function runSetup(rest) {
  if (rest.length > 0) throw new CliExit(`setup takes no arguments (got ${rest[0]})`, 2);
  const configPath = discoverConfig({ cwd: process.cwd(), existsSync: (p) => fs.existsSync(p) });
  if (configPath === null) {
    console.log("no config file found; nothing to set up");
    return 0;
  }
  const config = await loadConfigFile({
    path: configPath,
    validateUrl: (v) => validatePublicUrl(v, "config server url"),
  });
  const plugins = await loadDeclaredPlugins({
    plugins: config.plugins,
    globs: await marketplaceGlobs(),
    cwd: process.cwd(),
  });
  const targets = plugins.filter((p) => p.hooks.includes("setup"));
  if (targets.length === 0) {
    console.log("no plugins declare a setup hook");
    return 0;
  }
  let failed = false;
  for (const p of targets) {
    const r = await p.invoke("setup", { server: config.server ?? {}, cwd: process.cwd() });
    if (r.ok) {
      console.log(`setup ok: ${asciiEscape(p.name)}`);
    } else {
      failed = true;
      console.error(`error[plugin/${asciiEscape(p.name)}]: ${asciiEscape(r.error ?? "setup failed")}`);
    }
  }
  return failed ? 1 : 0;
}

/** 自适应插件调用：解析 → help 零执行 / 命令派发（D2/D3） */
async function runAdaptive(name, rest) {
  const { manifest } = await resolveAdaptive({
    name,
    globs: await marketplaceGlobs(),
    cwd: process.cwd(),
  });
  const [command, ...argv] = rest;
  if (command === undefined || wantsPluginHelp({ argv: rest })) {
    console.log(renderPluginHelp({ name, manifest }));
    return 0;
  }
  const code = await dispatchPluginCommand({ manifest, command, argv, cwd: process.cwd() });
  return code;
}

async function main() {
  const command = process.argv[2] ?? "help";
  const rest = process.argv.slice(3);

  if (command === "server") return await runServer(rest);
  if (command === "marketplace") return await runMarketplace(rest);
  if (command === "plugin") return await runPlugin(rest);
  if (command === "setup") return await runSetup(rest);
  if (command === "use") {
    const [name, ...restAfterUse] = rest;
    if (!name) throw new CliExit("usage: opendweb use <plugin-name> [command]", 2);
    const code = await runAdaptive(name, restAfterUse);
    if (code > 0) process.exit(code);
    return;
  }
  if (command === "help" || command === "--help") {
    console.log(HELP_TEXT);
    return;
  }
  // 自适应：非 builtin 首 token → 插件解析（未安装时错误信息含安装指引）
  const code = await runAdaptive(command, rest);
  if (code > 0) process.exit(code);
}

const HELP_TEXT = `opendweb - self-hosted server for opendweb fabrics

Usage:
  opendweb server [--gateway <bind>] [--relay <bind>] [--no-relay] [--trust-proxy]
                   [--public-gateway <url>] [--public-relay <url>] [--config <path>]
      Start the self-hosted server. The gateway (default 0.0.0.0:8787) serves
      rendezvous + /healthz + /services.json; the iroh relay (default
      0.0.0.0:3340) runs on its own port. Precedence: flag > env > config
      file (opendweb.config.toml|.json) > default.

  opendweb marketplace add|list|remove "npm:<glob>, ..."
      Manage plugin candidate globs. Default: npm:@jixo/opendweb-ext-*,
      npm:opendweb-* (declaration order = resolution order; npm: only).

  opendweb plugin add|list|remove <name>
      Install plugins into the current project (detected package manager)
      and lock name@version in ~/.opendweb/plugins.json.

  opendweb setup
      Run the setup hook of every plugin declared in the config file, in
      declaration order; non-zero exit if any fails.

  opendweb <plugin-name> [command] [...]     (or: opendweb use <plugin-name> ...)
      Adaptive plugin dispatch. Non-builtin first tokens resolve via the
      marketplace globs to an installed package's ./opendweb-plugin export.
      Not installed? The error prints the exact plugin add command.

Environment:
  DWEB_GATEWAY_BIND         gateway listen address
  DWEB_RELAY_HTTP_BIND      relay listen address
  DWEB_RELAY_ENABLED        set to false/0/off to disable the relay
  DWEB_TRUST_PROXY          set to 1 to trust X-Forwarded-Proto behind a reverse proxy
  DWEB_PUBLIC_GATEWAY_URL   public gateway URL override (see --public-gateway)
  DWEB_PUBLIC_RELAY_URL     public relay URL override (see --public-relay)
  DWEB_HOME                 CLI state directory (default ~/.opendweb)

Clients need a single config entry: pick any Network address from the startup
banner (e.g. http://192.168.2.13:8787). The gateway exposes the
machine-readable service manifest at GET /services.json.

Example flow (with @jixo/opendweb-example, in another terminal):
  opendweb-example init --data ~/.dweb-a && opendweb-example chat --data ~/.dweb-a
  opendweb-example join --data ~/.dweb-b <invite-token>
  opendweb-example chat --data ~/.dweb-b

Server deployment: docker image ghcr.io/gaubee/dweb`;

function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main()
    .then((code) => {
      // 命令返回非零退出码时显式退出（resolve 自然退出恒为 0）
      if (typeof code === "number" && code > 0) process.exit(code);
    })
    .catch((e) => {
      console.error(`error: ${asciiEscape(e.message)}`);
      process.exit(e.exitCode ?? 1);
    });
}
