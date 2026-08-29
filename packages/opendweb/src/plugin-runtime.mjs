// 插件 config 面运行时（plugin-marketplace D4b/D5）：统一插件对象契约
// `{name, hooks}` + 双适配器（npm 进程内直调 / 本地文件 shebang 子进程）
// + 3+1 生命周期编排（preStart/postReady/preStop/setup）。
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";
import { PluginManifestSchema } from "./plugin-contract.mjs";
import { candidatesFor } from "./marketplace.mjs";
import { resolvePluginEntry } from "./plugin-resolve.mjs";
import { asciiEscape, CliExit } from "./util.mjs";

/** 生命周期与可调用钩子（v1 恰 3+1） */
export const HOOK_NAMES = ["server.preStart", "server.postReady", "server.preStop", "setup"];

/**
 * shebang 首行 → 解释器命令（含 `env -S` 组合形态）。
 * `#!/usr/bin/env -S deno run` → { cmd: "deno", args: ["run"] }
 * `#!/usr/bin/env bun` → { cmd: "bun", args: [] }
 * `#!/usr/bin/deno` → { cmd: "/usr/bin/deno", args: [] }
 * @param {string} firstLine
 * @returns {{ cmd: string, args: string[] } | null}
 */
export function parseShebang(firstLine) {
  if (!firstLine.startsWith("#!")) return null;
  const tokens = firstLine.slice(2).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  if (tokens[0]?.endsWith("/env") || tokens[0] === "env") {
    const rest = tokens.slice(1);
    const dashS = rest.indexOf("-S");
    if (dashS !== -1) {
      // env -S 后的整串是一个命令行（可能含参数）
      const cmdTokens = rest.slice(dashS + 1);
      return cmdTokens.length > 0 ? { cmd: cmdTokens[0], args: cmdTokens.slice(1) } : null;
    }
    const [cmd, ...args] = rest;
    return cmd ? { cmd, args } : null;
  }
  return { cmd: tokens[0], args: tokens.slice(1) };
}

/** 执行子进程并收 stdout/stderr/退出码（超时兜底防本地插件挂死 CLI） */
export function runCapture(cmd, args, { cwd, input, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        resolve({ code: null, stdout: out, stderr: `${err}\n(timeout after ${timeoutMs}ms)` });
      }
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout: out, stderr: String(e.message) });
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 0, stdout: out, stderr: err });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** 钩子调用结果：ok=true 时 result 为钩子返回值（可为 undefined） */
export class HookOutcome {
  /**
   * @param {boolean} ok
   * @param {unknown} [result]
   * @param {string} [error]
   */
  constructor(ok, result, error) {
    this.ok = ok;
    this.result = result;
    this.error = error;
  }
}

/**
 * 加载声明的插件列表（配置清单序），产出统一适配器。
 * 重名 → 硬错误（编排歧义）。本地插件的 file 路径相对 configDir 解析
 * （R2 阻塞-3：spec 冻结「路径相对配置文件目录」），npm 候选仍从 cwd 解析。
 * @param {{ plugins: Array<string | {name: string, options?: object} | {file: string, options?: object}>, globs: string[], cwd: string, configDir?: string, importModule?: (url: string) => Promise<unknown>, exec?: typeof runCapture, which?: (cmd: string) => string | null }} input
 * @returns {Promise<Array<{ name: string, kind: "npm" | "local", options: object, hooks: string[], invoke: (hook: string, payload: object) => Promise<HookOutcome> }>>}
 */
