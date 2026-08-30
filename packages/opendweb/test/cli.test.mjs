// opendweb CLI 测试：参数解析/横幅纯函数（--gateway 与 --http 别名等价、全 ASCII 纪律、
// Network IPv4 枚举）+ e2e（随机端口自起 server，断言 /services.json 与 GET /；
// trustProxy 缺省时 X-Forwarded-Proto 不采信）。e2e 依赖 @jixo/opendweb-server-binary
// 内已 pack 的平台二进制；进程级启动/healthz 细节由 server-binary 测试补充覆盖。
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildBanner,
  networkIPv4s,
  resolveServerArgs,
  splitBind,
  validateBind,
} from "../bin/opendweb.mjs";

const NODE = process.execPath;
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/opendweb.mjs");
const ASCII = /^[\x00-\x7F]*$/;

/** 随机空闲端口（bind :0 后立即释放，存在极小竞态窗口） */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * 等待子进程退出（竞态安全）：若 'exit' 事件已在我们挂监听器之前触发
 * （子进程秒退场景，如 CLI 参数校验失败），exitCode/signalCode 已非 null，
 * 直接返回而不是永远等待一个不会再来的事件。
 * @param {import("node:child_process").ChildProcess} child
 */
function waitExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

/**
 * 轮询等待条件成立。CLI 的 readiness 门（R2 P1-2）使横幅延迟到子进程
 * healthz 首次成功（约 200-400ms）之后才打印——e2e 断言必须等横幅真的
 * 出现，而不是 healthz 一通就断言（两者是竞态，负载高时测试侧先赢）。
 * @param {() => boolean} cond
 * @param {number} [timeoutMs]
 */
async function waitUntil(cond, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("condition not met within timeout");
}

