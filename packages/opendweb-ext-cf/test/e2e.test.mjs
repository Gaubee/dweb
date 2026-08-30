// e2e 级：CLI 面经 opendweb 派发（真实子进程）+ 双消费者同场（cf npm 插件与
// 本地 echo 插件在同一 config 中经 `opendweb setup` 编排）——契约塑形验证。
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

/** 隔离环境：项目目录（cf 与 echo 插件已"安装"）+ DWEB_HOME */
async function env() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cf-e2e-"));
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "cf-home-"));
  await fsp.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "t", private: true }), "utf8");
  await fsp.cp(path.join(REPO, "opendweb/test/fixtures/opendweb-echo"), path.join(dir, "node_modules", "opendweb-echo"), { recursive: true });
  await fsp.mkdir(path.join(dir, "node_modules", "@jixo"), { recursive: true });
  await fsp.cp(path.join(REPO, "opendweb-ext-cf"), path.join(dir, "node_modules", "@jixo", "opendweb-ext-cf"), {
    recursive: true,
  });
  return { dir, home };
}

function runCli(args, { dir, home }) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [CLI, ...args], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, DWEB_HOME: home, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (code) => resolve({ code: code ?? 0, out, err }));
  });
}

test("cf plan/verify dispatch through the real CLI (adaptive resolution finds @jixo/opendweb-ext-cf first)", async () => {
  const e = await env();
  const plan = await runCli(["cf", "plan", "--hostname", "dweb.example.com"], e);
  assert.equal(plan.code, 0, plan.err);
  assert.match(plan.out, /gateway:\s+dweb\.example\.com/);
  assert.match(plan.out, /relay:\s+relay\.dweb\.example\.com/);

  // verify 走真实网络（本测试域名不存在）→ 应失败且错误可读；用超短等待不现实，
  // 故只断言未知主机时 CLI 层正常派发与退出码非零（默认 30s 太长，改用 plan 已证
  // 派发路径；这里验证 --help 零执行）
  const help = await runCli(["cf", "--help"], e);
  assert.equal(help.code, 0);
  assert.match(help.out, /opendweb cf setup \[[^\]]*--hostname <string>[^\]]*\]/);
  assert.match(help.out, /wire a Cloudflare Tunnel/);
});

test("cf setup --dry-run: no network side effects, prints planned actions", async () => {
  const e = await env();
  const r = await runCli(
    ["cf", "setup", "--hostname", "dweb.example.com", "--dry-run"],
    e,
  );
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /dry-run: would PUT ingress config/);
  assert.match(r.out, /relay\.dweb\.example\.com/);
  assert.match(r.out, /would route DNS/);
  // dry-run 不写文件
  assert.equal(await fsp.stat(path.join(e.dir, "opendweb.config.toml")).then(() => true).catch(() => false), false);
});

test("dual consumer: opendweb setup runs cf (dry-run) and local echo from one config", async () => {
  const e = await env();
  const cfg = `
configVersion = 1

[server]
publicGatewayUrl = "https://dweb.example.com"

[[plugins]]
name = "cf"
[plugins.options]
dryRun = true

[[plugins]]
file = ${JSON.stringify(path.join(REPO, "opendweb/test/fixtures/local-echo.mjs"))}
`;
  await fsp.writeFile(path.join(e.dir, "opendweb.config.toml"), cfg, "utf8");
  const r = await runCli(["setup"], e);
  assert.equal(r.code, 0, `stderr: ${r.err}\nstdout: ${r.out}`);
  assert.match(r.out, /setup ok: cf/);
  assert.match(r.out, /setup ok: local-echo/);
});

