// opendweb CLI 冒烟测试：server 启动 + 双 healthz + 幂等停止
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const NODE = process.execPath;
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/opendweb.mjs");

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

test("opendweb server serves rendezvous + relay healthz", async () => {
  const child = spawn(NODE, [
    CLI, "server",
    "--http", "127.0.0.1:18991",
    "--relay", "127.0.0.1:18992",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  try {
    await waitHealthy("http://127.0.0.1:18991");
    await waitHealthy("http://127.0.0.1:18992");
    const res = await fetch("http://127.0.0.1:18992/healthz");
    const body = await res.json();
    assert.equal(body.status, "ok");
  } finally {
    child.kill("SIGINT");
    await new Promise((r) => child.once("exit", r));
    setTimeout(() => child.kill("SIGKILL"), 2000).unref();
  }
});
