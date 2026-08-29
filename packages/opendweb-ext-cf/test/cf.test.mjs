// cf-api 与 wizard 纯函数单测：token 解码、ingress 形态、TOML 渲染、
// verify 断言逻辑（mock fetch）、API 错误路径。
import test from "node:test";
import assert from "node:assert/strict";

import { decodeTunnelToken, buildIngress, pushIngress, routeDns } from "../src/cf-api.js";
import { planExposure, renderConfigToml, verifyExposure } from "../src/wizard.js";

const TOKEN = Buffer.from(JSON.stringify({ a: "acc123", t: "tun456", s: "sec789" })).toString("base64");

test("decodeTunnelToken: base64 {a,t,s}; garbage rejected with user-facing message", () => {
  assert.deepEqual(decodeTunnelToken(TOKEN), { accountTag: "acc123", tunnelId: "tun456", apiToken: "sec789" });
  assert.throws(() => decodeTunnelToken("not-a-token"), /not a valid TUNNEL_TOKEN/);
  assert.throws(() => decodeTunnelToken(Buffer.from("{}").toString("base64")), /not a valid TUNNEL_TOKEN/);
});

test("buildIngress: dual hostname (default) and single-domain path routing", () => {
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
});

test("pushIngress: PUT configurations; API error surfaces code+message", async () => {
  const calls = [];
  const okFetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };
  await pushIngress({ fetchImpl: okFetch, accountTag: "a", tunnelId: "t", apiToken: "s", ingress: { ingress: [] } });
  assert.match(calls[0].url, /\/accounts\/a\/cfd_tunnel\/t\/configurations$/);
  assert.equal(calls[0].init.method, "PUT");
  assert.match(calls[0].init.headers.Authorization, /^Bearer s$/);

  const badFetch = async () => new Response(JSON.stringify({ success: false, errors: [{ code: 9, message: "bad ingress" }] }), { status: 400 });
  await assert.rejects(
    () => pushIngress({ fetchImpl: badFetch, accountTag: "a", tunnelId: "t", apiToken: "s", ingress: { ingress: [] } }),
    /9: bad ingress/,
  );
});

test("routeDns: idempotent on existing record (81057); zone failure prints manual CNAME path", async () => {
  const zoneFetch = async (url) =>
    new Response(JSON.stringify({ result: [{ id: "zone1" }] }), { status: 200 });
  const dnsFetch = async (url, init) => {
    if (url.includes("/zones?")) return zoneFetch(url);
    if (init?.method === "POST") {
      return new Response(JSON.stringify({ errors: [{ code: 81057, message: "record already exists" }] }), { status: 400 });
    }
    return new Response(JSON.stringify({ result: [] }), { status: 200 });
  };
  const done = await routeDns({ fetchImpl: dnsFetch, accountTag: "a", tunnelId: "t", apiToken: "s", hostnames: ["x.example.com"] });
  assert.deepEqual(done, ["x.example.com"]);

  const noZone = async () => new Response(JSON.stringify({ result: [] }), { status: 200 });
  await assert.rejects(
    () => routeDns({ fetchImpl: noZone, accountTag: "a", tunnelId: "t", apiToken: "s", hostnames: ["x.example.com"] }),
    /create CNAME x\.example\.com -> t\.cfargotunnel\.com manually/,
  );
});

test("planExposure: dual derives relay.<gateway>; single shares one host", () => {
  const dual = planExposure({ hostname: "Dweb.Example.COM" });
  assert.equal(dual.gatewayHost, "dweb.example.com"); // 归一小写
  assert.equal(dual.relayHost, "relay.dweb.example.com");
  assert.equal(dual.publicRelayUrl, "https://relay.dweb.example.com");
  const single = planExposure({ hostname: "dweb.example.com", mode: "single" });
  assert.equal(single.publicGatewayUrl, single.publicRelayUrl);
});

test("renderConfigToml: deterministic, loadable by the CLI schema (round-trip via smol-toml)", async () => {
  const plan = planExposure({ hostname: "dweb.example.com" });
  const toml = renderConfigToml({ plan, tokenEnv: "TUNNEL_TOKEN" });
  assert.match(toml, /configVersion = 1/);
  assert.match(toml, /publicGatewayUrl = "https:\/\/dweb\.example\.com"/);
  assert.match(toml, /name = "cf"/);
  assert.match(toml, /tokenEnv = "TUNNEL_TOKEN"/);
  // 与 opendweb CLI 同一解析器 round-trip
  const { parse } = await import("smol-toml");
  const parsed = parse(toml);
  assert.equal(parsed.server.publicRelayUrl, "https://relay.dweb.example.com");
  assert.deepEqual(parsed.plugins, [{ name: "cf", options: { tokenEnv: "TUNNEL_TOKEN" } }]);
});

test("verifyExposure: asserts relay URL match; mismatch and disabled relay are failures", async () => {
  const manifest = { services: [{ name: "relay", enabled: true, url: "https://relay.dweb.example.com" }] };
  const ok = await verifyExposure({
    fetchImpl: async () => new Response(JSON.stringify(manifest), { status: 200 }),
    publicGatewayUrl: "https://dweb.example.com",
    expectedRelayUrl: "https://relay.dweb.example.com",
    timeoutMs: 1000,
  });
  assert.equal(ok.ok, true);

  const mismatch = await verifyExposure({
    fetchImpl: async () => new Response(JSON.stringify(manifest), { status: 200 }),
    publicGatewayUrl: "https://dweb.example.com",
    expectedRelayUrl: "https://other.example.com",
    timeoutMs: 1000,
  });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /relay URL mismatch/);

  const disabled = await verifyExposure({
    fetchImpl: async () => new Response(JSON.stringify({ services: [{ name: "relay", enabled: false, url: null }] }), { status: 200 }),
    publicGatewayUrl: "https://dweb.example.com",
    expectedRelayUrl: "https://relay.dweb.example.com",
    timeoutMs: 1000,
  });
  assert.match(disabled.error, /relay disabled/);
});
