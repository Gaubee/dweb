// 幂等编排单测（provision）：注入 fake CfGateway（调用全记录）跑 desired-state
// ensure 链矩阵——tunnel 复用/新建、ingress GET-diff 后全量 PUT、DNS 三态
// （无记录创建 / 指向正确 no-op / 冲突必经确认）、dry-run 零副作用、本地
// config 新写 vs merge 指引、端到端自检失败即整体失败。
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { provision, tunnelNameFor, tunnelIdentityOf, DNS_MANAGED_BY, TUNNEL_NAME_PREFIX } from "../dist/provision.mjs";
import { buildIngress, planExposure } from "../dist/route-model.mjs";

const ZONE = { id: "zone1", name: "tweb.xin", accountId: "acc1", accountName: "Tweb Labs" };
const HOST = "gaubee.tweb.xin";
const RELAY = "relay.gaubee.tweb.xin";

/** fake CfGateway：可编程状态 + 全方法调用记录 */
function fakeGateway({ tunnels = [], configs = {}, dns = {}, tunnelToken = "tok-xyz" } = {}) {
  const calls = {
    listTunnels: [], createTunnel: [], getTunnelToken: [], getConfiguration: [],
    putConfiguration: [], findDnsRecord: [], createDnsRecord: [], updateDnsRecord: [],
  };
  return {
    calls,
    async listZones() {
      return [ZONE];
    },
    async listTunnels(accountId) {
      calls.listTunnels.push(accountId);
      return tunnels;
    },
    async createTunnel(accountId, name) {
      calls.createTunnel.push({ accountId, name });
      return { id: "t-created", name };
    },
    async getTunnelToken(accountId, tunnelId) {
      calls.getTunnelToken.push({ accountId, tunnelId });
      return tunnelToken;
    },
    async getConfiguration(accountId, tunnelId) {
      calls.getConfiguration.push({ accountId, tunnelId });
      return configs[tunnelId] ?? null;
    },
    async putConfiguration(accountId, tunnelId, config) {
      calls.putConfiguration.push({ accountId, tunnelId, config });
      configs[tunnelId] = config;
    },
    async findDnsRecord(zoneId, fqdn) {
      calls.findDnsRecord.push({ zoneId, fqdn });
      return dns[fqdn] ?? null;
    },
    async createDnsRecord(zoneId, fqdn, target, comment) {
      calls.createDnsRecord.push({ zoneId, fqdn, target, comment });
    },
    async updateDnsRecord(zoneId, recordId, fqdn, target, comment) {
      calls.updateDnsRecord.push({ zoneId, recordId, fqdn, target, comment });
    },
  };
}

/** 自检成功的 fetchImpl：公告期望的 relay URL */
const okVerifyFetch = (relayUrl) => async (url) =>
  new Response(JSON.stringify({ services: [{ name: "relay", enabled: true, url: relayUrl }] }), { status: 200 });

/** 基线输入（apply、单 hostname 便于 DNS 断言；dryRun/skipVerify 按需覆盖） */
function baseInput(client, { mode = "single", hostname = HOST, ...rest } = {}) {
  return {
    client,
    hostname,
    mode,
    zone: ZONE,
    tunnel: { kind: "auto" },
    cwd: "/proj",
    skipVerify: true,
    exists: () => false,
    writeFile: async () => {},
    log: () => {},
    ...rest,
  };
}

// ---- 命名与 token 身份 ----

test("tunnelNameFor/tunnelIdentityOf: hostname -> ownership name; token -> account/tunnel identity", () => {
  assert.equal(TUNNEL_NAME_PREFIX, "opendweb-");
  assert.equal(tunnelNameFor("gaubee.tweb.xin"), "opendweb-gaubee-tweb-xin");
  assert.equal(DNS_MANAGED_BY, "managed-by=opendweb");
  const token = Buffer.from(JSON.stringify({ a: "acc9", t: "tun8", s: "sec7" })).toString("base64");
  assert.deepEqual(tunnelIdentityOf(token), { accountId: "acc9", tunnelId: "tun8" });
});

// ---- ensure tunnel ----

