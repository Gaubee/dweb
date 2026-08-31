// config 面（包根导出）：插件对象 {name, hooks}。options 来自 opendweb.config.toml：
//   tokenEnv      TUNNEL_TOKEN 环境变量名（默认 "TUNNEL_TOKEN"，postReady 共生运行用）
//   tunnel        true = server 生命周期内共生 spawn cloudflared（connector.ts）
//   zoneId / accountId / tunnelId   1.0.0 资源锚点（setup 写入，复跑幂等复用）
//   mode / hostname / dryRun / skipVerify
// 1.0.0：setup 走发现式编排（auth → zone → provision）；postReady 保持
// TUNNEL_TOKEN 运行期凭据语义（setup 末尾一次性给出获取引导）。
import path from "node:path";
import os from "node:os";
import { getApiToken, loadStoredAuth } from "./auth.js";
import { createGateway, type ZoneSummary } from "./cf-client.js";
import { verifyExposure, type ExposureMode } from "./route-model.js";
import { provision, tunnelNameFor, type TunnelChoice } from "./provision.js";
import { spawnCloudflared, stopCloudflared } from "./connector.js";

/** config 面钩子上下文（宿主 fireHook/invoke 传入；字段按需可选） */
export interface HookContext {
  options?: {
    tokenEnv?: string;
    tunnel?: boolean;
    mode?: ExposureMode;
    hostname?: string;
    dryRun?: boolean;
    skipVerify?: boolean;
    zoneId?: string;
    accountId?: string;
    tunnelId?: string;
  };
  server?: { publicGatewayUrl?: string | null; publicRelayUrl?: string | null; [key: string]: unknown };
  cwd?: string;
  configPath?: string;
  configDir?: string;
  publicGatewayUrl?: string | null;
  publicRelayUrl?: string | null;
}

export interface HookResult {
  bannerLines?: string[];
  [key: string]: unknown;
}

function dwebHome(): string {
  return process.env.DWEB_HOME ?? path.join(os.homedir(), ".opendweb");
}

/** 从 server 配置的公网 URL 推导 hostname（https://gw.example.com -> gw.example.com） */
function hostnameFromServer(server: HookContext["server"]): string | null {
  const url = server?.publicGatewayUrl;
  if (typeof url !== "string" || !url.startsWith("https://")) return null;
  return url.slice("https://".length).replace(/\/+$/, "").split(":")[0] ?? null;
}

export default {
  name: "cf",
  hooks: {
    /**
     * `opendweb setup`（非交互）：认证（env API token 或已存的浏览器登录态）→
     * 按 options/config 锚点复用或按命名查找 tunnel → 幂等 provision。
     */
    async setup(ctx: HookContext): Promise<HookResult> {
      const hostname = ctx.options?.hostname ?? hostnameFromServer(ctx.server);
      if (!hostname) {
        throw new Error("cf setup needs options.hostname (or server.publicGatewayUrl) in opendweb.config.toml");
      }
      const home = dwebHome();
      const apiToken = await getApiToken(home, { env: process.env, stored: await loadStoredAuth(home) });
      if (apiToken === null) {
        throw new Error(
          "not authenticated with Cloudflare: run `opendweb cf login` (browser) or set CLOUDFLARE_API_TOKEN",
        );
      }
      const client = await createGateway(apiToken);
      const zone = await pickZoneForHostname(client, hostname);
      const tunnel: TunnelChoice =
        ctx.options?.tunnelId !== undefined
          ? { kind: "existing", id: ctx.options.tunnelId }
          : { kind: "auto" };
      await provision({
        client,
        hostname,
        mode: ctx.options?.mode === "single" ? "single" : "dual",
        zone,
        tunnel,
        cwd: ctx.cwd ?? process.cwd(),
        configPath: ctx.configPath ?? null,
        dryRun: Boolean(ctx.options?.dryRun),
        skipVerify: Boolean(ctx.options?.skipVerify),
        log: () => {}, // 钩子内静默执行；状态由 CLI 聚合输出
      });
      return { done: true };
    },

    /** 就绪后：可选共生 spawn + 端到端自检（失败降级 WARNING 由 CLI 处理） */
    async "server.postReady"(ctx: HookContext): Promise<HookResult | null> {
      const lines: string[] = [];
      const tokenEnv = ctx.options?.tokenEnv ?? "TUNNEL_TOKEN";
      const token = process.env[tokenEnv];
      const gatewayUrl = ctx.publicGatewayUrl ?? ctx.server?.publicGatewayUrl ?? null;
      const relayUrl = ctx.publicRelayUrl ?? ctx.server?.publicRelayUrl ?? null;

      if (ctx.options?.tunnel === true) {
        if (!token) {
          throw new Error(`options.tunnel is on but ${tokenEnv} is not set`);
        }
        await spawnCloudflared(token);
        lines.push("cf: cloudflared co-spawned (stops with the server)");
      }

      if (gatewayUrl && relayUrl) {
        const v = await verifyExposure({ publicGatewayUrl: gatewayUrl, expectedRelayUrl: relayUrl });
        if (!v.ok) throw new Error(`end-to-end verification failed: ${v.error}`);
        lines.push("cf: public exposure verified (services.json matches)");
      }
      return lines.length > 0 ? { bannerLines: lines } : null;
    },

    /** 停止前：清理共生 cloudflared */
    async "server.preStop"(): Promise<HookResult | null> {
      await stopCloudflared();
      return null;
    },
  },
};

/** hostname → zone：优先 options.zoneId 精确命中，否则按后缀匹配已列 zone */
export async function pickZoneForHostname(
  client: import("./cf-client.js").CfGateway,
  hostname: string,
  zoneId?: string,
): Promise<ZoneSummary> {
  const zones = await client.listZones();
  if (zones.length === 0) {
    throw new Error("no zones visible to this Cloudflare credential (need Zone: Zone Read on the token or a broader OAuth scope)");
  }
  const byId = zoneId !== undefined ? zones.find((z) => z.id === zoneId) : undefined;
  if (byId !== undefined) return byId;
  const match = zones.find((z) => hostname === z.name || hostname.endsWith(`.${z.name}`));
  if (match !== undefined) return match;
  // 最长后缀兜底（zone 列表权限受限时未必列得全）
  const suffix = zones
    .filter((z) => hostname.endsWith(z.name))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (suffix !== undefined) return suffix;
  throw new Error(
    `no zone in this Cloudflare account matches "${hostname}" (available: ${zones.map((z) => z.name).join(", ")})`,
  );
}

export { tunnelNameFor };
