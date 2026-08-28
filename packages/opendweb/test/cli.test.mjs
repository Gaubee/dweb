// opendweb CLI 测试：参数解析/横幅纯函数（--gateway 与 --http 别名等价、全 ASCII 纪律、
// Network IPv4 枚举）+ e2e（随机端口自起 server，断言 /services.json 与 GET /；
// trustProxy 缺省时 X-Forwarded-Proto 不采信）。e2e 依赖 @jixo/opendweb-server-binary
// 内已 pack 的平台二进制；进程级启动/healthz 细节由 server-binary 测试补充覆盖。
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildBanner,
  networkIPv4s,
  resolveServerArgs,
  splitBind,
} from "../bin/opendweb.mjs";

const NODE = process.execPath;
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/opendweb.mjs");
const ASCII = /^[\x00-\x7F]*$/;

/** 随机空闲端口（bind :0 后立即释放，存在极小竞态窗口） */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * 等待子进程退出（竞态安全）：若 'exit' 事件已在我们挂监听器之前触发
 * （子进程秒退场景，如 CLI 参数校验失败），exitCode/signalCode 已非 null，
 * 直接返回而不是永远等待一个不会再来的事件。
 * @param {import("node:child_process").ChildProcess} child
 */
function waitExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

/** @param {string} url @param {number} [ms] */
async function waitHealthy(url, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/healthz`);
      if (res.ok) return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`healthz not ready: ${url}`);
}

/** 裸 HTTP 请求：注入 Host / X-Forwarded-Proto 等头（fetch 会忽略部分受控头覆盖） */
function rawRequest(port, reqPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: reqPath, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
  });
}

test("resolveServerArgs: relay enable/disable and trustProxy", () => {
  assert.equal(resolveServerArgs([], {}).relayEnabled, true);
  assert.equal(resolveServerArgs(["--no-relay"], {}).relayEnabled, false);
  assert.equal(resolveServerArgs([], { DWEB_RELAY_ENABLED: "false" }).relayEnabled, false);
  assert.equal(resolveServerArgs([], { DWEB_RELAY_ENABLED: "0" }).relayEnabled, false);
  assert.equal(resolveServerArgs([], {}).trustProxy, false);
  assert.equal(resolveServerArgs([], { DWEB_TRUST_PROXY: "1" }).trustProxy, true);
  assert.equal(resolveServerArgs(["--trust-proxy"], {}).trustProxy, true);
});

test("resolveServerArgs: unknown option and missing value errors", () => {
  assert.equal(resolveServerArgs(["--foo"], {}).error, "unknown option --foo");
  assert.equal(resolveServerArgs(["--gateway"], {}).error, "missing value for --gateway");
  assert.equal(resolveServerArgs(["--public-gateway"], {}).error, "missing value for --public-gateway");
  assert.equal(resolveServerArgs(["--public-relay"], {}).error, "missing value for --public-relay");
});

test("resolveServerArgs: public URL overrides (flag > env > null, trailing slash normalized)", () => {
  const none = resolveServerArgs([], {});
  assert.equal(none.publicGatewayUrl, null);
  assert.equal(none.publicRelayUrl, null);

  const fromEnv = resolveServerArgs([], {
    DWEB_PUBLIC_GATEWAY_URL: "https://gw.example.com/",
    DWEB_PUBLIC_RELAY_URL: "https://relay.example.com",
  });
  assert.equal(fromEnv.publicGatewayUrl, "https://gw.example.com");
  assert.equal(fromEnv.publicRelayUrl, "https://relay.example.com");

  const flag = resolveServerArgs(
    ["--public-gateway", "https://flag-gw.example.com"],
    { DWEB_PUBLIC_GATEWAY_URL: "https://env-gw.example.com" },
  );
  assert.equal(flag.publicGatewayUrl, "https://flag-gw.example.com");

  const inline = resolveServerArgs(["--public-relay=https://r.example.com:443"], {});
  assert.equal(inline.publicRelayUrl, "https://r.example.com:443");
});

test("resolveServerArgs: public URL validation mirrors server rules", () => {
  // path 前缀（iroh set_path 会丢弃 path，必然错配）、query/fragment、
  // 非 http(s)、userinfo、端口越界
  for (const bad of [
    "https://ex.com/dweb",
    "https://ex.com/?a=b",
    "https://ex.com/#frag",
    "ftp://ex.com",
    "https://user:pass@ex.com",
    "https://ex.com:0",
    "https://ex.com:65536",
    "not a url",
  ]) {
    const r = resolveServerArgs(["--public-gateway", bad], {});
    assert.ok(r.error, `--public-gateway ${bad} must be rejected`);
    assert.match(r.error, /invalid public gateway url/, bad);
  }
  // 合法形态：括号 IPv6、带端口、尾随 "/"
  const ok = resolveServerArgs(
    ["--public-gateway", "http://[fd00::1]:9000", "--public-relay", "https://relay.example.com/"],
    {},
  );
  assert.equal(ok.publicGatewayUrl, "http://[fd00::1]:9000");
  assert.equal(ok.publicRelayUrl, "https://relay.example.com");
});

test("banner: all-ASCII, Local/Network enumeration, NAME | PORT service table", () => {
  const ips = ["192.168.2.13", "10.211.55.2"];
  const banner = buildBanner({
    version: "0.2.0",
    gatewayBind: "0.0.0.0:8787",
    relayBind: "0.0.0.0:3340",
    relayEnabled: true,
    ips,
  });
  assert.match(banner, ASCII, "banner must be all-ASCII");
  assert.ok(banner.includes("  * opendweb server v0.2.0"));
  assert.ok(banner.includes("  > Local:   http://localhost:8787"));
  assert.ok(banner.includes("  > Network: http://192.168.2.13:8787"));
  assert.ok(banner.includes("             http://10.211.55.2:8787"));
  assert.ok(banner.includes("  Use any Network address as the single config entry for clients."));
  assert.match(banner, /NAME\s+PORT\s+STATE/);
  assert.ok(banner.includes("gateway"));
  assert.ok(banner.includes("rendezvous"));
  assert.ok(banner.includes("entry point"));
  assert.ok(banner.includes("merged into gateway"));
  assert.ok(banner.includes("relay"));
  assert.ok(banner.includes("enabled"));
  assert.ok(banner.includes("Press Ctrl+C to stop"));
});

test("banner: placeholder line when no non-loopback IPv4 found", () => {
  const banner = buildBanner({
    version: "0.2.0",
    gatewayBind: "127.0.0.1:8787",
    relayBind: "0.0.0.0:3340",
    relayEnabled: false,
    ips: [],
  });
  assert.match(banner, ASCII);
  assert.ok(banner.includes("(no non-loopback IPv4 found)"));
  assert.ok(banner.includes("> Local:   http://127.0.0.1:8787"));
  assert.ok(banner.includes("disabled"));
  // 每个地址恰一行：占位行只出现一次
  assert.equal(banner.split("(no non-loopback IPv4 found)").length - 1, 1);
});

test("banner: Public section only when overrides set, guidance line switches", () => {
  const base = {
    version: "0.2.0",
    gatewayBind: "0.0.0.0:8787",
    relayBind: "0.0.0.0:3340",
    relayEnabled: true,
    ips: ["192.168.2.13"],
  };
  // 未设置：无 Public 节，指引仍是 Network 地址
  const plain = buildBanner(base);
  assert.ok(!plain.includes("Public"));
  assert.ok(plain.includes("Use any Network address as the single config entry for clients."));

  // 双覆盖：Public 节逐行列出，指引切换
  const full = buildBanner({
    ...base,
    publicGatewayUrl: "https://gw.example.com",
    publicRelayUrl: "https://relay.example.com",
  });
  assert.match(full, ASCII);
  assert.ok(full.includes("  > Public:  gateway https://gw.example.com"));
  assert.ok(full.includes("             relay   https://relay.example.com"));
  assert.ok(full.includes("Use the Public URLs as the config entry for clients"));

  // 仅 relay 覆盖：gateway 行不出现
  const relayOnly = buildBanner({ ...base, publicRelayUrl: "https://relay.example.com" });
  assert.ok(relayOnly.includes("  > Public:  relay   https://relay.example.com"));
  assert.ok(!relayOnly.includes("gateway https://"));
});

test("banner: no duplicate Network lines for repeated interface addresses", () => {
  const banner = buildBanner({
    version: "0.2.0",
    gatewayBind: "0.0.0.0:8787",
    relayBind: "0.0.0.0:3340",
    relayEnabled: true,
    ips: ["192.168.2.13", "192.168.2.13"],
  });
  assert.equal(banner.split("http://192.168.2.13:8787").length - 1, 1);
});

test("networkIPv4s enumerates all non-loopback IPv4, deduped and sorted", () => {
  const expected = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if ((ni.family === "IPv4" || ni.family === 4) && !ni.internal) expected.push(ni.address);
    }
  }
  const dedupedSorted = [...new Set(expected)].sort();
  assert.deepEqual(networkIPv4s(), dedupedSorted);
  // 纯函数注入形态
  assert.deepEqual(
    networkIPv4s({
      lo: [
        { family: "IPv4", internal: true, address: "127.0.0.1" },
        { family: "IPv6", internal: true, address: "::1" },
      ],
      en0: [
        { family: "IPv4", internal: false, address: "10.0.0.2" },
        { family: "IPv4", internal: false, address: "10.0.0.1" },
        { family: "IPv6", internal: false, address: "fd00::5" },
      ],
      en1: [{ family: "IPv4", internal: false, address: "10.0.0.2" }],
    }),
    ["10.0.0.1", "10.0.0.2"],
  );
});

test("splitBind handles ipv6 bracket form", () => {
  assert.deepEqual(splitBind("0.0.0.0:8787"), { host: "0.0.0.0", port: 8787 });
  assert.deepEqual(splitBind("[::]:8787"), { host: "::", port: 8787 });
  assert.deepEqual(splitBind("example.com:80"), { host: "example.com", port: 80 });
});

test("opendweb help is all-ASCII and mentions server usage", async () => {
  const out = await new Promise((resolve, reject) => {
    execFile(NODE, [CLI, "help"], (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(stdout + stderr);
    });
  });
  assert.match(out, ASCII, "help output must be all-ASCII");
  assert.ok(out.includes("opendweb server"), "help mentions server command");
  assert.ok(out.includes("--gateway"), "help documents --gateway");
  assert.ok(out.includes("DWEB_GATEWAY_BIND"), "help documents env vars");
  assert.ok(out.includes("opendweb-example"), "help mentions example flow");
});

test("opendweb server e2e: ASCII banner + /services.json + GET / (random ports)", async () => {
  const gatewayPort = await freePort();
  const relayPort = await freePort();
  const child = spawn(
    NODE,
    [CLI, "server", "--gateway", `127.0.0.1:${gatewayPort}`, "--relay", `127.0.0.1:${relayPort}`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stdout += d));
  try {
    await waitHealthy(`http://127.0.0.1:${gatewayPort}`);

    // 横幅：全 ASCII + Local/Network + 服务表
    assert.match(stdout, ASCII, "CLI output must be all-ASCII");
    assert.ok(stdout.includes(`  > Local:   http://127.0.0.1:${gatewayPort}`));
    const ips = networkIPv4s();
    if (ips.length > 0) {
      assert.ok(stdout.includes(`http://${ips[0]}:${gatewayPort}`), "banner lists network IPv4");
    } else {
      assert.ok(stdout.includes("(no non-loopback IPv4 found)"));
    }
    assert.match(stdout, /NAME\s+PORT\s+STATE/);

    // /services.json 契约
    const res = await rawRequest(gatewayPort, "/services.json", {
      Host: `127.0.0.1:${gatewayPort}`,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-type"], "application/json");
    assert.equal(res.headers["cache-control"], "no-store");
    const manifest = JSON.parse(res.body);
    assert.equal(manifest.server, "opendweb");
    assert.ok(typeof manifest.version === "string" && manifest.version.length > 0);
    assert.equal(manifest.gateway, `http://127.0.0.1:${gatewayPort}`);
    const byName = Object.fromEntries(manifest.services.map((s) => [s.name, s]));
    assert.deepEqual(Object.keys(byName).sort(), ["relay", "rendezvous"]);
    assert.equal(byName.rendezvous.enabled, true);
    assert.equal(byName.rendezvous.url, `http://127.0.0.1:${gatewayPort}/rendezvous`);
    assert.equal(byName.relay.enabled, true);
    assert.equal(byName.relay.url, `http://127.0.0.1:${relayPort}`);

    // X-Forwarded-Proto 信任边界：未设置 DWEB_TRUST_PROXY=1 时不采信
    const xf = await rawRequest(gatewayPort, "/services.json", {
      Host: `127.0.0.1:${gatewayPort}`,
      "X-Forwarded-Proto": "https",
    });
    const xfManifest = JSON.parse(xf.body);
    assert.equal(xfManifest.gateway, `http://127.0.0.1:${gatewayPort}`);

    // GET / 纯文本摘要（全 ASCII，与清单一致）
    const root = await rawRequest(gatewayPort, "/", { Host: `127.0.0.1:${gatewayPort}` });
    assert.equal(root.status, 200);
    assert.match(root.headers["content-type"], /^text\/plain/);
    assert.match(root.body, ASCII, "GET / must be all-ASCII");
    assert.ok(root.body.includes("opendweb server"));
    assert.ok(root.body.includes(`http://127.0.0.1:${relayPort}`));
  } finally {
    child.kill("SIGINT");
    await waitExit(child);
  }
});

