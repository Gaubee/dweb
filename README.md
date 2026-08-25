# dweb

应用级组网平台（dweb-cloud）：让多设备应用组成逻辑网络（类似游戏房间，不是系统级 VPN），支持受控邀请他人加入；P2P 直连优先，回退到可自托管的 Relay。

```text
身份层   Ed25519 EndpointId（稳定身份，与网络地址解耦）
名册层   Roster = 签名事实（Grant/Join/Revoke）union-merge 收敛
会话层   iroh 1.x：QUIC 直连 + NAT 穿透 + 自托管 relay 回退，连接门控
同步层   不透明 envelope 双向收发（v0.2 接入 Automerge 适配器）
```

## 仓库布局

- `crates/dweb-fabric` — 组网 kernel（Rust lib）
- `crates/dweb-server` — 自托管服务端：iroh-relay + rendezvous（Rust bin）
- `packages/client-sdk` — `@dweb/client-sdk`（napi-rs，darwin-arm64）
- `packages/example` — `@dweb/example` 双进程组网示例
- `packages/server-binary` — `@dweb/server-binary` 服务端 npm 包装
- `docker/` — ghcr.io/gaubee/dweb 镜像

## 快速开始

（实现中——见 openspec/changes/fabric-mvp）

## 研发流程

OpenSpec 驱动：所有变更先落 `openspec/changes/`，规格与任务驱动实现。网络磁盘仓库：Rust 编译产物固定走本地 `CARGO_TARGET_DIR`。
