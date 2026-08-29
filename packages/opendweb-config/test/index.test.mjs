// @jixo/opendweb-config 单测：definePlugin 的三种调用形态。
// 1) 子进程 --opendweb-declare → stdout 声明 JSON
// 2) 子进程 --opendweb-hook <name> + stdin payload → stdout 结果 JSON / 失败非零
// 3) 直接 import（无协议参数）→ 返回插件对象，零副作用
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixture-plugin.mjs");
const NODE = process.execPath;

function run(args, stdin = "") {
  return new Promise((resolve) => {
    const child = execFile(NODE, [FIXTURE, ...args], (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
    });
    child.stdin?.end(stdin);
  });
}

test("declare mode: --opendweb-declare prints {name, hooks} and exits 0", async () => {
  const r = await run(["--opendweb-declare"]);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), {
    name: "helper-echo",
    hooks: ["server.postReady", "setup"],
  });
});

test("hook mode: stdin payload in, result JSON out", async () => {
  const ok = await run(["--opendweb-hook", "setup"], JSON.stringify({ options: {} }));
  assert.equal(ok.code, 0);
  assert.deepEqual(JSON.parse(ok.stdout), { via: "definePlugin" });

  const ready = await run(["--opendweb-hook", "server.postReady"], JSON.stringify({ options: { a: 1 } }));
  assert.equal(ready.code, 0);
  assert.match(JSON.parse(ready.stdout).bannerLines[0], /options: \{"a":1\}/);
});

test("hook failure: stderr message + non-zero exit", async () => {
  const r = await run(["--opendweb-hook", "setup"], JSON.stringify({ options: { fail: true } }));
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /helper setup boom/);
});

test("plain import: returns the plugin object, no protocol side effects", async () => {
  const beforeArgCount = process.argv.length;
  const mod = await import("./fixture-plugin.mjs");
  assert.equal(mod.default.name, "helper-echo");
  assert.equal(typeof mod.default.hooks.setup, "function");
  assert.equal(process.argv.length, beforeArgCount, "no exit/arg mutation");
});
