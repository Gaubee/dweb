// TUI 引导单测（2026-08-30 Owner 二轮决策：交互层基于 @clack/prompts）。
// 编排测试注入 fake clack（脚本化应答；text 会执行 validate 模拟库的重问
// 语义），@clack 自身的交互正确性由库自身测试背书；管道驱动的真实库行为
// 由 e2e 覆盖（\r 提交、方向键序列）。另覆盖 sanitizeUI 防注入与
// InteractiveAbort 的编排语义。
import test from "node:test";
import assert from "node:assert/strict";

import { sanitizeUI, InteractiveAbort, createPrompts } from "../src/prompts.mjs";
import { runInteractiveSetup } from "../src/tui.mjs";
import { wantsInteractive } from "../src/cli.js";

/** fake clack：按类型弹出应答；记录全部调用供断言。text 执行 validate
 * （返回 string 即取下一应答重试——模拟 @clack 的重问循环） */
function fakeClack(answers) {
  const queue = [...answers];
  const calls = { text: [], password: [], select: [], confirm: [], intro: [], outro: [], note: [], log: [] };
  const next = (type) => {
    if (queue.length === 0) throw new Error(`fake clack: no scripted answer left for ${type}`);
    const a = queue.shift();
    if (a.type !== type) throw new Error(`fake clack: expected ${a.type}, got call ${type}`);
    return a;
  };
  return {
    calls,
    isCancel: (v) => v === Symbol.for("clack:cancel"),
    intro: (t) => { calls.intro.push(t); },
    outro: (m) => { calls.outro.push(m); },
    note: (body, title) => { calls.note.push({ body, title }); },
    log: { message: (m) => { calls.log.push(m); }, step: (m) => { calls.log.push(m); } },
    spinner: () => ({ start: () => {}, stop: () => {}, message: () => {} }),
    text: async (cfg) => {
      calls.text.push(cfg);
      for (;;) {
        const a = next("text");
        // @clack 语义：空提交且设有 defaultValue 时 validate 收到 undefined，
        // validate 通过后库返回 defaultValue
        const toValidate = a.value === "" && cfg.defaultValue !== undefined ? undefined : a.value;
        const err = cfg.validate?.(toValidate);
        if (err) continue; // 重问：消耗下一个应答
        return a.value === "" && cfg.defaultValue !== undefined ? cfg.defaultValue : a.value;
      }
    },
    password: async (cfg) => {
      calls.password.push(cfg);
      return next("password").value;
    },
    select: async (cfg) => {
      calls.select.push(cfg);
      return next("select").value;
    },
    confirm: async (cfg) => {
      calls.confirm.push(cfg);
      return next("confirm").value;
    },
  };
}

const A = {
  text: (value) => ({ type: "text", value }),
  password: (value) => ({ type: "password", value }),
  select: (value) => ({ type: "select", value }),
  confirm: (value) => ({ type: "confirm", value }),
};

/** 编排用 mock runSetup：捕获参数并模拟成功 */
function mockRunSetup() {
  const calls = [];
  return {
    calls,
    impl: async (input) => {
      calls.push(input);
      return { plan: { publicGatewayUrl: `https://${input.hostname}` } };
    },
  };
}

test("sanitizeUI: control characters are escaped, printable unicode kept (injection guard)", () => {
  assert.equal(sanitizeUI("ok"), "ok");
  assert.equal(sanitizeUI("bad\u2713host"), "bad\u2713host"); // 可打印 Unicode 保留（@clack 骨架即 Unicode）
  assert.equal(sanitizeUI("esc\x1b[31mred"), "esc\\x1b[31mred"); // ESC 注入转义
  assert.equal(sanitizeUI("line\nbreak"), "line\\x0abreak"); // 换行伪造 UI 转义
  assert.equal(sanitizeUI("del\x7f"), "del\\x7f");
  assert.equal(sanitizeUI("tab\tsep"), "tab\\x09sep"); // Tab 破坏对齐——同样转义
  assert.equal(sanitizeUI("c1\u009cseq"), "c1\\x9cseq"); // C1 控制区（U+0080-U+009F）
  assert.equal(sanitizeUI("stx\u0082"), "stx\\x82");
});

