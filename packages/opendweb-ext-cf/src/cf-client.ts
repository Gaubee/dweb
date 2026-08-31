// Cloudflare 控制面网关（1.0.0）：官方 SDK 的 tree-shakable 入口（全量包
// 62MB/16k 文件不可 bundle），仅挂所需资源。窄接口 CfGateway 是 provision/
// tui 的唯一依赖面——测试注入 fake，生产注入 SDK 实现。
//
// account id 推导（Owner 实测指出的 CLOUDFLARE_ACCOUNT_ID 缺陷修复）：
// zone 对象自带 account{id,name}（Zone Read 权限即可），选 zone 即得账户；
// 不再使用旧的 zones?account.id= 过滤查询。
import type { IngressRule } from "./route-model.js";
import type { FetchLike } from "./cf-api.js";

export interface ZoneSummary {
  id: string;
  name: string;
  accountId: string;
  accountName: string;
  status: string;
}

export interface TunnelSummary {
  id: string;
  name: string;
  status: string;
  connections: number;
}

export interface DnsRecordSummary {
  id: string;
  type: string;
  name: string;
  content: string;
  comment?: string;
}

/**
 * tunnel 配置全量形态（configurations GET/PUT 的 config 对象）：ingress 之外
 * 还可携带 originRequest/warpRouting 等字段——PUT 是全量替换，调用方必须
 * 先 GET 保留这些非 ingress 字段（B2），否则会静默丢配置。
 */
export interface TunnelConfiguration {
  ingress: IngressRule[];
  [key: string]: unknown;
}

/** 控制面窄接口（provision/tui 依赖；测试 fake 此面） */
export interface CfGateway {
  listZones(): Promise<ZoneSummary[]>;
  listTunnels(accountId: string): Promise<TunnelSummary[]>;
  createTunnel(accountId: string, name: string): Promise<{ id: string; name: string }>;
  getTunnelToken(accountId: string, tunnelId: string): Promise<string>;
  getConfiguration(accountId: string, tunnelId: string): Promise<TunnelConfiguration | null>;
  putConfiguration(accountId: string, tunnelId: string, config: TunnelConfiguration): Promise<void>;
  findDnsRecord(zoneId: string, fqdn: string): Promise<DnsRecordSummary | null>;
  createDnsRecord(zoneId: string, fqdn: string, target: string, comment: string): Promise<void>;
  updateDnsRecord(zoneId: string, recordId: string, fqdn: string, target: string, comment: string): Promise<void>;
}

export class CfApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** 把 SDK/API 错误归一为用户可读 ASCII（不吞上下文） */
export function toUserError(e: unknown, action: string): Error {
  const msg = e instanceof Error ? e.message : String(e);
  return new CfApiError(`${action} failed: ${msg.replace(/[^\x20-\x7e]+/g, "?")}`);
}

type SdkTunnel = {
  id?: string;
  name?: string;
  status?: string;
  connections?: Array<unknown> | number;
};
type SdkZone = {
  id?: string;
  name?: string;
  status?: string;
  account?: { id?: string; name?: string };
};
type SdkDnsRecord = {
  id?: string;
  type?: string;
  name?: string;
  content?: string;
  comment?: string;
};

/**
 * tree-shakable 入口的注入/默认装载面。7.1.0 实测契约（B1 修复）：
 * createClient 只收一个 options 对象（apiToken + resources 内联）；资源必须
 * 用 leaf 子路径的具名类——聚合入口 cloudflare/resources 会把 447KB 全量资源
 * 拉进 bundle，且其具名导出在部分版本缺失（undefined 混入 resources 数组）。
 * 取最窄 leaf：Zones/DNS 资源类 + zero-trust/tunnels 的 Cloudflared 类
 * （_key = ["zeroTrust","tunnels","cloudflared"]，恰为本网关的使用面；整个
 * ZeroTrust 资源类含 Access/Gateway/DLP 等 374KB 无关子资源）。
 */
export interface SdkModule {
  createClient: (options: { apiToken: string; resources: unknown[] }) => SdkLike;
  /** 挂载的资源类（默认 loader 给最窄 leaf 集；注入面可省略） */
  resources?: unknown[];
}

