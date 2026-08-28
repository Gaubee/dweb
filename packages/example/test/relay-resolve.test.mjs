// Unit tests for src/relay-resolve.mjs: address resolution (design D2 step 3)
// and the bootstrap state machine wiring. services.json responses come from
// the frozen C0 fixtures where possible; httpGet is always mocked.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeRelayInput,
  resolveOneRelay,
  resolveRelayUrls,
  bootstrapRelay,
  probeRelayUrls,
} from "../src/relay-resolve.mjs";
import { CliError } from "../src/errors.mjs";

const FIXTURES = JSON.parse(
  readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../openspec/changes/connectivity-ux-hardening/contracts/services.fixtures.json",
    ),
    "utf8",
  ),
);

const GW = "http://192.168.2.13:8787";
const LEGACY = "http://192.168.2.13:3340";

function svc(u) {
  return u.replace(/\/+$/, "") + "/services.json";
}

/**
 * @param {{ [url: string]: { status?: number, body?: string } | { ok: false } }} routes
 */
function mockGet(routes) {
  const calls = [];
  const doGet = async (url, opts = {}) => {
    calls.push({ url, policy: opts.policy ?? "none" });
    const hit = routes[url];
    if (hit === undefined) throw new Error(`unexpected request ${url}`);
    if ("ok" in hit && hit.ok === false) return { ok: false, reason: "timeout" };
    const r = /** @type {any} */ (hit);
    return { ok: true, status: r.status ?? 200, contentType: r.contentType ?? "application/json", body: r.body ?? "" };
  };
  return { doGet, calls };
}

// ---------------------------------------------------------------------------
// fixtures (contracts/services.fixtures.json)
// ---------------------------------------------------------------------------

test("frozen fixture cases resolve to expectedClientRelays / warnings", async () => {
  for (const c of FIXTURES.cases) {
    const routes = { [svc(GW)]: { status: 200, body: JSON.stringify(c.manifest) } };
    const m = mockGet(routes);
    const r = await resolveRelayUrls([GW], { policy: "none", httpGet: m.doGet });
    assert.deepEqual(r.urls, c.expectedClientRelays, c.name);
    if (c.expectedClientWarning === null) {
      assert.equal(r.warnings.length, 0, `${c.name}: no warnings expected`);
    } else {
      const joined = r.warnings.join("; ");
      assert.ok(
        joined.includes(c.expectedClientWarning),
        `${c.name}: warnings "${joined}" should mention "${c.expectedClientWarning}"`,
      );
      // all-disabled manifests end in disabled mode
      if (c.expectedClientRelays.length === 0) assert.equal(r.mode, "disabled", c.name);
    }
    if (c.expectedClientRelays.length > 0) assert.equal(r.mode, "custom", c.name);
  }
});

// ---------------------------------------------------------------------------
// fallback narrowing
// ---------------------------------------------------------------------------

test("404 -> legacy bare relay URL", async () => {
  const m = mockGet({ [svc(LEGACY)]: { status: 404, body: "not found", contentType: "text/plain" } });
  const r = await resolveRelayUrls([LEGACY], { httpGet: m.doGet });
  assert.deepEqual(r.urls, [LEGACY]);
  assert.equal(r.mode, "custom");
});

test("200 with non-JSON body -> legacy bare relay URL", async () => {
  const m = mockGet({ [svc(LEGACY)]: { status: 200, body: "<html>hi</html>", contentType: "text/html" } });
  const r = await resolveRelayUrls([LEGACY], { httpGet: m.doGet });
  assert.deepEqual(r.urls, [LEGACY]);
});

test("200 with JSON-but-not-an-object body -> hard error (R4 P1-4: no legacy fallback)", async () => {
  const m = mockGet({ [svc(LEGACY)]: { status: 200, body: "[1,2,3]" } });
  await assert.rejects(
    () => resolveRelayUrls([LEGACY], { httpGet: m.doGet }),
    /not a services manifest/,
  );
});

