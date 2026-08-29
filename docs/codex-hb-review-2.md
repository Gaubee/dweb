# hardening-backlog 独立复审报告（R2）

日期：2026-08-29  
复审范围：R1 报告 `docs/codex-hb-review-1.md` 所列修复、当前工作树未提交改动，以及对应 OpenSpec delta。  
门禁：采纳编排者提供的 Rust/JS 全绿、实机探针和 `fix-dts` 幂等证据；按要求未运行 `cargo build/test/clippy`。

## 结论

评分 **7.4/10**，**不放行**。R1 的两个直接 P0 已针对单次关闭流程修复，五项 P1 主体也有代码和回归证据；本轮仍发现四个可触发的 P1：并发 `shutdown()` 没有共享完成态、relay 事件 payload 读取可变快照导致事件与状态错配、启动初始 `online` 与 `activeUrl` 来自非原子观测，以及 N0 预设的实际 relay URL 与对外配置 URL 不一致。因存在未闭合的 P1 且评分低于 8.5，本轮不满足放行线。

## R1 修复逐项核验

### P0-1 userinfo：已闭合

- Rust `validate_public_url` 在 `crates/dweb-server/src/main.rs:105-148` 先拒绝 `#` 与 `@`，再检查 scheme、host、端口、path、query；`http::Uri::host()` 剥离 userinfo 的绕过已被前置 `@` 拦截。
- Rust 回归覆盖凭证段和 host 伪装：`crates/dweb-server/src/main.rs:331-347`。
- 启动顺序在 `crates/dweb-server/src/main.rs:196-224` 中先解析公网 URL，再启动 relay 和绑定 gateway；CLI 对称校验及三个 userinfo 用例位于 `packages/opendweb/bin/opendweb.mjs:87-107`、`packages/opendweb/test/cli.test.mjs:120-146`。

### P0-2 detached connect：原始登记竞态已闭合；并发关闭残余见新增 P1

- `DetachedConnects { shutting_down, tasks }` 在 `crates/dweb-fabric/src/fabric.rs:674-681` 同锁保护；登记在 `:716-730` 看到关闭标志时走本地 `abort` 后 `await`，不再把句柄遗留在表中。
- 关闭侧在 `crates/dweb-fabric/src/fabric.rs:1691-1713` 将置位和 `take(tasks)` 放在同一临界区，并通过 `&mut task` 的 timeout 保留句柄，abort 后再次 join。
- 关闭后登记回归测试 `crates/dweb-fabric/tests/join_classification.rs:508-538` 验证了有界失败和零登记。上述修复消除了 R1 所描述的“spawn 后、登记前被单次 shutdown 漏掉”路径。

### P1-1 known_addrs TTL：按明确裁决闭合

`openspec/changes/hardening-backlog/proposal.md:25-32` 已记录 R2 决策为纯容量 FIFO、不实现 TTL，并与 `openspec/changes/hardening-backlog/specs/fabric/known-addrs-boundary/spec.md:10-25` 一致。实现 `crates/dweb-fabric/src/known_addrs.rs:15-26,34-89` 提供 per-endpoint 1024、全局 65536、插入序淘汰和去重；复杂度注释已改为反映线性查重。

### P1-2 CustomPem + N0Default：已闭合

`FabricConfig::validate` 在 `crates/dweb-fabric/src/fabric.rs:233-247` 对 `CustomPem` 做构造期 PEM 解析，并明确拒绝 `N0Default + CustomPem`，错误包含改用显式 custom relay 的指引。回归 `crates/dweb-fabric/src/fabric.rs:2322-2338` 同时覆盖拒绝组合和合法 custom relay + CustomPem。

### P1-3 破坏性声明：已闭合

`openspec/changes/hardening-backlog/proposal.md:67-76` 明确声明 `FabricConfig.relay_ca_tls` 收窄为 `relay_tls_trust: RelayTlsTrust` 是 Rust 公共 API breaking change，仓库不提供兼容胶水，并说明 JS/npm 面无破坏；同时记录 `N0Default + CustomPem` 构造期拒绝。

### P1-4 尾斜杠与 URL 出口：custom 主路径已闭合；N0 预设残余见新增 P1

