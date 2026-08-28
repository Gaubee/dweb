// Unit tests for src/args.mjs (design D8/D9): dual-form equivalence, boolean
// flags, tilde expansion, unknown-option errors, duration suffix parsing and
// range validation.
import test from "node:test";
import assert from "node:assert/strict";

import { parseArgv, parseDurationMs, assertDurationRange, expandTilde } from "../src/args.mjs";
import { UsageError, CliError } from "../src/errors.mjs";

const SPEC = {
  data: { type: "string", tilde: true },
  relay: { type: "multi" },
  proxy: { type: "string" },
  "join-timeout": { type: "string" },
  ttl: { type: "string" },
  for: { type: "string" },
  "allow-relayless": { type: "boolean" },
};

test("dual forms are equivalent: --opt value vs --opt=value", () => {
  const a = parseArgv(["--data", "/tmp/a"], SPEC);
  const b = parseArgv(["--data=/tmp/a"], SPEC);
  assert.deepEqual(a, b);

  const c = parseArgv(["--proxy", "off", "chat"], SPEC);
  const d = parseArgv(["--proxy=off", "chat"], SPEC);
  assert.deepEqual(c.options, d.options);
  assert.deepEqual(c.positionals, d.positionals);

  const e = parseArgv(["--relay", "http://x:1", "--relay", "http://y:2"], SPEC);
  const f = parseArgv(["--relay=http://x:1", "--relay=http://y:2"], SPEC);
  assert.deepEqual(e.options.relay, f.options.relay);

  const g = parseArgv(["--ttl", "30s"], SPEC);
  const h = parseArgv(["--ttl=30s"], SPEC);
  assert.deepEqual(g.options, h.options);

  const i = parseArgv(["--join-timeout", "5s"], SPEC);
  const j = parseArgv(["--join-timeout=5s"], SPEC);
  assert.deepEqual(i.options, j.options);
});

test("boolean flag", () => {
  const r = parseArgv(["--allow-relayless"], SPEC);
  assert.equal(r.options["allow-relayless"], true);
  assert.equal(r.positionals.length, 0);
  // repeated boolean stays true
  const r2 = parseArgv(["--allow-relayless", "--allow-relayless"], SPEC);
  assert.equal(r2.options["allow-relayless"], true);
});

test("boolean flag does not consume the next token", () => {
  const r = parseArgv(["--allow-relayless", "abc"], SPEC);
  assert.equal(r.options["allow-relayless"], true);
  assert.deepEqual(r.positionals, ["abc"]);
});

test("boolean flag rejects inline value", () => {
  assert.throws(() => parseArgv(["--allow-relayless=yes"], SPEC), (e) => {
    assert.ok(e instanceof UsageError);
    assert.equal(e.exitCode, 2);
    assert.match(e.message, /does not take a value/);
    return true;
  });
});

test("tilde expansion for path-like options", () => {
  const r = parseArgv(["--data", "~/fab"], SPEC, { homedir: "/home/u" });
  assert.equal(r.options.data, "/home/u/fab");
  const r2 = parseArgv(["--data", "~"], SPEC, { homedir: "/home/u" });
  assert.equal(r2.options.data, "/home/u");
  const r3 = parseArgv(["--data", "/abs/path"], SPEC, { homedir: "/home/u" });
  assert.equal(r3.options.data, "/abs/path");
  assert.equal(expandTilde("~x/other", "/home/u"), "~x/other");
});

