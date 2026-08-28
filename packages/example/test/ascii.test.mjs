// ASCII discipline tests (design D10): dynamic values escape per UTF-8 byte
// with lowercase hex \xNN; control characters (incl. newlines) are escaped so
// one error stays one line.
import test from "node:test";
import assert from "node:assert/strict";

import { asciiEscape, isAscii } from "../src/ascii.mjs";

test("printable ASCII passes through unchanged", () => {
  assert.equal(asciiEscape("plain text -- 123 ~!@#"), "plain text -- 123 ~!@#");
});

test("non-ASCII escapes as lowercase hex UTF-8 bytes", () => {
  // U+4E2D U+6587 -> e4 b8 ad e6 96 87
  assert.equal(asciiEscape("\u4e2d\u6587"), "\\xe4\\xb8\\xad\\xe6\\x96\\x87");
  // U+00E9 (e-acute) -> c3 a9
  assert.equal(asciiEscape("caf\u00e9"), "caf\\xc3\\xa9");
});

test("control characters escape, including newlines and DEL", () => {
  assert.equal(asciiEscape("a\nb"), "a\\x0ab");
  assert.equal(asciiEscape("a\tb"), "a\\x09b");
  assert.equal(asciiEscape("a\rb"), "a\\x0db");
  assert.equal(asciiEscape("a\u007fb"), "a\\x7fb");
  assert.equal(asciiEscape("a\x00b"), "a\\x00b");
});

test("escaped line satisfies the all-ASCII assertion and stays one line", () => {
  const evil = "/tmp/\u4e2d\u6587/bad\u0000path\nsecond line";
  const out = asciiEscape(`error: invalid config file ${evil}: boom`);
  assert.ok(isAscii(out));
  assert.match(out, /^[\x00-\x7f]*$/);
  assert.ok(!out.includes("\n"));
  assert.equal(out, "error: invalid config file /tmp/\\xe4\\xb8\\xad\\xe6\\x96\\x87/bad\\x00path\\x0asecond line: boom");
});

test("null and undefined render as their names", () => {
  assert.equal(asciiEscape(null), "null");
  assert.equal(asciiEscape(undefined), "undefined");
});
