// CLI/入口面单测（1.0.1）：非交互 setup 的 config 锚点接线（B3b）、
// pickZoneForHostname 最长后缀匹配（B3c）、dry-run 零凭据落盘（B7——cli.run
// 与 index setup 钩子两条路径）。网关经 run 上下文注入（fake），OAuth token
// 端点经 patch globalThis.fetch 替身（getApiToken 在调用时才解析全局 fetch）。
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import cli from "../dist/cli.mjs";
import plugin, { pickZoneForHostname } from "../dist/index.mjs";

const ZONE_APEX = { id: "zone-apex", name: "example.com", accountId: "acc1", accountName: "Apex", status: "active" };
const ZONE_SUB = { id: "zone-sub", name: "a.example.com", accountId: "acc1", accountName: "Sub", status: "active" };

/** 全面 fake CfGateway（记录调用；缺省只读应答） */
function fakeGateway({ zones = [ZONE_APEX, ZONE_SUB], tunnels = [], configs = {}, dns = {} } = {}) {
  const calls = {
    listZones: 0, listTunnels: [], createTunnel: [], getConfiguration: [],
    putConfiguration: [], findDnsRecord: [], createDnsRecord: [], updateDnsRecord: [],
  };
  return {
    calls,
    tokens: [],
    async listZones() {
      calls.listZones += 1;
      return zones;
    },
    async listTunnels(accountId) {
      calls.listTunnels.push(accountId);
      return tunnels;
    },
    async createTunnel(accountId, name) {
      calls.createTunnel.push({ accountId, name });
      return { id: "t-created", name };
    },
    async getTunnelToken() {
      return "tok";
    },
    async getConfiguration(accountId, tunnelId) {
      calls.getConfiguration.push({ accountId, tunnelId });
      return configs[tunnelId] ?? null;
    },
    async putConfiguration(accountId, tunnelId, config) {
      calls.putConfiguration.push({ accountId, tunnelId, config });
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

/** DWEB_HOME/CLOUDFLARE_API_TOKEN/globalThis.fetch 的受控替换 */
async function withEnv({ home, apiToken }, fn) {
  const prevHome = process.env.DWEB_HOME;
  const prevToken = process.env.CLOUDFLARE_API_TOKEN;
  const prevFetch = globalThis.fetch;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cf-cli-"));
  const homeDir = home ?? (await fsp.mkdtemp(path.join(os.tmpdir(), "cf-home-")));
  process.env.DWEB_HOME = homeDir;
  if (apiToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
  else process.env.CLOUDFLARE_API_TOKEN = apiToken;
  try {
    return await fn({ dir, home: homeDir });
  } finally {
    if (prevHome === undefined) delete process.env.DWEB_HOME;
    else process.env.DWEB_HOME = prevHome;
    if (prevToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = prevToken;
    globalThis.fetch = prevFetch;
  }
}

/** OAuth token 端点替身：返回给定 JSON；其它 URL 一律炸（暴露意外网络） */
function tokenEndpointOnly(responseBody) {
  return async (url) => {
    assert.equal(String(url), "https://dash.cloudflare.com/oauth2/token", `unexpected fetch: ${url}`);
    return new Response(JSON.stringify(responseBody), { status: 200 });
  };
}

// ---- B3c: pickZoneForHostname ----

test("pickZoneForHostname (B3c): among exact/suffix matches the LONGEST zone name wins regardless of order", async () => {
  for (const zones of [[ZONE_APEX, ZONE_SUB], [ZONE_SUB, ZONE_APEX]]) {
    const client = { listZones: async () => zones };
    assert.equal((await pickZoneForHostname(client, "x.a.example.com")).name, "a.example.com", JSON.stringify(zones.map((z) => z.name)));
    assert.equal((await pickZoneForHostname(client, "a.example.com")).name, "a.example.com"); // 精确命中
    assert.equal((await pickZoneForHostname(client, "example.com")).name, "example.com");
  }
  // zoneId 锚点优先于任何后缀推导
  const byId = await pickZoneForHostname({ listZones: async () => [ZONE_SUB, ZONE_APEX] }, "x.a.example.com", "zone-apex");
  assert.equal(byId.name, "example.com");
  // 兜底后缀与无命中报错保持不变
  await assert.rejects(
    () => pickZoneForHostname({ listZones: async () => [ZONE_APEX] }, "other.org"),
    /no zone in this Cloudflare account matches "other\.org"/,
  );
  await assert.rejects(
    () => pickZoneForHostname({ listZones: async () => [] }, "example.com"),
    /no zones visible to this Cloudflare credential/,
  );
});

// ---- B3b: 非交互 setup 的 config 锚点 ----

test("cli setup (non-interactive, B3b): zoneId/tunnelId anchors from the config drive the run", async () => {
  await withEnv({ apiToken: "env-token-0123456789abcdef0123456789" }, async ({ dir, home }) => {
    await fsp.writeFile(
      path.join(dir, "opendweb.config.toml"),
      [
        "configVersion = 1",
        "",
        "[[plugins]]",
        'name = "cf"',
        "[plugins.options]",
        'zoneId = "zone-apex"',
        'tunnelId = "tun-anchor"',
      ].join("\n") + "\n",
      "utf8",
    );
    const gw = fakeGateway();
    const r = await cli.run({
      command: "setup",
      args: { hostname: "x.a.example.com", "skip-verify": true },
      log: () => {},
      cwd: dir,
      createGateway: async () => gw,
    });
    assert.equal(r.exit, 0);
    // zone 锚点：选了 example.com（而非最长后缀 a.example.com）
    assert.deepEqual(gw.calls.getConfiguration, [{ accountId: "acc1", tunnelId: "tun-anchor" }], "anchored zone account + tunnel id are used");
    assert.deepEqual(gw.calls.listTunnels, [], "existing-id anchor skips tunnel discovery (index.ts semantics)");
    assert.ok(gw.calls.createDnsRecord.every((c) => c.target === "tun-anchor.cfargotunnel.com"), JSON.stringify(gw.calls.createDnsRecord));
    assert.equal(
      await fsp.stat(path.join(home, "cf-auth.json")).then(() => true).catch(() => false),
      false,
      "an env token creates no stored session",
    );
  });
});

test("cli setup (non-interactive, no anchors): longest-suffix zone + auto tunnel discovery (regression)", async () => {
  await withEnv({ apiToken: "env-token-0123456789abcdef0123456789" }, async ({ dir }) => {
    const gw = fakeGateway({ tunnels: [{ id: "t-named", name: "opendweb-x-a-example-com", status: "active", connections: 0 }] });
    const r = await cli.run({
      command: "setup",
      args: { hostname: "x.a.example.com", "skip-verify": true },
      log: () => {},
      cwd: dir,
      createGateway: async () => gw,
    });
    assert.equal(r.exit, 0);
    assert.deepEqual(gw.calls.listTunnels, ["acc1"], "auto tunnel lists by the derived account");
    assert.deepEqual(gw.calls.getConfiguration, [{ accountId: "acc1", tunnelId: "t-named" }], "longest-suffix zone a.example.com derived account");
  });
});

// ---- B7: dry-run 不落盘凭据 ----

test("cli setup --dry-run (B7): an expired stored session refreshes (network read) but the auth file is untouched", async () => {
  await withEnv({}, async ({ dir, home }) => {
    const original = `${JSON.stringify({ refreshToken: "rt-old", clientId: "cid-1" }, null, 2)}\n`;
    const authFile = path.join(home, "cf-auth.json");
    await fsp.writeFile(authFile, original, "utf8");
    globalThis.fetch = tokenEndpointOnly({ access_token: "at-dry", refresh_token: "rt-rotated" });

    const gw = fakeGateway();
    const tokens = [];
    const r = await cli.run({
      command: "setup",
      args: { hostname: "x.a.example.com", "dry-run": true, "skip-verify": true },
      log: () => {},
      cwd: dir,
      createGateway: async (t) => {
        tokens.push(t);
        return gw;
      },
    });
    assert.equal(r.exit, 0);
    assert.deepEqual(tokens, ["at-dry"], "the refreshed access token reaches the gateway");
    assert.equal(await fsp.readFile(authFile, "utf8"), original, "dry-run must not rewrite the stored session (B7)");
    assert.deepEqual(gw.calls.createTunnel, [], "dry-run performs no control-plane writes");
    assert.deepEqual(gw.calls.putConfiguration, []);
    assert.deepEqual(gw.calls.createDnsRecord, []);
  });
});

test("cli setup (no dry-run): the rotation IS persisted as exactly {refreshToken, clientId} with 0600 (B4a contrast)", async () => {
  await withEnv({}, async ({ dir, home }) => {
    const authFile = path.join(home, "cf-auth.json");
    await fsp.writeFile(authFile, `${JSON.stringify({ refreshToken: "rt-old", clientId: "cid-1" }, null, 2)}\n`, "utf8");
    globalThis.fetch = tokenEndpointOnly({ access_token: "at-live", refresh_token: "rt-rotated" });

    const r = await cli.run({
      command: "setup",
      args: { hostname: "x.a.example.com", "skip-verify": true },
      log: () => {},
      cwd: dir,
      createGateway: async () => fakeGateway(),
    });
    assert.equal(r.exit, 0);
    const stored = JSON.parse(await fsp.readFile(authFile, "utf8"));
    assert.deepEqual(stored, { refreshToken: "rt-rotated", clientId: "cid-1" }, "rotation persisted, exactly two fields, no access token");
    assert.equal(statSync(authFile).mode & 0o777, 0o600);
  });
});

test("index setup hook (B7 + anchors): dryRun refreshes without persisting; tunnelId anchor skips discovery; no writes", async () => {
  await withEnv({}, async ({ dir, home }) => {
    const original = `${JSON.stringify({ refreshToken: "rt-old", clientId: "cid-1" }, null, 2)}\n`;
    const authFile = path.join(home, "cf-auth.json");
    await fsp.writeFile(authFile, original, "utf8");

    const apiCalls = [];
    const envelope = (result) =>
      new Response(
        JSON.stringify({ success: true, result, result_info: { page: 1, per_page: 50, total_pages: 1 } }),
        { status: 200 },
      );
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const method = (init.method ?? "GET").toUpperCase();
      apiCalls.push({ method, url: u });
      if (u === "https://dash.cloudflare.com/oauth2/token") {
        return new Response(JSON.stringify({ access_token: "at-hook", refresh_token: "rt-rotated" }), { status: 200 });
      }
      // REST 网关消费的是原始 CF API zone 形态（account.id 推导账户）
      if (u.startsWith("https://api.cloudflare.com/client/v4/zones?")) {
        return envelope([{ id: "zone-apex", name: "example.com", status: "active", account: { id: "acc1", name: "Apex" } }]);
      }
      if (u.includes("/cfd_tunnel/tun-anchor/configurations")) return envelope(null);
      if (u.includes("/dns_records?")) return envelope([]);
      throw new Error(`unexpected fetch: ${method} ${u}`);
    };

    const res = await plugin.hooks.setup({
      options: { hostname: "x.example.com", dryRun: true, tunnelId: "tun-anchor", skipVerify: true },
      cwd: dir,
    });
    assert.equal(res.done, true);
    assert.equal(await fsp.readFile(authFile, "utf8"), original, "hook dry-run must not persist the rotated session (B7)");
    assert.ok(
      apiCalls.every((c) => c.method === "GET" || c.url === "https://dash.cloudflare.com/oauth2/token"),
      `no control-plane writes in dry-run: ${JSON.stringify(apiCalls)}`,
    );
    assert.ok(!apiCalls.some((c) => c.url.includes("/cfd_tunnel?")), "tunnelId anchor skips tunnel discovery");
  });
});