- `Fabric::start` 在 `crates/dweb-fabric/src/fabric.rs:1039-1065` 只做可解析性校验，`relay_config_urls` 保存配置原串；`aggregate_relay_status` 在 `:334-369` 仅用 `same_relay_url` 做内部归一化匹配，返回配置原串。
- 实际 relay URL 事件/快照的归一化变体由 `crates/dweb-fabric/src/fabric.rs:2384-2403` 和 `:2137-2147` 回归覆盖。
- invite 令牌在 `crates/dweb-fabric/src/fabric.rs:1291-1305` 使用 custom 配置的原串；`session::endpoint_addr_from_invite` 在 `crates/dweb-fabric/src/session.rs:635-651` 只把令牌 URL 解析为内部 `EndpointAddr`，不会回写令牌。`advertise_addrs` 经 `:260-287` 保留输入字符串，并在 invite 路径原样复制。
- SDK `relayStatus` 包装在 `packages/client-sdk/index.js:86-99` 只做 `undefined -> null`，没有再次规范化。故 R1 所指出的对外尾斜杠漂移已闭合。

### P1-5 fix-dts 尾截断：已闭合（按当前 NAPI 形状）

`packages/client-sdk/scripts/fix-dts.mjs:214-243` 在回收 `TAIL_MARK` 后逐个检查顶层 `RelayOptions`/`RelayStatusJs` 残留，发现未知导出即抛错且在 `:286-294` 写盘前统一校验；`inject-event-types` 在 `:174-190` 对模板过期块整块刷新。编排者提供的合成 `[BrandNewThing]` fail-loud 证据和双跑字节幂等证据与实现一致。

### 非阻塞采纳项：已核对

`release.yml:96-111` 已加入 server-binary/client-sdk 的 `npm pack --dry-run` 清单门禁；`README.md:168,180` 的 SDK 示例和事件说明包含 `activeUrl`；`packages/server-binary/bin/dweb-server.mjs:17-20` 文案已更新为 v0.2。`known_addrs.rs:1-10` 与 `fix-dts.mjs:1-19` 已登记需求意图和日期。

## 新增阻塞问题

### P1-1：并发 `shutdown()` 没有共享完成态

证据：`crates/dweb-fabric/src/fabric.rs:1666-1717`。第一次 `shutdown()` 在 `:1694-1698` 将任务句柄取到局部变量后，可能在 `:1700-1712` 等待最多 5 秒；第二次调用可在此期间拿到同一锁，看到空 `tasks`，直接走到 `:1717` 返回。`shutting_down` 只阻止新登记，不让第二调用等待第一调用的 drain 完成。

SDK 侧更直接：`packages/client-sdk/src/fabric.rs:576-594` 在 `:579-583` 先 `swap(true)`，并发第二个调用立即返回 `Ok(())`，而第一次仍在 `inner.shutdown().await`，事件泵也尚未在 `:588-592` abort。这样第二个调用的返回不满足“shutdown 完成后无任务残留/无后续事件”的完成语义。

可验证修复：为 Fabric 增加 `Running -> Draining -> Done` 的共享状态（或共享 shutdown future/`Notify`）；只有执行 drain 的调用转为 `Done`，其余调用等待同一个完成通知。SDK 不应在异步 drain 前把 `shutdown_done` 标记为完成；并增加同一实例 `Promise.all([f.shutdown(), f.shutdown()])` 与 detached task 仍在等待时的回归测试。

### P1-2：relay 事件 payload 从可变快照读取，存在事件/状态错配

证据：watcher 在 `crates/dweb-fabric/src/fabric.rs:920-940` 先写入共享快照 `:923-927`，再只发送不带快照的 `FabricEvent::RelayOnline/RelayOffline`。SDK 事件泵在 `packages/client-sdk/src/fabric.rs:616-663` 收到事件后才读取当前快照；在 watcher 连续产生 online -> offline（或反向）且泵尚未调度时，`relay-online` 可携带后续的 `online: false, activeUrl: null`，反之亦然。该行为违反 `openspec/changes/hardening-backlog/contracts/client-sdk.d.ts.md:22-24` 所冻结的“事件 payload 与快照同构”以及 `activeUrl` 约束 `:15-18`。

可验证修复：在事件发送时把拥有所有权的 `RelayStatusSnapshot`（或已序列化 relay payload）与事件一起入队，SDK 直接使用事件携带的那份快照；不要在消费时重新读取共享可变快照。增加快速连续状态跳变的确定性泵测试，断言每个事件的 `online`、`activeUrl` 与事件类型一致。

