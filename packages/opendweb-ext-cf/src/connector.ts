// Connector 数据面（1.0.0 自 index.ts 迁移）：cloudflared 共生运行的生命周期
// 状态机——grace 健康窗口、per-child late-exit watchdog、stop 事务与全部竞态
// 保证（R3-R6 多轮复审打磨）原样保留。1.0.0 变化：spawn 目标经
// resolveCloudflaredBin() 参数化——PATH 上的 cloudflared 优先（兼容现状），
// 否则 npm:cloudflared 按需 install() 到 ~/.opendweb/cloudflared/<ver>/
// （CLOUDFLARED_BIN 显式覆盖；安装失败降级为手动指引，不阻塞宿主）。
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

/** cloudflared 可执行文件定位（同步路径：PATH/内置缓存探测；缺省惰性安装） */
export function cloudflaredHome(homeBase?: string): string {
  return path.join(homeBase ?? path.join(os.homedir(), ".opendweb"), "cloudflared");
}

/** 已缓存的 cloudflared 路径（无网络副作用；找不到返回 null） */
export function cachedCloudflaredBin(homeBase?: string): string | null {
  const envBin = process.env.CLOUDFLARED_BIN;
  if (envBin && envBin.trim() !== "" && existsSync(envBin)) return envBin;
  // PATH 上的 cloudflared 优先（0.2.x 行为兼容：用户已装的官方 binary）
  const names = process.platform === "win32" ? ["cloudflared.exe"] : ["cloudflared"];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    for (const name of names) {
      const p = path.join(dir, name);
      try {
        if (existsSync(p)) return p;
      } catch {
        /* 不可读的 PATH 段跳过 */
      }
    }
  }
  // DWEB_HOME 隔离（测试）/~/.opendweb 下的已安装副本
  const base = cloudflaredHome(process.env.DWEB_HOME ?? undefined);
  for (const name of names) {
    const p = path.join(base, "current", name);
    if (existsSync(p)) return p;
  }
  return null;
}

/** 同步解析：PATH 上的 cloudflared（沿用旧行为）或缓存副本；都没有返回 null */
export function resolveCloudflaredBin(): string | null {
  return cachedCloudflaredBin();
}

/**
 * 惰性安装（按需）：npm:cloudflared 的 install(to) 把 binary 下载到 `to`
 * （目标文件路径，非目录——源码 install.js：download(url, to) + chmodSync(to)
 * + 返回 to）。目标与 cachedCloudflaredBin 的探测路径严格一致（B6a）：
 * ~/.opendweb/cloudflared/current/cloudflared(.exe)。loadInstall 注入面供测试
 * 替换（真实 loader 动态 import npm:cloudflared）。
 */
export async function ensureCloudflaredBin(
  log: (line: string) => void,
  loadInstall: () => Promise<{ install: (to: string) => Promise<string> }> = async () =>
    (await import("cloudflared")) as { install: (to: string) => Promise<string> },
): Promise<string | null> {
  const found = resolveCloudflaredBin();
  if (found !== null) return found;
  try {
    const mod = await loadInstall();
    const name = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
    const target = path.join(cloudflaredHome(process.env.DWEB_HOME ?? undefined), "current", name);
    const bin = await mod.install(target);
    log(`cloudflared: installed to ${bin}`);
    return bin;
  } catch (e) {
    log(`WARNING: cloudflared auto-install failed (${(e as Error).message}); install it manually (brew install cloudflared / npm i -g cloudflared) or set CLOUDFLARED_BIN`);
    return null;
  }
}

interface StartupState {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
  child: ChildProcess | null;
  poll: ReturnType<typeof setInterval> | null;
  grace: ReturnType<typeof setTimeout> | null;
  settled: boolean;
  stopping: boolean;
  stopPromise: Promise<void> | null;
}

interface ActiveTunnel {
  child: ChildProcess;
  watchdog: () => void;
}

let tunnelStart: StartupState | null = null; // 启动中的状态（并发调用共享其 promise）
let tunnelPending: StartupState | null = null; // 已 spawn 但仍在健康窗口内的状态，供 preStop 取消
let tunnelChild: ActiveTunnel | null = null; // 当前活跃记录 { child, watchdog }，供 preStop 摘除本 child 的观察器
let tunnelStopAll: Promise<void> | null = null; // 进行中的全程停止 Promise（并发 preStop 共享，R6-Major）

/** 退出标签（区分正常退出码与信号终止），watchdog 与悬挂清理共用 */
function exitLabelOf(child: ChildProcess): string {
  if (child.exitCode !== null) return `code ${child.exitCode}`;
  if (child.signalCode !== null) return `signal ${child.signalCode}`;
  return "code unknown";
}

