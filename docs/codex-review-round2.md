# fabric-mvp 二轮独立复核

- 复核日期：2026-08-26
- 复核对象：`HEAD` `22bfa821c0afa357ff9c488678599b547ffb0d95`，以及相对 P0 重构起点 `15a1499...HEAD` 的提交和当前工作树
- 结论：**6.0 / 10**（上轮 4.4，+1.6）。P0 重构已把方案从“缺少核心安全构件”推进到“核心构件大多存在，但两个安全不变量尚未闭合”。不建议以“P0 已全部清零”或“SDK E2E 全绿”作为对外结论。

## 复核边界与证据

本报告只把当前源码、Git 提交和本机实际命令输出当作已核实事实；远端 Mac、GHCR 已发布镜像和 CI 页面没有在本轮重新登录/重跑，故不把它们当作独立复验证据。

| 项目 | 本轮结果 |
| --- | --- |
| `cargo fmt --all -- --check` | 通过 |
| `pnpm -r typecheck` | 通过 |
| `cargo test --workspace` | 通过。实际输出为 54 个 Rust 测试（fabric unit 43、integration 4、facade E2E 3、server 4），不是“50”个。 |
| `node --test packages/example/test/e2e.test.mjs` | 通过，1/1，约 64 秒。 |
| `node --test packages/server-binary/test/server.test.mjs` | 通过。 |
| `node --test packages/client-sdk/test/sdk.test.mjs` | **未通过本轮复验**：运行约 697,965 ms 后仍有 pending Promise，被中断；输出为 3 pass、1 cancelled、0 fail。 |
| `npm pack --dry-run --json` | client 包将已跟踪的意外 Mach-O 文件 `.smbdeleteAAA1410e043` 打入 tarball；server-binary 包也将源码、脚本和测试打包。 |

