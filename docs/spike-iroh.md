# iroh 1.1.0 spike 验证报告

> 意图：为 dweb fabric `session` 模块提供 iroh 1.1.0 真实 API 与行为的精确依据（主会话任务 2026-08-26）。
> 证据来源：本地 registry 源码 `iroh-1.1.0` / `iroh-base-1.1.0` / `iroh-relay-1.1.0` / `noq-1.2.0` + 本机可运行验证（crates/spike-iroh）。
> 所有「精确签名」均从源码抄录，非记忆。复跑：`cargo run -p spike-iroh -- <selftest|listen|connect|relay|relay-selftest|n0-selftest|keygen>`。

## 0. 与 0.x 博客/旧文档的重大差异（先读这个）

```
0.x / 旧博客                      iroh 1.1.0 实测（本报告全部验证）
─────────────────────────────    ─────────────────────────────────────────────
iroh::NodeId                 →   iroh::EndpointId（= iroh_base::PublicKey 类型别名）
Endpoint::builder()          →   Endpoint::builder(preset)   // preset 必填！
                                 presets::{Empty, Minimal, N0, N0DisableRelay}
discovery_dns() / n0 DNS     →   address_lookup（PkarrPublisher/PkarrResolver/DnsAddressLookup）
discovery_local() (mDNS)     →   不存在。核心已移除 mDNS（无此 feature）
add_node_addr(node_addr)     →   已删。connect 直接吃 EndpointAddr{ id, addrs }
NodeAddr { node_id, addrs }  →   EndpointAddr { pub id, pub addrs: BTreeSet<TransportAddr> }
conn_type() / ConnectionType →   Connection::paths() / paths_stream() / path_events()
Connection::remote_node_id() →   Connection::remote_id() -> EndpointId
Endpoint::shutdown-like      →   Endpoint::close()（无 shutdown 方法名）
quinn::Connection            →   iroh 自研 noq（Connection 不再透传 quinn）
```

- `iroh::protocol::{Router, ProtocolHandler, AcceptError}` 在 1.1.0 仍存在（accept 回调式封装，本次未深入）。
- Endpoint 是 `Clone`（内部 Arc）；Connection 也是 `Clone`。

## 1. 基础互连 —— ✅ 成立（localhost connect 62ms / 104ms）

精确签名（iroh-1.1.0/src/endpoint.rs）：

```rust
pub fn builder(preset: impl Preset) -> Builder;              // Endpoint::builder
pub async fn bind(preset: impl Preset) -> Result<Self, BindError>;  // Endpoint::bind 快捷方式
// Builder:
pub async fn bind(self) -> Result<Endpoint, BindError>;
pub fn secret_key(mut self, secret_key: SecretKey) -> Self;  // 不设则随机生成
pub fn alpns(mut self, alpn_protocols: Vec<Vec<u8>>) -> Self; // 覆盖式；仅影响入站
pub fn relay_mode(mut self, relay_mode: RelayMode) -> Self;
pub fn bind_addr<A>(self, addr: A) -> Result<Self, InvalidSocketAddr>
    where A: ToSocketAddr, <A as ToSocketAddr>::Err: Into<InvalidSocketAddr>;
pub fn crypto_provider(mut self, crypto_provider: Arc<rustls::crypto::CryptoProvider>) -> Self; // 必填项，由 Minimal/N0 preset 设置
// Endpoint:
pub async fn connect(&self, endpoint_addr: impl Into<EndpointAddr>, alpn: &[u8])
    -> Result<Connection, ConnectError>;
pub fn accept(&self) -> Accept<'_>;                          // Future<Output = Option<Incoming>>
pub fn id(&self) -> EndpointId;                              // 旧 node_id()
pub fn addr(&self) -> EndpointAddr;
pub fn bound_sockets(&self) -> Vec<SocketAddr>;              // 实际绑定的 UDP 端口（推导 127.0.0.1:port 用）
pub async fn online(&self);                                  // 等待 home relay 连上（addr 才含 RelayUrl）
```

accept 是两段式（0.x 一步到位 → 1.1.0 先 Incoming 再 Accepting）：

