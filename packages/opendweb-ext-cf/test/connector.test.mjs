// Connector 数据面单测：cloudflared 定位（CLOUDFLARED_BIN > DWEB_HOME 缓存 >
// 惰性安装）与共生 spawn 生命周期状态机（自旧 cf.test.mjs 迁移，契约不变）：
// 启动健康窗口、晚退 WARNING、stop-vs-start 拒绝、并发共享、preStop 取消与
// SIGINT+SIGKILL 回收、缺二进制降级。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  cloudflaredHome,
  cachedCloudflaredBin,
  resolveCloudflaredBin,
  ensureCloudflaredBin,
  spawnCloudflared,
  stopCloudflared,
} from "../dist/connector.mjs";

// ---- 二进制定位（无网络路径） ----

test("bin resolution: CLOUDFLARED_BIN wins when it exists; a dangling value falls through to the DWEB_HOME cache", async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "cf-binhome-"));
  const prev = { bin: process.env.CLOUDFLARED_BIN, home: process.env.DWEB_HOME, path: process.env.PATH };
  try {
    const cached = path.join(home, "cloudflared", "current", "cloudflared");
    await fsp.mkdir(path.dirname(cached), { recursive: true });
    await fsp.writeFile(cached, "fake", "utf8");

    process.env.DWEB_HOME = home;
    // 1.0 解析序：CLOUDFLARED_BIN > PATH 上的 cloudflared > 缓存——用独立的
    // 空 PATH 目录隔离（真机上 PATH 常有 brew 装的 cloudflared，会优先命中）
    const emptyPath = await fsp.mkdtemp(path.join(os.tmpdir(), "cf-empty-path-"));
    process.env.PATH = emptyPath;
    process.env.CLOUDFLARED_BIN = path.join(home, "does-not-exist"); // 不存在 -> 忽略
    assert.equal(cachedCloudflaredBin(), cached, "falls back to $DWEB_HOME/cloudflared/current");
    assert.equal(resolveCloudflaredBin(), cached);
    // ensureCloudflaredBin 命中缓存即返回，绝无网络副作用
    assert.equal(await ensureCloudflaredBin(() => {}), cached);

    const explicit = path.join(home, "explicit-bin");
    await fsp.writeFile(explicit, "fake", "utf8");
    process.env.CLOUDFLARED_BIN = explicit;
    assert.equal(cachedCloudflaredBin(), explicit, "explicit env override wins");

    assert.equal(cloudflaredHome(home), path.join(home, "cloudflared"));
  } finally {
    if (prev.bin === undefined) delete process.env.CLOUDFLARED_BIN;
    else process.env.CLOUDFLARED_BIN = prev.bin;
    if (prev.home === undefined) delete process.env.DWEB_HOME;
    else process.env.DWEB_HOME = prev.home;
    process.env.PATH = prev.path;
  }
});

// PATH 优先于缓存：PATH 上的可执行副本先于 $DWEB_HOME/cloudflared/current
test("bin resolution: a cloudflared on PATH wins over the cache (1.0 order)", async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "cf-pathbin-"));
  const prev = { bin: process.env.CLOUDFLARED_BIN, home: process.env.DWEB_HOME, path: process.env.PATH };
  try {
    const onPath = path.join(home, "cloudflared");
    await fsp.writeFile(onPath, "fake", "utf8");
    const cached = path.join(home, "nested", "cloudflared", "current", "cloudflared");
    await fsp.mkdir(path.dirname(cached), { recursive: true });
    await fsp.writeFile(cached, "fake", "utf8");
    process.env.CLOUDFLARED_BIN = path.join(home, "nope");
    process.env.DWEB_HOME = path.join(home, "nested");
    process.env.PATH = home;
    assert.equal(resolveCloudflaredBin(), onPath, "PATH copy wins over the cache");
  } finally {
    if (prev.bin === undefined) delete process.env.CLOUDFLARED_BIN;
    else process.env.CLOUDFLARED_BIN = prev.bin;
    if (prev.home === undefined) delete process.env.DWEB_HOME;
    else process.env.DWEB_HOME = prev.home;
    process.env.PATH = prev.path;
  }
});

