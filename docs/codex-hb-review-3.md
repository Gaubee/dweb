# hardening-backlog 独立复审报告（R3）

日期：2026-08-29  
复审范围：R2 报告 `docs/codex-hb-review-2.md` 所列四个新增 P1 的当前工作树修复，以及相关测试、SDK 契约和 N0 配置。  
门禁：采纳编排者提供的 Rust/JS 全绿和实机探针证据；按要求未运行 `cargo build/test/clippy`。

## 结论

评分 **7.8/10**，**不放行**。R2-P1-2（事件快照）、R2-P1-3（启动单观测）和 R2-P1-4（N0 真实 relay 列表）已由代码闭合；R2-P1-1 的并发等待主体已实现，但完成门仍有确定性的顺序调用死锁和 Future 取消永久等待路径。另发现普通 `connect()` 可越过一次性 shutdown drain 新登记，完成门不覆盖该航班。

## R2 四项修复核验

### R2-P1-1：并发 shutdown 共享完成门，部分闭合

- 正向路径正确：Rust 首调用在 `crates/dweb-fabric/src/fabric.rs:1708-1715` 置位，晚到调用在 `:1717-1722` 订阅并等待；SDK 在 `packages/client-sdk/src/fabric.rs:586-601` 做同构等待，完成后 Rust/SDK 分别在 `:1773-1775`、`:613-615` 发通知。
- detached join 登记互斥正确：登记侧在 `crates/dweb-fabric/src/fabric.rs:742-756` 只在同步锁块内判断 `shutting_down`，晚到句柄本地 `abort` 后 `await`；关闭侧在 `:1750-1755` 同锁置位并 take，未发现 R2-P0-2 的“spawn 后、登记前漏收”窗口。
- 但完成门有本轮阻塞问题，见下方 P1-1。现有回归仅覆盖并发调用（`crates/dweb-fabric/tests/join_classification.rs:508-543`、`packages/client-sdk/test/new-api.test.mjs:120-129`），没有覆盖顺序第二次调用或首调用取消。

### R2-P1-2：事件携带快照副本，已闭合

`FabricEvent::RelayOnline/RelayOffline` 已携带 `RelayStatusSnapshot`（`crates/dweb-fabric/src/fabric.rs:439-448`）。watch loop 在同一锁块写入并 clone 跳变后快照，再发送事件（`:946-968`）；SDK 泵直接序列化事件内副本（`packages/client-sdk/src/fabric.rs:675-685`），不再读取共享快照。Rust 回归断言 online/activeUrl 配对（`:2489-2502`）。

`relay_status()` 返回的是调用时刻的最新 clone（`crates/dweb-fabric/src/fabric.rs:1250-1254`），因此它可能晚于事件而不同；这是“事件历史快照、查询当前状态”的允许时序，不构成错配。

### R2-P1-3：初始快照单观测，已闭合

`endpoint.online()` 的 10 秒等待结果已纯粹作为沉降触发且丢弃（`crates/dweb-fabric/src/fabric.rs:1134-1140`）。初始 `online`、`active_url`、`last_error` 均从同一个 `home_relay_status().get()` 聚合结果产生（`:1150-1171`），并由 `snapshot_invariant` 约束 `active_url` 与 online 的一致性（`:363-367`）。

### R2-P1-4：N0 真实 relay 列表同源，已闭合

`n0_default_urls()` 直接读取 `iroh::defaults::prod::default_relay_map().urls()` 并排序（`crates/dweb-fabric/src/fabric.rs:369-380`）。该列表同时用于启动快照（`:1093-1098`）、拨号候选（`:1808-1815`）和 invite issuer relay（`:1327-1332`）；因此正常 watcher 状态下 `active_url` 落在 `urls` 内，邀请和状态使用同一 URL 体系。example 配置层 N0 的 `urls` 已置空并更新展示文案（`packages/example/src/config.mjs:225-230,304-306`），单元层覆盖真实列表合并（`crates/dweb-fabric/src/fabric.rs:2334-2346`）。外网 N0 探针未运行，接受用户给出的单元证据边界。

## 新增阻塞问题

