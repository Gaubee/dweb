// @jixo/opendweb-config — 本地插件文件的协议封装（plugin-marketplace D4b）。
// 意图：插件作者只声明 {name, hooks}；声明/回调子进程协议（--opendweb-declare /
// --opendweb-hook + stdin/stdout JSON）由 definePlugin 的模块加载副作用处理。
// runtime 无关：Deno / Bun / Node 均可承载（检测全局对象），无任何 node: 依赖。
//
// 用法（opendweb.plugins/cf.ts）：
//   #!/usr/bin/env -S deno run
//   import { definePlugin } from "npm:@jixo/opendweb-config";
//   export default definePlugin({
//     name: "my-notify",
//     hooks: {
//       async "server.postReady"(ctx) { /* ctx.options / ctx.server */ },
//     },
//   });

/** 当前 runtime 的 argv（不含可执行文件本身） */
function runtimeArgs() {
  if (typeof globalThis.Deno !== "undefined") return [...globalThis.Deno.args];
  if (typeof globalThis.Bun !== "undefined") return globalThis.Bun.argv.slice(2);
  if (typeof process !== "undefined" && Array.isArray(process.argv)) {
    return process.argv.slice(2);
  }
  return [];
}

/**
 * 当前 runtime 的 stdout 写出（完成式：resolve 前保证已冲刷——
 * R2 阻塞-5：不等待写入完成就 exit 会截断大输出，协议侧按损坏 JSON 处理）
 * @param {string} text
 * @returns {Promise<void>}
 */
async function writeStdout(text) {
  if (typeof globalThis.Deno !== "undefined") {
    await globalThis.Deno.stdout.write(new TextEncoder().encode(text));
    return;
  }
  // Node / Bun：write 的回调在缓冲落盘后触发（背压时等待 drain）
  await new Promise((resolve, reject) => {
    process.stdout.write(text, (err) => (err ? reject(err) : resolve()));
  });
}

/** 当前 runtime 的 stdin 全量读取 */
async function readStdin() {
  if (typeof globalThis.Deno !== "undefined") {
    const chunks = [];
    const buf = new Uint8Array(4096);
    // Deno.stdin.read 在 EOF 时返回 null
    for (;;) {
      const n = await globalThis.Deno.stdin.read(buf);
      if (n === null) break;
      chunks.push(buf.slice(0, n));
    }
    return new TextDecoder().decode(concat(chunks));
  }
  // Bun 与 Node 共享 node:readline 语义；Bun 额外兼容 process.stdin
  const rl = (await import("node:readline")).createInterface({ input: process.stdin });
  let text = "";
  rl.on("line", (l) => (text += l + "\n"));
  await new Promise((resolve) => rl.once("close", resolve));
  return text;
}

function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** 当前 runtime 的显式退出 */
function runtimeExit(code) {
  if (typeof globalThis.Deno !== "undefined") globalThis.Deno.exit(code);
  else process.exit(code);
}

/**
 * 声明本地插件并挂接子进程协议。非协议调用（无 --opendweb-* 参数）时为
 * 纯导出（可被直接 import 测试）。
 * @template {Record<string, (ctx: any) => Promise<any> | any>} H
 * @param {{ name: string, hooks: H }} plugin
 * @returns {{ name: string, hooks: H }}
 */
export function definePlugin(plugin) {
  const args = runtimeArgs();
  const declareIdx = args.indexOf("--opendweb-declare");
  const hookIdx = args.indexOf("--opendweb-hook");
  if (declareIdx !== -1) {
    // 写入完成后再退出（R2 阻塞-5：截断的声明会被 CLI 按协议损坏拒绝）
    writeStdout(JSON.stringify({ name: plugin.name, hooks: Object.keys(plugin.hooks ?? {}) }) + "\n")
      .then(() => runtimeExit(0))
      .catch(() => runtimeExit(1));
    return plugin;
  }
  if (hookIdx !== -1) {
    const hook = args[hookIdx + 1];
    readStdin()
      .then(async (text) => {
        const payload = text ? JSON.parse(text) : {};
        const fn = plugin.hooks?.[hook];
        if (typeof fn !== "function") {
          runtimeExit(0);
          return;
        }
        const result = await fn(payload);
        await writeStdout(JSON.stringify(result ?? null) + "\n");
        runtimeExit(0);
      })
      .catch(async (e) => {
        // 钩子失败：stderr 报错（冲刷后退出）+ 非零退出码（CLI invoke 归一化）
        const msg = `${e?.message ?? String(e)}\n`;
        try {
          if (typeof globalThis.Deno !== "undefined") {
            await globalThis.Deno.stderr.write(new TextEncoder().encode(msg));
          } else {
            await new Promise((resolve) => process.stderr.write(msg, () => resolve()));
          }
        } catch {
          /* stderr 冲刷失败不掩盖原错误 */
        }
        runtimeExit(1);
      });
  }
  return plugin;
}
