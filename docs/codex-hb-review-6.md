# hardening-backlog 独立复审报告（R6）

日期：2026-08-29
复审范围：R5 报告 `docs/codex-hb-review-5.md` 的两个剩余 P1，以及本轮
`connect_inflight`、`register_dialed`、接受循环和 shutdown 收敛修复。固定点为当前
`HEAD`（`cddf3b9`），核验其工作树改动。
门禁证据：采纳用户提供的 Rust/JS 全绿、重建产物和探针 v6 PASS；按要求未运行
`cargo build/test/clippy`。

## 结论

评分 **8.1/10**，**不放行**。本轮确实修复了 `map.drain()` 丢失 owner 的问题：正常
路径会保留航班条目，由 `FlightGuard` 自清理，空表轮询能观测真实收敛。但两个关闭门
仍不是原子提交，且 5 秒超时分支会在 owner 未退出时发送完成通知。无 P0，仍有 P1，
未达到 `>=8.5` 放行线。

## 已闭合核验

### owner 收敛

- `shutdown_drain()` 在 `crates/dweb-fabric/src/fabric.rs:389-396` 只置
  `draining` 并唤醒 waiter，不再清空 `connect_inflight.map`。
- `FlightGuard::Drop` 在 `:621-645` 按 generation 删除自身条目并通知；endpoint
  关闭后 `:410-424` 的空表等待因此具有真实观测意义。fixture
  `crates/dweb-fabric/tests/join_classification.rs:658-663` 也断言 shutdown 返回时
  `connect_inflight_len()==0`。这部分在 owner 正常退出路径上闭合。

### 锁序

未发现新的嵌套反向锁序：`connect_inflight` 与 `peers` 都是先释放前者再取得后者，
不会因本轮改动形成死锁。问题在于释放后的间隔不是原子提交窗口，见 P1-1。

## P1 阻塞问题

### P1-1：`insert_peer` 门与 `peers` 提交不原子

证据：`crates/dweb-fabric/src/fabric.rs:2013-2016,2017-2039`，shutdown 的
`:389-402`。

`insert_peer()` 读 `is_draining()` 后立即释放 `connect_inflight`，随后才挂
`path_watcher`、等待 `peers.lock()`、插入条目并发送 `PeerConnected`。可构造交错：

```
insert_peer: draining=false（释放 inflight）
shutdown:    draining=true，锁 peers，关闭现有条目并释放
insert_peer: 取得 peers，插入新条目并广播
```

接受路径没有 flight owner 可供 drain 等待，因此该迟到插入甚至可能发生在
`shutdown_done.send_replace(true)`（`:453-454`）之后。watcher 还可能发出
`PathChanged`（`crates/dweb-fabric/src/session.rs:319-345`）。本轮门不是原子门，
R5 的 owner/接受路径 P1 未闭合。

### P1-2：HELLO 后复检仍被 `merge_and_emit` 的 await 穿透

证据：拨出路径 `:1948-1957`，接受路径 `:2162-2176`，事件发送
`:1965-1980`。

两处新增复检只能保证“复检当刻”未 draining；复检后仍跨 `merge_and_emit().await`。
shutdown 可在此间置位，`merge_and_emit` 仍能合并事实并发送 `RosterUpdated`，之后
`insert_peer` 的门即使拒绝也无法撤回该事件。若 owner 恰好超过空表等待 deadline，
该事件还可越过完成通知。注释所称“merge 跳过”与实际控制流不符。

### P1-3：接受子任务与 redeem 支路没有完成收敛证明

endpoint.close 后，外层 `endpoint.accept().await` 返回 `None` 的退出边界已有
spike 证据（`docs/spike-iroh.md:229-234`）；但每条已接受连接在
`crates/dweb-fabric/src/fabric.rs:2122-2124` 被独立 `tokio::spawn`，shutdown 不保存或
join 这些句柄。`acceptor_hello()` 的 `read_frame` 也没有独立超时
（`crates/dweb-fabric/src/session.rs:373-397`）。因此 close 只封住新 accept，不能
证明已生成 child 在完成门前退出。ALPN_REDEEM 分支 `:2126-2151` 甚至没有
`draining` 门，成功兑换后仍可能广播 `RosterUpdated`。

### P1-4：5 秒 warning 兜底把“未退出”误报为完成

证据：`crates/dweb-fabric/src/fabric.rs:413-424,453-454`。

空表等待超时后仅记录 warning 即 `break`，无论 `connect_inflight.map` 是否仍非空都
发送 `shutdown_done=true`。这不是足以覆盖 MUST 的“文档化兜底”：主规格
`openspec/specs/fabric/session/spec.md:83-87` 明确要求关闭后无任务残留、无后续事件。
若 owner 未退出，完成通知即构成契约违例；除非同步修改规范为 best-effort，否则必须
继续等待、明确取消并 join，或以失败状态阻止完成门。

## 证据与非阻塞观察

用户提供的全绿门禁和 fixture 证明正常 owner 可收敛，但没有覆盖上述 gate 后阻塞
`peers`、`merge_and_emit`、接受 child 或 5 秒超时交错。`shutdown_drain` 的旧注释
`:385-387` 仍写“清空航班”，与 `:391-393` 不再 drain 的实现矛盾，属文档维护问题，
不另列 P1。

## 评分变化

相对 R5 **8.2**，本轮 **8.1（-0.1）**：保留 owner 并由 guard 观测收敛是实质进展；
但新增的门仍被异步提交阶段拆开，接受 child/redeem 未纳入完成证明，且超时分支明确
允许未退出 owner 越过完成门。当前无 P0、仍有 P1，故**不放行**。
