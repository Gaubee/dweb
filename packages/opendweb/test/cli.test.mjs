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

test("resolveServerArgs: --gateway canonical equals --http alias", () => {
  const canonical = resolveServerArgs(["--gateway", "10.0.0.1:9000"], {});
  const alias = resolveServerArgs(["--http", "10.0.0.1:9000"], {});
  assert.deepEqual(canonical, alias, "--http must be an exact alias of --gateway");
  assert.equal(canonical.gatewayBind, "10.0.0.1:9000");
  // --opt=value 双形式
  assert.equal(resolveServerArgs(["--gateway=10.0.0.2:9100"], {}).gatewayBind, "10.0.0.2:9100");
  assert.deepEqual(
    resolveServerArgs(["--gateway=10.0.0.2:9100"], {}),
    resolveServerArgs(["--gateway", "10.0.0.2:9100"], {}),
  );
});

test("resolveServerArgs: precedence flag > env canonical > env alias > default", () => {
  assert.equal(resolveServerArgs(["--gateway", "F", "--http", "X"], {}).gatewayBind, "F");
  // 别名 flag 与 canonical flag 完全等价：同样按 flag 优先于 env
  assert.equal(resolveServerArgs(["--http", "X"], { DWEB_GATEWAY_BIND: "G" }).gatewayBind, "X");
  assert.equal(resolveServerArgs([], { DWEB_GATEWAY_BIND: "G", DWEB_HTTP_BIND: "H" }).gatewayBind, "G");
  assert.equal(resolveServerArgs([], { DWEB_HTTP_BIND: "H" }).gatewayBind, "H");
  assert.equal(resolveServerArgs([], {}).gatewayBind, "0.0.0.0:8787");
  assert.equal(resolveServerArgs([], {}).relayBind, "0.0.0.0:3340");
});

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
    await new Promise((resolve) => child.once("exit", resolve));
  }
});

test("opendweb server e2e: --http alias starts an identical gateway", async () => {
  const gatewayPort = await freePort();
  const relayPort = await freePort();
  const child = spawn(
    NODE,
    [CLI, "server", "--http", `127.0.0.1:${gatewayPort}`, "--relay", `127.0.0.1:${relayPort}`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  try {
    await waitHealthy(`http://127.0.0.1:${gatewayPort}`);
    assert.match(stdout, ASCII);
    assert.ok(stdout.includes(`  > Local:   http://127.0.0.1:${gatewayPort}`));
    const res = await rawRequest(gatewayPort, "/services.json", {
      Host: `127.0.0.1:${gatewayPort}`,
    });
    const manifest = JSON.parse(res.body);
    assert.equal(manifest.gateway, `http://127.0.0.1:${gatewayPort}`);
  } finally {
    child.kill("SIGINT");
    await new Promise((resolve) => child.once("exit", resolve));
  }
});
