// 插件安装管理单测：findPackageRoot（R2 阻塞-2：src/ 布局 exports 包）、
// readInstalledVersion 经包根向上查找、包管理器命令表（typed map）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findPackageRoot, readInstalledVersion, installCommand, uninstallCommand, detectPackageManager } from "../src/plugin-registry.mjs";
import { CliExit } from "../src/util.mjs";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

test("findPackageRoot: entry at package root resolves directly; src/-layout entry walks up", () => {
  // 根布局：dirname(entry) 即包根
  assert.equal(
    findPackageRoot(path.join(FIXTURES, "opendweb-echo", "plugin.js")),
    path.join(FIXTURES, "opendweb-echo"),
  );
  // src/ 布局（R2 阻塞-2）：入口在子目录，必须向上查到包根
  assert.equal(
    findPackageRoot(path.join(FIXTURES, "@jixo", "opendweb-ext-srclayout", "src", "plugin.js")),
    path.join(FIXTURES, "@jixo", "opendweb-ext-srclayout"),
  );
});

test("findPackageRoot: no package.json above entry is a hard error", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "opendweb-nopkg-"));
  // 临时目录祖先链（直到 /）都不含 package.json 的概率极高；夹具根的存在
  // 使该断言不依赖仓库外部状态。同步函数 → throws（rejects 对同步抛出
  // 不做校验直接外抛）
  assert.throws(
    () => findPackageRoot(path.join(dir, "entry.js")),
    (e) => e instanceof CliExit && /cannot locate package\.json/.test(e.message),
  );
});

test("readInstalledVersion: src/-layout exports package reports the real version", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "opendweb-ver-"));
  await fsp.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "t", private: true }), "utf8");
  await fsp.cp(path.join(FIXTURES, "@jixo", "opendweb-ext-srclayout"), path.join(dir, "node_modules", "@jixo", "opendweb-ext-srclayout"), { recursive: true });
  // 夹具为 exports-only（无 "." 根导出）：必须回退 ./opendweb-plugin 入口（R2-M1）
  const { version, path: pkgJsonPath } = readInstalledVersion("@jixo/opendweb-ext-srclayout", dir);
  assert.equal(version, "3.1.4");
  // mkdtemp 可能落在 /var 或 /private/var（macOS 符号链接）——用 realpath 对齐
  assert.equal(
    pkgJsonPath,
    path.join(fs.realpathSync(dir), "node_modules", "@jixo", "opendweb-ext-srclayout", "package.json"),
  );
});

test("readInstalledVersion: entry resolving to a differently-named package is rejected (R2-M1)", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "opendweb-alias-"));
  await fsp.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "t", private: true }), "utf8");
  // 把声明为 opendweb-ext-srclayout 的包放进 opendweb-ext-cf 的位置——
  // 解析锚定与包名不一致必须拒绝（防锁定记录张冠李戴）
  await fsp.cp(path.join(FIXTURES, "@jixo", "opendweb-ext-srclayout"), path.join(dir, "node_modules", "@jixo", "opendweb-ext-cf"), { recursive: true });
  assert.throws(
    () => readInstalledVersion("@jixo/opendweb-ext-cf", dir),
    (e) => e instanceof CliExit && /declares name "@jixo\/opendweb-ext-srclayout"/.test(e.message),
  );
});

test("readInstalledVersion: resolver-unresolvable layouts fall back to fs read (R3 race hardening)", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "opendweb-flat-"));
  await fsp.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "t", private: true }), "utf8");
  // 无 main 无 exports 无入口文件：两条 req.resolve 都失败——fs 直读兜底
  await fsp.mkdir(path.join(dir, "node_modules", "opendweb-noflat"), { recursive: true });
  await fsp.writeFile(
    path.join(dir, "node_modules", "opendweb-noflat", "package.json"),
    JSON.stringify({ name: "opendweb-noflat", version: "7.7.7" }),
    "utf8",
  );
  const { version } = readInstalledVersion("opendweb-noflat", dir);
  assert.equal(version, "7.7.7");
});

test("readInstalledVersion: missing package name is rejected (R3-Minor)", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "opendweb-noname-"));
  await fsp.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "t", private: true }), "utf8");
  await fsp.mkdir(path.join(dir, "node_modules", "opendweb-noname"), { recursive: true });
  await fsp.writeFile(
    path.join(dir, "node_modules", "opendweb-noname", "package.json"),
    JSON.stringify({ version: "1.0.0" }), // 无 name 字段
    "utf8",
  );
  assert.throws(
    () => readInstalledVersion("opendweb-noname", dir),
    (e) => e instanceof CliExit && /declares name undefined/.test(e.message),
  );
});