// ---- spawn 生命周期（7 项 R2-R6 契约） ----

/**
 * 每用例环境：fake cloudflared 脚本 + CLOUDFLARED_BIN 显式指向 + DWEB_HOME 隔离
 * （既不误用用户真实缓存，也让自动安装路径在缺省测试里无从下手）。
 * 返回 restore()；bin 脚本本体由用例先写入 dir。
 */
async function lifecycleEnv(graceMs, script, spawnLogBasename = "spawns.log") {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cf-spawn-"));
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "cf-home-"));
  const fake = path.join(dir, "cloudflared");
  await fsp.writeFile(fake, script, "utf8");
  chmodSync(fake, 0o755);
  const spawnLog = path.join(dir, spawnLogBasename);
  const prev = {
    PATH: process.env.PATH,
    bin: process.env.CLOUDFLARED_BIN,
    home: process.env.DWEB_HOME,
    grace: process.env.DWEB_CF_SPAWN_GRACE_MS,
    log: process.env.DWEB_CF_SPAWN_LOG,
  };
  process.env.PATH = dir; // 兼容「PATH 上找 fake」的旧行为；解析仍以 CLOUDFLARED_BIN 为准
  process.env.CLOUDFLARED_BIN = fake;
  process.env.DWEB_HOME = home;
  process.env.DWEB_CF_SPAWN_GRACE_MS = String(graceMs);
  process.env.DWEB_CF_SPAWN_LOG = spawnLog;
  const restore = async () => {
    await stopCloudflared().catch(() => {});
    try {
      execFileSync("/bin/sh", ["-c", `kill -9 $(cat ${JSON.stringify(spawnLog)} 2>/dev/null) 2>/dev/null || true`]);
    } catch { /* best effort */ }
    process.env.PATH = prev.PATH;
    process.env.DWEB_CF_SPAWN_GRACE_MS = prev.grace;
    if (prev.bin === undefined) delete process.env.CLOUDFLARED_BIN;
    else process.env.CLOUDFLARED_BIN = prev.bin;
    if (prev.home === undefined) delete process.env.DWEB_HOME;
    else process.env.DWEB_HOME = prev.home;
    if (prev.log === undefined) delete process.env.DWEB_CF_SPAWN_LOG;
    else process.env.DWEB_CF_SPAWN_LOG = prev.log;
  };
  return { dir, home, fake, spawnLog, restore };
}