test("timeout -> hard error, no fallback", async () => {
  const m = mockGet({ [svc(GW)]: { ok: false } });
  await assert.rejects(
    resolveRelayUrls([GW], { httpGet: m.doGet }),
    (e) => {
      assert.ok(e instanceof CliError);
      assert.equal(e.exitCode, 1);
      assert.equal(e.message, `error: gateway ${GW} unreachable (timeout)`);
      return true;
    },
  );
});

test("5xx and non-404 4xx -> hard errors with status code", async () => {
  for (const status of [500, 503, 401, 403]) {
    const m = mockGet({ [svc(GW)]: { status, body: "" } });
    await assert.rejects(
      resolveRelayUrls([GW], { httpGet: m.doGet }),
      (e) => {
        assert.equal(e.message, `error: gateway ${GW} unreachable (http ${status})`);
        return true;
      },
      `status ${status}`,
    );
  }
});

test("mixed array: disabled gateway + legacy -> legacy kept, disabled warned and ignored", async () => {
  const disabledManifest = {
    services: [{ name: "relay", enabled: false, url: null }],
  };
  const m = mockGet({
    [svc(GW)]: { status: 200, body: JSON.stringify(disabledManifest) },
    [svc(LEGACY)]: { status: 404, body: "" },
  });
  const r = await resolveRelayUrls([GW, LEGACY], { httpGet: m.doGet });
  assert.equal(r.mode, "custom");
  assert.deepEqual(r.urls, [LEGACY]);
  assert.equal(r.warnings.length, 1);
  assert.ok(r.warnings[0].includes("reports relay disabled"));
  assert.ok(r.warnings[0].includes(GW));
});

test("array resolution fails as a whole when any candidate is unreachable", async () => {
  const manifest = { services: [{ name: "relay", enabled: true, url: "http://r:3340" }] };
  const m = mockGet({
    [svc(GW)]: { status: 200, body: JSON.stringify(manifest) },
    [svc(LEGACY)]: { ok: false },
  });
  await assert.rejects(
    resolveRelayUrls([GW, LEGACY], { httpGet: m.doGet }),
    /gateway http:\/\/192\.168\.2\.13:3340 unreachable \(timeout\)/,
  );
});

test("resolved URL list is deduplicated", async () => {
  const manifest = { services: [{ name: "relay", enabled: true, url: "http://r:3340" }] };
  const m = mockGet({
    [svc("http://g1:8787")]: { status: 200, body: JSON.stringify(manifest) },
    [svc("http://g2:8787")]: { status: 200, body: JSON.stringify(manifest) },
  });
  const r = await resolveRelayUrls(["http://g1:8787", "http://g2:8787"], { httpGet: m.doGet });
  assert.deepEqual(r.urls, ["http://r:3340"]);
});

test("duplicate raw candidates collapse before any request", async () => {
  const m = mockGet({ [svc(GW)]: { status: 404, body: "" } });
  const r = await resolveRelayUrls(normalizeRelayInput([GW, GW]), { httpGet: m.doGet });
  assert.deepEqual(r.urls, [GW]);
  assert.equal(m.calls.length, 1);
});

// ---------------------------------------------------------------------------
// normalize (state machine step 1)
// ---------------------------------------------------------------------------

test("normalizeRelayInput rejects non-http(s) values as configuration errors", () => {
  for (const bad of ["not-a-url", "ftp://x:1", "", "http://", "://x"]) {
    assert.throws(() => normalizeRelayInput([bad]), (e) => {
      assert.ok(e instanceof CliError);
      assert.equal(e.exitCode, 1);
      assert.ok(e.message.includes("error: invalid relay URL:"), e.message);
      return true;
    }, bad);
  }
});

test("resolveOneRelay: enabled:true with url null -> no reachable url signal", async () => {
  const manifest = { services: [{ name: "relay", enabled: true, url: null }] };
  const m = mockGet({ [svc(GW)]: { status: 200, body: JSON.stringify(manifest) } });
  const oc = await resolveOneRelay(GW, { httpGet: m.doGet });
  assert.equal(oc.kind, "disabled");
  assert.ok(oc.warning.includes("no reachable url"));
});