/** @param {string} url @param {number} [ms] */
async function waitHealthy(url, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/healthz`);
      if (res.ok) return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`healthz not ready: ${url}`);
}

/** 裸 HTTP 请求：注入 Host / X-Forwarded-Proto 等头（fetch 会忽略部分受控头覆盖） */
function rawRequest(port, reqPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: reqPath, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
  });
}

test("resolveServerArgs: relay enable/disable and trustProxy", () => {
  assert.equal(resolveServerArgs([], {}).relayEnabled, true);
  assert.equal(resolveServerArgs(["--no-relay"], {}).relayEnabled, false);
  assert.equal(resolveServerArgs([], { DWEB_RELAY_ENABLED: "false" }).relayEnabled, false);
  assert.equal(resolveServerArgs([], { DWEB_RELAY_ENABLED: "0" }).relayEnabled, false);
  assert.equal(resolveServerArgs([], {}).trustProxy, false);
  assert.equal(resolveServerArgs([], { DWEB_TRUST_PROXY: "1" }).trustProxy, true);
  assert.equal(resolveServerArgs(["--trust-proxy"], {}).trustProxy, true);
});

test("resolveServerArgs: unknown option and missing value errors", () => {
  assert.equal(resolveServerArgs(["--foo"], {}).error, "unknown option --foo");
  assert.equal(resolveServerArgs(["--gateway"], {}).error, "missing value for --gateway");
  assert.equal(resolveServerArgs(["--public-gateway"], {}).error, "missing value for --public-gateway");
  assert.equal(resolveServerArgs(["--public-relay"], {}).error, "missing value for --public-relay");
});

test("resolveServerArgs: public URL overrides (flag > env > null, trailing slash normalized)", () => {
  const none = resolveServerArgs([], {});
  assert.equal(none.publicGatewayUrl, null);
  assert.equal(none.publicRelayUrl, null);

  const fromEnv = resolveServerArgs([], {
    DWEB_PUBLIC_GATEWAY_URL: "https://gw.example.com/",
    DWEB_PUBLIC_RELAY_URL: "https://relay.example.com",
  });
  assert.equal(fromEnv.publicGatewayUrl, "https://gw.example.com");
  assert.equal(fromEnv.publicRelayUrl, "https://relay.example.com");

  const flag = resolveServerArgs(
    ["--public-gateway", "https://flag-gw.example.com"],
    { DWEB_PUBLIC_GATEWAY_URL: "https://env-gw.example.com" },
  );
  assert.equal(flag.publicGatewayUrl, "https://flag-gw.example.com");

  const inline = resolveServerArgs(["--public-relay=https://r.example.com:443"], {});
  assert.equal(inline.publicRelayUrl, "https://r.example.com:443");
});

test("resolveServerArgs: public URL validation mirrors server rules", () => {
  // path 前缀（iroh set_path 会丢弃 path，必然错配）、query/fragment、
  // 非 http(s)、userinfo、端口越界、空端口
  for (const bad of [
    "https://ex.com/dweb",
    "https://ex.com/?a=b",
    "https://ex.com/#frag",
    "ftp://ex.com",
    "https://user:pass@ex.com",
    "https://user@ex.com",
    "https://ex.com@evil.com",
    "https://ex.com:0",
    "https://ex.com:65536",
    "https://ex.com:",
    "https://ex.com:abc",
    "not a url",
  ]) {
    const r = resolveServerArgs(["--public-gateway", bad], {});
    assert.ok(r.error, `--public-gateway ${bad} must be rejected`);
    assert.match(r.error, /invalid public gateway url/, bad);
  }
  // 合法形态：括号 IPv6、带端口、尾随 "/"
  const ok = resolveServerArgs(
    ["--public-gateway", "http://[fd00::1]:9000", "--public-relay", "https://relay.example.com/"],
    {},
  );
  assert.equal(ok.publicGatewayUrl, "http://[fd00::1]:9000");
  assert.equal(ok.publicRelayUrl, "https://relay.example.com");
});

test("public URL rules: whitespace/unicode host rejected, scheme case normalized (R2 P1-2/P1-3)", () => {
  // R2 P1-2：带空格 host 不得被 CLI 放行（旧正则的 host 字符集过宽）
  assert.ok(resolveServerArgs(["--public-gateway", "https://exa mple.com"], {}).error);
  assert.ok(resolveServerArgs(["--public-gateway", "https://h\u{4e2d}.com"], {}).error);
  assert.ok(resolveServerArgs(["--public-gateway", "https://ex.com\n"], {}).error);
  // R2 P1-3：scheme 大小写不敏感，canonical 归一为小写（与 Rust 侧
  // http::Uri 的 scheme 归一一致，杜绝「校验通过/公告禁用」分裂）
  const r = resolveServerArgs(
    ["--public-gateway", "HTTPS://GW.example.com", "--public-relay", "HtTp://relay.example.com"],
    {},
  );
  assert.equal(r.publicGatewayUrl, "https://GW.example.com");
  assert.equal(r.publicRelayUrl, "http://relay.example.com");
});

test("public URL rules: host charset and canonical port match the Rust binary (R3 P1-1 shared vector)", () => {
  // 70e61ab 曾意外回退 R3 修复；本向量是回归锚点
  assert.ok(resolveServerArgs(["--public-gateway", "https://foo_bar.example.com"], {}).error);
  assert.ok(resolveServerArgs(["--public-gateway", "http://[1.2.3.4]:80"], {}).error);
  assert.ok(resolveServerArgs(["--public-gateway", "http://[fd00::zz]"], {}).error);
  // 前导零端口 canonical 化为十进制（":00001" → ":1"，与 Rust u32 重建一致）
  const r = resolveServerArgs(["--public-gateway", "HTTPS://GW.example.com:00001/"], {});
  assert.equal(r.publicGatewayUrl, "https://GW.example.com:1");
  const ok6 = resolveServerArgs(["--public-relay", "http://[fd00::1]"], {});
  assert.equal(ok6.publicRelayUrl, "http://[fd00::1]");
});

test("banner: all-ASCII, Local/Network enumeration, NAME | PORT service table", () => {
  const ips = ["192.168.2.13", "10.211.55.2"];
  const banner = buildBanner({
    version: "0.2.0",
    gatewayBind: "0.0.0.0:8787",
    relayBind: "0.0.0.0:3340",
    relayEnabled: true,
    ips,
  });
  assert.match(banner, ASCII, "banner must be all-ASCII");
  assert.ok(banner.includes("  * opendweb server v0.2.0"));
  assert.ok(banner.includes("  > Local:   http://localhost:8787"));
  assert.ok(banner.includes("  > Network: http://192.168.2.13:8787"));
  assert.ok(banner.includes("             http://10.211.55.2:8787"));
  assert.ok(banner.includes("  Use any Network address as the single config entry for clients."));
  assert.match(banner, /NAME\s+PORT\s+STATE/);
  assert.ok(banner.includes("gateway"));
  assert.ok(banner.includes("rendezvous"));
  assert.ok(banner.includes("entry point"));
  assert.ok(banner.includes("merged into gateway"));
  assert.ok(banner.includes("relay"));
  assert.ok(banner.includes("enabled"));
  assert.ok(banner.includes("Press Ctrl+C to stop"));
});

test("banner: non-ASCII dynamic values (Local host, version) are escaped, never bare-interpolated", () => {
  // 9.1 动态值纪律：host/version 非 ASCII（UTF-8）时转义为 \xNN 小写 hex 字节序列
  const banner = buildBanner({
    version: "0.2.0-ü", // ü = U+00FC = UTF-8 c3 bc
    gatewayBind: "höst.example:8787", // ö = U+00F6 = UTF-8 c3 b6
    relayBind: "0.0.0.0:3340",
    relayEnabled: true,
    ips: ["192.168.2.13"],
  });
  assert.match(banner, ASCII, "banner must stay all-ASCII with non-ASCII inputs");
  assert.ok(banner.includes("  * opendweb server v0.2.0-\\xc3\\xbc"));
  assert.ok(banner.includes("  > Local:   http://h\\xc3\\xb6st.example:8787"));
  // 服务表完好（端口为纯数字，转义为恒等变换）
  assert.match(banner, /NAME\s+PORT\s+STATE/);
  assert.ok(banner.includes("entry point"));
});

test("banner: placeholder line when no non-loopback IPv4 found", () => {
  const banner = buildBanner({
    version: "0.2.0",
    gatewayBind: "127.0.0.1:8787",
    relayBind: "0.0.0.0:3340",
    relayEnabled: false,
    ips: [],
  });
  assert.match(banner, ASCII);
  assert.ok(banner.includes("(no non-loopback IPv4 found)"));
  assert.ok(banner.includes("> Local:   http://127.0.0.1:8787"));
  assert.ok(banner.includes("disabled"));
  // 每个地址恰一行：占位行只出现一次
  assert.equal(banner.split("(no non-loopback IPv4 found)").length - 1, 1);
});

test("banner: Public section only when overrides set, guidance line switches", () => {
  const base = {
    version: "0.2.0",
    gatewayBind: "0.0.0.0:8787",
    relayBind: "0.0.0.0:3340",
    relayEnabled: true,
    ips: ["192.168.2.13"],
  };
  // 未设置：无 Public 节，指引仍是 Network 地址
  const plain = buildBanner(base);
  assert.ok(!plain.includes("Public"));
  assert.ok(plain.includes("Use any Network address as the single config entry for clients."));

  // 双覆盖：Public 节逐行列出，指引切换
  const full = buildBanner({
    ...base,
    publicGatewayUrl: "https://gw.example.com",
    publicRelayUrl: "https://relay.example.com",
  });
  assert.match(full, ASCII);
  assert.ok(full.includes("  > Public:  gateway https://gw.example.com"));
  assert.ok(full.includes("             relay   https://relay.example.com"));
  assert.ok(full.includes("Use the Public URLs as the config entry for clients"));

  // 仅 relay 覆盖：gateway 行不出现
  const relayOnly = buildBanner({ ...base, publicRelayUrl: "https://relay.example.com" });
  assert.ok(relayOnly.includes("  > Public:  relay   https://relay.example.com"));
  assert.ok(!relayOnly.includes("gateway https://"));
});

test("banner: no duplicate Network lines for repeated interface addresses", () => {
  const banner = buildBanner({
    version: "0.2.0",
    gatewayBind: "0.0.0.0:8787",
    relayBind: "0.0.0.0:3340",
    relayEnabled: true,
    ips: ["192.168.2.13", "192.168.2.13"],
  });
  assert.equal(banner.split("http://192.168.2.13:8787").length - 1, 1);
});

test("networkIPv4s enumerates all non-loopback IPv4, deduped and numerically sorted", () => {
  const expected = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if ((ni.family === "IPv4" || ni.family === 4) && !ni.internal) expected.push(ni.address);
    }
  }
  // 期望序独立于实现表述：点分四段逐段数值升序（task 9.2 冻结语义）
  const numeric = (a, b) => {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    return (pa[0] - pb[0]) || (pa[1] - pb[1]) || (pa[2] - pb[2]) || (pa[3] - pb[3]);
  };
  assert.deepEqual(networkIPv4s(), [...new Set(expected)].sort(numeric));
  // 纯函数注入形态
  assert.deepEqual(
    networkIPv4s({
      lo: [
        { family: "IPv4", internal: true, address: "127.0.0.1" },
        { family: "IPv6", internal: true, address: "::1" },
      ],
      en0: [
        { family: "IPv4", internal: false, address: "10.0.0.2" },
        { family: "IPv4", internal: false, address: "10.0.0.1" },
        { family: "IPv6", internal: false, address: "fd00::5" },
      ],
      en1: [{ family: "IPv4", internal: false, address: "10.0.0.2" }],
    }),
    ["10.0.0.1", "10.0.0.2"],
  );
  // task 9.2 回归：字符串字典序会把 "9.0.0.1" 排到 "10.0.0.2" 之后，数值序必须在前
  assert.deepEqual(
    networkIPv4s({
      en0: [
        { family: "IPv4", internal: false, address: "192.168.1.5" },
        { family: "IPv4", internal: false, address: "10.0.0.2" },
        { family: "IPv4", internal: false, address: "9.0.0.1" },
      ],
    }),
    ["9.0.0.1", "10.0.0.2", "192.168.1.5"],
  );
});

test("splitBind handles ipv6 bracket form", () => {
  assert.deepEqual(splitBind("0.0.0.0:8787"), { host: "0.0.0.0", port: 8787 });
  assert.deepEqual(splitBind("[::]:8787"), { host: "::", port: 8787 });
  assert.deepEqual(splitBind("example.com:80"), { host: "example.com", port: 80 });
});

test("opendweb help is all-ASCII and mentions server usage", async () => {
  const out = await new Promise((resolve, reject) => {
    execFile(NODE, [CLI, "help"], (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(stdout + stderr);
    });
  });
  assert.match(out, ASCII, "help output must be all-ASCII");
  assert.ok(out.includes("opendweb server"), "help mentions server command");
  assert.ok(out.includes("--gateway"), "help documents --gateway");
  assert.ok(out.includes("DWEB_GATEWAY_BIND"), "help documents env vars");
  assert.ok(out.includes("opendweb-example"), "help mentions example flow");
});

test("opendweb server e2e: ASCII banner + /services.json + GET / (random ports)", async () => {
  const gatewayPort = await freePort();
  const relayPort = await freePort();
  const child = spawn(
    NODE,
    [CLI, "server", "--gateway", `127.0.0.1:${gatewayPort}`, "--relay", `127.0.0.1:${relayPort}`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stdout += d));
  try {
    await waitHealthy(`http://127.0.0.1:${gatewayPort}`);

    // 横幅：全 ASCII + Local/Network + 服务表（readiness 门使横幅略滞后，
    // 必须等横幅完整出现再断言——banner 尾行是打印完成的标志）
    await waitUntil(() => stdout.includes("Press Ctrl+C to stop"));
    assert.match(stdout, ASCII, "CLI output must be all-ASCII");
    assert.ok(
      stdout.includes(`  > Local:   http://127.0.0.1:${gatewayPort}`),
      `Local line missing; exitCode=${child.exitCode} stdout=${JSON.stringify(stdout.slice(0, 300))}`,
    );
    const ips = networkIPv4s();
    if (ips.length > 0) {
      assert.ok(stdout.includes(`http://${ips[0]}:${gatewayPort}`), "banner lists network IPv4");
    } else {
      assert.ok(stdout.includes("(no non-loopback IPv4 found)"));
    }
    assert.match(stdout, /NAME\s+PORT\s+STATE/);

    // /services.json 契约
    const res = await rawRequest(gatewayPort, "/services.json", {
      Host: `127.0.0.1:${gatewayPort}`,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-type"], "application/json");
    assert.equal(res.headers["cache-control"], "no-store");
    const manifest = JSON.parse(res.body);
    assert.equal(manifest.server, "opendweb");
    assert.ok(typeof manifest.version === "string" && manifest.version.length > 0);
    assert.equal(manifest.gateway, `http://127.0.0.1:${gatewayPort}`);
    const byName = Object.fromEntries(manifest.services.map((s) => [s.name, s]));
    assert.deepEqual(Object.keys(byName).sort(), ["relay", "rendezvous"]);
    assert.equal(byName.rendezvous.enabled, true);
    assert.equal(byName.rendezvous.url, `http://127.0.0.1:${gatewayPort}/rendezvous`);
    assert.equal(byName.relay.enabled, true);
    assert.equal(byName.relay.url, `http://127.0.0.1:${relayPort}`);

    // X-Forwarded-Proto 信任边界：未设置 DWEB_TRUST_PROXY=1 时不采信
    const xf = await rawRequest(gatewayPort, "/services.json", {
      Host: `127.0.0.1:${gatewayPort}`,
      "X-Forwarded-Proto": "https",
    });
    const xfManifest = JSON.parse(xf.body);
    assert.equal(xfManifest.gateway, `http://127.0.0.1:${gatewayPort}`);

    // GET / 纯文本摘要（全 ASCII，与清单一致）
    const root = await rawRequest(gatewayPort, "/", { Host: `127.0.0.1:${gatewayPort}` });
    assert.equal(root.status, 200);
    assert.match(root.headers["content-type"], /^text\/plain/);
    assert.match(root.body, ASCII, "GET / must be all-ASCII");
    assert.ok(root.body.includes("opendweb server"));
    assert.ok(root.body.includes(`http://127.0.0.1:${relayPort}`));
  } finally {
    child.kill("SIGINT");
    await waitExit(child);
  }
});

