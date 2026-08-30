// 交互组件适配层（2026-08-30 Owner 第二轮决策：不自写交互终端，改用现代
// 库 @clack/prompts——方向键选择、真 spinner、遮蔽输入的体验非行式输入
// 可比）。本模块收敛三件事：
// 1) UI 注入防护：sanitizeUI 把控制字符转义为 \xNN（C0/DEL/C1 是 ANSI
//    逃逸与 UI 伪造的注入面；可打印 Unicode 保留——@clack 骨架本身即
//    Unicode，交互会话不再要求全 ASCII，但动态值必须堵注入）
// 2) cancel 语义统一：@clack 以 symbol cancel 表示用户中止（Ctrl+C/ESC），
//    这里转成 InteractiveAbort 供编排按「正常中止 exit 0」处理
// 3) 测试注入点：编排层经注入的 clack 对象工作，默认动态 import 真库；
//    单测注入 fake（脚本化应答），库本身的交互正确性由其自身测试背书
import { isCancel as clackIsCancel } from "@clack/prompts";

/** 测试注入面：fake 只需实现本包用到的子集（结构化，宽松于真库全量 API） */
export interface ClackApi {
  intro(title: string): void;
  outro(message: string): void;
  note(body: string, title?: string): void;
  log: { message(message: string): void; step?(message: string): void };
  spinner(): { start(message?: string): void; stop(message?: string): void; message(text: string): void };
  text(options: {
    message: string;
    placeholder?: string;
    defaultValue?: string;
    validate?: (value: string | undefined) => string | undefined;
  }): Promise<string>;
  password(options: { message: string }): Promise<string>;
  select<T>(options: {
    message: string;
    options: Array<{ value: T; label: string; hint?: string }>;
    initialValue?: T;
  }): Promise<T>;
  confirm(options: { message: string }): Promise<boolean>;
  isCancel?(value: unknown): boolean;
}

export interface UiPrompts {
  intro(title: string): void;
  outro(message: string): void;
  note(body: string, title?: string): void;
  log: ClackApi["log"];
  spinner(): ReturnType<ClackApi["spinner"]>;
  text(input: {
    message: string;
    placeholder?: string;
    defaultValue?: string;
    validate?: (value: string | undefined) => string | undefined;
  }): Promise<string>;
  password(input: { message: string }): Promise<string>;
  select<T>(input: {
    message: string;
    options: Array<{ value: T; label: string; hint?: string }>;
    initialValue?: T;
  }): Promise<T>;
  confirm(input: { message: string }): Promise<boolean>;
}

/**
 * UI 注入防护：C0 控制字符（含 Tab/换行/ESC）、DEL 与 C1 控制区
 * （U+0080-U+009F）全部转义为 \\xNN 字面量——Tab 会破坏对齐、C1 是终端
 * 控制面；可打印 Unicode 保留（见头注边界说明）。
 */
export function sanitizeUI(v: unknown): string {
  let out = "";
  for (const ch of String(v)) {
    const c = ch.codePointAt(0) ?? 0;
    out += c < 0x20 || (c >= 0x7f && c <= 0x9f) ? `\\x${c.toString(16).padStart(2, "0")}` : ch;
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
 * note 的 body 是结构性多行文本：换行是排版的一部分，绝不能整体
 * sanitize（会变成 \x0a 字面量）。约定：调用方对动态插值逐项
 * sanitizeUI 后再拼装（tui.ts 的计划预览即此形态）。
 */
export function createPrompts(clack: ClackApi): UiPrompts {
  const guard = <T>(v: T): T => {
    if ((clack.isCancel?.(v) ?? clackIsCancel(v as never))) throw new InteractiveAbort();
    return v;
  };
  return {
    intro: (title) => clack.intro(sanitizeUI(title)),
    outro: (message) => clack.outro(sanitizeUI(message)),
    note: (body, title) => clack.note(body, title ? sanitizeUI(title) : undefined),
    log: clack.log,
    spinner: () => clack.spinner(),
    text: async ({ message, placeholder, defaultValue, validate }) =>
      guard(
        await clack.text({
          message: sanitizeUI(message),
          ...(placeholder !== undefined ? { placeholder: sanitizeUI(placeholder) } : {}),
          ...(defaultValue !== undefined ? { defaultValue: sanitizeUI(defaultValue) } : {}),
          ...(validate ? { validate } : {}),
        }),
      ),
    password: async ({ message }) => guard(await clack.password({ message: sanitizeUI(message) })),
    select: async ({ message, options, initialValue }) =>
      guard(
        await clack.select({
          message: sanitizeUI(message),
          options: options.map((o) => ({
            value: o.value,
            label: sanitizeUI(o.label),
            ...(o.hint !== undefined ? { hint: sanitizeUI(o.hint) } : {}),
          })),
          ...(initialValue !== undefined ? { initialValue } : {}),
        }),
      ),
    confirm: async ({ message }) => guard(await clack.confirm({ message: sanitizeUI(message) })),
  };
}
