// 插件 CLI 面契约（plugin-marketplace D3）：`./opendweb-plugin` 子路径导出的
// 命令清单。zod safeParse 是兼容门不是安全门——import 即执行顶层代码，
// 信任决策在安装时（design D7）。本模块还承载统一参数解析（JSON Schema
// 子集：object 的 string/number/boolean 属性 + required）与执行包装器。
import { z } from "zod";
import { asciiEscape } from "./util.mjs";

/** 命令声明：args 为 JSON Schema 子集（type object + properties） */
export const CommandSpecSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  description: z.string().default(""),
  args: z
    .object({
      type: z.literal("object"),
      properties: z.record(z.string(), z.object({ type: z.enum(["string", "number", "boolean"]) })),
      required: z.array(z.string()).default([]),
    })
    .default({ type: "object", properties: {}, required: [] }),
});

/** 插件 CLI 面清单（apiVersion 破坏性变更走 2） */
export const PluginManifestSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  apiVersion: z.literal(1),
  commands: z.array(CommandSpecSchema).min(1),
  run: z.function(),
});

/**
 * 按命令声明解析 argv（`--key value` / `--key=value` / 布尔 flag / 裸位置参数
 * 按声明顺序填入同名 string 属性）。未知 flag / 缺 required / 类型不符 → 抛错。
 * @param {import("zod").infer<typeof CommandSpecSchema>} spec
 * @param {string[]} argv
 * @returns {Record<string, string | number | boolean>}
 */
export function parseCommandArgs(spec, argv) {
  const props = spec.args.properties ?? {};
  const required = new Set(spec.args.required ?? []);
  /** @type {Record<string, string | number | boolean>} */
  const out = {};
  const positionalNames = Object.entries(props)
    .filter(([name, def]) => def.type === "string" && !Object.keys(out).includes(name))
    .map(([name]) => name);
  const consumedPositional = new Set();
  // --key 必须在 props 中声明（含 boolean 才允许无值形态）
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") { i++; for (; i < argv.length; i++) pushPositional(argv[i]); continue; }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = (eq === -1 ? token : token.slice(0, eq)).slice(2);
      const def = props[name];
      if (!def) throw new Error(`unknown option --${name}`);
      if (def.type === "boolean") {
        out[name] = eq === -1 ? true : token.slice(eq + 1) === "true";
        continue;
      }
      let raw = eq === -1 ? undefined : token.slice(eq + 1);
      if (raw === undefined) {
        raw = argv[++i];
        if (raw === undefined) throw new Error(`missing value for --${name}`);
      }
      out[name] = coerce(def.type, raw, name);
      continue;
    }
    pushPositional(token);
  }
  function pushPositional(token) {
    const name = positionalNames.find((n) => !consumedPositional.has(n) && !(n in out));
    if (!name) throw new Error(`unexpected positional argument: ${token}`);
    consumedPositional.add(name);
    out[name] = coerce("string", token, name);
  }
  function coerce(type, raw, name) {
    if (type === "number") {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`--${name} expects a number (got ${raw})`);
      return n;
    }
    return String(raw);
  }
  for (const r of required) {
    if (!(r in out)) throw new Error(`missing required option --${r}`);
  }
  return out;
}

/**
 * 插件命令执行包装器：错误归一化、ASCII 纪律、退出码映射（design D3）。
 * run 收 { command, args, log, cwd }；返回 { exit?: number } 可指定退出码。
 * @param {{ manifest: { name: string, commands: Array<import("zod").infer<typeof CommandSpecSchema>>, run: (input: { command: string, args: Record<string, unknown>, log: (line: string) => void, cwd: string }) => Promise<{ exit?: number } | void> }, command: string, argv: string[], cwd: string, stdout?: NodeJS.WriteStream, stderr?: NodeJS.WriteStream }} input
 * @returns {Promise<number>} 进程退出码
 */
export async function dispatchPluginCommand({ manifest, command, argv, cwd, stdout = process.stdout, stderr = process.stderr }) {
  const spec = manifest.commands.find((c) => c.name === command);
  if (!spec) {
    const available = manifest.commands.map((c) => c.name).join(", ");
    stderr.write(`error: plugin ${asciiEscape(manifest.name)} has no command "${asciiEscape(command)}" (available: ${asciiEscape(available)})\n`);
    return 2;
  }
  let args;
  try {
    args = parseCommandArgs(spec, argv);
  } catch (e) {
    stderr.write(`error: ${asciiEscape(spec.name)}: ${asciiEscape(e.message)}\n`);
    return 2;
  }
  const log = (line = "") => stdout.write(`${asciiEscape(line)}\n`);
  try {
    const result = await manifest.run({ command, args, log, cwd });
    if (result && typeof result.exit === "number") return result.exit;
    return 0;
  } catch (e) {
    stderr.write(`error[plugin/${asciiEscape(manifest.name)}]: ${asciiEscape(e?.message ?? String(e))}\n`);
    return 1;
  }
}

/**
 * 依据命令声明渲染用法（`opendweb <name> --help` 零执行生成）。
 * @param {{ name: string, description?: string, manifest: { name: string, commands: Array<import("zod").infer<typeof CommandSpecSchema>> } }} input
 * @returns {string} 全 ASCII
 */
export function renderPluginHelp({ name, description = "", manifest }) {
  const esc = asciiEscape;
  const lines = [];
  lines.push(`opendweb ${esc(name)} - plugin commands${description ? `: ${esc(description)}` : ""}`);
  lines.push("");
  lines.push("Usage:");
  for (const c of manifest.commands) {
    // required 已单列在命令行主干；flags 列表只补非 required 项（避免重复）
    const requiredSet = new Set(c.args.required ?? []);
    const flags = Object.entries(c.args.properties ?? {})
      .filter(([k]) => !requiredSet.has(k))
      .map(([k, def]) => (def.type === "boolean" ? `--${k}` : `--${k} <${def.type}>`))
      .join(" ");
    const req = (c.args.required ?? []).map((k) => `--${k} <${(c.args.properties ?? {})[k]?.type ?? "string"}>`).join(" ");
    lines.push(`  opendweb ${esc(name)} ${esc(c.name)}${req ? ` ${esc(req)}` : ""}${flags ? ` [${esc(flags)}]` : ""}`);
    if (c.description) lines.push(`      ${esc(c.description)}`);
  }
  return lines.join("\n");
}