test("opendweb server e2e: --http alias starts an identical gateway", async () => {
  // 154baf3 移除 --http 别名：该入口现在快速失败（退出码 2 + 错误消息），
  // 而不是启动等价 gateway。断言跟随当前语义。
  const gatewayPort = await freePort();
  const relayPort = await freePort();
  const child = spawn(
    NODE,
    [CLI, "server", "--http", `127.0.0.1:${gatewayPort}`, "--relay", `127.0.0.1:${relayPort}`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stdout += d));
  const code = await new Promise((resolve) => {
    child.once("exit", (c) => resolve(c));
  });
  assert.equal(code, 2);
  assert.match(stdout, /unknown option --http/);
});

test("resolveServerArgs: --http is now an unknown option", () => {
  // ESM 直用顶部已导入的 resolveServerArgs（历史版本误用 require 导致
  // ReferenceError 掩盖真实断言）
  assert.equal(
    resolveServerArgs(["--http", "0.0.0.0:9999"], {}).error,
    "unknown option --http",
  );
});

test("opendweb server e2e: public URL overrides are advertised in /services.json", async () => {
  const gatewayPort = await freePort();
  const relayPort = await freePort();
  const child = spawn(
    NODE,
    [
      CLI, "server",
      "--gateway", `127.0.0.1:${gatewayPort}`,
      "--relay", `127.0.0.1:${relayPort}`,
      "--public-gateway", "https://gw.example.com",
      "--public-relay", "https://relay.example.com",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stdout += d));
  try {
    await waitHealthy(`http://127.0.0.1:${gatewayPort}`);
    // readiness 门使横幅滞后于 healthz；等横幅完整出现再断言 Public 节
    await waitUntil(() => stdout.includes("Press Ctrl+C to stop"));
    // 横幅 Public 节（public-exposure D5）
    assert.ok(stdout.includes("  > Public:  gateway https://gw.example.com"));
    assert.ok(stdout.includes("             relay   https://relay.example.com"));
    // manifest：覆盖值原样公告，Host 派生被跳过（D3）
    const res = await rawRequest(gatewayPort, "/services.json", { Host: `127.0.0.1:${gatewayPort}` });
    const manifest = JSON.parse(res.body);
    assert.equal(manifest.gateway, "https://gw.example.com");
    const byName = Object.fromEntries(manifest.services.map((s) => [s.name, s]));
    assert.equal(byName.rendezvous.url, "https://gw.example.com/rendezvous");
    assert.equal(byName.relay.url, "https://relay.example.com");
    // GET / 摘要同样公告公网地址
    const root = await rawRequest(gatewayPort, "/", { Host: `127.0.0.1:${gatewayPort}` });
    assert.ok(root.body.includes("https://relay.example.com"));
  } finally {
    child.kill("SIGINT");
    await waitExit(child);
  }
});

