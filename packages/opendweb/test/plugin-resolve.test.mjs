// 自适应解析与插件 CLI 面契约单测：候选解析语义（未安装→下一候选；已安装但
// 清单坏→硬错误）、参数解析（JSON Schema 子集）、help 零执行、执行包装器。
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveAdaptive, resolvePluginEntry, BUILTIN_COMMANDS, PluginNotResolved } from "../src/plugin-resolve.mjs";
import { parseCommandArgs, dispatchPluginCommand, renderPluginHelp, PluginManifestSchema } from "../src/plugin-contract.mjs";
import { candidatesFor, DEFAULT_GLOBS } from "../src/marketplace.mjs";
import { CliExit } from "../src/util.mjs";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

/** 造一个「已安装」状态的项目目录：node_modules/<pkg> = fixtures 复制 */
async function projectWith(...pkgNames) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "opendweb-proj-"));
  await fsp.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "t", private: true }), "utf8");
  await fsp.mkdir(path.join(dir, "node_modules"), { recursive: true });
  for (const pkg of pkgNames) {
    await fsp.cp(path.join(FIXTURES, pkg), path.join(dir, "node_modules", pkg), { recursive: true });
  }
  return dir;
}

test("builtin commands reserved (adaptive never shadows them)", () => {
  for (const b of ["server", "help", "marketplace", "plugin", "use", "config", "setup"]) {
    assert.ok(BUILTIN_COMMANDS.has(b), b);
  }
});

test("resolvePluginEntry: resolves ./opendweb-plugin from project context (pnpm/npm layouts)", async () => {
  const dir = await projectWith("opendweb-echo");
  const entry = resolvePluginEntry("opendweb-echo", dir);
  assert.ok(entry?.endsWith("plugin.js"), entry ?? "null");
  assert.equal(resolvePluginEntry("opendweb-ext-not-installed", dir), null);
});

test("resolvePluginEntry: same-process miss followed by install falls back to package metadata", async () => {
  const dir = await projectWith();
  const pkg = "@jixo/opendweb-ext-echo";
  // 首次 req.resolve 缺失后，包管理器在同一进程创建 node_modules；这里
  // 覆盖 Node 目录负缓存仍存在时的 package.json 直读回退。
  assert.equal(resolvePluginEntry(pkg, dir), null);
  const installed = path.join(dir, "node_modules", "@jixo", "opendweb-ext-echo");
  await fsp.mkdir(path.dirname(installed), { recursive: true });
  await fsp.cp(path.join(FIXTURES, "@jixo", "opendweb-ext-echo"), installed, { recursive: true });

  const entry = resolvePluginEntry(pkg, dir);
  assert.ok(entry?.endsWith("plugin.js"), entry ?? "null");
  const resolved = await resolveAdaptive({ name: "echo", globs: DEFAULT_GLOBS, cwd: dir });
  assert.equal(resolved.pkg, pkg);
});

test("resolvePluginEntry: CLI face never falls back to the package root export (R5-B1)", async () => {
  const dir = await projectWith();
  // 仅导出 "."（根导出恰好是合规清单）：CLI 面只认 ./opendweb-plugin，
  // 不得让未声明 CLI 面的包进入自适应派发（冻结 spec）
  const pkgDir = path.join(dir, "node_modules", "opendweb-rootface");
  await fsp.mkdir(pkgDir, { recursive: true });
  await fsp.writeFile(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "opendweb-rootface", version: "1.0.0", type: "module", exports: { ".": "./plugin.js" } }),
  );
  await fsp.writeFile(
    path.join(pkgDir, "plugin.js"),
    'export default { name: "rootface", apiVersion: 1, commands: [{ name: "hello", description: "d", args: { type: "object", properties: {}, required: [] } }], run: async () => ({ exit: 0 }) };',
  );
  assert.equal(resolvePluginEntry("opendweb-rootface", dir), null);
  await assert.rejects(
    () => resolveAdaptive({ name: "rootface", globs: DEFAULT_GLOBS, cwd: dir }),
    (e) => e instanceof PluginNotResolved,
  );
});

test("resolvePluginEntry: opendweb-plugin symlink escaping the package is rejected (R5-B2)", async () => {
  const dir = await projectWith();
  const pkgDir = path.join(dir, "node_modules", "opendweb-escape");
  await fsp.mkdir(pkgDir, { recursive: true });
  await fsp.writeFile(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "opendweb-escape", version: "1.0.0", type: "module", exports: { "./opendweb-plugin": "./link.mjs" } }),
  );
  // 包外目标（项目根下）：若被错误接受并导入，清单 name="evil" 会触发
  // manifest 名不匹配硬错误——用它区分「拒绝解析」与「错误接受」
  await fsp.writeFile(
    path.join(dir, "outside.mjs"),
    'export default { name: "evil", apiVersion: 1, commands: [], run: async () => ({ exit: 0 }) };',
  );
  await fsp.symlink(path.join(dir, "outside.mjs"), path.join(pkgDir, "link.mjs"));
  assert.equal(resolvePluginEntry("opendweb-escape", dir), null);
  // 不得 import 包外文件：PluginNotResolved（而非 manifest 硬错误）证明
  // 越界入口从未被加载
  await assert.rejects(
    () => resolveAdaptive({ name: "escape", globs: DEFAULT_GLOBS, cwd: dir }),
    (e) => e instanceof PluginNotResolved,
  );
});

