# connectivity-ux-hardening 实现复审报告（R5）

日期：2026-08-28  
复审对象：当前工作树 `git diff` 与未跟踪文件；本轮只复审实现，不复审文档改写。  
基准：`openspec/changes/connectivity-ux-hardening/` 的 D1-D12、C0 contracts、五个 delta 与 `tasks.md`。

## 结论

评分 **8.0/10**，相对 R4 的 7.6 分上升 0.4。R5 声称的四项修复中，`RosterUpdated` 成功路径守卫、redeem `finish()` 错误进入 silent-close、以及 JSON 错形不再 legacy fallback 均与当前代码一致。redeem 的 P0 关闭语义也覆盖了 accept/read/write/finish/deadline 的 Silent 出口，现有真实连接时延测试与门禁证据相符。

当前仍**不放行**：`connect` 的 single-flight 实现仍不能让等待者订阅 owner 的完成信号，导致任何并发调用确定性等待 30 秒；owner 被取消后 map 中的 Sender 也不会被 Drop，后续调用持续等待超时。这是 R4 P1-2 的实质性未闭合，而不是测试缺口。

门禁证据按用户提供结果接受：workspace cargo test 11 组全绿、clippy `-D warnings` 全绿、SDK/example/opendweb/server-binary JS 分别 12/108/12/5 全绿；当前轻量 `git diff --check` 通过。未重复运行重量级 workspace 构建。

## 阻塞问题

### P1-1：single-flight 等待者等待的是未发送的私有 channel

证据：`crates/dweb-fabric/src/fabric.rs:1241-1274`、`1287-1295`。

每次 `connect()` 一进入 single-flight 都创建自己的 `(tx, rx)`。owner 在 `None` 分支把 `tx` 移进 `Arc` 后放入 map；等待者在 `Some(existing)` 分支只读取并丢弃 `existing`，却继续等待自己新建的 `rx`。这个 `rx` 没有任何发送者会调用 `send(())`，因此：

1. owner 正常完成时，`remove()` 只取出 owner 的 Sender，并通知 owner 自己的 receiver；等待者不会被唤醒，固定等满 30 秒后返回 `concurrent connect timed out`。
2. owner 在 `connect_dial()` 或之后被取消时，map 仍保留 `Arc<oneshot::Sender<()>>`。owner 没有持有可在取消时 Drop 的独立 Sender，等待者的 receiver 也不会收到关闭；该 EndpointId 的后续调用继续命中陈旧 entry 并重复等满 30 秒。
3. `shutdown()` 没有清理或唤醒 `connect_inflight`，所以关闭期间已经注册的 flight 仍可能使调用方等待。

这直接违背“同 EndpointId 并发 connect 共享首飞结果、失败/取消可重试”的设计意图；并发 API 调用会出现确定性长延迟，且取消后会留下永久逻辑航班，故为 P1。

建议把 map value 改为可订阅的共享 flight state（例如 `watch`/共享结果对象，而不是不可 clone 的 oneshot receiver），等待者订阅同一 state；owner 使用带 generation/token 的清理 guard，在成功、失败、取消和 shutdown 时都只清理自己的 entry，并发布完成或可重试失败。补充并发成功、首飞失败、owner cancel、waiter cancel、shutdown 中断和拨号次数/事件次数断言；当前 `facade_e2e` 只有串行 connect，无法发现此问题。

## R5 修复核对

### 1. `RosterUpdated` 事件

`spawn_accept_loop` 在 `fabric.rs:1690-1708` 保存 handler 结果，并仅在 `_res.is_ok()` 时广播。结构化拒绝、Consumed、协议违规、Silent I/O 和 deadline 不会广播事件；成功路径的 grant 已在 roster 锁内提交后才返回 `Ok(())`，语义成立。当前缺少“17 个拒绝行均无 roster-updated”的自动断言，列为测试覆盖 P2。

### 2. redeem 写入与关闭

`session.rs:604-620` 的 `REDEEM_ERR` 和 `REDEEM_OK` 均把 `write_frame` 与 `send.finish()` 错误映射为 `InnerErr::Silent`；`session.rs:625-636` 的统一出口立即 `conn.close`。handler deadline 也直接关闭连接。`redeem_wire` 的 `io_failures_close_within_bound` 覆盖空 bidi、首帧 EOF、截断头，`expect_no_structured_frame` 断言无结构化帧与短时关闭。虽然没有独立的故障注入来让 `finish()` 返回错误，但当前代码已不再吞掉该错误，属于 P2 测试强化而非实现阻塞。

### 3. JSON 形状回退

