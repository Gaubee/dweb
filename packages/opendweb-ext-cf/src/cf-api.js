// TUNNEL_TOKEN 解码与 Cloudflare API 客户端（可注入 fetch，供测试与 dry-run）。
// TUNNEL_TOKEN = base64(JSON{ a: accountTag, t: tunnelId, s: apiToken })——与
// cloudflared 的 token 语义一致（dashboard remotely-managed tunnel 的安装串）。
export const CF_API_BASE = "https://api.cloudflare.com/client/v4";

/**
 * 解码 TUNNEL_TOKEN → { accountTag, tunnelId, apiToken }。形态不符 → 抛错
 * （错误信息面向终端用户，全 ASCII）。
 * @param {string} token
 */
export function decodeTunnelToken(token) {
  let json;
  try {
    json = Buffer.from(String(token), "base64").toString("utf8");
    const parsed = JSON.parse(json);
    if (typeof parsed.a !== "string" || typeof parsed.t !== "string" || typeof parsed.s !== "string") {
      throw new Error("missing a/t/s fields");
    }
    // a/t 会拼进 API URL 路径、s 进 Authorization 头——白名单字符集阻断
    // 路径穿越/头注入（合法 CF 值均为 [A-Za-z0-9_-]）
    const SAFE = /^[A-Za-z0-9_-]+$/;
    if (!SAFE.test(parsed.a) || !SAFE.test(parsed.t) || !SAFE.test(parsed.s)) {
      throw new Error("a/t/s fields contain characters outside [A-Za-z0-9_-]");
    }
    return { accountTag: parsed.a, tunnelId: parsed.t, apiToken: parsed.s };
  } catch (e) {
    throw new Error(`not a valid TUNNEL_TOKEN (${e.message}); copy it from Zero Trust -> Networks -> Tunnels -> your tunnel -> install`);
  }
}

/**
 * 构造 ingress 配置（design：双主机名默认 / 单域名路径分流可选）。
 * 服务指向回源地址（相对 compose 网络或本机）。
 * @param {{ mode: "dual" | "single", gatewayHost: string, relayHost: string, gatewayService: string, relayService: string }} input
 * @returns {{ ingress: Array<Record<string, unknown>> }}
 */
export function buildIngress({ mode, gatewayHost, relayHost, gatewayService = "http://localhost:8787", relayService = "http://localhost:3340" }) {
  const hostname = (h) => h.toLowerCase();
  if (mode === "single") {
    return {
      ingress: [
        { hostname: hostname(gatewayHost), path: "^/relay.*", service: relayService },
        { hostname: hostname(gatewayHost), path: "^/ping.*", service: relayService },
        { hostname: hostname(gatewayHost), service: gatewayService },
        { service: "http_status:404" },
      ],
    };
  }
  return {
    ingress: [
      { hostname: hostname(relayHost), service: relayService },
      { hostname: hostname(gatewayHost), service: gatewayService },
      { service: "http_status:404" },
    ],
  };
}

/**
 * 推送 ingress 配置（PUT configurations）。
 * @param {{ fetchImpl?: typeof fetch, apiBase?: string, accountTag: string, tunnelId: string, apiToken: string, ingress: object }} input
 */
export async function pushIngress({ fetchImpl = fetch, apiBase = CF_API_BASE, accountTag, tunnelId, apiToken, ingress }) {
  const res = await fetchImpl(`${apiBase}/accounts/${accountTag}/cfd_tunnel/${tunnelId}/configurations`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ config: { ingress: ingress.ingress } }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.success === false) {
    const errs = (body?.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ");
    throw new Error(`Cloudflare API rejected ingress config (HTTP ${res.status})${errs ? `: ${errs}` : ""}`);
  }
  return body;
}

/**
 * DNS 路由（best-effort）：查 zone → 建 CNAME <host> → <tunnelId>.cfargotunnel.com。
 * TUNNEL_TOKEN 的 api token 不一定有 DNS 权限——失败时抛错并提示手工路径。
 * @param {{ fetchImpl?: typeof fetch, apiBase?: string, accountTag: string, tunnelId: string, apiToken: string, hostnames: string[] }} input
 */
export async function routeDns({ fetchImpl = fetch, apiBase = CF_API_BASE, accountTag, tunnelId, apiToken, hostnames }) {
  const results = [];
  for (const host of hostnames) {
    // zone = 末两段（朴素近似；复杂域走 API 过滤）
    const labels = host.split(".");
    const zoneName = labels.slice(-2).join(".");
    const zoneRes = await fetchImpl(`${apiBase}/zones?name=${zoneName}&account.id=${accountTag}`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    const zoneBody = await zoneRes.json().catch(() => ({}));
    const zoneId = zoneBody?.result?.[0]?.id;
    if (!zoneId) {
      throw new Error(`cannot resolve zone for ${host} (token may lack Zone:Read); create CNAME ${host} -> ${tunnelId}.cfargotunnel.com manually`);
    }
    const cnameRes = await fetchImpl(`${apiBase}/zones/${zoneId}/dns_records`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "CNAME", name: host, content: `${tunnelId}.cfargotunnel.com`, proxied: true }),
    });
    const cnameBody = await cnameRes.json().catch(() => ({}));
    if (!cnameRes.ok && cnameBody?.errors?.[0]?.code !== 81057) {
      // 81057 = record already exists —— 幂等成功
      const errs = (cnameBody?.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ");
      throw new Error(`DNS record creation failed for ${host}${errs ? `: ${errs}` : ""}; create CNAME ${host} -> ${tunnelId}.cfargotunnel.com manually`);
    }
    results.push(host);
  }
  return results;
}