test("createPrompts: a clack cancel result maps to InteractiveAbort", async () => {
  const cancel = Symbol.for("clack:cancel");
  const fk = {
    isCancel: (v) => v === cancel,
    intro: () => {}, outro: () => {}, note: () => {},
    log: { message: () => {} }, spinner: () => ({ start: () => {}, stop: () => {}, message: () => {} }),
    text: async () => cancel,
    password: async () => "x",
    select: async () => "x",
    confirm: async () => true,
  };
  const ui = createPrompts(fk);
  await assert.rejects(() => ui.text({ message: "m" }), (e) => e instanceof InteractiveAbort);
  // message 类动态值经 sanitizeUI
  const calls = [];
  fk.text = async (cfg) => { calls.push(cfg); return "v"; };
  await ui.text({ message: "inject\nme" });
  assert.equal(calls[0].message, "inject\\x0ame");
});

test("runInteractiveSetup: collect -> preview -> apply; runSetup receives resolved inputs", async () => {
  const fk = fakeClack([
    A.select("env"),              // token 来源
    A.text("dweb.example.com"),   // hostname
    A.select("dual"),             // mode
    A.select("apply"),            // 确认
  ]);
  const { calls, impl } = mockRunSetup();
  const r = await runInteractiveSetup({
    cwd: "/proj",
    env: { TUNNEL_TOKEN: "env-token" },
    clack: fk,
    runSetupImpl: impl,
  });
  assert.equal(r.exit, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].token, "env-token");
  assert.equal(calls[0].hostname, "dweb.example.com");
  assert.equal(calls[0].mode, "dual");
  assert.equal(calls[0].dryRun, false);
  // 计划预览进 note（标题 plan）
  assert.equal(fk.calls.note.length, 1);
  assert.match(fk.calls.note[0].body, /gateway\s+dweb\.example\.com/);
  assert.match(fk.calls.note[0].body, /steps:/);
  // 结构性换行保留给 @clack 排版（不被 sanitize 成 \x0a 字面量）
  assert.ok(fk.calls.note[0].body.includes("\n"), "note body keeps structural newlines");
  // 成功收尾
  assert.match(fk.calls.outro.join("\n"), /setup ok \(applied\)/);
  assert.match(fk.calls.log.join("\n"), /config set relay https:\/\/dweb\.example\.com/);
});

test("runInteractiveSetup: empty hostname falls back to the suggested default value", async () => {
  const fk = fakeClack([
    A.select("env"),
    A.text(""),                   // 空输入 -> @clack 取 defaultValue
    A.select("dual"),
    A.select("apply"),
  ]);
  const { calls, impl } = mockRunSetup();
  const r = await runInteractiveSetup({
    cwd: "/proj",
    env: { TUNNEL_TOKEN: "t" },
    suggestedHostname: "suggested.example.com",
    clack: fk,
    runSetupImpl: impl,
  });
  assert.equal(r.exit, 0);
  assert.equal(calls[0].hostname, "suggested.example.com");
  // 建议值作为 defaultValue 传入库
  assert.equal(fk.calls.text[0].defaultValue, "suggested.example.com");
});

test("runInteractiveSetup: abort keeps exit 0 and never runs setup", async () => {
  const fk = fakeClack([
    A.select("env"),
    A.text("dweb.example.com"),
    A.select("dual"),
    A.select("no"),
  ]);
  const { calls, impl } = mockRunSetup();
  const r = await runInteractiveSetup({
    cwd: "/proj",
    env: { TUNNEL_TOKEN: "t" },
    clack: fk,
    runSetupImpl: impl,
  });
  assert.equal(r.exit, 0);
  assert.equal(calls.length, 0);
  assert.match(fk.calls.outro.join("\n"), /aborted; nothing was changed/);
});