async function loadLeafSdk(): Promise<SdkModule> {
  const { createClient } = (await import("cloudflare/tree-shakable")) as unknown as {
    createClient: SdkModule["createClient"];
  };
  const [{ Zones }, { DNS }, { Cloudflared }] = await Promise.all([
    import("cloudflare/resources/zones") as Promise<{ Zones?: unknown }>,
    import("cloudflare/resources/dns") as Promise<{ DNS?: unknown }>,
    import("cloudflare/resources/zero-trust/tunnels") as Promise<{ Cloudflared?: unknown }>,
  ]);
  const resources = [Zones, DNS, Cloudflared];
  if (resources.some((r) => r === undefined)) {
    throw new Error("cloudflare leaf resource modules did not export Zones/DNS/Cloudflared");
  }
  return { createClient, resources };
}

/**
 * 生产网关：cloudflare/tree-shakable createClient（apiToken 即 bearer——
 * OAuth access token 与 API token 同为 Bearer，同一网关可复用）。
 */
export async function createSdkGateway(
  apiToken: string,
  opts: { loadSdk?: () => Promise<SdkModule> } = {},
): Promise<CfGateway> {
  // tree-shakable：resources 必传（全量挂载会拉入整个生成的 SDK）
  const mod = await (opts.loadSdk ?? loadLeafSdk)();
  const client = mod.createClient({ apiToken, resources: mod.resources ?? [] });

  const wrap = async <T>(action: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      throw toUserError(e, action);
    }
  };

  return {
    async listZones(): Promise<ZoneSummary[]> {
      return wrap("listing zones", async () => {
        const out: ZoneSummary[] = [];
        for await (const z of client.zones.list() as AsyncIterable<SdkZone>) {
          if (z.id !== undefined && z.name !== undefined && z.account?.id !== undefined) {
            out.push({
              id: z.id,
              name: z.name,
              status: z.status ?? "",
              accountId: z.account.id,
              accountName: z.account.name ?? "",
            });
          }
        }
        return out;
      });
    },
    async listTunnels(accountId: string): Promise<TunnelSummary[]> {
      return wrap("listing tunnels", async () => {
        const out: TunnelSummary[] = [];
        for await (const t of client.zeroTrust.tunnels.cloudflared.list({ account_id: accountId }) as AsyncIterable<SdkTunnel>) {
          if (t.id !== undefined && t.name !== undefined) {
            out.push({
              id: t.id,
              name: t.name,
              status: t.status ?? "",
              connections: Array.isArray(t.connections) ? t.connections.length : (t.connections ?? 0),
            });
          }
        }
        return out;
      });
    },
    async createTunnel(accountId: string, name: string) {
      return wrap(`creating tunnel "${name}"`, async () => {
        const t = await client.zeroTrust.tunnels.cloudflared.create({
          account_id: accountId,
          name,
          config_src: "cloudflare",
        });
        if (t.id === undefined || t.name === undefined) throw new Error("create returned no id/name");
        return { id: t.id, name: t.name };
      });
    },
    async getTunnelToken(accountId: string, tunnelId: string) {
      return wrap("fetching the tunnel token", async () => {
        const token = await client.zeroTrust.tunnels.cloudflared.token.get(tunnelId, { account_id: accountId });
        if (typeof token !== "string" || token === "") throw new Error("empty token");
        return token;
      });
    },
    async getConfiguration(accountId: string, tunnelId: string) {
      return wrap("reading the tunnel configuration", async () => {
        const res = await client.zeroTrust.tunnels.cloudflared.configurations.get(tunnelId, {
          account_id: accountId,
        });
        const config = (res as { config?: TunnelConfiguration }).config;
        if (config?.ingress === undefined) return null;
        return config;
      });
    },
    async putConfiguration(accountId: string, tunnelId: string, config: TunnelConfiguration) {
      await wrap("pushing the tunnel configuration", () =>
        client.zeroTrust.tunnels.cloudflared.configurations.update(tunnelId, {
          account_id: accountId,
          config,
        }),
      );
    },
    async findDnsRecord(zoneId: string, fqdn: string) {
      return wrap(`looking up the DNS record for ${fqdn}`, async () => {
        const page = await client.dns.records.list({
          zone_id: zoneId,
          name: { exact: fqdn },
          per_page: 5,
        });
        const first = (page as { result?: SdkDnsRecord[] }).result?.[0];
        if (first?.id === undefined) return null;
        return {
          id: first.id,
          type: first.type ?? "",
          name: first.name ?? fqdn,
          content: first.content ?? "",
          ...(first.comment !== undefined ? { comment: first.comment } : {}),
        } satisfies DnsRecordSummary;
      });
    },
    async createDnsRecord(zoneId: string, fqdn: string, target: string, comment: string) {
      await wrap(`creating the DNS record for ${fqdn}`, () =>
        client.dns.records.create({
          zone_id: zoneId,
          type: "CNAME",
          name: fqdn,
          content: target,
          proxied: true,
          comment,
        }),
      );
    },
    async updateDnsRecord(zoneId: string, recordId: string, fqdn: string, target: string, comment: string) {
      await wrap(`updating the DNS record for ${fqdn}`, () =>
        client.dns.records.update(recordId, {
          zone_id: zoneId,
          type: "CNAME",
          name: fqdn,
          content: target,
          proxied: true,
          comment,
        }),
      );
    },
  };
}

