// e2e 级：CLI 面经真实 opendweb 子进程派发（零网络：auth 缺失路径 + forceDryRun
// 向导 + 只读命令）。交互式用例经 driveWizard 应答式驱动真实 @clack（char-by-char）；
// 有凭据的 zone/tunnel 步骤会打到真实 Cloudflare API，故交互 e2e 一律 --dry-run
//（forceDryRun：不收集凭据，host/mode 后在「dry-run complete」收尾——本套件
// 锁定的正是该契约；凭据后的完整流程由 tui 单测的注入 gateway 覆盖）。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const CLI = path.join(REPO, "opendweb/bin/opendweb.mjs");
const NODE = process.execPath;

/** 隔离环境：项目目录（cf 插件已"安装"）+ DWEB_HOME */
async function env() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cf-e2e-"));
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "cf-home-"));
  await fsp.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "t", private: true }), "utf8");
  await fsp.mkdir(path.join(dir, "node_modules", "@jixo"), { recursive: true });
  await fsp.cp(path.join(REPO, "opendweb-ext-cf"), path.join(dir, "node_modules", "@jixo", "opendweb-ext-cf"), {
    recursive: true,
  });
  return { dir, home };
}

/**
 * 应答式驱动 @clack 向导：每步等到上一问渲染出 expect 再发送 send。
 * @clack 在 prompt 切换窗口内到达的 keypress 会被丢弃（无 readline 行缓冲），
 * 预置全量输入会卡死——按提示节奏发送是可靠形态。
 * @param {import("node:child_process").ChildProcess} child
 * @param {{ expect: RegExp, send: string }[]} steps
 * @param {() => string} outSoFar
 */
