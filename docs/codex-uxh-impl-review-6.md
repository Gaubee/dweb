# connectivity-ux-hardening 实现复审报告（R6）

日期：2026-08-28  
复审对象：当前工作树 `git diff` 与未跟踪文件；本轮只复审实现，不复审文档改写。  
基准：`openspec/changes/connectivity-ux-hardening/` 的 D1-D12、C0 contracts、delta 与 `tasks.md`；R5 实现复审评分 8.0/10。

## 结论

评分 **8.1/10**，相对 R5 **+0.1**。R6 已真实修复正常 single-flight 等待者接错 receiver 的问题：并发调用订阅同一个 `watch::Sender`，成功完成时可同时唤醒，正常路径不会再固定等待 30 秒。兑换通道的 Silent close、D1-D11 主路径、代理 bootstrap、watcher、wire fixture 与门禁证据仍保持对齐。

当前仍**不放行**。single-flight 的取消与 shutdown 交界仍有两个确定性 P1 风险：首飞 owner 被取消时 map 中的逻辑航班不会 Drop；owner 的 post-flight 复查与 `shutdown()` 取得锁的顺序相反，存在可复现的 async mutex 死锁。新增并发测试也没有直接证明 `connect_dial` 只执行一次，无法作为这两条生命周期保证的证据。

门禁证据按用户提供结果接受：workspace cargo test 11 组全绿（含 `dial_after_disconnect` 新并发用例）、clippy `-D warnings` 全绿、SDK/example/opendweb/server-binary JS 分别 12/108/12/5 全绿；本轮未重复运行重量级 workspace 构建。

## 阻塞问题

### P1-1：single-flight owner 取消后遗留永久逻辑航班

证据：`crates/dweb-fabric/src/fabric.rs:1239-1288`，状态字段定义在 `:437-440`。

`connect()` 创建 `(flight_tx, _flight_rx)` 后，在 owner 分支把唯一的 `Sender` 移入 `connect_inflight` 的 `Arc`。owner 没有独立的 RAII guard 或取消清理 finally；只有 `connect_dial().await` 正常返回后 `:1285-1286` 才会 `remove` 并 `send(true)`。因此 owner future 在任意 `connect_dial` await 点被 abort/drop 时，map 仍持有 Sender，等待者的 `changed()` 既不会收到完成值，也不会收到 sender 关闭，只能到 30 秒 timeout 后返回重试错误；后续相同 EndpointId 的调用会持续命中这条陈旧 entry。源码注释声称“owner Drop 自动关闭唤醒”，但当前所有权实际在 map 中，该语义并不成立。

这直接违反 R6 声称的“owner 被取消也唤醒等待者、下一次可重拨”契约，是 P1 而非单纯测试缺口。

建议使用带 generation/token 的 owner guard，guard 的 `Drop` 只删除仍指向自身的 entry 并发送完成/失败信号；成功、失败、取消、shutdown 均走同一收尾函数。增加 owner cancel、首飞失败后重试、waiter cancel 与 shutdown 中断测试。

### P1-2：post-flight 复查与 shutdown 反向锁序可死锁

证据：`crates/dweb-fabric/src/fabric.rs:1271-1278` 与 `:1420-1429`。

owner 声明航班后的复查持有 `peers` guard（`:1273`），发现已有连接时又 `await self.inner.connect_inflight.lock()`（`:1277`）。而 `shutdown()` 先取得 `connect_inflight`（`:1423`），释放该 guard 后才取得 `peers`（`:1428`）。两条路径并发时可形成：

```
connect:  peers -> wait inflight
shutdown: inflight -> wait peers
```

Tokio mutex 不可重入，任一方都不会继续，因此 shutdown 可能永久挂起，且 owner 也不会返回。该路径不依赖网络失败，属于公开生命周期 API 的确定性锁协议错误。

