// 纯函数单测（1.0.0 精简面）：cf-api（token 凭据工具）+ route-model（暴露规划、
// ingress 形态、TOML 渲染、端到端自检）。控制面 REST 网关在 cf-client.test.mjs，
// 幂等编排在 provision.test.mjs，spawn 生命周期在 connector.test.mjs。
import test from "node:test";
import assert from "node:assert/strict";

import { extractTunnelToken, tokenSummary, decodeTunnelToken } from "../dist/cf-api.mjs";
import { planExposure, buildIngress, renderConfigToml, verifyExposure } from "../dist/route-model.mjs";

const TOKEN = Buffer.from(JSON.stringify({ a: "acc123", t: "tun456", s: "sec789" })).toString("base64");

// ---- cf-api: extractTunnelToken / tokenSummary / decodeTunnelToken ----

test("extractTunnelToken: pulls the eyJ base64url blob out of pasted install commands; no match -> null", () => {
  const raw = `eyJ${"A1b2c3D4e5".repeat(18)}`; // eyJ + 90 chars base64url
  assert.equal(extractTunnelToken(`sudo cloudflared service install ${raw}`), raw);
  assert.equal(extractTunnelToken(`multi\nline\ndocs ${raw}\nand ${raw}b`), raw); // 首个匹配
  assert.equal(extractTunnelToken(`  \n${raw}\n  `), raw); // 首尾空白剥离
  assert.equal(extractTunnelToken("hello world"), null);
  assert.equal(extractTunnelToken(`eyJ${"a".repeat(20)}`), null); // 长度 < 80 不是 CF token
  assert.equal(extractTunnelToken(""), null);
});

test("tokenSummary: head8...tail6 + length; short tokens omit the tail", () => {
  const tok = `eyJ${"A1b2c3D4e5".repeat(18)}`;
  assert.equal(tokenSummary(tok), `${tok.slice(0, 8)}...${tok.slice(-6)} (${tok.length} chars)`);
  // 短 token：尾巴会与头部重叠即省略，只剩头 + 长度
  assert.equal(tokenSummary("abc"), "abc... (3 chars)");
  assert.equal(tokenSummary("abcdefghijklmno"), "abcdefgh...jklmno (15 chars)"); // 15 > 14 -> 有尾
});

test("decodeTunnelToken: base64 {a,t,s}; garbage rejected with user-facing message", () => {
  assert.deepEqual(decodeTunnelToken(TOKEN), { accountTag: "acc123", tunnelId: "tun456", apiToken: "sec789" });
  assert.throws(() => decodeTunnelToken("not-a-token"), /not a valid TUNNEL_TOKEN/);
  assert.throws(() => decodeTunnelToken("not-a-token"), /Zero Trust -> Networks -> Tunnels/);
  assert.throws(() => decodeTunnelToken(Buffer.from("{}").toString("base64")), /not a valid TUNNEL_TOKEN/);
  assert.throws(() => decodeTunnelToken(Buffer.from(JSON.stringify({ a: "x", t: "y" })).toString("base64")), /not a valid TUNNEL_TOKEN/);
});

test("decodeTunnelToken: a/t/s charset whitelist (URL path / header injection guard)", () => {
  const mk = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
  // a/t 拼进 API URL 路径——路径穿越必须拒绝
  assert.throws(() => decodeTunnelToken(mk({ a: "../escape", t: "t", s: "s" })), /not a valid TUNNEL_TOKEN/);
  assert.throws(() => decodeTunnelToken(mk({ a: "a", t: "t/evil", s: "s" })), /not a valid TUNNEL_TOKEN/);
  // s 进 Authorization 头——CRLF 头注入必须拒绝
  assert.throws(() => decodeTunnelToken(mk({ a: "a", t: "t", s: "s\r\nX-Evil: 1" })), /not a valid TUNNEL_TOKEN/);
  assert.throws(() => decodeTunnelToken(mk({ a: "a b", t: "t", s: "s" })), /not a valid TUNNEL_TOKEN/);
});

// ---- route-model: planExposure ----

test("planExposure: dual derives relay.<gateway>; single shares one host", () => {
  const dual = planExposure({ hostname: "Dweb.Example.COM" });
  assert.equal(dual.mode, "dual");
  assert.equal(dual.gatewayHost, "dweb.example.com"); // 归一小写
  assert.equal(dual.relayHost, "relay.dweb.example.com");
  assert.equal(dual.publicGatewayUrl, "https://dweb.example.com");
  assert.equal(dual.publicRelayUrl, "https://relay.dweb.example.com");
  const single = planExposure({ hostname: "dweb.example.com", mode: "single" });
  assert.equal(single.publicGatewayUrl, single.publicRelayUrl);
});

