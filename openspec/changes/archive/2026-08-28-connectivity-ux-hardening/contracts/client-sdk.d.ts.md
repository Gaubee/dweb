# C0.1 — client-sdk 目标 d.ts 契约（Batch C0，ZCode 冻结）

> 本文件是 v0.2 SDK 公共面的**权威契约**。Batch F 按此实现（napi 层 + 手写修正），
> Batch E 按此编码（开发期无需 F 的二进制）。与当前生成物（packages/client-sdk/index.d.ts）
> 的差异全部标注 `// [NEW]` 或 `// [CHANGED]`；未标注处逐字保持现状语义。

```ts
/** 事件判别联合：relay-* 事件必携带完整快照 payload（非可选） */
export type FabricEventJs =
  | {
      type: 'peer-connected' | 'peer-disconnected'
      endpointId: string
    }
  | { type: 'roster-updated' }
  | { type: 'message'; from: string; data: Buffer }
  | { type: 'path-changed'; endpointId: string; status: 'direct' | 'relay' | 'unknown' }
  | { type: 'relay-online' | 'relay-offline'; relay: RelayStatusJs } // [NEW]

/** [NEW] relay 状态快照（relayStatus() 返回值与 relay-* 事件 payload 同构） */
export interface RelayStatusJs {
  /** 字面量联合（非 string） */
  mode: 'disabled' | 'custom' | 'n0'
  /** 配置的 relay URL 列表（disabled 为空数组；n0 恒为 ["https://relay.iroh.network"]） */
  urls: string[]
  /** null <=> mode === "disabled"；否则为任一 relay 已连接 */
  online: boolean | null
  /** 最近一次连接错误类别（脱敏：无凭证段；无错误为 null） */
  lastError: string | null
}

export declare class Fabric {
  static createRoot(opts: FabricOptions, secret?: SecretSeedHandle | undefined | null): Promise<Fabric>
  static open(opts: FabricOptions, secret?: SecretSeedHandle | undefined | null): Promise<Fabric>
  static attach(opts: FabricOptions, fabricIdHex: string, secret?: SecretSeedHandle | undefined | null): Promise<Fabric>
  static joinWithToken(opts: FabricOptions, token: string, secret?: SecretSeedHandle | undefined | null): Promise<Fabric>
  get endpointId(): string
  fabricIdHex(): Promise<string>
  members(): Promise<Array<Member>>
  isMember(endpointId: string): Promise<boolean>

  /** [CHANGED] 第三参 opts 透传签发安全门逃生阀。
   *  relay 为空且 advertiseAddrs 为空时：无 opts 或 allowRelayless!==true =>
   *  reject，错误消息前缀 [invite-without-relay]。 */
  invite(
    ttlMs: number,
    recipient?: string | undefined | null,
    opts?: InviteOptions | undefined | null,
  ): Promise<string>

  join(token: string): Promise<void>
  connect(endpointId: string): Promise<void>
  disconnect(endpointId: string): Promise<void>
  send(endpointId: string, data: Buffer): Promise<void>
  revoke(endpointId: string): Promise<void>
  setDisplayName(name: string): Promise<void>
  linkStatus(endpointId: string): Promise<string>
  exportSecretPassphrase(passphrase: string): Promise<string>

  /** [NEW] relay 状态快照。快照优先于事件：初始事实一律先查本方法。 */
  relayStatus(): Promise<RelayStatusJs>

  /** [CHANGED] 返回取消订阅函数；既有回调注册语义不变（多回调并存）。 */
  on(callback: (event: FabricEventJs) => void): () => void

  shutdown(): Promise<void>
}

/** [NEW] invite 逃生阀选项 */
export interface InviteOptions {
  /** 允许签发无 relay 令牌；调用方自担可达性责任（须自行保证带外可达路径，
   *  不要求 advertiseAddrs 非空——两者独立）。 */
  allowRelayless?: boolean
}

export declare class SecretSeedHandle {
  get endpointId(): string
  get available(): boolean
}

export interface FabricOptions {
  dataDir: string
  relay?: RelayOptions
  /** [CHANGED] 逐项校验 ip:port 或 [ipv6]:port；空串/不可解析 => 构造 reject */
  advertiseAddrs?: Array<string>
  /** [NEW] HTTP 控制面（relay 连接）代理所有权；缺省 "none"。
   *  iroh endpoint 不读进程环境变量；QUIC 数据面永不经代理。 */
  httpProxy?: HttpProxyOptions
  /** [NEW] join 总时限（毫秒）；缺省 30000；值域 [1000, 600000] */
  joinTimeoutMs?: number
}

/** [NEW] */
export type HttpProxyOptions = 'none' | 'from-env' | { url: string }

/** [CHANGED] 判别联合：非法组合在构造期拒绝，而非静默归一化 */
export type RelayOptions =
  | { mode?: 'n0' }                      // 缺省
  | { mode: 'disabled' }                 // 不接受 urls
  | { mode: 'custom'; urls: [string, ...string[]] } // 至少一个（空数组构造 reject）

export interface Member {
  endpointId: string
  displayName?: string
  sinceMs: number
}

export declare function importSecret(token: string, passphrase: string): Promise<SecretSeedHandle>
export declare function nativeVersion(): string
```

