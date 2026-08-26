// 双进程 E2E：init → invite → join → chat 互发消息 → revoke 拒绝
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startServer } from "@jixo/opendweb-server-binary";

const NODE = process.execPath;
const CLI = path.resolve(new URL("../src/cli.mjs", import.meta.url).pathname);

function tmpdir(p) {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}

/** @param {string} dataDir @param {string[]} args @param {{input?: string, timeoutMs?: number}} [opts] */
/** @type {any} */
let relay = null;

function runCli(dataDir, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (relay) {
      env.DWEB_RELAY = "custom";
      env.DWEB_RELAY_URLS = relay.relayHttpUrl;
    }
    const child = spawn(NODE, [CLI, ...args, "--data", dataDir], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timeout: ${args.join(" ")}\nout=${out}\nerr=${err}`));
    }, opts.timeoutMs ?? 20000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`exit ${code}: ${args.join(" ")}\nout=${out}\nerr=${err}`));
    });
    if (opts.input) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

/** @param {string} dataDir */
function chatProc(dataDir) {
  const env = { ...process.env };
  if (relay) {
    env.DWEB_RELAY = "custom";
    env.DWEB_RELAY_URLS = relay.relayHttpUrl;
  }
  const child = spawn(NODE, [CLI, "chat", "--data", dataDir], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  let buf = "";
  let errText = "";
  /** @type {(() => void)[]} */
  const pending = [];
  child.stdout.on("data", (d) => {
    buf += d;
    const waiters = pending.splice(0);
    waiters.forEach((w) => w());
  });
  child.stderr.on("data", (d) => (errText += d));
  return {
    child,
    waitFor(text, ms = 15000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`waitFor "${text}" timeout; got:\n${buf}\nerr:\n${errText}`)),
          ms,
        );
        const check = () => {
          if (buf.includes(text)) {
            clearTimeout(timer);
            resolve(buf);
          } else {
            pending.push(check);
          }
        };
        check();
      });
    },
    send(line) {
      child.stdin.write(line + "\n");
    },
    async kill() {
      child.kill("SIGINT");
      await new Promise((r) => child.once("exit", r));
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    },
  };
}

test(
  "two-process invite/join/chat/revoke",
  async () => {
    // 自托管 relay：进程重启后地址仍稳定（invite 内嵌 relay URL）
    relay = await startServer({
      httpBind: "127.0.0.1:18997",
      relayBind: "127.0.0.1:18998",
    });
    const dirA = tmpdir("dweb-ex-a-");
    const dirB = tmpdir("dweb-ex-b-");

    await runCli(dirA, ["init"]);
    const idA = (await runCli(dirA, ["id"])).trim();
    assert.match(idA, /^[a-z0-9]{52}$/);

    const token = (await runCli(dirA, ["invite"])).trim();
    assert.ok(token.startsWith("dweb1."));

    // issuer 必须在线：A 先进 chat 常驻，B 再兑换
    const chatA = chatProc(dirA);
    await chatA.waitFor("chat ready");
    await runCli(dirB, ["join", token], { timeoutMs: 30000 });
    const membersOut = await runCli(dirB, ["members"]);
    assert.match(membersOut, /2 member/);
    assert.match(membersOut, new RegExp(idA.slice(0, 8)));

    const chatB = chatProc(dirB);
    await chatB.waitFor("chat ready");
    await chatA.waitFor("connected");
    await chatB.waitFor("connected");

    chatB.send("hello-from-B");
    await chatA.waitFor("hello-from-B");
    chatA.send("hi-from-A");
    await chatB.waitFor("hi-from-A");

    const idB = (await runCli(dirB, ["id"])).trim();
    await chatA.kill();
    await chatB.kill();

    // A 撤销 B，随后 B 发送必须失败
    await runCli(dirA, ["revoke", idB]);
    await assert.rejects(() => runCli(dirB, ["send", idA, "should-fail"]));
    await relay.stop();
  },
  120000,
);
