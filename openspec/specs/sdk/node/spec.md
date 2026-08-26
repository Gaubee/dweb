# sdk/node Specification

## Purpose
定义 `@dweb/client-sdk` npm 包面向 Node 应用的 API 契约：Fabric 生命周期、身份与名册操作、会话与事件。SDK 是 Rust kernel 的 napi-rs 绑定，公共 API 必须类型完备。

## Requirements

### Requirement: Fabric 生命周期

SDK SHALL 提供 Fabric 类：构造时接受选项对象（数据目录、relay 配置、日志级别等），提供 `start()` 异步完成初始化并返回自身信息，`stop()` 异步释放网络资源并保证幂等（重复 stop 不报错）。

#### Scenario: 启动获得身份

- **WHEN** 以空数据目录构造 Fabric 并 start
- **THEN** `endpointId` 属性返回稳定的身份字符串

#### Scenario: 重复 stop 幂等

- **WHEN** 连续调用 stop 两次
- **THEN** 两次均正常返回，不抛出异常

### Requirement: 名册操作

SDK SHALL 提供 `invite()` 返回邀请令牌字符串、`join(token)` 兑换令牌加入网络、`members()` 返回当前有效成员投影（含 EndpointId 与显示名）、`revoke(endpointId)` 签发撤销。

#### Scenario: API 完整往返

- **WHEN** 使用 SDK 的 invite/join/members/revoke 完整流程
- **THEN** 各方法按 fabric/roster 规格定义的语义生效

### Requirement: 会话与事件

SDK SHALL 提供 `connect(endpointId)`、`disconnect(endpointId)`、`send(endpointId, bytes)`，以及事件注册接口，至少覆盖：收到消息（含发送者与字节）、成员上下线、名册更新、对端路径变化。

#### Scenario: 事件订阅生效

- **WHEN** 注册消息事件回调后对端发来字节
- **THEN** 回调被调用且携带发送者 EndpointId 与原始字节

### Requirement: 类型完备与平台约束

包 MUST 附带 TypeScript 类型定义，公共 API 不得出现 `any`。v0.1 仅提供 darwin-arm64 原生二进制；在不支持的平台加载时 MUST 抛出明确指明平台约束的错误，而不是模糊的动态链接失败。

#### Scenario: 不支持平台

- **WHEN** 在非 darwin-arm64 平台 require 该包
- **THEN** 抛出内容包含平台支持说明的错误

### Requirement: server-binary 包

`@dweb/server-binary` SHALL 包装服务端二进制：安装后在支持的平台上可经 Node API 或 bin 脚本以配置启动服务进程，并暴露停止方式。v0.1 仅 darwin-arm64。

#### Scenario: 启动服务进程

- **WHEN** 调用包提供的方式启动服务端并查询健康检查端点
- **THEN** 健康检查返回成功
