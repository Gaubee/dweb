#!/usr/bin/env node
// opendweb CLI — 顶层入口。server 命令启动自托管服务端（gateway: rendezvous + healthz +
// services.json；另起 iroh relay）。用户面输出全 ASCII（design D1/D10）：横幅/帮助/错误均为英文。
// 用法：
//   opendweb server [--gateway <bind>] [--relay <bind>] [--no-relay] [--trust-proxy]
//                   [--public-gateway <url>] [--public-relay <url>]
//   环境变量 DWEB_GATEWAY_BIND 同义；DWEB_PUBLIC_GATEWAY_URL / DWEB_PUBLIC_RELAY_URL
//   为反代/隧道部署的公网入口公告（public-exposure）。
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
 * 枚举本机全部非 loopback IPv4（去重、排序）。横幅 Network 节与 server 侧
 * services.json 的回退地址（首个非 loopback IPv4）共用同一枚举语义。
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
  return [...new Set(addrs)].sort();
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
 * 公网 URL 轻量校验（public-exposure D2，与 Rust 侧 validate_public_url 同规）：
 * `http(s)://host[:port]`，拒绝 path（尾随单个 "/" 先归一化剥除）、query、fragment、
 * userinfo。返回 null = 合法，否则错误消息。
 * @param {string} value
 * @param {string} label
 * @returns {string | null}
 */
export function validatePublicUrl(value, label) {
  const raw = String(value);
  const v = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  // host 字符集排除 ':' —— 否则贪婪匹配会吞掉端口段绕过端口校验（如 ex.com:0）
  const m = /^(https?):\/\/(\[[^\]]+\]|[^/?#@:]+)(?::(\d+))?$/.exec(v);
  if (!m) {
    return `invalid ${label}: ${raw} (expected http(s)://host[:port], no path/query/fragment)`;
  }
  const port = m[3];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) {
    return `invalid ${label}: ${raw} (port must be 1-65535)`;
  }
  return null;
}

/**
 * 解析 server 子命令参数。--gateway 为 canonical，--http 为兼容别名（完全等价）；
 * 支持 "--opt value" 与 "--opt=value" 双形式；未知选项报错（调用方以退出码 2 处理）。
 * 优先级 flag > env > default（DWEB_GATEWAY_BIND）；公网 URL 覆盖同规
 * （--public-gateway/--public-relay > DWEB_PUBLIC_GATEWAY_URL/DWEB_PUBLIC_RELAY_URL）。
 * @param {string[]} argv process.argv.slice(3)（"server" 之后）
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ gatewayBind: string, relayBind: string, relayEnabled: boolean, trustProxy: boolean, publicGatewayUrl: string | null, publicRelayUrl: string | null } | { error: string }}
 */
export function resolveServerArgs(argv, env = process.env) {
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
  const gatewayBind =
    opts["--gateway"] ?? env.DWEB_GATEWAY_BIND ?? "0.0.0.0:8787";
  const relayBind = opts["--relay"] ?? env.DWEB_RELAY_HTTP_BIND ?? "0.0.0.0:3340";
  // 与 server 侧一致：DWEB_RELAY_ENABLED 为 false/0/off 时关闭
  const relayEnvOff = ["false", "0", "off"].includes(env.DWEB_RELAY_ENABLED ?? "true");
  const relayEnabled = !opts["--no-relay"] && !relayEnvOff;
  const trustProxy = Boolean(opts["--trust-proxy"]) || env.DWEB_TRUST_PROXY === "1";
  const normalize = (v) => (v.endsWith("/") ? v.slice(0, -1) : v);
  const rawPublicGateway = opts["--public-gateway"] ?? env.DWEB_PUBLIC_GATEWAY_URL ?? null;
  const rawPublicRelay = opts["--public-relay"] ?? env.DWEB_PUBLIC_RELAY_URL ?? null;
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
    publicGatewayUrl: rawPublicGateway === null ? null : normalize(rawPublicGateway),
    publicRelayUrl: rawPublicRelay === null ? null : normalize(rawPublicRelay),
  };
}

/**
 * vite 风格启动横幅（全 ASCII，码位 < 128；design D1）。设置公网覆盖时
 * 追加 Public 节（public-exposure D5/D6），并把配置入口指引切换为公网地址。
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
  lines.push(`  * opendweb server v${version}`);
  lines.push(`  > Local:   http://${localHost}:${portText}`);
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
  ];
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

const command = process.argv[2] ?? "help";

async function main() {
  if (command === "server") {
    const resolved = resolveServerArgs(process.argv.slice(3));
    if ("error" in resolved) {
      console.error(`error: ${asciiEscape(resolved.error)}`);
      process.exit(2);
    }
    const { startServer } = await import("@jixo/opendweb-server-binary");
    const server = await startServer({
      gatewayBind: resolved.gatewayBind,
      relayBind: resolved.relayBind,
      relayEnabled: resolved.relayEnabled,
      trustProxy: resolved.trustProxy,
      publicGatewayUrl: resolved.publicGatewayUrl ?? undefined,
      publicRelayUrl: resolved.publicRelayUrl ?? undefined,
    });
    console.log(
      buildBanner({
        version: VERSION,
        gatewayBind: resolved.gatewayBind,
        relayBind: resolved.relayBind,
        relayEnabled: resolved.relayEnabled,
        ips: networkIPv4s(),
        publicGatewayUrl: resolved.publicGatewayUrl,
        publicRelayUrl: resolved.publicRelayUrl,
      }),
    );
    const shutdown = () => {
      server.stop().finally(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await server.exited;
    return;
  }
  if (command === "help" || command === "--help") {
    console.log(`opendweb - self-hosted server for opendweb fabrics

Usage:
  opendweb server [--gateway <bind>] [--relay <bind>] [--no-relay] [--trust-proxy]
                   [--public-gateway <url>] [--public-relay <url>]
      Start the self-hosted server. The gateway (default 0.0.0.0:8787) serves
      rendezvous + /healthz + /services.json; the iroh relay (default
      0.0.0.0:3340) runs on its own port. --http is a legacy alias of --gateway.

      --public-gateway / --public-relay declare the public entry URLs when
      running behind a reverse proxy or tunnel (e.g. Cloudflare Tunnel): the
      service manifest advertises these instead of deriving host/port from
      the request. Form: http(s)://host[:port], no path.

Environment:
  DWEB_GATEWAY_BIND         gateway listen address
  DWEB_RELAY_HTTP_BIND      relay listen address
  DWEB_RELAY_ENABLED        set to false/0/off to disable the relay
  DWEB_TRUST_PROXY          set to 1 to trust X-Forwarded-Proto behind a reverse proxy
  DWEB_PUBLIC_GATEWAY_URL   public gateway URL override (see --public-gateway)
  DWEB_PUBLIC_RELAY_URL     public relay URL override (see --public-relay)

Clients need a single config entry: pick any Network address from the startup
banner (e.g. http://192.168.2.13:8787). The gateway exposes the
machine-readable service manifest at GET /services.json.

Example flow (with @jixo/opendweb-example, in another terminal):
  opendweb-example init --data ~/.dweb-a && opendweb-example chat --data ~/.dweb-a
  opendweb-example join --data ~/.dweb-b <invite-token>
  opendweb-example chat --data ~/.dweb-b

Server deployment: docker image ghcr.io/gaubee/dweb`);
    return;
  }
  console.error(`unknown command: ${asciiEscape(command)} (see: opendweb help)`);
  process.exit(1);
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((e) => {
    console.error(`error: ${asciiEscape(e.message)}`);
    process.exit(1);
  });
}
