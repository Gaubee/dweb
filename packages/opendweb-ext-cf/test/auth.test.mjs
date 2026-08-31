// 认证面单测（1.0.0 双方案）：PKCE(S256) 工具、授权 URL 形态、loopback 回调
// 服务（注入 fake ServerLike）、loginFlow（PKCE + 回调 + code 换 token，含
// state 不匹配与 token 端点错误）、持久化登录态（0600、roundtrip、clear）、
// getApiToken 决策矩阵（env 优先 > 缓存 access token > 静默 refresh rotation）。
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import {
  CF_OAUTH,
  redirectUri,
  resolveClientId,
  authFilePath,
  loadStoredAuth,
  saveStoredAuth,
  clearStoredAuth,
  makePkcePair,
  makeState,
  buildAuthorizeUrl,
  waitForCallback,
  loginFlow,
  refreshAccessToken,
  getApiToken,
} from "../dist/auth.mjs";

// ---- 常量与 PKCE ----

test("CF_OAUTH contract: loopback redirect URI, scopes, timeout", () => {
  assert.equal(CF_OAUTH.callbackPort, 18971);
  assert.equal(CF_OAUTH.redirectPath, "/callback");
  assert.deepEqual(CF_OAUTH.SCOPES, ["offline_access", "account:read", "zone:read"]);
  assert.equal(CF_OAUTH.loginTimeoutMs, 300000);
  assert.equal(redirectUri(), "http://127.0.0.1:18971/callback");
});

test("makePkcePair: verifier 43-128 base64url chars; challenge = base64url(sha256(verifier))", () => {
  const { verifier, challenge } = makePkcePair();
  assert.ok(verifier.length >= 43 && verifier.length <= 128, `verifier len ${verifier.length}`);
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));

  // 32 字节熵 -> 恰好 43 字符（RFC 7636 下限）
  const min = makePkcePair(() => Buffer.alloc(32, 7));
  assert.equal(min.verifier.length, 43);
  assert.equal(min.challenge, createHash("sha256").update(min.verifier).digest("base64url"));

  // 熵不足 -> 显式拒绝（不得生成不合规 verifier）
  assert.throws(() => makePkcePair(() => Buffer.alloc(10, 7)), /PKCE verifier too short/);
});

test("makeState: base64url of the injected randomness", () => {
  const s = makeState(() => Buffer.from("abcdefghijklmnopqrstuvwx", "utf8"));
  assert.equal(s, Buffer.from("abcdefghijklmnopqrstuvwx").toString("base64url"));
  assert.notEqual(makeState(), makeState());
});

test("buildAuthorizeUrl: authorization-code + PKCE S256 query params; scopes space-joined", () => {
  const url = new URL(
    buildAuthorizeUrl({ clientId: "cid-1", state: "st-1", challenge: "ch-1" }),
  );
  assert.equal(`${url.origin}${url.pathname}`, CF_OAUTH.authorizeUrl);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "cid-1");
  assert.equal(url.searchParams.get("redirect_uri"), redirectUri());
  assert.equal(url.searchParams.get("scope"), CF_OAUTH.SCOPES.join(" "));
  assert.equal(url.searchParams.get("state"), "st-1");
  assert.equal(url.searchParams.get("code_challenge"), "ch-1");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  // 显式 scopes 覆盖默认
  const custom = new URL(buildAuthorizeUrl({ clientId: "c", state: "s", challenge: "x", scopes: ["a", "b"] }));
  assert.equal(custom.searchParams.get("scope"), "a b");
});

test("resolveClientId precedence: env > explicit > builtin(empty -> null)", () => {
  assert.equal(resolveClientId(undefined, { CF_OAUTH_CLIENT_ID: "env-cid" }), "env-cid");
  assert.equal(resolveClientId("exp-cid", {}), "exp-cid");
  assert.equal(resolveClientId("exp-cid", { CF_OAUTH_CLIENT_ID: "env-cid" }), "env-cid");
  assert.equal(resolveClientId("exp-cid", { CF_OAUTH_CLIENT_ID: "   " }), "exp-cid"); // 空白 env 忽略
  assert.equal(resolveClientId(undefined, {}), null); // builtinClientId 尚未内置
  assert.equal(resolveClientId("  ", {}), null);
});

// ---- 持久化登录态 ----