```rust
pub struct Incoming;      // iroh::endpoint::Incoming
pub fn accept(self) -> Result<Accepting, ConnectionError>;   // Incoming::accept
pub fn refuse(self);                                          // 拒绝
// Accepting: Future<Output = Result<Connection, ConnectingError>>
```

最小互连（selftest 实测通过）：

```rust
let server = Endpoint::builder(presets::Minimal)       // 无 relay、无发现，仅 ring 加密
    .secret_key(sk).alpns(vec![b"spike/1".to_vec()])
    .relay_mode(RelayMode::Disabled).bind().await?;
let client = Endpoint::builder(presets::Minimal).relay_mode(RelayMode::Disabled).bind().await?;

// 服务端（accept 循环）
while let Some(incoming) = ep.accept().await {          // close() 后返回 None
    let conn = incoming.accept()?.await?;               // 两段式 accept
    tokio::spawn(handle(conn));
}
// 客户端
let port = server.bound_sockets()[0].port();
let target = EndpointAddr::new(server.id()).with_ip_addr(([127,0,0,1], port).into());
let conn = client.connect(target, b"spike/1").await?;
let (mut send, mut recv) = conn.open_bi().await?;       // OpenBi -> Result<(SendStream, RecvStream)>
send.write_all(b"hello").await?;                        // SendStream::write_all(&mut self, &[u8])
send.finish()?;                                         // 半关闭；RecvStream::read_to_end 才会终止
let reply = recv.read_to_end(64 * 1024).await?;         // RecvStream::read_to_end(&mut self, usize)
// 服务端对应：conn.accept_bi().await? -> (SendStream, RecvStream)
```

坑：
- `Endpoint::builder()` 无参调用直接编译错误（必须传 preset）。`Minimal` 是能跑的最小集；`Empty` 会因缺 crypto_provider bind 失败。
- 默认绑定 `0.0.0.0:0` + `[::]:0` 双栈；`addr()` 里的直连地址是网卡地址（本机为 192.168.x.x），**不含 127.0.0.1**。本机互连要用 `bound_sockets()` 的端口自行拼。
- connect 不允许连自己（`ConnectWithOptsError::SelfConnect`），ALPN 不能为空。

## 2. 发现机制 —— ⚠️ 部分成立（n0 DNS ✅ / 手动注入 ✅ / mDNS ❌ 已移除）

| 方式 | 结论 | 实测 |
|---|---|---|
| n0 DNS（discovery_dns 替身） | ✅ 成立 | 两端 `presets::N0`，仅凭 z32 EndpointId connect 成功，1.35s（含 pkarr 发布等待 6s） |
| 手动注入地址（add_node_addr 替身） | ✅ 成立 | `EndpointAddr::new(id).with_ip_addr(...)`，跨进程 104ms |
| mDNS / discovery_local | ❌ 不存在 | 1.1.0 无此 API 无此 feature；`address_lookup` 子模块仅 dns/memory/pkarr |
| 无任何发现 + 空地址 | ✅ 立即失败（非超时） | 475µs 返回 `No addressing information available: No address lookup configured` |

n0 发现机制：N0 preset = `PkarrPublisher::n0_dns()`（发布）+ `PkarrResolver::n0_dns()`（HTTPS /pkarr 解析）+ `DnsAddressLookup::n0_dns()`（DNS TXT 解析）+ n0 官方 relay。`iroh::endpoint_info(z32)` 亦可独立查询。
进程内测试可用 `iroh::address_lookup::MemoryLookup`（`add_endpoint_info` / `get_endpoint_info`）做假发现。

坑：
- 「10s 才失败」的说法只在**有地址但不可达**时成立；无 lookup 服务 + 空 addrs 是**快速失败**。
- 发布有延迟（pkarr 发布非同步确认）；spike 用 sleep 6s 后成功。session 模块若依赖发现，需重试/超时预算 ≥ 数秒。

## 3. 路径观测（direct vs relay）—— ✅ 成立（新 API：paths/path_events，非 conn_type）

