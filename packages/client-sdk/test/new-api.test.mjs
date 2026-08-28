// connectivity-ux-hardening 新 API 测试（node --test）。
// 能力探测：旧二进制（无 relayStatus/三参 invite 门）自动跳过原生部分——
// 依赖重建二进制的完整 e2e（真实 relay 的 full lifecycle）归 ZCode 4.1 整合期。
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import sdkModule from "../index.js";
const { Fabric, deriveErrorCode } = /** @type {any} */ (sdkModule);

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const HAS_NEW_API = typeof Fabric?.prototype?.relayStatus === "function";
const maybeTest = HAS_NEW_API ? test : test.skip;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- deriveErrorCode：纯函数（新旧二进制都跑） ---------------------------------

test("deriveErrorCode maps kebab prefixes to SCREAMING_SNAKE", () => {
  const cases = [
    ["[invite-without-relay] x", "INVITE_WITHOUT_RELAY"],
    ["[wrong-fabric] x", "WRONG_FABRIC"],
    ["[token-invalid] x", "TOKEN_INVALID"],
    ["[token-expired] x", "TOKEN_EXPIRED"],
    ["[token-consumed] x", "TOKEN_CONSUMED"],
    ["[no-reachable-path] x", "NO_REACHABLE_PATH"],
    ["[relay-offline] x", "RELAY_OFFLINE"],
    ["[dial-failed] x", "DIAL_FAILED"],
    ["[dial-timeout] x", "DIAL_TIMEOUT"],
    ["[missing-identity] x", "MISSING_IDENTITY"],
    ["[corrupted] x", "CORRUPTED"],
    ["[roster-io] x", "ROSTER_IO"],
    ["[bad-advertise-addr] x", "BAD_ADVERTISE_ADDR"],
    ["[bad-proxy-url] x", "BAD_PROXY_URL"],
  ];
  for (const [msg, code] of cases) {
    assert.equal(deriveErrorCode(msg), code, msg);
  }
  assert.equal(deriveErrorCode("plain failure"), null);
  assert.equal(deriveErrorCode(null), null);
});

// ---- invite 门：无 relay 拒签（前缀断言） ---------------------------------------

maybeTest("invite rejects without relay with [invite-without-relay] prefix", async () => {
  const a = await Fabric.createRoot({ dataDir: tmpdir("dweb-gate-a-"), relay: { mode: "disabled" } });
  await assert.rejects(
    () => a.invite(300_000, null),
    (err) => {
      assert.match(err.message, /^\[invite-without-relay\]/);
      assert.equal(deriveErrorCode(err.message), "INVITE_WITHOUT_RELAY");
      return true;
    },
  );
  // 三参透传：allowRelayless 逃生阀放行（可达性责任归调用方）
  const token = await a.invite(300_000, null, { allowRelayless: true });
  assert.ok(token.startsWith("dweb1."));
  await a.shutdown();
});

// ---- join 错误码前缀：空路径令牌（确定性、零拨号） -------------------------------

maybeTest("join with empty-path token rejects with [no-reachable-path] prefix", async () => {
  const a = await Fabric.createRoot({ dataDir: tmpdir("dweb-nrp-a-"), relay: { mode: "disabled" } });
  const token = await a.invite(300_000, null, { allowRelayless: true });
  const b = await Fabric.attach({ dataDir: tmpdir("dweb-nrp-b-"), relay: { mode: "disabled" } }, await a.fabricIdHex());
  await assert.rejects(
    () => b.join(token),
    (err) => {
      assert.match(err.message, /^\[no-reachable-path\]/);
      assert.equal(deriveErrorCode(err.message), "NO_REACHABLE_PATH");
      return true;
    },
  );
  await a.shutdown();
  await b.shutdown();
});

// ---- wrong-fabric：目录 A + 令牌 B ----------------------------------------------

maybeTest("joinWithToken with foreign fabric dir rejects with [wrong-fabric] prefix", async () => {
  const dirA = tmpdir("dweb-wf-a-");
  const a = await Fabric.createRoot({ dataDir: dirA, relay: { mode: "disabled" } });
  const b = await Fabric.createRoot({ dataDir: tmpdir("dweb-wf-b-"), relay: { mode: "disabled" } });
  const tokenB = await b.invite(300_000, null, { allowRelayless: true });
  await assert.rejects(
    () => Fabric.joinWithToken({ dataDir: dirA, relay: { mode: "disabled" } }, tokenB),
    (err) => {
      assert.match(err.message, /^\[wrong-fabric\]/);
      assert.equal(deriveErrorCode(err.message), "WRONG_FABRIC");
      assert.match(err.message, /use a fresh --data directory/);
      return true;
    },
  );
  await a.shutdown();
  await b.shutdown();
});