test("authFilePath/loadStoredAuth: path shape; missing/invalid/incomplete files -> null; valid roundtrip", async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "cf-auth-"));
  assert.equal(authFilePath(home), path.join(home, "cf-auth.json"));

  assert.equal(await loadStoredAuth(home), null); // 文件不存在

  const file = authFilePath(home);
  await fsp.writeFile(file, "not json at all", "utf8");
  assert.equal(await loadStoredAuth(home), null); // 解析失败

  await fsp.writeFile(file, JSON.stringify({ refreshToken: "rt" }), "utf8"); // 缺 clientId
  assert.equal(await loadStoredAuth(home), null);
  await fsp.writeFile(file, JSON.stringify({ clientId: "cid" }), "utf8"); // 缺 refreshToken
  assert.equal(await loadStoredAuth(home), null);

  const auth = { refreshToken: "rt-1", clientId: "cid-1" };
  await fsp.writeFile(file, JSON.stringify(auth), "utf8");
  assert.deepEqual(await loadStoredAuth(home), auth);

  // B4a：1.0.0 落过盘的 accessToken/expiresAt 被剥离——登录态恰好两字段
  await fsp.writeFile(
    file,
    JSON.stringify({ refreshToken: "rt-1", clientId: "cid-1", accessToken: "leak", expiresAt: 1 }),
    "utf8",
  );
  assert.deepEqual(await loadStoredAuth(home), { refreshToken: "rt-1", clientId: "cid-1" });
});

test("saveStoredAuth: mkdir + write + chmod 0600 (real fs roundtrip; injectable io)", async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "cf-auth-save-"));
  const auth = { refreshToken: "rt-1", clientId: "cid-1" };
  await saveStoredAuth(home, auth);
  const file = authFilePath(home);
  assert.equal((statSync(file).mode & 0o777), 0o600, "stored session file must be 0600");
  const written = await fsp.readFile(file, "utf8");
  assert.equal(written, `${JSON.stringify(auth, null, 2)}\n`);
  assert.deepEqual(await loadStoredAuth(home), auth);

  // 注入 io：三个动作都可替换（捕获参数，不落盘）
  const ioCalls = { mkdir: [], writeFile: [], chmod: [] };
  await saveStoredAuth("/fake/home", auth, {
    mkdir: async (p) => ioCalls.mkdir.push(p),
    writeFile: async (p, c) => ioCalls.writeFile.push({ p, c }),
    chmod: async (p, m) => ioCalls.chmod.push({ p, m }),
  });
  assert.deepEqual(ioCalls.mkdir, ["/fake/home"]);
  assert.equal(ioCalls.writeFile[0].p, "/fake/home/cf-auth.json");
  assert.deepEqual(ioCalls.writeFile[0].c, `${JSON.stringify(auth, null, 2)}\n`);
  assert.deepEqual(ioCalls.chmod, [{ p: "/fake/home/cf-auth.json", m: 0o600 }]);
});

test("clearStoredAuth: removes the session file; a missing file is not an error", async () => {
  const removed = [];
  await clearStoredAuth("/h", async (p) => removed.push(p));
  assert.deepEqual(removed, ["/h/cf-auth.json"]);
  await clearStoredAuth("/h", async () => {
    throw new Error("ENOENT");
  }); // swallow
});

// ---- loopback 回调服务（注入 fake ServerLike） ----

/** fake ServerLike：捕获 request/error 处理器，fire() 模拟一次浏览器回调 */
function fakeCallbackServer() {
  const s = { handler: null, onError: null, closed: 0, listen: null };
  const srv = {
    once(evt, cb) {
      if (evt === "error") s.onError = cb;
      return srv;
    },
    on(evt, cb) {
      if (evt === "request") s.handler = cb;
      return srv;
    },
    close() {
      s.closed += 1;
      return srv;
    },
    listen(port, host) {
      s.listen = { port, host };
      return srv;
    },
  };
  const fire = (url) => {
    assert.ok(s.handler, "request handler must be registered");
    const res = {
      status: null,
      body: "",
      writeHead(code) {
        res.status = code;
        return res;
      },
      end(b = "") {
        res.body = b;
        return res;
      },
    };
    s.handler({ url }, res);
    return res;
  };
  return { srv, s, fire };
}