/** SDK 客户端形状（tree-shakable createClient 的使用面子集） */
export interface SdkLike {
  zones: { list: (p?: unknown) => AsyncIterable<SdkZone> & Promise<{ result?: SdkZone[] }> };
  dns: { records: SdkDnsRecords };
  zeroTrust: { tunnels: { cloudflared: SdkTunnels } };
}
export interface SdkDnsRecords {
  list: (p: unknown) => Promise<{ result?: SdkDnsRecord[] }>;
  create: (p: unknown) => Promise<unknown>;
  update: (id: string, p: unknown) => Promise<unknown>;
}
export interface SdkTunnels {
  list: (p: unknown) => AsyncIterable<SdkTunnel> & Promise<{ result?: SdkTunnel[] }>;
  create: (p: unknown) => Promise<SdkTunnel>;
  token: { get: (id: string, p: unknown) => Promise<string> };
  configurations: {
    get: (id: string, p: unknown) => Promise<unknown>;
    update: (id: string, p: unknown) => Promise<unknown>;
  };
}

// ---- 裸 REST 等价实现（零依赖恒可用；与 SDK 实现同接口，可互换）----
// 默认网关（rest）：见文件尾 createGateway。
// 端点全部为官方文档已验证形态（含 zone.account 推导与 token 端点）。
// 存在的意义：SDK 全量包 62MB/16k 文件在部分文件系统上安装成本极高，且
// bundle 体积是发布门禁约束；窄接口下的手写成本 ~80 行、行为可完全对拍。

const CF_API = "https://api.cloudflare.com/client/v4";

interface CfEnvelope<T> {
  success?: boolean;
  result?: T;
  result_info?: { page?: number; per_page?: number; total_pages?: number };
  errors?: Array<{ code?: number; message?: string }>;
}

