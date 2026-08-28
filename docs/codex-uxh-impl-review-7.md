# connectivity-ux-hardening 实现复审报告（R7）

日期：2026-08-28  
复审对象：当前工作树 `git diff` 与未跟踪文件；本轮只复审实现。  
基准：R6 报告 `docs/codex-uxh-impl-review-6.md`（8.1/10），对照 change 的 D1-D12、C0 contracts、delta 与 tasks。

## 结论

评分 **8.4/10**，相对 R6 **+0.3**。R7 的锁序修复成立：post-flight 复查已在释放 `peers` 后再访问 `connect_inflight`，与 shutdown 的顺序不再嵌套反向持锁；正常 single-flight 仍使用同一共享 `watch::Sender`。兑换 Silent close、RosterUpdated 成功守卫、D1-D7、D11 wire/reduction、SDK pump/watcher shutdown 与门禁证据均保持稳定。

当前仍**不放行**。`FlightGuard` 只部分覆盖 owner 生命周期，取消竞态仍可遗留或误清理航班；此外 bootstrap 对“合法 JSON 对象但缺少/错误的 `services` 数组”静默降级为 disabled，掩盖了 malformed manifest。这两项会使并发连接与 relay 配置诊断偏离 C0/D1-D2 契约，属于 P1。

门禁证据按用户提供结果接受：workspace cargo test 11 组全绿（`dial_after_disconnect` 3 组含新并发/关闭测试）、clippy `-D warnings` 全绿、SDK/example/opendweb/server-binary JS 为 12/108/12/5；本轮未重复重量级 workspace 构建。轻量验证 `resolveOneRelay(... body: "{}")` 的当前结果为 `disabled / gateway ... lists no relay service`，与下述 schema 风险一致。

## 阻塞问题

### P1-1：FlightGuard 未覆盖完整取消窗口，且清理不是 generation-safe

证据：`crates/dweb-fabric/src/fabric.rs:1243-1312`。

航班 entry 在 `:1267` 插入，但 `FlightGuard` 到 `:1306` 才构造。owner 在插入后等待 `peers.lock().await`（`:1275-1280`）期间被 abort/drop 时，guard 尚不存在，entry 没有任何清理者。即使进入 guard，`Drop` 只用 `connect_inflight.try_lock()`（`:1294-1303`）；只要 shutdown 或另一个 connect 短暂持有该 mutex，try-lock 失败便静默返回，后续没有重试或可靠的异步清理。下次相同 EndpointId 的调用会订阅陈旧 sender 并等待 30 秒。

清理还只按 `EndpointId` 删除，没有校验“entry 仍是本次航班”。shutdown 会 drain 旧 owner 的 entry，但没有取消 owner；旧 owner 随后结束时，其 guard 可能删除 shutdown 之后新建的同 id 航班并错误唤醒其等待者。代码注释所称“entry 已不可达或对端已见完成”不是由实现保证的。

这仍是 R6 P1-1 的实质性未闭合，新增 `connect_and_shutdown_no_deadlock` 不能覆盖 owner abort、try-lock 竞争或旧 owner/新 owner 代次冲突。

建议：在 map 中存带唯一 generation 的 flight state；owner 在插入前后立即拥有 guard，guard 的 Drop 只删除指向自身 generation 的 entry。Drop 不应把清理寄托于可能失败的 `try_lock`，可由 owner task 的 finally/专用清理任务完成，shutdown 则标记/取消所有 owner。补充 owner cancel、try-lock 竞争、shutdown 后重拨、首飞失败重试和等待者取消测试，并断言后续调用可立即重拨。

### P1-2：合法 JSON 的 malformed manifest 被静默当作 disabled

证据：`packages/example/src/relay-resolve.mjs:52-80`；D1/D2 契约见 `openspec/changes/connectivity-ux-hardening/design.md:133-153,217-235` 与 `specs/example-app/spec.md:105-107`。

当前逻辑仅把顶层 JSON 非对象判为硬错误（`:57-67`），随后对对象执行：

```js
const services = Array.isArray(manifest.services) ? manifest.services : [];
```

因此 `200 {}`, `200 {"services": null}` 或错误类型的 `services` 都返回 `disabled`。D1 冻结的 services.json 是带 required `server/version/gateway/services` 的 manifest；D2 只允许 `404` 或 `200 + 非 JSON` 回退 legacy，合法 JSON 但不符合 manifest 形状不应被静默转换为 disabled。该行为会把网关协议/部署错误隐藏成“relay disabled”，正好重现本 change 要消除的静默诊断问题。

建议在解析层区分：缺失或非数组 `services` 直接抛出 `gateway <url> returned invalid services manifest`；数组为空或无 relay 条目仍按既定 disabled 信号处理；已知 relay 条目的字段类型继续按 nullable/scheme 规则校验。补充 `{}`, `services:null`、缺失 required 字段的 mock 场景，并确保 resolveRelayUrls 整体以非零退出。

## R7 修复核对

### 锁序与关闭测试

- `connect()` 的 post-flight 复查在 `:1275-1280` 的内部 block 中释放 `peers`，随后才在 `:1282` 访问 `connect_inflight`；R6 报告的实际嵌套反向锁序已消失。
- `shutdown()` 仍按 `connect_inflight` drain 后再锁 `peers`（`:1447-1455`），当前没有与之同时持有另一把锁的路径，因此不再列为 P1 死锁。
- `connect_and_shutdown_no_deadlock`（`crates/dweb-fabric/tests/dial_after_disconnect.rs:130-164`）提供 10 秒有界断言，但没有 barrier/锁注入来强制 owner 与 shutdown 的临界区交错；它是回归烟雾测试，不是锁协议证明。

