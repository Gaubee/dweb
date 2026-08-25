# fabric-mvp 独立技术评审

- 评审日期：2026-08-26
- 范围：`openspec/changes/fabric-mvp/` 的方案，而非尚未完成的实现验收。
- 方法：检查当前工作树、已解析的 Cargo 依赖和一手资料（官方 release、源码、协议规范、crate manifest）。文末列出链接。

## 结论

**评分：4.4 / 10，当前不应进入 Apply 主线。**

iroh 仍是 native-only v0.1 的最优底座：它已经把公钥认证 QUIC、NAT 穿透、relay 回退和自托管 relay 收敛为一个 Rust 栈。没有找到同时更省事、且能保留这些能力的替代品。问题不在传输选型，而在 fabric 的授权模型尚不存在、邀请无法安全地表示“未知的被邀请者”、纯 union-merge 与一次性兑换目标冲突、以及 EndpointId 被误当作可直接拨号地址。

建议保留 iroh，但把 MVP 收窄为“一个根授权的 fabric + issuer-online 单次兑换 + 共同配置的自托管 relay + 邀请内携带 EndpointAddr”。删除 v0.1 自建 rendezvous 与 `@dweb/server-binary`，先跑通可审计的最小闭环。完成下列阻塞项和测试矩阵后，方案可升至约 7/10。

```text
当前： EndpointId + 自签事实 + 自定义 rendezvous + 单 ALPN 例外
          \______________________________/ 
                    授权边界未定义

建议： FabricId + 固定 RootKey
              |
       根或获授权 delegate 签发 MemberGrant(B)
              |
  redeem ALPN: B 持 token + B 的 PoP -> issuer 原子消费 -> grant
              |
 regular ALPN: 仅已是成员的 EndpointId；HELLO 在门控之后
```

## 已核实事实与评审边界

- 已提交历史只有 OpenSpec 建立提交和骨架提交；`dweb-fabric` 的四个模块仍是 placeholder。因此这里的“通过/不通过”是设计可实现性判断，不是功能验收。
- 当前工作树另有未提交的 `spike-iroh`、rendezvous 和 server 改动，且评审期间仍在变化；它们没有被回退或修改。它们只用来交叉验证 API 风险。按当前工作树复跑：`CARGO_TARGET_DIR=/Users/kzf/.cargo-target/dweb cargo test -p dweb-fabric --tests` 通过 45 个单元测试和 4 个集成测试，`cargo test -p dweb-server` 通过 4 个测试；这些是 WIP 代码的局部测试证据，不改变本文对 OpenSpec 设计尚未闭合的判断。
- `openspec validate fabric-mvp --strict` 通过；这只证明 Change 文档结构合法，不证明其中的授权、寻址和部署语义成立。
- 工作区实际解析到 `iroh/iroh-base/iroh-relay 1.1.0`，不是设计风险表写的 1.0.3。官方 release 于 2026-08-25 发布，manifest 要求 Rust 1.91，且底层是 `noq`，不是 quinn。`Cargo.toml` 的 `"1"` 仍允许未来小版本漂移。
- 官方 docs.rs 的 latest 仍滞后于已发布 1.1.0；版本事实以 crates sparse index、发布 tag 和锁文件为准，不能以 docs.rs latest 反推“当前最新”。

## 底座与替代方案

