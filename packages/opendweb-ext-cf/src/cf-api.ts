// 1.0.0 精简：本模块只保留凭据与输入宽容度工具（REST 控制面已迁至
// cf-client.ts 的 createRestGateway/createSdkGateway；路由模型在 route-model.ts）。
import type { IngressConfig } from "./route-model.js";
export type { IngressConfig };
export interface TunnelCreds {
  accountTag: string;
  tunnelId: string;
  apiToken: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * 从粘贴文本中提取 tunnel token：用户粘贴的常是整条安装命令甚至多行说明。
 * CF token 是 base64(JSON{a,t,s})——必然以 eyJ 开头、base64url 字符集、
 * 实际长度 150+（阈值 80 留余量）。取首个匹配；无匹配返回 null。
 */
export function extractTunnelToken(raw: string): string | null {
  const m = /eyJ[A-Za-z0-9_-]{80,}/.exec(raw.trim());
  return m === null ? null : m[0];
}

/** token 摘要（提交后回显对照用）：头 8 + … + 尾 6 + 长度 */
export function tokenSummary(token: string): string {
  const head = token.slice(0, 8);
  const tail = token.length > 14 ? token.slice(-6) : "";
  return `${head}...${tail} (${token.length} chars)`;
}

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
