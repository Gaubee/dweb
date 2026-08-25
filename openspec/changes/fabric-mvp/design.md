# fabric-mvp — Design

## 总体架构

```text
packages/example          (@dweb/example, Node CLI)
packages/client-sdk       (@dweb/client-sdk, napi-rs → Rust)
packages/server-binary    (@dweb/server-binary, 包装 server 二进制)
        │ napi                    │
crates/dweb-fabric  ──────┘       │
  ├─ identity   Ed25519 + EndpointId + 文件持久化
  ├─ roster     签名事实 + union-merge + 有效投影
  ├─ session    iroh Endpoint + 门控 + envelope 收发
  └─ protocol   线上格式（frame + fact 规范序列化）
crates/dweb-server        ───────┘
  ├─ relay      iroh-relay 服务端（crate 复用）
  └─ rendezvous axum HTTP API（/healthz /rendezvous）
docker/                  多阶段构建 → ghcr.io/gaubee/dweb
```

## 关键决策

### D1：iroh 1.x 作为原生传输底座

`Endpoint::builder()` + `discovery_local()`（局域网）+ `discovery_dns()`（可选 n0 或自托管）+ `relay_mode(RelayMode::Custom | Default)`。直连失败自动经 relay。path 类型（direct/relay）经 `conn.remote_addr()`/` endpoint.conn_type()` 可观测。MVP 不用 iroh-blobs/docs/gossip（主线未达生产质量）。

### D2：事实规范序列化与签名

- 事实结构：`Fact { id: Uuid v7, kind: Grant|Join|Revoke, issuer: EndpointId, subject: EndpointId, name: Option<String>, issued_at: unix_ms, expires_at: Option<unix_ms> }`
- 规范字节：字段按固定顺序、显式长度前缀拼接（length-prefixed canonical bytes），避免 JSON 字典序歧义；签名 = Ed25519 over 规范字节；令牌 = `base64url(canonical bytes || signature)` 前置 `dweb1.` 版本头。
- union-merge：`HashMap<FactId, Fact>`，插入时验证签名；同 id 不一致记 warn 保留先到。
- 有效投影：`self ∪ (Grant 未过期未被撤销 ∧ issuer 在投影内)`。根成员 = 本机首个身份（首次创建时签发自 Grant，issuer=self, subject=self）。

### D3：会话协议（运行在 iroh connection 上的应用帧）

单个 iroh ALPN（`/dweb/fabric/1`）双向流，帧格式：`u32 len | u8 type | payload`。帧类型：

```text
0x01 HELLO      { roster full dump }   连接建立后双方各发一次
0x02 FACT       { 单条或多条事实 }      增量同步与 join 交付
0x03 MSG        { opaque bytes }       业务 envelope，不解析
0x04 BYE        {}                     主动断开
```

门控在 accept 侧执行：对端 EndpointId ∈ 有效投影 → 放行；否则若携带 `INVITE_REDEEM` 帧（0x05：令牌 + Join 事实）则验证并兑换，随后按成员处理；都不满足则拒绝连接。accept 用 `endpoint.accept()` 循环 + ALPN 过滤。

### D4：网络磁盘编译约束

仓库在 `/Volumes/dweb`（SMB/NFS 类网络卷），cargo 原地编译会非常慢且文件锁可能异常。约定：本地开发与 CI 均设置 `CARGO_TARGET_DIR=$HOME/.cargo-target/dweb`（本地 SSD）；`.cargo/config.toml` 写入相对重定向不可行（相对路径仍落在网络卷），故用环境变量约定 + package.json 脚本统一注入。产物按需拷回仓库目录。

### D5：napi-rs 绑定面

`packages/client-sdk` 用 napi-rs（`#[napi(object)]` 结构 + `#[napi]` async 方法）。回调走 `ThreadsafeFunction`。v0.1 用 `@napi-rs/cli` 构建 `darwin-arm64` 单平台 `.node`。API：`Fabric` 类（spec 见 sdk/node）。

### D6：server 形态

`crates/dweb-server`：单二进制。relay 复用 `iroh-relay` crate 的服务端（官方镜像同款代码）；rendezvous 用 axum：`POST /rendezvous/:id`（body: addrs + ttl + sig over canonical req），`GET /rendezvous/:id`，`GET /healthz`。配置：`DWEB_RELAY_ENABLED`、`DWEB_HTTP_BIND`、`DWEB_RELAY_BIND`、TLS offload 交给反代（v0.1）。Docker：multi-stage（chef 风格 cargo chef 缓存层 + distroless/debian-slim 运行层）。

### D7：npm 包命名与发布策略

- workspace 内部引用 `workspace:*`；不发布到 npm registry（用户未要求）。
- `@dweb/server-binary` 的 `postinstall` 不自动下载（离线友好）：包内直接携带 darwin-arm64 二进制（`bin/dweb-server-aarch64-apple-darwin`），`optionalDependencies` 平台包模式留待多平台时启用。
- ghcr 镜像：`ghcr.io/gaubee/dweb:latest` + `:0.1.0`。发布经 GitHub Actions（GITHUB_TOKEN，packages:write）。
- **本机不使用 docker（Owner 指令 2026-08-26）**：镜像本地构建/验证一律走远端 Mac mini `bngjdemac-mini-7.local` 的 docker daemon（`DOCKER_HOST=ssh://kzf@bngjdemac-mini-7.local`，统一入口 `scripts/docker.sh`）。

## 风险与对策

| 风险 | 对策 |
| --- | --- |
| iroh 1.x API 与 0.x 差异大，社区资料混杂 | 以 docs.rs 1.0.3 与官方 example 为准；spike 先行验证建连/relay/accept 面 |
| SMB 文件锁导致 cargo/rustc 偶发失败 | CARGO_TARGET_DIR 本地化；`cargo check` 在 CI（Linux runner 本地磁盘）兜底 |
| napi ThreadsafeFunction 生命周期踩坑 | 参考 napi-rs 官方 examples；example-app 作为集成验收 |
| iroh-relay 服务端 API 面未知（文档偏客户端） | spike 阶段直接读 iroh-relay crate 源码与官方 docker 镜像入口 |
| ghcr 推送权限（token scopes 无 write:packages） | 先查 `docker` 是否已登录 ghcr.io；否则尝试 `gh auth token` 登录；失败则报告并保留镜像在本地 tar |

## 明确不做（v0.1 Non-goals）

- 浏览器/WebRTC 传输、CF Worker gateway（v0.2）
- Automerge 集成与不透明同步会话契约的通用化（v0.2，名册先行验证签名事实范式）
- 密钥轮换 / Key Epoch、MLS 群密钥、前向保密加密 envelope
- 离线消息存储转发、多 relay racing、自动 relay 选择
- Windows/Linux 原生构建（CI 可后续补）
