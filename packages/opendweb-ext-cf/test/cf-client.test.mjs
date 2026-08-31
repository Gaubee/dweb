// REST 网关单测（createRestGateway）：注入 fake fetchImpl 对拍官方端点契约——
// 手动分页（page/per_page=50 -> result_info.total_pages）、zone.account 推导、
// token 端点的纯字符串 result、configurations PUT 全量替换形态、DNS 记录
// CRUD 载荷，以及 CfApiError 归一（success:false + errors 数组 / 非 2xx HTTP）。
// SDK 网关按约定不测（包待安装；仅验证未注入 loadSdk 时的显式拒绝）。
import test from "node:test";
import assert from "node:assert/strict";

import { createRestGateway, createSdkGateway, createGateway, CfApiError } from "../dist/cf-client.mjs";

const CF_API = "https://api.cloudflare.com/client/v4";

/** JSON 信封 Response（CF API 形态：{success, result, result_info, errors}） */
const envelope = (body, status = 200) => new Response(JSON.stringify(body), { status });

/** 记录请求并按路由表应答的路由 fetch；未命中即抛错（暴露意外端点） */
function routingFetch(routes) {
  const seen = [];
  const f = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = (init.method ?? "GET").toUpperCase();
    seen.push({ url: u, method, init, auth: init.headers?.Authorization });
    for (const r of routes) {
      if (r.method !== method) continue;
      if (typeof r.path === "string" ? u.pathname === r.path : r.path.test(u.pathname)) {
        return typeof r.reply === "function" ? await r.reply(u, init, seen) : r.reply;
      }
    }
    throw new Error(`unexpected request: ${method} ${u.pathname}${u.search}`);
  };
  f.seen = seen;
  return f;
}

test("listZones: manual pagination to result_info.total_pages; account derived from zone.account; auth header on every page", async () => {
  const f = routingFetch([
    {
      method: "GET",
      path: "/client/v4/zones",
      reply: (u) => {
        assert.equal(u.searchParams.get("per_page"), "50");
        if (u.searchParams.get("page") === "1") {
          return envelope({
            success: true,
            result: [
              { id: "z1", name: "example.com", status: "active", account: { id: "acc1", name: "Acme Inc" } },
              { id: "z2", name: "no-account.example.com", status: "active" }, // 无 account.id -> 过滤
              { name: "no-id.example.com", account: { id: "accX" } }, // 无 id -> 过滤
            ],
            result_info: { page: 1, per_page: 50, total_pages: 2 },
          });
        }
        assert.equal(u.searchParams.get("page"), "2");
        return envelope({
          success: true,
          result: [{ id: "z3", name: "tweb.xin", status: "pending", account: { id: "acc2" } }],
          result_info: { page: 2, per_page: 50, total_pages: 2 },
        });
      },
    },
  ]);
  const gw = await createRestGateway("tk", f);
  const zones = await gw.listZones();
  assert.deepEqual(zones, [
    { id: "z1", name: "example.com", accountId: "acc1", accountName: "Acme Inc", status: "active" },
    { id: "z3", name: "tweb.xin", accountId: "acc2", accountName: "", status: "pending" },
  ]);
  assert.equal(f.seen.length, 2, "exactly two page requests");
  assert.ok(f.seen.every((r) => r.auth === "Bearer tk"), "Bearer apiToken on every request");
});

test("listTunnels: is_deleted=false filter, connections array length; missing fields tolerated", async () => {
  const f = routingFetch([
    {
      method: "GET",
      path: "/client/v4/accounts/acc1/cfd_tunnel",
      reply: (u) => {
        assert.equal(u.searchParams.get("is_deleted"), "false");
        assert.equal(u.searchParams.get("page"), "1");
        return envelope({
          success: true,
          result: [
            { id: "t1", name: "opendweb-gaubee-tweb-xin", status: "active", connections: [{}, {}] },
            { id: "t2", name: "legacy" }, // 无 status/connections -> 缺省
          ],
          result_info: { page: 1, per_page: 50, total_pages: 1 },
        });
      },
    },
  ]);
  const gw = await createRestGateway("tk", f);
  const tunnels = await gw.listTunnels("acc1");
  assert.deepEqual(tunnels, [
    { id: "t1", name: "opendweb-gaubee-tweb-xin", status: "active", connections: 2 },
    { id: "t2", name: "legacy", status: "", connections: 0 },
  ]);
});

