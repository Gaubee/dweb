// 自适应子命令解析（plugin-marketplace D2）：非 builtin 首 token → marketplace
// 候选包 → `import("$PKG/opendweb-plugin")` → safeParse → 派发。
// 解析语义（design D2 冻结）：
// - 候选不可解析（MODULE_NOT_FOUND）= 未安装 → 试下一候选
// - 解析成功后的任何失败（顶层抛错 / safeParse 不合规）= 硬错误，不静默跳过
// - 全部不可解析 → 报错 + 打印精确 plugin add 命令（无隐式安装）
import { createRequire } from "node:module";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { PluginManifestSchema } from "./plugin-contract.mjs";
import { candidatesFor } from "./marketplace.mjs";
import { asciiEscape } from "./util.mjs";

/** builtin 关键字恒优先（含保留字 config/setup，防止插件占用造成歧义） */
export const BUILTIN_COMMANDS = new Set([
  "server",
  "help",
  "marketplace",
  "plugin",
  "use",
  "config",
  "setup",
]);

/**
 * 全部候选不可解析（= 未安装）。携带候选序列供调用方自愈安装
 * （Owner 决策：`opendweb cf` 自动做 get cf ?? add cf——取首个候选，
 * 即声明序里官方 scoped 优先的安全梯度）。
 */
export class PluginNotResolved extends Error {
  /**
   * @param {string} name
   * @param {string[]} candidates 已展开的候选包名（声明序）
   */
  constructor(name, candidates) {
    super(
      `no plugin found for "${name}" (tried: ${candidates.join(", ")}); install one with: opendweb plugin add ${name}`,
    );
    this.name = "PluginNotResolved";
    this.candidates = candidates;
  }
}

/**
 * 在 cwd 的项目上下文解析插件的 ./opendweb-plugin 入口绝对路径（CLI 面：
 * 冻结 spec 只认该子路径导出——包根 "." 导出属于 config 面，不得混入，
 * 否则未声明 CLI 面的包会进入自适应派发，R5-B1）。
 * 用 createRequire(cwd/package.json) 拿到用户项目的解析语义（npm/pnpm 布局
 * 均适用）；解析不到或越界返回 null。
 * @param {string} pkg
 * @param {string} cwd
 * @returns {string | null}
 */
export function resolvePluginEntry(pkg, cwd) {
  return resolvePackageEntry(pkg, cwd, ["./opendweb-plugin"]);
}

/**
 * Resolve the config-face root export. It shares the post-install fs fallback
 * with the CLI face, but never treats the CLI manifest subpath as a root export.
 * @param {string} pkg
 * @param {string} cwd
 * @returns {string | null}
 */
export function resolvePluginRootEntry(pkg, cwd) {
  return resolvePackageEntry(pkg, cwd, ["."]);
}

/**
 * Prefer Node resolution, then bypass its same-process negative directory cache
 * only after every valid requested entry has failed.
 * R6-B2：containment 以「期望包根」为显式值（expectedPackageRoot），两条
 * 路径复用同一不变量 isWithinPackage(expectedRoot, realpath(entry))——不再
 * 由入口祖先的同名 metadata 推断（同名包外 symlink 可骗过推断）。
 * @param {string} pkg
 * @param {string} cwd
 * @param {string[]} exportPaths
 * @returns {string | null}
 */
function resolvePackageEntry(pkg, cwd, exportPaths) {
  const expectedRoot = expectedPackageRoot(pkg, cwd);
  // 期望包根不存在或身份不符（name !== pkg）时 req.resolve 沿同一 node_modules
  // 链也必然失败——直接判未安装（候选序列语义不变）
  if (expectedRoot === null) return null;
  const base = path.join(cwd, "package.json");
  const req = createRequire(base);
  for (const exportPath of exportPaths) {
    const specifier = exportPath === "." ? pkg : pkg + exportPath.slice(1);
    try {
      const resolved = req.resolve(specifier);
      let entryReal;
      try {
        entryReal = realpathSync(resolved);
      } catch {
        return null;
      }
      // 入口真实路径必须落在期望包根内；逃逸（symlink 指向包外）= 拒绝，
      // 且不再尝试该候选的其它入口（包本身不可信）
      return isWithinPackage(expectedRoot, entryReal) ? entryReal : null;
    } catch {
      // Try every valid entry for this candidate before falling back to fs.
    }
  }
  return resolvePackageEntryFromFs(expectedRoot, exportPaths);
}