### P1-1：完成门会因无订阅者或首个 Future 取消而永久等待

**确定性顺序死锁（Rust API）：** `FabricInner` 只保存 `watch::Sender`，初始化时丢弃 receiver（`crates/dweb-fabric/src/fabric.rs:1201-1205`）。首次 `shutdown()` 在 `:1708-1715` 置位后完成时调用 `shutdown_done.send(true)`（`:1773-1775`）。Tokio `watch::Sender::send` 在 receiver 数为零时返回错误且不会把值提供给未来订阅者（依赖源码 `/Users/kzf/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.52.3/src/sync/watch.rs:1048-1057,1064-1068`）。所以单独完成第一次 Rust `shutdown()` 后，第二次调用订阅到初值 `false` 并在 `:1717-1722` 永久等待。

**取消路径（Rust/SDK）：** 首调用在置位后任一 `.await` 被取消，代码没有 RAII/后台 owner/finally 恢复或发送完成通知；Rust 后续调用仍会在 `:1717-1722` 等待，SDK 首调用在 `packages/client-sdk/src/fabric.rs:586-605` 写入 `shutdown_gate` 后被取消，后续调用在 `:596-601` 永久等待。SDK 持久 receiver 只避免了“无订阅者”的顺序问题，不能解决取消问题。

可验证修复：完成通知使用 `send_replace(true)`（或保留永久 receiver/显式 `Done` 原子状态），并把 drain 交给可取消安全的共享后台任务/状态机，使 owner Future 被 drop 也能完成并放行等待者。增加两项有界回归：`shutdown().await` 后再次 `shutdown()`；在 drain 中取消首调用后再次 `shutdown()` 必须在 deadline 内返回。

### P1-2：普通 connect 可在 shutdown drain 后新登记，未纳入完成门

shutdown 只在 `crates/dweb-fabric/src/fabric.rs:1724-1731` drain 一次 `connect_inflight`；普通 `connect()` 随后仍可在 `:1529-1557` 插入新的 single-flight，整个入口没有 `shutdown_started`/Draining 检查。其 owner 进入 `connect_dial()`，底层 `endpoint.connect()` 没有自身 timeout（`:1601-1609`），且 shutdown 不再等待该 owner 的 guard 清理。常见情况下 endpoint 关闭会让拨号失败，但在关闭窗口中若握手/`register_dialed` 已推进，可能在 peers 已关闭后插入新 peer、发送事件，或让航班/等待者越过完成通知仍存活。

可验证修复：将 lifecycle 状态与 `connect_inflight` 登记置于同一临界区，进入 Draining 后拒绝新的 `connect()`；或把所有 owner 航班纳入共享 drain，并在完成门发送前确认 map 为空、owner 已退出。增加 shutdown 与并发 connect 的确定性阻塞 fixture，断言返回后无航班、无新 peer、无后续事件。

## 非阻塞残留

- 主规格仍未同步 activeUrl/N0 多 relay：`openspec/specs/sdk/node/spec.md:41-43,80-83` 仍只列旧 relay payload，并冻结单条 `https://relay.iroh.network`；当前 delta 契约已改为 activeUrl 和四个官方 URL。该残留在归档/同步主规格时必须修正，但不新增运行时 P1。
- `relay_snapshot_handle()`（`crates/dweb-fabric/src/fabric.rs:1256-1259`）在 SDK 改为事件副本后已无仓内调用，仍暴露可变快照 Arc；建议删除或限制为明确内部接口，避免绕过事件时刻快照语义。

## 评分与上轮变化

相对 R2 的加分：事件 payload 已成为不可变事件时刻副本；启动三字段来自一次聚合观测；N0 快照、拨号和 invite 已同源；detached join 的登记/abort/join 互斥路径闭合，且用户提供的门禁全绿。

扣分：完成门存在确定性的 Rust 顺序调用永久等待和 Rust/SDK 首调用取消永久等待；普通 connect 的新航班仍可能越过 shutdown 完成门；主规格尚有契约残留。R2 **7.4** → R3 **7.8（+0.4）**。当前无 P0，但仍有 P1，未达到 `>=8.5` 放行线，**不放行**。
