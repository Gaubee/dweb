// 插件安装管理（plugin-marketplace D1/D7）：plugin add/remove/list。
// v1 语义（有意从简，tasks 已注明）：
// - add：取 marketplace 首个候选包名，经用户项目的包管理器安装为 devDependency，
//   并把 name@version 锁定于 ~/.opendweb/plugins.json（安装即信任，展示精确版本）
// - remove：卸载包 + 删除锁定记录
// - list：展示锁定记录
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { readTextIfExists, CliExit, asciiEscape } from "./util.mjs";
import { candidatesFor } from "./marketplace.mjs";

/** 锁定记录：{ [pluginName]: { package, version } } */
export async function loadLockfile(lockPath) {
  const text = await readTextIfExists({ readFile }, lockPath);
  if (text === null) return {};
  const parsed = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliExit(`plugin lockfile is malformed (${lockPath})`, 1);
  }
  return parsed;
}

export async function saveLockfile(lockPath, records) {
  await writeFile(lockPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
}

/** 按 lockfile 探测用户项目的包管理器（默认 npm） */
export function detectPackageManager(cwd, existsSync) {
  if (existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(cwd, "bun.lockb")) || existsSync(path.join(cwd, "bun.lock"))) return "bun";
  return "npm";
}

/** 各包管理器的「安装为 devDependency」命令行 */
export function installCommand(pm, pkg) {
  switch (pm) {
    case "pnpm": return ["pnpm", ["add", "-D", pkg]];
    case "yarn": return ["yarn", ["add", "-D", pkg]];
    case "bun": return ["bun", ["add", "-d", pkg]];
    default: return ["npm", ["install", "--save-dev", pkg]];
  }
}

/** 各包管理器的卸载命令行 */
export function uninstallCommand(pm, pkg) {
  switch (pm) {
    case "pnpm": return ["pnpm", ["remove", pkg]];
    case "yarn": return ["yarn", ["remove", pkg]];
    case "bun": return ["bun", ["remove", pkg]];
    default: return ["npm", ["uninstall", pkg]];
  }
}

/** 安装后读取包真实版本（安装成功的实证，也用于锁定展示；exports 安全） */
export function readInstalledVersion(pkg, cwd) {
  const req = createRequire(path.join(cwd, "package.json"));
  const entry = req.resolve(pkg); // 包根入口（exports["."]）
  const pkgDir = path.dirname(entry);
  const pkgJsonPath = path.join(pkgDir, "package.json");
  const pkgJson = JSON.parse(nodeReadFileSync(pkgJsonPath, "utf8"));
  return { version: String(pkgJson.version ?? "unknown"), path: pkgJsonPath };
}

// node:fs 同步读（避免顶层引入；registry 本就是 Node-only 模块）
import { readFileSync as nodeReadFileSync } from "node:fs";

/**
 * `opendweb plugin add <name>`：解析首个候选 → 包管理器安装 → 读取真实版本 →
 * 锁定。任一步失败 → 非零退出（不写锁定）。
 * @param {{ name: string, globs: string[], cwd: string, lockPath: string, existsSync: (p: string) => boolean, run: (cmd: string, args: string[], opts: object) => Promise<{ code: number, stderr: string }> }} input
 * @returns {Promise<{ pkg: string, version: string }>}
 */
export async function pluginAdd({ name, globs, cwd, lockPath, existsSync, run }) {
  const candidate = candidatesFor(globs, name)[0];
  if (!candidate) throw new CliExit(`no marketplace glob resolves "${name}"`, 2);
  const pm = detectPackageManager(cwd, existsSync);
  const [cmd, args] = installCommand(pm, candidate);
  const res = await run(cmd, args, { cwd });
  if (res.code !== 0) {
    throw new CliExit(`plugin install failed (${cmd} ${args.join(" ")}):\n${asciiEscape(res.stderr)}`, 1);
  }
  let version;
  try {
    version = readInstalledVersion(candidate, cwd).version;
  } catch {
    throw new CliExit(`plugin installed but its package.json is unreadable (${candidate})`, 1);
  }
  const records = await loadLockfile(lockPath);
  records[name] = { package: candidate, version };
  await saveLockfile(lockPath, records);
  return { pkg: candidate, version };
}

/**
 * `opendweb plugin remove <name>`：按锁定记录卸载 + 删记录；未锁定 → 硬错误。
 * @param {{ name: string, cwd: string, lockPath: string, existsSync: (p: string) => boolean, run: (cmd: string, args: string[], opts: object) => Promise<{ code: number, stderr: string }> }} input
 */
export async function pluginRemove({ name, cwd, lockPath, existsSync, run }) {
  const records = await loadLockfile(lockPath);
  const rec = records[name];
  if (!rec) throw new CliExit(`plugin not installed: ${name}`, 2);
  const pm = detectPackageManager(cwd, existsSync);
  const [cmd, args] = uninstallCommand(pm, rec.package);
  const res = await run(cmd, args, { cwd });
  if (res.code !== 0) {
    throw new CliExit(`plugin uninstall failed (${cmd} ${args.join(" ")}):\n${asciiEscape(res.stderr)}`, 1);
  }
  delete records[name];
  await saveLockfile(lockPath, records);
  return { pkg: rec.package };
}

/** `opendweb plugin list` */
export async function pluginList(lockPath) {
  const records = await loadLockfile(lockPath);
  return Object.entries(records).map(([name, rec]) => ({ name, ...rec }));
}
