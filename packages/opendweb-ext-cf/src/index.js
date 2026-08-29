// config 面（包根导出）：插件对象 {name, hooks}。options 来自 opendweb.config.toml：
//   tokenEnv  TUNNEL_TOKEN 环境变量名（默认 "TUNNEL_TOKEN"）
//   tunnel    true = server 生命周期内共生 spawn cloudflared（本机需已安装）
// 钩子：setup（向导）/ server.postReady（自检 + 共生 spawn + 横幅行）/
// server.preStop（清理共生进程）。云端 API 交互全部在 wizard/cf-api。
import { spawn } from "node:child_process";
import { runSetup, verifyExposure, planExposure } from "./wizard.js";

/**
 * 共生 cloudflared 的生命周期状态（R3 竞态重构：「启动中」与「已登记」
 * 拆分为独立状态，exit 事件可能迟到于进程实际退出，一切判定都以
 * child.exitCode/signalCode 的同步快照为准）：
 * - tunnelStart 非空 = 启动进行中（并发 postReady 共享同一 Promise）
 * - tunnelChild 非空 = 已通过启动健康窗口的存活进程
 * @param {number} [graceMs] 启动健康窗口（默认 2s；DWEB_CF_SPAWN_GRACE_MS 可调，测试注入）
 * @returns {Promise<void>} resolve = 已运行超过健康窗口；reject(Error) = 启动失败
 */
let tunnelStart = null; // 启动进行中的 Promise（并发调用共享）
let tunnelChild = null; // 已通过健康窗口的存活进程句柄（preStop 清理）
let tunnelWatchdog = null; // 过窗后的晚退观察器（无法再失败 postReady，转为 stderr WARNING）

function spawnCloudflared(token, graceMs = Number(process.env.DWEB_CF_SPAWN_GRACE_MS) || 2000) {
  if (tunnelStart !== null) return tunnelStart;
  // 悬挂句柄（已退出但 exit 事件未派发）不得当作存活——清理后再 spawn
  if (tunnelChild !== null && tunnelChild.exitCode === null && tunnelChild.signalCode === null) {
    return Promise.resolve();
  }
  tunnelChild = null;
  tunnelStart = new Promise((resolve, reject) => {
    const child = spawn("cloudflared", ["tunnel", "run"], {
      env: { ...process.env, TUNNEL_TOKEN: token },
      stdio: ["ignore", "inherit", "inherit"],
      detached: false,
    });
    let finished = false;
    let poll = null;
    let grace = null;
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    const exitLabel = () => `code ${child.exitCode ?? child.signalCode}`;
    const fail = (msg) => {
      if (finished) return;
      finished = true;
      if (poll) clearInterval(poll);
      if (grace) clearTimeout(grace);
      tunnelChild = null;
      tunnelStart = null;
      reject(new Error(msg));
    };
    const startupFailure = () =>
      `cloudflared exited during startup (${exitLabel()}); check TUNNEL_TOKEN and the tunnel config`;
    child.once("error", (e) => {
      fail(`failed to start cloudflared (${e.message}); is it installed and on PATH?`);
    });
    child.once("exit", () => {
      if (tunnelChild === child) tunnelChild = null;
      // 未过健康窗口的退出（exit 事件路径）= 启动失败
      if (!finished) fail(startupFailure());
    });
    child.once("spawn", () => {
      tunnelChild = child;
      // exit 事件在 macOS 上可滞后数百毫秒：grace 内高频同步轮询快照，
      // 弥补事件迟到（R3 竞态 1 的强化）
      poll = setInterval(() => {
        if (exited()) fail(startupFailure());
      }, 50);
      poll.unref?.();
      grace = setTimeout(() => {
        if (exited()) {
          fail(startupFailure());
          return;
        }
        finished = true;
        tunnelStart = null;
        resolve();
        // 过窗后才退出（真实 cloudflared 坏 token 约 3s 后退出，事件也可能
        // 迟到于 grace）：postReady 已返回，无法再改判——但绝不能无声伪成功，
        // 转 stderr WARNING（preStop 主动停止会先摘除观察器）
        tunnelWatchdog = () => {
          tunnelWatchdog = null;
          console.error(`WARNING: cloudflared exited (${exitLabel()}); the public tunnel is down`);
        };
        child.once("exit", tunnelWatchdog);
      }, graceMs);
      grace.unref?.(); // 窗口计时不得阻止进程正常退出
    });
  });
  return tunnelStart;
}

function stopCloudflared() {
  return new Promise((resolve) => {
    if (tunnelChild === null) return resolve();
    const child = tunnelChild;
    tunnelChild = null;
    // 主动停止不是异常退出：摘除晚退观察器（避免误报 WARNING）
    if (tunnelWatchdog !== null) {
      child.removeListener("exit", tunnelWatchdog);
      tunnelWatchdog = null;
    }
    // 已退出（事件未派发）时不得等待一个可能已错过的 exit 事件（R3 竞态 3）
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGINT");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 5000).unref();
  });
}

export default {
  name: "cf",
  hooks: {
    /** `opendweb setup`：非交互向导（hostname 由 options.hostname 或 server 公网 URL 推导） */
    async setup(ctx) {
      const tokenEnv = ctx.options?.tokenEnv ?? "TUNNEL_TOKEN";
      const token = process.env[tokenEnv];
      const hostname = ctx.options?.hostname ?? hostnameFromServer(ctx.server);
      if (!hostname) {
        throw new Error("cf setup needs options.hostname (or server.publicGatewayUrl) in opendweb.config.toml");
      }
      if (!token && !ctx.options?.dryRun) {
        throw new Error(`missing ${tokenEnv} in the environment`);
      }
      await runSetup({
        token: token ?? "dry-run-token",
        hostname,
        mode: ctx.options?.mode === "single" ? "single" : "dual",
        cwd: ctx.cwd ?? process.cwd(),
        // R2-M2：`opendweb setup --config <path>` 时写用户所选文件（CLI 面
        // 直接调用则回落 cwd 下的默认名）
        configPath: ctx.configPath ?? undefined,
        tokenEnvName: tokenEnv,
        dryRun: Boolean(ctx.options?.dryRun),
        skipVerify: Boolean(ctx.options?.skipVerify),
        log: () => {}, // 钩子内静默执行；状态由 CLI 聚合输出
      });
      return { done: true };
    },

    /** 就绪后：可选共生 spawn + 端到端自检（失败降级 WARNING 由 CLI 处理） */
    async "server.postReady"(ctx) {
      const lines = [];
      const tokenEnv = ctx.options?.tokenEnv ?? "TUNNEL_TOKEN";
      const token = process.env[tokenEnv];
      const gatewayUrl = ctx.publicGatewayUrl ?? ctx.server?.publicGatewayUrl ?? null;
      const relayUrl = ctx.publicRelayUrl ?? ctx.server?.publicRelayUrl ?? null;

      if (ctx.options?.tunnel === true) {
        if (!token) {
          throw new Error(`options.tunnel is on but ${tokenEnv} is not set`);
        }
        // 失败（如 cloudflared 未安装）按 postReady 失败降级为 WARNING，
        // 不得击穿 CLI（R2 阻塞-6）
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
    async "server.preStop"() {
      await stopCloudflared();
      return null;
    },
  },
};

/** 从 server 配置的公网 URL 推导 hostname（https://gw.example.com -> gw.example.com） */
function hostnameFromServer(server) {
  const url = server?.publicGatewayUrl;
  if (typeof url !== "string" || !url.startsWith("https://")) return null;
  return url.slice("https://".length).replace(/\/+$/, "").split(":")[0];
}