test("createTunnel: POST body {name, config_src:'cloudflare'}; returns {id,name}", async () => {
  const f = routingFetch([
    {
      method: "POST",
      path: "/client/v4/accounts/acc1/cfd_tunnel",
      reply: (u, init) => {
        assert.deepEqual(JSON.parse(init.body), { name: "opendweb-gaubee-tweb-xin", config_src: "cloudflare" });
        return envelope({ success: true, result: { id: "t9", name: "opendweb-gaubee-tweb-xin" } });
      },
    },
  ]);
  const gw = await createRestGateway("tk", f);
  const created = await gw.createTunnel("acc1", "opendweb-gaubee-tweb-xin");
  assert.deepEqual(created, { id: "t9", name: "opendweb-gaubee-tweb-xin" });
  // success 但无 id：显式报错而非静默
  const f2 = routingFetch([
    { method: "POST", path: "/client/v4/accounts/acc1/cfd_tunnel", reply: envelope({ success: true, result: {} }) },
  ]);
  const gw2 = await createRestGateway("tk", f2);
  await assert.rejects(() => gw2.createTunnel("acc1", "x"), /tunnel create returned no id/);
});

test("getTunnelToken: result is a plain string in the envelope; empty token rejected", async () => {
  const f = routingFetch([
    { method: "GET", path: "/client/v4/accounts/acc1/cfd_tunnel/t9/token", reply: envelope({ success: true, result: "tok-xyz" }) },
    { method: "GET", path: "/client/v4/accounts/acc1/cfd_tunnel/t8/token", reply: envelope({ success: true, result: "" }) },
  ]);
  const gw = await createRestGateway("tk", f);
  assert.equal(await gw.getTunnelToken("acc1", "t9"), "tok-xyz");
  await assert.rejects(() => gw.getTunnelToken("acc1", "t8"), /empty tunnel token/);
});

test("configurations: GET returns the whole config object; PUT sends the full config (non-ingress fields preserved, B2)", async () => {
  const ingress = [{ hostname: "relay.dweb.example.com", service: "http://localhost:3340" }, { service: "http_status:404" }];
  const f = routingFetch([
    { method: "GET", path: "/client/v4/accounts/acc1/cfd_tunnel/t9/configurations", reply: envelope({ success: true, result: { config: { ingress, originRequest: { connectTimeout: 10 }, warpRouting: { enabled: true } } } }) },
    { method: "GET", path: "/client/v4/accounts/acc1/cfd_tunnel/t8/configurations", reply: envelope({ success: true, result: null }) },
    { method: "GET", path: "/client/v4/accounts/acc1/cfd_tunnel/t7/configurations", reply: envelope({ success: true, result: { config: { originRequest: { connectTimeout: 1 } } } }) },
    {
      method: "PUT",
      path: "/client/v4/accounts/acc1/cfd_tunnel/t9/configurations",
      reply: (u, init) => {
        // 全量替换：body 是整个 config 对象（非 ingress 字段原样保留）
        assert.deepEqual(JSON.parse(init.body), {
          config: { ingress, originRequest: { connectTimeout: 10 }, warpRouting: { enabled: true } },
        });
        return envelope({ success: true, result: null });
      },
    },
  ]);
  const gw = await createRestGateway("tk", f);
  assert.deepEqual(await gw.getConfiguration("acc1", "t9"), {
    ingress,
    originRequest: { connectTimeout: 10 },
    warpRouting: { enabled: true },
  });
  assert.equal(await gw.getConfiguration("acc1", "t8"), null);
  // config 无 ingress 字段：视为无配置（返回 null，不让 undefined 进 PUT 链）
  assert.equal(await gw.getConfiguration("acc1", "t7"), null);
  await gw.putConfiguration("acc1", "t9", { ingress, originRequest: { connectTimeout: 10 }, warpRouting: { enabled: true } });
});

test("dns records: find by encoded name query, create CNAME proxied with comment, update by record id", async () => {
  const f = routingFetch([
    {
      method: "GET",
      path: "/client/v4/zones/z1/dns_records",
      reply: (u) => {
        assert.equal(u.searchParams.get("name"), "relay.example.com");
        assert.ok(u.search.includes("name=relay.example.com"), "fqdn is URL-encoded into the query");
        return envelope({
          success: true,
          result: [
            { id: "r1", type: "CNAME", name: "relay.example.com", content: "t9.cfargotunnel.com", comment: "managed-by=opendweb" },
          ],
        });
      },
    },
    { method: "GET", path: "/client/v4/zones/z1/dns_records", reply: envelope({ success: true, result: [] }) },
    {
      method: "POST",
      path: "/client/v4/zones/z1/dns_records",
      reply: (u, init) => {
        assert.deepEqual(JSON.parse(init.body), {
          type: "CNAME",
          name: "relay.example.com",
          content: "t9.cfargotunnel.com",
          proxied: true,
          comment: "managed-by=opendweb",
        });
        return envelope({ success: true, result: { id: "r2" } });
      },
    },
    {
      method: "PUT",
      path: "/client/v4/zones/z1/dns_records/r1",
      reply: (u, init) => {
        assert.deepEqual(JSON.parse(init.body), {
          type: "CNAME",
          name: "relay.example.com",
          content: "t9.cfargotunnel.com",
          proxied: true,
          comment: "managed-by=opendweb",
        });
        return envelope({ success: true, result: { id: "r1" } });
      },
    },
  ]);
  const gw = await createRestGateway("tk", f);
  assert.deepEqual(await gw.findDnsRecord("z1", "relay.example.com"), {
    id: "r1",
    type: "CNAME",
    name: "relay.example.com",
    content: "t9.cfargotunnel.com",
    comment: "managed-by=opendweb",
  });
  // 无 comment 字段的记录：返回摘要不含 comment 键
  const f2 = routingFetch([
    {
      method: "GET",
      path: "/client/v4/zones/z1/dns_records",
      reply: envelope({ success: true, result: [{ id: "r9", type: "A", name: "x.example.com", content: "203.0.113.9" }] }),
    },
  ]);
  const rec = await (await createRestGateway("tk", f2)).findDnsRecord("z1", "x.example.com");
  assert.equal(rec.comment, undefined);
  await gw.createDnsRecord("z1", "relay.example.com", "t9.cfargotunnel.com", "managed-by=opendweb");
  await gw.updateDnsRecord("z1", "r1", "relay.example.com", "t9.cfargotunnel.com", "managed-by=opendweb");
});

