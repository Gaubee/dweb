# fabric-mvp — Tasks

> 执行约束：所有 cargo 命令必须设置 `CARGO_TARGET_DIR=$HOME/.cargo-target/dweb`。
> 共享文件（根 package.json、pnpm-workspace.yaml、Cargo.toml、.gitignore、package.json5 等）由主会话统一落盘，子代理不得修改。

## 1. 工作区骨架

- [x] 1.1 创建根 `Cargo.toml`（workspace: crates/*）、`pnpm-workspace.yaml`（packages/*）、根 `package.json`、`.gitignore`（target/ node_modules/ dist/ .env 等）、`.cargo/config.toml` 占位、`rust-toolchain.toml`（stable）
- [x] 1.2 `packages/*` 三包骨架（package.json + tsconfig 继承根配置）；`crates/*` 两 crate 骨架（lib.rs/bin.rs 空实现可编译）
- [ ] 1.3 验证：`cargo check` 通过（本地 target dir）、`pnpm install` 通过、`pnpm -r build` 空跑通过

## 2. iroh spike（先验证再铺开）

- [x] 2.1 spike：两进程 iroh Endpoint 按 EndpointId 互连（n0 默认 relay + discovery），发送一条自定义 ALPN 消息；记录 API 用法结论到 `docs/spike-iroh.md`
- [x] 2.2 spike：`iroh-relay` 服务端最小运行（本地 curl 健康检查 + 客户端 RelayMode::Custom 经其桥接连通）；结论追加到 `docs/spike-iroh.md`

## 3. fabric kernel（crates/dweb-fabric，codex P0 重构后）

- [x] 3.1 identity 模块重构：改用 iroh `SecretKey`（删除 ed25519-dalek 直接依赖），EndpointId 展示串统一 z-base-32（与 iroh 一致）；密钥持久化语义不变（0600/损坏报错）
- [x] 3.2 protocol 模块重构：Fact 增加 fabric_id；fact_id = BLAKE3(未签名规范字节)；域分隔签名；Genesis 事实；InviteV1（含 issuer EndpointAddr/max_uses=1/可选 recipient）；challenge-response PoP 材料；quarantine 解码器
- [x] 3.3 roster 模块重构：单根 Genesis 闭包（非 root 签发 fail-closed 入库不授权）；Revoke 精确目标 grant；事实集合原子落盘 + 启动重放；invite_id 持久化 CAS 消费
- [x] 3.4 session 模块：双 ALPN（redeem/regular）、两侧门控、控制流归属（发起方单条）、HELLO 全量同步、MSG 流、帧上限（1 MiB/32 KiB redeem/5s 时限）、path_events 归纳 LinkStatus、显式 close 语义；集成测试：invite→redeem→grant→session→revoke 全链路 + 窃取者无 PoP 被拒 + 重复兑换被拒
- [x] 3.5 public API 整理（Fabric::new/start/stop/invite/join/members/revoke/connect/disconnect/send + 事件 channel），crate 级文档

## 4. server（crates/dweb-server）

- [x] 4.1 rendezvous 模块：axum 路由（POST/GET /rendezvous/:id、GET /healthz）、签名验证、TTL 过期清理；集成测试（签名受理/拒绝/过期）
- [x] 4.2 relay 集成：按 spike 结论嵌入 iroh-relay 服务端，环境变量配置开关与端口
- [ ] 4.3 端到端：fabric 节点以自托管 relay 完成组网（禁用 n0 默认）的集成测试

## 5. client-sdk（packages/client-sdk）

- [x] 5.1 napi-rs 工程接入（build.rs、index.d.ts 生成、@napi-rs/cli 构建脚本 darwin-arm64）
- [x] 5.2 Fabric 类绑定 + ThreadsafeFunction 事件；vitest 单测（生命周期幂等、API 面）；不支持平台的明确报错路径
- [ ] 5.3 README（API 表 + 最小示例代码）

## 6. example（packages/example）

- [x] 6.1 CLI：id / invite / join / members / send / chat 命令（tsx 直跑 + 编译双形态）
- [x] 6.2 E2E 脚本：脚本化双进程 invite→join→互发消息→revoke 断言（vitest 或 node 脚本），纳入 `pnpm test:e2e`

## 7. server-binary 包 + docker

- [x] 7.1 `packages/server-binary`：拷贝 darwin-arm64 二进制、bin 入口（`dweb-server`）+ Node API（start/stop）、健康检查自测脚本
- [ ] 7.2 `docker/Dockerfile`：cargo chef 缓存层 + 运行层；本地构建镜像并以两个容器验证 relay 组网
- [ ] 7.3 发布 ghcr.io/gaubee/dweb（:0.1.0 与 :latest）；验证 pull 后 healthz

## 8. 收尾

- [ ] 8.1 CI（GitHub Actions）：cargo test/clippy/fmt + pnpm build/test（Linux 容器内跑 Rust 单元测试与 SDK 类型检查；原生 .node 相关 job 限 macos-14）
- [ ] 8.2 README（根）：快速开始（docker run relay → example 双进程组网）
- [ ] 8.3 openspec validate --strict 通过；tasks 勾选完成；按批次 git commit 并推送