test("unknown option errors with exit code 2 and lists known options", () => {
  assert.throws(() => parseArgv(["--foo", "bar"], SPEC), (e) => {
    assert.ok(e instanceof UsageError);
    assert.equal(e.exitCode, 2);
    assert.match(e.message, /^error: unknown option --foo \(known: /);
    for (const k of Object.keys(SPEC)) assert.ok(e.message.includes(`--${k}`));
    return true;
  });
});

test("missing option value errors", () => {
  assert.throws(() => parseArgv(["--data"], SPEC), (e) => {
    assert.ok(e instanceof UsageError);
    assert.equal(e.exitCode, 2);
    assert.match(e.message, /option --data requires a value/);
    return true;
  });
});

test("-- terminator makes everything afterwards positional", () => {
  const r = parseArgv(["join", "--", "--looks-like-option", "x"], SPEC);
  assert.deepEqual(r.positionals, ["join", "--looks-like-option", "x"]);
});

test("multi option accumulates in order; single-dash tokens are positionals", () => {
  const r = parseArgv(["--relay", "http://a:1", "pos1", "-x", "--relay=http://b:2"], SPEC);
  assert.deepEqual(r.options.relay, ["http://a:1", "http://b:2"]);
  assert.deepEqual(r.positionals, ["pos1", "-x"]);
});

// ---------------------------------------------------------------------------
// durations (design D9)
// ---------------------------------------------------------------------------

test("duration suffixes and bare milliseconds", () => {
  assert.equal(parseDurationMs("30000", "--ttl"), 30000);
  assert.equal(parseDurationMs("30s", "--ttl"), 30000);
  assert.equal(parseDurationMs("15m", "--ttl"), 900000);
  assert.equal(parseDurationMs("2h", "--ttl"), 7200000);
  assert.equal(parseDurationMs("1d", "--ttl"), 86400000);
  assert.equal(parseDurationMs("1000ms", "--ttl"), 1000);
  assert.equal(parseDurationMs("1.5h", "--ttl"), 5400000);
  // 60m default cross-check
  assert.equal(parseDurationMs("60m", "--ttl"), 3600000);
});

test("duration syntax errors", () => {
  for (const bad of ["abc", "", "5x", "-5s", "s", "1h30m", "1 s"]) {
    assert.throws(() => parseDurationMs(bad, "--ttl"), (e) => {
      assert.ok(e instanceof CliError);
      assert.equal(e.exitCode, 1);
      assert.ok(e.message.includes(`invalid --ttl value: ${bad}`), e.message);
      return true;
    }, `expected error for ${JSON.stringify(bad)}`);
  }
});

test("duration overflow does not wrap around", () => {
  assert.equal(parseDurationMs("999999999d", "--ttl"), Number.POSITIVE_INFINITY);
});

test("ttl range: 999ms rejected, 1000ms accepted, 30d boundary", () => {
  const TTL_MIN = 1000;
  const TTL_MAX = 30 * 24 * 60 * 60 * 1000;
  const expectRangeError = (ms) =>
    assert.throws(
      () => assertDurationRange(ms, TTL_MIN, TTL_MAX, "--ttl", "1s..30d"),
      (e) => {
        assert.match(e.message, /error: --ttl out of range \(1s\.\.30d\)/);
        return true;
      },
    );
  expectRangeError(0);
  expectRangeError(999);
  expectRangeError(Number.POSITIVE_INFINITY); // 999999999d
  expectRangeError(30 * 24 * 60 * 60 * 1000 + 1);
  assertDurationRange(1000, TTL_MIN, TTL_MAX, "--ttl", "1s..30d");
  assertDurationRange(30 * 24 * 60 * 60 * 1000, TTL_MIN, TTL_MAX, "--ttl", "1s..30d");
});

test("join-timeout range: 1s..10m", () => {
  const MIN = 1000;
  const MAX = 600000;
  assert.throws(
    () => assertDurationRange(500, MIN, MAX, "--join-timeout", "1s..10m"),
    (e) => {
      assert.match(e.message, /error: --join-timeout out of range \(1s\.\.10m\)/);
      return true;
    },
  );
  assertDurationRange(1000, MIN, MAX, "--join-timeout", "1s..10m");
  assertDurationRange(600000, MIN, MAX, "--join-timeout", "1s..10m");
  assert.throws(
    () => assertDurationRange(600001, MIN, MAX, "--join-timeout", "1s..10m"),
    /out of range/,
  );
});
