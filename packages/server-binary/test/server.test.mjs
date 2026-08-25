// @dweb/server-binary 测试（node --test）
import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../index.js";

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

test("server binary serves rendezvous + relay healthz", async () => {
  const server = await startServer({
    httpBind: "127.0.0.1:18987",
    relayBind: "127.0.0.1:18988",
  });
  try {
    await waitHealthy(server.httpUrl);
    await waitHealthy(server.relayHttpUrl);
    const res = await fetch(`${server.relayHttpUrl}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
    const res2 = await fetch(`${server.httpUrl}/healthz`);
    assert.equal(res2.status, 200);
  } finally {
    await server.stop();
    await server.stop(); // 幂等
  }
});
