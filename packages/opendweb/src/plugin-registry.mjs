// 插件安装管理（plugin-marketplace D1/D7）：plugin add|get/remove/list。
// 原始需求（2026-08-29，Owner 第四轮）：opendweb cf 即 get cf ?? add cf；
// 本模块承载显式管理与自愈安装共用的「安装 + 版本读取 + 锁定」逻辑。
// - add/get：取 marketplace 首个候选包名，经用户项目的包管理器安装为
//   devDependency，并把 name@version 锁定于 ~/.opendweb/plugins.json
//   （安装即信任，展示精确版本）
// - remove：卸载包 + 删除锁定记录
// - list：展示锁定记录
import { readFile, writeFile } from "node:fs/promises";
import { existsSync as nodeExistsSync, readFileSync } from "node:fs";
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

/**
 * 写入锁定记录（records 形如 { [name]: { package, version } }）。
 * @param {string} lockPath
 * @param {Record<string, { package: string, version: string }>} records
 */
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

/** 各包管理器的「安装为 devDependency」命令行（typed map，禁 switch） */
const INSTALL_COMMANDS = {
  pnpm: (pkg) => ["pnpm", ["add", "-D", pkg]],
  yarn: (pkg) => ["yarn", ["add", "-D", pkg]],
  bun: (pkg) => ["bun", ["add", "-d", pkg]],
  npm: (pkg) => ["npm", ["install", "--save-dev", pkg]],
};

/** 各包管理器的卸载命令行 */
const UNINSTALL_COMMANDS = {
  pnpm: (pkg) => ["pnpm", ["remove", pkg]],
  yarn: (pkg) => ["yarn", ["remove", pkg]],
  bun: (pkg) => ["bun", ["remove", pkg]],
  npm: (pkg) => ["npm", ["uninstall", pkg]],
};

/** @returns {[string, string[]]} */
export function installCommand(pm, pkg) {
  return (INSTALL_COMMANDS[pm] ?? INSTALL_COMMANDS.npm)(pkg);
}

/** @returns {[string, string[]]} */
export function uninstallCommand(pm, pkg) {
  return (UNINSTALL_COMMANDS[pm] ?? UNINSTALL_COMMANDS.npm)(pkg);
}

/**
 * 从已解析的包入口向上查找包根目录（含 package.json 的最近祖先）。
 * R2 阻塞-2：exports 包的入口常在 src/ 下，dirname(entry) 不一定是包根。
 * @param {string} entry 已解析入口的绝对路径
 * @returns {string} 包根目录（含 package.json）
 */
export function findPackageRoot(entry) {
  let dir = path.dirname(entry);
  for (;;) {
    if (nodeExistsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new CliExit(`cannot locate package.json above ${entry}`, 1);
    }
    dir = parent;
  }
}

/** 安装后读取包真实版本（安装成功的实证，也用于锁定展示；exports 安全） */
export function readInstalledVersion(pkg, cwd) {
  const req = createRequire(path.join(cwd, "package.json"));
  const entry = req.resolve(pkg); // 包根入口（exports["."]）
  const pkgDir = findPackageRoot(entry);
  const pkgJsonPath = path.join(pkgDir, "package.json");
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  return { version: String(pkgJson.version ?? "unknown"), path: pkgJsonPath };
}

/**
 * `opendweb plugin add|get <name>`：解析首个候选 → 包管理器安装 → 读取真实
 * 版本 → 锁定。任一步失败 → 非零退出（不写锁定）。
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
