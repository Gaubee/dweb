// 行式输入组件（cf setup 交互引导用，2026-08-30 Owner 需求：setup 子命令
// 提供 TUI 引导）。零依赖：readline + 数字选择 + y/d/n 确认，无 raw mode。
//
// 行分发自维护队列而非 rl.question：question 挂起期间到达的额外行会被
// readline 丢弃（管道预置输入 / 脚本驱动的真实场景会死锁在第二问），
// backlog 暂存后逐问供给；输入关闭时拒绝未决问题（Ctrl+C / EOF ->
// 上层按失败处理）。
import readline from "node:readline/promises";

/**
 * 动态值 ASCII 纪律（与宿主 CLI 的 D10 同规）：UTF-8 字节小写 \xNN、
 * 控制字符同转义保一行一错误。cf 插件零依赖，故本地实现而非 import 宿主。
 * @param {unknown} v
 * @returns {string}
 */
export function asciiEscape(v) {
  const s = String(v);
  let out = "";
  for (const b of Buffer.from(s, "utf8")) {
    out += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, "0")}`;
  }
  return out;
}

/** NO_COLOR / 非 TTY 时全部恒等（输出内容不因颜色通道而变化）。包装函数
 *  只做 ANSI 包裹——输入必须已是转义后的 ASCII（先 asciiEscape 后着色，
 *  顺序不可反：着色后再转义会把 ANSI 序列变成字面量） */
function colors(output) {
  if (!output.isTTY || process.env.NO_COLOR) {
    return { dim: (s) => String(s), bold: (s) => String(s), green: (s) => String(s), red: (s) => String(s) };
  }
  return {
    dim: (s) => `\x1b[2m${s}\x1b[22m`,
    bold: (s) => `\x1b[1m${s}\x1b[22m`,
    green: (s) => `\x1b[32m${s}\x1b[39m`,
    red: (s) => `\x1b[31m${s}\x1b[39m`,
  };
}

/**
 * 输出侧受控 writer（P1-2：宿主 D10 纪律）：line(text, style) 先把整行
 * （含动态插值）经 asciiEscape，再用可选的 colors 包装函数上色写出——
 * 动态值里的 Unicode/控制字符不可能进入输出。
 * @param {{ write: (s: string) => boolean }} stream
 */
export function createWriter(stream) {
  const paint = colors(stream);
  return {
    paint,
    line: (line = "", style) => {
      stream.write(`${style ? style(asciiEscape(line)) : asciiEscape(line)}\n`);
    },
  };
}

/**
 * 基础输入组件。所有提示文案经 asciiEscape（hostname/token/错误消息等
 * 动态值不构成注入面）。
 * @param {{ input: NodeJS.ReadStream & { isTTY?: boolean }, output: NodeJS.WriteStream & { isTTY?: boolean } }} streams
 */
export function createPrompts({ input, output }) {
  const rl = readline.createInterface({ input, output });
  const paint = colors(output);
  const backlog = [];
  const pending = [];
  let closed = false;
  rl.on("line", (line) => {
    const next = pending.shift();
    if (next) next.resolve(line);
    else backlog.push(line);
  });
  rl.on("close", () => {
    closed = true;
    for (const next of pending.splice(0)) next.reject(new Error("input closed before an answer"));
  });
  const readLine = () => {
    if (backlog.length > 0) return Promise.resolve(backlog.shift());
    if (closed) return Promise.reject(new Error("input closed before an answer"));
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  };

  async function ask(label, { default: def, required = false } = {}) {
    for (;;) {
      output.write(paint.dim(`${asciiEscape(label)}${def !== undefined ? ` (${asciiEscape(def)})` : ""}: `));
      const answer = (await readLine()).trim();
      const value = answer === "" && def !== undefined ? def : answer;
      if (!required || value !== "") return value;
      output.write(paint.dim("  a value is required\n"));
    }
  }

  async function askSecret(label) {
    // 遮蔽手法：提示语自己写；terminal 模式下按键回显经 _writeToOutput
    // 替换为 '*'（readline 的半私有稳定接口——零依赖下的务实选择），
    // 管道模式本就无回显。恢复须精确：记录 own 属性状态，原先不存在则
    // delete（P2：bind 恢复会留下 own 属性）。
    output.write(paint.dim(`${asciiEscape(label)} (input hidden): `));
    const hadOwn = Object.hasOwn(rl, "_writeToOutput");
    const orig = hadOwn ? rl._writeToOutput : undefined;
    rl._writeToOutput = (s) => rl.output.write(s ? "*" : s);
    try {
      return (await readLine()).trim();
    } finally {
      if (hadOwn) rl._writeToOutput = orig;
      else delete rl._writeToOutput;
      output.write("\n");
    }
  }

  async function select(label, options) {
    const fallback = options.findIndex((o) => o.default);
    output.write(paint.bold(`? ${asciiEscape(label)}\n`));
    options.forEach((o, i) => {
      const mark = o.default ? " (default)" : "";
      output.write(`  ${i + 1}) ${asciiEscape(o.label)}${paint.dim(mark)}\n`);
    });
    for (;;) {
      output.write(`  choose [${fallback + 1}]: `);
      const raw = (await readLine()).trim();
      const idx = raw === "" ? fallback : Number(raw) - 1;
      if (Number.isInteger(idx) && idx >= 0 && idx < options.length) return options[idx].value;
      output.write(paint.dim(`  enter a number between 1 and ${options.length}\n`));
    }
  }

  /**
   * 三态确认：y = apply / d = dry-run / n = abort（回车取默认，通常 apply）。
   * @returns {Promise<"apply" | "dry" | "no">}
   */
  async function confirm3(label, def = "apply") {
    for (;;) {
      output.write(`? ${asciiEscape(label)} [y] apply / [d] dry-run / [n] abort (${def}): `);
      const raw = (await readLine()).trim().toLowerCase();
      const value = raw === "" ? def : raw;
      if (value === "y" || value === "yes") return "apply";
      if (value === "d" || value === "dry") return "dry";
      if (value === "n" || value === "no") return "no";
      output.write(paint.dim("  answer y, d or n\n"));
    }
  }

  /**
   * 二元确认（forceDryRun 等只有 go/no-go 的场景）。
   * @returns {Promise<boolean>} true = 执行，false = 中止
   */
  async function confirm(label, def = true) {
    for (;;) {
      output.write(`? ${asciiEscape(label)} (${def ? "Y/n" : "y/N"}): `);
      const raw = (await readLine()).trim().toLowerCase();
      const value = raw === "" ? (def ? "y" : "n") : raw;
      if (value === "y" || value === "yes") return true;
      if (value === "n" || value === "no") return false;
      output.write(paint.dim("  answer y or n\n"));
    }
  }

  return { ask, askSecret, select, confirm3, confirm, rl, paint, close: () => rl.close() };
}
