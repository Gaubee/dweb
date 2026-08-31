// 产品路由模型（provider 中立边界）：opendweb 的公网暴露语义 —— gateway 与
// relay 的 hostname 派生、DNS 形态校验、TOML 渲染、端到端自检。Cloudflare
// 专有映射（ingress 规则）也在本层，但以纯数据形态输出，经 cf-client 写入。
// 1.0.0 重写：自 wizard.ts/cf-api.ts 迁入，行为保持（含全部校验与 404 收尾）。
import type { FetchLike } from "./cf-api.js";

export type ExposureMode = "dual" | "single";

export interface ExposurePlan {
  mode: ExposureMode;
  gatewayHost: string;
  relayHost: string;
  publicGatewayUrl: string;
  publicRelayUrl: string;
}

const LABEL = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

/** 单/双域名规划 + DNS 形态校验（尾点剥离、label/总长限制、注入拒绝） */
export function planExposure({ hostname, mode = "dual" }: { hostname: string; mode?: ExposureMode }): ExposurePlan {
  const raw = hostname.trim().toLowerCase().replace(/\.$/, "");
  // dual 模式实际使用 relay.<hostname>，派生后的 DNS 名也必须落在同一上限内
  const relayHost = `relay.${raw}`;
  const labels = raw.split(".");
  if (labels.length < 2 || raw.length > 253 || relayHost.length > 253 || !labels.every((l) => LABEL.test(l))) {
    throw new Error(
      `"${raw}" is not a routable DNS hostname (labels a-z0-9-, overall <= 253 chars, at least two labels)`,
    );
  }
  const gatewayHost = raw;
  return {
    mode,
    gatewayHost,
    relayHost,
    publicGatewayUrl: `https://${gatewayHost}`,
    publicRelayUrl: mode === "single" ? `https://${gatewayHost}` : `https://${relayHost}`,
  };
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
 * opendweb 拓扑 → Cloudflare ingress（顺序即优先级，恒以 catch-all 收尾）：
 * - single：同 hostname 上 /relay、/ping 先行路径分流到 relay 端口，其余走 gateway
 * - dual：relay 子域整域走 relay 端口，gateway 域走 gateway 端口
 */
export function buildIngress({
  mode,
  gatewayHost,
  relayHost,
  gatewayService = "http://localhost:8787",
  relayService = "http://localhost:3340",
}: {
  mode: ExposureMode;
  gatewayHost: string;
  relayHost: string;
  gatewayService?: string;
  relayService?: string;
}): IngressConfig {
  if (mode === "single") {
    return {
      ingress: [
        { hostname: gatewayHost, path: "^/relay.*", service: relayService },
        { hostname: gatewayHost, path: "^/ping.*", service: relayService },
        { hostname: gatewayHost, service: gatewayService },
        { service: "http_status:404" },
      ],
    };
  }
  return {
    ingress: [
      { hostname: relayHost, service: relayService },
      { hostname: gatewayHost, service: gatewayService },
      { service: "http_status:404" },
    ],
  };
}

export interface RenderConfigInput {
  plan: ExposurePlan;
  tokenEnv?: string;
  gatewayBind?: string;
  relayBind?: string;
  /** 1.0.0：复跑复用的资源锚点（accountId/zoneId/tunnelId）写入插件 options */
  resource?: { accountId?: string; zoneId?: string; tunnelId?: string };
}

const q = (v: string) => `"${v}"`;

/** opendweb.config.toml 渲染（确定性输出；已存在文件走 merge fragment 路径） */
export function renderConfigToml({
  plan,
  tokenEnv = "TUNNEL_TOKEN",
  gatewayBind = "0.0.0.0:8787",
  relayBind = "0.0.0.0:3340",
  resource = {},
}: RenderConfigInput): string {
  const lines = [
    "configVersion = 1",
    "",
    "[server]",
    `gatewayBind = ${q(gatewayBind)}`,
    `relayBind = ${q(relayBind)}`,
    `publicGatewayUrl = ${q(plan.publicGatewayUrl)}`,
    `publicRelayUrl = ${q(plan.publicRelayUrl)}`,
    "",
    "[[plugins]]",
    'name = "cf"',
    "",
    "[plugins.options]",
    `tokenEnv = ${q(tokenEnv)}`,
  ];
  if (resource.accountId !== undefined) lines.push(`accountId = ${q(resource.accountId)}`);
  if (resource.zoneId !== undefined) lines.push(`zoneId = ${q(resource.zoneId)}`);
  if (resource.tunnelId !== undefined) lines.push(`tunnelId = ${q(resource.tunnelId)}`);
  return `${lines.join("\n")}\n`;
}

export interface VerifyInfo {
  elapsedMs: number;
  lastError: string | null;
}
export interface VerifyResult {
  ok: boolean;
  error?: string;
}

/**
 * 端到端自检：经公网入口拉 /services.json，断言公告的 relay URL 与期望一致。
 * 严格截止：每次 fetch 带 AbortSignal（剩余时间），外加 race 兜底信号忽略型
 * fetch；到达截止仍未通过即失败。
 */
export async function verifyExposure({
  fetchImpl = fetch,
  publicGatewayUrl,
  expectedRelayUrl,
  timeoutMs = 30000,
  onProgress,
}: {
  fetchImpl?: FetchLike;
  publicGatewayUrl: string;
  expectedRelayUrl: string;
  timeoutMs?: number;
  onProgress?: (info: VerifyInfo) => void;
}): Promise<VerifyResult> {
  const deadline = Date.now() + timeoutMs;
  let lastError: string | null = null;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const raceRemaining = (remaining: number) =>
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new Error(`fetch ignored the abort signal (stalled ${timeoutMs}ms)`)), remaining);
        if (typeof t === "object" && "unref" in t) (t as { unref(): void }).unref();
      });
    try {
      const res = await Promise.race([
        fetchImpl(`${publicGatewayUrl}/services.json`, { signal: AbortSignal.timeout(remaining) }),
        raceRemaining(remaining),
      ]);
      if (!res.ok) throw new Error(`services.json responded HTTP ${res.status}`);
      const manifest = (await res.json()) as {
        services?: Array<{ name: string; enabled: boolean; url: string | null }>;
      };
      const relayEntry = (manifest.services ?? []).find((s) => s.name === "relay");
      if (relayEntry?.enabled !== true) {
        throw new Error(`public services.json does not advertise an enabled relay (got: ${JSON.stringify(relayEntry)})`);
      }
      if (relayEntry.url !== expectedRelayUrl) {
        throw new Error(`relay URL mismatch: advertised ${relayEntry.url}, expected ${expectedRelayUrl}`);
      }
      return { ok: true };
    } catch (e) {
      lastError = (e as Error).message;
      onProgress?.({ elapsedMs: timeoutMs - (deadline - Date.now()), lastError });
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return {
    ok: false,
    error: `public exposure not reachable within ${timeoutMs}ms (is cloudflared running? last error: ${lastError ?? "none"})`,
  };
}
