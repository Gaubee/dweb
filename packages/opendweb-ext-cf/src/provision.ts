// 幂等编排（1.0.0 核心）：desired-state 式 ensure 链——tunnel → ingress 配置
// → DNS → 本地 config 落盘 → 端到端自检。原则（cf-provider-rewrite proposal）：
// - 已存在资源一律复用（tunnel 命名 ownership：opendweb-<hostname 标签>）
// - configurations PUT 是全量替换：写前 GET-diff，相等 no-op；差异仅在资源
//   属于本产品（命名前缀）或用户显式选择复用时写入
// - DNS：exact 查询；无记录创建（comment 标记 ownership）；指向本 tunnel 即
//   no-op；指向他处必须经交互确认（非交互默认 abort，绝不静默覆盖）
import type { CfGateway, DnsRecordSummary, TunnelConfiguration } from "./cf-client.js";
import {
  planExposure,
  buildIngress,
  renderConfigToml,
  verifyExposure,
  type ExposureMode,
  type ExposurePlan,
  type IngressConfig,
} from "./route-model.js";
import path from "node:path";
import { decodeTunnelToken, type FetchLike } from "./cf-api.js";

export const DNS_MANAGED_BY = "managed-by=opendweb";
export const TUNNEL_NAME_PREFIX = "opendweb-";

/** tunnel 命名：hostname 标签化（gaubee.tweb.xin → opendweb-gaubee-tweb-xin） */
export function tunnelNameFor(hostname: string): string {
  return `${TUNNEL_NAME_PREFIX}${hostname.replace(/\./g, "-")}`;
}

export type TunnelChoice =
  | { kind: "auto" } // config 锚点优先 → 按命名查找 → 新建
  | { kind: "new"; name: string }
  | { kind: "existing"; id: string };

export interface ProvisionInput {
  client: CfGateway;
  hostname: string;
  mode: ExposureMode;
  /** zone（含 account 推导）；缺省由调用方先经交互选定 */
  zone: { id: string; name: string; accountId: string; accountName: string };
  tunnel: TunnelChoice;
  cwd: string;
  configPath?: string | null;
  dryRun?: boolean;
  skipVerify?: boolean;
  /** 供 verifyExposure 注入与超时 */
  fetchImpl?: FetchLike;
  verifyTimeoutMs?: number;
  /** 交互回调（TUI 提供）；非交互路径默认保守行为 */
  onDnsConflict?: (record: DnsRecordSummary, hostname: string) => Promise<"replace" | "abort">;
  writeFile?: (p: string, content: string) => Promise<void>;
  exists?: (p: string) => boolean;
  log?: (line: string) => void;
}

export interface ProvisionResult {
  plan: ExposurePlan;
  accountId: string;
  zoneId: string;
  tunnelId: string;
  /** 新建 tunnel 时返回 connector token（一次性展示给用户；不落盘） */
  tunnelToken: string | null;
  configWritten: boolean;
}

function ingressEqual(a: IngressConfig, b: IngressConfig): boolean {
  return JSON.stringify(a.ingress) === JSON.stringify(b.ingress);
}

/**
 * 期望的完整 tunnel 配置（B2）：configurations PUT 是全量替换——仅发送
 * {ingress} 会静默丢掉既有 originRequest/warpRouting 等字段。这里把当前
 * 配置的非 ingress 字段原样保留，仅替换 ingress。
 */
function mergeConfiguration(current: TunnelConfiguration | null, desiredIngress: IngressConfig): TunnelConfiguration {
  if (current === null) return { ingress: desiredIngress.ingress };
  return { ...current, ingress: desiredIngress.ingress };
}