/**
 * 共生 cloudflared 的生命周期（R3 竞态重构：「启动中」与「已登记」拆分为
 * 独立状态，exit 事件可能迟到于进程实际退出，一切判定都以
 * child.exitCode/signalCode 的同步快照为准）。启动健康窗口内退出 = 启动
 * 失败；过窗后退出无法再失败 postReady——由 per-child watchdog 输出
 * stderr WARNING（绝不无声伪成功），preStop 主动停止先摘除观察器。
 */
export async function spawnCloudflared(
  token: string,
  graceMs: number = Number(process.env.DWEB_CF_SPAWN_GRACE_MS) || 2000,
  resolveBin: () => Promise<string | null> = async () =>
    resolveCloudflaredBin() ?? (await ensureCloudflaredBin(() => {})),
): Promise<void> {
  // 全程停止事务进行中：事务快照取走的是旧状态，此刻新 spawn 的 child
  // 无人认领（事务会在 tunnelChild===null 时直接返回）——拒绝，杜绝孤儿
  // 进程逃逸 preStop（R6 复审阻塞项：stop-中-start 所有权竞态）。
  if (tunnelStopAll !== null) {
    return Promise.reject(new Error("cloudflared is stopping; refusing to start a new tunnel"));
  }
  if (tunnelStart !== null) return tunnelStart.promise;
  if (tunnelChild !== null) {
    if (!exited(tunnelChild.child)) {
      return Promise.resolve();
    }
    // 防御性不变量：悬挂记录（快照已退出）不得无声丢弃——否则其 watchdog
    // 若在清理后才派发，会因 tunnelChild!==active 静默返回，晚退 WARNING
    // 被吞。同步完成告警并摘除旧 watchdog（双保险防双报）。
    const stale = tunnelChild;
    tunnelChild = null;
    stale.child.removeListener("exit", stale.watchdog);
    console.error(`WARNING: cloudflared exited (${exitLabelOf(stale.child)}); the public tunnel is down`);
  }

  const state: StartupState = {
    promise: null as never,
    resolve: null as never,
    reject: null as never,
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
  const fail = (msg: string) => {
    if (state.settled) return;
    state.settled = true;
    clearStartupTimers();
    if (tunnelPending === state) tunnelPending = null;
    if (tunnelStart === state) tunnelStart = null;
    state.reject(new Error(msg));
  };

  let child: ChildProcess;
  try {
    const bin = await resolveBin();
    // B6b：await 期间（自动安装可长达数分钟）stop 事务可能已启动——此刻
    // spawn 出的 child 无人认领（事务在 tunnelChild===null 时直接返回）。
    // 重新检查停止条件，停止中即以同一 stop 语义拒绝，杜绝孤儿进程。
    if (tunnelStopAll !== null || state.stopping) {
      fail("cloudflared is stopping; refusing to start a new tunnel");
      return state.promise;
    }
    if (bin === null) {
      fail("cloudflared not found on PATH or in the cache, and the auto-install failed; install it (brew install cloudflared / npm i -g cloudflared) or set CLOUDFLARED_BIN");
      return state.promise;
    }
    child = spawn(bin, ["tunnel", "run"], {
      env: { ...process.env, TUNNEL_TOKEN: token },
      stdio: ["ignore", "inherit", "inherit"],
      detached: false,
    });
  } catch (e) {
    fail(`failed to start cloudflared (${(e as Error).message}); is it installed and on PATH?`);
    return state.promise;
  }

  state.child = child;
  tunnelPending = state;
  const startupFailure = () =>
    `cloudflared exited during startup (${exitLabelOf(child)}); check TUNNEL_TOKEN and the tunnel config`;
  child.once("error", (e: Error) => {
    fail(`failed to start cloudflared (${e.message}); is it installed and on PATH?`);
  });
  child.once("exit", () => {
    // 未过健康窗口的退出（exit 事件路径）= 启动失败。过窗后本 child 的
    // 告警与 tunnelChild 清理完全归其 watchdog——此处不得抢先清记录：
    // 本 listener 注册早于 watchdog、同一次 exit 会先执行，抢先置空会让
    // watchdog 判 tunnelChild!==active 而静默（晚退 WARNING 被吞）。
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
      const active: ActiveTunnel = { child, watchdog: null as never };
      const watchdog = () => {
        // 仅当前活跃记录才告警+清理（R5-Minor：promote 前的窄窗退出已由
        // startup exit listener 归一为启动失败，不得再叠一条 WARNING）
        if (tunnelChild !== active) return;
        tunnelChild = null;
        console.error(`WARNING: cloudflared exited (${exitLabelOf(child)}); the public tunnel is down`);
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

export function stopCloudflared(): Promise<void> {
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
    tunnelChild = null;
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

function stopPendingStartup(state: StartupState): Promise<void> {
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

function stopChild(child: ChildProcess): Promise<void> {
  if (exited(child)) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    let force: ReturnType<typeof setTimeout> | null = null;
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

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}