test("runInteractiveSetup: clack cancel (Ctrl+C) maps to abort semantics", async () => {
  const cancel = Symbol.for("clack:cancel");
  const fk = fakeClack([]);
  fk.select = async () => cancel; // 第一个问题（token 来源）即取消
  const { calls, impl } = mockRunSetup();
  const r = await runInteractiveSetup({
    cwd: "/proj",
    env: { TUNNEL_TOKEN: "t" },
    clack: fk,
    runSetupImpl: impl,
  });
  assert.equal(r.exit, 0);
  assert.equal(calls.length, 0);
  assert.match(fk.calls.outro.join("\n"), /aborted; nothing was changed/);
});

test("runInteractiveSetup: dry choice runs the same flow as dry-run", async () => {
  const fk = fakeClack([
    A.select("env"),
    A.text("dweb.example.com"),
    A.select("single"),
    A.select("dry"),
  ]);
  const { calls, impl } = mockRunSetup();
  const r = await runInteractiveSetup({
    cwd: "/proj",
    env: { TUNNEL_TOKEN: "t" },
    clack: fk,
    runSetupImpl: impl,
  });
  assert.equal(r.exit, 0);
  assert.equal(calls[0].dryRun, true);
  assert.equal(calls[0].skipVerify, true);
  assert.equal(calls[0].mode, "single");
  assert.match(fk.calls.outro.join("\n"), /dry-run ok - nothing was pushed/);
});

test("runInteractiveSetup: forceDryRun skips token collection and cannot become apply (P1-1)", async () => {
  const fk = fakeClack([
    A.text("dweb.example.com"),
    A.select("dual"),             // mode 选择在 forced dry-run 下仍然存在
    A.confirm(true),              // 二元 go
  ]);
  const { calls, impl } = mockRunSetup();
  const r = await runInteractiveSetup({
    cwd: "/proj",
    env: {},                      // 无环境 token：forceDryRun 下不得询问
    forceDryRun: true,
    clack: fk,
    runSetupImpl: impl,
  });
  assert.equal(r.exit, 0);
  assert.equal(fk.calls.password.length, 0, "dry-run must not demand a token");
  assert.match(fk.calls.confirm[0].message, /dry-run\? \(nothing will be pushed\)/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dryRun, true);
  assert.equal(calls[0].skipVerify, true);
  assert.equal(calls[0].token, "dry-run-token");
});

test("runInteractiveSetup: forceDryRun with real runSetup touches neither fetch nor writeFile (P1-1)", async () => {
  const fk = fakeClack([
    A.text("dweb.example.com"),
    A.select("dual"),
    A.confirm(true),
  ]);
  const spies = { fetch: 0, write: 0 };
  const r = await runInteractiveSetup({
    cwd: "/proj",
    env: {},
    forceDryRun: true,
    clack: fk,
    fetchImpl: async () => { spies.fetch += 1; throw new Error("must not be called"); },
    writeFile: async () => { spies.write += 1; },
    exists: () => false,
  });
  assert.equal(r.exit, 0);
  assert.equal(spies.fetch, 0);
  assert.equal(spies.write, 0);
});

test("runInteractiveSetup: pasted token is used when the environment has none", async () => {
  const fk = fakeClack([
    A.password("pasted-token"),
    A.text("dweb.example.com"),
    A.select("dual"),
    A.select("apply"),
  ]);
  const { calls, impl } = mockRunSetup();
  const r = await runInteractiveSetup({
    cwd: "/proj",
    env: {},
    clack: fk,
    runSetupImpl: impl,
  });
  assert.equal(r.exit, 0);
  assert.equal(calls[0].token, "pasted-token");
});

test("runInteractiveSetup: invalid hostname is re-asked until it validates", async () => {
  const fk = fakeClack([
    A.select("env"),
    A.text("bad host"),           // validate 拒绝 -> 库重问
    A.text("localhost"),          // 仍拒（单段）
    A.text("dweb.example.com"),   // 通过
    A.select("dual"),
    A.select("apply"),
  ]);
  const { calls, impl } = mockRunSetup();
  const r = await runInteractiveSetup({
    cwd: "/proj",
    env: { TUNNEL_TOKEN: "t" },
    clack: fk,
    runSetupImpl: impl,
  });
  assert.equal(r.exit, 0);
  assert.equal(calls[0].hostname, "dweb.example.com");
});