test("opendweb server e2e: invalid public URL fails fast with exit code 2", async () => {
  // path 前缀在 CLI 层即被拒（与 Rust validate_public_url 同规），子进程不启动
  const code = await new Promise((resolve) => {
    const child = spawn(
      NODE,
      [CLI, "server", "--public-gateway", "https://ex.com/dweb"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    child.on("exit", (c) => resolve(c));
  });
  assert.equal(code, 2);
});

test("opendweb server e2e: child bind failure propagates non-zero exit, no banner (R2 P1-2)", async () => {
  // 端口冲突设计在 relay 端口：Rust main 先绑 relay 再绑 gateway，第二实例
  // 在 relay bind 即失败退出；其 gateway 端口是全新空闲口——readiness 门的
  // healthz 探测永远失败，必须由 exited 分支胜出：无横幅、stderr 转发、
  // 非零退出码（CLI 不再伪成功）。
  const relayPort = await freePort();
  const first = spawn(
    NODE,
    [CLI, "server", "--gateway", `127.0.0.1:${await freePort()}`, "--relay", `127.0.0.1:${relayPort}`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let firstOut = "";
  first.stdout.on("data", (d) => (firstOut += d));
  try {
    await waitUntil(() => firstOut.includes("Press Ctrl+C to stop"), 20000);

    const second = spawn(
      NODE,
      [CLI, "server", "--gateway", `127.0.0.1:${await freePort()}`, "--relay", `127.0.0.1:${relayPort}`],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let secondOut = "";
    let secondErr = "";
    second.stdout.on("data", (d) => (secondOut += d));
    second.stderr.on("data", (d) => (secondErr += d));
    const code = await new Promise((resolve) => {
      second.once("exit", (c) => resolve(c));
    });
    assert.notEqual(code, 0, "conflicting bind must exit non-zero");
    assert.ok(!secondOut.includes("opendweb server v"), "no success banner on failed start");
    assert.ok(
      secondErr.includes("exited unexpectedly"),
      `stderr should surface the failure, got: ${secondErr.slice(0, 300)}`,
    );
  } finally {
    first.kill("SIGINT");
    await waitExit(first);
  }
});

// ---------------------------------------------------------------------------
// plugin-marketplace e2e：自适应子命令 / marketplace / setup（子进程级）
// ---------------------------------------------------------------------------

const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

/** 造一个「项目目录 + 已安装 echo 插件 + DWEB_HOME 隔离」的 e2e 环境 */
async function pluginProjectEnv() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "opendweb-e2e-"));
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "opendweb-home-"));
  await fsp.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "e2e", private: true }), "utf8");
  await fsp.cp(path.join(FIXTURES_DIR, "opendweb-echo"), path.join(dir, "node_modules", "opendweb-echo"), { recursive: true });
  return { dir, home };
}

