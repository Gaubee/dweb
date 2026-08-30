// TUI 引导单测（2026-08-30 Owner 需求）：输入组件（默认值/遮蔽/选择/确认）
// 与 runInteractiveSetup 编排（预览/确认/中止/dry-run/forceDryRun/无效
// hostname 重问/失败 rethrow/ASCII 纪律），streams 全注入。应答行在调用前
// 写入管道（PassThrough 缓冲，行队列 backlog 顺序消费——这正是被测语义）。
import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { createPrompts, asciiEscape } from "../src/prompts.mjs";
import { runInteractiveSetup } from "../src/tui.mjs";
import { wantsInteractive } from "../src/cli.js";

/** 造一对管道流；feed() 把预置应答行全部写入（调用被测函数前执行） */
function scriptedIO(lines) {
  const input = new PassThrough();
  const output = new PassThrough();
  let chunks = "";
  output.on("data", (d) => (chunks += d));
  return {
    input,
    output,
    text: () => chunks,
    feed: () => { for (const line of lines) input.write(`${line}\n`); },
  };
}

test("prompts: ask uses the default on empty input, returns typed value otherwise", async () => {
  const io = scriptedIO(["", "typed.example.com"]);
  io.feed();
  const ui = createPrompts(io);
  assert.equal(await ui.ask("gateway hostname", { default: "dweb.example.com" }), "dweb.example.com");
  assert.equal(await ui.ask("gateway hostname", { default: "dweb.example.com" }), "typed.example.com");
  ui.close();
});

test("prompts: askSecret masks the echoed input and restores _writeToOutput precisely", async () => {
  const io = scriptedIO(["sekret-token-value"]);
  io.feed();
  const ui = createPrompts(io);
  const value = await ui.askSecret("tunnel token");
  assert.equal(value, "sekret-token-value");
  const text = io.text();
  assert.ok(!text.includes("sekret-token-value"), "secret must not be echoed");
  assert.ok(text.includes("input hidden"));
  // P2：遮蔽用 _writeToOutput 是原型方法——finally 后不得留下 own 属性
  assert.equal(Object.hasOwn(ui.rl, "_writeToOutput"), false);
  ui.close();
});

test("prompts: select honors default and validates invalid choices", async () => {
  const io = scriptedIO(["9", "2"]);
  io.feed();
  const ui = createPrompts(io);
  const picked = await ui.select("routing mode", [
    { value: "dual", label: "dual", default: true },
    { value: "single", label: "single" },
  ]);
  assert.equal(picked, "single");
  assert.ok(io.text().includes("enter a number between 1 and 2"));
  ui.close();
});

test("prompts: select falls back to the default on empty input", async () => {
  const io = scriptedIO([""]);
  io.feed();
  const ui = createPrompts(io);
  assert.equal(
    await ui.select("routing mode", [
      { value: "dual", label: "dual", default: true },
      { value: "single", label: "single" },
    ]),
    "dual",
  );
  ui.close();
});

test("prompts: confirm3 maps y/d/n, the default, and re-asks on junk", async () => {
  const io = scriptedIO(["y", "d", "n", "", "x", "yes"]);
  io.feed();
  const ui = createPrompts(io);
  assert.equal(await ui.confirm3("apply this plan?"), "apply");
  assert.equal(await ui.confirm3("apply this plan?"), "dry");
  assert.equal(await ui.confirm3("apply this plan?"), "no");
  assert.equal(await ui.confirm3("apply this plan?", "no"), "no");
  assert.equal(await ui.confirm3("apply this plan?"), "apply");
  assert.ok(io.text().includes("answer y, d or n"));
  ui.close();
});

test("prompts: binary confirm maps y/n, the default, and re-asks on junk", async () => {
  const io = scriptedIO(["y", "n", "", "x", "yes", "no"]);
  io.feed();
  const ui = createPrompts(io);
  assert.equal(await ui.confirm("run it?"), true);
  assert.equal(await ui.confirm("run it?"), false);
  assert.equal(await ui.confirm("run it?", false), false);
  assert.equal(await ui.confirm("run it?"), true); // x -> 重问 -> yes
  assert.equal(await ui.confirm("run it?", false), false); // no
  assert.ok(io.text().includes("answer y or n"));
  ui.close();
});