async function driveWizard(child, steps, outSoFar) {
  for (const step of steps) {
    const deadline = Date.now() + 30000; // 冷启动（SMB 卷/页缓存空）时首 prompt 渲染可超 15s
    while (!step.expect.test(outSoFar())) {
      if (Date.now() > deadline) throw new Error(`wizard step not rendered: ${step.expect}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    // prompt 建立窗口（上一应答提交 -> 下一个 prompt 挂起）内整串写入会丢
    // 首字符（@clack 已知行为）：稍候后逐字符慢发，保证 keypress 逐个入列
    await new Promise((r) => setTimeout(r, 150));
    for (const ch of step.send) {
      child.stdin.write(ch);
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  child.stdin.end();
}

/**
 * 有界等待子进程退出（超时 kill 并报 timeout，不留僵尸门禁）。
 * @returns {Promise<number | "timeout">}
 */
function exitWithDeadline(child, ms = 30000) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve("timeout");
    }, ms);
    timer.unref();
  });
  return Promise.race([
    new Promise((resolve) => child.on("exit", (c) => {
      clearTimeout(timer);
      resolve(c ?? 0);
    })),
    timeout,
  ]);
}

function runCli(args, { dir, home }, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [CLI, ...args], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, DWEB_HOME: home, NO_COLOR: "1", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (code) => resolve({ code: code ?? 0, out, err }));
  });
}

/** 交互式向导子进程（stdin 管道驱动） */
function spawnWizard(args, { dir, home }, extraEnv = {}) {
  const child = spawn(NODE, [CLI, ...args], {
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DWEB_HOME: home, NO_COLOR: "1", ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  return { child, out: () => out, err: () => err };
}

async function driveAndCollect(spawned, steps) {
  const driven = driveWizard(spawned.child, steps, spawned.out);
  const first = await Promise.race([exitWithDeadline(spawned.child), driven.then(() => "driven")]);
  assert.notEqual(first, "timeout", `wizard hung; stdout so far: ${spawned.out()}\nstderr: ${spawned.err()}`);
  const code = await exitWithDeadline(spawned.child);
  return { code, out: spawned.out(), err: spawned.err() };
}

// ---- 零执行 usage / 只读命令 ----

test("cf --help: zero-exec usage lists all six commands", async () => {
  const e = await env();
  const help = await runCli(["cf", "--help"], e);
  assert.equal(help.code, 0, help.err);
  for (const cmd of ["setup", "verify", "plan", "status", "login", "logout"]) {
    assert.match(help.out, new RegExp(`opendweb cf ${cmd}\\b`), `usage line for ${cmd}`);
  }
  assert.match(help.out, /opendweb cf plan --hostname <string>/);
  assert.match(help.out, /--interactive/);
  assert.ok(!help.out.includes("error"), "help is zero-exec (no side effects)");

  const setupHelp = await runCli(["cf", "setup", "--help"], e);
  assert.equal(setupHelp.code, 0, setupHelp.err);
  assert.match(setupHelp.out, /--dry-run/);
  assert.match(setupHelp.out, /--skip-verify/);
});

test("cf plan: offline plan output for both modes", async () => {
  const e = await env();
  const dual = await runCli(["cf", "plan", "--hostname", "dweb.example.com"], e);
  assert.equal(dual.code, 0, dual.err);
  assert.match(dual.out, /mode:\s+dual/);
  assert.match(dual.out, /gateway:\s+dweb\.example\.com \(https:\/\/dweb\.example\.com\)/);
  assert.match(dual.out, /relay:\s+relay\.dweb\.example\.com/);

  const single = await runCli(["cf", "plan", "--hostname", "dweb.example.com", "--mode", "single"], e);
  assert.equal(single.code, 0, single.err);
  assert.match(single.out, /mode:\s+single/);
  assert.match(single.out, /relay:\s+relay\.dweb\.example\.com \(https:\/\/dweb\.example\.com\)/); // single 共主机

  const bad = await runCli(["cf", "plan", "--hostname", "not a host"], e);
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /not a routable DNS hostname/);
});

test("cf status: empty dir is a read-only inventory (exit 0) with auth/tunnel guidance", async () => {
  const e = await env();
  const r = await runCli(["cf", "status"], e);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /config:\s+not found/);
  assert.match(r.out, /plan:\s+unknown/);
  assert.match(r.out, /auth:\s+none \(cf login or CLOUDFLARE_API_TOKEN\)/);
  assert.match(r.out, /tunnel:\s+no resource anchors in the config \(run cf setup\)/);
});

test("cf status: config-derived plan, resource anchors and the saved auth session", async () => {
  const e = await env();
  await fsp.writeFile(
    path.join(e.dir, "opendweb.config.toml"),
    [
      "configVersion = 1",
      "",
      "[server]",
      'publicGatewayUrl = "https://dweb.example.com"',
      "",
      "[[plugins]]",
      'name = "cf"',
      "[plugins.options]",
      'tokenEnv = "TUNNEL_TOKEN"',
      'accountId = "acc1"',
      'zoneId = "zone1"',
      'tunnelId = "tun9"',
    ].join("\n") + "\n",
    "utf8",
  );
  await fsp.writeFile(
    path.join(e.home, "cf-auth.json"),
    JSON.stringify({ refreshToken: "rt", clientId: "cid" }),
    "utf8",
  );
  const r = await runCli(["cf", "status"], e);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /config:\s+opendweb\.config\.toml/);
  assert.match(r.out, /gateway:\s+dweb\.example\.com \(https:\/\/dweb\.example\.com\)/);
  assert.match(r.out, /relay:\s+relay\.dweb\.example\.com/);
  assert.match(r.out, /plugin:\s+cf declared in the config/);
  assert.match(r.out, /auth:\s+browser session saved \(cf login\)/);
  assert.match(r.out, /tunnel:\s+anchor tun9 \(zone zone1\)/);

  // env token 展示：无已存登录态时（stored 优先于 env 展示）
  await fsp.rm(path.join(e.home, "cf-auth.json"), { force: true });
  const withEnv = await runCli(["cf", "status"], e, { CLOUDFLARE_API_TOKEN: "envtok" });
  assert.match(withEnv.out, /auth:\s+CLOUDFLARE_API_TOKEN is set/);
});

// ---- 非交互 setup 的认证门 ----

test("cf setup (non-interactive) without a credential fails through the plugin error channel", async () => {
  const e = await env();
  const r = await runCli(["cf", "setup", "--hostname", "dweb.example.com"], e);
  assert.equal(r.code, 1, `stdout: ${r.out}`);
  assert.match(r.err, /error\[plugin\/cf\]: not authenticated: `opendweb cf login` or set CLOUDFLARE_API_TOKEN/);
});

test("cf setup without a terminal and without --hostname points at the wizard", async () => {
  const e = await env();
  const r = await runCli(["cf", "setup"], e); // 测试子进程 stdin 非 TTY
  assert.equal(r.code, 1);
  assert.match(r.err, /--hostname is required/);
  assert.match(r.err, /--interactive/);
});

// ---- login/logout ----

test("cf login without CF_OAUTH_CLIENT_ID explains the redirect URI and the env knob", async () => {
  const e = await env();
  const r = await runCli(["cf", "login"], e);
  assert.equal(r.code, 1);
  assert.match(r.err, /error\[plugin\/cf\]: browser login is not configured/);
  assert.match(r.err, /http:\/\/127\.0\.0\.1:18971\/callback/);
  assert.match(r.err, /CF_OAUTH_CLIENT_ID/);
});

test("cf logout forgets the session (missing file is fine)", async () => {
  const e = await env();
  await fsp.writeFile(path.join(e.home, "cf-auth.json"), JSON.stringify({ refreshToken: "rt", clientId: "c" }), "utf8");
  const r = await runCli(["cf", "logout"], e);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /session forgotten/);
  assert.equal(await fsp.stat(path.join(e.home, "cf-auth.json")).then(() => true).catch(() => false), false);
});

// ---- 交互式向导（forceDryRun：无凭据、零网络） ----

test("cf setup --interactive --dry-run: overview -> mode -> dry-run confirm -> exit 0, nothing written", async () => {
  const e = await env();
  const spawned = spawnWizard(["cf", "setup", "--interactive", "--dry-run", "--hostname", "dweb.example.com"], e);
  const { code, out, err } = await driveAndCollect(spawned, [
    { expect: /how this works:/, send: "" }, // 概览 note 先渲染（无输入）
    { expect: /routing mode/, send: "\r" }, // 默认高亮 single（无 zone -> 深度保守建议）
    { expect: /dry-run\? \(nothing will be pushed\)/, send: "y" },
  ]);
  assert.equal(code, 0, `stderr: ${err}\nstdout: ${out}`);
  // forceDryRun：绝不出现认证问题
  assert.ok(!out.includes("cloudflare authentication"), "no auth prompt in forced dry-run");
  // hostname 来自 --hostname 预填（无凭据路径不重问）
  assert.match(out, /gateway\s+dweb\.example\.com/);
  assert.match(out, /tunnel\s+find-or-create "opendweb-dweb-example-com"/);
  assert.match(out, /steps:/);
  assert.match(out, /dry-run complete \(no credential collected - nothing was pushed\)/);
  // 零副作用：不写配置文件
  assert.equal(await fsp.stat(path.join(e.dir, "opendweb.config.toml")).then(() => true).catch(() => false), false);
});

test("cf setup --interactive --dry-run: declining the binary confirm aborts with exit 0", async () => {
  const e = await env();
  const spawned = spawnWizard(["cf", "setup", "--interactive", "--dry-run", "--hostname", "dweb.example.com"], e);
  const { code, out } = await driveAndCollect(spawned, [
    { expect: /routing mode/, send: "\r" },
    { expect: /dry-run\? \(nothing will be pushed\)/, send: "n" },
  ]);
  assert.equal(code, 0);
  assert.match(out, /aborted; nothing was changed/);
  assert.equal(await fsp.stat(path.join(e.dir, "opendweb.config.toml")).then(() => true).catch(() => false), false);
});

test("cf setup --interactive --dry-run: TOML config prefills hostname and mode", async () => {
  const e = await env();
  await fsp.writeFile(
    path.join(e.dir, "opendweb.config.toml"),
    [
      "configVersion = 1",
      "",
      "[server]",
      'publicGatewayUrl = "https://cfg.example.com"',
      "",
      "[[plugins]]",
      'name = "cf"',
      "[plugins.options]",
      'tokenEnv = "CUSTOM_TOK_ENV"',
      'mode = "single"',
    ].join("\n") + "\n",
    "utf8",
  );
  const spawned = spawnWizard(["cf", "setup", "--interactive", "--dry-run"], e);
  const { code, out, err } = await driveAndCollect(spawned, [
    { expect: /routing mode/, send: "\r" }, // config mode=single 为初始值
    { expect: /dry-run\? \(nothing will be pushed\)/, send: "y" },
  ]);
  assert.equal(code, 0, `stderr: ${err}\nstdout: ${out}`);
  assert.match(out, /gateway\s+cfg\.example\.com/); // hostname 从 server.publicGatewayUrl 预填
  assert.match(out, /single-domain path routing/); // mode=single 预填
  assert.match(out, /\^\/relay\.\*/); // single 的 ingress 规则
});

test("cf setup --interactive --dry-run: explicit --hostname flag beats the JSON config prefill", async () => {
  const e = await env();
  await fsp.writeFile(
    path.join(e.dir, "opendweb.config.json"),
    JSON.stringify({
      configVersion: 1,
      server: { publicGatewayUrl: "https://json.example.com" },
      plugins: [{ name: "cf", options: { tokenEnv: "JSON_TOK_ENV", mode: "single" } }],
    }),
    "utf8",
  );
  const spawned = spawnWizard(
    ["cf", "setup", "--interactive", "--dry-run", "--hostname", "flag.example.com"],
    e,
  );
  const { code, out, err } = await driveAndCollect(spawned, [
    { expect: /routing mode/, send: "\r" },
    { expect: /dry-run\? \(nothing will be pushed\)/, send: "y" },
  ]);
  assert.equal(code, 0, `stderr: ${err}\nstdout: ${out}`);
  assert.match(out, /gateway\s+flag\.example\.com/); // flag > config
  assert.ok(!out.includes("json.example.com"), "config hostname must not leak into the plan");
  assert.match(out, /single-domain path routing/); // mode 仍取 config（交互路径不接收 --mode flag）
});

// ---- 宿主编排：setup 钩子经真实 CLI 聚合 ----

test("opendweb setup: cf hook without a credential aggregates as error[plugin/cf] exit 1 (offline)", async () => {
  const e = await env();
  const cfg = [
    "configVersion = 1",
    "",
    "[[plugins]]",
    'name = "cf"',
    "[plugins.options]",
    'hostname = "dweb.example.com"',
  ].join("\n") + "\n";
  await fsp.writeFile(path.join(e.dir, "opendweb.config.toml"), cfg, "utf8");
  const r = await runCli(["setup"], e);
  assert.equal(r.code, 1, `stdout: ${r.out}`);
  assert.match(r.err, /error\[plugin\/cf\]: not authenticated with Cloudflare: run `opendweb cf login` \(browser\) or set CLOUDFLARE_API_TOKEN/);
});
