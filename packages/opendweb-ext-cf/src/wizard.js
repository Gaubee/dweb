// setup 向导核心（命令与 setup 钩子共享）：
// token 解码 → ingress 构建（双主机名默认/单域名可选）→ API 推送 → DNS 路由
// （best-effort）→ 写 opendweb.config.toml（仅当文件不存在；已存在时打印
// 待合并片段，不破坏用户注释）→ 端到端自检（公网拉 services.json 断言）。
// dryRun：跳过一切网络副作用（API/DNS/自检），仅产出「将会做什么」。
import path from "node:path";
import { decodeTunnelToken, buildIngress, pushIngress, routeDns } from "./cf-api.js";

/**
 * 解析向导输入 → 目标形态（纯函数，测试锚点）。
 * @param {{ hostname: string, mode?: "dual" | "single" }} input
 */
export function planExposure({ hostname, mode = "dual" }) {
  const gatewayHost = hostname.toLowerCase();
  const relayHost = `relay.${gatewayHost}`;
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
 * 手渲染固定形态（全部值已经过校验，JSON 字符串转义对 TOML basic string 安全），
 * 保持插件零依赖。
 * @param {{ plan: ReturnType<typeof planExposure>, tokenEnv: string, gatewayBind?: string, relayBind?: string }} input
 */
export function renderConfigToml({ plan, tokenEnv, gatewayBind = "0.0.0.0:8787", relayBind = "0.0.0.0:3340" }) {
  const q = (s) => JSON.stringify(s);
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
 * @param {{ fetchImpl?: typeof fetch, publicGatewayUrl: string, expectedRelayUrl: string, timeoutMs?: number }} input
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function verifyExposure({ fetchImpl = fetch, publicGatewayUrl, expectedRelayUrl, timeoutMs = 30000 }) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      // R2 阻塞-7：单次 fetch 受剩余时间约束——悬挂的连接会让 await 永不
      // 返回，while 的 deadline 检查也就永不发生（postReady 整体挂死）
      const res = await fetchImpl(`${publicGatewayUrl.replace(/\/+$/, "")}/services.json`, {
        signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
      });
      if (res.ok) {
        const manifest = await res.json();
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
      lastError = e.message;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { ok: false, error: `public gateway not reachable within ${timeoutMs}ms (${lastError})` };
}

/**
 * 完整 setup 流程（命令/钩子共享）。逐步报告；任一步失败抛错。
 * @param {{ token: string, hostname: string, mode?: "dual"|"single", cwd: string, tokenEnvName?: string,
 *           dryRun?: boolean, skipVerify?: boolean, fetchImpl?: typeof fetch,
 *           writeFile?: (p: string, content: string) => Promise<void>, exists?: (p: string) => boolean,
 *           log?: (line: string) => void }} input
 * @returns {Promise<{ plan: ReturnType<typeof planExposure> }>}
 */
export async function runSetup(input) {
  const {
    token, hostname, mode = "dual", cwd,
    tokenEnvName = "TUNNEL_TOKEN",
    dryRun = false, skipVerify = false,
    fetchImpl = fetch,
    writeFile = defaultWriteFile,
    exists = defaultExists,
    log = () => {},
  } = input;
  const plan = planExposure({ hostname, mode });
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
  log(`mode: ${plan.mode === "single" ? "single-domain path routing" : "dual hostname"} -> ${plan.publicGatewayUrl}${plan.mode === "single" ? "" : ` + ${plan.publicRelayUrl}`}`);

  if (dryRun) {
    log("dry-run: would PUT ingress config:");
    for (const rule of ingress.ingress) log(`  ${JSON.stringify(rule)}`);
    log(`dry-run: would route DNS ${plan.relayHost}${plan.mode === "single" ? "" : ` and ${plan.gatewayHost}`} -> ${creds.tunnelId}.cfargotunnel.com`);
    log("dry-run: would write opendweb.config.toml:");
    return { plan };
  }

  await pushIngress({ fetchImpl, ...creds, ingress });
  log(`ingress pushed (${ingress.ingress.length} rules)`);

  try {
    await routeDns({ fetchImpl, ...creds, hostnames: plan.mode === "single" ? [plan.gatewayHost] : [plan.relayHost, plan.gatewayHost] });
    log(`dns routed (CNAME -> ${creds.tunnelId}.cfargotunnel.com)`);
  } catch (e) {
    log(`WARNING: ${e.message}`);
  }

  const configPath = path.join(cwd, "opendweb.config.toml");
  if (exists(configPath)) {
    log("opendweb.config.toml already exists; merge these values manually:");
    log(`  [server]`);
    log(`  publicGatewayUrl = ${JSON.stringify(plan.publicGatewayUrl)}`);
    log(`  publicRelayUrl   = ${JSON.stringify(plan.publicRelayUrl)}`);
    log(`  [[plugins]]`);
    log(`  name = "cf"`);
    log(`  [plugins.options]`);
    log(`  tokenEnv = ${JSON.stringify(tokenEnvName)}`);
  } else {
    await writeFile(configPath, renderConfigToml({ plan, tokenEnv: tokenEnvName }));
    log(`wrote ${configPath}`);
  }

  if (!skipVerify) {
    log("verifying end-to-end via the public gateway...");
    const v = await verifyExposure({ fetchImpl, publicGatewayUrl: plan.publicGatewayUrl, expectedRelayUrl: plan.publicRelayUrl });
    if (!v.ok) throw new Error(`verification failed: ${v.error} (is cloudflared running for this tunnel?)`);
    log("verification ok: services.json advertises the expected relay URL");
  }
  log(`clients can now use: config set relay ${plan.publicGatewayUrl}`);
  return { plan };
}

import { writeFile as defaultWriteFileImpl } from "node:fs/promises";
import { existsSync as defaultExistsImpl } from "node:fs";
async function defaultWriteFile(p, content) {
  await defaultWriteFileImpl(p, content, "utf8");
}
function defaultExists(p) {
  return defaultExistsImpl(p);
}
