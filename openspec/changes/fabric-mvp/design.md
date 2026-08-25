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

### D2：事实、签名与授权模型（codex 评审后重订，2026-08-26）

- 密钥统一：身份与事实签名共用 iroh 的 `SecretKey`/`EndpointId`/`Signature`（iroh 1.1 re-export，dalek 3 内核），**不引入第二套 ed25519-dalek 2**。EndpointId 展示串统一用 iroh 的 z-base-32（与 iroh CLI/票据一致），消除"同钥两串"。
- Fabric 授权：`Genesis { fabric_id, root }`（root 自签、不可变）；v0.1 仅 root 可签 MemberGrant/Revoke；非 root 签发的事实入库但不产生授权（fail-closed）；事实规范字节含 fabric_id，跨 fabric 拒收。
- 事实 id = BLAKE3(未签名规范字节)（内容寻址，删除随机 UUID）；域分隔前缀 `b"dweb/fact/v1\0"`；签名覆盖域分隔后的规范字节。
- 邀请 InviteV1（`dweb1.` + base64url）：version | fabric_id | invite_id(16B 随机) | issuer EndpointId | issuer EndpointAddr（relay URL + 可选直连） | expires_at | optional recipient | max_uses=1 | issuer 签名。
- 兑换 issuer-online：B 连 issuer 的兑换 ALPN，提交令牌 + B 对 (fabric_id, invite_id, 连接绑定材料) 的 PoP；issuer 验证 root 权限仍在、过期、PoP、TLS peer==B、持久化 CAS 消费 invite_id，然后签发 MemberGrant(subject=B) 回执。PoP 的连接绑定材料 v0.1 用（fabric_id, invite_id）与 channel 绑定的简化组合（TLS exporter 若 iroh 未暴露则退化为随机 challenge-response，由 issuer 发 challenge，B 签 challenge——防跨连接重放的效果等同且不依赖 exporter）。
- 合并 = 内容寻址集合并；解码/签名失败进 quarantine（计数 + 保留样本供诊断）；事实集合原子落盘 + 启动重放。
- 有效投影：Genesis 出发的确定性闭包；Join 仅自述信息非准入边；Revoke 精确指向 grant（或 subject 全部活 grant）；过期/未知签发者 fail-closed。

### D3：会话协议（codex 评审后重订，2026-08-26）

双 ALPN：

```text
/dweb/fabric-redeem/1  兑换通道：单 bidi 流，首帧必为 Redeem{token, PoP 或 challenge 响应}，
                       32 KiB 上限，5s 时限，单次成功（invite_id CAS 消费），完成即关闭
/dweb/fabric/1         常规通道：接受/发起两侧先门控（对端 EndpointId ∈ 有效投影），
                       发起方开唯一控制 bidi 流；HELLO(全量事实 dump) 在门控后交换；
                       MSG 走后续流（或控制流内的带类型帧）
```

- 寻址：connect 必须带 EndpointAddr（relay URL/直连地址），来源 = 邀请令牌 / 同步的地址记录 / 显式配置；无线索快速失败（spike 实证 ~500µs）。
- 帧资源边界：max_frame=1 MiB、max_facts/次同步上限、max_roster_bytes、读超时；长度前缀超限拒绝不预分配。
- 路径观测：每连接一个 `path_events()` 消费任务归纳 LinkStatus{Direct|Relay}。
- 关闭语义：显式 `conn.close(code, reason)` + `Endpoint::close().await`；accept 循环以 `accept()==None` 退出（spike 实证）。

### D4：网络磁盘编译约束

仓库在 `/Volumes/dweb`（SMB/NFS 类网络卷），cargo 原地编译会非常慢且文件锁可能异常。约定：本地开发与 CI 均设置 `CARGO_TARGET_DIR=$HOME/.cargo-target/dweb`（本地 SSD）；`.cargo/config.toml` 写入相对重定向不可行（相对路径仍落在网络卷），故用环境变量约定 + package.json 脚本统一注入。产物按需拷回仓库目录。

### D5：napi-rs 绑定面

`packages/client-sdk` 用 napi-rs（`#[napi(object)]` 结构 + `#[napi]` async 方法）。回调走 `ThreadsafeFunction`。v0.1 用 `@napi-rs/cli` 构建 `darwin-arm64` 单平台 `.node`。API：`Fabric` 类（spec 见 sdk/node）。

### D6：server 形态（codex 评审后修订）

`crates/dweb-server`：单二进制。relay 用 `iroh-relay` 的 **server feature**（`Server::spawn` 自行绑定监听，无法把 axum 路由塞进同一 listener——spike 实证）；rendezvous 独立 HTTP 端口（axum 自行监听）。端口拓扑：`DWEB_HTTP_BIND`（rendezvous + healthz）、`DWEB_RELAY_HTTP_BIND`（relay 控制面，明文 HTTP 本地可用）、`DWEB_RELAY_QUIC_BIND`（relay 数据面 UDP）。TLS：本地/内网明文可用；生产由反代终结 TCP/WS，QUIC 数据面需原生证书（v0.1 文档写明降级边界）。rendezvous 是可选发现辅助，非信任边界。Docker：multi-stage（cargo chef 缓存层 + debian-slim 运行层）。

### D7：npm 包命名与发布策略

- workspace 内部引用 `workspace:*`；不发布到 npm registry（用户未要求）。
- `@dweb/server-binary` 保留（Owner 指定交付物，darwin-arm64）：包内直接携带二进制（`bin/dweb-server-aarch64-apple-darwin`）+ bin 入口；Docker 镜像是服务器侧主交付物，两者并存。
- ghcr 镜像：`ghcr.io/gaubee/dweb`，版本 tag 优先（`:0.1.0`），`latest` 仅为便利不作为验证目标。发布经 GitHub Actions（GITHUB_TOKEN，packages:write）。
- **本机不使用 docker（Owner 指令 2026-08-26）**：镜像本地构建/验证一律走远端 Mac mini `bngjdemac-mini-7.local` 的 docker daemon（`DOCKER_HOST=ssh://kzf@bngjdemac-mini-7.local`，统一入口 `scripts/docker.sh`）。

### D8：版本锁定（codex 评审新增）

- `iroh = "=1.1.0"`、`iroh-relay = { version = "=1.1.0", features = ["server"] }`、`iroh-base = "=1.1.0"`（1.x 仍在快速演进，含 breaking change；升级逐次读 release notes + 跑跨 NAT 回归）。
- napi 三件套锁精确版本；`blake3` 进入 workspace deps。
- `.cargo/config.toml` 的绝对 target-dir 为本机开发便利（CI 用 `CARGO_TARGET_DIR` env 覆盖，env 优先级高于 config）；在 README 注明。

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
