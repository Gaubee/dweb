# hardening-backlog 独立复审报告（R5）

日期：2026-08-29  
复审范围：R4 报告 `docs/codex-hb-review-4.md` 的剩余 P1，以及本轮工作树中 `connect` 准入、登记门、drain 顺序和回归 fixture。  
证据边界：当前 R5 修复仍在未提交工作树；采纳用户提供的 Rust/JS 全绿与探针证据，未运行 `cargo build/test/clippy`。

## 结论

评分 **8.2/10**，**不放行**。准入与登记的跨锁竞态已由同锁 `InflightState` 消除；但已登记 owner 仍未被 shutdown 真正持有/等待，`register_dialed` 的单次前置检查存在 TOCTOU，且接受循环有另一条 `insert_peer` 绕过该门。因此关闭完成后仍可能出现新 peer、`PeerConnected` 或名册事件。本轮未发现 P0，仍有 P1。

## 已闭合核验

### 准入与登记原子性

- `InflightState { draining, map }` 定义于 `crates/dweb-fabric/src/fabric.rs:611-616`，字段由 `Mutex<InflightState>` 持有（`:664-667`）。
- `connect()` 在 `:1625-1662` 的同一临界区先检查 `inflight.draining`，再对 `inflight.map` 查找/插入；shutdown 在 `:389-393` 同锁置 `draining=true` 并清理表。故不会再出现“已检查 Running、shutdown 置位后才登记”的跨锁窗口。
- `shutdown_started` 的早期快查（`:1584-1589`）只是快速路径，不能替代上述同锁检查；这一层次划分本身正确。

### drain 顺序局部正确

`shutdown_drain()` 先唤醒航班、关现存 peer、终止 relay watcher，再调用 `endpoint.close()`（`crates/dweb-fabric/src/fabric.rs:384-407`）；把 endpoint 关闭放到拨号收敛等待之前的方向正确，能促使挂起的底层拨号尽快失败。完成通知仍在全部后台收尾步骤之后用 `send_replace(true)` 写入（`:428-451`），R4 的顺序二调/首调取消问题保持闭合。

## 新增阻塞问题

### P1-1：已登记 connect owner 被 `map.drain()` 丢失，前置门仍有 TOCTOU

证据：`crates/dweb-fabric/src/fabric.rs:389-393,410-421,1930-1947`。

1. drain 在同锁中 `map.drain()`，所以 `FlightGuard` 仍活着的 owner 不再有表项；其 Drop 只会按 generation 尝试删除表项（`:623-642`），并不代表 owner Future 已退出。
2. 紧接着的“空表等待”检查 `:411` 从逻辑上必然看到空表，无法等待 owner；shutdown 也没有保存/等待普通 `connect()` 的 JoinHandle。因而 `send_replace(true)` 不是“无 owner”证明。
3. `register_dialed()` 只在 `:1933-1937` 检查一次 `draining`，随后跨 `roster.lock().await`、`dialer_hello()`、`merge_and_emit()` 才在 `:1944-1946` 调用 `insert_peer()`。可构造时序：检查读到 false -> shutdown 置 draining/关闭 endpoint -> HELLO 或其前一步已经完成 -> owner 在 shutdown 完成门前后继续 merge、插 peer、发 `PeerConnected`/`RosterUpdated`。前置门没有覆盖检查后的阶段。

该问题直接违反 session 生命周期“关闭后无任务残留、无后续事件”的要求（`openspec/specs/fabric/session/spec.md:83-87`），也是 R4 剩余 P1 的实质部分仍未闭合。需要让 owner 生命周期可等待，或在 HELLO 后、merge/insert 前再次以关闭状态做原子门控，并确认完成通知前 owner 已退出。

### P1-2：接受循环的 `insert_peer` 绕过 `register_dialed` 门

`insert_peer` 的唯一两个调用点是 `crates/dweb-fabric/src/fabric.rs:1944-1947`（拨出路径）和 `:2136-2143`（接受路径）。后者在 `acceptor_hello()` 成功后直接 `merge_and_emit()`、`insert_peer()`，没有检查 `connect_inflight.draining`。接受连接处理 task 由 `spawn_accept_loop()` 在 `:2084-2151` 逐连接 `tokio::spawn`，不进入 shutdown 的等待集合；`acceptor_hello()` 的读帧本身也无独立超时（`crates/dweb-fabric/src/session.rs:373-398`）。因此 shutdown 已开始/endpoint 已关闭时，已接受的 regular 连接仍可能完成 HELLO 并在完成门之后插入 peer、广播事件。即使本轮目标聚焦 outgoing owner，该绕过点仍使“关闭后无新 peer/事件”契约不成立。

## fixture 证据成色

`inflight_connect_owner_cannot_cross_shutdown_completion` 的固定端口直连、真实 join、对端关闭、持流 relay 和 `connect_inflight_len()` 轮询（`crates/dweb-fabric/tests/join_classification.rs:595-647`）能够较确定地证明 owner 曾登记。

但取消子场景仅 `sleep(50ms)` 后 `owner.abort()`（`:648-657`），没有 drain 中段屏障/状态观测；而实现已在 drain 开头把 map 清空（生产代码 `:389-393`），随后空表等待是即时的。因此该 fixture 不能证明取消发生在“空表等待卡住挂起 owner”的阶段，也没有覆盖“门检查后 HELLO/insert”或接受路径绕过。它是有价值的回归，但不足以证明 P1 闭合。

## 评分与上轮变化

相对 R4 **8.1**，本轮 **8.2（+0.1）**：同锁准入/登记是实质进展，且 endpoint 提前关闭的顺序合理；但 owner 仍未纳入可等待集合，单次 `register_dialed` 检查和接受路径 bypass 继续留下完成门后的 peer/事件竞态，确定性 fixture 也未覆盖这些窗口。当前无 P0、存在 P1，故**不放行**。
