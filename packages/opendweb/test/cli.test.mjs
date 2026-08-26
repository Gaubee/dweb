// opendweb CLI 冒烟：help 输出 + server 启动能力（直调，等价于 CLI 的 server 路径）。
// server 进程级启动/healthz 由 @jixo/opendweb-server-binary 的测试覆盖（spawn 模式在
// Windows CI 的 stdio 管道下不稳定，CLI 只是对 startServer 的薄包装）。
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "@jixo/opendweb-server-binary";

const NODE = process.execPath;
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/opendweb.mjs");

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

test("opendweb help lists server command", async () => {
  const out = await new Promise((resolve, reject) => {
    execFile(NODE, [CLI, "help"], (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(stdout + stderr);
    });
  });
  assert.ok(out.includes("opendweb server"), "help mentions server command");
  assert.ok(out.includes("opendweb-example"), "help mentions example flow");
});

test("opendweb server serves rendezvous + relay healthz (direct)", async () => {
  const server = await startServer({
    httpBind: "127.0.0.1:18991",
    relayBind: "127.0.0.1:18992",
  });
  try {
    await waitHealthy(server.httpUrl);
    await waitHealthy(server.relayHttpUrl);
    const res = await fetch(`${server.relayHttpUrl}/healthz`);
    const body = await res.json();
    assert.equal(body.status, "ok");
  } finally {
    await server.stop();
    await server.stop(); // 幂等
  }
});