test("install/uninstall commands: typed map covers pnpm/yarn/bun/npm; unknown falls back to npm", () => {
  assert.deepEqual(installCommand("pnpm", "p"), ["pnpm", ["add", "-D", "p"]]);
  assert.deepEqual(installCommand("yarn", "p"), ["yarn", ["add", "-D", "p"]]);
  assert.deepEqual(installCommand("bun", "p"), ["bun", ["add", "-d", "p"]]);
  assert.deepEqual(installCommand("npm", "p"), ["npm", ["install", "--save-dev", "p"]]);
  assert.deepEqual(installCommand("unknown-pm", "p"), ["npm", ["install", "--save-dev", "p"]]);
  assert.deepEqual(uninstallCommand("pnpm", "p"), ["pnpm", ["remove", "p"]]);
  assert.deepEqual(uninstallCommand("unknown-pm", "p"), ["npm", ["uninstall", "p"]]);
});

test("detectPackageManager: lockfile probing order", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "opendweb-pm-"));
  assert.equal(detectPackageManager(dir, fs.existsSync), "npm");
  await fsp.writeFile(path.join(dir, "yarn.lock"), "", "utf8");
  assert.equal(detectPackageManager(dir, fs.existsSync), "yarn");
  await fsp.writeFile(path.join(dir, "pnpm-lock.yaml"), "", "utf8");
  assert.equal(detectPackageManager(dir, fs.existsSync), "pnpm");
});

// v0.3.2 线上回归：全新环境（~/.opendweb 不存在）首次自愈安装时
// saveLockfile 直写不存在的父目录 → ENOENT。写前 mkdir 后 load/save 往返
// 在「目录不存在」起点上必须成功。
test("saveLockfile: creates a missing parent directory on first write (v0.3.2 regression)", async () => {
  const { saveLockfile, loadLockfile } = await import("../src/plugin-registry.mjs");
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "opendweb-lock-"));
  const lockPath = path.join(base, "fresh-home", "plugins.json");
  await saveLockfile(lockPath, { cf: { package: "@jixo/opendweb-ext-cf", version: "0.1.0" } });
  const loaded = await loadLockfile(lockPath);
  assert.deepEqual(loaded, { cf: { package: "@jixo/opendweb-ext-cf", version: "0.1.0" } });
});

// ---- plugin add/update/list 体系（2026-08-30 Owner 规格：alias 寻址、--name
// 显式包名、--force 重装、skipped 幂等、registry latest 对照升级、path 解析）----

/** 临时项目：顶层 package.json + fixture 包拷进 node_modules（可被 resolve） */
async function scratchProject() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "opendweb-plug-"));
  await fsp.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "t", private: true }), "utf8");
  await fsp.cp(
    path.join(FIXTURES, "@jixo", "opendweb-ext-srclayout"),
    path.join(dir, "node_modules", "@jixo", "opendweb-ext-srclayout"),
    { recursive: true },
  );
  return dir;
}
const PKG = "@jixo/opendweb-ext-srclayout";

test("pluginAdd: already-locked alias skips (idempotent); --force reinstalls", async () => {
  const { pluginAdd, loadLockfile } = await import("../src/plugin-registry.mjs");
  const dir = await scratchProject();
  const lockPath = path.join(dir, "plugins.json");
  const runs = [];
  const run = async (cmd, args) => { runs.push([cmd, ...args]); return { code: 0, stderr: "" }; };
  const input = (over = {}) => ({
    alias: "srclayout", globs: ["npm:@jixo/opendweb-ext-*"], cwd: dir, lockPath,
    existsSync: fs.existsSync, run, ...over,
  });
  // 首次：glob 寻址装首个候选，lock 以 alias 为键
  const a = await pluginAdd(input());
  assert.equal(a.pkg, PKG);
  assert.equal(a.version, "3.1.4");
  assert.equal(runs.length, 1);
  let lock = await loadLockfile(lockPath);
  assert.deepEqual(lock.srclayout, { package: PKG, version: "3.1.4" });
  // 重复 add 同 alias：skipped，不再安装
  const b = await pluginAdd(input());
  assert.equal(b.skipped, true);
  assert.equal(runs.length, 1);
  // --force：重装（安装命令再次出现）
  await pluginAdd(input({ force: true }));
  assert.equal(runs.length, 2);
  lock = await loadLockfile(lockPath);
  assert.deepEqual(lock.srclayout, { package: PKG, version: "3.1.4" });
});