建议在持有 `peers` 时只记录“需要移除航班”的布尔值，先释放 guard，再按统一顺序操作 `connect_inflight`；或规定所有路径始终 `connect_inflight -> peers`。补充并发 `connect`/`shutdown` 回归测试并设置有界断言。

## P0 兑换关闭语义复核

`crates/dweb-fabric/src/session.rs:517-637` 的 `InnerErr::Silent/Emitted` 分流已覆盖 `accept_bi`、首帧/proof 读取、协议校验、challenge/proof 写入、verify/consume/grant、事实编码、REDEEM_ERR/REDEEM_OK 写入、两个 `finish()` 以及整体 deadline。Silent 和 deadline 在 `:625-635` 统一立即 `conn.close()`；Emitted 仅在记录写完且 `finish()` 成功后返回，由 accept loop 有界等待对端读取再关闭。

`spawn_accept_loop` 在 `crates/dweb-fabric/src/fabric.rs:1683-1708` 只对 handler `is_ok()` 广播 `RosterUpdated`，拒绝、Consumed、协议错误、I/O 与 deadline 不再伪造名册事件。`redeem_wire` 的真实连接测试覆盖无 bidi、首帧 EOF、截断头等无帧路径，并断言关闭时延上界。未发现新的 P0 绕过。

## R6 single-flight 复核

已成立的部分：

- `connect_inflight` 的值为 `Arc<watch::Sender<bool>>`；等待者通过 `existing.subscribe()` 订阅同一航班，正常完成不会丢通知。
- owner 完成/失败后移除 entry 并发送完成值；等待者醒来后复查 `peers`，成功幂等返回，失败返回可重试错误。
- `shutdown()` 会 drain map 并唤醒当前等待者。
- `concurrent_connect_single_flight` 是真实双 Fabric 连接测试，两个调用均成功且收到一次 `PeerConnected`。

仍不足的部分：

- owner 取消路径没有 guard，见 P1-1；shutdown drain 只是事后兜底，不能处理普通 future abort。
- shutdown 与 post-flight 复查锁序相反，见 P1-2。
- `crates/dweb-fabric/tests/dial_after_disconnect.rs:78-124` 只统计远端 `PeerConnected` 事件。第二调用也可能在首个连接已建立后走幂等快捷路径，该断言不能严格证明 `connect_dial` 只执行一次；需要可替换 dial hook、屏障或拨号计数器。

## D1-D12 与契约对照

- **D1/server**：`services.rs` 实现 IPv6 Host 拆括号、拒绝 unspecified/userinfo/坏端口/控制字符、回退首个非 loopback IPv4、nullable URL、真实端口、`no-store`、信任代理开关、未知服务静默与重复服务首项告警；摘要动态值走 ASCII 转义。
- **D2/D7 bootstrap/proxy**：example 保持“规范化 -> 原始候选集合代理决策 -> 按已决策略逐项解析”的无环状态机；n0/disabled 短路，auto 混合可达采用统一代理覆盖；环境变量顺序、undici `ProxyAgent`、legacy fallback（仅 404/200 非 JSON）与合法 JSON 错形硬错误均已落地。
- **D3 invite**：仅信任显式 `advertise_addrs`；relay 与直连均为空时拒签，`allow_relayless` 独立放行；wildcard/端口 0/坏地址构造期拒绝并去重保序，不混入运行时 hints。
- **D4 watcher**：消费 `home_relay_status().stream()`；任一 relay online；首值只入快照，后续聚合态跳变才广播；事件 URL tie-break 与 lastError 按配置序；shutdown 对 watcher 和 SDK event pump 做 abort+join。
- **D5/D11 join**：令牌解码/过期/地址规范化早于目录检查；DirFabricMismatch 与 issuer WrongFabric 分离；空路径零拨号；8 码和三类本地豁免按顺序归类；探针条件与 2 秒预算、join/redeem deadline 边界、redeem wire/reduction 与 12 fixture 均有实现。
- **D6/D8-D10 config/CLI**：flag > env > file > default、URLS 隐式 custom、空项过滤去重、原子写、权限收紧、`--opt=value`、`~` 展开、TTL/join timeout、三态 proxy、ASCII 稳定前缀均已覆盖。
- **D12/C0**：F 通过 `include_str!` 编译期解析 12 个 fixture，避免手工副本漂移；issuer 17 行显式 Rust match；S/E/F owner 边界与测试门禁一致。