| 候选 | 本次核实结论 | 对 fabric-mvp 的取舍 |
| --- | --- | --- |
| **iroh 1.1.0** | 官方提供 public-key dial、QUIC streams/datagrams、打洞和 relay；`iroh-relay` 同仓库提供 server library/CLI、访问控制与 Docker 路径。 | **保留。** native Rust + napi 的最小概念面；应用仍须自建成员授权。锁定精确版本和 MSRV。 |
| rust-libp2p | Circuit Relay v2 是成熟 active 规范，但含 reservation voucher、流量/时长上限；实际 native 组网还要组合 swarm、transport/security/mux、identify、AutoNAT、DCUtR、relay、发现。 | 不比 iroh 省事。只有浏览器/WebRTC、多 transport 互通成为近期硬目标时再重开选型。 |
| Hyperswarm / HyperDHT | Node 的 topic swarm 和 Noise 流很简洁，DHT 可自建 bootstrap；但 relay 包官方标作 experimental、不可用于生产，且没有 Rust/napi 直通路径。 | 不选。会把现有 Rust kernel 变成 JS 网络栈，并引入 DHT/bootstrap 运维。 |
| Pion ICE / pion TURN | Pion ICE 是 Go 的 ICE agent，TURN 是可嵌入 toolkit；仍需信令、候选、DTLS/SCTP 或自建 QUIC-over-ICE 与 Rust/Go FFI。 | 不选。适合浏览器/WebRTC 阶段，而不是 native QUIC MVP。 |
| Quinn 自研 | Quinn 是纯 Rust QUIC transport，有 streams/datagrams；不提供打洞、发现、relay。 | 不选。需要重新实现 iroh 已承担的连接编排。 |
| webrtc-rs / 浏览器传输动向 | webrtc-rs 是原生 WebRTC 栈；浏览器侧的 P2P 传输状态与实现边界仍需按目标浏览器逐项核验，本评审不把它当作 native-only v0.1 的已验证生产路径。两者都仍要信令、ICE/TURN。 | 记录为 browser v0.2 评估项，不替换 v0.1。 |

**最终选择：** `iroh = "=1.1.0"`，不使用“iroh 1.x”或宽松 `"1"` 作为协议承诺。发布前逐次升级、读取 release notes、跑下文的跨 NAT 回归；因为 1.1.0 本身也含一个 CustomAddr 序列化 breaking change。

## D1-D7 逐项审查

| 决策 | 判断 | 错误、遗漏或修复 |
| --- | --- | --- |
| D1 iroh | **方向正确，API 描述过期。** | 1.1 的 API 是 `Endpoint::builder(presets::N0|Minimal)`；旧的 `discovery_local()/discovery_dns()` 不是当前主接口，统一为 `address_lookup(...)`。`conn_type()` 不存在；路径应读取 `Connection::paths()` / `path_events()` 的 selected `TransportAddr`。最关键的是 `EndpointId` 不是地址：没有 `EndpointAddr` 的 relay/IP，或 Address Lookup，拨号会失败。 |
| D2 事实/签名 | **阻塞。** | 事实没有 `FabricId`、根密钥/管理员集合、Grant 与 Revoke 的签发权限、revoke target/作用域、委托链、时钟策略和名册持久化。`self ∪` 以每台本机 self 为根，网络没有共同信任根，不能收敛到同一投影。UUID 冲突“先到者赢”不满足交换律，也可制造永久分叉/拒绝服务。 |
| D3 会话 | **阻塞。** | 常规成员 gate 与兑换例外共用 ALPN，未知方需完成 TLS 和开流后才能看到 token；这不是“拒绝连接”，也没有大小、时限、并发和首帧限制。单条 bidi stream 上双方同时写 HELLO 时，帧交错、控制/业务边界和半关闭语义未定义；若实现各自开流又会产生两条控制流竞态。`u32 len` 没有上限，单个帧可诱导 4 GiB 分配。 |
| D4 网络盘构建 | **意图正确，落地矛盾。** | design 说只靠环境变量，实际 `.cargo/config.toml` 已硬编码 `/Users/kzf/.cargo-target/dweb`，根 `build:rs` 也没有注入环境变量。这既不便携，也不满足 CI 说明。删除已提交的绝对路径；脚本使用 `CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cargo-target/dweb}"`。 |
| D5 napi-rs | **可行，但尚无生命周期设计。** | `ThreadsafeFunction` 必须设有界队列、明确 overflow/error、`stop()` 后不再回调、GC/finalizer 与 Rust task 的所有权和取消顺序。事件更适合 `AsyncIterator`/拉取队列加可选回调。当前 spec 未定义错误码、Buffer 所有权、重入与关闭竞态。 |
| D6 server | **阻塞且有过度设计。** | `iroh-relay::server` 需要 `server` feature；当前 `dweb-server` manifest 没启用它。官方 `Server::spawn` 自己绑定 relay HTTP/HTTPS/可选 QUIC 地址发现 listener，公开 API 不能把 axum route 直接塞进同一个 listener；DWEB 的两个 bind 变量也不足以表达 HTTP、HTTPS、UDP/QAD 与 rendezvous。反代 TLS 只能处理 TCP/HTTPS/WebSocket，不能替代 UDP QAD 的 TLS。自建 rendezvous 对本 MVP 不是必需，且把发现控制面和 relay 数据面错误捆绑。 |
| D7 发布物 | **范围过大。** | “不发布 npm”与携带 darwin-arm64 binary 的 `@dweb/server-binary` 并不矛盾，但后者对最常见 Linux 自托管没有交付价值；Docker 已是服务器交付物。v0.1 应只交付 Docker/原生 relay 配置和 darwin SDK；把 server npm binary 和 GHCR latest tag 策略推后。固定版本 tag/镜像 digest，`latest` 不能作为验证目标。 |

