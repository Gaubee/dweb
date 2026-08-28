// Unit tests for src/proxy.mjs: env proxy resolution, httpGet policy wiring,
// and the proxy=auto probe decision table from contracts/error-matrix.md
// (mocked httpGet; set-based, order-independent decisions).
import test from "node:test";
import assert from "node:assert/strict";

import { envProxyUrl, httpGet, decideProxyPolicy } from "../src/proxy.mjs";
import { CliError } from "../src/errors.mjs";

const URL_A = "http://a.example:8787";
const URL_B = "http://b.example:8787";

function svc(u) {
  return u.replace(/\/+$/, "") + "/services.json";
}

// ---------------------------------------------------------------------------
// envProxyUrl
// ---------------------------------------------------------------------------

test("env proxy order: HTTP_PROXY > http_proxy > HTTPS_PROXY > https_proxy", () => {
  assert.equal(envProxyUrl({ HTTP_PROXY: "http://h:1", http_proxy: "http://l:1" }), "http://h:1");
  assert.equal(envProxyUrl({ http_proxy: "http://l:1", HTTPS_PROXY: "http://s:1" }), "http://l:1");
  assert.equal(envProxyUrl({ HTTPS_PROXY: "http://s:1", https_proxy: "http://s2:1" }), "http://s:1");
  assert.equal(envProxyUrl({ https_proxy: "http://s2:1" }), "http://s2:1");
  assert.equal(envProxyUrl({}), null);
});

test("empty env proxy values count as unset", () => {
  assert.equal(envProxyUrl({ HTTP_PROXY: "", http_proxy: "http://l:1" }), "http://l:1");
  assert.equal(envProxyUrl({ HTTP_PROXY: "" }), null);
});

test("invalid proxy URLs are ignored and the search continues", () => {
  assert.equal(envProxyUrl({ HTTP_PROXY: "::not a url::", http_proxy: "http://l:1" }), "http://l:1");
  assert.equal(envProxyUrl({ HTTP_PROXY: "::bad::", http_proxy: "::also bad::" }), null);
});

// ---------------------------------------------------------------------------
// httpGet policy wiring (mocked fetch / ProxyAgent)
// ---------------------------------------------------------------------------

/** @param {{ status?: number, body?: string, rejectName?: string }} [behavior] */
function makeFetch(behavior = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (behavior.rejectName) {
      const e = new Error("boom");
      e.name = behavior.rejectName;
      throw e;
    }
    return {
      status: behavior.status ?? 200,
      headers: { get: () => "application/json" },
      text: async () => behavior.body ?? "{}",
    };
  };
  return { fn, calls };
}

test("httpGet policy=none calls fetch without a dispatcher", async () => {
  const f = makeFetch();
  const r = await httpGet(svc(URL_A), { policy: "none", fetchImpl: f.fn });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].init.dispatcher, undefined);
});