/** 以指定 cwd/DWEB_HOME 跑 CLI 子进程，收集 stdout/stderr/退出码 */
function runCli(args, envObj, extraEnv = {}) {
  return runCliWithEnv(args, envObj, extraEnv);
}

function runCliWithEnv(args, { dir, home }, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [CLI, ...args], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, DWEB_HOME: home, NO_COLOR: "1", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (code) => resolve({ code: code ?? 0, out, err }));
  });
}

test("adaptive e2e: opendweb echo hello dispatches through marketplace resolution", async () => {
  const env = await pluginProjectEnv();
  const r = await runCli(["echo", "hello", "--name", "ada", "--loud", "--times", "2"], env);
  assert.equal(r.code, 0, `stderr: ${r.err}`);
  // 孤儿提示（fixture 从磁盘解析、无锁定记录）是预期行为：一行 note + 命令输出
  assert.match(r.out, /^note: echo resolved an unlocked opendweb-echo @1\.2\.3 from disk; run "plugin install echo" to lock it and stay up to date\n/);
  assert.equal(r.out.split("\n").slice(1).join("\n"), "hello ada!\nhello ada!\n");

  const use = await runCli(["use", "echo", "hello", "--name", "bob"], env);
  assert.equal(use.code, 0);
  assert.equal(use.out.split("\n").slice(1).join("\n"), "hello bob\n");
});