风险表遗漏了版本/MSRV 固定、成员授权、token 被窃/重放、CRDT 冲突、发现与地址泄露、帧资源耗尽、relay TLS/端口拓扑、撤销传播延迟、持久化损坏和 NAPI 取消语义；这些不是普通“实现风险”，而是安全/产品语义。

## 安全语义审查

### 1. 身份、根与授权链

iroh 的 `EndpointId` 就是 Ed25519 public key，并在 TLS 中认证。设计又引入 `ed25519-dalek = 2`；而 iroh 1.1 依赖 dalek 3 RC。这会形成两套不兼容的 key/signature 类型，极易把“传输认证的 endpoint key”与“名册签名 key”做成不同密钥而没有绑定证明。

修复：名册只使用 iroh re-export 的 `SecretKey`、`EndpointId/PublicKey` 和 `Signature`，或在规范中显式定义第二把 authorization key 及其由 EndpointId 签发的 binding certificate。MVP 选择前者。

每一个 fact 必须带 `fabric_id[32]`。创建 fabric 时持久化不可变的 `Genesis { fabric_id, root_endpoint_id }`；只有该 root 或由它**已授权且未撤回的 delegate**可签 `MemberGrant` / `Revoke`。不要把“issuer 在投影内”当成签发授权，更不能让所有成员默认有邀请和逐出权。

`Revoke` 必须精确 target `grant_id`（必要时另有被撤销 delegate key 的语义），并定义“撤销 delegate 是否传递性撤回其子授权”。建议 v0.1 只允许 root 签发 MemberGrant 和 Revoke，先不做 delegation。这样“有权成员”变为可执行的确定规则。

### 2. 邀请令牌与 `INVITE_REDEEM`

规范与 design 自相矛盾：roster spec 要 token 自包含 rendezvous 提示和 Grant；D2 却把 token 定义为 `canonical Fact || signature`，没有地址字段。更根本的是签发时通常尚未知被邀请者 B 的 EndpointId，因而不能预先签一条 `Grant(subject=B)`。

令牌泄露时，当前定义允许第一个拿到它的任意 EndpointId 生成 Join；并发兑换或离线分区中的两个 Join 无法靠 union-merge 原子地选择“唯一成功者”。“任一在线成员兑换”又没有共同的已消费状态和可验证的签发权。这是能力令牌的一次性语义与 AP CRDT 的不可兼得边界，不能用 warn 解决。

MVP 应改为 issuer-online、一次性兑换：

```text
dweb1.<base64url(InviteV1)>
InviteV1 = version | fabric_id | invite_id | issuer_endpoint_id |
           issuer_endpoint_addr | expires_at | max_uses=1 |
           optional recipient_endpoint_id | issuer_signature

B 先生成 EndpointId B，通过 /dweb/fabric-redeem/1 连接 issuer。
B -> issuer: InviteV1, B, B 对 (fabric_id, invite_id, TLS exporter) 的 PoP
issuer: 验证签名、当前 root 权限、过期、TLS peer == B、持久化 CAS 消费 invite_id
issuer -> B: MemberGrant(subject=B) + 签名回执
```

`TLS exporter` 绑定可阻止跨连接重放；仍须按 `invite_id` 持久化去重。若要允许离线自助兑换，只能牺牲“单次”，或在 token 创建前把 B 的公钥绑定进去。不得承诺两者同时成立。redeem 后关闭该连接；不得在该 ALPN 上传 HELLO、FACT dump 或 MSG。