test("opendweb server e2e: --http alias starts an identical gateway", async () => {
  // 154baf3 移除 --http 别名：该入口现在快速失败（退出码 2 + 错误消息），
  // 而不是启动等价 gateway。断言跟随当前语义。
  const gatewayPort = await freePort();
  const relayPort = await freePort();
  const child = spawn(
    NODE,
    [CLI, "server", "--http", `127.0.0.1:${gatewayPort}`, "--relay", `127.0.0.1:${relayPort}`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stdout += d));
  const code = await new Promise((resolve) => {
    child.once("exit", (c) => resolve(c));
  });
  assert.equal(code, 2);
  assert.match(stdout, /unknown option --http/);
});

test("resolveServerArgs: --http is now an unknown option", () => {
  // ESM 直用顶部已导入的 resolveServerArgs（历史版本误用 require 导致
  // ReferenceError 掩盖真实断言）
  assert.equal(
    resolveServerArgs(["--http", "0.0.0.0:9999"], {}).error,
    "unknown option --http",
  );
});

test("opendweb server e2e: public URL overrides are advertised in /services.json", async () => {
  const gatewayPort = await freePort();
  const relayPort = await freePort();
  const child = spawn(
    NODE,
    [
      CLI, "server",
      "--gateway", `127.0.0.1:${gatewayPort}`,
      "--relay", `127.0.0.1:${relayPort}`,
      "--public-gateway", "https://gw.example.com",
      "--public-relay", "https://relay.example.com",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stdout += d));
  try {
    await waitHealthy(`http://127.0.0.1:${gatewayPort}`);
    // 横幅 Public 节（public-exposure D5）
    assert.ok(stdout.includes("  > Public:  gateway https://gw.example.com"));
    assert.ok(stdout.includes("             relay   https://relay.example.com"));
    // manifest：覆盖值原样公告，Host 派生被跳过（D3）
    const res = await rawRequest(gatewayPort, "/services.json", { Host: `127.0.0.1:${gatewayPort}` });
    const manifest = JSON.parse(res.body);
    assert.equal(manifest.gateway, "https://gw.example.com");
    const byName = Object.fromEntries(manifest.services.map((s) => [s.name, s]));
    assert.equal(byName.rendezvous.url, "https://gw.example.com/rendezvous");
    assert.equal(byName.relay.url, "https://relay.example.com");
    // GET / 摘要同样公告公网地址
    const root = await rawRequest(gatewayPort, "/", { Host: `127.0.0.1:${gatewayPort}` });
    assert.ok(root.body.includes("https://relay.example.com"));
  } finally {
    child.kill("SIGINT");
    await waitExit(child);
  }
});

test("opendweb server e2e: invalid public URL fails fast with exit code 2", async () => {
  // path 前缀在 CLI 层即被拒（与 Rust validate_public_url 同规），子进程不启动
  const code = await new Promise((resolve) => {
    const child = spawn(
      NODE,
      [CLI, "server", "--public-gateway", "https://ex.com/dweb"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    child.on("exit", (c) => resolve(c));
  });
  assert.equal(code, 2);
});
