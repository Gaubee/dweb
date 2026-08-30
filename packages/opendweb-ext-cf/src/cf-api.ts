// TUNNEL_TOKEN 解码与 Cloudflare API 客户端（可注入 fetch，供测试与 dry-run）。
// TUNNEL_TOKEN = base64(JSON{ a: accountTag, t: tunnelId, s: apiToken })——与
// cloudflared 的 token 语义一致（dashboard remotely-managed tunnel 的安装串）。
export const CF_API_BASE = "https://api.cloudflare.com/client/v4";

/** 可注入的 fetch 形态（测试/编排替换全局 fetch） */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface TunnelCreds {
  accountTag: string;
  tunnelId: string;
  apiToken: string;
}

export interface IngressRule {
  hostname?: string;
  path?: string;
  service: string;
}

export interface IngressConfig {
  ingress: IngressRule[];
}

/**
 * 解码 TUNNEL_TOKEN → { accountTag, tunnelId, apiToken }。形态不符 → 抛错
 * （错误信息面向终端用户，全 ASCII）。
 * a/t 会拼进 API URL 路径、s 进 Authorization 头——白名单字符集阻断
 * 路径穿越/头注入（合法 CF 值均为 [A-Za-z0-9_-]）。
 */
export function decodeTunnelToken(token: string): TunnelCreds {
  let json: string;
  try {
    json = Buffer.from(String(token), "base64").toString("utf8");
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (typeof parsed.a !== "string" || typeof parsed.t !== "string" || typeof parsed.s !== "string") {
      throw new Error("missing a/t/s fields");
    }
    const SAFE = /^[A-Za-z0-9_-]+$/;
    if (!SAFE.test(parsed.a) || !SAFE.test(parsed.t) || !SAFE.test(parsed.s)) {
      throw new Error("a/t/s fields contain characters outside [A-Za-z0-9_-]");
    }
    return { accountTag: parsed.a, tunnelId: parsed.t, apiToken: parsed.s };
  } catch (e) {
    throw new Error(
      `not a valid TUNNEL_TOKEN (${(e as Error).message}); copy it from Zero Trust -> Networks -> Tunnels -> your tunnel -> install`,
    );
  }
}

/**
 * 构造 ingress 配置（design：双主机名默认 / 单域名路径分流可选）。
 * 服务指向回源地址（相对 compose 网络或本机）。
 */
export function buildIngress({
  mode,
  gatewayHost,
  relayHost,
  gatewayService = "http://localhost:8787",
  relayService = "http://localhost:3340",
}: {
  mode: "dual" | "single";
  gatewayHost: string;
  relayHost: string;
  gatewayService?: string;
  relayService?: string;
}): IngressConfig {
  const hostname = (h: string) => h.toLowerCase();
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

/** Cloudflare API 响应的公共包裹形态（宽松：只取我们关心的字段） */
interface CfResponse {
  success?: boolean;
  errors?: Array<{ code?: number | string; message?: string }>;
  result?: Array<{ id?: string }>;
}

const errsOf = (body: CfResponse | undefined): string =>
  (body?.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ");

/** 推送 ingress 配置（PUT configurations）。 */
export async function pushIngress({
  fetchImpl = fetch,
  apiBase = CF_API_BASE,
  accountTag,
  tunnelId,
  apiToken,
  ingress,
}: {
  fetchImpl?: FetchLike;
  apiBase?: string;
} & TunnelCreds & { ingress: IngressConfig }): Promise<CfResponse> {
  const res = await fetchImpl(`${apiBase}/accounts/${accountTag}/cfd_tunnel/${tunnelId}/configurations`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ config: { ingress: ingress.ingress } }),
  });
  const body = (await res.json().catch(() => ({}))) as CfResponse;
  if (!res.ok || body?.success === false) {
    const errs = errsOf(body);
    throw new Error(`Cloudflare API rejected ingress config (HTTP ${res.status})${errs ? `: ${errs}` : ""}`);
  }
  return body;
}

/**
 * DNS 路由（best-effort）：查 zone → 建 CNAME <host> → <tunnelId>.cfargotunnel.com。
 * TUNNEL_TOKEN 的 api token 不一定有 DNS 权限——失败时抛错并提示手工路径。
 * R2-M7：query 经 URLSearchParams 构造（值里疑似 query 的字符一律编码）；
 * zone 名先试末两段、再试末三段（example.co.uk 这类公共后缀）。
 */
export async function routeDns({
  fetchImpl = fetch,
  apiBase = CF_API_BASE,
  accountTag,
  tunnelId,
  apiToken,
  hostnames,
}: {
  fetchImpl?: FetchLike;
  apiBase?: string;
  hostnames: string[];
} & TunnelCreds): Promise<string[]> {
  const results: string[] = [];
  for (const host of hostnames) {
    const labels = host.split(".");
    const zoneCandidates = [labels.slice(-2).join("."), labels.slice(-3).join(".")];
    let zoneId: string | null = null;
    let lastZoneErr = "";
    for (const zoneName of [...new Set(zoneCandidates)]) {
      const qs = new URLSearchParams({ name: zoneName, "account.id": accountTag });
      const zoneRes = await fetchImpl(`${apiBase}/zones?${qs}`, {
        headers: { Authorization: `Bearer ${apiToken}` },
      });
      const zoneBody = (await zoneRes.json().catch(() => ({}))) as CfResponse;
      zoneId = zoneBody?.result?.[0]?.id ?? null;
      if (zoneId) break;
      lastZoneErr = `zone lookup for ${zoneName} returned no zone`;
    }
    if (!zoneId) {
      throw new Error(
        `cannot resolve zone for ${host} (${lastZoneErr || "token may lack Zone:Read"}); create CNAME ${host} -> ${tunnelId}.cfargotunnel.com manually`,
      );
    }
    const cnameRes = await fetchImpl(`${apiBase}/zones/${zoneId}/dns_records`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "CNAME",
        name: host,
        content: `${tunnelId}.cfargotunnel.com`,
        proxied: true,
      }),
    });
    const cnameBody = (await cnameRes.json().catch(() => ({}))) as CfResponse;
    if (!cnameRes.ok && cnameBody?.errors?.[0]?.code !== 81057) {
      // 81057 = record already exists —— 幂等成功
      const errs = errsOf(cnameBody);
      throw new Error(
        `DNS record creation failed for ${host}${errs ? `: ${errs}` : ""}; create CNAME ${host} -> ${tunnelId}.cfargotunnel.com manually`,
      );
    }
    results.push(host);
  }
  return results;
}