test("prompts: EOF drains the backlog first, then rejects the next question (P1-3)", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.on("data", () => {});
  input.write("first\n");
  input.end(); // EOF：backlog 里的行仍可消费；之后的提问必须拒绝而非挂死
  const ui = createPrompts({ input, output });
  assert.equal(await ui.ask("q1"), "first");
  await assert.rejects(() => ui.ask("q2"), /input closed before an answer/);
  ui.close();
});

test("asciiEscape: non-ASCII bytes become \\xNN escapes (writer discipline anchor)", () => {
  assert.equal(asciiEscape("ok"), "ok");
  assert.equal(asciiEscape("bad\u2713host"), "bad\\xe2\\x9c\\x93host");
  assert.equal(asciiEscape("line\nbreak"), "line\\x0abreak");
});

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

test("runInteractiveSetup: collect -> preview -> apply; runSetup receives resolved inputs", async () => {
  const io = scriptedIO(["", "dweb.example.com", "1", "y"]); // env token 默认 / hostname / dual / apply
  io.feed();
  const { calls, impl } = mockRunSetup();
  const r = await runInteractiveSetup({
    cwd: "/proj",
    env: { TUNNEL_TOKEN: "env-token" },
    stdin: io.input,
    stdout: io.output,
    runSetupImpl: impl,
  });
  assert.equal(r.exit, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].token, "env-token");
  assert.equal(calls[0].hostname, "dweb.example.com");
  assert.equal(calls[0].mode, "dual");
  assert.equal(calls[0].dryRun, false);
  const text = io.text();
  assert.match(text, /plan:/);
  assert.match(text, /gateway\s+dweb\.example\.com/);
  assert.match(text, /this will:/);
  assert.match(text, /setup ok \(applied\)/);
  assert.match(text, /config set relay https:\/\/dweb\.example\.com/);
});

test("runInteractiveSetup: empty hostname falls back to the suggested value", async () => {
  const io = scriptedIO(["", "", "1", "y"]);
  io.feed();
  const { calls, impl } = mockRunSetup();
  const r = await runInteractiveSetup({
    cwd: "/proj",
    env: { TUNNEL_TOKEN: "t" },
    suggestedHostname: "suggested.example.com",
    stdin: io.input,
    stdout: io.output,
    runSetupImpl: impl,
  });
  assert.equal(r.exit, 0);
  assert.equal(calls[0].hostname, "suggested.example.com");
});

test("runInteractiveSetup: abort keeps exit 0 and never runs setup", async () => {
  const io = scriptedIO(["", "dweb.example.com", "1", "n"]);
  io.feed();
  const { calls, impl } = mockRunSetup();
  const r = await runInteractiveSetup({
    cwd: "/proj",
    env: { TUNNEL_TOKEN: "t" },
    stdin: io.input,
    stdout: io.output,
    runSetupImpl: impl,
  });
  assert.equal(r.exit, 0);
  assert.equal(calls.length, 0);
  assert.match(io.text(), /aborted; nothing was changed/);
});

test("runInteractiveSetup: d runs the same flow as dry-run (zero side effects)", async () => {
  const io = scriptedIO(["", "dweb.example.com", "2", "d"]); // single + dry
  io.feed();
  const { calls, impl } = mockRunSetup();
  const r = await runInteractiveSetup({
    cwd: "/proj",
    env: { TUNNEL_TOKEN: "t" },
    stdin: io.input,
    stdout: io.output,
    runSetupImpl: impl,
  });
  assert.equal(r.exit, 0);
  assert.equal(calls[0].dryRun, true);
  assert.equal(calls[0].mode, "single");
  assert.match(io.text(), /setup ok \(dry-run\)/);
  assert.match(io.text(), /rehearsal/);
});

test("runInteractiveSetup: forceDryRun skips token collection and cannot become apply (P1-1)", async () => {
  const io = scriptedIO(["dweb.example.com", "1", "y"]); // 无 token 问题；mode；二元确认 y
  io.feed();
  const { calls, impl } = mockRunSetup();
  const r = await runInteractiveSetup({
    cwd: "/proj",
    env: {}, // 无环境 token：forceDryRun 下不得询问
    forceDryRun: true,
    stdin: io.input,
    stdout: io.output,
    runSetupImpl: impl,
  });
  assert.equal(r.exit, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dryRun, true);
  assert.equal(calls[0].skipVerify, true);
  assert.equal(calls[0].token, "dry-run-token");
  const text = io.text();
  assert.ok(!text.includes("paste the tunnel token"), "dry-run must not demand a token");
  assert.match(text, /dry-run\? \(nothing will be pushed\)/);
});

