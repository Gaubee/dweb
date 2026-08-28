# sdk/node Specification

## Purpose
定义 `@jixo/opendweb-client-sdk` npm 包面向 Node 应用的 API 契约：Fabric 生命周期、身份与名册操作、会话与事件。SDK 是 Rust kernel 的 napi-rs 绑定，公共 API 必须类型完备。

## Requirements

### Requirement: Fabric 生命周期

SDK SHALL 提供 Fabric 类：以异步工厂构造（createRoot/open/attach/joinWithToken，接受选项对象——数据目录、relay 配置等）完成初始化并返回实例，`shutdown()` 异步释放网络资源并保证幂等（重复调用不报错）。

#### Scenario: 工厂构造获得身份

- **WHEN** 以空数据目录调用 Fabric.createRoot 完成构造
- **THEN** `endpointId` 属性返回稳定的身份字符串

#### Scenario: 重复 shutdown 幂等

- **WHEN** 连续调用 shutdown 两次
- **THEN** 两次均正常返回，不抛出异常

### Requirement: 名册操作

SDK SHALL 提供 `invite()` 返回邀请令牌字符串、`join(token)` 兑换令牌加入网络、`members()` 返回当前有效成员投影（含 EndpointId 与显示名）、`revoke(endpointId)` 签发撤销。`invite()` SHALL 接受可选第三参 `{ allowRelayless?: boolean }` 透传内核签发安全门逃生阀；无 relay 且无显式直连地址时 `invite()` SHALL 以 `InviteWithoutRelay` 语义的错误 reject（而非产出不可达令牌）。构造选项 SHALL 新增：`advertiseAddrs`（字符串数组，逐项校验 ip:port，非法项构造报错）、`httpProxy`（`"none" | "from-env" | { url: string }`，缺省 `"none"`，映射内核 iroh endpoint 代理配置）、`joinTimeoutMs`（数值，缺省 30000，值域 1000 至 600000，越界构造报错）；relay 配置的 `mode` SHALL 为字面量联合 `"disabled" | "custom" | "n0"`。join 失败的错误 SHALL 以 `[<kebab-code>]` 消息前缀标识稳定错误码（token-invalid/token-expired/wrong-fabric/no-reachable-path/relay-offline/dial-failed/dial-timeout/token-consumed），目录归属不匹配的前缀为 `[wrong-fabric]`，供 JS 侧设置 `err.code`。豁免的本地数据面错误（目录缺身份、名册真损坏、名册读写 IO）SHALL 同样以 kebab 前缀透出（missing-identity/corrupted/roster-io），JS 侧派生同名 SCREAMING_SNAKE code。主规格既有 `start()/stop()` 生命周期措辞与现实现（工厂构造 + `shutdown()`）的历史差异由 C0.3 勘误统一为后者。

#### Scenario: API 完整往返

- **WHEN** 使用 SDK 的 invite/join/members/revoke 完整流程
- **THEN** 各方法按 fabric/roster 规格定义的语义生效

#### Scenario: 无 relay 拒签透出

- **WHEN** relay 未配置时调用 `invite(ttl, null)`（无 allowRelayless）
- **THEN** Promise 以 InviteWithoutRelay 语义的错误 reject

#### Scenario: join 错误码前缀

- **WHEN** 以空路径令牌调用 `joinWithToken`
- **THEN** reject 的错误消息以 `[no-reachable-path]` 前缀标识

### Requirement: 会话与事件

SDK SHALL 提供事件订阅覆盖 peer 连接/断开、名册更新与消息收发，并新增 `relay-online`/`relay-offline` 事件——事件对象为判别联合，relay 事件 SHALL **必携带**快照同构 payload（mode、urls、online、lastError；禁用模式不产生）。`on(cb)` SHALL 返回取消订阅函数。SDK SHALL 提供 `relayStatus()` 快照：`{ mode: "disabled"|"custom"|"n0", urls: string[], online: boolean | null, lastError: string | null }`——`online` 在 relay 禁用模式 SHALL 为 `null`（而非 false）；`lastError` 为脱敏的最近连接错误类别（不含 URL 凭证段）。消费方 SHALL 以快照为初始事实、事件承载后续跳变（文档明示，避免初始事件竞态）。

#### Scenario: 事件订阅生效

- **WHEN** 注册消息事件回调后对端发来字节
- **THEN** 回调被调用且携带发送者 EndpointId 与原始字节

#### Scenario: 事件取消订阅

- **WHEN** 调用 `on()` 返回的取消函数后对端再次发来字节
- **THEN** 已注销的回调不再被调用

#### Scenario: relay 事件订阅

- **WHEN** 订阅事件后 relay 状态发生跳变
- **THEN** relay-online/relay-offline 事件按序送达回调，且每个 relay 事件必携带快照同构 payload

#### Scenario: 代理 URL 非法拒绝

- **WHEN** 以 `httpProxy: { url: "not a url" }` 构造 Fabric
- **THEN** 构造期以 `[bad-proxy-url]` 前缀 reject

#### Scenario: custom 空 urls 拒绝

- **WHEN** 以 `{ mode: "custom", urls: [] }` 构造 Fabric
- **THEN** 构造期 reject（提示至少一个 relay URL），不进入运行

#### Scenario: join 超时配置

- **WHEN** 以 `joinTimeoutMs: 1000` 构造并 join 一个 issuer 离线的 fabric
- **THEN** 约 1 秒后以 `[dial-timeout]` 前缀错误 reject；以 `joinTimeoutMs: 500` 构造则直接构造报错（值域）

#### Scenario: relay 状态查询

- **WHEN** 配置自托管 relay 且可达时调用 `relayStatus()`
- **THEN** 返回 `mode: "custom"`、实际 URL 列表与 `online: true`

#### Scenario: n0 模式的 relay 状态

- **WHEN** relay 配置为 n0 模式时调用 `relayStatus()`
- **THEN** 返回 `mode: "n0"`、`urls: ["https://relay.iroh.network"]`、online 为实际连接状态

#### Scenario: 禁用模式的 relay 状态

- **WHEN** relay 禁用模式下调用 `relayStatus()`
- **THEN** `online` 为 `null`，不产生 relay 事件

### Requirement: 类型完备与平台约束

包 MUST 附带 TypeScript 类型定义，公共 API 不得出现 `any`。v0.1 仅提供 darwin-arm64 原生二进制；在不支持的平台加载时 MUST 抛出明确指明平台约束的错误，而不是模糊的动态链接失败。

#### Scenario: 不支持平台

- **WHEN** 在非 darwin-arm64 平台 require 该包
- **THEN** 抛出内容包含平台支持说明的错误

### Requirement: server-binary 包

`@jixo/opendweb-server-binary` SHALL 包装服务端二进制：安装后在支持的平台上可经 Node API 或 bin 脚本以配置启动服务进程，并暴露停止方式。v0.1 仅 darwin-arm64。

#### Scenario: 启动服务进程

- **WHEN** 调用包提供的方式启动服务端并查询健康检查端点
- **THEN** 健康检查返回成功
