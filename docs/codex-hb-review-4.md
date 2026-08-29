# hardening-backlog 独立复审报告（R4）

日期：2026-08-29  
复审范围：R3 报告 `docs/codex-hb-review-3.md` 所列两个 P1 的当前工作树修复，以及相关回归、SDK 绑定和生命周期契约。  
门禁：采纳编排者提供的 Rust/JS 全绿与实机探针证据；按要求未运行 `cargo build/test/clippy`。

## 结论

评分 **8.1/10**，**不放行**。R3-P1-1 的 Rust/SDK 完成门和首调用取消语义已闭合；R3-P1-2 的 `connect()` 拒绝入口虽已加入，但 admission 与航班登记仍非原子，关闭完成后仍存在普通 connect owner 继续运行并产生 peer/事件的确定性竞态。本轮未发现 P0，仍有一个 P1，未达到 `>=8.5` 放行线。

## R3-P1-1：shutdown 完成门与取消

### Rust：已闭合

- `crates/dweb-fabric/src/fabric.rs:1779-1786` 用 `shutdown_started` 只选出首个 drain owner；后续调用订阅同一 `watch` 完成门并在 `:1788-1793` 等待。
- 首个调用把 `shutdown_drain(inner)` 放入 `tokio::spawn`（`:1795-1804`）。调用方唯一的异步等待是 `drain.await`；调用方 Future 被 drop 时只是丢弃 JoinHandle，Tokio 的已 spawn 任务仍继续运行。当前代码没有对该后台句柄执行 `abort` 的路径；只有运行时整体销毁或外部取得句柄后显式 abort 才会终止它，这属于进程终止边界。
- drain 主体在 `crates/dweb-fabric/src/fabric.rs:384-448` 完成航班唤醒、peer/watcher/endpoint 收尾，并以 `send_replace(true)` 写入完成值。即使当时没有订阅者，值也被保留，顺序第二次调用可在 `:1789-1792` 立即观察到 `true`。

### SDK：已闭合

- `packages/client-sdk/src/fabric.rs:587-603` 以 `shutdown_gate` 选 owner，晚到调用读取持久的 `watch::Receiver`；`:604-624` 将内核 drain、事件泵 abort+join 和 `send_replace(true)` 放入后台任务。
- `pump_handle` 已是 `Arc<Mutex<Option<JoinHandle<()>>>>`（`:319-324`），后台任务可安全取得所有权；`inner`、句柄和完成 Sender 均随 `tokio::spawn` move，满足 Send 约束。正常路径没有任何地方 abort drain 任务。

### 证据边界

Rust 新回归 `crates/dweb-fabric/tests/join_classification.rs:544-593` 覆盖顺序二调和后续调用，但取消子场景使用 relay disabled 的空 Fabric（`:556-587`），首次 shutdown 很可能在 100ms sleep 前已完成，因此 `owner.abort()` 不一定真的取消了 drain 等待；它证明不了“正在 drain 时取消首调”。这是测试覆盖缺口，不改变上述后台任务的运行时语义。

## R3-P1-2：connect 越过完成门（未完全闭合）

### P1-1：admission 与登记存在竞态，完成门不保证无普通 connect owner

证据：`crates/dweb-fabric/src/fabric.rs:1557-1565,1599-1629,1645-1647` 与 `:384-405`。

1. `connect()` 在 `:1561-1564` 读取 `shutdown_started` 后立即释放 std 锁，随后还要跨 `roster.lock().await`、`peers.lock().await`，最后才在 `connect_inflight.lock().await` 内插入航班（`:1599-1629`）。
2. `shutdown_drain()` 先在 `:389-393` drain 并清空 `connect_inflight`，再用 `:395-405` 只在“表非空”时轮询。表被 drain 为空后，该循环没有额外的关闭登记窗口保护。
3. 因此可出现：connect 先读到 `false` 后被 roster/peers 调度挂起；shutdown 置位并 drain 空表、走过空表检查；connect 恢复后仍插入 owner。即使没有迟到插入，已经在表中的普通 connect owner 也被 `drain()` 移除，shutdown 不持有其 JoinHandle，`connect_dial()` 仍可继续。

endpoint 关闭通常会让拨号快速失败，但不是完成门的严格保证：若 owner 已经取得连接并推进到 `register_dialed()`，`insert_peer()` 会在 `crates/dweb-fabric/src/fabric.rs:1898-1907,1965-1974` 写入 peer 并发送 `PeerConnected`。该动作可能发生在 shutdown 关闭 peers/endpoint 之后，甚至在 `send_replace(true)`（`:447-448`）之后，违反“完成后无航班、无新 peer、无后续事件”的生命周期契约。

修复边界应是：让 `shutdown_started` 与 `connect_inflight` admission 使用同一把锁，在登记临界区二次拒绝 Draining；并对已登记 owner 保留可等待的所有权（或显式取消并 join），只有 owner 退出且表确实为空后才发送完成通知。需要一个能阻塞 roster/peers 或 HELLO 的确定性并发 fixture，断言 shutdown 返回后无 owner、无新 peer、无事件。

## 其他观察

- 未发现新的 P0；规范轴也未发现本轮新增的硬性风格违规。
- `openspec/specs/sdk/node/spec.md` 与主规格的 activeUrl/N0 列表同步仍按编排说明留待归档步骤，不是本轮运行时阻塞。
- `relay_snapshot_handle()` 已从源码公共面移除，SDK 事件改用事件内快照副本，R3 对应非阻塞项已落实。

## 评分与上轮变化

相对 R3 **7.8**，本轮 **8.1（+0.3）**：完成门从“无订阅者丢值/首调取消挂死”改为后台 drain + `send_replace`，Rust 与 SDK 的句柄所有权和正常取消路径均成立；但 `connect()` 的检查与登记仍跨异步锁，且 drain 后的空表轮询不能封闭该窗口。当前无 P0、仍有 P1，故**不放行**。
