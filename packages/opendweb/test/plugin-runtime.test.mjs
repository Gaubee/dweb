// 插件 config 面运行时单测：shebang 解析、本地文件子进程协议（声明/回调）、
// npm 双适配器等权、fireHook 失败语义（preStart 阻断 / postReady 降级）。
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseShebang, runCapture, loadDeclaredPlugins, fireHook, defaultWhich, HOOK_NAMES } from "../src/plugin-runtime.mjs";
import { DEFAULT_GLOBS } from "../src/marketplace.mjs";
import { CliExit } from "../src/util.mjs";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const LOCAL_PLUGIN = path.join(FIXTURES, "local-echo.mjs");

test("parseShebang: plain interpreter / env / env -S compound", () => {
  assert.deepEqual(parseShebang("#!/usr/bin/deno"), { cmd: "/usr/bin/deno", args: [] });
  assert.deepEqual(parseShebang("#!/usr/bin/env bun"), { cmd: "bun", args: [] });
  assert.deepEqual(parseShebang("#!/usr/bin/env -S deno run"), { cmd: "deno", args: ["run"] });
  assert.equal(parseShebang("// not a shebang"), null);
  assert.equal(parseShebang("#!"), null);
});

test("local plugin adapter: declare (no-arg) + hook callback (stdin payload / stdout JSON)", async () => {
  const plugins = await loadDeclaredPlugins({
    plugins: [{ file: LOCAL_PLUGIN }],
    globs: DEFAULT_GLOBS,
    cwd: FIXTURES,
  });
  assert.equal(plugins.length, 1);
  const p = plugins[0];
  assert.equal(p.name, "local-echo");
  assert.equal(p.kind, "local");
  assert.deepEqual(p.hooks, ["server.preStart", "server.postReady", "server.preStop", "setup"]);

  const pre = await p.invoke("server.preStart", { server: { gatewayBind: "127.0.0.1:1" } });
  assert.equal(pre.ok, true);
  assert.deepEqual(pre.result, { server: { publicGatewayUrl: "https://from-local-plugin.example.com" } });

  const post = await p.invoke("server.postReady", { server: { gatewayBind: "127.0.0.1:12345" } });
  assert.equal(post.ok, true);
  assert.match(post.result.bannerLines[0], /local-echo ready \(server: 127\.0\.0\.1:12345\)/);

  const setupFail = await p.invoke("setup", { options: { fail: true } });
  assert.equal(setupFail.ok, false);
  assert.match(setupFail.error, /setup failed as requested/);

  const setupOk = await p.invoke("setup", { options: {} });
  assert.equal(setupOk.ok, true);
});

test("npm plugin adapter (config face): root export {name, hooks}, options via ctx", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "opendweb-npm-"));
  await fsp.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "t", private: true }), "utf8");
  await fsp.cp(path.join(FIXTURES, "opendweb-echo"), path.join(dir, "node_modules", "opendweb-echo"), { recursive: true });

  const plugins = await loadDeclaredPlugins({
    plugins: [{ name: "echo", options: { tokenEnv: "X" } }],
    globs: DEFAULT_GLOBS,
    cwd: dir,
  });
  assert.equal(plugins[0].kind, "npm");
  assert.equal(plugins[0].name, "echo");
  assert.ok(plugins[0].hooks.includes("server.preStart"));
  const r = await plugins[0].invoke("server.preStart", { server: {} });
  assert.equal(r.ok, true);
  assert.equal(r.result.server.trustProxy, true);
  assert.match(r.result.bannerLines[0], /tokenEnv.*X/);
});

test("npm and local plugins coexist with equal rights; duplicate names rejected", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "opendweb-mix-"));
  await fsp.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "t", private: true }), "utf8");
  await fsp.cp(path.join(FIXTURES, "opendweb-echo"), path.join(dir, "node_modules", "opendweb-echo"), { recursive: true });

  const plugins = await loadDeclaredPlugins({
    plugins: [{ name: "echo" }, { file: LOCAL_PLUGIN }],
    globs: DEFAULT_GLOBS,
    cwd: dir,
  });
  assert.deepEqual(plugins.map((p) => p.name).sort(), ["echo", "local-echo"]);

  // 重名（npm echo + 本地伪装 echo）→ 硬错误
  const echoNamed = path.join(dir, "echo-named.mjs");
  await fsp.writeFile(echoNamed, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({name:'echo',hooks:[]})+'\\n');\n", "utf8");
  await assert.rejects(
    () => loadDeclaredPlugins({ plugins: [{ name: "echo" }, { file: echoNamed }], globs: DEFAULT_GLOBS, cwd: dir }),
    /duplicate plugin name in config: echo/,
  );
});

test("fireHook: preStart merges overrides + collects banner lines; failures are reported", async () => {
  const mkPlugin = (name, hooks, behavior) => ({
    name,
    hooks,
    invoke: async (hook, payload) => behavior(hook, payload),
  });
  const plugins = [
    mkPlugin("a", ["server.preStart"], async () => ({ ok: true, result: { server: { trustProxy: true }, bannerLines: ["from-a"] } })),
    mkPlugin("b", ["server.preStart"], async () => ({ ok: false, error: "b exploded" })),
  ];
  let err = "";
  const r = await fireHook({
    plugins,
    hook: "server.preStart",
    payload: {},
    stderr: { write: (s) => (err += s) },
  });
  assert.deepEqual(r.merged, { trustProxy: true });
  assert.deepEqual(r.bannerLines, ["from-a"]);
  assert.deepEqual(r.failures, [{ name: "b", error: "b exploded" }]);
  assert.match(err, /error\[plugin\/b\]: b exploded/);
});