test("cf setup --interactive: piped stdin drives the full wizard (dry-run, zero network)", async () => {
  const e = await env();
  const child = spawn(NODE, [CLI, "cf", "setup", "--interactive"], {
    cwd: e.dir,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DWEB_HOME: e.home, NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  // 管道预置全部应答：粘贴 token（遮蔽）→ hostname → dual → dry-run
  child.stdin.write("piped-token\n");
  child.stdin.write("dweb.example.com\n");
  child.stdin.write("1\n");
  child.stdin.write("d\n");
  child.stdin.end();
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  // P1-3：有界等待——挂起时 kill 子进程并带已采集输出失败（不留僵尸门禁）
  const code = await Promise.race([
    new Promise((resolve) => child.on("exit", (c) => resolve(c ?? 0))),
    new Promise((resolve) => setTimeout(() => {
      child.kill("SIGKILL");
      resolve("timeout");
    }, 30000)),
  ]);
  assert.notEqual(code, "timeout", `wizard hung; stdout so far: ${out}\nstderr: ${err}`);
  assert.equal(code, 0, `stderr: ${err}\nstdout: ${out}`);
  assert.match(out, /interactive wizard/);
  assert.match(out, /plan:/);
  assert.match(out, /gateway\s+dweb\.example\.com/);
  assert.match(out, /dry-run: would PUT ingress config/);
  assert.match(out, /setup ok \(dry-run\)/);
  // 遮蔽：管道模式无回显，粘贴的 token 不得出现在输出
  assert.ok(!out.includes("piped-token"), "token must not be echoed");
  // dry-run 零副作用：不写配置文件
  assert.equal(await fsp.stat(path.join(e.dir, "opendweb.config.toml")).then(() => true).catch(() => false), false);
});

test("cf setup --interactive --dry-run: y still runs dry-run only; unicode cwd stays ASCII (P1-1/P1-2)", async () => {
  const e = await env();
  // Unicode 目录名：计划预览里的 config 路径必须以 \xNN 转义出现（D10 纪律）
  const weird = path.join(e.dir, "gr\u00fc\u2713");
  await fsp.mkdir(weird, { recursive: true });
  await fsp.writeFile(path.join(weird, "package.json"), JSON.stringify({ name: "t", private: true }), "utf8");
  const child = spawn(NODE, [CLI, "cf", "setup", "--interactive", "--dry-run"], {
    cwd: weird,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DWEB_HOME: e.home, NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  // forceDryRun：不问 token；hostname -> mode -> 二元确认 y（即便输 y 也是 dry）
  child.stdin.write("dweb.example.com\n");
  child.stdin.write("1\n");
  child.stdin.write("y\n");
  child.stdin.end();
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const code = await Promise.race([
    new Promise((resolve) => child.on("exit", (c) => resolve(c ?? 0))),
    new Promise((resolve) => setTimeout(() => {
      child.kill("SIGKILL");
      resolve("timeout");
    }, 30000)),
  ]);
  assert.notEqual(code, "timeout", `wizard hung; stdout so far: ${out}`);
  assert.equal(code, 0, `stderr: ${err}\nstdout: ${out}`);
  assert.match(out, /dry-run\? \(nothing will be pushed\)/);
  assert.match(out, /dry-run: would PUT ingress config/);
  assert.match(out, /setup ok \(dry-run\)/);
  // 非 token 问题不得出现（forceDryRun 跳过收集）
  assert.ok(!out.includes("paste the tunnel token"));
  // ASCII 纪律：stdout 全 ASCII，Unicode 目录以 \xNN 转义出现
  assert.match(out, /^[\x00-\x7F]*$/, "stdout must be all-ASCII");
  assert.ok(out.includes("\\xc3\\xbc"), "unicode dir bytes (UTF-8) must be escaped visibly");
});

test("cf setup without a terminal and without --hostname fails with wizard guidance", async () => {
  const e = await env();
  const r = await runCli(["cf", "setup"], e); // 测试子进程 stdin 非 TTY
  assert.notEqual(r.code, 0);
  assert.match(r.err, /--hostname is required/);
  assert.match(r.err, /--interactive/);
});

test("cf setup --interactive: TOML config prefills tokenEnv/hostname/mode (flag > config > default)", async () => {
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
  const child = spawn(NODE, [CLI, "cf", "setup", "--interactive"], {
    cwd: e.dir,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DWEB_HOME: e.home, NO_COLOR: "1", CUSTOM_TOK_ENV: "tok" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  // 全部回车取预填：token 用 env -> hostname 取 config 推导 -> mode=single -> dry
  child.stdin.write("\n");
  child.stdin.write("\n");
  child.stdin.write("\n");
  child.stdin.write("d\n");
  child.stdin.end();
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const code = await Promise.race([
    new Promise((resolve) => child.on("exit", (c) => resolve(c ?? 0))),
    new Promise((resolve) => setTimeout(() => { child.kill("SIGKILL"); resolve("timeout"); }, 30000)),
  ]);
  assert.notEqual(code, "timeout", `wizard hung; stdout so far: ${out}`);
  assert.equal(code, 0, `stderr: ${err}\nstdout: ${out}`);
  assert.match(out, /detected CUSTOM_TOK_ENV in the environment/); // tokenEnv 预填
  assert.match(out, /gateway\s+cfg\.example\.com/); // hostname 从 server.publicGatewayUrl 预填
  assert.match(out, /single-domain path routing/); // mode=single 预填
  assert.match(out, /\^\/relay\.\*/); // single 的 ingress 规则（dry-run 输出）
});

test("cf setup --interactive: JSON config prefill loses to explicit flags", async () => {
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
  const child = spawn(NODE, [CLI, "cf", "setup", "--interactive", "--hostname", "flag.example.com", "--mode", "dual", "--token-env", "TUNNEL_TOKEN"], {
    cwd: e.dir,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DWEB_HOME: e.home, NO_COLOR: "1", TUNNEL_TOKEN: "tok" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.write("\n"); // token 用 TUNNEL_TOKEN（flag 覆盖 JSON_TOK_ENV）
  child.stdin.write("\n"); // hostname 取 flag 值（覆盖 json 推导）
  child.stdin.write("\n"); // mode=dual（flag 覆盖 config single）
  child.stdin.write("d\n");
  child.stdin.end();
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const code = await Promise.race([
    new Promise((resolve) => child.on("exit", (c) => resolve(c ?? 0))),
    new Promise((resolve) => setTimeout(() => { child.kill("SIGKILL"); resolve("timeout"); }, 30000)),
  ]);
  assert.notEqual(code, "timeout", `wizard hung; stdout so far: ${out}`);
  assert.equal(code, 0, `stderr: ${err}\nstdout: ${out}`);
  assert.match(out, /detected TUNNEL_TOKEN in the environment/);
  assert.ok(!out.includes("JSON_TOK_ENV"), "flag token-env must beat config");
  assert.match(out, /gateway\s+flag\.example\.com/);
  assert.match(out, /relay\s+relay\.flag\.example\.com/); // dual 生效（config 的 single 被覆盖）
});

test("cf setup --help: wizard flag is part of the zero-exec usage", async () => {
  const e = await env();
  const help = await runCli(["cf", "setup", "--help"], e);
  assert.equal(help.code, 0, help.err);
  assert.match(help.out, /--interactive/);
});

test("cf status: read-only dispatch through the real CLI (spec scenario)", async () => {
  const e = await env();
  // 无配置：状态未知也是正常退出（status 是盘点，不是断言）
  const bare = await runCli(["cf", "status"], e);
  assert.equal(bare.code, 0, bare.err);
  assert.match(bare.out, /config:\s+not found/);
  assert.match(bare.out, /plan:\s+unknown/);

  // 配置 + 锁定记录齐备：plan 从 server.publicGatewayUrl 推导，各段齐全
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
    ].join("\n") + "\n",
    "utf8",
  );
  await fsp.writeFile(
    path.join(e.home, "plugins.json"),
    JSON.stringify({ cf: { package: "@jixo/opendweb-ext-cf", version: "0.0.0" } }),
    "utf8",
  );
  const done = await runCli(["cf", "status"], e);
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, /config:\s+opendweb\.config\.toml/);
  assert.match(done.out, /gateway:\s+dweb\.example\.com \(https:\/\/dweb\.example\.com\)/);
  assert.match(done.out, /relay:\s+relay\.dweb\.example\.com/);
  assert.match(done.out, /plugin:\s+cf declared in the config/);
  assert.match(done.out, /lock:\s+cf @jixo\/opendweb-ext-cf@0\.0\.0/);
});

test("dual consumer: failing local plugin aggregates non-zero while cf stays ok", async () => {
  const e = await env();
  const cfg = `
configVersion = 1

[[plugins]]
name = "cf"
[plugins.options]
dryRun = true
hostname = "dweb.example.com"

[[plugins]]
file = ${JSON.stringify(path.join(REPO, "opendweb/test/fixtures/local-echo.mjs"))}
[plugins.options]
fail = true
`;
  await fsp.writeFile(path.join(e.dir, "opendweb.config.toml"), cfg, "utf8");
  const r = await runCli(["setup"], e);
  assert.notEqual(r.code, 0, `stderr: ${r.err}`);
  assert.match(r.out, /setup ok: cf/, `stderr: ${r.err}`);
  assert.match(r.err, /error\[plugin\/local-echo\]: setup failed as requested/);
});
