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
    (e) => e instanceof CliExit && /belongs to package @jixo\/opendweb-ext-srclayout/.test(e.message),
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
