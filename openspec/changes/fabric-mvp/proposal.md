# fabric-mvp

## Why

dweb 的愿景是应用级组网：开发者的多设备应用组成一个逻辑网络（类似游戏房间，而非系统级 VPN），并支持受控邀请他人加入。前期调研（`open2fa/tasks/dweb-cloud-v1/research/p2p-fabric-technology-survey.md`）确认：传输/发现/打洞/自托管 Relay 均有成熟原子（iroh 1.0 覆盖原生侧几乎全部需求），但"受控邀请他人进入我的网"没有任何现成方案——这层必须自建，且可以做成薄层（签名名册 + 连接门控）。本次 change 交付第一个可运行、可分发、可验证的 MVP，验证整条技术路线。

## What Changes

- 新增 Rust workspace：`crates/dweb-fabric`（组网 kernel 库：身份、签名名册、iroh 传输、连接门控、不透明消息收发）与 `crates/dweb-server`（自托管服务端二进制：iroh-relay + rendezvous 登记/解析 HTTP API）。
- 新增 npm 包 `@dweb/client-sdk`：napi-rs 绑定 fabric kernel，v0.1 仅编译 darwin-arm64。
- 新增 npm 包 `@dweb/example`：使用 client-sdk 的示例应用（双进程组网 + 邀请 + 聊天式消息收发的端到端验证载体）。
- 新增 npm 包 `@dweb/server-binary`：包装 darwin-arm64 服务端二进制。
- 新增 docker 交付物并发布到 `ghcr.io/gaubee/dweb`。
- 交付物约束：仓库位于网络磁盘，Rust 编译使用本地 `CARGO_TARGET_DIR`；无原生 UDP 能力的环境（浏览器/CF Worker）不在 v0.1 范围。

## Capabilities

### New Capabilities

- `fabric/identity`: 节点密码学身份——Ed25519 keypair、EndpointId 派生与展示、密钥持久化（文件）。
- `fabric/roster`: 受控成员关系——签名事实（Membership Grant / Member Join / Revocation）、邀请令牌的签发与兑换、union-merge 收敛、撤销前向生效。
- `fabric/session`: 会话承载——基于 iroh 的 P2P 直连与 relay 回退、连接门控（仅与名册投影中的成员建连）、不透明二进制 envelope 双向收发。
- `server`: 自托管服务端——iroh-relay（Docker 镜像 + 二进制）与 rendezvous 登记/解析 API 的行为契约。
- `sdk/node`: `@dweb/client-sdk` 的 npm API 面——Fabric 类生命周期、事件回调、TypeScript 类型契约。
- `example-app`: 示例应用的可观察行为——两个进程通过 EndpointId/邀请令牌组网并交换消息。

### Modified Capabilities

（无——首个 change，全部为新增。）

## Impact

- 全新代码库（`/Volumes/dweb`，git remote `github.com/Gaubee/dweb`），无存量代码受影响。
- 引入重依赖：iroh 1.x（QUIC、打洞、relay）、iroh-relay（服务端）、axum（rendezvous API）、napi-rs（绑定）。
- 发布物：ghcr.io Docker 镜像 `gaubee/dweb`；npm 包仅本地 workspace 构建（不发布 registry）。
- 网络磁盘编译性能约束：CI 与本地均需本地 target 缓存目录。
