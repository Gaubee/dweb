// 自适应子命令解析（plugin-marketplace D2）：非 builtin 首 token → marketplace
// 候选包 → `import("$PKG/opendweb-plugin")` → safeParse → 派发。
// 解析语义（design D2 冻结）：
// - 候选不可解析（MODULE_NOT_FOUND）= 未安装 → 试下一候选
// - 解析成功后的任何失败（顶层抛错 / safeParse 不合规）= 硬错误，不静默跳过
// - 全部不可解析 → 报错 + 打印精确 plugin add 命令（无隐式安装）
import { createRequire } from "node:module";
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
 * 在 cwd 的项目上下文解析插件的 ./opendweb-plugin 入口绝对路径。
 * 用 createRequire(cwd/package.json) 拿到用户项目的解析语义（npm/pnpm 布局
 * 均适用）；解析不到返回 null。
 * @param {string} pkg
 * @param {string} cwd
 * @returns {string | null}
 */
export function resolvePluginEntry(pkg, cwd) {
  const base = path.join(cwd, "package.json");
  const req = createRequire(base);
  try {
    return req.resolve(`${pkg}/opendweb-plugin`);
  } catch {
    // 子路径 exports 不存在或包未安装（ERR_PACKAGE_PATH_NOT_EXPORTED /
    // MODULE_NOT_FOUND）：前者按「入口不合规」处理走候选序列更宽容——
    // 社区包常见错误形态，硬错误留给「能解析但清单坏」的场景
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
  /** @type {string[]} */
  const tried = [];
  for (const pkg of candidatesFor(globs, name)) {
    const entry = resolveEntry(pkg, cwd);
    if (entry === null) {
      tried.push(pkg);
      continue;
    }
    const mod = await importModule(pathToFileURL(entry).href);
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
    return { pkg, manifest: parsed.data, entryUrl: pathToFileURL(entry).href };
  }
  throw new Error(
    `no plugin found for "${name}" (tried: ${tried.join(", ")}); install one with: opendweb plugin add ${name}`,
  );
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