```rust
// iroh::endpoint::Connection（iroh-1.1.0/src/endpoint/connection.rs）
pub fn paths(&self) -> PathList<'_>;          // 借用快照：len/is_empty/iter/get(PathId)
pub fn paths_stream(&self) -> PathListStream<'_>;  // 快照流：首拍当前值，路径集或选中变化时再拍
pub fn path_events(&self) -> PathEventStream;      // 'static 事件流，可 move 进 spawn
// Path（PathList::iter() 的元素）：
pub fn id(&self) -> PathId;
pub fn remote_addr(&self) -> &TransportAddr;  // Relay(url) = 经 relay；Ip(sockaddr) = 直连
pub fn local_addr(&self) -> &LocalTransportAddr;
pub fn is_selected(&self) -> bool;            // 当前承载数据的路径
pub fn stats(&self) -> PathStats;
// PathEvent（#[non_exhaustive]，全部变体也 non_exhaustive，match 必须带 .. 和 _）
Opened { id, remote_addr, local_addr } / Closed { id, remote_addr, local_addr, last_stats }
Selected { id, remote_addr, local_addr } / Lagged { missed }
```

判定 direct/relay：看 **selected path 的 `remote_addr()`** 是 `TransportAddr::Relay(_)` 还是 `Ip(_)`。
PathEventStream 实现的是 futures_core::Stream，`n0_future::StreamExt`（futures_lite）可直接 `.next()`。

实测事件序列（selftest，同机直连）：

```
[client-event] Opened   id=PathId(0) remote=ip:127.0.0.1:60748   ← 初选 127.0.0.1
[client-event] Opened   id=PathId(1) remote=ip:192.168.2.11:56824
[client-event] Selected id=PathId(1) remote=ip:192.168.2.11:56824 ← 迁移到网卡地址
[client-event] Closed   id=PathId(0) remote=ip:127.0.0.1:60748
```

坑：
- 多路径并存是常态：relay 自测里 relay path(PathId 0) 一直开着（不 selected），direct path(PathId 1) 打洞成功后被 Selected。**判定连接质量要盯 Selected 变化，而不是有没有 Relay path**。
- `paths()` 借用 Connection，不能跨 task；跨 task 用 `path_events()`（'static）或 clone Path 数据。

## 4. 自建 iroh-relay —— ✅ 成立（35ms 经 relay 互连，随后迁移 direct）

服务端（需要 `iroh-relay = { features = ["server"] }`；spike-iroh/Cargo.toml 已开）：

```rust
use iroh_relay::server::{RelayConfig as RelayServerConfig, Server, ServerConfig};
// iroh-relay-1.1.0/src/server.rs 精确签名：
// pub struct ServerConfig { pub relay: Option<RelayConfig>, pub quic: Option<QuicConfig>,
//                           pub metrics_addr: Option<SocketAddr> }  // #[non_exhaustive] + Default
// impl RelayConfig { pub fn new(http_bind_addr: impl Into<SocketAddr>) -> Self }
//   字段：http_bind_addr / tls: Option<TlsConfig> / limits / key_cache_capacity / access
// impl Server {
//   pub async fn spawn(config: ServerConfig) -> Result<Self, SpawnError>;
//   pub async fn shutdown(self) -> Result<(), SupervisorError>;
//   pub async fn join(&mut self) -> ...;
//   pub fn http_addr(&self) -> Option<SocketAddr>;   // 无 TLS 时的服务地址
//   pub fn https_addr(&self) -> Option<SocketAddr>;  pub fn https_url(&self) -> Option<RelayUrl>;
//   pub fn quic_addr(&self) -> Option<SocketAddr>;   pub fn metrics(&self) -> &RelayMetrics;
// }

let bind = SocketAddr::from(([127, 0, 0, 1], 3340));
let mut rc = RelayServerConfig::new(bind);
rc.tls = None;                       // 开发环境无 TLS；生产必须 TLS（见坑）
let mut config = ServerConfig::default();
config.relay = Some(rc);
let server = Server::spawn(config).await?;
let url: RelayUrl = format!("http://{}", server.http_addr().unwrap()).parse()?;
```

健康检查：`GET /healthz` → `200 {"status":"ok","version":"1.1.0","git_hash":"unknown"}`（curl 实测）。
SIGINT 后 `server.shutdown().await` 干净退出。

