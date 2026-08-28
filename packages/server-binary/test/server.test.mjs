// @jixo/opendweb-server-binary 测试（node --test）
// 覆盖：healthz（随机端口）、httpBind 别名等价、/services.json 清单与 GET / 摘要、
// DWEB_TRUST_PROXY 透传的 scheme 信任边界。每个用例自起 server 并在结束时停止。
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { startServer } from "../index.js";

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
async function waitHealthy(url, ms = 15000) {
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

/**
 * 裸 HTTP 请求（node:http）：用于注入 Host / X-Forwarded-Proto 等头
 * （fetch 规范会忽略部分受控头的覆盖）。
 * @param {number} port @param {string} path @param {Record<string,string>} [headers]
 */
function rawRequest(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path, headers },
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

test("server binary serves gateway + relay healthz (random ports)", async () => {
  const gatewayPort = await freePort();
  const relayPort = await freePort();
  const server = await startServer({
    gatewayBind: `127.0.0.1:${gatewayPort}`,
    relayBind: `127.0.0.1:${relayPort}`,
  });
  try {
    await waitHealthy(server.gatewayUrl);
    await waitHealthy(server.relayHttpUrl);
    const res = await fetch(`${server.relayHttpUrl}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
    const res2 = await fetch(`${server.gatewayUrl}/healthz`);
    assert.equal(res2.status, 200);
    assert.equal(server.httpUrl, server.gatewayUrl, "httpUrl is a legacy alias of gatewayUrl");
  } finally {
    await server.stop();
    await server.stop(); // 幂等
  }
});

test("services.json manifest matches contract and GET / is an ASCII summary", async () => {
  const port = await freePort();
  const relayPort = await freePort();
  const server = await startServer({
    gatewayBind: `127.0.0.1:${port}`,
    relayBind: `127.0.0.1:${relayPort}`,
  });
  try {
    await waitHealthy(server.gatewayUrl);

    const res = await rawRequest(port, "/services.json", { Host: `127.0.0.1:${port}` });
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-type"], "application/json");
    assert.equal(res.headers["cache-control"], "no-store");
    const manifest = JSON.parse(res.body);
    assert.equal(manifest.server, "opendweb");
    assert.ok(typeof manifest.version === "string" && manifest.version.length > 0);
    assert.equal(manifest.gateway, `http://127.0.0.1:${port}`);
    // 字段快照：条目字段恰为 name/enabled/url；顺序 rendezvous -> relay
    assert.deepEqual(
      manifest.services.map((s) => Object.keys(s)),
      [["name", "enabled", "url"], ["name", "enabled", "url"]],
    );
    const byName = Object.fromEntries(manifest.services.map((s) => [s.name, s]));
    assert.deepEqual(Object.keys(byName).sort(), ["relay", "rendezvous"]);
    assert.equal(byName.rendezvous.enabled, true);
    assert.equal(byName.rendezvous.url, `http://127.0.0.1:${port}/rendezvous`);
    assert.equal(byName.relay.enabled, true);
    // 各条目实际监听端口：relay 用自己的端口，不复用 Host 端口
    assert.equal(byName.relay.url, `http://127.0.0.1:${relayPort}`);

    // Host 为 unspecified 时回退本机地址：绝不产出 0.0.0.0 形态 URL
    const fb = await rawRequest(port, "/services.json", { Host: `0.0.0.0:${port}` });
    const fbManifest = JSON.parse(fb.body);
    assert.ok(fbManifest.gateway === null || !fbManifest.gateway.includes("0.0.0.0"));
    assert.ok(
      fbManifest.services.every((s) => s.url === null || !s.url.includes("0.0.0.0")),
    );

    const root = await rawRequest(port, "/", { Host: `127.0.0.1:${port}` });
    assert.equal(root.status, 200);
    assert.match(root.headers["content-type"], /^text\/plain/);
    assert.match(root.body, ASCII, "GET / summary must be all-ASCII");
    assert.ok(root.body.includes("opendweb server"));
    assert.ok(root.body.includes(`http://127.0.0.1:${port}/services.json`));
  } finally {
    await server.stop();
  }
});

test("trustProxy=true honors X-Forwarded-Proto", async () => {
  const port = await freePort();
  const relayPort = await freePort();
  const server = await startServer({
    gatewayBind: `127.0.0.1:${port}`,
    relayBind: `127.0.0.1:${relayPort}`,
    trustProxy: true,
  });
  try {
    await waitHealthy(server.gatewayUrl);
    const trusted = await rawRequest(port, "/services.json", {
      Host: `127.0.0.1:${port}`,
      "X-Forwarded-Proto": "https",
    });
    const trustedManifest = JSON.parse(trusted.body);
    assert.equal(trustedManifest.gateway, `https://127.0.0.1:${port}`);
    assert.equal(
      trustedManifest.services.find((s) => s.name === "relay").url,
      `https://127.0.0.1:${relayPort}`,
    );
    // 未采信路径（trustProxy 缺省）由 opendweb e2e 覆盖
  } finally {
    await server.stop();
  }
});

test("DWEB_RELAY_ENABLED=false disables the relay entry", async () => {
  const port = await freePort();
  const server = await startServer({
    gatewayBind: `127.0.0.1:${port}`,
    relayBind: `127.0.0.1:${await freePort()}`,
    relayEnabled: false,
  });
  try {
    await waitHealthy(server.gatewayUrl);
    const res = await rawRequest(port, "/services.json", { Host: `127.0.0.1:${port}` });
    const manifest = JSON.parse(res.body);
    const relay = manifest.services.find((s) => s.name === "relay");
    assert.equal(relay.enabled, false);
    assert.equal(relay.url, null);
    const rendezvous = manifest.services.find((s) => s.name === "rendezvous");
    assert.equal(rendezvous.enabled, true);
    assert.equal(rendezvous.url, `http://127.0.0.1:${port}/rendezvous`);
  } finally {
    await server.stop();
  }
});

test("httpBind is ignored (use gatewayBind)", async () => {
  // httpBind 传入被静默忽略——server 按默认 gatewayBind 127.0.0.1:8787 启动
  const srv = await startServer({ httpBind: "127.0.0.1:19876", relayEnabled: false });
  assert.ok(srv.gatewayUrl.includes("8787"), "default gateway port, not 19876");
  await srv.stop();
});