export async function provision(input: ProvisionInput): Promise<ProvisionResult> {
  const {
    client,
    zone,
    tunnel: tunnelChoice,
    cwd,
    configPath = null,
    dryRun = false,
    skipVerify = false,
    log = () => {},
  } = input;
  const plan = planExposure({ hostname: input.hostname, mode: input.mode });
  const desiredIngress = buildIngress({ mode: plan.mode, gatewayHost: plan.gatewayHost, relayHost: plan.relayHost });

  // ---- ensure tunnel ----
  let tunnelId: string | null = null;
  let createdTunnel = false;
  if (tunnelChoice.kind === "existing") {
    tunnelId = tunnelChoice.id;
    log(`tunnel: reusing ${tunnelId}`);
  } else {
    const wanted = tunnelChoice.kind === "new" ? tunnelChoice.name : tunnelNameFor(plan.gatewayHost);
    const existing = (await client.listTunnels(zone.accountId)).find((t) => t.name === wanted);
    if (existing !== undefined) {
      // kind:"new" 是显式命名的新建意图：同名已存在时静默复用会紧接着覆盖其
      // 配置（所有权缺口 B3a）——非 dry-run 一律显式拒绝，让用户选 reuse 或改名
      if (tunnelChoice.kind === "new") {
        if (!dryRun) {
          throw new Error(`tunnel "${wanted}" already exists - choose reuse or a different name`);
        }
        log(`dry-run: tunnel "${wanted}" already exists (rerun with reuse or a different name)`);
      }
      tunnelId = existing.id;
      log(`tunnel: found existing "${wanted}" (${tunnelId})`);
    } else if (dryRun) {
      log(`dry-run: would create tunnel "${wanted}"`);
    } else {
      const created = await client.createTunnel(zone.accountId, wanted);
      tunnelId = created.id;
      createdTunnel = true;
      log(`tunnel: created "${wanted}" (${tunnelId})`);
    }
  }

  // ---- ensure configuration（GET-diff → PUT 全量，非 ingress 字段保留）----
  if (tunnelId !== null) {
    const current = await client.getConfiguration(zone.accountId, tunnelId);
    if (current !== null && ingressEqual(current, desiredIngress)) {
      log("ingress: configuration already up to date (no-op)");
    } else if (dryRun) {
      log("dry-run: would PUT ingress configuration:");
      for (const rule of desiredIngress.ingress) log(`  ${JSON.stringify(rule)}`);
    } else {
      // PUT 全量替换：merge 当前配置的非 ingress 字段（originRequest 等），
      // 仅 ingress 换成期望值（B2：不能静默丢用户已有的全局配置）
      await client.putConfiguration(zone.accountId, tunnelId, mergeConfiguration(current, desiredIngress));
      log(`ingress: pushed ${desiredIngress.ingress.length} rules (full replacement)`);
    }
  }

  // ---- ensure DNS（逐 hostname；冲突必须确认）----
  const hostnames = plan.mode === "single" ? [plan.gatewayHost] : [plan.relayHost, plan.gatewayHost];
  const target = `${tunnelId ?? "<tunnel>"}.cfargotunnel.com`;
  for (const host of hostnames) {
    const record = await client.findDnsRecord(zone.id, host);
    if (record === null) {
      if (dryRun) {
        log(`dry-run: would create CNAME ${host} -> ${target}`);
        continue;
      }
      await client.createDnsRecord(zone.id, host, target, DNS_MANAGED_BY);
      log(`dns: CNAME ${host} -> ${target} created`);
      continue;
    }
    if (record.type === "CNAME" && record.content === target) {
      log(`dns: ${host} already routed to this tunnel (no-op)`);
      continue;
    }
    log(
      `dns: ${host} already has a ${record.type} record -> ${record.content}` +
        `${record.comment !== undefined && record.comment !== "" ? ` (comment: ${record.comment})` : ""}`,
    );
    if (dryRun) {
      log(`dry-run: would replace it with CNAME -> ${target} after confirmation`);
      continue;
    }
    const decision =
      input.onDnsConflict !== undefined ? await input.onDnsConflict(record, host) : "abort" as const;
    if (decision === "abort") {
      throw new Error(
        `DNS record for ${host} is not owned by this setup (declined); ` +
          `remove or update it manually, or choose replace when re-running`,
      );
    }
    await client.updateDnsRecord(zone.id, record.id, host, target, DNS_MANAGED_BY);
    log(`dns: ${host} replaced with CNAME -> ${target} (user-approved)`);
  }

  // ---- 写本地 config（存在则 merge fragment 指引，绝不覆盖）----
  const targetFile = configPath ?? path.join(cwd, "opendweb.config.toml");
  const exists = input.exists ?? ((p: string) => false);
  const write = input.writeFile ?? (async () => {});
  let configWritten = false;
  const toml = renderConfigToml({
    plan,
    resource:
      tunnelId !== null
        ? { accountId: zone.accountId, zoneId: zone.id, tunnelId }
        : {},
  });
  if (dryRun) {
    log(`dry-run: would write ${targetFile}`);
  } else if (exists(targetFile)) {
    log(`${path.relative(cwd, targetFile) || targetFile} already exists; merge these values manually:`);
    log(toml.trimEnd());
  } else {
    await write(targetFile, toml);
    configWritten = true;
    log(`config: wrote ${targetFile}`);
  }

  // ---- 端到端自检（保持旧行为：失败即整体失败）----
  if (!dryRun && !skipVerify) {
    const v = await verifyExposure({
      ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
      publicGatewayUrl: plan.publicGatewayUrl,
      expectedRelayUrl: plan.publicRelayUrl,
      ...(input.verifyTimeoutMs !== undefined ? { timeoutMs: input.verifyTimeoutMs } : {}),
    });
    if (!v.ok) {
      throw new Error(`verification failed: ${v.error}`);
    }
    log("verified: public services.json advertises the expected relay URL");
  }

  // ---- 新建 tunnel：取 connector token（一次性返回，不落盘）----
  let tunnelToken: string | null = null;
  if (createdTunnel && tunnelId !== null) {
    tunnelToken = await client.getTunnelToken(zone.accountId, tunnelId);
  }

  return {
    plan,
    accountId: zone.accountId,
    zoneId: zone.id,
    tunnelId: tunnelId ?? "",
    tunnelToken,
    configWritten,
  };
}

/** 校验既有 connector token 并提取 account/tunnel（postReady 兼容路径） */
export function tunnelIdentityOf(token: string): { accountId: string; tunnelId: string } {
  const creds = decodeTunnelToken(token);
  return { accountId: creds.accountTag, tunnelId: creds.tunnelId };
}
