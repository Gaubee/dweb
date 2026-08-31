// Cloudflare 认证（1.0.0 双方案）：方案 A = OAuth Authorization Code + PKCE(S256)
// + loopback 回调（官方 self-managed OAuth clients，2026-06 起）；方案 B =
// CLOUDFLARE_API_TOKEN 环境变量兜底。refresh token 持久化于
// ~/.opendweb/cf-auth.json（0600），access token 仅内存使用、过期静默刷新。
//
// 显式风险关卡（proposal 已登记）：wrangler workers-auth 的 scope 子集无
// cfd_tunnel 管理/写 scope；平台全量 scope 是否覆盖待 Owner 在 dashboard 建
// client 时实测。SCOPES 常量为实测后的落点——若不覆盖 tunnel 写，login 能力
// 面降级为发现/只读，tunnel 写操作回落 API token（tui/cli 按能力提示）。
import { createServer, type Server } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import path from "node:path";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import type { FetchLike } from "./cf-api.js";

export const CF_OAUTH = {
  authorizeUrl: "https://dash.cloudflare.com/oauth2/auth",
  tokenUrl: "https://dash.cloudflare.com/oauth2/token",
  /** Owner public client（创建并完成 tweb.xin TXT 域名验证后填入；空 = 未配置） */
  builtinClientId: "",
  /** 回调监听端口（OAuth client 的 redirect_uri 精确匹配注册值，不可随机） */
  callbackPort: 18971,
  redirectPath: "/callback",
  /** 登录等待用户在浏览器完成授权的截止（毫秒） */
  loginTimeoutMs: 5 * 60 * 1000,
  /**
   * 请求的 scope。identity 基础 + 发现类已确认存在（wrangler 先例）；
   * tunnel/DNS 写 scope 字符串待 dashboard 实测填入（见文件头注）。
   */
  SCOPES: [
    "offline_access",
    "account:read",
    "zone:read",
    // 实测占位：Tunnel 写 / DNS 写 的平台 scope 字符串
    // "cloudflare_tunnel:write", "dns_records:write",
  ],
} as const;

export function redirectUri(): string {
  return `http://127.0.0.1:${CF_OAUTH.callbackPort}${CF_OAUTH.redirectPath}`;
}

/** 客户端 id 解析：显式 env/参数 > 内置 public client；都无 → null（引导自建） */
export function resolveClientId(explicit?: string, env?: Record<string, string | undefined>): string | null {
  const fromEnv = env?.CF_OAUTH_CLIENT_ID?.trim();
  if (fromEnv) return fromEnv;
  if (explicit && explicit.trim() !== "") return explicit.trim();
  return CF_OAUTH.builtinClientId === "" ? null : CF_OAUTH.builtinClientId;
}

export interface StoredAuth {
  refreshToken: string;
  clientId: string;
  /** 相对 epoch 毫秒；access token 缓存（内存语义，文件里可为陈旧值） */
  accessToken?: string;
  expiresAt?: number;
}

export function authFilePath(home: string): string {
  return path.join(home, "cf-auth.json");
}

export async function loadStoredAuth(
  home: string,
  readFileImpl: (p: string) => Promise<string> = (p) => readFile(p, "utf8"),
): Promise<StoredAuth | null> {
  try {
    const raw = await readFileImpl(authFilePath(home));
    const parsed = JSON.parse(raw) as StoredAuth;
    if (typeof parsed?.refreshToken !== "string" || typeof parsed?.clientId !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveStoredAuth(
  home: string,
  auth: StoredAuth,
  io: { writeFile?: (p: string, c: string) => Promise<void>; mkdir?: (p: string) => Promise<void>; chmod?: (p: string, m: number) => Promise<void> } = {},
): Promise<void> {
  const file = authFilePath(home);
  const w = io.writeFile ?? ((p, c) => writeFile(p, c, "utf8"));
  await (io.mkdir ?? ((p) => mkdir(p, { recursive: true })))(home);
  await w(file, `${JSON.stringify(auth, null, 2)}\n`);
  await (io.chmod ?? ((p, m) => chmod(p, m)))(file, 0o600);
}

export async function clearStoredAuth(home: string, rm: (p: string) => Promise<void>): Promise<void> {
  await rm(authFilePath(home)).catch(() => {});
}

// ---- PKCE ----

export function makePkcePair(rand: () => Buffer = () => randomBytes(48)): { verifier: string; challenge: string } {
  const verifier = rand().toString("base64url").slice(0, 128); // RFC 7636: 43-128
  if (verifier.length < 43) throw new Error("PKCE verifier too short");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function makeState(rand: () => Buffer = () => randomBytes(24)): string {
  return rand().toString("base64url");
}

// ---- 授权 URL ----

export function buildAuthorizeUrl(opts: { clientId: string; state: string; challenge: string; scopes?: readonly string[] }): string {
  const qs = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: redirectUri(),
    scope: [...(opts.scopes ?? CF_OAUTH.SCOPES)].join(" "),
    state: opts.state,
    code_challenge: opts.challenge,
    code_challenge_method: "S256",
  });
  return `${CF_OAUTH.authorizeUrl}?${qs.toString()}`;
}

// ---- loopback 回调服务 ----

export interface CallbackResult {
  code: string;
  state: string;
}

/**
 * 在 127.0.0.1:callbackPort 起一次性 HTTP 服务接收 ?code=&state=；state 不匹配
 * 或缺少 code 返回 400（浏览器侧可见原因），匹配即 200 并停机。
 */
type ServerLike = Pick<Server, "once" | "on" | "close" | "listen">;

export async function waitForCallback(
  deps: { createServerImpl?: () => ServerLike } = {},
): Promise<CallbackResult> {
  const srv: ServerLike = (deps.createServerImpl ?? (() => createServer() as unknown as ServerLike))();
  return new Promise<CallbackResult>((resolve, reject) => {
    const fail = (e: Error) => {
      srv.close();
      reject(e);
    };
    srv.once("error", fail);
    srv.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== CF_OAUTH.redirectPath) {
        res.writeHead(404).end("not found");
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const err = url.searchParams.get("error");
      if (err) {
        res.writeHead(400).end(`authorization declined: ${err}`);
        fail(new Error(`authorization declined: ${err}`));
        return;
      }
      if (!code || !state) {
        res.writeHead(400).end("missing code/state");
        fail(new Error("callback arrived without code/state"));
        return;
      }
      res.writeHead(200).end("authorization received - you can close this tab and return to the terminal");
      srv.close();
      resolve({ code, state });
    });
    srv.listen(CF_OAUTH.callbackPort, "127.0.0.1");
  });
}