test("waitForCallback: success resolves {code,state} with 200 and closes the server", async () => {
  const f = fakeCallbackServer();
  const p = waitForCallback({ createServerImpl: () => f.srv });
  assert.deepEqual(f.s.listen, { port: 18971, host: "127.0.0.1" }, "binds the registered redirect port on loopback");
  const res = f.fire("/callback?code=abc&state=st-9");
  assert.equal(res.status, 200);
  assert.match(res.body, /authorization received/);
  assert.deepEqual(await p, { code: "abc", state: "st-9" });
  assert.equal(f.s.closed, 1);
});

test("waitForCallback: non-callback paths get 404; error/missing params reject with a browser-visible reason", async () => {
  const f = fakeCallbackServer();
  const p404 = waitForCallback({ createServerImpl: () => f.srv });
  assert.equal(f.fire("/evil?code=x&state=y").status, 404); // 其它路径一律 404

  const fErr = fakeCallbackServer();
  const pErr = waitForCallback({ createServerImpl: () => fErr.srv });
  const resErr = fErr.fire(`/callback?error=access_denied&error_description=nope`);
  assert.equal(resErr.status, 400);
  await assert.rejects(() => pErr, /authorization declined: access_denied/);
  assert.equal(fErr.s.closed, 1);

  const fMiss = fakeCallbackServer();
  const pMiss = waitForCallback({ createServerImpl: () => fMiss.srv });
  const resMiss = fMiss.fire("/callback?state=only");
  assert.equal(resMiss.status, 400);
  await assert.rejects(() => pMiss, /callback arrived without code\/state/);
  void p404; // 该 fake 无真实句柄，pending promise 无副作用
});

test("waitForCallback: server errors (port already in use) reject and close", async () => {
  const f = fakeCallbackServer();
  const p = waitForCallback({ createServerImpl: () => f.srv });
  f.s.onError(new Error("EADDRINUSE"));
  await assert.rejects(() => p, /EADDRINUSE/);
  assert.equal(f.s.closed, 1);
});

// ---- loginFlow ----

/** 确定性 rand：第 n 次调用返回 n 填充的 48 字节（PKCE 与 state 各取一次） */
function seqRand() {
  let n = 0;
  return () => Buffer.alloc(48, ++n);
}

/** listen 后在微任务里用 stateBox 中记录的 state 触发一次回调（模拟真实时序：
 * openBrowser 先执行，浏览器请求后到） */
function autoCallbackServer(stateBox, code = "code-9") {
  let handler = null;
  const srv = {
    once() {
      return srv;
    },
    on(evt, cb) {
      if (evt === "request") handler = cb;
      return srv;
    },
    close() {
      return srv;
    },
    listen() {
      queueMicrotask(() => {
        if (handler !== null) {
          handler({ url: `/callback?code=${code}&state=${encodeURIComponent(stateBox.v)}` }, { writeHead() { return this; }, end() { return this; } });
        }
      });
      return srv;
    },
  };
  return srv;
}

/** token 端点 fake：断言 form-encoded 载荷并返回给定 JSON */
function tokenEndpointFetch(responseBody, status = 200, capture = []) {
  return async (url, init = {}) => {
    assert.equal(String(url), CF_OAUTH.tokenUrl);
    assert.equal(init.method, "POST");
    assert.equal(init.headers["Content-Type"], "application/x-www-form-urlencoded");
    const body = new URLSearchParams(init.body);
    capture.push(Object.fromEntries(body.entries()));
    return new Response(JSON.stringify(responseBody), { status });
  };
}

test("loginFlow: PKCE + loopback callback + code exchange (happy path, all bodies asserted)", async () => {
  const rand = seqRand();
  const verifier = Buffer.alloc(48, 1).toString("base64url");
  const state = Buffer.alloc(48, 2).toString("base64url");
  const stateBox = { v: "" };
  const opened = [];
  const bodies = [];
  const result = await loginFlow({
    clientId: "cid-1",
    openBrowser: (url) => {
      opened.push(url);
      stateBox.v = new URL(url).searchParams.get("state");
    },
    fetchImpl: tokenEndpointFetch({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 }, 200, bodies),
    createServerImpl: () => autoCallbackServer(stateBox, "code-9"),
    rand,
  });
  // 浏览器拿到的是完整授权 URL（state/challenge 可从 URL 复原）
  assert.equal(opened.length, 1);
  const authUrl = new URL(opened[0]);
  assert.equal(authUrl.searchParams.get("state"), state);
  assert.equal(authUrl.searchParams.get("code_challenge"), createHash("sha256").update(verifier).digest("base64url"));
  assert.equal(authUrl.searchParams.get("client_id"), "cid-1");
  // token 端点载荷：authorization_code + code_verifier + client_id + redirect_uri
  assert.deepEqual(bodies, [
    {
      grant_type: "authorization_code",
      code: "code-9",
      code_verifier: verifier,
      client_id: "cid-1",
      redirect_uri: redirectUri(),
    },
  ]);
  assert.equal(result.accessToken, "at-1");
  assert.equal(result.refreshToken, "rt-1");
  assert.equal(result.state, state);
  assert.ok(Math.abs(result.expiresAt - (Date.now() + 3600_000)) < 5000, "expiresAt derived from expires_in");
});