test("pluginAdd: --name installs the explicit package and the alias keys the lock", async () => {
  const { pluginAdd, loadLockfile } = await import("../src/plugin-registry.mjs");
  const dir = await scratchProject();
  const lockPath = path.join(dir, "plugins.json");
  const runs = [];
  const r = await pluginAdd({
    alias: PKG, pkgName: PKG, // --name 全名安装（alias 未自定义 -> 全名）
    globs: [], cwd: dir, lockPath,
    existsSync: fs.existsSync,
    run: async (cmd, args) => { runs.push([cmd, ...args]); return { code: 0, stderr: "" }; },
  });
  assert.equal(runs[0].includes(PKG), true, "explicit package name is installed verbatim");
  assert.equal(r.version, "3.1.4");
  const lock = await loadLockfile(lockPath);
  assert.deepEqual(lock[PKG], { package: PKG, version: "3.1.4" });
});

test("pluginUpdate: registry latest refreshes the lock; same version is upToDate", async () => {
  const { pluginUpdate, loadLockfile } = await import("../src/plugin-registry.mjs");
  const dir = await scratchProject();
  const lockPath = path.join(dir, "plugins.json");
  await saveLockfileForTest(lockPath, { cf: { package: PKG, version: "3.1.4" } });
  const runs = [];
  const run = async (cmd, args) => { runs.push([cmd, ...args]); return { code: 0, stderr: "" }; };
  // 已是最新：不安装
  const same = await pluginUpdate({
    alias: "cf", lockPath, cwd: dir, existsSync: fs.existsSync, run,
    fetchImpl: async () => new Response(JSON.stringify({ version: "3.1.4" }), { status: 200 }),
  });
  assert.equal(same.upToDate, true);
  assert.equal(runs.length, 0);
  // 有新版：安装 pkg@latest 并以读回的实际版本刷新 lock
  const up = await pluginUpdate({
    alias: "cf", lockPath, cwd: dir, existsSync: fs.existsSync, run,
    fetchImpl: async () => new Response(JSON.stringify({ version: "9.9.9" }), { status: 200 }),
  });
  assert.equal(up.upToDate, false);
  assert.equal(up.latest, "9.9.9");
  assert.ok(runs[0].join(" ").includes(`${PKG}@9.9.9`), `install pin includes @9.9.9: ${runs[0]}`);
  // fixture 实际版本是 3.1.4——读回值以磁盘为准（lock 记录真实而非请求）
  assert.equal(up.version, "3.1.4");
  const lock = await loadLockfile(lockPath);
  assert.deepEqual(lock.cf, { package: PKG, version: "3.1.4" });
});

test("pluginUpdate: unknown alias is a hard error; latest lookup failure surfaces", async () => {
  const { pluginUpdate } = await import("../src/plugin-registry.mjs");
  const dir = await scratchProject();
  const lockPath = path.join(dir, "plugins.json");
  await assert.rejects(
    pluginUpdate({ alias: "nope", lockPath, cwd: dir, existsSync: fs.existsSync, run: async () => ({ code: 0, stderr: "" }) }),
    (e) => e instanceof CliExit && /plugin not installed: nope/.test(e.message),
  );
  await saveLockfileForTest(lockPath, { cf: { package: PKG, version: "3.1.4" } });
  await assert.rejects(
    pluginUpdate({
      alias: "cf", lockPath, cwd: dir, existsSync: fs.existsSync, run: async () => ({ code: 0, stderr: "" }),
      fetchImpl: async () => new Response("nope", { status: 500 }),
    }),
    (e) => e instanceof CliExit && /registry lookup failed.*500/.test(e.message),
  );
});

test("pluginList: alias-keyed rows; path resolves with cwd and stays null without it", async () => {
  const { pluginList } = await import("../src/plugin-registry.mjs");
  const dir = await scratchProject();
  const lockPath = path.join(dir, "plugins.json");
  await saveLockfileForTest(lockPath, { cf: { package: PKG, version: "3.1.4" } });
  const bare = await pluginList(lockPath);
  assert.equal(bare[0].alias, "cf");
  assert.equal(bare[0].path, null);
  const withCwd = await pluginList(lockPath, { cwd: dir });
  assert.ok(withCwd[0].path?.includes("opendweb-ext-srclayout"), `resolved path: ${withCwd[0].path}`);
});

test("latestVersion: reads dist-tags metadata; rejects malformed payloads", async () => {
  const { latestVersion } = await import("../src/plugin-registry.mjs");
  const urls = [];
  const v = await latestVersion(PKG, async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ version: "1.2.3" }), { status: 200 });
  });
  assert.equal(v, "1.2.3");
  assert.ok(urls[0].endsWith(`/${PKG}/latest`), `registry URL shape: ${urls[0]}`);
  await assert.rejects(
    latestVersion(PKG, async () => new Response(JSON.stringify({}), { status: 200 })),
    /has no version/,
  );
});

/** 测试内直接落一个初始 lock（绕过 pluginAdd 的安装路径） */
async function saveLockfileForTest(lockPath, records) {
  const { saveLockfile } = await import("../src/plugin-registry.mjs");
  await saveLockfile(lockPath, records);
}
