// CLI wiring smoke tests (spawn the real CLI). These do NOT depend on Batch S
// (server /services.json) or Batch F (new SDK APIs): the local 0.1.0 SDK
// binary is feature-detected by the CLI, and relay probing is exercised via
// a closed local port. Real-server/real-SDK e2e belongs to ZCode 4.1.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const NODE = process.execPath;
const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

/**
 * @param {string[]} args
 * @param {{ home?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function run(args, opts = {}) {
  const home = opts.home ?? fs.mkdtempSync(path.join(os.tmpdir(), "dweb-cli-home-"));
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    // strip inherited connectivity env for determinism
    ...(Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !/^(DWEB_|.*_proxy|.*_PROXY)$/.test(k)),
    )),
  };
  // explicit HOME wins over any inherited value
  env.HOME = home;
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"], env });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timeout: ${args.join(" ")}\nout=${out}\nerr=${err}`));
    }, opts.timeoutMs ?? 15000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err });
    });
  });
}

const ASCII_RE = /^[\x00-\x7f]*$/;

test("help prints, exits 0, all ASCII, mentions config", async () => {
  const r = await run([]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /dweb-example -- fabric networking example CLI/);
  assert.match(r.stdout, /config <list\|get\|set\|unset>/);
  assert.match(r.stdout, ASCII_RE);
});

test("unknown option exits 2 with the frozen message and known list", async () => {
  const r = await run(["chat", "--foo", "bar"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^error: unknown option --foo \(known: --data, --relay, --proxy, --join-timeout\)/);
  assert.match(r.stderr, ASCII_RE);
});

test("unknown command exits 2", async () => {
  const r = await run(["frobnicate"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /error: unknown command: frobnicate/);
});

test("invite --ttl out of range exits 1 with range hint (999ms rejected)", async () => {
  for (const bad of ["999ms", "0", "40d", "999999999d"]) {
    const r = await run(["invite", "--ttl", bad]);
    assert.equal(r.code, 1, bad);
    assert.match(r.stderr, /error: --ttl out of range \(1s\.\.30d\)/, bad);
    assert.match(r.stderr, ASCII_RE);
  }
});

test("invite --join-timeout out of range exits 1", async () => {
  const r = await run(["invite", "--join-timeout", "500ms"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /error: --join-timeout out of range \(1s\.\.10m\)/);
});

test("--ttl 1000ms / 1s are accepted (parse-level; fabric open then fails cleanly on a fresh dir)", async () => {
  const r = await run(["invite", "--ttl", "1s"]);
  assert.notEqual(r.code, 2); // not a usage error
  assert.doesNotMatch(r.stderr, /out of range/);
});

test("config list shows defaults with sources; all ASCII", async () => {
  const r = await run(["config", "list"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /relay\s+= disabled \(default\)/);
  assert.match(r.stdout, /proxy\s+= auto \(default\)/);
  assert.match(r.stdout, /data\s+= ~\/\.dweb-example \(default\)/);
  assert.match(r.stdout, /inviteTtlMs\s+= 3600000 \(default\)/);
  assert.match(r.stdout, /joinTimeoutMs\s+= 30000 \(default\)/);
  assert.match(r.stdout, ASCII_RE);
});

test("config set/get/unset proxy cycle (spec scenario)", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dweb-cli-home-"));
  const set = await run(["config", "set", "proxy", "off"], { home });
  assert.equal(set.code, 0);
  const get = await run(["config", "get", "proxy"], { home });
  assert.equal(get.code, 0);
  assert.equal(get.stdout.trim(), "off");
  const unset = await run(["config", "unset", "proxy"], { home });
  assert.equal(unset.code, 0);
  const get2 = await run(["config", "get", "proxy"], { home });
  assert.equal(get2.code, 0);
  assert.equal(get2.stdout.trim(), "auto"); // default after unset
  const list = await run(["config", "list"], { home });
  assert.match(list.stdout, /proxy\s+= auto \(default\)/);
});

test("config set relay with zero URLs exits 1, frozen message, nothing written", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dweb-cli-home-"));
  const r = await run(["config", "set", "relay"], { home });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^error: config set relay requires at least one URL/);
  assert.equal(fs.existsSync(path.join(home, ".opendweb", "config.json")), false);
});

test("config set relay with invalid URL exits 1, nothing written", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dweb-cli-home-"));
  const r = await run(["config", "set", "relay", "not-a-url"], { home });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^error: invalid relay URL: not-a-url/);
  assert.equal(fs.existsSync(path.join(home, ".opendweb", "config.json")), false);
});

test("config set relay to an unreachable URL: saved-but-unreachable, file written, exit 1", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dweb-cli-home-"));
  // 127.0.0.1:1 -> connection refused immediately (deterministic, no server needed)
  const r = await run(["config", "set", "relay", "http://127.0.0.1:1"], { home, timeoutMs: 20000 });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /WARNING: saved but unreachable: http:\/\/127\.0\.0\.1:1 \((connect failed|timeout)\)/);
  assert.match(r.stderr, ASCII_RE);
  const saved = JSON.parse(fs.readFileSync(path.join(home, ".opendweb", "config.json"), "utf8"));
  assert.equal(saved.relay, "http://127.0.0.1:1");
  const list = await run(["config", "list"], { home });
  assert.match(list.stdout, /relay\s+= http:\/\/127\.0\.0\.1:1 \(file\)/);
});

test("invalid config file is a hard error carrying the path", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dweb-cli-home-"));
  fs.mkdirSync(path.join(home, ".opendweb"), { recursive: true });
  fs.writeFileSync(path.join(home, ".opendweb", "config.json"), "{ oops");
  const r = await run(["config", "list"], { home });
  assert.equal(r.code, 1);
  assert.match(r.stderr, new RegExp(`^error: invalid config file .*config\\.json: `));
  assert.match(r.stderr, ASCII_RE);
});

test("dynamic values with control characters stay one ASCII line", async () => {
  // A config file whose parse error message embeds a newline + non-ASCII byte.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dweb-cli-home-"));
  fs.mkdirSync(path.join(home, ".opendweb"), { recursive: true });
  fs.writeFileSync(path.join(home, ".opendweb", "config.json"), '{"bad-key":1}');
  const r = await run(["config", "list"], { home });
  assert.equal(r.code, 1);
  assert.match(r.stderr, ASCII_RE);
  const lines = r.stderr.split("\n").filter((l) => l.length > 0);
  assert.equal(lines.length, 1); // one line per error
});

test("DWEB_RELAY invalid value exits 1 with the frozen message", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dweb-cli-home-"));
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    DWEB_RELAY: "banana",
  };
  const res = await new Promise((resolve) => {
    const child = spawn(NODE, [CLI, "config", "list"], { stdio: ["ignore", "pipe", "pipe"], env });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });
  assert.equal(res.code, 1);
  assert.match(res.err, /error: invalid DWEB_RELAY value: banana \(expected disabled\|custom\|n0\)/);
});

test("dual form equivalence observable through --data", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dweb-cli-home-"));
  const a = await run(["--data", "~/dweb-fab", "config", "list"], { home });
  const b = await run(["--data=~/dweb-fab", "config", "list"], { home });
  assert.equal(a.code, 0);
  assert.equal(b.code, 0);
  assert.equal(a.stdout, b.stdout);
  // the CLI's os.homedir() follows the spawned HOME override
  const expected = path.join(home, "dweb-fab").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(a.stdout, new RegExp(`data\\s+= ${expected} \\(flag\\)`));
});

test("join without a token is a plain error (exit 1)", async () => {
  const r = await run(["join"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /error: join requires a dweb1\. invite token as argument/);
});