`packages/example/src/relay-resolve.mjs:46-81` 用 `parseOk` 区分 JSON 解析失败和解析成功；只有 404 或 200 非 JSON 返回 legacy。合法 JSON 的数组、标量、null 在 `manifest === null` 分支抛出 `gateway <url> returned JSON but not a services manifest`。对应测试 `packages/example/test/relay-resolve.test.mjs:94-100` 断言 reject，R4 的反向语义已消失。对象缺少 relay 条目仍按 C0 disabled/unknown-service 语义处理，未与顶层形状错误混淆。

## P0 关闭语义复核

当前 `handle_redeem_as_issuer` 的 Silent/Emitted 分流覆盖：`accept_bi`、首帧和 proof 读取、challenge 写入、协议校验、verify/consume/grant/receipt 编码、两条 `write_frame`、两条 `finish` 以及整体 deadline。Silent 在 handler 内关闭，Emitted 只有记录写完并 finish 后才交 accept loop 有界等待。accept loop 在等待后再关闭连接，避免成功回执或结构化拒绝尚未被对端读取就被 `CONNECTION_CLOSE` 丢弃。此处没有发现新的 P0 绕过；single-flight 是独立的并发 P1。

## D1-D12 与实现对照

- **D1/server**：`services.rs` 的 Host 派生、IPv6 括号剥离、拒绝 unspecified/userinfo/坏端口/控制字符、回退首个非 loopback IPv4、nullable URL、实际 gateway/relay 端口、`no-store`、X-Forwarded-Proto 信任开关、unknown 静默与 duplicate 首项告警均有实现和测试。摘要动态值走 `ascii_escape`。Rust 接口枚举顺序与 JS 排序仍不同，见 P2。
- **D2/D7 bootstrap/proxy**：`relay-resolve.mjs` 保持“规范化 -> 基于原始候选的代理决策 -> 按已决策略解析”的无环状态机；空候选、n0/disabled 短路；auto 混合候选命中代理时对全部候选统一 from-env；可达性接受任意完整 HTTP 响应；legacy fallback 仅限 404/200 非 JSON；环境变量顺序和 undici dispatcher 实现与契约对齐。
- **D3 invite**：`invite_with` 仅信任显式 `advertise_addrs`；relay 为空且地址为空时拒签，`allow_relayless` 独立放行；构造期拒绝 wildcard/端口 0/坏地址并去重保序，未混入运行时 hints。
- **D4 watcher**：`home_relay_status().stream()` 直接消费；任一 relay 在线聚合，首值只入快照，跳变才广播，配置序 tie-break 与 lastError 聚合有纯函数测试；shutdown 对 watcher 做 abort+join。事件泵也由 SDK 保存 JoinHandle 并在 shutdown abort+join。
- **D5/D11 join**：`precheck_join_token` 在目录检查和 seed 消费前执行；DirFabricMismatch 与 issuer 侧 WrongFabric 分离；空路径零拨号；8 码有序归类，探针适用条件与 2 秒诊断预算保持；redeem 外层 `u32_be(1+payload_len)+type+payload`、记录 len 0..255、短读、未知 kind、多记录 reduction 与 12 fixture 由既有读写器驱动测试。
- **D6/D8-D10 config/CLI**：flag > env > file > default、URLS 隐式 custom、空项过滤去重、原子写、权限收紧、`--opt=value`、`~` 展开、TTL/join timeout、三态 proxy、ASCII 稳定前缀均已落地。`buildBanner` 的 Local host/port/version 仍直接插值，虽然有效 bind/version 的正常输入基本是 ASCII。
- **D12/C0**：F 使用 `include_str!` 编译期解析 12 fixture，server/example 共享服务 fixture；JS d.ts 产物声明唯一性已修复。`HttpProxyOptions` 已导出但 `FabricOptions.httpProxy` 仍内联联合类型，和 C0 的别名引用不完全一致。

## Wire、reduction 与 issuer 映射

`session.rs:265-300` 的 `read_frame/write_frame` 与 `contracts/redeem-err.fixtures.json` 的外层字节模型一致，整帧限制使用 `4 + len`。`decode_records` 在外层 payload 边界内逐条消费，kind/len/payload 任一段短读即错误，未知 kind 按长度消费；`reduce` 对恰一条 Consumed、其它单条、多条分别 fail-closed。`redeem_verify_emit` 对当前 `RosterError` 变体无 `_` 通配，避免新增枚举无裁决；17 行机器一致性测试与真实连接行测试仍可定位。

## iroh 同 NodeId workaround 与公共 API