// ---- token 端点 ----

export interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

async function postToken(
  body: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<TokenResponse> {
  const res = await fetchImpl(CF_OAUTH.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`oauth token endpoint rejected the request (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  const parsed = JSON.parse(text) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (typeof parsed.access_token !== "string" || parsed.access_token === "") {
    throw new Error(`oauth token endpoint returned no access_token: ${text.slice(0, 300)}`);
  }
  return {
    accessToken: parsed.access_token,
    ...(parsed.refresh_token !== undefined ? { refreshToken: parsed.refresh_token } : {}),
    ...(typeof parsed.expires_in === "number" ? { expiresAt: Date.now() + parsed.expires_in * 1000 } : {}),
  };
}

/** 完整登录流：PKCE + loopback 回调 + code 换 token（含新 refresh token） */
export async function loginFlow(opts: {
  clientId: string;
  openBrowser: (url: string) => void;
  fetchImpl?: FetchLike;
  createServerImpl?: typeof createServer;
  rand?: () => Buffer;
  timeoutMs?: number;
}): Promise<TokenResponse & { state: string }> {
  const rand = opts.rand ?? (() => randomBytes(48));
  const { verifier, challenge } = makePkcePair(rand);
  const state = makeState(rand);
  const authorizeUrl = buildAuthorizeUrl({ clientId: opts.clientId, state, challenge });
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? CF_OAUTH.loginTimeoutMs;

  const callbackP = waitForCallback(opts.createServerImpl !== undefined ? { createServerImpl: opts.createServerImpl } : {});
  // 端口被占（上一次未完成登录的残留监听等）在 listen 阶段即抛出，先于浏览器
  opts.openBrowser(authorizeUrl);
  const callback = await Promise.race([
    callbackP,
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`browser login did not complete within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      if (typeof t === "object" && "unref" in t) (t as { unref(): void }).unref();
    }),
  ]).catch(async (e: Error) => {
    void callbackP.catch(() => {}); // 避免未处理拒绝
    throw e;
  });
  if (callback.state !== state) {
    throw new Error("oauth state mismatch (possible CSRF - aborting)");
  }
  const tokens = await postToken(
    {
      grant_type: "authorization_code",
      code: callback.code,
      code_verifier: verifier,
      client_id: opts.clientId,
      redirect_uri: redirectUri(),
    },
    fetchImpl,
  );
  return { ...tokens, state };
}

/** refresh token 换新 access token（rotation：响应可携带新 refresh token） */
export async function refreshAccessToken(opts: {
  refreshToken: string;
  clientId: string;
  fetchImpl?: FetchLike;
}): Promise<TokenResponse> {
  return postToken(
    {
      grant_type: "refresh_token",
      refresh_token: opts.refreshToken,
      client_id: opts.clientId,
    },
    opts.fetchImpl ?? fetch,
  );
}

/**
 * 取得可用的 API bearer：显式 API token env 优先（方案 B），否则用持久化
 * 登录态（静默 refresh，回写新 token 缓存）。都不可用时返回 null（调用方
 * 引导 login 或设置 env）。
 */
export async function getApiToken(home: string, opts: {
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  stored?: StoredAuth | null;
  persist?: (auth: StoredAuth) => Promise<void>;
}): Promise<string | null> {
  const envToken = opts.env?.CLOUDFLARE_API_TOKEN?.trim();
  if (envToken) return envToken;
  const stored = opts.stored ?? (await loadStoredAuth(home));
  if (stored === null) return null;
  if (stored.accessToken !== undefined && stored.expiresAt !== undefined && stored.expiresAt > Date.now() + 30_000) {
    return stored.accessToken;
  }
  try {
    const refreshed = await refreshAccessToken({
      refreshToken: stored.refreshToken,
      clientId: stored.clientId,
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    });
    const next: StoredAuth = {
      refreshToken: refreshed.refreshToken ?? stored.refreshToken,
      clientId: stored.clientId,
      accessToken: refreshed.accessToken,
      ...(refreshed.expiresAt !== undefined ? { expiresAt: refreshed.expiresAt } : {}),
    };
    await (opts.persist ?? ((a) => saveStoredAuth(home, a)))(next);
    return next.accessToken ?? refreshed.accessToken;
  } catch {
    // refresh 失败（吊销/网络）：视为未登录，由调用方引导重新 login
    return null;
  }
}