test("loginFlow: callback with a mismatched state aborts (CSRF guard), token endpoint untouched", async () => {
  const stateBox = { v: "real-state" };
  const opened = [];
  await assert.rejects(
    () =>
      loginFlow({
        clientId: "cid-1",
        openBrowser: (url) => {
          opened.push(url);
        },
        fetchImpl: async () => {
          throw new Error("token endpoint must not be reached on state mismatch");
        },
        createServerImpl: () => {
          // 回调带回一个与授权 URL 不同的 state
          const evilBox = { v: "evil-state" };
          return autoCallbackServer(evilBox, "code-x");
        },
        rand: seqRand(),
      }),
    /oauth state mismatch/,
  );
  assert.equal(opened.length, 1);
});

test("loginFlow: token endpoint failure surfaces HTTP status + body excerpt; no access_token -> explicit error", async () => {
  const stateBox1 = { v: "" };
  const p1 = loginFlow({
    clientId: "cid-1",
    openBrowser: (url) => {
      stateBox1.v = new URL(url).searchParams.get("state");
    },
    fetchImpl: async () => new Response("invalid_grant detail", { status: 400 }),
    createServerImpl: () => autoCallbackServer(stateBox1),
    rand: seqRand(),
  });
  await assert.rejects(() => p1, (e) => {
    assert.match(e.message, /oauth token endpoint rejected the request \(HTTP 400\)/);
    assert.match(e.message, /invalid_grant detail/);
    return true;
  });

  // 2xx 但无 access_token：显式报错（不静默给 undefined）
  const stateBox2 = { v: "" };
  const p2 = loginFlow({
    clientId: "cid-1",
    openBrowser: (url) => {
      stateBox2.v = new URL(url).searchParams.get("state");
    },
    fetchImpl: async () => new Response(JSON.stringify({ nope: true }), { status: 200 }),
    createServerImpl: () => autoCallbackServer(stateBox2),
    rand: seqRand(),
  });
  await assert.rejects(() => p2, /returned no access_token/);
});

test("loginFlow: browser never completing rejects at the timeout AND releases the loopback listener (B4b)", async () => {
  const keepalive = setTimeout(() => {}, 10_000); // ref'd：未决的 race 不清空事件循环
  try {
    const f = fakeCallbackServer();
    await assert.rejects(
      () =>
        loginFlow({
          clientId: "cid-1",
          openBrowser: () => {},
          fetchImpl: async () => {
            throw new Error("unreachable");
          },
          createServerImpl: () => f.srv, // listen 后永不触发回调
          rand: seqRand(),
          timeoutMs: 300,
        }),
      /browser login did not complete within 0s/,
    );
    // 端口 18971 的监听必须随超时关停——不再留下卡死的 loopback server
    assert.equal(f.s.closed, 1, "timeout must close the callback server");
  } finally {
    clearTimeout(keepalive);
  }
});

test("waitForCallback: an aborted signal closes the server and rejects with the abort reason (B4b)", async () => {
  const controller = new AbortController();
  const f = fakeCallbackServer();
  const p = waitForCallback({ createServerImpl: () => f.srv, signal: controller.signal });
  controller.abort(new Error("login timed out (test)"));
  await assert.rejects(() => p, /login timed out \(test\)/);
  assert.equal(f.s.closed, 1);

  // 已中止的 signal：不监听直接拒绝
  const fPre = fakeCallbackServer();
  await assert.rejects(
    () => waitForCallback({ createServerImpl: () => fPre.srv, signal: AbortSignal.abort(new Error("pre-aborted")) }),
    /pre-aborted/,
  );
  assert.equal(fPre.s.closed, 1);
  assert.deepEqual(fPre.s.listen, null, "must not bind after a pre-aborted signal");
});