### 3. 事实编码、签名和 union-merge

“固定顺序 + length prefix”还不是完整规范。至少需要：wire version、域分离常量、`fabric_id`、每字段固定宽度/端序、kind/Option tag、UUID 是 16 raw bytes 还是文本、UTF-8 是否保留原始字节、最大长度、时间语义、未知字段策略和 decoder 必须拒绝非规范长度编码。签名输入不能依赖 JSON、serde map 顺序或 locale。

建议删除随机 UUID 主键，令 `fact_id = BLAKE3(unsigned_canonical_bytes)`；签名覆盖 `b"dweb/fact/v1\\0" || unsigned_canonical_bytes`。Revocation 指向 `grant_id`。若仍保留客户端生成 ID，key 至少应为 `(issuer_id, fact_id)`，冲突必须 quarantine 并停止授权，而不是 first-wins。内容寻址能让同一事实的重复天然幂等。事实集合必须原子写入本地数据目录并在启动时重放，否则重启会丢失成员授权。

投影应从固定 Genesis 出发做有界、确定性的闭包；无根、循环、跨 fabric、过期、未授权签发、引用未知 target 的事实均不产生权限。时间使用单调比较规则和明确的允许时钟偏移；过期必须 fail-closed。接收事实数、每成员事实数、名字和地址记录均要上限。

### 4. relay 与 rendezvous 信任模型

iroh relay 不解密端到端 QUIC 会话内容，但它能观察 endpoint identity、IP/relay usage、上线时间、流量大小和关联关系，并能拒绝、延迟或丢包；它不是成员授权点。官方 relay 的 allowlist/shared-token/http-callout 只控制谁能用 relay，不能替代 roster，shared token 还只能靠更新配置并重启撤销。

默认公开的 `GET /rendezvous/:id` 会暴露已知成员的存在和地址。即使 POST 有签名，服务端仍可注入/删除/陈旧返回地址，客户端必须把 rendezvous 当作不可信发现结果，并以 EndpointId TLS 认证为最终校验。若保留 API，需定义完整签名域、request nonce、有效期、replay cache、地址类型白名单/数量/大小、速率限制、存储耐久性和查询授权；不能用自由字符串 `addrs`。当前 WIP 的 timestamp 窗口仍允许窗口内重放，且未定义 nonce/查询隐私，不能作为已解决的设计问题。

更简单也更私密的 v0.1 是**删除 rendezvous**：同一 fabric 配置共同的 custom relay；invite 内含 issuer 的 `EndpointAddr`（可使用 `iroh-tickets::EndpointTicket` 的 endpoint-address 编码，或自定义受签字节）。加入完成后的成员地址从已认证连接或受签 `AddressRecord` 同步。异构 home relay / 长期 address lookup 留到 v0.2。

### 5. 帧协议和资源边界

- 常规 ALPN `/dweb/fabric/1` 只接受已在本地有效投影的 TLS peer；本地 `connect()` 也必须先 gate。
- 兑换使用独立 `/dweb/fabric-redeem/1`，只允许一条 bidi stream、首帧必须是 Redeem、例如 5 s deadline、32 KiB token 上限、per-IP/per-relay/per-endpoint 并发上限；TLS 前无法可靠得到 remote EndpointId，因此仍需网络层配额。
- 常规会话规定“dialer 开一条 control bidi stream，acceptor 只接受该条”；HELLO 完成并验证后才可开 MSG stream。定义 `max_frame`、`max_roster_bytes`、`max_facts`、read timeout、未知 frame 和 application close code；不能按攻击者声明的 `u32 len` 分配。
- 对端下线只可定义为 heartbeat/connection deadline 的本地推断，不能承诺绝对的“有限时间”。撤销到达前的旧连接与分区节点仍有风险窗口，必须在产品语义中写明。

## 建议的 v0.1 组装方案

### 保留和新增依赖