test("httpGet policy=from-env installs the ProxyAgent dispatcher", async () => {
  const f = makeFetch();
  const agents = [];
  const r = await httpGet(svc(URL_A), {
    policy: "from-env",
    fetchImpl: f.fn,
    env: { HTTP_PROXY: "http://proxy:3128" },
    proxyAgentFactory: (u) => {
      agents.push(u);
      return { marker: true };
    },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(agents, ["http://proxy:3128"]);
  assert.deepEqual(f.calls[0].init.dispatcher, { marker: true });
});

test("httpGet maps TimeoutError/AbortError to timeout, others to connect failed", async () => {
  for (const name of ["TimeoutError", "AbortError"]) {
    const f = makeFetch({ rejectName: name });
    const r = await httpGet(svc(URL_A), { fetchImpl: f.fn });
    assert.deepEqual(r, { ok: false, reason: "timeout", error: "boom" }, name);
  }
  const f2 = makeFetch({ rejectName: "TypeError" });
  const r2 = await httpGet(svc(URL_A), { fetchImpl: f2.fn });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, "connect failed");
});

// ---------------------------------------------------------------------------
// decideProxyPolicy: the bootstrap probe decision table
// ---------------------------------------------------------------------------

/**
 * @param {string[]} candidates
 * @param {{ direct?: { [url: string]: { ok: boolean } }, proxy?: { [url: string]: { ok: boolean } } }} routes
 */
function mockGet(candidates, routes) {
  const calls = [];
  const doGet = async (url, opts = {}) => {
    const policy = opts.policy ?? "none";
    calls.push({ url, policy });
    const table = policy === "from-env" ? routes.proxy : routes.direct;
    const hit = table[url];
    if (!hit) throw new Error(`unexpected probe ${url} (policy=${policy})`);
    return hit.ok
      ? { ok: true, status: 404, contentType: "", body: "" }
      : { ok: false, reason: "connect failed" };
  };
  return { doGet, calls };
}

const bothRoutes = (direct, viaProxy) => ({ direct, proxy: viaProxy });

test("row: all candidates reachable directly -> none", async () => {
  const m = mockGet([URL_A, URL_B], bothRoutes({ [svc(URL_A)]: { ok: true }, [svc(URL_B)]: { ok: true } }, {}));
  const r = await decideProxyPolicy([URL_A, URL_B], { proxySetting: "auto", httpGet: m.doGet });
  assert.equal(r.policy, "none");
  assert.deepEqual(r.warnings, []);
  assert.equal(m.calls.length, 2); // direct probes only
  assert.ok(m.calls.every((c) => c.policy === "none"));
});

test("row: legacy relay 404 counts as reachable (complete HTTP response)", async () => {
  const m = mockGet([URL_A], bothRoutes({ [svc(URL_A)]: { ok: true } }, {}));
  const r = await decideProxyPolicy([URL_A], { proxySetting: "auto", httpGet: m.doGet });
  assert.equal(r.policy, "none");
});

test("row: some direct-fail, proxy retries all fail -> none + per-item both-fail WARNING", async () => {
  const m = mockGet(
    [URL_A, URL_B],
    bothRoutes(
      { [svc(URL_A)]: { ok: true }, [svc(URL_B)]: { ok: false } },
      { [svc(URL_B)]: { ok: false } },
    ),
  );
  const r = await decideProxyPolicy([URL_A, URL_B], { proxySetting: "auto", httpGet: m.doGet });
  assert.equal(r.policy, "none");
  assert.deepEqual(r.warnings, [`relay unreachable both directly and via proxy: ${URL_B}`]);
});

test("row: some direct-fail, any proxy success -> from-env (proxy-override semantics)", async () => {
  const m = mockGet(
    [URL_A, URL_B],
    bothRoutes(
      { [svc(URL_A)]: { ok: true }, [svc(URL_B)]: { ok: false } },
      { [svc(URL_B)]: { ok: true } },
    ),
  );
  const r = await decideProxyPolicy([URL_A, URL_B], { proxySetting: "auto", httpGet: m.doGet });
  assert.equal(r.policy, "from-env");
  assert.deepEqual(r.warnings, []);
});

test("row: all direct fail, any proxy success -> from-env", async () => {
  const m = mockGet(
    [URL_A, URL_B],
    bothRoutes(
      { [svc(URL_A)]: { ok: false }, [svc(URL_B)]: { ok: false } },
      { [svc(URL_A)]: { ok: false }, [svc(URL_B)]: { ok: true } },
    ),
  );
  const r = await decideProxyPolicy([URL_A, URL_B], { proxySetting: "auto", httpGet: m.doGet });
  assert.equal(r.policy, "from-env");
});

test("row: all direct fail, all proxy fail -> none + general both-fail WARNING (only after actual proxy attempts)", async () => {
  const m = mockGet(
    [URL_A, URL_B],
    bothRoutes(
      { [svc(URL_A)]: { ok: false }, [svc(URL_B)]: { ok: false } },
      { [svc(URL_A)]: { ok: false }, [svc(URL_B)]: { ok: false } },
    ),
  );
  const r = await decideProxyPolicy([URL_A, URL_B], {
    proxySetting: "auto",
    httpGet: m.doGet,
    env: { HTTP_PROXY: "http://proxy:3128" },
  });
  assert.equal(r.policy, "none");
  assert.deepEqual(r.warnings, ["relay unreachable both directly and via proxy; check the server"]);
  // proxy actually attempted for every failing candidate
  assert.equal(m.calls.filter((c) => c.policy === "from-env").length, 2);
});

test("row: all direct fail, no env proxy -> none + different WARNING, no proxy attempts", async () => {
  const m = mockGet([URL_A], bothRoutes({ [svc(URL_A)]: { ok: false } }, {}));
  const r = await decideProxyPolicy([URL_A], { proxySetting: "auto", httpGet: m.doGet, env: {} });
  assert.equal(r.policy, "none");
  assert.deepEqual(r.warnings, ["relay unreachable directly and no proxy configured"]);
  assert.equal(m.calls.filter((c) => c.policy === "from-env").length, 0);
});

test("row: empty candidate list issues no requests (disabled / no relay)", async () => {
  const m = mockGet([], bothRoutes({}, {}));
  const r = await decideProxyPolicy([], { proxySetting: "auto", httpGet: m.doGet });
  assert.equal(r.policy, "none");
  assert.deepEqual(r.warnings, []);
  assert.equal(m.calls.length, 0);
});

test("row: proxy=on without usable env proxy -> configuration error", async () => {
  await assert.rejects(
    decideProxyPolicy([], { proxySetting: "on", env: {} }),
    (e) => {
      assert.ok(e instanceof CliError);
      assert.equal(e.message, "error: proxy=on but no usable proxy in environment");
      return true;
    },
  );
  // also an error when candidates exist
  const m = mockGet([URL_A], bothRoutes({}, {}));
  await assert.rejects(
    decideProxyPolicy([URL_A], { proxySetting: "on", env: {}, httpGet: m.doGet }),
    /proxy=on but no usable proxy in environment/,
  );
  assert.equal(m.calls.length, 0);
});

test("proxy=on with env proxy -> from-env without probing", async () => {
  const m = mockGet([URL_A], bothRoutes({}, {}));
  const r = await decideProxyPolicy([URL_A], {
    proxySetting: "on",
    env: { HTTP_PROXY: "http://proxy:3128" },
    httpGet: m.doGet,
  });
  assert.equal(r.policy, "from-env");
  assert.equal(m.calls.length, 0);
});

test("proxy=off forces none even with env proxy set", async () => {
  const m = mockGet([URL_A], bothRoutes({}, {}));
  const r = await decideProxyPolicy([URL_A], {
    proxySetting: "off",
    env: { HTTP_PROXY: "http://proxy:3128" },
    httpGet: m.doGet,
  });
  assert.equal(r.policy, "none");
  assert.equal(m.calls.length, 0);
});

test("mixed arrays decide identically regardless of order", async () => {
  const directOnly = "http://direct.example:8787";
  const proxyOnly = "http://proxyonly.example:8787";
  const routes = bothRoutes(
    { [svc(directOnly)]: { ok: true }, [svc(proxyOnly)]: { ok: false } },
    { [svc(proxyOnly)]: { ok: true } },
  );
  const r1 = await decideProxyPolicy([directOnly, proxyOnly], {
    proxySetting: "auto",
    httpGet: mockGet([directOnly, proxyOnly], routes).doGet,
  });
  const r2 = await decideProxyPolicy([proxyOnly, directOnly], {
    proxySetting: "auto",
    httpGet: mockGet([proxyOnly, directOnly], routes).doGet,
  });
  assert.equal(r1.policy, "from-env");
  assert.equal(r2.policy, "from-env");
});

test("proxy retry only targets the direct-unreachable candidates", async () => {
  const m = mockGet(
    [URL_A, URL_B],
    bothRoutes(
      { [svc(URL_A)]: { ok: true }, [svc(URL_B)]: { ok: false } },
      { [svc(URL_B)]: { ok: true } },
    ),
  );
  await decideProxyPolicy([URL_A, URL_B], { proxySetting: "auto", httpGet: m.doGet });
  const proxyCalls = m.calls.filter((c) => c.policy === "from-env");
  assert.deepEqual(proxyCalls.map((c) => c.url), [svc(URL_B)]);
});
