// HTTP client with explicit proxy policy (design D2/D7) + the proxy=auto
// probe decision table (contracts/error-matrix.md, "bootstrap probe" rows).
//
// Proxy env order matches iroh 1.1 proxy_from_env(): HTTP_PROXY > http_proxy >
// HTTPS_PROXY > https_proxy; empty values count as unset; invalid URLs are
// ignored and the search continues. undici is an explicit dependency of this
// package (Node's bundled fetch is not importable) and is required lazily so
// pure-function tests can inject mocks; the lockfile is owned by ZCode.

import { createRequire } from "node:module";
import { CliError } from "./errors.mjs";

const require = createRequire(import.meta.url);

/** @type {any} */
let undiciModule = null;
function undici() {
  if (undiciModule === null) {
    try {
      undiciModule = require("undici");
    } catch {
      throw new CliError(
        "error: the undici dependency is not installed; run package install (pnpm install) to use proxy support",
      );
    }
  }
  return undiciModule;
}

const PROXY_ENV_ORDER = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"];

/**
 * First usable proxy URL from the environment (same order as iroh), or null.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | null}
 */
export function envProxyUrl(env = process.env) {
  for (const key of PROXY_ENV_ORDER) {
    const v = env[key];
    if (!v) continue; // empty counts as unset
    try {
      const u = new URL(v);
      if (u.protocol === "http:" || u.protocol === "https:") return v;
    } catch {
      // invalid URL: ignore and continue
    }
  }
  return null;
}

/**
 * Default ProxyAgent factory (real undici).
 * @param {string} proxyUrl
 */
export function defaultProxyAgentFactory(proxyUrl) {
  return new (undici().ProxyAgent)(proxyUrl);
}

/**
 * GET a URL under a proxy policy. Reachability contract (design D2): any
 * COMPLETE HTTP response -- including 404/401/407/500 -- proves the transport
 * path works; only connect errors and timeouts are "unreachable".
 * @param {string} url
 * @param {{ policy?: "none" | "from-env", timeoutMs?: number, env?: Record<string, string | undefined>, fetchImpl?: typeof fetch, proxyAgentFactory?: (url: string) => unknown }} [opts]
 * @returns {Promise<{ ok: true, status: number, contentType: string, body: string } | { ok: false, reason: "timeout" | "connect failed", error?: string }>}
 */
export async function httpGet(url, opts = {}) {
  const {
    policy = "none",
    timeoutMs = 3000,
    env = process.env,
    fetchImpl,
    proxyAgentFactory = defaultProxyAgentFactory,
  } = opts;
  /** @type {any} */
  const init = { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" };
  let fetchFn = fetchImpl;
  if (policy === "from-env") {
    const proxyUrl = envProxyUrl(env);
    if (proxyUrl) {
      init.dispatcher = proxyAgentFactory(proxyUrl);
      // Use undici's own fetch so the per-request dispatcher is honored.
      if (!fetchFn) fetchFn = (u, i) => undici().fetch(u, i);
    }
  }
  if (!fetchFn) fetchFn = fetch;
  try {
    const res = await fetchFn(url, init);
    const body = await res.text();
    return {
      ok: true,
      status: res.status,
      contentType: typeof res.headers?.get === "function" ? (res.headers.get("content-type") ?? "") : "",
      body,
    };
  } catch (e) {
    const name = e?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      return { ok: false, reason: "timeout", error: String(e?.message ?? e) };
    }
    return { ok: false, reason: "connect failed", error: String(e?.message ?? e) };
  }
}

/** @param {string} u */
function servicesUrl(u) {
  return u.replace(/\/+$/, "") + "/services.json";
}

/**
 * Proxy=auto/on/off decision (design D2 step 2). Set-based, order-independent,
 * proxy-override semantics: if ANY candidate cannot be reached directly and
 * any candidate is reachable via an env proxy, the policy is from-env for ALL
 * candidates. Empty candidate lists never issue requests.
 *
 * Throws CliError for proxy=on without a usable env proxy.
 * @param {string[]} candidates raw relay URLs (already normalized)
 * @param {{ proxySetting?: "auto" | "on" | "off", env?: Record<string, string | undefined>, httpGet?: typeof httpGet, timeoutMs?: number }} [opts]
 * @returns {Promise<{ policy: "none" | "from-env", warnings: string[], probed: boolean }>}
 */
export async function decideProxyPolicy(candidates, opts = {}) {
  const {
    proxySetting = "auto",
    env = process.env,
    httpGet: doGet = httpGet,
    timeoutMs = 3000,
  } = opts;
  const proxyUrl = envProxyUrl(env);
  if (proxySetting === "on") {
    if (!proxyUrl) {
      throw new CliError("error: proxy=on but no usable proxy in environment");
    }
    return { policy: "from-env", warnings: [], probed: false };
  }
  if (candidates.length === 0 || proxySetting === "off") {
    return { policy: "none", warnings: [], probed: false };
  }
  // proxy=auto: bounded direct probe of ALL candidates (no ordering bias).
  const direct = await Promise.all(
    candidates.map((u) => doGet(servicesUrl(u), { policy: "none", timeoutMs, env })),
  );
  const unreachable = candidates.filter((_, i) => !direct[i].ok);
  if (unreachable.length === 0) {
    return { policy: "none", warnings: [], probed: true };
  }
  if (!proxyUrl) {
    return {
      policy: "none",
      warnings: ["relay unreachable directly and no proxy configured"],
      probed: true,
    };
  }
  // Retry the direct-unreachable candidates via the env proxy.
  const viaProxy = await Promise.all(
    unreachable.map((u) => doGet(servicesUrl(u), { policy: "from-env", timeoutMs, env })),
  );
  if (viaProxy.some((r) => r.ok)) {
    return { policy: "from-env", warnings: [], probed: true };
  }
  if (unreachable.length === candidates.length) {
    return {
      policy: "none",
      warnings: ["relay unreachable both directly and via proxy; check the server"],
      probed: true,
    };
  }
  return {
    policy: "none",
    warnings: unreachable.map((u) => `relay unreachable both directly and via proxy: ${u}`),
    probed: true,
  };
}