```toml
# Rust workspace: 精确锁版本；Cargo.lock 入库
iroh = "=1.1.0"
iroh-relay = { version = "=1.1.0", features = ["server"] }
blake3 = "=1.8.7"               # fact content address；锁入 Cargo.lock
# 可选，仅作为 invite 内 EndpointAddr 的标准编码，不承担成员授权：
iroh-tickets = "=1.0.0"

# N-API crate（单独 crates/dweb-napi，cdylib）
napi = "=3.12.2"
napi-derive = "=3.6.3"
napi-build = "=2.4.1"           # build-dependency
```

移除 MVP server 对 `axum`、`serde_json`、`base64`、独立 `ed25519-dalek = 2` 的依赖；身份、签名和验证走 iroh key API。手写 bounded binary codec 并提交跨平台固定测试向量，避免把 postcard/serde 当作未声明的长期 wire ABI。若使用 `iroh-tickets`，其用途仅限把 `EndpointAddr` 放入邀请，不替代 `dweb1` 的 fabric 授权 envelope。

```json
// packages/client-sdk
{
  "devDependencies": { "@napi-rs/cli": "3.8.6" },
  "optionalDependencies": {
    "@dweb/client-sdk-darwin-arm64": "workspace:*"
  }
}
```

保持 `@dweb/client-sdk`，但将 `@dweb/server-binary` 从 v0.1 移出。服务端交付为基于 `iroh-relay` server feature 的 Docker image；首次验证可以直接使用官方 `iroh-relay` 容器/CLI 和明确的 TOML，再决定是否需要 dweb 包装二进制。若以后恢复自建 rendezvous，采用独立 HTTP 端口与独立持久存储，不能假设能嵌入 relay listener。

### MVP 运行拓扑

```text
native node A                         native node B
iroh Endpoint(A key)  <=== QUIC ===>  iroh Endpoint(B key)
       |  direct preferred                    |
       +---------- encrypted relay -----------+
                         |
                   self-hosted iroh-relay

Invite: signed bootstrap EndpointAddr(A) + single-use invite capability
Roster: Genesis(root key) + root-signed MemberGrant/Revocation facts
```

这仍满足“P2P 优先 + 自托管 relay 回退”和无中心账号；删去的是未证明必要且语义尚不安全的全局地址数据库，不是组网能力。

## 发布前阻塞项与可验证修复

| 优先级 | 阻塞项 | 必须完成的修复 | 验收证据 |
| --- | --- | --- | --- |
| P0 | 没有唯一 fabric 根与授权规则 | 引入 `FabricId + Genesis(root)`；v0.1 仅 root 可 Grant/Revoke；删除 local self root。 | 三节点不同到达顺序得到同一投影；普通成员 Grant/Revoke 被拒。 |
| P0 | token 可被窃取/重放，未知 subject Grant 未定义 | 引入 issuer-online CAS redemption、recipient PoP、独立 redeem ALPN、持久化 consumed invite。 | 窃取者、过期、重复、并发两个 B、错误 TLS peer、issuer 下线均按规范失败。 |
| P0 | `EndpointId` 不能独自寻址 | invite 和同步事实携带受签 `EndpointAddr`；或明确配置共同 relay；禁止宣称裸 ID 可连。 | 无 lookup 的 EndpointId 拨号失败测试；同一 token/relay 成功测试。 |
| P0 | iroh key 与 dalek v2 key 可能脱节 | 使用同一 iroh `SecretKey` 签 roster，事实 issuer 等于 TLS `remote_id()`。 | 用错误但有效的第二把签名 key 的 fact 被拒。 |
| P0 | server/relay 拓扑未定义 | 启用 `iroh-relay/server`，写清 HTTP/HTTPS/UDP/QAD 端口和 TLS 终结责任；v0.1 删除 rendezvous。 | 自托管 TLS relay、双 hard-NAT（或可控网络模拟）和断 relay 失败路径。 |
| P1 | 非确定 merge 与无界帧 | 内容寻址 fact、冲突 quarantine、限制/超时/状态机。 | property test：排列、重复、冲突包；fuzz decoder；超长/慢流不耗尽内存。 |
| P1 | D4/D5/D7 交付不自洽 | 删除绝对 target-dir；固定 Rust 1.91；NAPI stop/callback 契约；Docker-first。 | 干净 macOS + Linux CI；macOS NAPI E2E；镜像按版本 digest pull 后健康检查。 |

