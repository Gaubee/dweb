// marketplace 候选配置（plugin-marketplace D1）：候选名 globs，不是注册表。
// 持久化 ~/.opendweb/marketplace.json；默认双 glob（Owner 决策：无 scope 默认开放）。
// 意图单一：globs 的读写、校验与「glob → 子命令候选包名」的展开。
import { readTextIfExists, CliExit } from "./util.mjs";

/** 默认候选集（声明序即解析序：官方 scoped 前、社区无 scope 后） */
export const DEFAULT_GLOBS = ["npm:@jixo/opendweb-ext-*", "npm:opendweb-*"];

/** glob 语法：`npm:` 前缀 + 恰一个 `*`（Owner 决策：不预留 github:/https:） */
export function validateGlob(glob) {
  if (typeof glob !== "string" || glob.length === 0) return "glob must be a non-empty string";
  if (!glob.startsWith("npm:")) return `only npm: source is supported (got ${glob})`;
  const pattern = glob.slice("npm:".length);
  if (!pattern.includes("*")) return `glob must contain * (got ${glob})`;
  if (pattern.split("*").length > 2) return `glob must contain exactly one * (got ${glob})`;
  const head = pattern.split("*")[0];
  if (!/^[a-z0-9@/_-]*$/i.test(head)) return `glob prefix has invalid characters (got ${glob})`;
  return null;
}

/** 解析 add 输入（逗号/空白分隔多项）→ 校验后的 glob 数组；任一非法即硬错误 */
export function parseGlobInput(input) {
  const raw = String(input ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (raw.length === 0) throw new CliExit("no globs provided", 2);
  for (const g of raw) {
    const err = validateGlob(g);
    if (err) throw new CliExit(`invalid marketplace glob: ${g} (${err})`, 2);
  }
  return raw;
}

/**
 * 读取 marketplace 配置。文件缺失 → 默认；JSON 损坏 → 硬错误（不静默重置）。
 * @param {{ fs: Pick<typeof import("node:fs/promises"), "readFile">, path: string }} opts
 * @returns {Promise<{ globs: string[], source: "default" | "file" }>}
 */
export async function loadMarketplace({ fs, path }) {
  const text = await readTextIfExists(fs, path);
  if (text === null) return { globs: [...DEFAULT_GLOBS], source: "default" };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new CliExit(`marketplace config is not valid JSON (${path}): ${e.message}`, 1);
  }
  if (!parsed || !Array.isArray(parsed.globs) || parsed.globs.length === 0) {
    throw new CliExit(`marketplace config must be {"globs": string[]} (${path})`, 1);
  }
  for (const g of parsed.globs) {
    const err = validateGlob(g);
    if (err) throw new CliExit(`invalid marketplace glob in ${path}: ${g} (${err})`, 1);
  }
  return { globs: [...parsed.globs], source: "file" };
}

/** 写入 marketplace 配置（globs 去重保序；目录由调用方保证存在） */
export async function saveMarketplace({ fs, path, globs }) {
  const unique = [...new Set(globs)];
  for (const g of unique) {
    const err = validateGlob(g);
    if (err) throw new CliExit(`invalid marketplace glob: ${g} (${err})`, 2);
  }
  await fs.writeFile(path, `${JSON.stringify({ globs: unique }, null, 2)}\n`, "utf8");
  return unique;
}

/**
 * `opendweb marketplace add`：解析输入 → 校验 → 合并（去重保序，新增项追加在尾）。
 * @returns {Promise<{ added: string[], globs: string[] }>}
 */
export async function marketplaceAdd({ fs, path, input }) {
  const current = await loadMarketplace({ fs, path });
  const incoming = parseGlobInput(input);
  const before = new Set(current.globs);
  const added = incoming.filter((g) => !before.has(g));
  const globs = await saveMarketplace({ fs, path, globs: [...current.globs, ...added] });
  return { added, globs };
}

/** `opendweb marketplace remove`：精确匹配移除；不存在 → 硬错误 */
export async function marketplaceRemove({ fs, path, input }) {
  const current = await loadMarketplace({ fs, path });
  const targets = parseGlobInput(input);
  const known = new Set(current.globs);
  for (const t of targets) {
    if (!known.has(t)) throw new CliExit(`glob not in marketplace: ${t}`, 2);
  }
  const globs = await saveMarketplace({
    fs,
    path,
    globs: current.globs.filter((g) => !targets.includes(g)),
  });
  return { removed: targets, globs };
}

/**
 * 子命令名 → 候选包名序列（声明序、去重）：globs 的 `*` 替换为 name。
 * @param {string[]} globs
 * @param {string} name
 * @returns {string[]}
 */
export function candidatesFor(globs, name) {
  const out = [];
  for (const g of globs) {
    const pkg = g.replace("npm:", "").replace("*", name);
    if (!out.includes(pkg)) out.push(pkg);
  }
  return out;
}