async function cfFetch<T>(token: string, path: string, init: RequestInit & { fetchImpl?: FetchLike } = {}): Promise<{ body: CfEnvelope<T> }> {
  const { fetchImpl = fetch, ...rest } = init;
  const res = await fetchImpl(`${CF_API}${path}`, {
    ...rest,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(rest.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as CfEnvelope<T>;
  if (!res.ok || body.success === false) {
    const errs = (body.errors ?? []).map((e) => `${e.code ?? "?"}: ${e.message ?? ""}`).join("; ");
    throw new CfApiError(`Cloudflare API rejected ${path} (HTTP ${res.status})${errs ? `: ${errs}` : ""}`, res.status);
  }
  return { body };
}

/** 收集分页结果（per_page 上限 100 之内取 50，翻到 total_pages） */
async function cfPages<T>(token: string, path: string, fetchImpl: FetchLike): Promise<T[]> {
  const out: T[] = [];
  let page = 1;
  for (;;) {
    const { body } = await cfFetch<T[]>(token, `${path}${path.includes("?") ? "&" : "?"}page=${page}&per_page=50`, { fetchImpl });
    out.push(...(body.result ?? []));
    const totalPages = body.result_info?.total_pages ?? 1;
    if (page >= totalPages) return out;
    page += 1;
  }
}

export async function createRestGateway(apiToken: string, fetchImpl: FetchLike = fetch): Promise<CfGateway> {
  const t = apiToken;
  const F = fetchImpl;
  const wrap = async <T>(action: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof CfApiError) throw e;
      throw toUserError(e, action);
    }
  };
  return {
    async listZones() {
      return wrap("listing zones", async () => {
        const zones = await cfPages<Record<string, never>>(t, "/zones", F); // 类型经 narrow 重述
        return zones
          .map((z) => z as unknown as { id?: string; name?: string; status?: string; account?: { id?: string; name?: string } })
          .filter((z) => z.id !== undefined && z.name !== undefined && z.account?.id !== undefined)
          .map((z) => ({
            id: z.id!,
            name: z.name!,
            status: z.status ?? "",
            accountId: z.account!.id!,
            accountName: z.account?.name ?? "",
          }));
      });
    },
    async listTunnels(accountId) {
      return wrap("listing tunnels", async () => {
        const tunnels = await cfPages<Record<string, never>>(t, `/accounts/${accountId}/cfd_tunnel?is_deleted=false`, F);
        return tunnels
          .map((x) => x as unknown as { id?: string; name?: string; status?: string; connections?: unknown[] })
          .filter((x) => x.id !== undefined && x.name !== undefined)
          .map((x) => ({
            id: x.id!,
            name: x.name!,
            status: x.status ?? "",
            connections: Array.isArray(x.connections) ? x.connections.length : 0,
          }));
      });
    },
    async createTunnel(accountId, name) {
      return wrap(`creating tunnel "${name}"`, async () => {
        const { body } = await cfFetch<{ id?: string; name?: string }>(t, `/accounts/${accountId}/cfd_tunnel`, {
          method: "POST",
          body: JSON.stringify({ name, config_src: "cloudflare" }),
          fetchImpl: F,
        });
        const r = body.result;
        if (r?.id === undefined) throw new CfApiError("tunnel create returned no id");
        return { id: r.id, name: r.name ?? name };
      });
    },
    async getTunnelToken(accountId, tunnelId) {
      return wrap("fetching the tunnel token", async () => {
        const { body } = await cfFetch<string>(t, `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`, { fetchImpl: F });
        const token = body.result;
        if (typeof token !== "string" || token === "") throw new CfApiError("empty tunnel token");
        return token;
      });
    },
    async getConfiguration(accountId, tunnelId) {
      return wrap("reading the tunnel configuration", async () => {
        const { body } = await cfFetch<{ config?: TunnelConfiguration }>(
          t,
          `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
          { fetchImpl: F },
        );
        const config = body.result?.config;
        // 整个 config 对象返回（含 originRequest 等非 ingress 字段）：
        // PUT 是全量替换，调用方需要它们才能不丢配置（B2）
        return config?.ingress === undefined ? null : config;
      });
    },
    async putConfiguration(accountId, tunnelId, config) {
      await wrap("pushing the tunnel configuration", () =>
        cfFetch(t, `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
          method: "PUT",
          body: JSON.stringify({ config }),
          fetchImpl: F,
        }),
      );
    },
    async findDnsRecord(zoneId, fqdn) {
      return wrap(`looking up the DNS record for ${fqdn}`, async () => {
        const { body } = await cfFetch<
          Array<{ id?: string; type?: string; name?: string; content?: string; comment?: string }>
        >(t, `/zones/${zoneId}/dns_records?name=${encodeURIComponent(fqdn)}`, { fetchImpl: F });
        const first = body.result?.[0];
        if (first?.id === undefined) return null;
        return {
          id: first.id,
          type: first.type ?? "",
          name: first.name ?? fqdn,
          content: first.content ?? "",
          ...(first.comment !== undefined ? { comment: first.comment } : {}),
        };
      });
    },
    async createDnsRecord(zoneId, fqdn, target, comment) {
      await wrap(`creating the DNS record for ${fqdn}`, () =>
        cfFetch(t, `/zones/${zoneId}/dns_records`, {
          method: "POST",
          body: JSON.stringify({ type: "CNAME", name: fqdn, content: target, proxied: true, comment }),
          fetchImpl: F,
        }),
      );
    },
    async updateDnsRecord(zoneId, recordId, fqdn, target, comment) {
      await wrap(`updating the DNS record for ${fqdn}`, () =>
        cfFetch(t, `/zones/${zoneId}/dns_records/${recordId}`, {
          method: "PUT",
          body: JSON.stringify({ type: "CNAME", name: fqdn, content: target, proxied: true, comment }),
          fetchImpl: F,
        }),
      );
    },
  };
}

/**
 * 默认网关工厂：REST 实现（零依赖、bundle 最小、端点全为已验证形态）。
 * SDK 实现装好并核对 tree-shakable 资源名后可经 CF_CLIENT=sdk 切换对拍。
 */
export const createGateway: (apiToken: string) => Promise<CfGateway> = (apiToken) =>
  process.env.CF_CLIENT === "sdk" ? createSdkGateway(apiToken) : createRestGateway(apiToken);
// 默认 rest（零依赖面最小、行为已被单测钉死）；CF_CLIENT=sdk 切官方 SDK 对拍