/** 有界等待 spawn 日志出现内容（新写可执行文件的首次 exec 在 macOS 可滞后数百毫秒） */
async function waitForSpawnLog(spawnLog, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const content = (await fsp.readFile(spawnLog, "utf8")).trim();
      if (content !== "") return content;
    } catch { /* not yet */ }
    if (Date.now() > deadline) return "";
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** 有界等待首条 stderr WARNING */
async function waitForWarning(warnings, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (warnings.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return warnings.join("\n");
}

function captureStderr() {
  const warnings = [];
  const orig = console.error;
  console.error = (s) => warnings.push(String(s));
  return {
    warnings,
    restore: () => {
      console.error = orig;
    },
  };
}

const pidAlive = (pid) => {
  try {
    execFileSync("/bin/sh", ["-c", `kill -0 ${Number(pid)} 2>/dev/null`]);
    return true;
  } catch {
    return false;
  }
};

// 1) 启动健康窗口内退出 = 启动失败；事件迟到时过窗后退出必须落 WARNING——
//    两种合法结局，无声伪成功即失败。
test("spawn: cloudflared dying at startup is never a silent fake success", { skip: process.platform === "win32" }, async () => {
  const { restore } = await lifecycleEnv(300, "#!/bin/sh\nexit 7\n");
  const cap = captureStderr();
  try {
    let rejected = null;
    try {
      await spawnCloudflared("placeholder");
    } catch (e) {
      rejected = e;
    }
    if (rejected !== null) {
      assert.match(rejected.message, /cloudflared exited during startup/);
    } else {
      const out = await waitForWarning(cap.warnings);
      assert.match(out, /WARNING: cloudflared exited \(code 7\); the public tunnel is down/);
    }
  } finally {
    cap.restore();
    await restore();
  }
});

// 2) grace 先过窗、child 之后才退出（确定性晚退）：watchdog 必须 WARNING。
test("spawn: dying after the grace window must surface the WARNING", { skip: process.platform === "win32" }, async () => {
  const { restore } = await lifecycleEnv(150, "#!/bin/sh\n/bin/sleep 1\nexit 7\n");
  const cap = captureStderr();
  try {
    await spawnCloudflared("placeholder"); // 过窗 promote
    const out = await waitForWarning(cap.warnings);
    assert.match(
      out,
      /WARNING: cloudflared exited \(code 7\); the public tunnel is down/,
      "late exit after promotion must warn, never a silent success",
    );
  } finally {
    cap.restore();
    await restore();
  }
});

// 3) 停止事务进行中并发启动：直接拒绝（杜绝孤儿进程逃逸 preStop）。
test("spawn: a start racing an in-flight stop is rejected, never an orphan", { skip: process.platform === "win32" }, async () => {
  const { restore, spawnLog } = await lifecycleEnv(
    150,
    '#!/bin/sh\necho $$ >> "$DWEB_CF_SPAWN_LOG"\nexec /bin/sleep 30\n',
  );
  try {
    await spawnCloudflared("placeholder");
    const firstPid = await waitForSpawnLog(spawnLog);
    assert.ok(firstPid, "first spawn must be recorded before racing the stop");
    const stopP = stopCloudflared(); // 不 await：让 stop 停在 reap 旧 child 的 await 上
    let racing = null;
    try {
      await spawnCloudflared("placeholder");
    } catch (e) {
      racing = e;
    }
    assert.ok(racing instanceof Error, "a start during an in-flight stop must be rejected");
    assert.match(racing.message, /cloudflared is stopping/);
    await stopP;
    assert.equal(pidAlive(firstPid), false, "the reaped child pid must be gone when the stop promise settles");
    const pids = (await fsp.readFile(spawnLog, "utf8")).trim().split("\n").filter(Boolean);
    assert.equal(pids.length, 1, `expected exactly one spawn (the racing start must not spawn), got: ${pids}`);
  } finally {
    await restore();
  }
});

// 4) 并发启动共享同一 child；stop 全量回收。
test("spawn: concurrent tunnel requests share one spawn; stop reaps it", { skip: process.platform === "win32" }, async () => {
  const { restore, spawnLog } = await lifecycleEnv(
    300,
    '#!/bin/sh\necho $$ >> "$DWEB_CF_SPAWN_LOG"\nexec /bin/sleep 30\n',
  );
  try {
    await Promise.all([spawnCloudflared("placeholder"), spawnCloudflared("placeholder")]);
    const logged = await waitForSpawnLog(spawnLog);
    const pids = logged.split("\n").filter(Boolean);
    assert.equal(pids.length, 1, `expected exactly one spawn, got: ${logged}`);
    await stopCloudflared();
    assert.equal(pidAlive(pids[0]), false, "cloudflared should be reaped by stop");
  } finally {
    await restore();
  }
});

// 5) preStop 取消启动中的 child 并回收。
test("spawn: stop cancels a pending startup and reaps its child", { skip: process.platform === "win32" }, async () => {
  const { restore, spawnLog } = await lifecycleEnv(
    10000,
    '#!/bin/sh\necho $$ > "$DWEB_CF_SPAWN_LOG"\nexec /bin/sleep 30\n',
  );
  let stopped = null;
  try {
    const startup = spawnCloudflared("placeholder");
    stopped = assert.rejects(startup, /startup was stopped before it became healthy/);
    const pid = await waitForSpawnLog(spawnLog);
    assert.match(pid, /^\d+$/, "fake cloudflared must be spawned before stop");
    await stopCloudflared();
    await stopped;
    assert.equal(pidAlive(pid), false, "pending cloudflared should be reaped by stop");
  } finally {
    await restore();
    await stopped?.catch(() => {});
  }
});

// 6) spawn 事件尚未派发即 preStop：信号推迟到 spawn 之后，SIGKILL 兜底。
test("spawn: stop before the spawn event still reaps the child", { skip: process.platform === "win32" }, async () => {
  const { restore, spawnLog } = await lifecycleEnv(
    10000,
    '#!/bin/sh\ntrap \'\' INT\necho $$ > "$DWEB_CF_SPAWN_LOG"\nexec /bin/sleep 30\n',
  );
  let stopped = null;
  try {
    const startup = spawnCloudflared("placeholder");
    stopped = assert.rejects(startup, /startup was stopped before it became healthy/);
    await stopCloudflared(); // 立即停止：child.pid 未就绪，SIGINT 必须推迟
    await stopped;
    let pid = "";
    try {
      pid = (await fsp.readFile(spawnLog, "utf8")).trim();
    } catch { /* log not written: child died before echo — also reaped */ }
    if (/^\d+$/.test(pid)) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(pidAlive(pid), false, "child must be reaped even when stop preceded its spawn event");
    }
  } finally {
    await restore();
    await stopped?.catch(() => {});
  }
});

