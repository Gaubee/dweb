// @dweb/client-sdk 生命周期测试（node --test，原生模块与 vitest worker 池不兼容）
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import sdkModule from "../index.js";
const { Fabric, nativeVersion } = /** @type {any} */ (sdkModule);

/** @typedef {import("../index.js").FabricEventJs} FabricEventJs */

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function opts(dir) {
  return { dataDir: dir, relay: { mode: "disabled" } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("nativeVersion returns crate version", () => {
  assert.match(nativeVersion(), /^0\.1\./);
});

test(
  "full lifecycle: invite -> join -> connect -> messages -> revoke",
  async () => {
    const a = await Fabric.createRoot(opts(tmpdir("dweb-sdk-a-")));
    assert.match(a.endpointId, /^[a-z0-9]{52}$/);

    const b = await Fabric.attach(opts(tmpdir("dweb-sdk-b-")), await a.fabricIdHex());

    /** @type {any[]} */
    const eventsB = [];
    b.on((e) => eventsB.push(e));

    const token = await a.invite(300_000, null);
    assert.ok(token.startsWith("dweb1."));

    await b.join(token);
    assert.equal((await b.members()).length, 2);

    // 同一令牌二次兑换被拒
    await assert.rejects(() => b.join(token));

    await b.connect(a.endpointId);
    await sleep(800);

    await a.send(b.endpointId, Buffer.from("ping"));
    await sleep(800);

    const msg = eventsB.find((e) => e.type === "message");
    assert.ok(msg, "message event received");
    assert.equal(msg.data.toString(), "ping");
    assert.equal(msg.from, a.endpointId);

    await a.revoke(b.endpointId);
    await sleep(800);
    assert.equal((await a.members()).length, 1);

    await assert.rejects(() => b.connect(a.endpointId));

    await b.shutdown();
    await a.shutdown();
    await a.shutdown(); // 幂等
  },
);

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