客户端仅经自建 relay（relay-selftest + 跨进程 relay 实测）：

```rust
let ep = Endpoint::builder(presets::Minimal)          // 不用 N0：关掉 n0 DNS 与官方 relay
    .alpns(vec![ALPN.to_vec()])
    .relay_mode(RelayMode::custom([relay_url]))       // RelayMode::Custom(RelayMap) 的便捷构造
    .bind().await?;
ep.online().await;                                    // 等 home relay 连上（否则 addr 里无 RelayUrl）
// 发起侧只给 id + relay url，一个 IP 都不给：
let target = EndpointAddr::new(remote_id).with_relay_url(relay_url);
let conn = ep.connect(target, ALPN).await?;           // 实测 35ms~89ms
```

实测：连接先经 relay 建立（PathId0 = relay，Selected），打洞成功后 direct path（PathId1）接管 Selected；echo 全程成功。

坑：
- **无 TLS 的 http:// relay 可用**：client.rs 把 `http` 映射为 `ws://`（`RelayUrl` 解析不强制 https）。本地开发零证书成本。生产要 TLS：服务端 `rc.tls = Some(TlsConfig::new(addr, CertConfig::Manual{..}))`，客户端 `builder.ca_tls_config(CaTlsConfig::...)`（自签可用 `CaTlsConfig::insecure_skip_verify()`，但它在 `test-utils` feature 后面，生产应注入自签 CA）。
- `Server` 无 `http_url()`，只有 `https_url()`；无 TLS 时手工拼 `http://{http_addr}`。
- relay 的 QUIC 转发（`QuicConfig`）需配 TLS 证书，spike 未启用（纯 WebSocket 转发已够验证）。
- `RelayMode::custom(urls)` 接受 `impl IntoIterator<Item = RelayUrl>`。

## 5. SecretKey 持久化 —— ✅ 成立

```rust
// iroh-base-1.1.0/src/key.rs
pub struct SecretKey(SigningKey);          // ed25519（ed25519-dalek）
pub fn generate() -> Self;                 // 实现就是 from_bytes(&rand::random())
pub fn to_bytes(&self) -> [u8; 32];        // 仅私部；公钥可随时恢复
pub fn from_bytes(bytes: &[u8; 32]) -> Self;   // ⚠️ 无 Result，不失败
pub fn public(&self) -> PublicKey;         // = EndpointId
// PublicKey（= EndpointId）：
pub fn to_z32(&self) -> String;            // z-base-32，52 字符
pub fn from_z32(s: &str) -> Result<Self, KeyParsingError>;
pub fn from_bytes(&[u8; 32]) -> Result<Self, KeyParsingError>;  // 公钥侧有 Result
```

实测：`to_bytes → from_bytes → public()` 与原 id 相同；`Builder::secret_key(restored)` 后 `endpoint.id() == sk.public()`。
坑：`from_bytes` 对任意 32B 都构造成功（不校验）；密钥落盘要自行加密封装（iroh 不管存储）。

## 6. 接受侧信息 —— ✅ 成立

```rust
// Connection（已建立）：
pub fn remote_id(&self) -> EndpointId;      // 旧 remote_node_id
pub fn alpn(&self) -> &[u8];                // 协商出的 ALPN
pub async fn closed(&self) -> ConnectionError;   // 连接关闭 future（正常关闭也走这里）
pub fn close_reason(&self) -> Option<ConnectionError>; // 已关闭时的原因，未关 None
pub fn close(&self, error_code: VarInt, reason: &[u8]); // VarInt: From<u32>
// Incoming（握手前）：remote_addr() / remote_addr_validated() / decrypt()；Accepting::remote_id() 也可用
```

实测：client `conn.close(0u32.into(), b"selftest-done")` 后，server 的 `closed()` 返回
`closed by peer: selftest-done (code 0)` —— **对端 close 的 code 与 reason 字符串都能拿到**，session 层可借此区分正常退出/异常。

## 7. 并发与生命周期 —— ✅ 成立