test("planExposure: hostname must be a routable DNS name — junk and injection rejected", () => {
  for (const bad of [
    "foo.com&account.id=evil",
    "not a host",
    "localhost", // 单段不是可路由域名
    "",
    "dweb..example.com",
    "-dweb.example.com",
    "dweb.example.com:8443",
    `${"a".repeat(64)}.example.com`, // label > 63
  ]) {
    assert.throws(() => planExposure({ hostname: bad }), /not a routable DNS hostname/, bad);
  }
  // 尾点合法（归一去除）；深层次不再受段数限制
  const fqdn = planExposure({ hostname: "dweb.example.com." });
  assert.equal(fqdn.gatewayHost, "dweb.example.com");
  const deep = planExposure({ hostname: "a.b.c.d.e.f.g.h.i.j.k.example.com" });
  assert.equal(deep.relayHost, "relay.a.b.c.d.e.f.g.h.i.j.k.example.com");
  // 派生后的 relay.<hostname> 同样必须落在 DNS 253 上限内
  const relayTooLong = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(60)}`;
  assert.equal(relayTooLong.length, 252);
  assert.throws(() => planExposure({ hostname: relayTooLong }), /not a routable DNS hostname/);
});

// ---- route-model: buildIngress ----

test("buildIngress: dual hostnames and single-domain path routing; 404 catch-all always last", () => {
  const dual = buildIngress({ mode: "dual", gatewayHost: "dweb.example.com", relayHost: "relay.dweb.example.com" });
  assert.deepEqual(dual.ingress, [
    { hostname: "relay.dweb.example.com", service: "http://localhost:3340" },
    { hostname: "dweb.example.com", service: "http://localhost:8787" },
    { service: "http_status:404" },
  ]);

  const single = buildIngress({ mode: "single", gatewayHost: "dweb.example.com", relayHost: "relay.dweb.example.com" });
  assert.equal(single.ingress[0].path, "^/relay.*");
  assert.equal(single.ingress[0].service, "http://localhost:3340");
  assert.equal(single.ingress[1].path, "^/ping.*");
  assert.equal(single.ingress[2].service, "http://localhost:8787");
  assert.equal(single.ingress.at(-1).service, "http_status:404");
  // 顺序即优先级：relay/ping 分流必须先于 gateway 兜底
  const services = single.ingress.map((r) => r.service);
  assert.ok(services.indexOf("http://localhost:3340") < services.indexOf("http://localhost:8787"));

  // 自定义 service 端口透传（非 localhost 部署形态）
  const custom = buildIngress({
    mode: "dual",
    gatewayHost: "gw.example.com",
    relayHost: "relay.gw.example.com",
    gatewayService: "http://127.0.0.1:9000",
    relayService: "http://127.0.0.1:9001",
  });
  assert.equal(custom.ingress[0].service, "http://127.0.0.1:9001");
  assert.equal(custom.ingress[1].service, "http://127.0.0.1:9000");
});

// ---- route-model: renderConfigToml ----

test("renderConfigToml: deterministic output, loadable by smol-toml without anchors", async () => {
  const plan = planExposure({ hostname: "dweb.example.com" });
  const toml = renderConfigToml({ plan, tokenEnv: "TUNNEL_TOKEN" });
  assert.match(toml, /configVersion = 1/);
  assert.match(toml, /gatewayBind = "0\.0\.0\.0:8787"/);
  assert.match(toml, /relayBind = "0\.0\.0\.0:3340"/);
  assert.match(toml, /publicGatewayUrl = "https:\/\/dweb\.example\.com"/);
  assert.match(toml, /name = "cf"/);
  assert.match(toml, /tokenEnv = "TUNNEL_TOKEN"/);
  assert.ok(!toml.includes("accountId"), "no anchors -> no anchor keys");
  // 与 opendweb CLI 同一解析器 round-trip
  const { parse } = await import("smol-toml");
  const parsed = parse(toml);
  assert.equal(parsed.server.publicRelayUrl, "https://relay.dweb.example.com");
  assert.deepEqual(parsed.plugins, [{ name: "cf", options: { tokenEnv: "TUNNEL_TOKEN" } }]);
});

test("renderConfigToml: resource anchors land in [plugins.options] (parse round-trip)", async () => {
  const plan = planExposure({ hostname: "gaubee.tweb.xin" });
  const toml = renderConfigToml({
    plan,
    resource: { accountId: "acc1", zoneId: "zone1", tunnelId: "tun9" },
  });
  const { parse } = await import("smol-toml");
  const parsed = parse(toml);
  assert.deepEqual(parsed.plugins, [
    { name: "cf", options: { tokenEnv: "TUNNEL_TOKEN", accountId: "acc1", zoneId: "zone1", tunnelId: "tun9" } },
  ]);
  // 部分锚点：只写给出的键
  const partial = parse(renderConfigToml({ plan, resource: { tunnelId: "tun9" } }));
  assert.equal(partial.plugins[0].options.tunnelId, "tun9");
  assert.ok(!("zoneId" in partial.plugins[0].options));
});

// ---- route-model: verifyExposure ----

test("verifyExposure: ok when services.json advertises the expected relay URL", async () => {
  const manifest = { services: [{ name: "relay", enabled: true, url: "https://relay.dweb.example.com" }] };
  const seen = [];
  const v = await verifyExposure({
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), signal: init?.signal });
      return new Response(JSON.stringify(manifest), { status: 200 });
    },
    publicGatewayUrl: "https://dweb.example.com",
    expectedRelayUrl: "https://relay.dweb.example.com",
    timeoutMs: 1000,
  });
  assert.equal(v.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://dweb.example.com/services.json");
  assert.ok(seen[0].signal instanceof AbortSignal, "every fetch carries an AbortSignal bounded by the remaining time");
});

test("verifyExposure: mismatch and disabled relay are failures with the reason in error", async () => {
  const mismatch = await verifyExposure({
    fetchImpl: async () =>
      new Response(JSON.stringify({ services: [{ name: "relay", enabled: true, url: "https://relay.dweb.example.com" }] }), { status: 200 }),
    publicGatewayUrl: "https://dweb.example.com",
    expectedRelayUrl: "https://other.example.com",
    timeoutMs: 300,
  });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /relay URL mismatch/);

  const disabled = await verifyExposure({
    fetchImpl: async () => new Response(JSON.stringify({ services: [{ name: "relay", enabled: false, url: null }] }), { status: 200 }),
    publicGatewayUrl: "https://dweb.example.com",
    expectedRelayUrl: "https://relay.dweb.example.com",
    timeoutMs: 300,
  });
  assert.equal(disabled.ok, false);
  assert.match(disabled.error, /does not advertise an enabled relay/);

  const httpErr = await verifyExposure({
    fetchImpl: async () => new Response("bad gateway", { status: 502 }),
    publicGatewayUrl: "https://dweb.example.com",
    expectedRelayUrl: "https://relay.dweb.example.com",
    timeoutMs: 300,
  });
  assert.match(httpErr.error, /HTTP 502/);
});

test("verifyExposure: onProgress observes each retry with the last error", async () => {
  const infos = [];
  const v = await verifyExposure({
    fetchImpl: async () => new Response("nope", { status: 404 }),
    publicGatewayUrl: "https://dweb.example.com",
    expectedRelayUrl: "https://relay.dweb.example.com",
    timeoutMs: 400,
    onProgress: (i) => infos.push(i),
  });
  assert.equal(v.ok, false);
  assert.ok(infos.length >= 1, "progress reported");
  assert.match(infos.at(-1).lastError, /HTTP 404/);
  assert.ok(infos.every((i) => i.elapsedMs >= 0));
});

test("verifyExposure: strict deadline — signal-ignoring fetch cannot stall past timeoutMs", async () => {
  const t0 = Date.now();
  const v = await verifyExposure({
    // 永不 resolve 且无视 signal；附带 ref'd 定时器保活事件循环
    fetchImpl: () => {
      setTimeout(() => {}, 60000);
      return new Promise(() => {});
    },
    publicGatewayUrl: "https://dweb.example.com",
    expectedRelayUrl: "https://relay.dweb.example.com",
    timeoutMs: 100,
  });
  const elapsed = Date.now() - t0;
  assert.equal(v.ok, false);
  assert.match(v.error, /not reachable within 100ms/);
  assert.match(v.error, /fetch ignored the abort signal/);
  assert.ok(elapsed < 1500, `should return near the deadline, took ${elapsed}ms`);
});