test("runInteractiveSetup: forceDryRun with real runSetup touches neither fetch nor writeFile (P1-1)", async () => {
  const io = scriptedIO(["dweb.example.com", "1", "y"]);
  io.feed();
  const spies = { fetch: 0, write: 0 };
  const r = await runInteractiveSetup({
    cwd: "/proj",
    env: {},
    forceDryRun: true,
    stdin: io.input,
    stdout: io.output,
    fetchImpl: async () => { spies.fetch += 1; throw new Error("must not be called"); },
    writeFile: async () => { spies.write += 1; },
    exists: () => false,
  });
  assert.equal(r.exit, 0);
  assert.equal(spies.fetch, 0);
  assert.equal(spies.write, 0);
});

test("runInteractiveSetup: pasted token is used when the environment has none", async () => {
  const io = scriptedIO(["pasted-token", "dweb.example.com", "1", "y"]);
  io.feed();
  const { calls, impl } = mockRunSetup();
  const r = await runInteractiveSetup({
    cwd: "/proj",
    env: {},
    stdin: io.input,
    stdout: io.output,
    runSetupImpl: impl,
  });
  assert.equal(r.exit, 0);
  assert.equal(calls[0].token, "pasted-token");
  assert.ok(!io.text().includes("pasted-token"), "pasted token must stay masked");
});

test("runInteractiveSetup: invalid hostname is re-asked until it validates", async () => {
  const io = scriptedIO(["", "bad host", "localhost", "dweb.example.com", "1", "y"]);
  io.feed();
  const { calls, impl } = mockRunSetup();
  const r = await runInteractiveSetup({
    cwd: "/proj",
    env: { TUNNEL_TOKEN: "t" },
    stdin: io.input,
    stdout: io.output,
    runSetupImpl: impl,
  });
  assert.equal(r.exit, 0);
  assert.equal(calls[0].hostname, "dweb.example.com");
  const text = io.text();
  assert.match(text, /invalid hostname/);
  assert.equal((text.match(/gateway hostname/g) ?? []).length, 3);
});

test("runInteractiveSetup: non-ASCII dynamic values are escaped in the output (P1-2)", async () => {
  const io = scriptedIO(["", "bad\u2713host", "dweb.example.com", "1", "y"]);
  io.feed();
  const { impl } = mockRunSetup();
  const r = await runInteractiveSetup({
    cwd: "/proj",
    env: { TUNNEL_TOKEN: "t" },
    stdin: io.input,
    stdout: io.output,
    runSetupImpl: impl,
  });
  assert.equal(r.exit, 0);
  const text = io.text();
  // 校验错误消息回显里的 \u2713 必须以 \xe2\x9c\x93 转义出现，不得有裸字节
  assert.ok(text.includes("\\xe2\\x9c\\x93"), "non-ASCII must be \\xNN-escaped");
  assert.ok(!text.includes("\u2713"), "raw non-ASCII must never reach the output");
});

test("runInteractiveSetup: failures rethrow for dispatcher normalization (P1-2)", async () => {
  const io = scriptedIO(["", "dweb.example.com", "1", "y"]);
  io.feed();
  await assert.rejects(
    () => runInteractiveSetup({
      cwd: "/proj",
      env: { TUNNEL_TOKEN: "t" },
      stdin: io.input,
      stdout: io.output,
      runSetupImpl: async () => {
        throw new Error("boom from cloudflare api");
      },
    }),
    /boom from cloudflare api/,
  );
});

test("wantsInteractive: explicit flag always; otherwise only TTY without hostname", () => {
  assert.equal(wantsInteractive({ interactive: true, hostname: "x.example.com" }, false), true);
  assert.equal(wantsInteractive({ interactive: true }, false), true);
  assert.equal(wantsInteractive({}, true), true);
  assert.equal(wantsInteractive({}, false), false);
  assert.equal(wantsInteractive({ hostname: "x.example.com" }, true), false);
});