- `Endpoint::close()`（无 `shutdown()`）：优雅关闭；**强烈建议 await 完**（源码注释：不 await 会让对端超时误判失败）。close 后：
  - `accept()` → `None`（accept 循环的退出信号，实测通过）
  - `is_closed()` → `true`
  - 对已 close 的 endpoint 发起 connect → 报错（实测 `timed out`；对端视角）
- `Endpoint::closed() -> EndpointClosed`：endpoint 级关闭 future，且 `EndpointClosed::run_until(fut)` 可做「endpoint 关闭即取消」的任务包装。
- 多 peer 并发：一个 listener + 3 个并发 connect（tokio::spawn）全部回声成功；accept 循环内 `tokio::spawn(handle(conn))` 即并发 accept 模式。
- ⚠️ 坑（实测日志）：**drop Endpoint 而不 close() 会打 ERROR `Endpoint dropped without calling Endpoint::close. Aborting ungracefully.`**（selftest 里 client_ep 忘 close 触发过一次）。session 模块必须有显式 close 路径（Drop 守卫或 shutdown 流程）。
- Connection 泄漏不阻塞 Endpoint：connection 由各自任务持有。

## 给 session 模块实现者的建议（Top 3）

1. **连接管理数据结构**：以 `EndpointId`(z32 字符串做 key) 为主索引；连接参数每次显式给 `EndpointAddr`（`EndpointAddr::new(id).with_relay_url(..).with_ip_addr(..)`）。地址缓存自己做（iroh 不再有 add_node_addr 全局表）；缓存更新源：`Connection::paths()` 里 selected path 的 remote/local 地址 + 对端 `EndpointAddr` 序列化交换。
2. **路径感知**：每条 Connection spawn 一个 `path_events()` 消费任务，把 `Selected`/`Opened`/`Closed` 归纳成 session 层的 `LinkStatus{Direct|Relay}` 事件（`remote_addr()` 的 `TransportAddr::Relay|Ip` 判定）。事件流在连接关闭时自然结束，任务随之退出，不需要额外生命周期管理。
3. **关闭协议**：自定义关闭 reason（`conn.close(code, reason)` 的 reason 是 UTF-8 字节，实测可读回）承载 session 语义；Endpoint 退出必须 `close().await`（配 Drop 守卫兜底），accept 循环以 `accept() == None` 为唯一退出条件。

## 复跑清单（全部实测通过）

```
cargo run -p spike-iroh -- selftest          # 项1/2(空地址失败+手动注入)/3/5/6/7 同进程全流程
cargo run -p spike-iroh -- relay-selftest    # 项4 同进程：自建 relay + 仅 relay 互连 + 迁移观测
cargo run -p spike-iroh -- n0-selftest       # 项2 n0 DNS 发现（需外网；实测通过 1.35s）
cargo run -p spike-iroh -- keygen            # 项5 密钥生成/恢复
cargo run -p spike-iroh -- relay --port 3340 # 项4 relay 服务端（GET /healthz 实测 200）
cargo run -p spike-iroh -- listen            # 跨进程 echo 服务端（打印 z32 + 127.0.0.1 候选）
cargo run -p spike-iroh -- connect <z32> --addr 127.0.0.1:<port>            # 手动注入直连
cargo run -p spike-iroh -- connect <z32> --relay http://127.0.0.1:3340/     # 仅 relay 跨进程
```

## 环境/实现注记

- iroh 1.1.0 默认 features：`metrics, fast-apple-datapath, portmapper, tls-ring`；`test-utils` 提供 `CaTlsConfig::insecure_skip_verify()` 与 `iroh::test_utils::run_relay_server()`（TLS 版 relay 一键起，带自签证书——生产化自建 relay 的参考实现）。
- 本机网络：沙箱内 UDP 绑定/localhost 双进程均未被拦截；n0 外网（relay + pkarr DNS）可达。若部署环境无外网，验证路径 = 自建 relay + `with_ip_addr` 手动注入（本文档已覆盖）。
- spike 代码：`crates/spike-iroh/src/main.rs`（单文件子命令式，注释含每验证项对应关系）。Cargo.toml 追加 `n0-future = "0.3"` 与 `iroh-relay/server` feature——由此带动根 Cargo.lock 更新（clap/rcgen 等 server 依赖），属预期变更，由主会话统一提交。
