// setup 向导核心（命令与 setup 钩子共享）：
// token 解码 → ingress 构建（双主机名默认/单域名可选）→ API 推送 → DNS 路由
// （best-effort）→ 写 opendweb.config.toml（仅当文件不存在；已存在时打印
// 待合并片段，不破坏用户注释）→ 端到端自检（公网拉 services.json 断言）。
// dryRun：跳过一切网络副作用（API/DNS/自检），仅产出「将会做什么」。
import path from "node:path";
import { decodeTunnelToken, buildIngress, pushIngress, routeDns, type FetchLike } from "./cf-api.js";

export type ExposureMode = "dual" | "single";

export interface ExposurePlan {
  mode: ExposureMode;
  gatewayHost: string;
  relayHost: string;
  publicGatewayUrl: string;
  publicRelayUrl: string;
}

export interface VerifyInfo {
  elapsedMs: number;
  lastError: string;
}

export type VerifyResult = { ok: true } | { ok: false; error: string };

/**
 * 解析向导输入 → 目标形态（纯函数，测试锚点）。
 * hostname 先过 DNS 形态校验（R2-M7：`foo.com&account.id=evil` 这类输入
 * 会原样进入公网 URL 与 API query，必须在入口拒绝）。
 */
export function planExposure({ hostname, mode = "dual" }: { hostname: string; mode?: ExposureMode }): ExposurePlan {
  let raw = String(hostname ?? "").trim().toLowerCase();
  if (raw.endsWith(".")) raw = raw.slice(0, -1); // FQDN 尾点合法（R3-Minor）
  // 每段：字母数字开头/结尾，中间可含 -，长度 <= 63（DNS label 规则）；
  // 整体至少两段（可路由域名，非裸 TLD/localhost）、总长 <= 253；dual
  // 模式实际使用 relay.<hostname>，派生后的 DNS 名也必须落在同一上限内。
  const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
  const labels = raw.split(".");
  const relayHost = `relay.${raw}`;
  if (labels.length < 2 || raw.length > 253 || relayHost.length > 253 || !labels.every((l) => LABEL.test(l))) {
    throw new Error(`invalid hostname: ${JSON.stringify(hostname ?? "")} (expected a DNS name like dweb.example.com)`);
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

/**
 * 生成要写入的 opendweb.config.toml 内容（全新文件；已存在文件只打印片段）。
 * 手渲染固定形态（全部值已经过校验，JSON 字符串转义对 TOML basic string 安全）。
 */
export function renderConfigToml({
  plan,
  tokenEnv,
  gatewayBind = "0.0.0.0:8787",
  relayBind = "0.0.0.0:3340",
}: {
  plan: ExposurePlan;
  tokenEnv: string;
  gatewayBind?: string;
  relayBind?: string;
}): string {
  const q = (s: string) => JSON.stringify(s);
  return [
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
    "[plugins.options]",
    `tokenEnv = ${q(tokenEnv)}`,
    "",
  ].join("\n");
}

/**
 * 端到端自检：经公网入口拉 /services.json，断言公告的 relay URL 与期望一致。
 * R2-M3：deadline 严格——单次 fetch 的 AbortSignal 取剩余毫秒（下限 1ms，
 * 不再垫到 1s）、轮询 sleep 不超出 deadline，并对不尊重 signal 的实现加
 * Promise.race 兜底，保证整个函数在 timeoutMs 附近必然返回。
 * onProgress：每轮等待前回调一次（交互引导的等待反馈）；非交互调用省略。
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
  onProgress?: ((info: VerifyInfo) => void) | undefined;
}): Promise<VerifyResult> {
  const deadline = Date.now() + timeoutMs;
  const url = `${publicGatewayUrl.replace(/\/+$/, "")}/services.json`;
  let lastError = "";
  const raceRemaining = <T>(p: Promise<T>): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, reject) => {
        const left = deadline - Date.now();
        const t = setTimeout(() => reject(new Error(`deadline exceeded (${timeoutMs}ms)`)), Math.max(1, left));
        t.unref?.();
      }),
    ]);
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    try {
      const res = await raceRemaining(fetchImpl(url, { signal: AbortSignal.timeout(Math.max(1, remaining)) }));
      if (res.ok) {
        const manifest = (await raceRemaining(res.json())) as { services?: Array<{ name?: string; enabled?: boolean; url?: string | null }> };
        const relayEntry = (manifest.services ?? []).find((s) => s.name === "relay");
        if (relayEntry?.enabled !== true) {
          return { ok: false, error: "public services.json reports relay disabled" };
        }
        if (relayEntry.url !== expectedRelayUrl) {
          return { ok: false, error: `relay URL mismatch: advertised ${relayEntry.url}, expected ${expectedRelayUrl}` };
        }
        return { ok: true };
      }
      lastError = `HTTP ${res.status}`;
    } catch (e) {
      lastError = (e as Error)?.message ?? String(e);
    }
    const left = deadline - Date.now();
    if (onProgress) onProgress({ elapsedMs: timeoutMs - left, lastError });
    if (left > 0) await new Promise((r) => setTimeout(r, Math.min(1000, left)));
  }
  return { ok: false, error: `public gateway not reachable within ${timeoutMs}ms (${lastError})` };
}

export interface RunSetupOptions {
  /** TUNNEL_TOKEN：连接器 token（解码出 account/tunnel id；运行 cloudflared 用） */
  token: string;
  /**
   * 管理 API token（CF_API_TOKEN，2026-08-31 实测 401 修正）：connector
   * token 无 REST API 权限——PUT configurations / DNS 记录需要独立创建的
   * API Token（Account/Cloudflare Tunnel/Edit + Zone/DNS/Edit）。缺省回落
   * 环境变量 CF_API_TOKEN；dry-run 不需要。
   */
  apiToken?: string | undefined;
  hostname: string;
  mode?: ExposureMode;
  cwd: string;
  /** R2-M2：显式目标文件（`opendweb setup --config`）；缺省为 cwd 下的默认名 */
  configPath?: string | null | undefined;
  tokenEnvName?: string;
  dryRun?: boolean;
  skipVerify?: boolean;
  fetchImpl?: FetchLike;
  writeFile?: (p: string, content: string) => Promise<void>;
  exists?: (p: string) => boolean;
  log?: (line: string) => void;
  /** 透传给 verifyExposure 的 onProgress（交互等待反馈） */
  verifyProgress?: (info: VerifyInfo) => void;
}

/**
 * 完整 setup 流程（命令/钩子共享）。逐步报告；任一步失败抛错。
 */
export async function runSetup(input: RunSetupOptions): Promise<{ plan: ExposurePlan }> {
  const {
    token,
    apiToken,
    hostname,
    mode = "dual",
    cwd,
    configPath = null,
    tokenEnvName = "TUNNEL_TOKEN",
    dryRun = false,
    skipVerify = false,
    fetchImpl = fetch,
    writeFile = defaultWriteFile,
    exists = defaultExists,
    log = () => {},
    verifyProgress,
  } = input;
  const plan = planExposure({ hostname, mode });
  // 管理 token：connector token（TUNNEL_TOKEN）无 REST 权限，API 推送必须
  // 用独立创建的 API Token；缺失时给出可照做的创建指引
  const managementToken = apiToken ?? process.env.CF_API_TOKEN ?? "";
  if (!dryRun && managementToken === "") {
    throw new Error(
      "missing CF_API_TOKEN: create one at dash.cloudflare.com -> My Profile -> API Tokens -> Create Token " +
        "(Custom Token: Account / Cloudflare Tunnel / Edit, plus Zone / DNS / Edit for your zone), " +
        "then export CF_API_TOKEN or pass --api-token",
    );
  }
  // dry-run 容忍不可解码 token（占位符）：dry-run 的意义是零前置条件预览
  let creds;
  if (dryRun) {
    try {
      creds = decodeTunnelToken(token);
    } catch {
      creds = { accountTag: "<unknown>", tunnelId: "<unknown>", apiToken: "" };
    }
  } else {
    creds = decodeTunnelToken(token);
  }
  const ingress = buildIngress({ mode: plan.mode, gatewayHost: plan.gatewayHost, relayHost: plan.relayHost });

  log(`tunnel: ${creds.tunnelId} (account ${creds.accountTag})`);
  log(
    `mode: ${plan.mode === "single" ? "single-domain path routing" : "dual hostname"} -> ${plan.publicGatewayUrl}${
      plan.mode === "single" ? "" : ` + ${plan.publicRelayUrl}`
    }`,
  );

  if (dryRun) {
    log("dry-run: would PUT ingress config:");
    for (const rule of ingress.ingress) log(`  ${JSON.stringify(rule)}`);
    log(
      `dry-run: would route DNS ${plan.relayHost}${plan.mode === "single" ? "" : ` and ${plan.gatewayHost}`} -> ${creds.tunnelId}.cfargotunnel.com`,
    );
    log("dry-run: would write opendweb.config.toml:");
    return { plan };
  }

  await pushIngress({ fetchImpl, accountTag: creds.accountTag, tunnelId: creds.tunnelId, apiToken: managementToken, ingress });
  log(`ingress pushed (${ingress.ingress.length} rules)`);

  try {
    await routeDns({
      fetchImpl,
      accountTag: creds.accountTag,
      tunnelId: creds.tunnelId,
      apiToken: managementToken,
      hostnames: plan.mode === "single" ? [plan.gatewayHost] : [plan.relayHost, plan.gatewayHost],
    });
    log(`dns routed (CNAME -> ${creds.tunnelId}.cfargotunnel.com)`);
  } catch (e) {
    log(`WARNING: ${(e as Error).message}`);
  }

  // R2-M2：目标文件 = 显式 configPath（`opendweb setup --config`）或 cwd 默认名
  const targetConfigPath = configPath ?? path.join(cwd, "opendweb.config.toml");
  if (exists(targetConfigPath)) {
    log(`${relativeLabel(cwd, targetConfigPath)} already exists; merge these values manually:`);
    log(`  [server]`);
    log(`  publicGatewayUrl = ${JSON.stringify(plan.publicGatewayUrl)}`);
    log(`  publicRelayUrl   = ${JSON.stringify(plan.publicRelayUrl)}`);
    log(`  [[plugins]]`);
    log(`  name = "cf"`);
    log(`  [plugins.options]`);
    log(`  tokenEnv = ${JSON.stringify(tokenEnvName)}`);
  } else {
    await writeFile(targetConfigPath, renderConfigToml({ plan, tokenEnv: tokenEnvName }));
    log(`wrote ${targetConfigPath}`);
  }

  if (!skipVerify) {
    log("verifying end-to-end via the public gateway...");
    const v = await verifyExposure({
      fetchImpl,
      publicGatewayUrl: plan.publicGatewayUrl,
      expectedRelayUrl: plan.publicRelayUrl,
      onProgress: verifyProgress,
    });
    if (!v.ok) throw new Error(`verification failed: ${v.error} (is cloudflared running for this tunnel?)`);
    log("verification ok: services.json advertises the expected relay URL");
  }
  log(`clients can now use: config set relay ${plan.publicGatewayUrl}`);
  return { plan };
}

import { writeFile as defaultWriteFileImpl } from "node:fs/promises";
import { existsSync as defaultExistsImpl } from "node:fs";
async function defaultWriteFile(p: string, content: string): Promise<void> {
  await defaultWriteFileImpl(p, content, "utf8");
}
function defaultExists(p: string): boolean {
  return defaultExistsImpl(p);
}
/** 相对 cwd 展示路径（同目录则裸文件名，否则原样绝对路径） */
function relativeLabel(cwd: string, p: string): string {
  return p.startsWith(`${cwd}${path.sep}`) ? p.slice(cwd.length + 1) : p;
}