// 7) 缺二进制且自动安装失败：明确拒绝（降级指引），不崩不挂。
//    DWEB_HOME 指向普通文件 -> 安装目标 mkdir ENOTDIR -> auto-install 立即失败，
//    全程零网络请求。
test("spawn: missing cloudflared degrades to an explicit rejection", { skip: process.platform === "win32" }, async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "cf-nobin-"));
  const notADir = path.join(tmp, "occupied"); // 普通文件：作为 DWEB_HOME 使 cloudflared/ 无法创建
  await fsp.writeFile(notADir, "x", "utf8");
  const prev = {
    PATH: process.env.PATH,
    bin: process.env.CLOUDFLARED_BIN,
    home: process.env.DWEB_HOME,
    grace: process.env.DWEB_CF_SPAWN_GRACE_MS,
  };
  process.env.PATH = "";
  if (prev.bin !== undefined) delete process.env.CLOUDFLARED_BIN;
  process.env.DWEB_HOME = notADir;
  process.env.DWEB_CF_SPAWN_GRACE_MS = "300";
  try {
    await assert.rejects(
      () => spawnCloudflared("placeholder"),
      (e) => /cloudflared not found on PATH or in the cache/.test(e.message) && /CLOUDFLARED_BIN|brew install/.test(e.message),
    );
  } finally {
    process.env.PATH = prev.PATH;
    if (prev.bin === undefined) delete process.env.CLOUDFLARED_BIN;
    else process.env.CLOUDFLARED_BIN = prev.bin;
    if (prev.home === undefined) delete process.env.DWEB_HOME;
    else process.env.DWEB_HOME = prev.home;
    if (prev.grace === undefined) delete process.env.DWEB_CF_SPAWN_GRACE_MS;
    else process.env.DWEB_CF_SPAWN_GRACE_MS = prev.grace;
  }
});

// 附：grace 仍由 DWEB_CF_SPAWN_GRACE_MS 环境变量驱动（上面 3/5/6 已分别用
// 150/10000/10000 验证）；显式 graceMs 参数覆盖环境值。
test("spawn: explicit graceMs argument overrides the environment default", { skip: process.platform === "win32" }, async () => {
  const { restore } = await lifecycleEnv(10000, "#!/bin/sh\nexec /bin/sleep 30\n");
  try {
    process.env.DWEB_CF_SPAWN_GRACE_MS = "10000";
    await spawnCloudflared("placeholder", 200); // 200ms 即过窗
    await stopCloudflared(); // 立即回收，证明 spawn 确实成功 promote
  } finally {
    await restore();
  }
});