export async function loadDeclaredPlugins({
  plugins,
  globs,
  cwd,
  configDir,
  importModule = (url) => import(url),
  exec = runCapture,
  which,
}) {
  /** @type {Awaited<ReturnType<typeof loadDeclaredPlugins>>} */
  const out = [];
  const seen = new Set();
  const fileBase = configDir ?? cwd;
  for (const entry of plugins) {
    const normalized =
      typeof entry === "string" ? { name: entry, options: {} } : { options: {}, ...entry };
    if ("file" in normalized && normalized.file) {
      const file = path.resolve(fileBase, normalized.file);
      const adapter = await makeLocalAdapter({ file, options: normalized.options ?? {}, exec });
      if (seen.has(adapter.name)) throw new CliExit(`duplicate plugin name in config: ${adapter.name}`, 2);
      seen.add(adapter.name);
      out.push(adapter);
      continue;
    }
    const name = /** @type {{name?: string}} */ (normalized).name;
    if (!name) throw new CliExit(`plugin entry must have name or file (got ${JSON.stringify(entry)})`, 2);
    const adapter = await makeNpmAdapter({ name, options: normalized.options ?? {}, globs, cwd, importModule });
    if (seen.has(adapter.name)) throw new CliExit(`duplicate plugin name in config: ${adapter.name}`, 2);
    seen.add(adapter.name);
    out.push(adapter);
  }
  return out;

  async function makeNpmAdapter({ name, options, globs, cwd, importModule }) {
    // config 面 = 包根导出（exports["."]）：解析入口而非 package.json 子路径
    // （exports 存在时 package.json 不可解析——ERR_PACKAGE_PATH_NOT_EXPORTED）
    let entry = null;
    let pkg = null;
    const req = createRequire(path.join(cwd, "package.json"));
    for (const candidate of candidatesFor(globs, name)) {
      try {
        entry = req.resolve(candidate);
        pkg = candidate;
        break;
      } catch {
        /* try next candidate */
      }
    }
    if (entry === null) {
      throw new CliExit(`config plugin "${name}" is not installed (opendweb plugin add ${name})`, 2);
    }
    const mod = await importModule(pathToFileURL(entry).href);
    const plugin = mod?.default ?? mod;
    validatePluginObject(plugin, pkg);
    const hooks = Object.keys(plugin.hooks ?? {}).filter((h) => HOOK_NAMES.includes(h));
    return {
      name: plugin.name,
      kind: "npm",
      options,
      hooks,
      invoke: async (hook, payload) => {
        const fn = plugin.hooks?.[hook];
        if (typeof fn !== "function") return new HookOutcome(true);
        try {
          return new HookOutcome(true, await fn({ ...payload, options }));
        } catch (e) {
          return new HookOutcome(false, undefined, e?.message ?? String(e));
        }
      },
    };
  }

  async function makeLocalAdapter({ file, options, exec }) {
    const declared = await declareLocalPlugin({ file, exec, which });
    return {
      name: declared.name,
      kind: "local",
      options,
      hooks: declared.hooks,
      invoke: async (hook, payload) => {
        if (!declared.hooks.includes(hook)) return new HookOutcome(true);
        // ctx.options：调用方显式携带的 options 优先（测试/编排注入），
        // 否则用配置声明的 options——spread 覆灭 bug 的修正
        const res = await exec(declared.cmd, [...declared.args, file, "--opendweb-hook", hook], {
          cwd,
          input: JSON.stringify({ ...payload, options: payload.options ?? options }),
        });
        if (res.code !== 0) {
          return new HookOutcome(false, undefined, res.stderr.trim() || `exited with code ${res.code}`);
        }
        // R2 阻塞-5：stdout 必须严格是单个 JSON 值（或空 = 成功无返回值）；
        // 有输出但不可解析 = 协议损坏（截断/多行污染），按钩子失败处理——
        // 静默吞掉会把截断的 preStart 覆写当成成功
        const text = res.stdout.trim();
        if (text === "") return new HookOutcome(true);
        try {
          return new HookOutcome(true, JSON.parse(text));
        } catch (e) {
          return new HookOutcome(
            false,
            undefined,
            `hook output is not valid JSON (protocol corruption?): ${String(e.message)}; first 120 bytes: ${text.slice(0, 120)}`,
          );
        }
      },
    };
  }
}

/** 校验插件对象契约 {name, hooks}（npm config 面） */
function validatePluginObject(plugin, pkg) {
  if (!plugin || typeof plugin !== "object") {
    throw new CliExit(`config plugin ${pkg}: root export must be a plugin object {name, hooks}`, 1);
  }
  if (typeof plugin.name !== "string" || !/^[a-z][a-z0-9-]*$/.test(plugin.name)) {
    throw new CliExit(`config plugin ${pkg}: invalid plugin name ${JSON.stringify(plugin.name)}`, 1);
  }
  if (plugin.hooks !== undefined && typeof plugin.hooks !== "object") {
    throw new CliExit(`config plugin ${pkg}: hooks must be an object of functions`, 1);
  }
  for (const [hook, fn] of Object.entries(plugin.hooks ?? {})) {
    if (!HOOK_NAMES.includes(hook)) {
      throw new CliExit(`config plugin ${pkg}: unknown hook "${hook}" (known: ${HOOK_NAMES.join(", ")})`, 1);
    }
    if (typeof fn !== "function") {
      throw new CliExit(`config plugin ${pkg}: hook "${hook}" must be a function`, 1);
    }
  }
}