## 错误码约定（与 error-matrix.md 一致）

napi Error 无自定义 code 通道：**错误消息以 `[<kebab-code>]` 前缀标识**，JS 层（example 与
下游产品）以前缀解析设置 `err.code = <SCREAMING_SNAKE>`。冻结前缀集合（join 8 码 + invite 1 码 + 豁免 3 码）：

| 消息前缀 | err.code（JS 侧派生） | 场景 |
| --- | --- | --- |
| `[invite-without-relay]` | INVITE_WITHOUT_RELAY | invite 安全门拒签 |
| `[wrong-fabric]` | WRONG_FABRIC | 目录归属不匹配（DirFabricMismatch） |
| `[token-invalid]` | TOKEN_INVALID | 令牌解码/签名/版本失败 |
| `[token-expired]` | TOKEN_EXPIRED | 令牌过期 |
| `[token-consumed]` | TOKEN_CONSUMED | invite_id 已消费 |
| `[no-reachable-path]` | NO_REACHABLE_PATH | 令牌无 relay 且无直连地址（拨号前） |
| `[relay-offline]` | RELAY_OFFLINE | connect 立即错误 + 探针适用（无直连地址、策略 none）且失败 |
| `[dial-failed]` | DIAL_FAILED | join 拨号立即失败（非 relay 归因、非超时）与 redeem 非结构化失败 |
| `[dial-timeout]` | DIAL_TIMEOUT | join 超时（relay 在线时附注 issuer likely offline） |
| `[missing-identity]` | MISSING_IDENTITY | 豁免：目录缺身份（原生变体透出，非 8 码） |
| `[corrupted]` | CORRUPTED | 豁免：名册真损坏（原生变体透出，非 8 码） |
| `[roster-io]` | ROSTER_IO | 豁免：名册读写 IO（原生变体透出，非 8 码） |
| `[bad-proxy-url]` | BAD_PROXY_URL | **稳定附加码**：`httpProxy: { url }` 形态的 URL 解析失败（构造期 reject；仅 SDK 使用——CLI 不暴露 url 形态） |

## 实现注记（Batch F）

- `on()` 返回取消订阅：用现有 `event_callbacks` Vec 的移除句柄（注册时分配 id）实现；
- `RelayStatusJs.lastError` 脱敏规则：仅错误类别（如 `connect timeout`、`tls error`）+ host，剥除 URL userinfo 与完整路径；
- `httpProxy: { url }` 解析失败 => 构造 reject（`[bad-proxy-url]` 前缀，已列入冻结集合）；
- `joinTimeoutMs` 越界 => 构造 reject（消息指明值域）。