test("ensure tunnel (auto): existing tunnel with the ownership name is reused; no create, no token fetch", async () => {
  const g = fakeGateway({ tunnels: [{ id: "t-keep", name: "opendweb-gaubee-tweb-xin", status: "active", connections: 1 }] });
  const logs = [];
  const r = await provision({ ...baseInput(g), log: (l) => logs.push(l) });
  assert.equal(r.tunnelId, "t-keep");
  assert.equal(r.tunnelToken, null, "token only surfaces for a newly created tunnel");
  assert.deepEqual(g.calls.createTunnel, []);
  assert.deepEqual(g.calls.getTunnelToken, []);
  assert.ok(logs.some((l) => l.includes('found existing "opendweb-gaubee-tweb-xin"')));
});

test("ensure tunnel (auto): missing -> create with the ownership name; connector token fetched and returned once", async () => {
  const g = fakeGateway({});
  const plan = planExposure({ hostname: HOST, mode: "dual" });
  const r = await provision({
    ...baseInput(g, { mode: "dual" }),
    skipVerify: false,
    fetchImpl: okVerifyFetch(plan.publicRelayUrl),
  });
  assert.deepEqual(g.calls.createTunnel, [{ accountId: "acc1", name: "opendweb-gaubee-tweb-xin" }]);
  assert.equal(r.tunnelId, "t-created");
  assert.equal(r.tunnelToken, "tok-xyz");
  assert.deepEqual(g.calls.getTunnelToken, [{ accountId: "acc1", tunnelId: "t-created" }]);
  assert.deepEqual(g.calls.listTunnels, ["acc1"]);
  // 资源锚点与计划随结果返回
  assert.equal(r.accountId, "acc1");
  assert.equal(r.zoneId, "zone1");
  assert.equal(r.plan.gatewayHost, HOST);
});

test("ensure tunnel (existing id): reused directly without listing tunnels", async () => {
  const g = fakeGateway({});
  const r = await provision({ ...baseInput(g), tunnel: { kind: "existing", id: "t-given" } });
  assert.equal(r.tunnelId, "t-given");
  assert.equal(r.tunnelToken, null);
  assert.deepEqual(g.calls.listTunnels, []);
  assert.deepEqual(g.calls.createTunnel, []);
});

test("ensure tunnel (new name): explicit name wins over the ownership name", async () => {
  const g = fakeGateway({});
  await provision({ ...baseInput(g), tunnel: { kind: "new", name: "custom-name" } });
  assert.deepEqual(g.calls.createTunnel, [{ accountId: "acc1", name: "custom-name" }]);
});

// ---- ensure configuration（GET-diff -> PUT 全量） ----

test("ensure configuration: identical ingress is a no-op; drift triggers a full-replacement PUT", async () => {
  const desired = buildIngress({ mode: "single", gatewayHost: HOST, relayHost: RELAY });
  const same = fakeGateway({
    tunnels: [{ id: "t-keep", name: "opendweb-gaubee-tweb-xin", status: "active", connections: 0 }],
    configs: { "t-keep": JSON.parse(JSON.stringify(desired)) },
  });
  const logs = [];
  await provision({ ...baseInput(same), log: (l) => logs.push(l) });
  assert.deepEqual(same.calls.putConfiguration, [], "equal config must not be re-pushed");
  assert.ok(logs.some((l) => /already up to date/.test(l)));

  const drifted = fakeGateway({
    tunnels: [{ id: "t-keep", name: "opendweb-gaubee-tweb-xin", status: "active", connections: 0 }],
    configs: { "t-keep": { ingress: [{ service: "http_status:404" }] } },
  });
  await provision({ ...baseInput(drifted) });
  assert.equal(drifted.calls.putConfiguration.length, 1);
  // PUT 是全量替换：body 恰为 desired ingress（非增量 merge）
  assert.deepEqual(drifted.calls.putConfiguration[0], { accountId: "acc1", tunnelId: "t-keep", config: desired });
});

