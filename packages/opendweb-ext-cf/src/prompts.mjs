// 交互组件适配层（2026-08-30 Owner 第二轮决策：不自写交互终端，改用现代
// 库 @clack/prompts——方向键选择、真 spinner、遮蔽输入的体验非行式输入
// 可比）。本模块收敛三件事：
// 1) UI 注入防护：sanitizeUI 把控制字符/换行转义为 \xNN（C0/DEL 是
//    ANSI 逃逸与 UI 伪造的注入面；可打印 Unicode 保留——@clack 骨架本身
//    即 Unicode，交互会话不再要求全 ASCII，但动态值必须堵注入）
// 2) cancel 语义统一：@clack 以 symbol cancel 表示用户中止（Ctrl+C/ESC），
//    这里转成 InteractiveAbort 供编排按「正常中止 exit 0」处理
// 3) 测试注入点：编排层经注入的 clack 对象工作，默认动态 import 真库；
//    单测注入 fake（脚本化应答），库本身的交互正确性由其自身测试背书
import { isCancel as clackIsCancel } from "@clack/prompts";

/**
 * UI 注入防护：C0 控制字符（含换行/ESC）与 DEL 转义为 \\xNN 字面量；
 * 可打印 Unicode 照常显示（见头注边界说明）。
 * @param {unknown} v
 * @returns {string}
 */
export function sanitizeUI(v) {
  let out = "";
  for (const ch of String(v)) {
    const c = ch.codePointAt(0);
    out += (c < 0x20 || c === 0x7f) && c !== 0x09 ? `\\x${c.toString(16).padStart(2, "0")}` : ch;
  }
  return out;
}

/** 用户主动中止（@clack cancel / 输入流关闭）；不是错误，编排按 exit 0 处理 */
export class InteractiveAbort extends Error {
  constructor() {
    super("interactive session aborted by the user");
    this.name = "InteractiveAbort";
  }
}

/**
 * 构建绑定了真库（或测试注入的 fake）的 prompt 集合，cancel 统一转
 * InteractiveAbort，message/label 类动态值统一过 sanitizeUI。
 * @param {Awaited<typeof import("@clack/prompts")>} clack
 */
export function createPrompts(clack) {
  const guard = (v) => {
    if (clack.isCancel?.(v) ?? clackIsCancel(v)) throw new InteractiveAbort();
    return v;
  };
  return {
    intro: (title) => clack.intro(sanitizeUI(title)),
    outro: (msg) => clack.outro(sanitizeUI(msg)),
    note: (body, title) => clack.note(sanitizeUI(body), title ? sanitizeUI(title) : undefined),
    log: clack.log,
    spinner: () => clack.spinner(),
    text: async ({ message, placeholder, defaultValue, validate }) =>
      guard(await clack.text({
        message: sanitizeUI(message),
        ...(placeholder !== undefined ? { placeholder: sanitizeUI(placeholder) } : {}),
        ...(defaultValue !== undefined ? { defaultValue: sanitizeUI(defaultValue) } : {}),
        ...(validate ? { validate } : {}),
      })),
    password: async ({ message }) => guard(await clack.password({ message: sanitizeUI(message) })),
    select: async ({ message, options, initialValue }) =>
      guard(await clack.select({
        message: sanitizeUI(message),
        options: options.map((o) => ({
          value: o.value,
          label: sanitizeUI(o.label),
          ...(o.hint !== undefined ? { hint: sanitizeUI(o.hint) } : {}),
        })),
        ...(initialValue !== undefined ? { initialValue } : {}),
      })),
    confirm: async ({ message }) =>
      guard(await clack.confirm({ message: sanitizeUI(message) })),
  };
}
