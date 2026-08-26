# fabric-mvp 三轮独立复核

- 复核日期：2026-08-26
- 复核提交：`7b34c27ba90591620ed418501522652a97d2b8b4`（`HEAD` 与该提交一致）
- 上轮基线：二轮报告评分 6.0/10
- 本轮最终评分：**6.7/10**（+0.7）

结论：二轮提出的若干安全修复已真实落地，但不能称“全部处置完成”。Genesis 形状校验、跨实例 invite 文件锁、PoP 对端绑定、epoch、PathChanged 和 Lagged 恢复均存在；然而远程 Revoke 在接收方路径仍不生效，发布的 server-binary npm 包不包含二进制，畸形 invite 仍可能触发 panic。普通帧 deadline/流配额、rendezvous nonce、QUIC UDP 和供应链证明也仍是规格缺口。

## 本轮实际证据

| 验证 | 结果 |
| --- | --- |
| `cargo test --workspace` | 通过，源码实际列出 58 个 Rust 测试：fabric 47、integration 4、facade 3、server 4；另有 0 个 doc-test。 |
| `pnpm -r typecheck` | 通过。 |
| `pnpm --dir packages/client-sdk test` | 通过，3/3；脚本使用 `node --test --test-force-exit`。 |
| `pnpm --dir packages/server-binary test` | 通过，1/1；同样使用 `--test-force-exit`。 |
| `pnpm --dir packages/example test` | 通过，1/1，双进程 relay 场景约 59 秒。 |
| `cargo fmt --all -- --check`、`git diff --check` | 通过。 |
| `npm pack --dry-run --json ./packages/client-sdk` | 通过白名单，只有 `.node`、`index.js`、`index.d.ts`、`package.json`。 |
| `npm pack --dry-run --json ./packages/server-binary` | **失败于交付语义**：仅 5 个文件，没有 `bin/dweb-server-aarch64-apple-darwin`。 |
| CI/GHCR/远端 Docker | 本轮未重新访问远端；仅检查 workflow/Dockerfile 源码，不能把用户陈述当作独立复验。 |

## 处置逐条核验

### P0-1：Genesis 与 kind shape

`crates/dweb-fabric/src/roster.rs:466-498` 已加入交叉校验：Genesis 要求 `issuer == subject` 且无 name/expiry/target，Grant/Join 禁止 `target_fact_id`；47 个 fabric 单测包含三项负向回归（`:1059-1105`），这些代码和测试均真实存在。

但测试 `fake_genesis_first_then_real_real_wins_root`（`:1083-1105`）明确证明：在空 `attach` roster 上，攻击者合法自签且 `issuer==subject` 的 Genesis 仍会先建立 root，真实 Genesis 之后被隔离。也就是说 shape 修复成立，**Genesis 的信任引导仍是“先到先得”**。当前 facade 的 regular HELLO 要先通过成员门控，redeem 又由 root 验证 token，攻击者不易从公开网络把该事实送入空 roster；但 `Roster::merge` 是公开入口，恢复/导入/未来 discovery 若复用它仍会抢根。若接受该边界，必须在 spec 明确“attach 必须只从已认证 issuer 学习 Genesis”；否则仍是 P1 安全设计问题。

**判定：shape 处置成立；单根信任锚定部分成立。**

### P0-2：跨实例单次兑换 CAS

`roster.rs:261-296` 用 `roster.lock` + `libc::flock`，5 秒有界重试；`consume_invite` 在锁内重读 `invites.consumed`、检查、append、`sync_all`（`:864-901`）。这确实消除了二轮中“每个实例只看自己的 HashSet”的竞态。测试 `concurrent_consume_invite_across_instances_is_cas`（`:1107-1130`）用两个独立 `Roster`、两个文件描述符并发消费并断言恰一成功，重启后再次拒绝。

限制仍有三点：测试是同一进程线程而非真正独立进程，且没有在 SMB/NFS 上验证 flock；消费日志与后续 `r.grant()` 不在同一事务中，进程若在 consume fsync 后崩溃会“令牌已烧掉但 Grant 未落盘”；锁竞争在 issuer 持有 Tokio roster mutex 时使用 `std::thread::sleep`，可阻塞一个 runtime worker。

**判定：单 invite 的跨实例 at-most-once 处置成立；崩溃原子性与网络文件系统语义仍为已知边界。**

### PoP 对端绑定与过期时间

`session.rs:248-303` 在 issuer 侧保存 `expected_remote = conn.remote_id()`，拒绝 proof 中声明的其它 EndpointId（`:287-294`）；`redeem_verify` 使用验证时的 `now_ms()`（`:296-307`），不再使用连接任务开始时的旧快照。

**判定：成立。**仍只有单帧 32 KiB 限制，不是整个 redeem 序列的累计字节限制。

