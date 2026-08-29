// @dweb/client-sdk 生命周期测试（node --test，原生模块与 vitest worker 池不兼容）
// connectivity-ux-hardening 后 invite 有 D3 签发安全门：relay 禁用时无 advertiseAddrs
// 的令牌不再签发（旧 direct_addr_hints 回退已删除），relay-less full lifecycle
// （invite→join→message→revoke）需要真实 relay，移至 ZCode 4.1 整合期联测；
// 新 API 行为（invite 门/错误码前缀/relayStatus/事件取消订阅）见 new-api.test.mjs。
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import sdkModule from "../index.js";
const { Fabric, nativeVersion, importSecret } = /** @type {any} */ (sdkModule);

/** @typedef {import("../index.js").FabricEventJs} FabricEventJs */

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function opts(dir) {
  return { dataDir: dir, relay: { mode: "disabled" } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("nativeVersion returns crate version", () => {
  // 与包版本同步断言（v0.3.1 起不再硬编码前缀——曾漏更新导致假红）
  const pkgVersion = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ).version;
  assert.equal(nativeVersion(), pkgVersion);
});

test("identity persists across restart", async () => {
  const dir = tmpdir("dweb-sdk-restart-");
  const a1 = await Fabric.createRoot(opts(dir));
  const id1 = a1.endpointId;
  await a1.shutdown();

  const a2 = await Fabric.open(opts(dir));
  assert.equal(a2.endpointId, id1);
  assert.equal((await a2.members()).length, 1);
  await a2.shutdown();
});

test("secret injection + identity export/import lifecycle", async () => {
  const dirA = tmpdir("dweb-sec-a-");
  const dirB = tmpdir("dweb-sec-b-");

  // Seed 注入：零存储副作用 + 确定性身份
  const a = await Fabric.createRoot(opts(dirA));
  const token = await a.exportSecretPassphrase("my-passphrase");
  assert.ok(token.startsWith("dwebkey1."), "export token prefix");

  // 导入 → 注入新环境：恢复同 EndpointId；期间不写任何 identity.key
  const handle = await importSecret(token, "my-passphrase");
  assert.ok(handle.endpointId.length === 52, "handle derives endpointId");  // getter 属性
  const b = await Fabric.createRoot(opts(dirB), handle);
  assert.equal(b.endpointId, a.endpointId);  // getter 属性
  assert.ok(
    !fs.existsSync(path.join(dirB, "identity.key")),
    "seed injection has no storage side effect",
  );

  // 句柄一次性：消费后再用必须报错
  const again = Fabric.createRoot(opts(tmpdir("dweb-sec-c-")), handle);
  await assert.rejects(again);

  // 错误口令导入失败
  await assert.rejects(() => importSecret(token, "wrong-pass"));

  await a.shutdown();
  await b.shutdown();
});

test("secret handle: concurrent construction, one wins without panic", async () => {
  const a = await Fabric.createRoot(opts(tmpdir("dweb-conc-a-")));
  const token = await a.exportSecretPassphrase("pp");
  const handle = await importSecret(token, "pp");

  // 同一句柄并发两次构造：恰一成功（或双双失败于目录冲突），绝不 panic
  const dirB = tmpdir("dweb-conc-b-");
  const [r1, r2] = await Promise.allSettled([
    Fabric.createRoot({ dataDir: dirB }, handle),
    Fabric.createRoot({ dataDir: dirB }, handle),
  ]);
  const states = [r1.status, r2.status].sort().join(",");
  assert.ok(
    states === "fulfilled,rejected" || states === "rejected,rejected",
    `expected one-win or both-rejected, got ${states}`,
  );
  // 双 rejected 场景（roster AlreadyExists 竞态）下也不能有进程级异常——
  // allSettled 本身已证明无 panic。
  await a.shutdown();
});