test("resolveAdaptive: declaration order wins; unresolvable candidates are skipped", async () => {
  const dir = await projectWith("opendweb-echo");
  // 默认序：@jixo/opendweb-echo（未安装）→ opendweb-echo（已安装）
  const r = await resolveAdaptive({ name: "echo", globs: DEFAULT_GLOBS, cwd: dir });
  assert.equal(r.pkg, "opendweb-echo");
  assert.equal(r.manifest.name, "echo");
  assert.equal(r.manifest.apiVersion, 1);
});

test("resolveAdaptive: installed-but-invalid manifest is a HARD error (no silent skip)", async () => {
  const dir = await projectWith("opendweb-bad");
  await assert.rejects(
    () => resolveAdaptive({ name: "bad", globs: DEFAULT_GLOBS, cwd: dir }),
    (e) => {
      assert.match(e.message, /invalid opendweb-plugin manifest/);
      assert.match(e.message, /apiVersion/);
      return true;
    },
  );
});

test("resolveAdaptive: nothing resolvable -> error prints plugin add guidance", async () => {
  const dir = await projectWith();
  await assert.rejects(
    () => resolveAdaptive({ name: "frp", globs: DEFAULT_GLOBS, cwd: dir }),
    /opendweb plugin add frp/,
  );
});

test("parseCommandArgs: flags, inline values, booleans, numbers, positionals, required", () => {
  const spec = {
    name: "hello",
    description: "",
    args: {
      type: "object",
      properties: { name: { type: "string" }, loud: { type: "boolean" }, times: { type: "number" } },
      required: ["name"],
    },
  };
  assert.deepEqual(
    parseCommandArgs(spec, ["--name", "ada", "--loud", "--times=3"]),
    { name: "ada", loud: true, times: 3 },
  );
  assert.deepEqual(parseCommandArgs(spec, ["ada"]), { name: "ada" });
  assert.throws(() => parseCommandArgs(spec, []), /missing required option --name/);
  assert.throws(() => parseCommandArgs(spec, ["--name", "a", "--nope"]), /unknown option --nope/);
  assert.throws(() => parseCommandArgs(spec, ["--name", "a", "--times", "x"]), /expects a number/);
  assert.throws(() => parseCommandArgs(spec, ["--name", "a", "extra"]), /unexpected positional/);
});

test("dispatchPluginCommand: wrapper normalizes output (ASCII), errors, exit codes", async () => {
  const dir = await projectWith("opendweb-echo");
  const { manifest } = await resolveAdaptive({ name: "echo", globs: DEFAULT_GLOBS, cwd: dir });

  let out = "";
  const stdout = { write: (s) => (out += s) };
  let err = "";
  const stderr = { write: (s) => (err += s) };

  const code = await dispatchPluginCommand({
    manifest, command: "hello", argv: ["--name", "ada", "--loud", "--times", "2"],
    cwd: dir, stdout, stderr,
  });
  assert.equal(code, 0);
  assert.equal(out, "hello ada!\nhello ada!\n");

  const failCode = await dispatchPluginCommand({
    manifest, command: "fail", argv: [], cwd: dir, stdout, stderr,
  });
  assert.equal(failCode, 1);
  assert.match(err, /error\[plugin\/echo\]: boom from echo plugin/);

  const unknown = await dispatchPluginCommand({
    manifest, command: "nope", argv: [], cwd: dir, stdout, stderr,
  });
  assert.equal(unknown, 2);
});

test("renderPluginHelp: zero-execution help from manifest declarations", async () => {
  const dir = await projectWith("opendweb-echo");
  const { manifest } = await resolveAdaptive({ name: "echo", globs: DEFAULT_GLOBS, cwd: dir });
  let executed = false;
  const wrapped = { ...manifest, run: () => { executed = true; } };
  const text = renderPluginHelp({ name: "echo", manifest: wrapped });
  assert.ok(text.includes("opendweb echo hello --name <string> [--loud --times <number>]"));
  assert.ok(text.includes("greet by name"));
  assert.ok([...text].every((c) => c.charCodeAt(0) < 128), "help must be ASCII");
  assert.equal(executed, false, "help must not execute run");
});

test("PluginManifestSchema.safeParse catches missing commands / bad name shape", () => {
  assert.equal(PluginManifestSchema.safeParse({ name: "x", apiVersion: 1, commands: [], run: () => {} }).success, false);
  assert.equal(PluginManifestSchema.safeParse({ name: "Bad_Name", apiVersion: 1, commands: [{ name: "c" }], run: () => {} }).success, false);
});