## 仍未闭合的问题

### P0/P1：远程 Revoke 在 acceptor 路径仍不会踢会话

`fabric.rs:488-521` 的差集逻辑本身正确：merge 前取投影、merge 后取投影、摘除并 close 失效 peer。但 `session.rs:176-200` 的 `acceptor_hello` 已经先执行 `roster.lock().await.merge(incoming...)`；随后 `fabric.rs:667-673` 再调用 `merge_and_emit(facts)`。因此 `merge_and_emit` 的 before 快照已经包含 Revoke，after 不变，`removed` 为空。只有 dialer 收到 HELLO 的路径能触发差集踢除。

这违反 session spec `openspec/changes/fabric-mvp/specs/fabric/session/spec.md:28-40` 的“Revoke 进入本地投影后既有会话主动断开”。现有 facade E2E 只覆盖 root 本地 revoke，example 也在停 chat 后执行 revoke，未覆盖“被撤销事实由对端作为 acceptor 接收”。

修复：让 `acceptor_hello` 只 decode 并返回 incoming，由 Fabric 统一执行 merge-and-emit；或让 acceptor 返回 merge 前后投影报告，禁止重复 merge。新增强制方向测试：B 主动拨号连接 C，C 已有 B 会话；B 携带 A 的 Revoke 事实，C 收到后在 deadline 内关闭 B，且发出 `PeerDisconnected`。

### P1：发布的 server-binary npm 包无法启动

`packages/server-binary/package.json:27-32` 的 `files` 白名单只有 `index.js`、类型、bin 入口和脚本，没有 `bin/dweb-server-aarch64-apple-darwin`；`.gitignore:11` 也忽略该文件。实际 `npm pack --dry-run --json` entryCount=5，确认 tarball 不含二进制。虽然 workspace 测试先运行 `scripts/pack.mjs`，所以本地测试通过，但从 npm tarball 安装后 `index.js:31` 与 `bin/dweb-server.mjs:18` 都找不到目标文件。

这直接违反 SDK spec `sdk/node:50-57` 以及 design D7“包内直接携带二进制”的交付物承诺，应视为发布阻塞，而不是供应链强化的可选项。

修复：把二进制加入 `files`，发布前取消该路径的忽略或在 CI 生成后显式纳入；用临时目录执行 `npm pack`，解包到干净目录后从包目录调用 `startServer()` 和 bin，断言 healthz 成功。

### P1：畸形 invite 仍可使解析器 panic

`crates/dweb-fabric/src/protocol.rs:674-690` 在检查 relay 字节后直接读取 `bytes[off]`；`:697-705` 在每个 direct address 直接读取 `bytes[off]`。攻击者可构造长度恰好使 `off == bytes.len()` 的 payload：长度检查会通过，下一次索引越界。该解析发生在签名验证之前（`:799-817`），所以“无有效签名”不能保护调用方。Node `join()` 接收到不可信字符串时可能导致任务 panic/进程级拒绝服务，取决于 panic 配置。

修复：每次读取单字节前要求 `bytes.len() > off`，长度计算使用 checked arithmetic；为 relay 无 n_addrs、n_addrs 缺 addr_len、截断 recipient 增加 fuzz/负向测试，并保证所有 malformed token 返回 `ProtocolError::Quarantine` 而不 panic。

### P1：常规会话的 deadline/流配额仍未实现

`session.rs:80-104,152-200` 的 `read_frame`/HELLO 使用无限期 `read_exact`；`fabric.rs:582-610` 的 MSG receiver 串行 `accept_bi` 后读一帧。已认证成员可以打开 bidi 流后停在帧头，永久占住 receiver；入站连接/握手任务也没有全局 semaphore（`:624-682`）。协议错误被静默忽略，未统一 reset/close。

这与 session spec `:65-82` 的读取超时、总量上限和协议错误处理冲突。对可信局域网演示可作为明确的 DoS 边界，但对于“受控邀请后成员可能被撤销/失陷”的应用级组网，不应在公网部署前放行。修复验收应证明停滞流不阻塞后续消息、超额流有上界、HELLO/MSG timeout 后连接可继续或被干净关闭。

### P1：rendezvous 仍没有 nonce 防重放

`crates/dweb-server/src/rendezvous.rs:55-63,99-118` 的请求和规范签名域只有 timestamp；120 秒窗口内相同签名请求可重复提交。server spec `:18-20` 明确要求“时间戳与随机数防重放”。将该 API 标为“不可信辅助”只能降低影响，不能使实现符合当前 spec：攻击者仍可反复覆盖地址造成发现层 DoS/误导，最终 TLS 会拒绝冒充但会浪费拨号。

