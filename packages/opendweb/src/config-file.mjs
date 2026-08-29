// 静态配置文件（plugin-marketplace D4/D6）：TOML 为主、JSON 兼容，
// 编排层零代码。两格式过同一 zod schema（杜绝格式间漂移）；解析失败是
// 静态错误，不涉及任何执行。
import { z } from "zod";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { readTextIfExists, CliExit } from "./util.mjs";

/** server 段：与 flag 同名同规；URL 字段复用 CLI 的同规校验由调用方接入 */
export const ServerConfigSchema = z
  .object({
    gatewayBind: z.string().optional(),
    relayBind: z.string().optional(),
    relayEnabled: z.boolean().optional(),
    trustProxy: z.boolean().optional(),
    publicGatewayUrl: z.string().optional(),
    publicRelayUrl: z.string().optional(),
  })
  .strict();

/** 插件清单元素三形态：裸名 | {name, options} | {file, options?} */
export const PluginEntrySchema = z.union([
  z.string().min(1),
  z
    .object({
      name: z.string().min(1),
      options: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
  z
    .object({
      file: z.string().min(1),
      options: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
]);

/** 配置文件 schema（两格式共用；configVersion 破坏性变更走 2） */
export const ConfigFileSchema = z
  .object({
    configVersion: z.literal(1),
    server: ServerConfigSchema.optional(),
    plugins: z.array(PluginEntrySchema).default([]),
  })
  .strict();

/**
 * 发现配置文件：`opendweb.config.toml` > `.json`（--config 覆盖）。
 * @param {{ cwd: string, explicit?: string, existsSync: (p: string) => boolean }} input
 * @returns {string | null}
 */
export function discoverConfig({ cwd, explicit, existsSync }) {
  if (explicit) {
    if (!existsSync(explicit)) throw new CliExit(`config file not found: ${explicit}`, 2);
    return explicit;
  }
  for (const name of ["opendweb.config.toml", "opendweb.config.json"]) {
    const p = path.join(cwd, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * 解析 + 校验（静态，零执行）。TOML 与 JSON 解析后走同一 zod schema；
 * URL 类字段的同规校验（与 flag 一致）由本函数在 schema 之后追加执行。
 * @param {{ path: string, validateUrl?: (v: string) => string | null, readFileImpl?: typeof readFile, tomlParse?: typeof parseToml }} input
 * @returns {Promise<import("zod").infer<typeof ConfigFileSchema>>}
 */
export async function loadConfigFile({
  path: configPath,
  validateUrl,
  readFileImpl = readFile,
  tomlParse = parseToml,
}) {
  const text = await readTextIfExists({ readFile: readFileImpl }, configPath);
  if (text === null) throw new CliExit(`config file not found: ${configPath}`, 2);
  let raw;
  if (configPath.endsWith(".toml")) {
    try {
      raw = tomlParse(text);
    } catch (e) {
      throw new CliExit(`invalid TOML in ${configPath}: ${e.message}`, 2);
    }
  } else {
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new CliExit(`invalid JSON in ${configPath}: ${e.message}`, 2);
    }
  }
  const parsed = ConfigFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new CliExit(`invalid config ${configPath}: ${issues}`, 2);
  }
  // URL 字段与 flag 同规（config 层静态校验，失败不执行任何插件）
  if (validateUrl) {
    for (const key of ["publicGatewayUrl", "publicRelayUrl"]) {
      const v = parsed.data.server?.[key];
      if (v !== undefined && validateUrl(v) !== null) {
        throw new CliExit(`invalid config ${configPath}: server.${key} = ${v} is not a valid http(s)://host[:port] URL`, 2);
      }
    }
  }
  return parsed.data;
}

/**
 * 优先级合并辅助：flag > env > config > default。resolveServerArgs 已实现
 * flag > env > default；本函数把 config 值注入到该链的 env 之后。
 * 值形态：bind 为 string、开关为 boolean、URL 为 string（均已过 schema）。
 * @param {{ gatewayBind?: string, relayBind?: string, relayEnabled?: boolean, trustProxy?: boolean, publicGatewayUrl?: string, publicRelayUrl?: string }} server
 */
export function configDefaults(server) {
  return {
    gatewayBind: server?.gatewayBind,
    relayBind: server?.relayBind,
    relayEnabled: server?.relayEnabled,
    trustProxy: server?.trustProxy,
    publicGatewayUrl: server?.publicGatewayUrl,
    publicRelayUrl: server?.publicRelayUrl,
  };
}