test("unknown hook in local declaration is rejected at load time", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "opendweb-badhook-"));
  const bad = path.join(dir, "bad.mjs");
  await fsp.writeFile(
    bad,
    "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({name:'bad',hooks:['server.nope']})+'\\n');\n",
    "utf8",
  );
  await assert.rejects(
    () => loadDeclaredPlugins({ plugins: [{ file: bad }], globs: DEFAULT_GLOBS, cwd: dir }),
    /unknown hooks: server\.nope/,
  );
});

test("HOOK_NAMES is exactly 3+1 (v1 freeze)", () => {
  assert.deepEqual(HOOK_NAMES, ["server.preStart", "server.postReady", "server.preStop", "setup"]);
});

test("runCapture: child exiting early with large stdin does not crash the CLI (EPIPE guard, R2-M5)", async () => {
  const r = await runCapture(process.execPath, ["-e", "process.exit(0)"], {
    input: "x".repeat(10 * 1024 * 1024),
    timeoutMs: 10000,
  });
  assert.equal(r.code, 0);
});

test("defaultWhich: finds node on PATH; misses unknown commands (R2-M6)", () => {
  const node = defaultWhich("node");
  assert.ok(typeof node === "string" && node.length > 0);
  assert.equal(defaultWhich("definitely-not-a-command-zzz9"), null);
});

test("no-shebang .ts honors the injected which (runtime probing is live, R2-M6)", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "opendweb-ts-"));
  const file = path.join(dir, "plugin.ts");
  await fsp.writeFile(
    file,
    [
      "// 无 shebang 的 .ts：declareLocalPlugin 应按 which 探测解释器（注入 bun -> node 可执行文件）",
      "const args = process.argv.slice(2);",
      "if (args.includes('--opendweb-declare')) {",
      "  process.stdout.write(JSON.stringify({ name: 'ts-probe', hooks: ['server.postReady'] }) + '\\n');",
      "}",
    ].join("\n") + "\n",
    "utf8",
  );
  const plugins = await loadDeclaredPlugins({
    plugins: [{ file: "plugin.ts" }],
    globs: DEFAULT_GLOBS,
    cwd: dir,
    which: (cmd) => (cmd === "bun" ? process.execPath : null),
  });
  assert.equal(plugins[0].name, "ts-probe");
});

test("fireHook: non-plain-object hook results and result.server become plugin failures (R2-Minor)", async () => {
  const mkPlugin = (name, result) => ({
    name,
    hooks: ["server.preStart"],
    invoke: async () => ({ ok: true, result }),
  });
  const captured = [];
  const r = await fireHook({
    plugins: [
      mkPlugin("str-result", "oops"),
      mkPlugin("array-result", [1, 2]),
      mkPlugin("bad-server", { server: "not-an-object" }),
      mkPlugin("good", { server: { trustProxy: true }, bannerLines: ["ok"] }),
    ],
    hook: "server.preStart",
    payload: {},
    stderr: { write: (s) => captured.push(s) },
  });
  assert.equal(r.failures.length, 3);
  assert.match(r.failures.map((f) => f.error).join(" "), /must be an object or null/);
  assert.match(r.failures.map((f) => f.error).join(" "), /result\.server must be a plain object/);
  assert.deepEqual(r.merged, { trustProxy: true }); // good 插件的覆写仍生效
  assert.deepEqual(r.bannerLines, ["ok"]);
});

test("local plugin file resolves relative to configDir, not cwd (R2 blocked-3)", async () => {
  const configDir = await fsp.mkdtemp(path.join(os.tmpdir(), "opendweb-cfgdir-"));
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "opendweb-cwddir-"));
  await fsp.copyFile(LOCAL_PLUGIN, path.join(configDir, "local-echo.mjs"));

  const plugins = await loadDeclaredPlugins({
    plugins: [{ file: "local-echo.mjs" }],
    globs: DEFAULT_GLOBS,
    cwd,
    configDir,
  });
  assert.equal(plugins[0].name, "local-echo");

  // 无 configDir 时回落到 cwd——文件不存在 → 声明失败（行为锚点）
  await assert.rejects(
    () => loadDeclaredPlugins({ plugins: [{ file: "local-echo.mjs" }], globs: DEFAULT_GLOBS, cwd }),
    /failed to declare/,
  );
});

test("local adapter: hook stdout that is not JSON is a protocol failure, not silent success (R2 blocked-5)", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "opendweb-corrupt-"));
  const corrupt = path.join(dir, "corrupt.mjs");
  await fsp.writeFile(
    corrupt,
    [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      "if (args.includes('--opendweb-declare')) {",
      "  process.stdout.write(JSON.stringify({name:'corrupt',hooks:['server.postReady']})+'\\n');",
      "  process.exit(0);",
      "}",
      "if (args.includes('--opendweb-hook')) {",
      "  process.stdout.write('definitely not json\\n');",
      "  process.exit(0);",
      "}",
    ].join("\n") + "\n",
    "utf8",
  );
  const plugins = await loadDeclaredPlugins({ plugins: [{ file: corrupt }], globs: DEFAULT_GLOBS, cwd: dir });
  const r = await plugins[0].invoke("server.postReady", {});
  assert.equal(r.ok, false);
  assert.match(r.error, /not valid JSON/);
  assert.match(r.error, /definitely not json/);
});