// ---- relayStatus 三态 ------------------------------------------------------------

maybeTest("relayStatus: disabled => online null, no relay events", async () => {
  const a = await Fabric.createRoot({ dataDir: tmpdir("dweb-rs-d-"), relay: { mode: "disabled" } });
  const events = [];
  a.on((e) => events.push(e));
  const s = await a.relayStatus();
  assert.equal(s.mode, "disabled");
  assert.deepEqual(s.urls, []);
  assert.equal(s.online, null, "disabled => null, not false");
  await sleep(300);
  assert.ok(!events.some((e) => e.type === "relay-online" || e.type === "relay-offline"));
  await a.shutdown();
});

maybeTest("relayStatus: custom => online boolean (not null)", async () => {
  const a = await Fabric.createRoot({
    dataDir: tmpdir("dweb-rs-c-"),
    relay: { mode: "custom", urls: ["http://127.0.0.1:9"] },
  });
  const s = await a.relayStatus();
  assert.equal(s.mode, "custom");
  assert.deepEqual(s.urls, ["http://127.0.0.1:9"]);
  assert.notEqual(s.online, null, "enabled mode => boolean");
  // lastError 为 null 或脱敏类别串（不含 URL 凭证段）
  if (s.lastError !== null) {
    assert.equal(typeof s.lastError, "string");
  }
  await a.shutdown();
});

// ---- 事件订阅 / 取消订阅（roster-updated，无需网络） ------------------------------

maybeTest("on() returns unsubscribe; off callback stops receiving", async () => {
  const a = await Fabric.createRoot({ dataDir: tmpdir("dweb-evt-a-"), relay: { mode: "disabled" } });
  const seen1 = [];
  const seen2 = [];
  const unsub1 = a.on((e) => seen1.push(e));
  a.on((e) => seen2.push(e));
  assert.equal(typeof unsub1, "function");

  await a.setDisplayName("alice");
  await sleep(500);
  assert.ok(seen1.some((e) => e.type === "roster-updated"), "callback 1 receives roster-updated");
  assert.ok(seen2.some((e) => e.type === "roster-updated"), "callback 2 receives roster-updated");

  unsub1();
  const count1 = seen1.length;
  await a.setDisplayName("alice2");
  await sleep(500);
  assert.equal(seen1.length, count1, "unsubscribed callback no longer invoked");
  assert.ok(seen2.length > 0);
  await a.shutdown();
});

// ---- 构造期校验 -------------------------------------------------------------------

maybeTest("constructor validation: bad advertiseAddrs / empty custom urls / joinTimeout range / bad proxy", async () => {
  const base = { relay: { mode: "disabled" } };
  await assert.rejects(
    () => Fabric.createRoot({ dataDir: tmpdir("dweb-val-1-"), ...base, advertiseAddrs: ["0.0.0.0:1234"] }),
    (err) => /^\[bad-advertise-addr\]/.test(err.message),
  );
  await assert.rejects(
    () => Fabric.createRoot({ dataDir: tmpdir("dweb-val-2-"), ...base, advertiseAddrs: ["nope"] }),
    (err) => /^\[bad-advertise-addr\]/.test(err.message),
  );
  await assert.rejects(
    () => Fabric.createRoot({ dataDir: tmpdir("dweb-val-3-"), relay: { mode: "custom", urls: [] } }),
    (err) => /at least one relay URL/.test(err.message),
  );
  await assert.rejects(
    () => Fabric.createRoot({ dataDir: tmpdir("dweb-val-4-"), ...base, joinTimeoutMs: 500 }),
    (err) => /out of range/.test(err.message),
  );
  await assert.rejects(
    () => Fabric.createRoot({ dataDir: tmpdir("dweb-val-5-"), ...base, httpProxy: { url: "not a url" } }),
    (err) => /^\[bad-proxy-url\]/.test(err.message),
  );
  await assert.rejects(
    () => Fabric.createRoot({ dataDir: tmpdir("dweb-val-6-"), relay: { mode: "custom" } }),
    (err) => /at least one relay URL/.test(err.message),
  );
});

// ---- 说明 ------------------------------------------------------------------------
// 依赖真实 relay 的部分（RelayOnline 事件透传、full lifecycle invite→join→
// connect→message→revoke、TOKEN_CONSUMED 二次兑换、joinTimeoutMs 约 1s 的
// [dial-timeout]）需要重建原生二进制 + 运行 relay 服务，归 ZCode 4.1 整合期联测。