test("adaptive e2e: not-installed plugin prints install guidance (DWEB_NO_AUTO_INSTALL), exit non-zero", async () => {
  const env = await pluginProjectEnv();
  // 默认语义已改为自愈安装（走真实包管理器，测试不可联网）——本用例固定
  // 显式安装语义；自愈路径由 fake-pm shim 用例覆盖
  const r = await runCliWithEnv(["frp", "setup"], env, { DWEB_NO_AUTO_INSTALL: "1" });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /opendweb plugin add frp/);
});

test("adaptive e2e: plugin --help renders zero-exec usage, exit 0", async () => {
  const env = await pluginProjectEnv();
  const r = await runCli(["echo", "--help"], env);
  assert.equal(r.code, 0);
  assert.match(r.out, /opendweb echo hello --name <string>/);
  assert.match(r.out, /greet by name/);
});

test("adaptive e2e: malformed installed plugin is a hard error (no silent skip)", async () => {
  const env = await pluginProjectEnv();
  await fsp.cp(path.join(FIXTURES_DIR, "opendweb-bad"), path.join(env.dir, "node_modules", "opendweb-bad"), { recursive: true });
  const r = await runCli(["bad", "anything"], env);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /invalid opendweb-plugin manifest/);
});

test("marketplace e2e: list shows defaults; add validates npm: protocol", async () => {
  const env = await pluginProjectEnv();
  const list = await runCli(["marketplace", "list"], env);
  assert.equal(list.code, 0);
  assert.match(list.out, /npm:@jixo\/opendweb-ext-\*/);
  assert.match(list.out, /npm:opendweb-\*/);

  const bad = await runCli(["marketplace", "add", "github:foo/*"], env);
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /only npm: source is supported/);

  const ok = await runCli(["marketplace", "add", "npm:mine-*"], env);
  assert.equal(ok.code, 0);
  assert.match(ok.out, /added: npm:mine-\*/);
  const again = await runCli(["marketplace", "list"], env);
  assert.match(again.out, /npm:mine-\*/);
});

test("plugin e2e: list on fresh home shows empty state", async () => {
  const env = await pluginProjectEnv();
  const r = await runCli(["plugin", "list"], env);
  assert.equal(r.code, 0);
  assert.match(r.out, /\(no plugins installed\)/);
});

test("setup e2e: no config -> nothing to do (exit 0); local plugin setup runs via config", async () => {
  const env = await pluginProjectEnv();
  const none = await runCli(["setup"], env);
  assert.equal(none.code, 0);
  assert.match(none.out, /no config file found/);

  // 带本地插件配置：setup 钩子执行（definePlugin 协议由 CLI 子进程适配器驱动）
  const cfg = `
configVersion = 1

[[plugins]]
file = ${JSON.stringify(path.join(FIXTURES_DIR, "local-echo.mjs"))}
`;
  await fsp.writeFile(path.join(env.dir, "opendweb.config.toml"), cfg, "utf8");
  const done = await runCli(["setup"], env);
  assert.equal(done.code, 0, `stderr: ${done.err}`);
  assert.match(done.out, /setup ok: local-echo/);
});

test("setup e2e: failing setup hook aggregates non-zero with per-plugin status", async () => {
  const env = await pluginProjectEnv();
  const cfg = `
configVersion = 1

[[plugins]]
file = ${JSON.stringify(path.join(FIXTURES_DIR, "local-echo.mjs"))}
[plugins.options]
fail = true
`;
  await fsp.writeFile(path.join(env.dir, "opendweb.config.toml"), cfg, "utf8");
  const r = await runCli(["setup"], env);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /error\[plugin\/local-echo\]: setup failed as requested/);
});