test("runInteractiveSetup: failures rethrow for dispatcher normalization (P1-2)", async () => {
  const fk = fakeClack([
    A.select("env"),
    A.text("dweb.example.com"),
    A.select("dual"),
    A.select("apply"),
  ]);
  await assert.rejects(
    () => runInteractiveSetup({
      cwd: "/proj",
      env: { TUNNEL_TOKEN: "t" },
      clack: fk,
      runSetupImpl: async () => {
        throw new Error("boom from cloudflare api");
      },
    }),
    /boom from cloudflare api/,
  );
});

test("runInteractiveSetup: plan preview escapes dynamic paths but keeps layout newlines (R3-P1)", async () => {
  const fk = fakeClack([
    A.select("env"),
    A.text("dweb.example.com"),
    A.select("dual"),
    A.select("apply"),
  ]);
  const { impl } = mockRunSetup();
  const r = await runInteractiveSetup({
    cwd: "/pr\x1boj", // 控制字符进 cwd（targetConfig 的动态源）
    env: { TUNNEL_TOKEN: "t" },
    clack: fk,
    runSetupImpl: impl,
  });
  assert.equal(r.exit, 0);
  const body = fk.calls.note[0].body;
  // 结构换行保留；动态路径中的 ESC 被逐项转义为 \xNN 字面量
  assert.ok(body.includes("\n"), "layout newlines survive");
  assert.ok(body.includes("\\x1b"), "control chars in dynamic values are escaped");
  assert.ok(!body.includes("pr\x1boj"), "raw control char must not reach the note body");
});

test("runInteractiveSetup: verifyProgress drives the spinner; log lines stop it", async () => {
  const spinnerCalls = [];
  const fk = fakeClack([
    A.select("env"),
    A.text("dweb.example.com"),
    A.select("dual"),
    A.select("apply"),
  ]);
  fk.spinner = () => {
    const s = { start: (m) => spinnerCalls.push(["start", m]), stop: () => spinnerCalls.push(["stop"]), message: (m) => spinnerCalls.push(["msg", m]) };
    return s;
  };
  const r = await runInteractiveSetup({
    cwd: "/proj",
    env: { TUNNEL_TOKEN: "t" },
    clack: fk,
    runSetupImpl: async (input) => {
      input.verifyProgress({ elapsedMs: 1000, lastError: "HTTP 526" });
      input.verifyProgress({ elapsedMs: 6000, lastError: "HTTP 526" });
      input.log("dns routed"); // log 行打断 spinner——先 stop 再打印
      return { plan: { publicGatewayUrl: "https://dweb.example.com" } };
    },
  });
  assert.equal(r.exit, 0);
  const kinds = spinnerCalls.map(([k]) => k);
  // start -> msg 更新 -> log 打断时 stop（R3 测试缺口：stop 事件本身可断言）
  assert.equal(kinds.filter((k) => k === "stop").length >= 1, true);
  const firstStopIdx = kinds.indexOf("stop");
  const lastStartIdx = kinds.lastIndexOf("start");
  assert.ok(firstStopIdx > lastStartIdx, "stop must follow the started spinner");
  const msgs = spinnerCalls.filter(([k]) => k !== "stop").map(([, m]) => m);
  assert.match(msgs[0], /verifying via the public gateway\.\.\. 1s/);
  assert.match(msgs[1], /6s/);
});

test("wantsInteractive: explicit flag always; otherwise only TTY without hostname", () => {
  assert.equal(wantsInteractive({ interactive: true, hostname: "x.example.com" }, false), true);
  assert.equal(wantsInteractive({ interactive: true }, false), true);
  assert.equal(wantsInteractive({}, true), true);
  assert.equal(wantsInteractive({}, false), false);
  assert.equal(wantsInteractive({ hostname: "x.example.com" }, true), false);
});
