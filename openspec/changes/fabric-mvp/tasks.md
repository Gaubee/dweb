# fabric-mvp — Tasks

> 执行约束：所有 cargo 命令必须设置 `CARGO_TARGET_DIR=$HOME/.cargo-target/dweb`。
> 共享文件（根 package.json、pnpm-workspace.yaml、Cargo.toml、.gitignore、package.json5 等）由主会话统一落盘，子代理不得修改。

## 1. 工作区骨架

- [x] 1.1 创建根 `Cargo.toml`（workspace: crates/*）、`pnpm-workspace.yaml`（packages/*）、根 `package.json`、`.gitignore`（target/ node_modules/ dist/ .env 等）、`.cargo/config.toml` 占位、`rust-toolchain.toml`（stable）
- [x] 1.2 `packages/*` 三包骨架（package.json + tsconfig 继承根配置）；`crates/*` 两 crate 骨架（lib.rs/bin.rs 空实现可编译）
- [ ] 1.3 验证：`cargo check` 通过（本地 target dir）、`pnpm install` 通过、`pnpm -r build` 空跑通过

## 2. iroh spike（先验证再铺开）

- [ ] 2.1 spike：两进程 iroh Endpoint 按 EndpointId 互连（n0 默认 relay + discovery），发送一条自定义 ALPN 消息；记录 API 用法结论到 `docs/spike-iroh.md`
- [ ] 2.2 spike：`iroh-relay` 服务端最小运行（本地 curl 健康检查 + 客户端 RelayMode::Custom 经其桥接连通）；结论追加到 `docs/spike-iroh.md`

## 3. fabric kernel（crates/dweb-fabric）

- [ ] 3.1 identity 模块：keypair 生成/加载、EndpointId 编码（z-base-32 或 hex，选定后写死测试）、密钥文件持久化与损坏报错；单元测试覆盖 spec 场景
- [ ] 3.2 protocol 模块：Fact 结构、规范序列化（length-prefixed）、签名/验证、令牌 `dweb1.` 编解码；单元测试（含非规范编码一致性、过期判定）
- [ ] 3.3 roster 模块：union-merge、有效投影推导（根成员自 Grant）、撤销/过期逻辑；单元测试覆盖收敛与投影场景
- [ ] 3.4 session 模块：ALPN accept 循环 + 门控（成员/邀请兑换例外）、帧协议（HELLO/FACT/MSG/BYE/INVITE_REDEEM）、连接管理（connect/在线表/事件广播）、路径类型观测；集成测试：同机双节点 invite→join→send→revoke 全链路
- [ ] 3.5 public API 整理（Fabric::new/start/stop/invite/join/members/revoke/connect/disconnect/send + 事件 channel），crate 级文档

## 4. server（crates/dweb-server）

- [x] 4.1 rendezvous 模块：axum 路由（POST/GET /rendezvous/:id、GET /healthz）、签名验证、TTL 过期清理；集成测试（签名受理/拒绝/过期）
- [ ] 4.2 relay 集成：按 spike 结论嵌入 iroh-relay 服务端，环境变量配置开关与端口
- [ ] 4.3 端到端：fabric 节点以自托管 relay 完成组网（禁用 n0 默认）的集成测试

## 5. client-sdk（packages/client-sdk）

- [ ] 5.1 napi-rs 工程接入（build.rs、index.d.ts 生成、@napi-rs/cli 构建脚本 darwin-arm64）
- [ ] 5.2 Fabric 类绑定 + ThreadsafeFunction 事件；vitest 单测（生命周期幂等、API 面）；不支持平台的明确报错路径
- [ ] 5.3 README（API 表 + 最小示例代码）

## 6. example（packages/example）

- [ ] 6.1 CLI：id / invite / join / members / send / chat 命令（tsx 直跑 + 编译双形态）
- [ ] 6.2 E2E 脚本：脚本化双进程 invite→join→互发消息→revoke 断言（vitest 或 node 脚本），纳入 `pnpm test:e2e`

## 7. server-binary 包 + docker

- [ ] 7.1 `packages/server-binary`：拷贝 darwin-arm64 二进制、bin 入口（`dweb-server`）+ Node API（start/stop）、健康检查自测脚本
- [ ] 7.2 `docker/Dockerfile`：cargo chef 缓存层 + 运行层；本地构建镜像并以两个容器验证 relay 组网
- [ ] 7.3 发布 ghcr.io/gaubee/dweb（:0.1.0 与 :latest）；验证 pull 后 healthz

## 8. 收尾

- [ ] 8.1 CI（GitHub Actions）：cargo test/clippy/fmt + pnpm build/test（Linux 容器内跑 Rust 单元测试与 SDK 类型检查；原生 .node 相关 job 限 macos-14）
- [ ] 8.2 README（根）：快速开始（docker run relay → example 双进程组网）
- [ ] 8.3 openspec validate --strict 通过；tasks 勾选完成；按批次 git commit 并推送