test("ensure configuration: non-ingress fields of the current config are preserved in the PUT (B2)", async () => {
  const desired = buildIngress({ mode: "single", gatewayHost: HOST, relayHost: RELAY });
  const g = fakeGateway({
    tunnels: [{ id: "t-keep", name: "opendweb-gaubee-tweb-xin", status: "active", connections: 0 }],
    configs: {
      "t-keep": {
        ingress: [{ hostname: "old.gaubee.tweb.xin", service: "http://localhost:9999" }],
        originRequest: { connectTimeout: 10, noTLSVerify: true },
        warpRouting: { enabled: false },
      },
    },
  });
  await provision({ ...baseInput(g) });
  assert.equal(g.calls.putConfiguration.length, 1, "drifted ingress must be pushed");
  const put = g.calls.putConfiguration[0];
  assert.deepEqual(put.config.ingress, desired.ingress, "ingress is replaced by the desired rules");
  // 非 ingress 字段原样带在 PUT body 里——绝不静默丢弃用户已有的全局配置
  assert.deepEqual(put.config.originRequest, { connectTimeout: 10, noTLSVerify: true });
  assert.deepEqual(put.config.warpRouting, { enabled: false });
});

test("ensure configuration: no current config -> PUT is exactly the desired ingress (nothing to preserve)", async () => {
  const g = fakeGateway({ tunnels: [{ id: "t-keep", name: "opendweb-gaubee-tweb-xin", status: "active", connections: 0 }] });
  await provision({ ...baseInput(g) });
  assert.deepEqual(g.calls.putConfiguration[0].config, buildIngress({ mode: "single", gatewayHost: HOST, relayHost: RELAY }));
});

// ---- tunnel ownership（B3a） ----

test("ensure tunnel (new name): a same-name tunnel is a hard error, not a silent reuse + overwrite (B3a)", async () => {
  const g = fakeGateway({ tunnels: [{ id: "t-taken", name: "custom-name", status: "active", connections: 0 }] });
  await assert.rejects(
    () => provision({ ...baseInput(g), tunnel: { kind: "new", name: "custom-name" } }),
    /tunnel "custom-name" already exists - choose reuse or a different name/,
  );
  assert.deepEqual(g.calls.createTunnel, [], "must not create a second same-name tunnel");
  assert.deepEqual(g.calls.putConfiguration, [], "must not overwrite the existing tunnel's config");
});

test("ensure tunnel (new name, dry-run): the collision is logged, nothing throws and nothing is written (B3a)", async () => {
  const g = fakeGateway({ tunnels: [{ id: "t-taken", name: "custom-name", status: "active", connections: 0 }] });
  const logs = [];
  await provision({
    ...baseInput(g),
    tunnel: { kind: "new", name: "custom-name" },
    dryRun: true,
    log: (l) => logs.push(l),
  });
  const out = logs.join("\n");
  assert.match(out, /dry-run: tunnel "custom-name" already exists \(rerun with reuse or a different name\)/);
  assert.deepEqual(g.calls.createTunnel, []);
  assert.deepEqual(g.calls.putConfiguration, []);
});

test("ensure tunnel (auto): a same-name ownership collision still reuses silently (unchanged 1.0.0 semantics)", async () => {
  const g = fakeGateway({ tunnels: [{ id: "t-keep", name: "opendweb-gaubee-tweb-xin", status: "active", connections: 0 }] });
  const r = await provision({ ...baseInput(g), tunnel: { kind: "auto" } });
  assert.equal(r.tunnelId, "t-keep");
  assert.deepEqual(g.calls.createTunnel, []);
});

// ---- ensure DNS ----

test("ensure DNS: no record -> CNAME created with the ownership comment (dual routes relay + gateway)", async () => {
  const g = fakeGateway({});
  await provision({ ...baseInput(g, { mode: "dual" }) });
  assert.deepEqual(g.calls.findDnsRecord.map((c) => c.fqdn), [RELAY, HOST]);
  assert.deepEqual(g.calls.createDnsRecord, [
    { zoneId: "zone1", fqdn: RELAY, target: "t-created.cfargotunnel.com", comment: DNS_MANAGED_BY },
    { zoneId: "zone1", fqdn: HOST, target: "t-created.cfargotunnel.com", comment: DNS_MANAGED_BY },
  ]);
});

