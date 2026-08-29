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
 * - tunnelPending 非空 = 已 spawn、尚未通过健康窗口的子进程
 * - tunnelChild 非空 = 已通过启动健康窗口的活跃记录（含本 child 的 watchdog）
 * @param {number} [graceMs] 启动健康窗口（默认 2s；DWEB_CF_SPAWN_GRACE_MS 可调，测试注入）
 * @returns {Promise<void>} resolve = 已运行超过健康窗口；reject(Error) = 启动失败
 */
let tunnelStart = null; // 启动中的状态（并发调用共享其 promise）
let tunnelPending = null; // 已 spawn 但仍在健康窗口内的状态，供 preStop 取消
let tunnelChild = null; // 当前活跃记录 { child, watchdog }，供 preStop 摘除本 child 的观察器

function spawnCloudflared(token, graceMs = Number(process.env.DWEB_CF_SPAWN_GRACE_MS) || 2000) {
  if (tunnelStart !== null) return tunnelStart.promise;
  // 悬挂句柄（已退出但 exit 事件未派发）不得当作存活——清理后再 spawn
  if (tunnelChild !== null && !exited(tunnelChild.child)) {
    return Promise.resolve();
  }
  // 旧 child 的 exit 监听器仍必须保留：它会为真实的晚退输出 WARNING，
  // 但其闭包不会再清掉新的 tunnelChild。
  tunnelChild = null;

  const state = {
    promise: null,
    resolve: null,
    reject: null,
    child: null,
    poll: null,
    grace: null,
    settled: false,
    stopping: false,
    stopPromise: null,
  };
  state.promise = new Promise((resolve, reject) => {
    state.resolve = resolve;
    state.reject = reject;
  });
  tunnelStart = state;

  const clearStartupTimers = () => {
    if (state.poll !== null) {
      clearInterval(state.poll);
      state.poll = null;
    }
    if (state.grace !== null) {
      clearTimeout(state.grace);
      state.grace = null;
    }
  };
  const fail = (msg) => {
    if (state.settled) return;
    state.settled = true;
    clearStartupTimers();
    if (tunnelPending === state) tunnelPending = null;
    if (tunnelStart === state) tunnelStart = null;
    state.reject(new Error(msg));
  };

  let child;
  try {
    child = spawn("cloudflared", ["tunnel", "run"], {
      env: { ...process.env, TUNNEL_TOKEN: token },
      stdio: ["ignore", "inherit", "inherit"],
      detached: false,
    });
  } catch (e) {
    fail(`failed to start cloudflared (${e?.message ?? String(e)}); is it installed and on PATH?`);
    return state.promise;
  }

  state.child = child;
  tunnelPending = state;
  const exitLabel = () => `code ${child.exitCode ?? child.signalCode}`;
  const startupFailure = () =>
    `cloudflared exited during startup (${exitLabel()}); check TUNNEL_TOKEN and the tunnel config`;
  child.once("error", (e) => {
    if (!state.settled) {
      fail(`failed to start cloudflared (${e.message}); is it installed and on PATH?`);
    }
  });
  child.once("exit", () => {
    // 未过健康窗口的退出（exit 事件路径）= 启动失败。过窗后由该
    // child 专属 watchdog 负责告警，不能碰后续启动留下的新状态。
    if (!state.settled) fail(startupFailure());
  });
  child.once("spawn", () => {
    if (state.settled || state.stopping) return;
    // exit 事件在 macOS 上可滞后数百毫秒：grace 内高频同步轮询快照，
    // 弥补事件迟到（R3 竞态 1 的强化）。
    state.poll = setInterval(() => {
      if (exited(child)) fail(startupFailure());
    }, 50);
    state.poll.unref?.();
    state.grace = setTimeout(() => {
      if (state.settled || state.stopping) return;
      if (exited(child)) {
        fail(startupFailure());
        return;
      }

      // 先挂 late-exit 观察器、再做最后一次同步存活判定。否则 child
      // 恰在判定与 once("exit") 之间退出，会形成无声伪成功窗口。
      const active = { child, watchdog: null };
      const watchdog = () => {
        // 仅当前活跃记录才告警+清理（R5-Minor：promote 前的窄窗退出已由
        // startup exit listener 归一为启动失败，不得再叠一条 WARNING）
        if (tunnelChild !== active) return;
        tunnelChild = null;
        console.error(`WARNING: cloudflared exited (${exitLabel()}); the public tunnel is down`);
      };
      active.watchdog = watchdog;
      child.once("exit", watchdog);
      if (exited(child)) {
        child.removeListener("exit", watchdog);
        fail(startupFailure());
        return;
      }

      state.settled = true;
      clearStartupTimers(); // grace 成功路径同样必须释放 50ms poll interval
      if (tunnelPending === state) tunnelPending = null;
      if (tunnelStart === state) tunnelStart = null;
      tunnelChild = active;
      state.resolve();
    }, graceMs);
    state.grace.unref?.(); // 窗口计时不得阻止进程正常退出
  });
  return state.promise;
}