建议 gate：以上 P0 全部通过前，tasks 不应从 3.2/3.4 推进到 SDK/发布。此时先完成一个只含 `Genesis -> invite redeem -> root grant -> regular session -> revoke` 的端到端测试；Automerge、MLS、browser 和长期发现继续保持 non-goal。

## 一手信源

1. iroh v1.1.0 release（发布日期与变更）：https://github.com/n0-computer/iroh/releases/tag/v1.1.0
2. iroh v1.1.0 manifest（MSRV、`noq`、features）：https://raw.githubusercontent.com/n0-computer/iroh/v1.1.0/iroh/Cargo.toml
3. iroh Endpoint preset 源码（N0 Address Lookup、relay、Minimal）：https://raw.githubusercontent.com/n0-computer/iroh/v1.1.0/iroh/src/endpoint/presets.rs
4. iroh EndpointAddr 源码（EndpointId 不等于可达地址）：https://raw.githubusercontent.com/n0-computer/iroh/v1.1.0/iroh-base/src/endpoint_addr.rs
5. iroh connection 源码（`paths` / `path_events`）：https://raw.githubusercontent.com/n0-computer/iroh/v1.1.0/iroh/src/endpoint/connection.rs
6. iroh relay README（server、access control、shared token 撤销限制）：https://raw.githubusercontent.com/n0-computer/iroh/v1.1.0/iroh-relay/README.md
7. iroh relay server 源码（`server` feature、listener/TLS/QAD 配置）：https://raw.githubusercontent.com/n0-computer/iroh/v1.1.0/iroh-relay/src/server.rs
8. iroh tickets EndpointTicket 源码（EndpointAddr 的自包含编码）：https://raw.githubusercontent.com/n0-computer/iroh-tickets/v1.0.0/src/endpoint.rs
9. libp2p Circuit Relay v2 规范（reservation、cap、discovery）：https://github.com/libp2p/specs/blob/master/relay/circuit-v2.md
10. rust-libp2p manifest（可组合 feature 面）：https://raw.githubusercontent.com/libp2p/rust-libp2p/master/libp2p/Cargo.toml
11. Hyperswarm 与 HyperDHT 官方 README：https://raw.githubusercontent.com/holepunchto/hyperswarm/master/README.md 、https://raw.githubusercontent.com/holepunchto/hyperdht/master/README.md
12. Hyperswarm DHT relay README（experimental / not production）：https://raw.githubusercontent.com/holepunchto/hyperswarm-dht-relay/master/README.md
13. Pion ICE、TURN 官方 README：https://raw.githubusercontent.com/pion/ice/master/README.md 、https://raw.githubusercontent.com/pion/turn/master/README.md
14. Quinn README：https://raw.githubusercontent.com/quinn-rs/quinn/main/README.md
15. webrtc-rs 0.20.3 docs：https://docs.rs/webrtc/0.20.3/webrtc/
16. `@napi-rs/cli` registry metadata（2026-08-26 核验版本 3.8.6）：https://registry.npmjs.org/@napi-rs%2fcli/latest

## 评分依据

| 维度 | 分数 | 原因 |
| --- | ---: | --- |
| 原生传输与自托管可行性 | 8.5 | iroh/relay 与目标高度匹配，且有官方实现。 |
| 模块边界与 MVP 克制 | 5.5 | 不做 browser/MLS/离线转发是正确的，但 rendezvous、npm server binary 与 Docker 同时进入 MVP。 |
| 协议严谨性 | 3.0 | 版本、寻址、帧状态机、资源限制和 merge 规则不完整。 |
| 安全授权语义 | 1.5 | 根、授权、撤销权、token subject/消费和 replay 防护未定义。 |
| 交付与可验证性 | 4.0 | spike 优先是优点；MSRV、feature、端口/TLS、NAPI 生命周期和 CI 仍未闭合。 |

综合评分取 **4.4 / 10**（安全与协议按更高权重，且 P0 阻塞项触发上限）。这是“按当前文档开始实现的风险评分”，不是对 iroh 或正在进行 WIP 代码质量的评分。
