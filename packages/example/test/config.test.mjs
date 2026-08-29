// Unit tests for src/config.mjs (design D6): file IO with permissions and
// atomic writes, validation hard errors, and the flag > env > file > default
// priority decision table including every frozen DWEB_RELAY/DWEB_PROXY edge.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  CONFIG_KEYS,
  N0_RELAY_URL,
  configPaths,
  loadConfigFile,
  writeConfigFileAtomic,
  resolveSettings,
  configListLines,
  relayDisplay,
  relayStatusLine,
  configSetValue,
  parseEnvUrlList,
} from "../src/config.mjs";
import { CliError, UsageError } from "../src/errors.mjs";

const IS_WIN = process.platform === "win32";

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dweb-cfg-"));
}

function writeRaw(home, text) {
  const p = configPaths({ HOME: home });
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(p.file, text);
  return p;
}

const CLEAN_ENV = /** @type {any} */ ({});

// ---------------------------------------------------------------------------
// file IO
// ---------------------------------------------------------------------------

test("missing file loads as empty config without warnings", () => {
  const home = tmpHome();
  const { config, warnings } = loadConfigFile(configPaths({ HOME: home }).file);
  assert.deepEqual(config, {});
  assert.deepEqual(warnings, []);
});

test("atomic write + load roundtrip; no temp leftovers; 0600/0700 on POSIX", () => {
  const home = tmpHome();
  const p = configPaths({ HOME: home });
  writeConfigFileAtomic(p.file, { relay: "http://a:8787", proxy: "off", inviteTtlMs: 900000 });
  const { config, warnings } = loadConfigFile(p.file);
  assert.deepEqual(config, { relay: "http://a:8787", proxy: "off", inviteTtlMs: 900000 });
  assert.deepEqual(warnings, []);
  const entries = fs.readdirSync(p.dir);
  assert.deepEqual(entries, ["config.json"]);
  if (!IS_WIN) {
    assert.equal(fs.statSync(p.file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(p.dir).mode & 0o777, 0o700);
  }
});

test("writeConfigFileAtomic replaces an existing file (tmp+rename, not truncate-in-place)", () => {
  const home = tmpHome();
  const p = configPaths({ HOME: home });
  writeConfigFileAtomic(p.file, { proxy: "on" });
  writeConfigFileAtomic(p.file, { proxy: "off" });
  const { config } = loadConfigFile(p.file);
  assert.deepEqual(config, { proxy: "off" });
  assert.deepEqual(fs.readdirSync(p.dir), ["config.json"]);
});

test("loading tightens over-wide permissions and returns a WARNING (POSIX)", () => {
  if (IS_WIN) return; // best-effort semantics on Windows
  const home = tmpHome();
  const p = writeRaw(home, '{"proxy":"off"}');
  fs.chmodSync(p.file, 0o644);
  fs.chmodSync(p.dir, 0o755);
  const { warnings } = loadConfigFile(p.file);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((w) => w.includes("tightened to 0600")));
  assert.ok(warnings.some((w) => w.includes("tightened to 0700")));
  assert.equal(fs.statSync(p.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(p.dir).mode & 0o777, 0o700);
});

// ---------------------------------------------------------------------------
// validation hard errors
// ---------------------------------------------------------------------------

test("invalid JSON hard-errors with the file path", () => {
  const home = tmpHome();
  const p = writeRaw(home, "{ not json");
  assert.throws(() => loadConfigFile(p.file), (e) => {
    assert.ok(e instanceof CliError);
    assert.equal(e.exitCode, 1);
    assert.ok(e.message.startsWith(`error: invalid config file ${p.file}:`));
    return true;
  });
});

test("unknown keys hard-error and list known keys", () => {
  const home = tmpHome();
  const p = writeRaw(home, '{"frobnicate":1}');
  assert.throws(
    () => loadConfigFile(p.file),
    (e) => {
      assert.ok(e.message.includes('unknown key "frobnicate"'));
      assert.ok(e.message.includes(CONFIG_KEYS.join(", ")));
      return true;
    },
  );
});

test("wrong types and out-of-range values hard-error", () => {
  const cases = [
    ['{"relay":42}', "relay"],
    ['{"relay":[]}', "relay"],
    ['{"relay":["http://a:1","ftp://b:2"]}', "relay"],
    ['{"proxy":"sometimes"}', "proxy"],
    ['{"data":""}', "data"],
    ['{"inviteTtlMs":999}', "inviteTtlMs"],
    ['{"inviteTtlMs":2592000001}', "inviteTtlMs"],
    ['{"joinTimeoutMs":500}', "joinTimeoutMs"],
    ['{"joinTimeoutMs":999999}', "joinTimeoutMs"],
    ['{"inviteTtlMs":"60m"}', "inviteTtlMs"],
  ];
  for (const [raw, key] of cases) {
    const home = tmpHome();
    const p = writeRaw(home, raw);
    assert.throws(() => loadConfigFile(p.file), (e) => {
      assert.ok(e instanceof CliError, raw);
      assert.ok(e.message.includes(key), `${raw} -> ${e.message}`);
      return true;
    }, raw);
  }
});

test("valid full file loads", () => {
  const home = tmpHome();
  const p = writeRaw(
    home,
    JSON.stringify({
      relay: ["http://a:8787", "http://b:8787"],
      proxy: "on",
      data: "~/.dweb-example",
      inviteTtlMs: 3600000,
      joinTimeoutMs: 45000,
    }),
  );
  if (!IS_WIN) {
    fs.chmodSync(p.file, 0o600);
    fs.chmodSync(p.dir, 0o700);
  }
  const { config, warnings } = loadConfigFile(p.file);
  assert.deepEqual(config.relay, ["http://a:8787", "http://b:8787"]);
  assert.equal(warnings.length, 0);
});

// ---------------------------------------------------------------------------
// priority decision table (flag > env > file > default)
// ---------------------------------------------------------------------------

test("data priority: flag > env > file > default", () => {
  const file = { data: "/file" };
  assert.equal(resolveSettings({ flags: { data: "/flag" }, env: { DWEB_DATA: "/env" }, file }).data.source, "flag");
  assert.equal(resolveSettings({ flags: {}, env: { DWEB_DATA: "/env" }, file }).data.value, "/env");
  assert.equal(resolveSettings({ flags: {}, env: {}, file }).data.source, "file");
  const d = resolveSettings({ flags: {}, env: {}, file: {} }).data;
  assert.equal(d.source, "default");
  assert.equal(d.value, "~/.dweb-example");
});

test("relay: env custom+URLS overrides file relay (spec scenario)", () => {
  const s = resolveSettings({
    env: { DWEB_RELAY: "custom", DWEB_RELAY_URLS: "http://b:3340" },
    file: { relay: "http://a:8787" },
  });
  assert.equal(s.relay.mode, "custom");
  assert.deepEqual(s.relay.urls, ["http://b:3340"]);
  assert.equal(s.relay.source, "env");
});

test("relay: DWEB_RELAY=disabled disables even when the file has relay", () => {
  const s = resolveSettings({ env: { DWEB_RELAY: "disabled" }, file: { relay: "http://a:8787" } });
  assert.equal(s.relay.mode, "disabled");
  assert.deepEqual(s.relay.urls, []);
});

test("relay: DWEB_RELAY=custom without usable DWEB_RELAY_URLS errors", () => {
  for (const urls of [undefined, "", ",", ",,"]) {
    const env = /** @type {any} */ ({ DWEB_RELAY: "custom" });
    if (urls !== undefined) env.DWEB_RELAY_URLS = urls;
    assert.throws(() => resolveSettings({ env, file: {} }), (e) => {
      assert.equal(e.message, "error: DWEB_RELAY=custom requires DWEB_RELAY_URLS");
      return true;
    }, `urls=${urls}`);
  }
});

test("relay: invalid DWEB_RELAY value errors with the valid set", () => {
  assert.throws(() => resolveSettings({ env: { DWEB_RELAY: "foo" }, file: {} }), (e) => {
    assert.equal(e.message, "error: invalid DWEB_RELAY value: foo (expected disabled|custom|n0)");
    return true;
  });
});

test("relay: DWEB_RELAY unset + DWEB_RELAY_URLS present = implicit custom; empty items filtered, deduped, order kept", () => {
  const s = resolveSettings({ env: { DWEB_RELAY_URLS: "http://a:3340,,http://b:3340,http://a:3340," }, file: {} });
  assert.equal(s.relay.mode, "custom");
  assert.deepEqual(s.relay.urls, ["http://a:3340", "http://b:3340"]);
  assert.equal(s.relay.source, "env");
});

test("relay: implicit custom with all-empty URLS errors", () => {
  assert.throws(
    () => resolveSettings({ env: { DWEB_RELAY_URLS: ",," }, file: {} }),
    /DWEB_RELAY_URLS is set but contains no usable URL/,
  );
});

test("relay: n0 mode uses the official default relay URL", () => {
  const s = resolveSettings({ env: { DWEB_RELAY: "n0" }, file: {} });
  assert.equal(s.relay.mode, "n0");
  assert.deepEqual(s.relay.urls, []); // n0 配置层不再携带 canonical 单条（内核用真实默认列表）
});

test("relay: file value used when env absent (string or array)", () => {
  const s1 = resolveSettings({ env: {}, file: { relay: "http://a:8787" } });
  assert.deepEqual(s1.relay.urls, ["http://a:8787"]);
  assert.equal(s1.relay.source, "file");
  const s2 = resolveSettings({ env: {}, file: { relay: ["http://a:8787", "http://a:8787", "http://b:8787"] } });
  assert.deepEqual(s2.relay.urls, ["http://a:8787", "http://b:8787"]);
});

test("relay: flag --relay beats env and file", () => {
  const s = resolveSettings({
    flags: { relay: ["http://flag:3340"] },
    env: { DWEB_RELAY: "custom", DWEB_RELAY_URLS: "http://env:3340" },
    file: { relay: "http://file:3340" },
  });
  assert.deepEqual(s.relay.urls, ["http://flag:3340"]);
  assert.equal(s.relay.source, "flag");
});

test("relay: nothing configured -> disabled (0.1.0 behavior, D3-gated)", () => {
  const s = resolveSettings({ env: {}, file: {} });
  assert.equal(s.relay.mode, "disabled");
  assert.equal(s.relay.source, "default");
});

test("proxy: DWEB_PROXY invalid value errors with the valid set", () => {
  assert.throws(() => resolveSettings({ env: { DWEB_PROXY: "bar" }, file: {} }), (e) => {
    assert.equal(e.message, "error: invalid DWEB_PROXY value: bar (expected auto|on|off)");
    return true;
  });
});

test("proxy: priority flag > env > file > default(auto)", () => {
  assert.equal(resolveSettings({ flags: { proxy: "off" }, env: { DWEB_PROXY: "on" }, file: { proxy: "on" } }).proxy.value, "off");
  assert.equal(resolveSettings({ flags: {}, env: { DWEB_PROXY: "on" }, file: { proxy: "off" } }).proxy.value, "on");
  assert.equal(resolveSettings({ flags: {}, env: {}, file: { proxy: "on" } }).proxy.source, "file");
  assert.equal(resolveSettings({ flags: {}, env: {}, file: {} }).proxy.value, "auto");
});

test("inviteTtlMs / joinTimeoutMs: flag > file > default (no env entries)", () => {
  const s1 = resolveSettings({ flags: { ttlMs: 5000 }, env: {}, file: { inviteTtlMs: 60000 } });
  assert.equal(s1.inviteTtlMs.value, 5000);
  assert.equal(s1.inviteTtlMs.source, "flag");
  const s2 = resolveSettings({ flags: {}, env: {}, file: { inviteTtlMs: 60000 } });
  assert.equal(s2.inviteTtlMs.value, 60000);
  const s3 = resolveSettings({ flags: {}, env: {}, file: {} });
  assert.equal(s3.inviteTtlMs.value, 3600000); // 60m default
  assert.equal(s3.joinTimeoutMs.value, 30000); // 30s default
  const s4 = resolveSettings({ flags: { joinTimeoutMs: 5000 }, env: {}, file: { joinTimeoutMs: 60000 } });
  assert.equal(s4.joinTimeoutMs.value, 5000);
});

// ---------------------------------------------------------------------------
// display / list
// ---------------------------------------------------------------------------

test("relayDisplay formats the three modes", () => {
  assert.equal(relayDisplay({ mode: "disabled", urls: [] }), "disabled");
  assert.equal(relayDisplay({ mode: "n0", urls: [] }), "n0 (iroh default relays)");
  assert.equal(
    relayDisplay({ mode: "custom", urls: ["http://a:3340", "http://b:3340"] }),
    "http://a:3340,http://b:3340",
  );
});

// task 8.3：activeUrl 显示（contracts C0.2 RelayStatusJs 增量）。四形态 + 防御分支。
test("relayStatusLine: online+activeUrl shows the connected relay URL", () => {
  assert.equal(
    relayStatusLine({
      mode: "custom",
      urls: ["http://a:3340", "http://b:3340"],
      online: true,
      lastError: null,
      activeUrl: "http://a:3340",
    }),
    "relay: online (http://a:3340)",
  );
  assert.equal(
    relayStatusLine({
      mode: "n0",
      urls: [N0_RELAY_URL],
      online: true,
      lastError: null,
      activeUrl: N0_RELAY_URL,
    }),
    `relay: online (${N0_RELAY_URL})`,
  );
});

test("relayStatusLine: online without activeUrl (old binary undefined) falls back to candidate count", () => {
  assert.equal(
    relayStatusLine({
      mode: "custom",
      urls: ["http://a:3340", "http://b:3340"],
      online: true,
      lastError: null,
    }),
    "relay: online (2 candidates)",
  );
  // 单候选用单数形式
  assert.equal(
    relayStatusLine({ mode: "custom", urls: ["http://a:3340"], online: true, lastError: null }),
    "relay: online (1 candidate)",
  );
  // 防御：新二进制 online 时 activeUrl 契约上必为 URL，异常 null/空串也回退候选数
  assert.equal(
    relayStatusLine({
      mode: "custom",
      urls: ["http://a:3340", "http://b:3340"],
      online: true,
      lastError: null,
      activeUrl: null,
    }),
    "relay: online (2 candidates)",
  );
  assert.equal(
    relayStatusLine({
      mode: "custom",
      urls: ["http://a:3340", "http://b:3340"],
      online: true,
      lastError: null,
      activeUrl: "",
    }),
    "relay: online (2 candidates)",
  );
});

test("relayStatusLine: offline and disabled snapshots yield no online line (null)", () => {
  // offline：无显示行，警告文案由调用方（chat）处理
  assert.equal(
    relayStatusLine({
      mode: "custom",
      urls: ["http://a:3340"],
      online: false,
      lastError: "dial failed",
      activeUrl: null,
    }),
    null,
  );
  // online === null（未探测态）同样无显示行
  assert.equal(
    relayStatusLine({ mode: "custom", urls: ["http://a:3340"], online: null, lastError: null, activeUrl: null }),
    null,
  );
  // disabled：静默
  assert.equal(
    relayStatusLine({ mode: "disabled", urls: [], online: null, lastError: null, activeUrl: null }),
    null,
  );
});

test("config list annotates the source of every key", () => {
  const lines = configListLines(
    resolveSettings({ env: { DWEB_RELAY: "custom", DWEB_RELAY_URLS: "http://b:3340" }, file: { proxy: "off", inviteTtlMs: 120000 } }),
  );
  assert.equal(lines.length, 5);
  assert.ok(lines.some((l) => l.startsWith("relay") && l.includes("http://b:3340") && l.includes("(env)")));
  assert.ok(lines.some((l) => l.startsWith("proxy") && l.includes("off") && l.includes("(file)")));
  assert.ok(lines.some((l) => l.startsWith("data") && l.includes("(default)")));
  assert.ok(lines.some((l) => l.startsWith("inviteTtlMs") && l.includes("120000") && l.includes("(file)")));
  assert.ok(lines.some((l) => l.startsWith("joinTimeoutMs") && l.includes("30000") && l.includes("(default)")));
});

// ---------------------------------------------------------------------------
// config set value handling
// ---------------------------------------------------------------------------

test("config set relay: zero URLs errors with usage and does not build a patch", () => {
  assert.throws(() => configSetValue("relay", []), (e) => {
    assert.equal(e.message, "error: config set relay requires at least one URL");
    return true;
  });
});

test("config set relay: syntax-invalid URL errors (write happens in the caller, only after this passes)", () => {
  assert.throws(() => configSetValue("relay", ["not-a-url"]), (e) => {
    assert.equal(e.message, "error: invalid relay URL: not-a-url");
    return true;
  });
  assert.throws(() => configSetValue("relay", ["http://ok:3340", "ftp://bad:1"]));
});

test("config set relay: variadic writes deduped single string or array", () => {
  assert.deepEqual(configSetValue("relay", ["http://a:3340"]), { relay: "http://a:3340" });
  assert.deepEqual(configSetValue("relay", ["http://a:3340", "http://b:3340", "http://a:3340"]), {
    relay: ["http://a:3340", "http://b:3340"],
  });
});

test("config set proxy/data/ttl/joinTimeout validation", () => {
  assert.deepEqual(configSetValue("proxy", ["on"]), { proxy: "on" });
  assert.throws(() => configSetValue("proxy", ["sometimes"]), /invalid proxy value: sometimes \(expected auto\|on\|off\)/);
  assert.throws(() => configSetValue("proxy", []), UsageError);

  assert.deepEqual(configSetValue("data", ["~/fab"], { homedir: "/home/u" }), { data: "/home/u/fab" });

  assert.deepEqual(configSetValue("inviteTtlMs", ["15m"]), { inviteTtlMs: 900000 });
  assert.deepEqual(configSetValue("inviteTtlMs", ["3600000"]), { inviteTtlMs: 3600000 });
  assert.throws(() => configSetValue("inviteTtlMs", ["999"]), /inviteTtlMs out of range \(1s\.\.30d\)/);
  assert.throws(() => configSetValue("inviteTtlMs", ["40d"]), /inviteTtlMs out of range \(1s\.\.30d\)/);

  assert.deepEqual(configSetValue("joinTimeoutMs", ["45s"]), { joinTimeoutMs: 45000 });
  assert.throws(() => configSetValue("joinTimeoutMs", ["999ms"]), /joinTimeoutMs out of range \(1s\.\.10m\)/);
  assert.throws(() => configSetValue("joinTimeoutMs", ["11m"]), /joinTimeoutMs out of range \(1s\.\.10m\)/);

  assert.throws(() => configSetValue("nope", ["x"]), /unknown config key: nope/);
});

test("parseEnvUrlList filters empty items, dedupes, keeps order", () => {
  assert.deepEqual(parseEnvUrlList("a,,b,a,"), ["a", "b"]);
  assert.deepEqual(parseEnvUrlList(""), []);
  assert.deepEqual(parseEnvUrlList(undefined), []);
  assert.deepEqual(parseEnvUrlList(",,"), []);
});

test("configPaths honors HOME override", () => {
  const p = configPaths({ HOME: "/tmp/home-x" });
  assert.equal(p.dir, path.join("/tmp/home-x", ".opendweb"));
  assert.equal(p.file, path.join(p.dir, "config.json"));
});

// ---- P1-4 回归：DWEB_RELAY_URLS 显式空串 = 隐式 custom 意图 → 硬错误 ----

test("DWEB_RELAY_URLS set to empty string is explicit custom intent and errors", async () => {
  const { resolveSettings } = await import("../src/config.mjs");
  assert.throws(
    () => resolveSettings({ env: { DWEB_RELAY_URLS: "" }, file: {}, flags: {} }),
    /no usable URL/,
  );
});

test("DWEB_RELAY_URLS with only commas filters to empty and errors", async () => {
  const { resolveSettings } = await import("../src/config.mjs");
  assert.throws(
    () => resolveSettings({ env: { DWEB_RELAY_URLS: ",,," }, file: {}, flags: {} }),
    /no usable URL/,
  );
});
