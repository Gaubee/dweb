// Two-process E2E: init -> invite -> join -> chat exchange -> revoke.
//
// Transition notes (connectivity-ux-hardening, Batch E):
//  - Every CLI invocation now runs the bootstrap state machine: the relay URL
//    gets one GET /services.json probe. Against the 0.1.0 server binary the
//    iroh relay answers 404 on unknown paths, so the URL is classified as a
//    legacy bare relay and networking behavior is unchanged.
//  - The local 0.1.0 SDK binary lacks relayStatus()/relay-* events and the
//    invite() options argument; cli.mjs feature-detects them, so this e2e
//    keeps running on the old binary. Real coverage of the new SDK surface
//    (relay status snapshot, join 8-code paths, invite gate) is ZCode 4.1
//    integration territory, not this file.
//  - Spawned CLIs get an isolated HOME so they never touch the developer's
//    real ~/.opendweb/config.json.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "@jixo/opendweb-server-binary";

const NODE = process.execPath;
const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

// Isolated HOME for every spawned CLI (config file must not leak between
// tests or into the developer's real ~/.opendweb).
const E2E_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dweb-e2e-home-"));

function tmpdir(p) {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}

/** Grab a random free TCP port (e2e discipline: no fixed ports). */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = /** @type {net.AddressInfo} */ (srv.address());
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function cliEnv() {
  // keep PATH etc, drop inherited DWEB_*/proxy variables for determinism
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(DWEB_|.*_proxy|.*_PROXY)$/.test(k)),
  );
  env.HOME = E2E_HOME;
  return env;
}

/** @type {any} */
let relay = null;

function runCli(dataDir, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const env = cliEnv();
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
    }, opts.timeoutMs ?? 30000);
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
  const env = cliEnv();
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
    // Self-hosted relay on random free ports: address stays stable across
    // process restarts (invite embeds the relay URL).
    const httpPort = await freePort();
    const relayPort = await freePort();
    relay = await startServer({
      httpBind: `127.0.0.1:${httpPort}`,
      relayBind: `127.0.0.1:${relayPort}`,
    });
    const dirA = tmpdir("dweb-ex-a-");
    const dirB = tmpdir("dweb-ex-b-");

    await runCli(dirA, ["init"]);
    const idA = (await runCli(dirA, ["id"])).trim();
    assert.match(idA, /^[a-z0-9]{52}$/);

    const token = (await runCli(dirA, ["invite"])).trim();
    assert.ok(token.startsWith("dweb1."));

    // The issuer must stay online: A enters chat first, then B redeems.
    const chatA = chatProc(dirA);
    await chatA.waitFor("chat ready");
    await runCli(dirB, ["join", token], { timeoutMs: 40000 });
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

    // A revokes B; B's next send must fail
    await runCli(dirA, ["revoke", idB]);
    await assert.rejects(() => runCli(dirB, ["send", idA, "should-fail"]));
    await relay.stop();
  },
  180000,
);