## R5 P2 清单复核

以下问题仍存在，但当前判断均为 P2，不阻塞本轮放行门槛（前提是先解决上述 P1）：

1. `join_with_deadline` 在 `crates/dweb-fabric/src/fabric.rs:545-559` 使用 detached `endpoint.connect` task；它未纳入 Fabric shutdown，短 deadline 后可能继续运行至 iroh 自身结束。
2. `known_addrs` 在 `:1474-1515` 无 TTL/容量；命中 learned 地址会提前返回，可能跳过本地 custom relay 的候选集合，优先级边界尚未在契约中冻结。
3. `FabricConfig.relay_ca_tls`（`:120-125, 890-891`）直接暴露 `iroh_relay` 上游类型及其 TLS 能力，公共 API 耦合偏重；自签 relay 场景确有需要，建议 feature-gate 或提供受限抽象与安全文档。
4. `packages/client-sdk/index.d.ts:122-130` 的 `FabricOptions.httpProxy` 仍内联联合类型，且额外导出 `HttpProxyUrl`；C0 期望字段引用唯一的 `HttpProxyOptions` alias。语义等价但契约清洁度不足，建议补 TypeScript consumer 编译门禁。
5. `packages/opendweb/bin/opendweb.mjs:124-125` 的 Local host/port/version 尚未统一经过 `asciiEscape`；正常成功输入基本为 ASCII，仍应补齐 D10 的动态值纪律。
6. `packages/client-sdk/index.js:49-64` 无条件读取 `Native.Fabric.prototype.off`；若继续支持旧二进制，应 feature-detect，否则删除旧兼容声明。
7. Rust `primary_non_loopback_ipv4()` 与 JS `networkIPv4s()` 的候选排序规则仍不完全相同，跨平台回退地址可能与横幅首项不同。
8. `packages/client-sdk/scripts/fix-dts.mjs` 仍依赖 marker/string replacement；当前产物唯一且 `node --check` 通过，但对 NAPI 生成形状变化较脆。

## 可操作建议与放行判定

1. 先实现 single-flight owner guard：取消、失败、成功、shutdown 都以同一 generation-safe 清理与广播路径结束。
2. 消除 `peers`/`connect_inflight` 反向锁序，并加入 `connect` 与 `shutdown` 的有界竞态测试。
3. 为 `connect_dial` 增加测试注入点或计数器，验证并发成功、首飞失败重试、owner cancel、waiter cancel、shutdown 中断和拨号次数均符合契约。
4. P1 处理完成后，再收口 detached task、known address TTL/优先级、`relay_ca_tls` API 边界、d.ts alias、Local banner 转义、旧二进制 feature-detect 与 fix-dts 生成器。

**放行判定：不放行。** P0 兑换关闭语义已闭合，R6 正常 single-flight 通知已修复；但 owner 取消泄漏与 shutdown 锁反转仍会破坏并发/关闭工作流，必须在合并前解决。R5 列出的其余项目维持 P2，不单独阻塞放行。

## 评分依据

加分项：共享 `watch` 航班修复了 R5 的正常并发等待者错误；P0 Silent close 覆盖 finish/I/O/deadline；RosterUpdated 成功守卫、D1-D7、D11 wire/reduction、fixture 编译期驱动和全量门禁证据均稳定。

扣分项：owner cancellation 仍会留下陈旧航班；post-flight 复查与 shutdown 的锁序形成反向等待；并发测试未直接证明唯一拨号。故仅相对 R5 小幅上调至 **8.1/10**，尚未达到放行线。