test("resolveOneRelay: manifest without a relay entry -> disabled signal", async () => {
  const manifest = { services: [{ name: "rendezvous", enabled: true, url: "http://x:8787/rendezvous" }] };
  const m = mockGet({ [svc(GW)]: { status: 200, body: JSON.stringify(manifest) } });
  const oc = await resolveOneRelay(GW, { httpGet: m.doGet });
  assert.equal(oc.kind, "disabled");
});

// ---------------------------------------------------------------------------
// bootstrapRelay (full state machine)
// ---------------------------------------------------------------------------

test("bootstrapRelay: disabled mode issues no requests, policy none", async () => {
  const m = mockGet({});
  const r = await bootstrapRelay(
    { relay: { mode: "disabled", urls: [] }, proxy: { value: "auto" } },
    { httpGet: m.doGet, env: {} },
  );
  assert.deepEqual(r.relayOpts, { mode: "disabled" });
  assert.equal(r.httpProxy, "none");
  assert.equal(m.calls.length, 0);
});

test("bootstrapRelay: n0 mode does not probe the public relay", async () => {
  const m = mockGet({});
  const r = await bootstrapRelay(
    { relay: { mode: "n0", urls: ["https://relay.iroh.network"] }, proxy: { value: "auto" } },
    { httpGet: m.doGet, env: {} },
  );
  assert.deepEqual(r.relayOpts, { mode: "n0" });
  assert.equal(r.httpProxy, "none");
  assert.equal(m.calls.length, 0);
});

test("bootstrapRelay: custom gateway candidate resolves to the relay URL", async () => {
  const manifest = { services: [{ name: "relay", enabled: true, url: "http://192.168.2.13:3340" }] };
  const m = mockGet({ [svc(GW)]: { status: 200, body: JSON.stringify(manifest) } });
  const r = await bootstrapRelay(
    { relay: { mode: "custom", urls: [GW] }, proxy: { value: "auto" } },
    { httpGet: m.doGet, env: {} },
  );
  assert.deepEqual(r.relayOpts, { mode: "custom", urls: ["http://192.168.2.13:3340"] });
  assert.equal(r.httpProxy, "none");
});

test("bootstrapRelay: all-disabled manifests end in disabled relay mode with canonical warning", async () => {
  const manifest = { services: [{ name: "relay", enabled: false, url: null }] };
  const m = mockGet({ [svc(GW)]: { status: 200, body: JSON.stringify(manifest) } });
  const r = await bootstrapRelay(
    { relay: { mode: "custom", urls: [GW] }, proxy: { value: "auto" } },
    { httpGet: m.doGet, env: {} },
  );
  assert.deepEqual(r.relayOpts, { mode: "disabled" });
  assert.ok(r.warnings.some((w) => w.includes("gateway reports relay disabled")));
});

// ---------------------------------------------------------------------------
// probeRelayUrls (config set relay transactional probe)
// ---------------------------------------------------------------------------

test("probeRelayUrls reports per-URL outcomes without throwing", async () => {
  const manifest = { services: [{ name: "relay", enabled: true, url: "http://r:3340" }] };
  const m = mockGet({
    [svc("http://ok-gw:8787")]: { status: 200, body: JSON.stringify(manifest) },
    [svc("http://legacy:3340")]: { status: 404, body: "" },
    [svc("http://dead:8787")]: { ok: false },
  });
  const r = await probeRelayUrls(["http://ok-gw:8787", "http://legacy:3340", "http://dead:8787"], {
    proxySetting: "auto",
    httpGet: m.doGet,
    env: {},
  });
  assert.equal(r.allOk, false);
  assert.deepEqual(r.lines, [
    "saved: http://ok-gw:8787 (gateway -> http://r:3340)",
    "saved: http://legacy:3340 (legacy relay)",
  ]);
  // the auto-probe warning for the unreachable candidate is forwarded too
  assert.deepEqual(r.warnings, [
    "relay unreachable directly and no proxy configured",
    "saved but unreachable: http://dead:8787 (timeout)",
  ]);
});