/**
 * 期望包根（R6-B2）：沿 cwd 的 node_modules 向上找到 <pkg> 目录，realpath
 * 后要求其 package.json 声明 name === pkg（目录名 + 元数据双重身份）。
 * 身份不符的目录不作为期望根（继续向上找外层副本；都找不到则 null）。
 * @param {string} pkg
 * @param {string} cwd
 * @returns {string | null}
 */
function expectedPackageRoot(pkg, cwd) {
  const packageParts = pkg.split("/");
  if (packageParts.some((part) => part === "" || part === "." || part === "..")) return null;
  let searchDir = path.resolve(cwd);
  for (;;) {
    const linked = path.join(searchDir, "node_modules", ...packageParts);
    try {
      const root = realpathSync(linked);
      const meta = readPackageMeta(path.join(root, "package.json"));
      if (meta !== null && meta.name === pkg) return root;
    } catch {
      /* not installed at this level; walk up */
    }
    const parent = path.dirname(searchDir);
    if (parent === searchDir) return null;
    searchDir = parent;
  }
}

/** @param {string} p @returns {Record<string, unknown> | null} */
function readPackageMeta(p) {
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Post-install fs fallback against Node's same-process negative directory
 * cache. The expected root is already identity-verified (name === pkg), so the
 * only remaining job is entry selection + containment.
 * @param {string} expectedRoot
 * @param {string[]} exportPaths
 * @returns {string | null}
 */
function resolvePackageEntryFromFs(expectedRoot, exportPaths) {
  const packageJson = readPackageMeta(path.join(expectedRoot, "package.json"));
  if (packageJson === null) return null;
  const hasExports = Object.prototype.hasOwnProperty.call(packageJson, "exports");
  for (const exportPath of exportPaths) {
    const entry = resolvePackageFile(expectedRoot, packageExportTarget(packageJson.exports, exportPath), false);
    if (entry !== null) return entry;
  }
  // Exports is authoritative. main is only a legacy fallback when absent.
  if (!hasExports) {
    const main = typeof packageJson.main === "string" ? packageJson.main : "./index.js";
    const entry = resolvePackageFile(expectedRoot, main, true);
    if (entry !== null) return entry;
  }
  return null;
}

/** @param {unknown} exportsField @param {string} exportPath @returns {string | null} */
function packageExportTarget(exportsField, exportPath) {
  if (typeof exportsField === "string" || Array.isArray(exportsField)) {
    return exportPath === "." ? selectExportTarget(exportsField) : null;
  }
  if (!isRecord(exportsField)) return null;
  if (Object.keys(exportsField).some((key) => key.startsWith("."))) {
    return selectExportTarget(exportsField[exportPath]);
  }
  return exportPath === "." ? selectExportTarget(exportsField) : null;
}

/**
 * 与 createRequire 使用的条件保持一致。解析出的 CommonJS 文件仍可由
 * resolveAdaptive 使用的 file URL 导入。
 * @param {unknown} target
 * @returns {string | null}
 */
function selectExportTarget(target) {
  if (typeof target === "string") return target;
  if (Array.isArray(target)) {
    for (const branch of target) {
      const selected = selectExportTarget(branch);
      if (selected !== null) return selected;
    }
    return null;
  }
  if (!isRecord(target)) return null;
  for (const [condition, branch] of Object.entries(target)) {
    if (condition === "node" || condition === "require" || condition === "default") {
      const selected = selectExportTarget(branch);
      if (selected !== null) return selected;
    }
  }
  return null;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Export targets must stay inside the package. Legacy main also gets common
 * extension and index probing used by packages without an exports map.
 * R5-B2：词法候选先取真实路径（existingFile 内部 realpath），再对真实路径
 * 判包含——先词法判包含会被指向包外的符号链接绕过。
 * @param {string} packageDir
 * @param {string | null} target
 * @param {boolean} legacyMain
 * @returns {string | null}
 */
function resolvePackageFile(packageDir, target, legacyMain) {
  if (typeof target !== "string" || target.length === 0) return null;
  if (!legacyMain && !target.startsWith("./")) return null;
  const candidate = path.resolve(packageDir, target);
  const real = legacyMain ? probeLegacyEntry(candidate) : existingFile(candidate);
  if (real === null) return null;
  return isWithinPackage(packageDir, real) ? real : null;
}

/** legacy main 的扩展名与 index 探测（结果一律取真实路径） */
function probeLegacyEntry(candidate) {
  const exact = existingFile(candidate);
  if (exact !== null) return exact;
  for (const suffix of [".js", ".mjs", ".cjs"]) {
    const withSuffix = existingFile(candidate + suffix);
    if (withSuffix !== null) return withSuffix;
  }
  for (const name of ["index.js", "index.mjs", "index.cjs"]) {
    const index = existingFile(path.join(candidate, name));
    if (index !== null) return index;
  }
  return null;
}

/** @param {string} packageDir @param {string} candidate @returns {boolean} */
function isWithinPackage(packageDir, candidate) {
  const relative = path.relative(packageDir, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

/** @param {string} candidate @returns {string | null} */
function existingFile(candidate) {
  try {
    return statSync(candidate).isFile() ? realpathSync(candidate) : null;
  } catch {
    return null;
  }
}

/**
 * 自适应解析：返回首个可加载且契约合规的插件。
 * @param {{ name: string, globs: string[], cwd: string, importModule?: (url: string) => Promise<unknown>, resolveEntry?: typeof resolvePluginEntry }} input
 * @returns {Promise<{ pkg: string, manifest: import("zod").infer<typeof PluginManifestSchema>, entryUrl: string }>}
 * @throws {Error} 全部不可解析（message 含安装指引）或加载后硬失败
 */
export async function resolveAdaptive({
  name,
  globs,
  cwd,
  importModule = (url) => import(url),
  resolveEntry = resolvePluginEntry,
}) {
  for (const pkg of candidatesFor(globs, name)) {
    const entry = resolveEntry(pkg, cwd);
    if (entry === null) {
      continue;
    }
    const imported = await importModule(pathToFileURL(entry).href);
    const mod = /** @type {Record<string, unknown>} */ (imported);
    const parsed = PluginManifestSchema.safeParse(mod?.default ?? mod);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      // 硬错误：已安装但清单不合规——静默跳到下一候选会掩盖真实包的损坏
      throw new Error(
        `plugin package ${pkg} has an invalid opendweb-plugin manifest (${issues})`,
      );
    }
    // R2 其他项：清单 name 必须与子命令名一致——否则装错包/名字劫持会静默成功
    if (parsed.data.name !== name) {
      throw new Error(
        `plugin package ${pkg} declares name "${parsed.data.name}" but was invoked as "${name}"`,
      );
    }
    return { pkg, manifest: parsed.data, entryUrl: pathToFileURL(entry).href };
  }
  throw new PluginNotResolved(name, candidatesFor(globs, name));
}

/**
 * `opendweb <name> --help`：仅依据清单渲染，不调用 run（spec：零执行生成）。
 * @param {{ manifest: import("zod").infer<typeof PluginManifestSchema>, argv: string[] }} input
 * @returns {boolean} 是否命中 help 请求
 */
export function wantsPluginHelp({ argv }) {
  return argv.includes("--help") || argv.includes("-h");
}

/** ASCII 转义再导出（渲染层用） */
export { asciiEscape };