test("ensure DNS: record already pointing at this tunnel -> no-op", async () => {
  const g = fakeGateway({
    dns: {
      [HOST]: { id: "r1", type: "CNAME", name: HOST, content: "t-keep.cfargotunnel.com", comment: DNS_MANAGED_BY },
    },
  });
  const logs = [];
  await provision({
    ...baseInput(g),
    tunnel: { kind: "existing", id: "t-keep" },
    log: (l) => logs.push(l),
  });
  assert.deepEqual(g.calls.createDnsRecord, []);
  assert.deepEqual(g.calls.updateDnsRecord, []);
  assert.ok(logs.some((l) => /already routed to this tunnel/.test(l)));
});

test("ensure DNS: foreign record + approved replace -> update points it at the tunnel", async () => {
  const conflict = { id: "r7", type: "A", name: HOST, content: "203.0.113.9" };
  const g = fakeGateway({ dns: { [HOST]: conflict } });
  const asked = [];
  const logs = [];
  await provision({
    ...baseInput(g),
    tunnel: { kind: "existing", id: "t-keep" },
    onDnsConflict: async (record, host) => {
      asked.push({ record, host });
      return "replace";
    },
    log: (l) => logs.push(l),
  });
  assert.deepEqual(asked, [{ record: conflict, host: HOST }]);
  assert.deepEqual(g.calls.updateDnsRecord, [
    { zoneId: "zone1", recordId: "r7", fqdn: HOST, target: "t-keep.cfargotunnel.com", comment: DNS_MANAGED_BY },
  ]);
  assert.ok(logs.some((l) => /replaced with CNAME .* \(user-approved\)/.test(l)));
});

test("ensure DNS: declined conflict aborts with ownership guidance; no callback defaults to abort", async () => {
  const g = fakeGateway({ dns: { [HOST]: { id: "r7", type: "A", name: HOST, content: "203.0.113.9" } } });
  await assert.rejects(
    () =>
      provision({
        ...baseInput(g),
        tunnel: { kind: "existing", id: "t-keep" },
        onDnsConflict: async () => "abort",
      }),
    /DNS record for gaubee\.tweb\.xin is not owned by this setup/,
  );
  assert.deepEqual(g.calls.updateDnsRecord, []);

  // 无回调（非交互）：保守 abort，绝不静默覆盖他人记录
  const g2 = fakeGateway({ dns: { [HOST]: { id: "r7", type: "A", name: HOST, content: "203.0.113.9" } } });
  await assert.rejects(
    () => provision({ ...baseInput(g2), tunnel: { kind: "existing", id: "t-keep" } }),
    /not owned by this setup/,
  );
  assert.deepEqual(g2.calls.updateDnsRecord, []);
});

// ---- dry-run ----

test("dry-run: zero control-plane writes; every step logs what would happen", async () => {
  const g = fakeGateway({});
  const writes = [];
  const logs = [];
  const r = await provision({
    ...baseInput(g, { mode: "dual" }),
    dryRun: true,
    writeFile: async (p, c) => writes.push({ p, c }),
    log: (l) => logs.push(l),
  });
  const out = logs.join("\n");
  assert.match(out, /dry-run: would create tunnel "opendweb-gaubee-tweb-xin"/);
  assert.match(out, /dry-run: would create CNAME relay\.gaubee\.tweb\.xin -> <tunnel>\.cfargotunnel\.com/);
  assert.match(out, /dry-run: would create CNAME gaubee\.tweb\.xin -> <tunnel>\.cfargotunnel\.com/);
  assert.match(out, /dry-run: would write \/proj\/opendweb\.config\.toml/);
  assert.deepEqual(g.calls.createTunnel, []);
  assert.deepEqual(g.calls.putConfiguration, []);
  assert.deepEqual(g.calls.createDnsRecord, []);
  assert.deepEqual(g.calls.updateDnsRecord, []);
  assert.deepEqual(writes, []);
  assert.equal(r.tunnelId, "", "nothing was created");
  assert.equal(r.configWritten, false);
  // DNS exact 查询仍发生（只读），但写操作为零
  assert.equal(g.calls.findDnsRecord.length, 2);
});