### Single-flight 正常路径

- 等待者使用 `existing.subscribe()`，owner 正常完成/失败后 `remove + send(true)`，成功后等待者复查 `peers` 并幂等返回。
- `concurrent_connect_single_flight` 是真实连接测试，两个调用成功且远端收到一次 `PeerConnected`。
- 该测试只统计事件；没有 dial hook/计数器/屏障，无法排除第二调用在首连接完成后走幂等快捷路径，不能单独证明 `connect_dial` 恰好执行一次。

## P0 兑换关闭语义复核

`crates/dweb-fabric/src/session.rs:517-637` 的 `InnerErr::Silent/Emitted` 仍覆盖 accept/read/write/finish、协议错误、grant/编码、I/O 与 deadline。Silent 和 deadline 立即 `conn.close()`；Emitted 在结构化记录写完并 `finish()` 后交 accept loop 有界等待。`fabric.rs:1683-1708` 仅对成功 handler 广播 `RosterUpdated`，拒绝、Consumed、协议/I/O/deadline 不再伪造事件。R7 未引入 P0 回归。

## D1-D12、C0 与测试 owner 对照

- **D1/S**：Host IPv6 拆分、拒绝集合、非 loopback 回退、nullable URL、实际端口、no-store、代理 scheme 信任、unknown/duplicate 与 ASCII 摘要均有实现和测试；横幅 Local 动态值未完整转义仍列 P2。
- **D2/D7/E**：规范化 -> 原始候选集合代理决策 -> 已决策略解析的无环状态机成立；n0/disabled 短路、代理覆盖、404/200 非 JSON fallback、JSON 非对象硬错成立。P1-2 是剩余 manifest shape 缺口。
- **D3/F**：显式 advertise 地址、relayless 门、allowRelayless 逃生阀、wildcard/端口校验和不混入 runtime hints 均对齐。
- **D4/F/SDK**：`home_relay_status().stream()`、任一 online、首值只进快照、跳变广播、配置序 tie-break/lastError、watcher 与 JS pump abort+join 均对齐。
- **D5/D11/F**：DirFabricMismatch 与 issuer WrongFabric 分离；令牌错误优先；8 码及三类本地豁免、探针、deadline 边界、外层 `u32_be(1+payload_len)`、记录 0..255、短读/未知/多记录 reduction 与 12 fixture 均有实现。
- **D6/D8-D10/E/S**：配置优先级、URLS 隐式 custom、逗号过滤、事务写入、`--opt=value`、`~` 展开、TTL/join timeout、proxy 三态和 ASCII 稳定前缀均已覆盖。
- **D12/C0**：S/E/F 文件 owner 与整合边界清晰；fixture 以 `include_str!` 编译期驱动；issuer 17 行显式 Rust match。R7 新测试尚未覆盖 guard cancellation 的 owner 契约。

## R6 P2 清单最终判断

以下项目仍可保留为 P2，不单独阻塞放行（P1-1/P1-2 先修复）：

1. detached `endpoint.connect` task 未纳入 Fabric shutdown；短 deadline 后可能继续运行至 iroh 自身结束。
2. `known_addrs` 无 TTL/容量，且命中 learned 地址会跳过本地 custom relay 候选，优先级尚未冻结。
3. `relay_ca_tls` 直接暴露 `iroh_relay` 上游类型及 TLS 能力，建议 feature-gate 或受限抽象并补安全文档。
4. d.ts 的 `FabricOptions.httpProxy` 仍内联联合类型，且保留 `HttpProxyUrl`；应改为唯一 `HttpProxyOptions` alias 并补 TypeScript consumer 编译门禁。
5. `buildBanner` Local host/port/version 尚未统一 `asciiEscape`；正常有效输入通常为 ASCII，但 D10 要求仍未完全落实。
6. `index.js` 对旧二进制的 `Native.Fabric.prototype.off` 无 feature-detect；需在兼容声明与实现之间择一收口。
7. Rust 与 JS 的首个非 loopback IPv4 选择顺序规则仍可能不同。
8. `fix-dts.mjs` 仍依赖 marker/string replacement；当前产物唯一、`node --check` 通过，但生成形状变化时较脆。

## 可操作建议与放行判定

1. 把 owner guard 的创建移到航班插入的同一所有权协议内，使用 generation-safe state；确保 Drop/abort/正常返回/shutdown 都能可靠清理，不能以无重试 `try_lock` 作为唯一取消路径。
2. 对 gateway manifest 做 required-field/schema 校验，新增缺失 `services`、`services:null` 与错误类型测试；保留空数组/无 relay 条目的 disabled 语义。
3. 用可替换 dial hook 或受控 listener/barrier 直接断言一次拨号；新增 owner cancel、shutdown 后重拨和旧 owner 不得删除新 flight 的测试。

**放行判定：不放行。** R6 的锁反转已修复，正常 single-flight 与 P0 兑换关闭路径成立；但 owner cancellation 清理仍不可靠，且 malformed gateway manifest 会静默 disabled，两个 P1 必须在合并前处理。R6 其余清单维持 P2，不单独阻塞放行。

## 评分依据

加分项：R7 去除了实际嵌套锁等待，新增 shutdown 有界回归；共享 watch 航班、P0 Silent close、D1-D7、D11 wire、fixture 编译期驱动和门禁证据持续一致。

扣分项：FlightGuard 的创建/try-lock 竞态仍可留下陈旧航班，并缺 generation 保护；D2 对缺失 `services` 的合法 JSON 对象缺少硬 schema 校验；并发测试没有直接证明唯一拨号。因此相对 R6 上调至 **8.4/10**，但未达到放行线。