### P1-3：启动初始快照的 `online` 与 `activeUrl` 不是同一次观测

证据：`crates/dweb-fabric/src/fabric.rs:1101-1110` 以独立的 `endpoint.online()`（10 秒 timeout）决定 `initial_online`，随后 `:1123-1129` 新建 watcher、读取另一时刻的 `get()` 并单独聚合 `initial_active_url`。relay 在两次观测之间掉线或上线时，会产生 `online: Some(true), active_url: None` 或 `online: Some(false), active_url: Some(...)`。这违反 `RelayStatusSnapshot` 自身在 `:303-307` 写明的约束及 C0.2 `activeUrl` 契约。

可验证修复：以同一个 watcher 值计算 `RelayAggregate`，用其 `online` 和 `online_url` 同时初始化快照；若仍需要 `endpoint.online()` 的 10 秒等待，只把它作为等待触发，不要再把其独立结果写入 `online`。补充 online/activeUrl 成对不变量和启动交错测试。

### P1-4：N0 预设的实际 relay URL 会绕过配置原串契约

证据：`crates/dweb-fabric/src/fabric.rs:1056-1065` 将 N0 快照/事件候选固定为单一 `https://relay.iroh.network`，但 `:1079` 通过 `Endpoint::builder(iroh::endpoint::presets::N0)` 启用 iroh 的区域默认 relay map（当前依赖 `/Users/kzf/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/iroh-1.1.0/src/defaults.rs:35-42` 实际列出四个区域 relay）。聚合在 `:339-343` 对“配置中不存在但 watcher 报告已连接”的状态走 fallback，直接返回 watcher 的实际区域 URL；因此 N0 在线时 `RelayStatusSnapshot.active_url`/`relay-online` 可能是 `https://use1-1.relay.n0.iroh.link./` 等并不在 `urls` 中的字符串。invite 仍在 `:1291-1295` 携带 `https://relay.iroh.network`，同一 Fabric 的配置、令牌和状态出口由此不一致，且不满足 activeUrl 必须为配置序候选的契约。

可验证修复：为 N0 使用与实际 `RelayMode::Default` 完全相同的 relay URL 列表（并保持每条原串），或把 N0 的 canonical alias 映射关系显式建模，在聚合 fallback 时将实际区域状态映射回 canonical 配置串；补充 N0 多 relay 状态 fixture，断言 `activeUrl` 必须出现在 `urls` 且 invite relay URL 与状态契约一致。

## 非阻塞观察

- `crates/dweb-server/src/main.rs:196-212` 仍先解析 relay bind，再解析公网 URL；这不会越过 relay 启动或 gateway bind，但 malformed bind 可能先于非法公网 URL 报错，属于错误优先级的一致性细节。
- `packages/client-sdk/scripts/fix-dts.mjs:226-231` 的 fail-loud 扫描覆盖当前 NAPI 的 interface/type/class/const/function/declare 形状；若未来生成器引入 `export namespace` 或 export-list 形状，应扩展声明解析器，否则会回到字符串形状依赖。当前已知产物不构成阻塞。
- 主 SDK 规格 `openspec/specs/sdk/node/spec.md:43` 仍以旧字段列表描述 relay payload；当前 change 的 C0.2 contract 已记录 `activeUrl`，归档/同步主规格时应一并更新。

## 评分依据与上轮变化

加分项：userinfo 的 Rust/CLI 双侧拒绝和启动前校验可对照；detached task 的登记所有权、abort 后 join 和单次关闭竞态已实质修复；FIFO 边界、TLS 组合拒绝、破坏性声明、配置原串保持、invite/advertise 出口、d.ts fail-loud 均有明确代码证据；用户提供的全套门禁为绿。

扣分项：并发 shutdown 返回值仍可能早于实际 drain；relay 事件 payload 不是事件时刻的不可变快照；启动快照存在 online/activeUrl 矛盾窗口。前两项可由并发/快速跳变回归直接构造，启动项可由观测交错注入构造；当前正常 relay 探针不能覆盖这些边界。

上轮 **5.8/10** → 本轮 **7.4/10（+1.6）**：两个 P0 已降级为无直接 P0，但上述四项 P1 使本轮仍不达 8.5 放行线。