test("dry-run with an existing tunnel: config GET-diff still runs; drift logs the rules it would PUT", async () => {
  const g = fakeGateway({
    tunnels: [{ id: "t-keep", name: "opendweb-gaubee-tweb-xin", status: "active", connections: 0 }],
    configs: { "t-keep": { ingress: [{ service: "http_status:404" }] } },
    dns: { [HOST]: { id: "r7", type: "A", name: HOST, content: "203.0.113.9" } },
  });
  const logs = [];
  await provision({
    ...baseInput(g),
    dryRun: true,
    log: (l) => logs.push(l),
  });
  const out = logs.join("\n");
  assert.match(out, /dry-run: would PUT ingress configuration:/);
  assert.match(out, /\{"hostname":"gaubee\.tweb\.xin","path":"\^\/relay\.\*","service":"http:\/\/localhost:3340"\}/);
  assert.match(out, /dry-run: would replace it with CNAME/);
  assert.equal(g.calls.getConfiguration.length, 1);
  assert.deepEqual(g.calls.putConfiguration, []);
  assert.deepEqual(g.calls.updateDnsRecord, []);
});

// ---- 本地 config 落盘 ----

test("config write: new file gets the full TOML with resource anchors; existing file only gets a merge fragment", async () => {
  const g = fakeGateway({});
  const writes = [];
  const r = await provision({
    ...baseInput(g),
    writeFile: async (p, c) => writes.push({ p, c }),
  });
  assert.equal(r.configWritten, true);
  assert.deepEqual(writes.map((w) => w.p), [path.join("/proj", "opendweb.config.toml")]);
  const toml = writes[0].c;
  assert.match(toml, /publicGatewayUrl = "https:\/\/gaubee\.tweb\.xin"/);
  assert.match(toml, /accountId = "acc1"/);
  assert.match(toml, /zoneId = "zone1"/);
  assert.match(toml, /tunnelId = "t-created"/);

  // 已存在：绝不覆盖，输出 merge 指引片段
  const g2 = fakeGateway({});
  const writes2 = [];
  const logs = [];
  const r2 = await provision({
    ...baseInput(g2),
    exists: () => true,
    writeFile: async () => {
      throw new Error("must not overwrite an existing config");
    },
    log: (l) => logs.push(l),
  });
  assert.equal(r2.configWritten, false);
  assert.deepEqual(writes2, []);
  const out = logs.join("\n");
  assert.match(out, /already exists; merge these values manually:/);
  assert.match(out, /tunnelId = "t-created"/);
});

test("config write: explicit configPath targets the chosen file", async () => {
  const g = fakeGateway({});
  const writes = [];
  await provision({
    ...baseInput(g),
    configPath: "/elsewhere/custom.toml",
    writeFile: async (p, c) => writes.push({ p, c }),
  });
  assert.deepEqual(writes.map((w) => w.p), ["/elsewhere/custom.toml"]);
});

// ---- 端到端自检 ----

test("verify: failure fails the whole run; success logs the confirmation", async () => {
  const g = fakeGateway({});
  let fetches = 0;
  await assert.rejects(
    () =>
      provision({
        ...baseInput(g, { mode: "dual" }),
        skipVerify: false,
        verifyTimeoutMs: 250,
        fetchImpl: async () => {
          fetches += 1;
          return new Response("nope", { status: 502 });
        },
      }),
    (e) => {
      assert.match(e.message, /^verification failed:/);
      assert.match(e.message, /not reachable within 250ms/);
      return true;
    },
  );
  assert.ok(fetches >= 1);

  const g2 = fakeGateway({});
  const plan = planExposure({ hostname: HOST, mode: "dual" });
  const logs = [];
  await provision({
    ...baseInput(g2, { mode: "dual" }),
    skipVerify: false,
    fetchImpl: okVerifyFetch(plan.publicRelayUrl),
    log: (l) => logs.push(l),
  });
  assert.ok(logs.some((l) => /verified: public services\.json advertises the expected relay URL/.test(l)));
});

test("verify: skipVerify skips the end-to-end check entirely", async () => {
  const g = fakeGateway({});
  let fetches = 0;
  await provision({
    ...baseInput(g, { mode: "dual" }),
    skipVerify: true,
    fetchImpl: async () => {
      fetches += 1;
      throw new Error("verify must not run");
    },
  });
  assert.equal(fetches, 0);
});