修复：加入 128-bit nonce 并纳入签名域，以 endpoint+nonce 建立有界过期 replay cache；或者正式修改 spec，把 nonce 降级为 v0.1 非目标，并要求默认关闭/限制 rendezvous。

### P1：客户端类型定义仍与运行时不一致

`packages/client-sdk/index.d.ts:40-44` 已把 `=> any` 改为 `=> void`，但仍声明 `on(callback(err, arg: string))`。`index.js:45-56` 的包装器实际向用户调用 `callback(ev)` 单参数事件对象，并且 `FabricEventJs` 只在注释/JSDoc 中出现，没有导出类型。TypeScript 项目因此无法获得真实事件 union，违反 sdk spec 的“公共 API 类型完备”。

修复：导出 `FabricEventJs`（message 的 `data: Buffer`、peer/roster/path 事件的 discriminated union），将 `on(callback: (event: FabricEventJs) => void)` 写入声明，并让生成/后处理步骤保持一致。补一个使用 `tsc --noEmit` 的 consumer fixture，禁止再次回退到 napi 原始 error-first 字符串签名。

### P2：已修复项仍有边界细节

- watcher epoch 已真实实现于 `fabric.rs:539-578`，旧连接不会误删新连接；主动 remove 后会广播下线。但没有 per-peer dialing 去重，两个并发 `connect` 仍可能先后建立并覆盖。
- PathChanged 已在 `session.rs:115-148` 状态变化时发送，但只响应 `Selected` 事件，插入 peer 时没有用当前 selected path 初始化；早于 watcher 的路径事件可能丢失。
- Lagged 已在 `client-sdk/src/fabric.rs:251-258` 通过 `continue` 恢复；但 TSFN 使用 `NonBlocking` 且忽略返回值（`:294-295`），队列满时仍可静默丢事件，`on()` 没有注销和数量上限，`blocking_lock()` 仍可能阻塞 Node 调用线程。
- `dweb-server` 仍直接依赖 `ed25519-dalek` v2（`crates/dweb-server/Cargo.toml:16-17`），与 D2“全仓不引入第二套 dalek”不一致；应统一 iroh-base 验签或明确服务端独立协议例外。

## 未处置项能否作为 v0.1 放行边界

| 项目 | v0.1 判断 | 放行前提 |
| --- | --- | --- |
| Docker digest pin/SBOM/provenance | 可作为开发版已知边界，不能作为生产安全承诺。 | 文档明确镜像未签名/不可复现；生产发布前必须 digest pin、非 root、SBOM、签名和 provenance。 |
| QUIC UDP 数据面 | **不能宣称完整 relay 拓扑**。当前 `relay.tls=None` 使 `DWEB_RELAY_QUIC_BIND` 永远不启用，Docker 也只 expose TCP。 | 仅以 HTTP/WS relay 作为 v0.1 支持面，并修改 server spec/README；硬 NAT + UDP 要求不能写成已满足。 |
| 普通帧 deadline/流配额 | 仅可信 LAN/演示网络可暂缓；公网或成员不完全可信时不可接受。 | 至少在文档给出威胁模型和部署限制；下一版必须加入 deadline、stream semaphore、错误 reset。 |
| `issued_at_ms` 时钟偏移容忍 | 可接受的低风险边界。root 签名事实仍可信，主要影响提前生效/时间排序。 | 定义最大 clock skew，并将未来事实限制为 `now + skew`，加入测试。 |
| `known_addrs` 不持久化 | 可接受的可用性缺口，不改变授权安全。relay 配置存在时仍可工作；禁 relay 重启后可能无法 connect。 | README 明确需要重新邀请/地址配置，后续持久化地址记录。 |
| rendezvous nonce | 只有在 rendezvous 默认关闭、无 SDK 调用方且 TLS 身份最终校验的受限 v0.1 才能暂缓；按现有 server spec 仍是不符合项。 | 修订 spec 或实现 nonce/replay cache，并限制覆盖/枚举。 |

## 最终评分与放行建议

从 6.0 上升到 **6.7/10** 的依据是：二轮两个 P0 的大部分代码修复真实存在，跨实例消费、对端 PoP、连接代次、路径事件、事件泵恢复和 SMB 私有临时目录都有实现及回归测试，且本轮 58 Rust + 5 Node 测试通过。

扣分依据是：远程撤销接收路径仍违反门控生命周期，server-binary 发布包不可执行，invite 解析器仍有可触发 panic，常规流资源耗尽仍是已知公网 DoS，rendezvous 与 server spec 明确冲突，SDK 类型仍与 wrapper runtime 不一致。建议在“协议内核演示版、仅受信网络、Docker 由操作者自行校验”范围内有限放行；在修复远程 Revoke、npm binary、invite panic 前，不应称为完整 v0.1 发布。
