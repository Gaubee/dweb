// 共享工具：动态值 ASCII 纪律（D10）与 CLI 退出语义。
// 意图（2026-08-29，plugin-marketplace）：bin 与 src 各模块共用，避免双向依赖。

/** 动态值 ASCII 纪律：UTF-8 字节小写 \xNN，控制字符同转义保一行一错误 */
export function asciiEscape(v) {
  const s = String(v);
  let out = "";
  for (const b of Buffer.from(s, "utf8")) {
    out += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, "0")}`;
  }
  return out;
}

/**
 * 插件/CLI 统一错误：message 已含 "error: " 前缀语义；exitCode 默认 1。
 * 用法：throw new CliExit("msg", 2)
 */
export class CliExit extends Error {
  /**
   * @param {string} message
   * @param {number} [exitCode]
   */
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** 读文本文件（ENOENT → null） */
export async function readTextIfExists(fs, path) {
  try {
    return await fs.readFile(path, "utf8");
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e)?.code === "ENOENT") return null;
    throw e;
  }
}
