// TUI 引导单测：输入组件（默认值/遮蔽/选择/三态确认）与 runInteractiveSetup
// 编排（预览/确认/中止/dry-run/无效 hostname 重问），streams 全注入。
// 应答行在调用前写入管道（PassThrough 缓冲，readline 顺序消费）。
import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { createPrompts, runInteractiveSetup } from "../src/tui.mjs";
import { wantsInteractive } from "../src/cli.js";

/** 造一对管道流；feed() 把预置应答行全部写入（调用被测函数前执行） */
function scriptedIO(lines) {
  const input = new PassThrough();
  const output = new PassThrough();
  let chunks = "";
  output.on("data", (d) => (chunks += d));
  return { input, output, text: () => chunks, feed: () => { for (const line of lines) input.write(`${line}\n`); } };
}

test("prompts: ask uses the default on empty input, returns typed value otherwise", async () => {
  const io = scriptedIO(["", "typed.example.com"]);
  io.feed();
  const ui = createPrompts(io);
  assert.equal(await ui.ask("gateway hostname", { default: "dweb.example.com" }), "dweb.example.com");
  assert.equal(await ui.ask("gateway hostname", { default: "dweb.example.com" }), "typed.example.com");
  ui.close();
});

test("prompts: askSecret masks the echoed input", async () => {
  const io = scriptedIO(["sekret-token-value"]);
  io.feed();
  const ui = createPrompts(io);
  const value = await ui.askSecret("tunnel token");
  assert.equal(value, "sekret-token-value");
  const text = io.text();
  assert.ok(!text.includes("sekret-token-value"), "secret must not be echoed");
  assert.ok(text.includes("input hidden"));
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

test("runInteractiveSetup: runSetup failure exits 1 with the error surfaced", async () => {
  const io = scriptedIO(["", "dweb.example.com", "1", "y"]);
  io.feed();
  const r = await runInteractiveSetup({
    cwd: "/proj",
    env: { TUNNEL_TOKEN: "t" },
    stdin: io.input,
    stdout: io.output,
    runSetupImpl: async () => {
      throw new Error("boom from cloudflare api");
    },
  });
  assert.equal(r.exit, 1);
  assert.match(io.text(), /failed: boom from cloudflare api/);
});

test("wantsInteractive: explicit flag always; otherwise only TTY without hostname", () => {
  assert.equal(wantsInteractive({ interactive: true, hostname: "x.example.com" }, false), true);
  assert.equal(wantsInteractive({ interactive: true }, false), true);
  assert.equal(wantsInteractive({}, true), true);
  assert.equal(wantsInteractive({}, false), false);
  assert.equal(wantsInteractive({ hostname: "x.example.com" }, true), false);
});