test("error normalization: success:false surfaces CF error codes; non-2xx surfaces the HTTP status", async () => {
  const f = routingFetch([
    {
      method: "GET",
      path: "/client/v4/zones",
      reply: new Response(JSON.stringify({ success: false, errors: [{ code: 9, message: "bad ingress" }] }), { status: 400 }),
    },
  ]);
  const gw = await createRestGateway("tk", f);
  await assert.rejects(
    () => gw.listZones(),
    (e) => {
      assert.ok(e instanceof CfApiError);
      assert.equal(e.status, 400);
      assert.match(e.message, /Cloudflare API rejected \/zones\?page=1&per_page=50 \(HTTP 400\)/);
      assert.match(e.message, /9: bad ingress/);
      return true;
    },
  );

  // 非 JSON 正文 + 非 2xx：仍报状态码，不因 body 解析失败而崩溃
  const f2 = routingFetch([
    { method: "GET", path: "/client/v4/zones", reply: new Response("gateway down", { status: 503 }) },
  ]);
  const gw2 = await createRestGateway("tk", f2);
  await assert.rejects(() => gw2.listZones(), (e) => /HTTP 503/.test(e.message));
});

test("network failure is wrapped with the action context (toUserError path)", async () => {
  const boom = async () => {
    throw new TypeError("fetch failed");
  };
  const gw = await createRestGateway("tk", boom);
  await assert.rejects(() => gw.listZones(), (e) => {
    assert.ok(e instanceof CfApiError);
    assert.match(e.message, /listing zones failed: fetch failed/);
    return true;
  });
});

test("createSdkGateway mounts an injected SDK client; createGateway exposes the full gateway surface", async () => {
  // tree-shakable createClient 的使用面子集（7.1.0 实测：单 options 对象，
  // resources 内联——B1 修复后的注入契约）
  const calls = [];
  const fakeResource = { _key: ["fake"] };
  const fakeClient = {
    zones: { list: async function* () {} },
    dns: { records: { list: async () => ({ result: [] }), create: async () => ({}), update: async () => ({}) } },
    zeroTrust: { tunnels: { cloudflared: {
      list: async function* () {},
      create: async () => ({}),
      token: { get: async () => "t" },
      configurations: { get: async () => ({}), update: async () => ({}) },
    } } },
  };
  const gw = await createSdkGateway("tk", {
    loadSdk: async () => ({
      createClient: (o) => {
        calls.push(o);
        return fakeClient;
      },
      resources: [fakeResource],
    }),
  });
  assert.equal(calls.length, 1, "createClient called once");
  assert.equal(calls[0].apiToken, "tk");
  assert.deepEqual(calls[0].resources, [fakeResource], "resources are forwarded inline in the single options object");
  const gwRest = await createGateway("tk");
  for (const m of [
    "listZones",
    "listTunnels",
    "createTunnel",
    "getTunnelToken",
    "getConfiguration",
    "putConfiguration",
    "findDnsRecord",
    "createDnsRecord",
    "updateDnsRecord",
  ]) {
    assert.equal(typeof gw[m], "function", `sdk gateway method ${m}`);
    assert.equal(typeof gwRest[m], "function", `rest gateway method ${m}`);
  }
});

test("createSdkGateway (default loader, B1): constructs from the bundled leaf modules without throwing; no network at construction", async () => {
  const prev = process.env.CF_CLIENT;
  delete process.env.CF_CLIENT;
  try {
    // 不注入 loadSdk：默认 loader 动态 import 打进 dist 的 leaf 资源模块
    // （zones/dns/zero-trust）。构造是纯挂载——不发生任何网络请求。
    const gw = await createSdkGateway("x");
    for (const m of ["listZones", "listTunnels", "createTunnel", "getConfiguration", "putConfiguration"]) {
      assert.equal(typeof gw[m], "function", `gateway method ${m} present after leaf-module construction`);
    }
  } finally {
    if (prev !== undefined) process.env.CF_CLIENT = prev;
  }
});