技术版本只作交叉确认：`Cargo.lock`/manifest 固定 `iroh`、`iroh-base`、`iroh-relay` 为 `1.1.0`；iroh 官方 GitHub release 已有 v1.1.0，但 docs.rs 的首页构建状态仍可能滞后于此版本，不能把 docs.rs “latest”误作版本真相。[iroh v1.1.0 release](https://github.com/n0-computer/iroh/releases/tag/v1.1.0) 是本报告所用的一手版本来源。下列功能判断以仓库源码为准。

## P0 处置逐项核验

| 上轮 P0 处置 | 代码事实 | 判定 |
| --- | --- | --- |
| FabricId + Genesis 单根授权 | `Roster::validate_and_insert` 确实拒绝跨 fabric（`crates/dweb-fabric/src/roster.rs:431`），投影仅接受 root 的 Grant/Revoke（`:508`、`:530`）。但首次 Genesis 未校验 `issuer == subject`，且未限制 Genesis 的 name/expiry/target 为空（`:444-472`）。空 roster 若将不可信事实送入 `merge`，攻击者自签 Genesis 可先占 root，真实 Genesis 随后成为冲突项。当前 facade 的入站门控使该输入路径较窄，但数据模型安全不变量本身不成立。 | **部分成立，仍为 P0 阻塞** |
| issuer-online 单次兑换 | 独立 `ALPN_REDEEM`、随机 challenge、5 秒 timeout、32 KiB 单帧读限制和 `invites.consumed` fsync 记录都已存在（`session.rs:12-20, 228-290`；`roster.rs:810-837`）。但 CAS 只由一个 `Roster` 实例内存集合保护：同一 data dir 被两个进程/实例打开时没有文件锁或跨进程事务，两者可先后检查为未消费并各自 grant。PoP proof 声明的 redeemer 也没有与 `conn.remote_id()` 比对；兑换总字节数并非 32 KiB 上限。 | **部分成立，CAS 仍为 P0 阻塞** |
| EndpointAddr 显式寻址 | invite 载入 relay/direct hints，`endpoint_addr_from_invite` 会在两者均无效时快速失败（`session.rs:293-310`）；常规 connect 优先用 learned hints（`fabric.rs:434-449`）。无 hints 时使用显式 relay 配置也是规格允许的“显式配置”来源。 | **成立** |
| iroh 密钥统一 | fabric 侧身份、EndpointId、事实签名均使用 `iroh_base::{SecretKey, Signature}`，并有 z32 display/parse 守护测试。应注意 server rendezvous 仍直接依赖 `ed25519-dalek` v2（`crates/dweb-server/src/rendezvous.rs:13`），虽只用于服务端验签、字节格式兼容，却与“全仓删除 dalek”不符。 | **fabric 核心成立；全仓表述不成立** |
| 自托管 relay 拓扑 | `iroh-relay` server feature 被真正嵌入并由 `Server::spawn` 启动（`crates/dweb-server/src/relay.rs:28-53`）；Docker 公开 relay HTTP 3340（`docker/Dockerfile:24-31`）。但 `relay.tls = None`，故无论设置何值 `DWEB_RELAY_QUIC_BIND` 都不会启动 QUIC listener（`relay.rs:31-41`），Docker 也没有 UDP expose。当前可确认的是 HTTP/WS relay 路径，不是完整 QUIC relay 拓扑。 | **MVP fallback 成立；拓扑宣称部分成立** |
| 内容寻址 + quarantine | `fact_id` 是 `BLAKE3(canonical_bytes)`，签名覆盖同一规范字节（`protocol.rs:263-322, 432-454`）；跨 fabric、验签失败及冲突进入 quarantine（`roster.rs:430-475`）。 | **成立** |

## 阻塞问题

### P0-1：Genesis 可被不规范自签事实抢占 root

`validate_and_insert` 在接受第一条 Genesis 时只检查签名和“是否已有不同 Genesis”，随后把 `fact.issuer` 设为 root（`crates/dweb-fabric/src/roster.rs:443-472`）。协议/规格要求 Genesis 是 root 自签且不可变，但实现没有强制 `issuer == subject`，也允许携带只应属于其它 kind 的可选字段。

影响不是“普通成员能自行 grant”，而是 **untrusted fact 一旦可达空 roster，根授权即不可恢复地指向攻击者**。现有公共 join 流没有把陌生 regular peer 的 HELLO 送入空 roster，这降低了即时远程攻击面；不过公共 `Roster::merge`、恢复/导入和后续 discovery 增量一旦复用该入口，安全边界即失效。因此不能称单根授权已经 fail-closed。

可验证修复：在入库前把 Genesis shape 固化为 `issuer == subject`、`display_name == None`、`expires_at_ms == None`、`target_fact_id == None`；按 kind 做字段交叉校验，拒绝 `target_fact_id` 非 Revoke 的事实。新增三个负向测试：攻击者 issuer/subject 不同的 Genesis、带 optional 字段的 Genesis、空 attach 先合并伪 Genesis 再合并真 Genesis；三个都必须 quarantine，真 Genesis 必须成为 root。

### P0-2：invite_id “CAS”不是跨进程原子操作

`Roster::consume_invite` 先检查实例内 `HashSet`，append + `sync_all` 后插入该集合（`crates/dweb-fabric/src/roster.rs:810-837`）。这保证单一 `Roster`/进程内串行兑换，但没有 data-dir 独占锁、OS 文件锁、SQLite transaction 或原子 create；两个 `Fabric::open` 指向同目录时可同时观测“未消费”并分别写入/签发 Grant。

可验证修复：启动时为 data dir 获取排他锁，并把“记录 invite_id + Grant”放入同一带崩溃恢复语义的事务/WAL；或明确拒绝第二实例。用两个独立进程同时 redeem 同一 token，断言恰有一个成功、事实集合只有一个对应 Grant、`invites.consumed` 无坏记录；在 append 后人为中断再重启也须保持同一结论。

## 规格轴：新发现的实现缺口

### P1：同步得到 Revoke 后，既有会话没有被主动断开

本地 `Fabric::revoke` 会 remove/close peer（`fabric.rs:274-287`），但通过 HELLO 同步进入的 Revoke 只会走 `merge_and_emit`，该函数仅 merge 和发送 `RosterUpdated`（`:483-491`）。这违反 session spec 的“Revoke 进入本地投影后既有会话被主动断开”（`openspec/.../session/spec.md:28-40`）。

修复应在 merge 前后计算有效成员差集，先从 peers 中摘掉不再有效的 endpoint，再在锁外 `conn.close`；必须避免把旧连接的 watcher 删除新连接。验收为三节点测试：C 从 B 同步到 A 的 Revoke 后，C 与被撤销节点的现有 session 在 deadline 内关闭，重连被拒。

### P1：常规帧协议缺读取 deadline、流配额和协议处置

`read_frame` 使用无限期 `read_exact`（`session.rs:80-98`）；HELLO 无 deadline（`:135-181`）。MSG receiver 串行 `accept_bi -> read_frame`（`fabric.rs:525-553`），一个已认证成员只要开一条 bidi stream 后停在帧头/帧体，后续流就无法读取；其余连接可无限创建 handshake task（`:567-626`）。协议错误还会被静默忽略，连接和流没有统一 reset/close。它既违背 spec 的读取超时与资源边界（session spec `:65-82`），也是易触发的资源耗尽面。

修复：设置 HELLO/MSG 首字节与完整帧 deadline；使用连接级 stream semaphore 和全局 handshake semaphore；对超限、错误类型、超时统一 reset stream 并按阈值 close connection。验收测试应证明一个停滞 MSG 流不阻塞随后正常 MSG，超额流被拒且任务数有上界。

### P1：兑换通道的连接身份与总量语义未闭合

issuer 从 proof payload 读取 `redeemer`（`session.rs:267-272`），没有检查它等于 TLS/iroh 已认证的 `conn.remote_id()`；PoP 只签 fabric/invite/challenge（`protocol.rs:836-849`），缺失此绑定。另一个细节是 `now_ms` 在 accept 任务开始时捕获（`fabric.rs:590-595`），最晚五秒后才用于过期判断，边界 token 可按过期前的旧时间通过。32 KiB 仅为每次 `read_frame` 上限，receipt 写出和整个兑换序列没有累计计数。

修复：要求 `redeemer == conn.remote_id()`，在最终验证时取当前时间，并以一个方向/全连接计数器限制 token、proof、receipt 总字节数。加入 remote-id 不匹配、等待到 token 过期、超过总量 receipt 三个负向测试。

### P1：rendezvous 防重放与互操作不成立

`AnnounceRequest` 只有 timestamp，无 nonce（`rendezvous.rs:55-63`）；canonical bytes 也不包含 nonce（`:99-118`），所以 120 秒接受窗内同一有效请求可重放。规格要求 timestamp + random 防重放。该服务还只接受 64 位 hex endpoint id（`:92-97`），而 SDK 公共 EndpointId 是 52 位 z32；当前仓库没有 client announce/resolve 调用，故它不是可从 SDK 实际使用的“发现辅助”。

修复：在签名域加入 128-bit nonce，以 endpoint+nonce 建立有界、过期的 replay cache；统一接受 z32 或清楚暴露转换；限制 announce/resolve 速率并只接受严格 `SocketAddr`/`RelayUrl`。验收为重放返回冲突、z32 请求可互操作、无效地址拒绝。

### P1：PathChanged 是死事件

`FabricEvent::PathChanged` 和 N-API JSON 映射都存在（`fabric.rs:54-57`、`packages/client-sdk/src/fabric.rs:279-286`），但 `spawn_path_watcher` 只写 `LinkStatus` mutex（`session.rs:108-130`），没有 event sender。因此该 API 永远不能收到路径变化，违反 relay/direct 可观测承诺。

修复：watcher 应接收 endpoint id 与 event sender，并仅在状态变化时 emit；插入 peer 后要读取当前 selected path，以免错过第一个事件。用 mock/真实 path event 验证 direct -> relay 与 relay -> direct 各投递一次。

## 工程与生命周期轴

### P1：N-API 事件泵可静默永久停止，且 SDK E2E 本轮未完成

`broadcast` 容量是 256（`fabric.rs:180`），事件泵将所有 `rx.recv()` 错误都 `break`（`packages/client-sdk/src/fabric.rs:251-256`）。一旦 `Lagged`，此 Fabric 之后永远不再把事件送给 JS。每个 callback 的 `ThreadsafeFunction::call(...NonBlocking)` 结果被忽略（`:291-293`），队列满时消息可静默丢失；callback 没有注销/数量上限，`on()` 还在 Node 调用线程上使用 `blocking_lock()`（`:225-231`）。shutdown 只阻断泵，其他 SDK 方法仍可调用底层 Fabric。

这与实际本轮 `node --test` 不能退出相互印证：不能断言根因完全是事件泵，但该生命周期问题必须先被定位并回归。修复后测试需在有限 timeout 内全绿，并测试超过 256 个事件后的行为（可恢复/显式 overflow 事件，而不是永久沉默）。

### P1：peer map 的锁与替换竞态会破坏连接生命周期

`send` 持有 `peers` async mutex 跨越 `open_bi`、写和 finish 的网络 await（`fabric.rs:380-388`），慢对端可阻塞 disconnect、close watcher 与其它发送。`insert_peer` 对同一 remote 无条件覆盖（`:494-510`）；旧连接关闭 watcher 随后 `remove(&remote)`（`:515-524`）可删掉新连接。`connect` 也没有拨号 in-flight 去重（`:336-361`）。

修复：锁内只 clone `Connection`，然后在锁外 I/O；为 peer entry 加 connection epoch/identity 比较后再 remove；使用 per-peer dialing state。并发两次 connect + 延迟关闭旧连接的测试必须保留新连接。

### P1：SMB 回避加载器新增本地替换和发布污染风险

client/server loader 都使用可预测的 `/tmp/dweb-...-{hash}` 路径，执行 `rmSync -> writeFileSync -> require/spawn`（`packages/client-sdk/index.js:23-36`；`packages/server-binary/index.js:32-52`）。该模式有 symlink/TOCTOU 窗口；server copy 失败后注释称“直接执行”，实际仍 `spawn(binPath)` 而非 `srcBin`。哈希只是由刚读到的源码计算，未校验发布者声明的完整性。更直接的打包问题是 `npm pack --dry-run` 已证明 client tarball 包含不应交付的 `.smbdeleteAAA1410e043` Mach-O（其 `otool -L` 还含开发机绝对 dylib 路径）。

修复：`mkdtemp` 建 0700 私有目录，用 `O_CREAT|O_EXCL|O_NOFOLLOW` 写入后 fsync；失败时明确 spawn/require 源路径；发布包使用 `files` allowlist，CI 解包检查不含 `.smbdelete*`、源码和测试；为二进制维护签名或构建期固定 digest。这个问题在单用户本机的直接利用条件较高，但 npm 交付物不应携带未知可执行文件。

### P1：Docker/CI 供应链和运行时隔离不足

`docker/Dockerfile` 用可变 tag `rust:1.98-slim`、`debian:bookworm-slim`，apt 未版本锁定，最终镜像无 `USER`，服务以 root 运行（`:4,20-22`）。workflow 只 pin action major tag（`.github/workflows/docker.yml:26-46`），无 `id-token: write`、无显式 SBOM、provenance/attestation、镜像签名或消费端 digest 验证。基于当前源码，不能证明 GHCR 的镜像可复现或来自该 commit。

修复：以 digest pin 基础镜像和 action full SHA；最小非 root runtime；产生 SPDX/CycloneDX SBOM 与 GitHub provenance，再用 cosign 以 tag->digest 验证。发布验收记录应包含 `docker inspect` digest、SBOM 和 attestation 验证输出。

### P2：其它可预见问题

- `known_addrs` 只在内存内学习，重启即丢（`fabric.rs:104, 307-320`）；即使成员已知，也可能无法再次拨号。
- `DWEB_RELAY_QUIC_BIND` 当前永远无法启用，Docker 也未公开 UDP；README/镜像标签不能暗示 QUIC relay 可用。
- `issued_at_ms` 不参与有效性下界，未来签发的 Grant/Revoke 会立即生效（`roster.rs:508-535`）；应定义时钟容忍与 `issued_at_ms <= now + skew`。
- 生成的 `index.d.ts` 仍暴露 `=> any`（`packages/client-sdk/index.d.ts:44`），与仓库 TypeScript 规则冲突；并且 JS 测试本身也使用 `@type {any}`（`test/sdk.test.mjs:8`）。
- rendezvous 是进程内 memory registry、公开 resolve、自由字符串地址；作为不可信发现辅助可以接受“结果需 iroh 身份认证”，但应限制枚举/滥用并在部署文档说明地址暴露边界。

## 评分依据与放行条件

相对上轮，独立 ALPN、challenge-response、规范字节/内容寻址、显式寻址、iroh 身份统一、嵌入 relay 和多个 Rust/双进程测试都是真实进展，故从 4.4 升至 **6.0**。扣分集中在两项仍未闭合的 P0 安全不变量、同步撤销会话未关闭、可由成员触发的帧/任务耗尽、N-API 事件可靠性和可验证交付供应链。

建议的最小放行门槛是：先关闭 P0-1、P0-2；随后完成“远端 Revoke 踢现有会话”“普通流 deadline + quota”“SDK node test 有界全绿”三项。Docker/NPM 若作为外部交付物，还应通过私有临时目录、`npm pack` allowlist、镜像 digest/SBOM/provenance 验证。完成后再评审，才适合宣称 P0 已关闭。