let tunnelStopAll = null; // 进行中的全程停止 Promise（并发 preStop 共享，R6-Major）

function stopCloudflared() {
  if (tunnelStopAll !== null) return tunnelStopAll;
  tunnelStopAll = (async () => {
    // 启动尚未过窗时，tunnelChild 尚不存在；必须取消并等待已 spawn 的
    // 子进程结束，不能让随后完成的 startup 变成孤儿进程。
    const starting = tunnelStart;
    if (starting !== null) {
      // Attach the rejection handler before waiting for the child: cancellation
      // can reject only after its exit event, and that expected rejection must
      // never become an unhandled rejection in the meantime.
      const stoppedStartup = starting.promise.catch(() => {});
      await stopPendingStartup(starting);
      await stoppedStartup;
    }

    const active = tunnelChild;
    if (active === null) return;
    if (tunnelChild === active) tunnelChild = null;
    // 主动停止不是异常退出：只摘除此 child 的 watchdog，不影响旧 child
    // 或之后新 child 的监听器。
    active.child.removeListener("exit", active.watchdog);
    await stopChild(active.child);
  })().finally(() => {
    // 停止流程结束后复位：之后的新启动/再停止不受本次共享影响
    tunnelStopAll = null;
  });
  return tunnelStopAll;
}

function stopPendingStartup(state) {
  if (state.stopPromise !== null) return state.stopPromise;
  state.stopping = true;
  if (!state.settled) {
    state.settled = true;
    if (state.poll !== null) {
      clearInterval(state.poll);
      state.poll = null;
    }
    if (state.grace !== null) {
      clearTimeout(state.grace);
      state.grace = null;
    }
    if (tunnelPending === state) tunnelPending = null;
    if (tunnelStart === state) tunnelStart = null;
    state.reject(new Error("cloudflared startup was stopped before it became healthy"));
  }
  state.stopPromise = state.child === null ? Promise.resolve() : stopChild(state.child);
  return state.stopPromise;
}

function stopChild(child) {
  if (exited(child)) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    let force = null;
    const finish = () => {
      if (done) return;
      done = true;
      child.removeListener("spawn", requestStop);
      child.removeListener("exit", finish);
      child.removeListener("error", finish);
      if (force !== null) clearTimeout(force);
      resolve();
    };
    const requestStop = () => {
      if (done || exited(child)) {
        finish();
        return;
      }
      try {
        child.kill("SIGINT");
      } catch {
        // spawn() can expose a ChildProcess before its OS process exists. In
        // that case wait for its spawn/error event rather than declaring it
        // stopped and allowing a later spawn to escape preStop.
        if (exited(child)) finish();
        else if (force === null) {
          force = setTimeout(() => {
            if (!exited(child)) {
              try {
                child.kill("SIGKILL");
              } catch {
                // Keep waiting for the child's terminal event.
              }
            }
          }, 5000);
          force.unref?.();
        }
        return;
      }
      if (force === null) {
        force = setTimeout(() => {
          if (!exited(child)) {
            try {
              child.kill("SIGKILL");
            } catch {
              finish();
            }
          }
        }, 5000);
        force.unref?.();
      }
    };
    child.once("exit", finish);
    child.once("error", finish);
    // ChildProcess is returned before the spawn event. Defer SIGINT until the
    // OS pid exists so preStop cannot race a startup into an orphan process.
    if (child.pid === undefined) child.once("spawn", requestStop);
    else requestStop();
  });
}

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null;
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