test("refreshAccessToken: grant_type=refresh_token payload; rotation passthrough", async () => {
  const bodies = [];
  const r = await refreshAccessToken({
    refreshToken: "rt-0",
    clientId: "cid-1",
    fetchImpl: tokenEndpointFetch({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 }, 200, bodies),
  });
  assert.deepEqual(bodies, [{ grant_type: "refresh_token", refresh_token: "rt-0", client_id: "cid-1" }]);
  assert.equal(r.accessToken, "at-2");
  assert.equal(r.refreshToken, "rt-2");
  assert.ok(r.expiresAt > Date.now());
});

// ---- getApiToken 决策矩阵 ----

test("getApiToken: env API token wins without touching stored state or network", async () => {
  const token = await getApiToken("/nope", {
    env: { CLOUDFLARE_API_TOKEN: "  env-tok  " },
    stored: { refreshToken: "rt", clientId: "cid" },
    fetchImpl: async () => {
      throw new Error("network must not be reached when env token present");
    },
  });
  assert.equal(token, "env-tok");
});

test("getApiToken: no stored session -> null; a stored session ALWAYS refreshes (no disk access-token shortcut, B4a)", async () => {
  assert.equal(await getApiToken("/nope", { env: {}, stored: null }), null);
  const bodies = [];
  const token = await getApiToken("/nope", {
    env: {},
    stored: { refreshToken: "rt", clientId: "cid" },
    fetchImpl: tokenEndpointFetch({ access_token: "at-fresh" }, 200, bodies),
    persist: async () => {},
  });
  assert.equal(token, "at-fresh");
  assert.deepEqual(bodies, [{ grant_type: "refresh_token", refresh_token: "rt", client_id: "cid" }]);
});

test("getApiToken: expired token silently refreshes; rotation is persisted (next refresh token kept)", async () => {
  const bodies = [];
  const persisted = [];
  const token = await getApiToken("/nope", {
    env: {},
    stored: { refreshToken: "rt-old", clientId: "cid-1" },
    fetchImpl: tokenEndpointFetch({ access_token: "at-new", refresh_token: "rt-new", expires_in: 3600 }, 200, bodies),
    persist: async (a) => persisted.push(a),
  });
  assert.equal(token, "at-new");
  assert.deepEqual(bodies, [{ grant_type: "refresh_token", refresh_token: "rt-old", client_id: "cid-1" }]);
  assert.equal(persisted.length, 1);
  // B4a：持久化对象恰好 {refreshToken, clientId}——access token 绝不落盘
  assert.deepEqual(persisted[0], { refreshToken: "rt-new", clientId: "cid-1" });
});

test("getApiToken: refresh without rotation keeps the old refresh token; refresh failure -> null (not an error)", async () => {
  const persisted = [];
  const token = await getApiToken("/nope", {
    env: {},
    stored: { refreshToken: "rt-keep", clientId: "cid" },
    fetchImpl: tokenEndpointFetch({ access_token: "at-2" }, 200), // 无新 refresh_token
    persist: async (a) => persisted.push(a),
  });
  assert.equal(token, "at-2");
  assert.deepEqual(persisted[0], { refreshToken: "rt-keep", clientId: "cid" });

  assert.equal(
    await getApiToken("/nope", {
      env: {},
      stored: { refreshToken: "revoked", clientId: "cid" },
      fetchImpl: async () => new Response("invalid_grant", { status: 400 }),
      persist: async () => {
        throw new Error("must not persist a failed refresh");
      },
    }),
    null,
  );
});

test("getApiToken: dry-run callers pass a no-op persist - refresh happens, nothing is written (B7)", async () => {
  const bodies = [];
  const token = await getApiToken("/nope", {
    env: {},
    stored: { refreshToken: "rt-old", clientId: "cid-1" },
    fetchImpl: tokenEndpointFetch({ access_token: "at-dry", refresh_token: "rt-new" }, 200, bodies),
    persist: async () => {}, // no-op：dry-run 调用方（cli/index/tui）的形态
  });
  assert.equal(token, "at-dry");
  assert.equal(bodies.length, 1, "the refresh (network read) still happens");
});