test("help mentions new commands (marketplace/plugin/setup)", async () => {
  const out = await new Promise((resolve, reject) => {
    execFile(NODE, [CLI, "help"], (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(stdout + stderr);
    });
  });
  assert.match(out, ASCII, "help must be all-ASCII");
  assert.match(out, /opendweb marketplace/);
  assert.match(out, /opendweb plugin/);
  assert.match(out, /opendweb setup/);
  assert.match(out, /opendweb <plugin-name>/);
});

// ---------------------------------------------------------------------------
// 自愈安装 e2e（Owner 决策第四轮：opendweb cf 即 get cf ?? add cf）
// ---------------------------------------------------------------------------

import { chmodSync } from "node:fs";

/** 造一个假 npm shim（无网络安装）：复制 DWEB_FAKE_PM_SRC/<pkg> 到 ./node_modules/<pkg> */
async function fakePmShim(srcDir) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "opendweb-pm-"));
  const script = path.join(dir, "npm");
  await fsp.writeFile(
    script,
    [
      "#!/bin/sh",
      '# fake package manager (test shim): copy fixture package into node_modules',
      'pkg=""',
      'for a in "$@"; do case "$a" in -*) ;; *) pkg="$a";; esac; done',
      '[ -z "$pkg" ] && exit 1',
      'echo "fake-pm: $pkg (src $DWEB_FAKE_PM_SRC/$pkg)" >&2',
      'src="$DWEB_FAKE_PM_SRC/$pkg"',
      '[ -d "$src" ] || { echo "fake-pm: fixture $src missing (shim ran; real npm would differ)" >&2; exit 9; }',
      'dst="node_modules/$pkg"',
      'mkdir -p "$(dirname "$dst")"',
      'cp -R "$src" "$dst" || exit 1',
      "exit 0",
    ].join("\n"),
    "utf8",
  );
  chmodSync(script, 0o755);
  return { dir, srcDir };
}