/**
 * 本地插件声明：无参执行 `--opendweb-declare` → stdout `{name, hooks:[...]}`。
 * 解释器：shebang 优先；无 shebang 按扩展名探测（.ts → bun|deno|node）。
 */
async function declareLocalPlugin({ file, exec, which }) {
  const fsMod = await import("node:fs/promises");
  const head = (await fsMod.readFile(file, "utf8").catch(() => null))?.split("\n")[0] ?? "";
  let cmd = null;
  let args = [];
  const shebang = parseShebang(head);
  if (shebang) {
    cmd = shebang.cmd;
    args = shebang.args;
  } else if (file.endsWith(".ts")) {
    cmd = which?.("bun") ?? which?.("deno") ?? "node";
    if (cmd === "deno") args = ["run"];
  } else {
    cmd = "node";
  }
  const res = await exec(cmd, [...args, file, "--opendweb-declare"], {});
  if (res.code !== 0) {
    throw new CliExit(`local plugin failed to declare (${file}):\n${asciiEscape(res.stderr.trim())}`, 1);
  }
  let declared;
  try {
    declared = JSON.parse(res.stdout);
  } catch {
    throw new CliExit(`local plugin declaration is not JSON (${file}):\n${asciiEscape(res.stdout.slice(0, 200))}`, 1);
  }
  const check = PluginManifestSchema.pick({ name: true }).safeParse(declared);
  if (!check.success || !Array.isArray(declared.hooks)) {
    throw new CliExit(`local plugin declaration invalid (${file}): expected {name, hooks: string[]}`, 1);
  }
  const unknown = declared.hooks.filter((h) => !HOOK_NAMES.includes(h));
  if (unknown.length > 0) {
    throw new CliExit(`local plugin ${declared.name} declares unknown hooks: ${unknown.join(", ")}`, 1);
  }
  return { name: declared.name, hooks: declared.hooks, cmd, args };
}

/**
 * 生命周期编排（server 命令内嵌）：
 * - preStart：收集覆写片段并合并（后到者覆盖，值经调用方校验），失败阻断
 * - postReady：失败降级 WARNING；结果可带 bannerLines（ASCII 追加横幅）
 * - preStop：尽力执行（失败仅 WARNING）
 * @param {{ plugins: Array<{name: string, hooks: string[], invoke: Function}>, hook: string, payload: object, stderr?: NodeJS.WriteStream }} input
 * @returns {Promise<{ failures: Array<{name: string, error: string}>, merged: object, bannerLines: string[] }>}
 */
export async function fireHook({ plugins, hook, payload, stderr = process.stderr }) {
  const failures = [];
  const merged = {};
  const bannerLines = [];
  for (const p of plugins) {
    if (!p.hooks.includes(hook)) continue;
    const r = await p.invoke(hook, payload);
    if (!r.ok) {
      failures.push({ name: p.name, error: r.error ?? "unknown error" });
      continue;
    }
    const result = r.result;
    if (result && typeof result === "object") {
      if (result.server && typeof result.server === "object") {
        Object.assign(merged, result.server);
      }
      if (Array.isArray(result.bannerLines)) {
        bannerLines.push(...result.bannerLines.map((l) => asciiEscape(String(l))));
      }
    }
  }
  if (hook !== "server.postReady" && hook !== "server.preStop" && failures.length > 0) {
    // preStart / setup：失败阻断（调用方决定退出）；postReady/preStop 由调用方降级
    stderr.write(
      failures.map((f) => `error[plugin/${asciiEscape(f.name)}]: ${asciiEscape(f.error)}`).join("\n") + "\n",
    );
  }
  return { failures, merged, bannerLines };
}