disconnect 排空、3 秒预沉降、HELLO 5 秒上限、干净 close、2.5 秒单次退避重试与本机实证相符，能针对已观察到的同 NodeId 去重窗口降低重拨失败；不应因此判为过度设计。代价是失败重拨可能增加数秒延迟，且 `connect_dial` 对 `endpoint.connect()` 本身没有应用层显式 timeout，主要依赖 iroh 内部地址/传输超时；普通 `connect()` 的资源与时延上界没有本 change 的独立契约测试，列 P2。single-flight 修复后再评估该 workaround 的实际拨号次数。

`FabricConfig.relay_ca_tls: Option<iroh_relay::tls::CaTlsConfig>` 对自签 relay 集成测试确有必要，`None` 保持平台默认根；但公共配置直接暴露上游类型及 `insecure_skip_verify()` 能力，且 SDK 未暴露。若是正式自托管能力，应补公共安全边界文档或改为受限抽象；若仅用于测试，应 feature-gate/test-only。当前为 P2 API 耦合与安全边界风险。

## 测试覆盖与剩余 P2

- **F**：12 fixture、外层 round-trip/负例、reduction、17 行 issuer 行、Silent 关闭时延、frame limit、relay probe、watcher 真 relay 集成均有门禁证据。缺少 single-flight 并发/取消/shutdown 测试（导致 P1 漏洞），也缺 finish 失败注入和拒绝无 roster-updated 断言。
- **E**：108 项覆盖参数解析、配置、proxy 集合决策、n0/disabled、JSON 错形硬错误、config set 保存语义和 ASCII；当前 R5 反向测试已修正。
- **SDK**：12 项覆盖 relayStatus、事件、取消订阅、错误码和构造校验；产物唯一性成立，但 `FabricOptions.httpProxy` 未引用公共 `HttpProxyOptions`，暂无 TypeScript 消费者 `tsc --noEmit` 门禁。
- **S**：25 项覆盖 services fixture、Host 拒绝/回退、nullable、unknown/duplicate、scheme、实际端口和 no-store；跨平台 fallback 顺序和 banner Local 动态值未完整断言。

非阻塞 P2 清单：

1. `join_with_deadline` 的 detached `endpoint.connect` task 未纳入 Fabric shutdown；`connect_inflight` 也应在 shutdown 中清理。
2. `known_addrs` 在目录归属检查前写入，且命中 learned 地址会跳过 custom relay 候选；没有 TTL/容量和优先级契约。
3. `relay_ca_tls` 上游类型/不安全验证能力直接进入公共 Rust API。
4. `FabricOptions.httpProxy` 应引用 `HttpProxyOptions`，并删除或内部化 `HttpProxyUrl`；补最小 TypeScript 编译消费者。
5. `buildBanner` 的 Local host、端口、版本应统一经过 `asciiEscape`；当前有效输入下利用面较小。
6. `index.js` 对 `Native.Fabric.prototype.off` 仍无条件读取；若继续宣称旧二进制兼容，应 feature-detect，否则删除兼容声明。
7. Rust fallback IPv4 取 ifaddrs 首项，JS Network 展示排序后取首项，需共享排序规则或在 D1 明确二者可不同。
8. `fix-dts.mjs` 仍依赖 marker/string replacement，当前产物正确但对 NAPI 生成形状变化较脆。

## 可操作建议与放行判定

1. 先修复 single-flight：共享可订阅完成状态，修正 owner/waiter 的 channel 关系；取消、失败、shutdown 都清理同代 entry 并唤醒等待者。
2. 增加并发 connect 的最小真连接测试：两个调用只能产生一次 `connect_dial` 和一次 `PeerConnected`；owner cancel 后下一次调用必须可重新拨号；shutdown 必须在有 waiter 时返回且不遗留 entry。
3. 保留当前三项已成立修复，并补 finish failure 与拒绝路径事件断言，作为回归门禁。
4. 后续再收口 detached task、known_addrs 优先级/TTL、relay_ca_tls API 边界、d.ts alias、Local banner 转义和 TypeScript consumer 编译检查。

**放行判定：不放行。** P0 兑换关闭语义已闭合，R5 三项修复成立；但 single-flight 等待者必超时与取消后陈旧 entry 会破坏并发连接工作流，仍是合并前必须解决的 P1。

## 评分依据

加分项：redeem 的 Silent/Emitted 分流现在覆盖 finish 和 deadline；真实连接测试验证无帧关闭；JSON fallback 语义与 D2 及反向测试已统一；D1 服务清单、D2/D7 代理状态机、D3 invite 门、D4 watcher、D11 wire/reduction、D12 fixture 之间的主要契约一致；门禁证据完整。

扣分项：single-flight 修复实际接错 receiver，令并发调用确定性超时，取消后还会永久占用逻辑 flight；该路径完全没有并发/取消测试。另有若干公共 API、任务生命周期和跨平台输出一致性的 P2 风险。

最终评分：**8.0/10（R4 7.6，+0.4）**。