test("adaptive e2e: missing plugin is auto-installed on first use (get ?? add, scoped candidate first)", async () => {
  const env = await pluginProjectEnv();
  // 自愈场景要求「未安装」：移除预装的无 scope echo，迫使走首个候选（scoped）
  await fsp.rm(path.join(env.dir, "node_modules", "opendweb-echo"), { recursive: true, force: true });
  const shim = await fakePmShim(FIXTURES_DIR); // DWEB_FAKE_PM_SRC=fixtures：$SRC/@jixo/opendweb-ext-echo
  const child = spawn(NODE, [CLI, "echo", "hello", "--name", "ada"], {
    cwd: env.dir,
    env: {
      PATH: `${shim.dir}:${process.env.PATH}`,
      HOME: process.env.HOME,
      DWEB_HOME: env.home,
      DWEB_FAKE_PM_SRC: shim.srcDir,
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const code = await new Promise((resolve) => child.on("exit", (c) => resolve(c ?? 0)));
  assert.equal(code, 0, `stderr: ${err}`);
  assert.match(out, /installed: echo \(@jixo\/opendweb-ext-echo@1\.2\.3\)/);
  assert.match(out, /hello ada/);
  // 安装后写入锁定记录
  const lock = JSON.parse(await fsp.readFile(path.join(env.home, "plugins.json"), "utf8"));
  assert.deepEqual(lock.echo, { package: "@jixo/opendweb-ext-echo", version: "1.2.3" });
});

test("adaptive e2e: DWEB_NO_AUTO_INSTALL=1 keeps explicit-install semantics (manual guidance)", async () => {
  const env = await pluginProjectEnv();
  await fsp.rm(path.join(env.dir, "node_modules", "opendweb-echo"), { recursive: true, force: true });
  const r = await new Promise((resolve) => {
    const child = spawn(NODE, [CLI, "echo", "hello", "--name", "ada"], {
      cwd: env.dir,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        DWEB_HOME: env.home,
        DWEB_NO_AUTO_INSTALL: "1",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (c) => resolve({ code: c ?? 0, out, err }));
  });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /opendweb plugin add echo/);
  // 自愈关闭时不得有任何安装痕迹
  assert.equal(
    await fsp.stat(path.join(env.dir, "node_modules", "@jixo")).then(() => true).catch(() => false),
    false,
    "nothing installed",
  );
});

test("plugin e2e: get is an alias of add", async () => {
  const env = await pluginProjectEnv();
  const shim = await fakePmShim(FIXTURES_DIR);
  const r = await new Promise((resolve) => {
    const child = spawn(NODE, [CLI, "plugin", "get", "echo"], {
      cwd: env.dir,
      env: {
        PATH: `${shim.dir}:${process.env.PATH}`,
        HOME: process.env.HOME,
        DWEB_HOME: env.home,
        DWEB_FAKE_PM_SRC: shim.srcDir,
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (c) => resolve({ code: c ?? 0, out, err }));
  });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /installed: echo \(@jixo\/opendweb-ext-echo@1\.2\.3\)/);
});

test("plugin e2e: add works for src/-layout exports packages (findPackageRoot walks up)", async () => {
  const env = await pluginProjectEnv();
  const shim = await fakePmShim(FIXTURES_DIR);
  const r = await new Promise((resolve) => {
    const child = spawn(NODE, [CLI, "plugin", "add", "srclayout"], {
      cwd: env.dir,
      env: {
        PATH: `${shim.dir}:${process.env.PATH}`,
        HOME: process.env.HOME,
        DWEB_HOME: env.home,
        DWEB_FAKE_PM_SRC: shim.srcDir,
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (c) => resolve({ code: c ?? 0, out, err }));
  });
  assert.equal(r.code, 0, r.err);
  // 入口在 src/ 下：版本读取必须向上找到包根（R2 阻塞-2）
  assert.match(r.out, /installed: srclayout \(@jixo\/opendweb-ext-srclayout@3\.1\.4\)/);
  // 安装后自适应派发也可用（exports 子路径 src/plugin.js 解析）
  const dispatch = await runCli(["srclayout", "ping"], env);
  assert.equal(dispatch.code, 0, dispatch.err);
  assert.equal(dispatch.out, "pong\n");
});

test("reserved word: opendweb config is rejected, never dispatched to a plugin (R2 blocked-4)", async () => {
  const env = await pluginProjectEnv();
  // 即便同名插件已安装，保留字也必须被 builtin 分支显式拒绝
  await fsp.cp(path.join(FIXTURES_DIR, "opendweb-echo"), path.join(env.dir, "node_modules", "opendweb-echo"), { recursive: true });
  const r = await runCli(["config"], env);
  assert.equal(r.code, 2);
  assert.match(r.err, /"config" is reserved/);
});

test("setup e2e: --config <path> works and local plugin file resolves relative to the config dir (R2 blocked-3)", async () => {
  const env = await pluginProjectEnv();
  // 配置文件放在子目录，file 用相对路径——必须相对配置文件目录而非 cwd 解析
  const cfgDir = path.join(env.dir, "custom");
  await fsp.mkdir(cfgDir, { recursive: true });
  await fsp.copyFile(path.join(FIXTURES_DIR, "local-echo.mjs"), path.join(cfgDir, "local-echo.mjs"));
  await fsp.writeFile(
    path.join(cfgDir, "cfg.toml"),
    ['configVersion = 1', "", "[[plugins]]", 'file = "local-echo.mjs"'].join("\n"),
    "utf8",
  );
  const r = await runCli(["setup", "--config", "custom/cfg.toml"], env);
  assert.equal(r.code, 0, `stderr: ${r.err}`);
  assert.match(r.out, /setup ok: local-echo/);

  // 缺值报错（退出码 2）
  const missing = await runCli(["setup", "--config"], env);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /missing value for --config/);
});

test("setup e2e: plugins receive configPath/configDir matching the explicit --config (R2-M2)", async () => {
  const env = await pluginProjectEnv();
  const cfgDir = path.join(env.dir, "custom");
  await fsp.mkdir(cfgDir, { recursive: true });
  await fsp.copyFile(path.join(FIXTURES_DIR, "cfg-assert.mjs"), path.join(cfgDir, "cfg-assert.mjs"));
  await fsp.writeFile(
    path.join(cfgDir, "cfg.toml"),
    ['configVersion = 1', "", "[[plugins]]", 'file = "cfg-assert.mjs"'].join("\n"),
    "utf8",
  );
  const r = await new Promise((resolve) => {
    const child = spawn(NODE, [CLI, "setup", "--config", "custom/cfg.toml"], {
      cwd: env.dir,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        DWEB_HOME: env.home,
        NO_COLOR: "1",
        CFG_ASSERT_EXPECT: "custom/cfg.toml",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (c) => resolve({ code: c ?? 0, out, err }));
  });
  assert.equal(r.code, 0, `stderr: ${r.err}`);
  assert.match(r.out, /setup ok: cfg-assert/);
});

test("validateBind: host:port form with port range (R2 blocked-8, preStart override same-rule validation)", () => {
  for (const ok of ["127.0.0.1:8787", "0.0.0.0:9000", "[::1]:3340", "example.com:80"]) {
    assert.equal(validateBind(ok, "bind"), null, ok);
  }
  for (const bad of ["", ":8080", "localhost", "host:0", "host:70000", "host:abc", "a:b:c"]) {
    assert.notEqual(validateBind(bad, "bind"), null, bad);
  }
  assert.match(validateBind("host:0", "preStart override gatewayBind"), /port 1-65535/);
});
