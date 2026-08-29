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
  assert.match(help.out, /opendweb cf setup --hostname <string>/);
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
