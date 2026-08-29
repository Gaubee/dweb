# hardening-backlog 独立复审报告（R7）

日期：2026-08-29  
复审范围：R6 报告 `docs/codex-hb-review-6.md` 所列四个 P1，以及当前工作树中
`crates/dweb-fabric/src/fabric.rs`、`crates/dweb-fabric/src/session.rs` 的生命周期主门改动。
固定基线为当前 `HEAD`（`cddf3b9`）加工作树改动；其它 TLS/URL 等改动不纳入本轮评分。

门禁证据：采纳用户提供的 clippy、Rust workspace、JS 三组测试、重建产物和探针 v7
全绿证据；按要求未运行 `cargo build/test/clippy`。另执行 `git diff --check`，无输出。

## 结论

评分 **8.0/10**，**不放行**。`insert_peer` 的门与 `peers` 提交已经形成有效的
原子临界区，且超时分支对首调用显式返回错误；但“单一主门覆盖全部事件/副作用”
并未成立：仍有四处直接 `broadcast::send` 绕过主门，`merge_and_emit` 的顶部门检查
仍被后续 `await` 穿透，接受循环的外层任务及其晚到 child 也没有纳入同一收敛协议。
本轮未发现 P0，仍有 P1，故不满足 `>=8.5` 放行线。

## R6 四项逐条核验

### P1-1：insert 门与 peers 提交不原子 —— 已闭合（锁序成立）

- `shutdown()` 在 `crates/dweb-fabric/src/fabric.rs:1878-1882` 同步置
  `lifecycle_gate=true`，再 spawn drain；drain 的 peers sweep 位于 `:398-402`。
- `insert_peer()` 在 `:2082-2094` 先取得 tokio `peers` 锁，再取得 std
  `lifecycle_gate` 锁，检查、插入和 `PeerConnected` 的 `emit_gated` 均在该临界区。
  因而迟到插入要么在 gate 置位前提交并随后被 sweep 关闭，要么看到 gate 后拒绝，
  不会在 sweep 之后新增 peer/连接事件。
- `emit_gated()`（`:727-738`）持 gate 锁期间只做同步 `broadcast::Sender::send`，
  无 `await`。当前未发现反向锁序：shutdown 置 gate 后即释放，再等待 peers；
  没有 gate 持有期间等待 peers 的路径。`merge_and_emit` 的 roster→gate、watcher
  的 link→gate 也都不反向等待，因此未发现由本轮引入的死锁面。

### P1-2：merge_and_emit await 穿透 —— 未闭合

`merge_and_emit()` 只在 `:2016-2020` 读取一次 gate，随后在 `:2021-2028`
跨 `roster.lock().await`。可构造时序：

```
merge:    gate=false，释放 gate，等待 roster
shutdown: gate=true，完成 sweep/关闭
merge:    取得 roster，仍在 :2028 merge facts
```

`:2035` 的 `emit_gated` 会抑制事件，但不能撤销已写入的名册事实；这直接违反本轮
声明的“lifecycle 已关则整段跳过（不 merge、零事件）”，也使迟到 HELLO/redeem 的
事实同步可能发生在关闭完成门之后。入口复检（拨出 `:2000-2007`、接受
`:2224-2240`）同样不能替代 merge 内的原子提交门。

### P1-3：接受子任务与 redeem 支路收敛 —— 部分实现，仍未闭合

- per-conn child 的 `spawn` 与 `push` 本身无 `await`（`:2187-2250`），这一小段
  没有“spawn 后、登记前”窗口；但外层 accept loop 在 `:2171-2173` 的
  `JoinHandle` 被直接丢弃，未登记、未 join。
- drain 在 endpoint close 后于 `:460-464` 一次性 `take(accept_children)`；外层
  可能正挂在 `incoming.accept().await`（`:2178-2183`），其已就绪结果可以在 take
  之后才被继续调度，随后新增 child 并 push 到已取走的表。该句柄不会再被本次
  drain join，关闭返回时仍缺乏“无任务残留”的证明。
- redeem child 在 `:2190-2217` 没有 gate 准入；`handle_redeem_as_issuer()`
  在 `crates/dweb-fabric/src/session.rs:561-598` 锁内执行 consume/grant。即使
  `:2214` 的 `RosterUpdated` 走了 `emit_gated`，grant 仍可能在 gate 置位后提交。

### P1-4：5 秒超时误报完成 —— 首调用语义已闭合，存在失败态边界

空表等待在 `:413-425` 超时会 `error!`、`shutdown_done.send_replace(true)` 并返回
`Err`；`shutdown()` 在 `:1883-1890` 会把 drain 的 `Err`/`JoinErr` 透传给首调用，
因此 R6 所指“首调用静默成功”已修复。

但该 `Err` 路径在 `:422-425` 提前返回，不再执行后续 detached-connect 与
`accept_children` 收尾（`:429-478`）；晚到 waiter 在 `:1868-1874` 只看到 `true`
并返回 `Ok(())`。按本轮明确的“首调用显式感知、晚到者不挂死”定义不另列阻塞，
但该 `true` 只能理解为唤醒信号，不能当作成功收敛证明。

## 新增阻塞问题

### P1-1：仍有四处事件发送绕过生命周期主门

证据：`crates/dweb-fabric/src/fabric.rs:1096,1500,1511,1584`。

- relay watcher 的 `events_tx.send(RelayOnline/Offline)`（`:1096`）没有 gate 参数；
  shutdown 在 `:1880` 置 gate 后，drain 要先等待 inflight/peers 才在 `:405-408`
  abort watcher，watcher 可在这段窗口内广播事件。
- `revoke()`、`set_display_name()` 和 `join()` 成功兑换分支仍直接调用
  `self.inner.events.send`。它们均含有 `roster.lock().await`/其它 await，调用在
  gate 置位前开始、恢复后发送的交错是可行的。

这些路径使“全部事件发送点已切换”和 session 规格
`openspec/specs/fabric/session/spec.md:83-87` 的“关闭后无后续事件”均不成立，
属于独立 P1。应让所有发送统一经同一 gate；relay watcher 也必须持有同一门，且
watcher 的创建/终止顺序要与 `FabricInner` 生命周期一致。

## 标准轴

主门不变量是本轮明确的代码约束；上述四处裸 `send` 属于行为级硬违反。除这些
遗漏外，`emit_gated` 的同步发送和 `peers -> gate` 嵌套没有观察到反向锁序或锁内
异步等待。accept loop 未登记是生命周期收敛风险，不是格式或工具可自动发现的问题。

## 规格轴

规格要求关闭后无任务残留、无后续事件（`spec.md:87`），并且本轮声明 merge 在
关闭后“不 merge”。直接发送、merge 的 TOCTOU、accept loop/child 的 take 窗口和
redeem 的无准入均与这些要求不符；没有发现超出本轮生命周期范围、且会改变其它
协议语义的新增 scope creep。

用户提供的全绿门禁与现有 fixture 仍不足以覆盖这些窗口：已有
`inflight_connect_owner_cannot_cross_shutdown_completion` 主要断言航班表最终清空、
拨号失败和无 `PeerConnected`，没有屏障注入到 `merge` 等待、relay watcher 广播或
`accept_children` 的 take/late-push 交错，也没有断言关闭后名册事实未被写入。

## 评分变化

相对 R6 **8.1**，本轮 **8.0（-0.1）**：原子 peer 提交、锁内零 await 的发送门和
首调用超时显式失败是实质进展；但主门并未覆盖全部发送点，merge/accept 仍存在
关闭完成后的副作用或未 join 任务，因此阻塞项未归零。当前无 P0、存在 P1，**不放行**。
