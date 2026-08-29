// cf-api 与 wizard 纯函数单测：token 解码、ingress 形态、TOML 渲染、
// verify 断言逻辑（mock fetch）、API 错误路径。
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { decodeTunnelToken, buildIngress, pushIngress, routeDns } from "../src/cf-api.js";
import { planExposure, renderConfigToml, verifyExposure, runSetup } from "../src/wizard.js";

const TOKEN = Buffer.from(JSON.stringify({ a: "acc123", t: "tun456", s: "sec789" })).toString("base64");

test("decodeTunnelToken: base64 {a,t,s}; garbage rejected with user-facing message", () => {
  assert.deepEqual(decodeTunnelToken(TOKEN), { accountTag: "acc123", tunnelId: "tun456", apiToken: "sec789" });
  assert.throws(() => decodeTunnelToken("not-a-token"), /not a valid TUNNEL_TOKEN/);
  assert.throws(() => decodeTunnelToken(Buffer.from("{}").toString("base64")), /not a valid TUNNEL_TOKEN/);
});

test("decodeTunnelToken: a/t/s charset whitelist (URL path / header injection guard)", () => {
  const mk = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
  // a/t 拼进 API URL 路径——路径穿越必须拒绝
  assert.throws(() => decodeTunnelToken(mk({ a: "../escape", t: "t", s: "s" })), /not a valid TUNNEL_TOKEN/);
  assert.throws(() => decodeTunnelToken(mk({ a: "a", t: "t/evil", s: "s" })), /not a valid TUNNEL_TOKEN/);
  // s 进 Authorization 头——CRLF 头注入必须拒绝
  assert.throws(() => decodeTunnelToken(mk({ a: "a", t: "t", s: "s\r\nX-Evil: 1" })), /not a valid TUNNEL_TOKEN/);
  assert.throws(() => decodeTunnelToken(mk({ a: "a b", t: "t", s: "s" })), /not a valid TUNNEL_TOKEN/);
});

test("buildIngress: dual hostname (default) and single-domain path routing", () => {
  const dual = buildIngress({ mode: "dual", gatewayHost: "dweb.example.com", relayHost: "relay.dweb.example.com" });
  assert.deepEqual(dual.ingress, [
    { hostname: "relay.dweb.example.com", service: "http://localhost:3340" },
    { hostname: "dweb.example.com", service: "http://localhost:8787" },
    { service: "http_status:404" },
  ]);

  const single = buildIngress({ mode: "single", gatewayHost: "dweb.example.com", relayHost: "relay.dweb.example.com" });
  assert.equal(single.ingress[0].path, "^/relay.*");
  assert.equal(single.ingress[0].service, "http://localhost:3340");
  assert.equal(single.ingress[1].path, "^/ping.*");
  assert.equal(single.ingress[2].service, "http://localhost:8787");
  assert.equal(single.ingress.at(-1).service, "http_status:404");
  // 顺序即优先级：relay/ping 分流必须先于 gateway 兜底
  const services = single.ingress.map((r) => r.service);
  assert.ok(services.indexOf("http://localhost:3340") < services.indexOf("http://localhost:8787"));
});

test("pushIngress: PUT configurations; API error surfaces code+message", async () => {
  const calls = [];
  const okFetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };
  await pushIngress({ fetchImpl: okFetch, accountTag: "a", tunnelId: "t", apiToken: "s", ingress: { ingress: [] } });
  assert.match(calls[0].url, /\/accounts\/a\/cfd_tunnel\/t\/configurations$/);
  assert.equal(calls[0].init.method, "PUT");
  assert.match(calls[0].init.headers.Authorization, /^Bearer s$/);

  const badFetch = async () => new Response(JSON.stringify({ success: false, errors: [{ code: 9, message: "bad ingress" }] }), { status: 400 });
  await assert.rejects(
    () => pushIngress({ fetchImpl: badFetch, accountTag: "a", tunnelId: "t", apiToken: "s", ingress: { ingress: [] } }),
    /9: bad ingress/,
  );
});