test("probeRelayUrls: disabled relay is saved-but-unreachable with reason", async () => {
  const manifest = { services: [{ name: "relay", enabled: false, url: null }] };
  const m = mockGet({ [svc(GW)]: { status: 200, body: JSON.stringify(manifest) } });
  const r = await probeRelayUrls([GW], { proxySetting: "auto", httpGet: m.doGet, env: {} });
  assert.equal(r.allOk, false);
  assert.equal(r.warnings.length, 1);
  assert.ok(r.warnings[0].startsWith(`saved but unreachable: ${GW} (gateway ${GW} reports relay disabled)`));
});

// ---- P1-3/P1-4 回归：n0 先于 proxy 决策短路；URLS 显式空串 = 隐式 custom 意图 ----

test("bootstrapRelay n0 short-circuits before proxy decision (no probing, policy none)", async () => {
  const { bootstrapRelay } = await import("../src/relay-resolve.mjs");
  let probed = false;
  const out = await bootstrapRelay(
    { relay: { mode: "n0", urls: [] }, proxy: { value: "on" } },
    { env: {}, httpGet: async () => { probed = true; throw new Error("must not probe"); } },
  );
  assert.equal(probed, false, "n0 must not probe");
  assert.equal(out.httpProxy, "none");
  assert.deepEqual(out.relayOpts, { mode: "n0" });
});

test("bootstrapRelay disabled short-circuits (no probing, policy none)", async () => {
  const { bootstrapRelay } = await import("../src/relay-resolve.mjs");
  const out = await bootstrapRelay(
    { relay: { mode: "disabled", urls: [] }, proxy: { value: "on" } },
    { env: {}, httpGet: async () => { throw new Error("must not probe"); } },
  );
  assert.equal(out.httpProxy, "none");
  assert.deepEqual(out.relayOpts, { mode: "disabled" });
});

// ---- R7 P1-2：malformed manifest（合法 JSON 对象但 services 缺失/错型）硬错误 ----

test("200 {} -> hard error (missing services)", async () => {
  const { resolveOneRelay } = await import("../src/relay-resolve.mjs");
  const m = mockGet({ [svc(LEGACY)]: { status: 200, body: "{}" } });
  await assert.rejects(
    () => resolveOneRelay(LEGACY, { httpGet: m.doGet }),
    /invalid services manifest/,
  );
});

test("200 {services: null} -> hard error", async () => {
  const { resolveOneRelay } = await import("../src/relay-resolve.mjs");
  const m = mockGet({ [svc(LEGACY)]: { status: 200, body: '{"services": null}' } });
  await assert.rejects(
    () => resolveOneRelay(LEGACY, { httpGet: m.doGet }),
    /invalid services manifest/,
  );
});

test("200 {services: []} -> disabled (empty array is well-formed)", async () => {
  const { resolveOneRelay } = await import("../src/relay-resolve.mjs");
  const m = mockGet({ [svc(LEGACY)]: { status: 200, body: '{"services": []}' } });
  const r = await resolveOneRelay(LEGACY, { httpGet: m.doGet });
  assert.equal(r.kind, "disabled");
});

// ---- R8 P1-2b：probeRelayUrls 对 malformed manifest 逐项归一为 saved-but-unreachable ----

test("probeRelayUrls: malformed manifest -> saved but unreachable warning, no throw", async () => {
  const { probeRelayUrls } = await import("../src/relay-resolve.mjs");
  const m = mockGet({ [svc(LEGACY)]: { status: 200, body: "{}" } });
  const r = await probeRelayUrls([LEGACY], { httpGet: m.doGet });
  assert.equal(r.allOk, false);
  assert.ok(
    r.warnings.some((w) => w.includes(`saved but unreachable: ${LEGACY}`) && w.includes("invalid manifest")),
    `expected invalid-manifest warning, got: ${JSON.stringify(r.warnings)}`,
  );
});
