// config 面（包根导出）：插件对象 {name, hooks}。options 来自 opendweb.config.toml：
//   tokenEnv  TUNNEL_TOKEN 环境变量名（默认 "TUNNEL_TOKEN"）
//   tunnel    true = server 生命周期内共生 spawn cloudflared（本机需已安装）
// 钩子：setup（向导）/ server.postReady（自检 + 共生 spawn + 横幅行）/
// server.preStop（清理共生进程）。云端 API 交互全部在 wizard/cf-api。
import { spawn } from "node:child_process";
import { runSetup, verifyExposure, planExposure } from "./wizard.js";

/** 共生 cloudflared 进程句柄（进程内单例；preStop 清理） */
let tunnelChild = null;

/**
 * spawn 的 error 事件在解释器不存在（ENOENT）等场景触发——没有监听器会
 * 让未处理异常击穿整个 CLI。R2 阻塞-6：捕获并经 onError 降级。
 * @returns {Promise<void>} resolve = 已开始运行；reject(Error) = 启动失败
 */
function spawnCloudflared(token) {
  return new Promise((resolve, reject) => {
    if (tunnelChild !== null) return resolve();
    const child = spawn("cloudflared", ["tunnel", "run"], {
      env: { ...process.env, TUNNEL_TOKEN: token },
      stdio: ["ignore", "inherit", "inherit"],
      detached: false,
    });
    let settled = false;
    child.once("error", (e) => {
      if (settled) return;
      settled = true;
      tunnelChild = null;
      reject(new Error(`failed to start cloudflared (${e.message}); is it installed and on PATH?`));
    });
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      tunnelChild = child;
      child.once("exit", () => {
        if (tunnelChild === child) tunnelChild = null;
      });
      resolve();
    });
  });
}

function stopCloudflared() {
  return new Promise((resolve) => {
    if (tunnelChild === null) return resolve();
    const child = tunnelChild;
    tunnelChild = null;
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