test("routeDns: idempotent on existing record (81057); zone failure prints manual CNAME path", async () => {
  const zoneFetch = async (url) =>
    new Response(JSON.stringify({ result: [{ id: "zone1" }] }), { status: 200 });
  const dnsFetch = async (url, init) => {
    if (url.includes("/zones?")) return zoneFetch(url);
    if (init?.method === "POST") {
      return new Response(JSON.stringify({ errors: [{ code: 81057, message: "record already exists" }] }), { status: 400 });
    }
    return new Response(JSON.stringify({ result: [] }), { status: 200 });
  };
  const done = await routeDns({ fetchImpl: dnsFetch, accountTag: "a", tunnelId: "t", apiToken: "s", hostnames: ["x.example.com"] });
  assert.deepEqual(done, ["x.example.com"]);

  const noZone = async () => new Response(JSON.stringify({ result: [] }), { status: 200 });
  await assert.rejects(
    () => routeDns({ fetchImpl: noZone, accountTag: "a", tunnelId: "t", apiToken: "s", hostnames: ["x.example.com"] }),
    /create CNAME x\.example\.com -> t\.cfargotunnel\.com manually/,
  );
});

test("routeDns: query params encoded; co.uk zones fall back to three labels (R2-M7)", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    if (url.includes("/zones?")) {
      // 末两段 co.uk 查不到 zone，末三段 example.co.uk 命中
      const hit = url.includes("name=example.co.uk");
      return new Response(JSON.stringify({ result: hit ? [{ id: "zone9" }] : [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };
  const done = await routeDns({ fetchImpl, accountTag: "a&b", tunnelId: "t", apiToken: "s", hostnames: ["www.example.co.uk"] });
  assert.deepEqual(done, ["www.example.co.uk"]);
  // 两次 zone 查询：先 co.uk 后 example.co.uk；account.id 必须被编码而非裸拼
  assert.equal(seen.length, 3);
  assert.match(seen[0], /name=co\.uk/);
  assert.match(seen[1], /name=example\.co\.uk/);
  assert.ok(seen.slice(0, 2).every((u) => u.includes("account.id=a%26b")), "accountTag must be URL-encoded");
});

test("planExposure: dual derives relay.<gateway>; single shares one host", () => {
  const dual = planExposure({ hostname: "Dweb.Example.COM" });
  assert.equal(dual.gatewayHost, "dweb.example.com"); // 归一小写
  assert.equal(dual.relayHost, "relay.dweb.example.com");
  assert.equal(dual.publicRelayUrl, "https://relay.dweb.example.com");
  const single = planExposure({ hostname: "dweb.example.com", mode: "single" });
  assert.equal(single.publicGatewayUrl, single.publicRelayUrl);
});

test("planExposure: hostname must be a DNS name — query-injection and junk rejected (R2-M7)", () => {
  for (const bad of [
    "foo.com&account.id=evil",
    "not a host",
    "localhost", // 单段不是可路由域名
    "",
    "dweb..example.com",
    "-dweb.example.com",
    "dweb.example.com:8443",
    `${"a".repeat(64)}.example.com`, // label > 63（R3-Minor 规则化）
  ]) {
    assert.throws(() => planExposure({ hostname: bad }), /invalid hostname/, bad);
  }
  // R3-Minor 放宽：FQDN 尾点合法（归一去除）；深层次合法域名不再受 10 段限制
  const fqdn = planExposure({ hostname: "dweb.example.com." });
  assert.equal(fqdn.gatewayHost, "dweb.example.com");
  const deep = planExposure({ hostname: "a.b.c.d.e.f.g.h.i.j.k.example.com" });
  assert.equal(deep.relayHost, "relay.a.b.c.d.e.f.g.h.i.j.k.example.com");

  // 原 hostname 仍在 DNS 253 字符上限内，但实际 dual-host 方案还会
  // 派生 relay.<hostname>；该派生结果同样必须是合法 DNS 名。
  const relayTooLong = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(60)}`;
  assert.equal(relayTooLong.length, 252);
  assert.throws(() => planExposure({ hostname: relayTooLong }), /invalid hostname/);
});

test("verifyExposure: strict deadline — signal-ignoring fetch cannot stall past timeoutMs (R2-M3)", async () => {
  const t0 = Date.now();
  const v = await verifyExposure({
    // 永不 resolve 且无视 signal；附带 ref'd 定时器保活事件循环，
    // 否则空循环会让测试运行器取消后续用例
    fetchImpl: () => {
      setTimeout(() => {}, 60000);
      return new Promise(() => {});
    },
    publicGatewayUrl: "https://dweb.example.com",
    expectedRelayUrl: "https://relay.dweb.example.com",
    timeoutMs: 100,
  });
  const elapsed = Date.now() - t0;
  assert.equal(v.ok, false);
  assert.match(v.error, /not reachable within 100ms/);
  assert.ok(elapsed < 1500, `should return near the deadline, took ${elapsed}ms`);
});

test("renderConfigToml: deterministic, loadable by the CLI schema (round-trip via smol-toml)", async () => {
  const plan = planExposure({ hostname: "dweb.example.com" });
  const toml = renderConfigToml({ plan, tokenEnv: "TUNNEL_TOKEN" });
  assert.match(toml, /configVersion = 1/);
  assert.match(toml, /publicGatewayUrl = "https:\/\/dweb\.example\.com"/);
  assert.match(toml, /name = "cf"/);
  assert.match(toml, /tokenEnv = "TUNNEL_TOKEN"/);
  // 与 opendweb CLI 同一解析器 round-trip
  const { parse } = await import("smol-toml");
  const parsed = parse(toml);
  assert.equal(parsed.server.publicRelayUrl, "https://relay.dweb.example.com");
  assert.deepEqual(parsed.plugins, [{ name: "cf", options: { tokenEnv: "TUNNEL_TOKEN" } }]);
});

test("verifyExposure: asserts relay URL match; mismatch and disabled relay are failures", async () => {
  const manifest = { services: [{ name: "relay", enabled: true, url: "https://relay.dweb.example.com" }] };
  const ok = await verifyExposure({
    fetchImpl: async () => new Response(JSON.stringify(manifest), { status: 200 }),
    publicGatewayUrl: "https://dweb.example.com",
    expectedRelayUrl: "https://relay.dweb.example.com",
    timeoutMs: 1000,
  });
  assert.equal(ok.ok, true);

  const mismatch = await verifyExposure({
    fetchImpl: async () => new Response(JSON.stringify(manifest), { status: 200 }),
    publicGatewayUrl: "https://dweb.example.com",
    expectedRelayUrl: "https://other.example.com",
    timeoutMs: 1000,
  });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /relay URL mismatch/);

  const disabled = await verifyExposure({
    fetchImpl: async () => new Response(JSON.stringify({ services: [{ name: "relay", enabled: false, url: null }] }), { status: 200 }),
    publicGatewayUrl: "https://dweb.example.com",
    expectedRelayUrl: "https://relay.dweb.example.com",
    timeoutMs: 1000,
  });
  assert.match(disabled.error, /relay disabled/);
});

test("verifyExposure: every fetch carries an AbortSignal bounded by the remaining time (R2 blocked-7)", async () => {
  const seen = [];
  const manifest = { services: [{ name: "relay", enabled: true, url: "https://relay.dweb.example.com" }] };
  const v = await verifyExposure({
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return new Response(JSON.stringify(manifest), { status: 200 });
    },
    publicGatewayUrl: "https://dweb.example.com",
    expectedRelayUrl: "https://relay.dweb.example.com",
    timeoutMs: 1000,
  });
  assert.equal(v.ok, true);
  assert.equal(seen.length, 1);
  assert.ok(seen[0].init?.signal instanceof AbortSignal, "fetch must receive an abort signal");
});

test("runSetup: existing config gets a complete merge fragment ([[plugins]] entry + tokenEnv included)", async () => {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "cf-merge-"));
  const logs = [];
  await runSetup({
    token: TOKEN,
    hostname: "dweb.example.com",
    cwd,
    skipVerify: true,
    exists: () => true,
    writeFile: async () => {
      throw new Error("must not overwrite an existing config");
    },
    fetchImpl: async (url) => {
      if (url.includes("/zones?")) return new Response(JSON.stringify({ result: [{ id: "zone1" }] }), { status: 200 });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    },
    log: (l) => logs.push(l),
  });
  const out = logs.join("\n");
  assert.match(out, /already exists; merge these values manually/);
  assert.match(out, /publicGatewayUrl = "https:\/\/dweb\.example\.com"/);
  assert.match(out, /publicRelayUrl\s+= "https:\/\/relay\.dweb\.example\.com"/);
  assert.match(out, /\[\[plugins\]\]/);
  assert.match(out, /name = "cf"/);
  assert.match(out, /tokenEnv = "TUNNEL_TOKEN"/);
});

test("runSetup: explicit configPath targets the chosen file, not cwd default (R2-M2)", async () => {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "cf-cfgpath-"));
  const target = path.join(cwd, "custom", "dir", "cfg.toml");
  const writes = [];
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await runSetup({
    token: TOKEN,
    hostname: "dweb.example.com",
    cwd,
    configPath: target,
    skipVerify: true,
    exists: () => false,
    writeFile: async (p, content) => writes.push({ p, content }),
    fetchImpl: async (url) => {
      if (url.includes("/zones?")) return new Response(JSON.stringify({ result: [{ id: "zone1" }] }), { status: 200 });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    },
    log: () => {},
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].p, target);
  assert.match(writes[0].content, /name = "cf"/);

  // 已存在时：merge 片段指向所选文件（相对 cwd 展示），不误写
  const logs = [];
  await runSetup({
    token: TOKEN,
    hostname: "dweb.example.com",
    cwd,
    configPath: target,
    skipVerify: true,
    exists: () => true,
    writeFile: async () => {
      throw new Error("must not overwrite");
    },
    fetchImpl: async (url) => {
      if (url.includes("/zones?")) return new Response(JSON.stringify({ result: [{ id: "zone1" }] }), { status: 200 });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    },
    log: (l) => logs.push(l),
  });
  assert.match(logs.join("\n"), /custom\/dir\/cfg\.toml already exists; merge these values manually/);
});

test("postReady hook: cloudflared dying at startup is never a silent fake success (R2-M4/R4)", { skip: process.platform === "win32" }, async () => {
  const plugin = (await import("../src/index.js")).default;
  const binDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cf-bin-"));
  const fake = path.join(binDir, "cloudflared");
  await fsp.writeFile(fake, "#!/bin/sh\nexit 7\n", "utf8");
  const { chmodSync } = await import("node:fs");
  chmodSync(fake, 0o755);
  const prevPath = process.env.PATH;
  const prevToken = process.env.TUNNEL_TOKEN;
  const prevGrace = process.env.DWEB_CF_SPAWN_GRACE_MS;
  process.env.PATH = binDir;
  process.env.TUNNEL_TOKEN = "placeholder";
  // exit 事件在 macOS 可滞后数百毫秒（实测 757ms 方差大）——grace 故意短于
  // 事件延迟，两种合法结局：启动失败拒绝，或过窗后晚退 WARNING
  process.env.DWEB_CF_SPAWN_GRACE_MS = "300";
  const warnings = [];
  const origError = console.error;
  console.error = (s) => warnings.push(String(s));
  try {
    let rejected = null;
    try {
      await plugin.hooks["server.postReady"]({ options: { tunnel: true } });
    } catch (e) {
      rejected = e;
    }
    if (rejected !== null) {
      assert.match(rejected.message, /cloudflared exited during startup/);
    } else {
      // 过窗 resolve：晚退必须落 stderr WARNING（无声伪成功 = 失败）
      const deadline = Date.now() + 5000;
      while (warnings.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.match(warnings.join("\n"), /WARNING: cloudflared exited \(code 7\); the public tunnel is down/);
    }
  } finally {
    console.error = origError;
    process.env.PATH = prevPath;
    process.env.DWEB_CF_SPAWN_GRACE_MS = prevGrace;
    if (prevToken === undefined) delete process.env.TUNNEL_TOKEN;
    else process.env.TUNNEL_TOKEN = prevToken;
  }
});

test("postReady hook: concurrent tunnel requests share one spawn; preStop reaps it (R3 race hardening)", { skip: process.platform === "win32" }, async () => {
  const plugin = (await import("../src/index.js")).default;
  const binDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cf-bin-"));
  const spawnLog = path.join(binDir, "spawns.log");
  const fake = path.join(binDir, "cloudflared");
  await fsp.writeFile(fake, "#!/bin/sh\necho $$ >> \"$DWEB_CF_SPAWN_LOG\"\nexec /bin/sleep 30\n", "utf8");
  const { chmodSync } = await import("node:fs");
  chmodSync(fake, 0o755);
  const prevPath = process.env.PATH;
  const prevToken = process.env.TUNNEL_TOKEN;
  const prevGrace = process.env.DWEB_CF_SPAWN_GRACE_MS;
  process.env.PATH = binDir;
  process.env.TUNNEL_TOKEN = "placeholder";
  process.env.DWEB_CF_SPAWN_GRACE_MS = "300";
  process.env.DWEB_CF_SPAWN_LOG = spawnLog;
  const { execFileSync } = await import("node:child_process");
  try {
    const ctx = { options: { tunnel: true } };
    const [a, b] = await Promise.all([
      plugin.hooks["server.postReady"](ctx),
      plugin.hooks["server.postReady"](ctx),
    ]);
    assert.match(a.bannerLines[0], /co-spawned/);
    assert.match(b.bannerLines[0], /co-spawned/);
    // 新写可执行文件的首次 exec 可滞后数百毫秒（macOS 扫描）：grace 过窗
    // 不代表子进程已执行到第一行——有界等待首个 spawn 记录
    let logged = "";
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        logged = await fsp.readFile(spawnLog, "utf8");
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    const spawnCount = logged.trim().split("\n").filter(Boolean).length;
    assert.equal(spawnCount, 1, `expected exactly one spawn, got: ${logged}`);
    // preStop 清理存活进程
    await plugin.hooks["server.preStop"]();
    let alive = true;
    const pid = logged.trim().split("\n")[0];
    try {
      execFileSync("/bin/sh", ["-c", `kill -0 ${Number(pid)} 2>/dev/null`]);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, "cloudflared should be reaped by preStop");
  } finally {
    // 断言失败也必须回收：泄漏的存活句柄会污染后续测试（PATH="" 的 ENOENT
    // 用例会被存活句柄短路成 resolve）
    await plugin.hooks["server.preStop"]().catch(() => {});
    try {
      execFileSync("/bin/sh", ["-c", `kill $(cat ${JSON.stringify(spawnLog)} 2>/dev/null) 2>/dev/null || true`]);
    } catch { /* best effort */ }
    process.env.PATH = prevPath;
    process.env.DWEB_CF_SPAWN_GRACE_MS = prevGrace;
    delete process.env.DWEB_CF_SPAWN_LOG;
    if (prevToken === undefined) delete process.env.TUNNEL_TOKEN;
    else process.env.TUNNEL_TOKEN = prevToken;
  }
});

test("postReady hook: preStop cancels a pending startup and reaps its child (R4)", { skip: process.platform === "win32" }, async () => {
  const plugin = (await import("../src/index.js")).default;
  const binDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cf-bin-"));
  const spawnLog = path.join(binDir, "spawns.log");
  const fake = path.join(binDir, "cloudflared");
  await fsp.writeFile(fake, "#!/bin/sh\necho $$ > \"$DWEB_CF_SPAWN_LOG\"\nexec /bin/sleep 30\n", "utf8");
  const { chmodSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  chmodSync(fake, 0o755);
  const prevPath = process.env.PATH;
  const prevToken = process.env.TUNNEL_TOKEN;
  const prevGrace = process.env.DWEB_CF_SPAWN_GRACE_MS;
  const prevSpawnLog = process.env.DWEB_CF_SPAWN_LOG;
  process.env.PATH = binDir;
  process.env.TUNNEL_TOKEN = "placeholder";
  process.env.DWEB_CF_SPAWN_GRACE_MS = "10000";
  process.env.DWEB_CF_SPAWN_LOG = spawnLog;
  let stopped = null;
  try {
    const postReady = plugin.hooks["server.postReady"]({ options: { tunnel: true } });
    // Attach the assertion before preStop rejects startup, avoiding an
    // expected lifecycle rejection being reported as unhandled by node:test.
    stopped = assert.rejects(postReady, /startup was stopped before it became healthy/);

    let pid = "";
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        pid = (await fsp.readFile(spawnLog, "utf8")).trim();
        if (pid) break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.match(pid, /^\d+$/, "fake cloudflared must be spawned before preStop");

    await plugin.hooks["server.preStop"]();
    await stopped;
    assert.throws(
      () => execFileSync("/bin/sh", ["-c", `kill -0 ${Number(pid)} 2>/dev/null`]),
      "pending cloudflared should be reaped by preStop",
    );
  } finally {
    await plugin.hooks["server.preStop"]().catch(() => {});
    await stopped?.catch(() => {});
    try {
      execFileSync("/bin/sh", ["-c", `kill $(cat ${JSON.stringify(spawnLog)} 2>/dev/null) 2>/dev/null || true`]);
    } catch { /* best effort */ }
    process.env.PATH = prevPath;
    process.env.DWEB_CF_SPAWN_GRACE_MS = prevGrace;
    if (prevSpawnLog === undefined) delete process.env.DWEB_CF_SPAWN_LOG;
    else process.env.DWEB_CF_SPAWN_LOG = prevSpawnLog;
    if (prevToken === undefined) delete process.env.TUNNEL_TOKEN;
    else process.env.TUNNEL_TOKEN = prevToken;
  }
});

test("postReady hook: preStop before the spawn event still reaps the child (R5 negative)", { skip: process.platform === "win32" }, async () => {  const plugin = (await import("../src/index.js")).default;
  const binDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cf-bin-"));
  const spawnLog = path.join(binDir, "spawns.log");
  const fake = path.join(binDir, "cloudflared");
  await fsp.writeFile(fake, "#!/bin/sh\ntrap '' INT\necho $$ > \"$DWEB_CF_SPAWN_LOG\"\nexec /bin/sleep 30\n", "utf8");
  const { chmodSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  chmodSync(fake, 0o755);
  const prevPath = process.env.PATH;
  const prevToken = process.env.TUNNEL_TOKEN;
  const prevGrace = process.env.DWEB_CF_SPAWN_GRACE_MS;
  const prevSpawnLog = process.env.DWEB_CF_SPAWN_LOG;
  process.env.PATH = binDir;
  process.env.TUNNEL_TOKEN = "placeholder";
  process.env.DWEB_CF_SPAWN_GRACE_MS = "10000";
  process.env.DWEB_CF_SPAWN_LOG = spawnLog;
  let stopped = null;
  try {
    const postReady = plugin.hooks["server.postReady"]({ options: { tunnel: true } });
    stopped = assert.rejects(postReady, /startup was stopped before it became healthy/);
    // 立即停止：spawn 事件几乎必然尚未派发（child.pid 未就绪）——stopChild
    // 必须把信号推迟到 spawn 之后，且 preStop 只在子进程终态事件后才 resolve
    // （resolve 本身就是回收证明；INT 被 trap 吞掉时最长 5s 由 SIGKILL 兜底）
    await plugin.hooks["server.preStop"]();
    await stopped;
    // 可选观测：若 pid 记录来得及写出（SIGINT 晚于 echo），确认进程已死；
    // SIGINT 早于 echo 时子进程被直接杀死——同样已终态（preStop 已等到）
    let pid = "";
    try {
      pid = (await fsp.readFile(spawnLog, "utf8")).trim();
    } catch { /* log not written: child died before echo — also reaped */ }
    if (/^\d+$/.test(pid)) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.throws(
        () => execFileSync("/bin/sh", ["-c", `kill -0 ${Number(pid)} 2>/dev/null`]),
        "child must be reaped even when preStop preceded its spawn event",
      );
    }
  } finally {
    await plugin.hooks["server.preStop"]().catch(() => {});
    await stopped?.catch(() => {});
    try {
      execFileSync("/bin/sh", ["-c", `kill -9 $(cat ${JSON.stringify(spawnLog)} 2>/dev/null) 2>/dev/null || true`]);
    } catch { /* best effort */ }
    process.env.PATH = prevPath;
    process.env.DWEB_CF_SPAWN_GRACE_MS = prevGrace;
    if (prevSpawnLog === undefined) delete process.env.DWEB_CF_SPAWN_LOG;
    else process.env.DWEB_CF_SPAWN_LOG = prevSpawnLog;
    if (prevToken === undefined) delete process.env.TUNNEL_TOKEN;
    else process.env.TUNNEL_TOKEN = prevToken;
  }
});

test("postReady hook: concurrent preStop calls share one full-stop promise and all await the child (R6-Major)", { skip: process.platform === "win32" }, async () => {
  const plugin = (await import("../src/index.js")).default;
  const binDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cf-bin-"));
  const spawnLog = path.join(binDir, "spawns.log");
  const fake = path.join(binDir, "cloudflared");
  await fsp.writeFile(fake, "#!/bin/sh\ntrap '' INT\necho $$ > \"$DWEB_CF_SPAWN_LOG\"\nexec /bin/sleep 30\n", "utf8");
  const { chmodSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  chmodSync(fake, 0o755);
  const prevPath = process.env.PATH;
  const prevToken = process.env.TUNNEL_TOKEN;
  const prevGrace = process.env.DWEB_CF_SPAWN_GRACE_MS;
  const prevSpawnLog = process.env.DWEB_CF_SPAWN_LOG;
  process.env.PATH = binDir;
  process.env.TUNNEL_TOKEN = "placeholder";
  process.env.DWEB_CF_SPAWN_GRACE_MS = "10000";
  process.env.DWEB_CF_SPAWN_LOG = spawnLog;
  let stopped = null;
  try {
    const postReady = plugin.hooks["server.postReady"]({ options: { tunnel: true } });
    stopped = assert.rejects(postReady, /startup was stopped before it became healthy/);
    // 第二个 preStop 不得在第一个仍在等待子进程终态时提前返回（抢跑
    // server.stop/exit 的根源）——两次调用共享同一全程停止 promise
    const [, second] = await Promise.all([
      plugin.hooks["server.preStop"](),
      plugin.hooks["server.preStop"](),
    ]);
    assert.equal(second, null); // 钩子返回 null；两次调用都在子进程终态后完成
    await stopped;
    // 停止流程结束后复位：后续 preStop 立即完成（无进程可停）
    await plugin.hooks["server.preStop"]();
    let pid = "";
    try {
      pid = (await fsp.readFile(spawnLog, "utf8")).trim();
    } catch { /* child died before echo — equally reaped */ }
    if (/^\d+$/.test(pid)) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.throws(() => execFileSync("/bin/sh", ["-c", `kill -0 ${Number(pid)} 2>/dev/null`]));
    }
  } finally {
    await plugin.hooks["server.preStop"]().catch(() => {});
    await stopped?.catch(() => {});
    try {
      execFileSync("/bin/sh", ["-c", `kill -9 $(cat ${JSON.stringify(spawnLog)} 2>/dev/null) 2>/dev/null || true`]);
    } catch { /* best effort */ }
    process.env.PATH = prevPath;
    process.env.DWEB_CF_SPAWN_GRACE_MS = prevGrace;
    if (prevSpawnLog === undefined) delete process.env.DWEB_CF_SPAWN_LOG;
    else process.env.DWEB_CF_SPAWN_LOG = prevSpawnLog;
    if (prevToken === undefined) delete process.env.TUNNEL_TOKEN;
    else process.env.TUNNEL_TOKEN = prevToken;
  }
});

test("postReady hook: missing cloudflared degrades to a hook failure, not a crash (R2 blocked-6)", async () => {
  const plugin = (await import("../src/index.js")).default;
  const prevPath = process.env.PATH;
  const prevToken = process.env.TUNNEL_TOKEN;
  process.env.TUNNEL_TOKEN = "placeholder";
  process.env.PATH = ""; // spawn 查不到解释器 → ENOENT error 事件
  try {
    await assert.rejects(
      () => plugin.hooks["server.postReady"]({ options: { tunnel: true } }),
      (e) => /cloudflared/.test(e.message) && /installed and on PATH/.test(e.message),
    );
  } finally {
    process.env.PATH = prevPath;
    if (prevToken === undefined) delete process.env.TUNNEL_TOKEN;
    else process.env.TUNNEL_TOKEN = prevToken;
  }
});

test("status command: read-only summary from config file + lock record (TOML and JSON variants)", async () => {
  const cli = (await import("../src/cli.js")).default;
  const prevHome = process.env.DWEB_HOME;
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "cf-home-"));
  process.env.DWEB_HOME = home;
  try {
    // 无配置：not found + plan unknown 也是 exit 0（盘点而非断言）
    const emptyDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cf-status-"));
    let lines = [];
    let r = await cli.run({ command: "status", args: {}, log: (l) => lines.push(l), cwd: emptyDir });
    assert.equal(r.exit, 0);
    assert.match(lines.join("\n"), /config:   not found/);
    assert.match(lines.join("\n"), /plan:     unknown/);

    // TOML 配置 + 锁定记录
    const tomlDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cf-status-toml-"));
    await fsp.writeFile(
      path.join(tomlDir, "opendweb.config.toml"),
      [
        "configVersion = 1",
        "",
        "[server]",
        'publicGatewayUrl = "https://dweb.example.com"',
        "",
        "[[plugins]]",
        'name = "cf"',
      ].join("\n") + "\n",
      "utf8",
    );
    await fsp.writeFile(
      path.join(home, "plugins.json"),
      JSON.stringify({ cf: { package: "@jixo/opendweb-ext-cf", version: "0.1.0" } }),
      "utf8",
    );
    lines = [];
    r = await cli.run({ command: "status", args: {}, log: (l) => lines.push(l), cwd: tomlDir });
    assert.equal(r.exit, 0);
    let out = lines.join("\n");
    assert.match(out, /config:   opendweb\.config\.toml/);
    assert.match(out, /gateway:  dweb\.example\.com \(https:\/\/dweb\.example\.com\)/);
    assert.match(out, /relay:    relay\.dweb\.example\.com/);
    assert.match(out, /plugin:   cf declared in the config/);
    assert.match(out, /lock:     cf @jixo\/opendweb-ext-cf@0\.1\.0/);

    // JSON 配置：无 cf 条目 → plugin 段提示缺失；--hostname 覆盖推导
    const jsonDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cf-status-json-"));
    await fsp.writeFile(
      path.join(jsonDir, "opendweb.config.json"),
      JSON.stringify({ configVersion: 1, server: { publicGatewayUrl: "https://json.example.com" }, plugins: [] }),
      "utf8",
    );
    lines = [];
    r = await cli.run({ command: "status", args: { hostname: "alt.example.org" }, log: (l) => lines.push(l), cwd: jsonDir });
    assert.equal(r.exit, 0);
    out = lines.join("\n");
    assert.match(out, /config:   opendweb\.config\.json/);
    assert.match(out, /gateway:  alt\.example\.org/);
    assert.match(out, /plugin:   cf entry missing in the config/);
  } finally {
    if (prevHome === undefined) delete process.env.DWEB_HOME;
    else process.env.DWEB_HOME = prevHome;
  }
});
