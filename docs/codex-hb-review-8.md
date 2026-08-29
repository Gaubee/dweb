# hardening-backlog 独立终审报告（R8）

日期：2026-08-29  
复审范围：R7 报告 `docs/codex-hb-review-7.md` 所列四个 P1，及 R8 修复简报
`docs/codex-hb-fix-report.md` 对 `crates/dweb-fabric/src/fabric.rs`、
`crates/dweb-fabric/src/session.rs` 的当前工作树实现。重点复核 `[R8-1]`/
`[R8-2]` 的二阶段门、名册提交锁、接受任务登记和 watcher 入口。

门禁证据：采纳修复简报所列全量 Rust/JS 门禁与探针结果；本轮独立执行
`cargo fmt --all -- --check` 和生命周期发送点/锁路径检索，均通过。未重复启动
workspace 级构建或测试。

## 结论

R7 的四项 P1 均已按设计闭合：事件发送统一受门控，`merge_and_emit` 与 redeem
提交被 `roster_commit` 线性化，accept loop/child 登记表的 take 窗口已收敛，且超时
兜底没有回归。实现仍有一个会阻断关闭完成的 P1：`send()` 在持有 `peers` 锁时跨
网络 await，而 shutdown 必须先取得该锁才关闭 endpoint。对端停止读取或耗尽双向流
额度时，shutdown 可能无法到达 `shutdown_done`，违反 session 生命周期的有界收敛
要求。因此本轮 **8.3/10，不放行**。

## R7 四项逐条核验

### P1-1：四处裸 `events.send` —— 已闭合

- 事件的唯一实际发送语句为 `FabricInner::emit_gated_on` 的
  `events.send`（`crates/dweb-fabric/src/fabric.rs:783-797`）和在同一请求门/主门
  临界区内调用的 `emit_gated_locked`（`:800-805`）。未再发现 relay watcher、
  revoke、display-name、join/redeem、peer/message/roster 的裸发送。
- relay watcher 在 `:1197` 经 `emit_gated_on`；revoke/display-name 在 `:1624`、
  `:1643`；merge、peer、message 在 `:2169`、`:2271-2280`、`:2315-2318`；
  redeem 成功通知在 `:2405-2407`，均共享请求门与主门。
- 两阶段门的 Arc 来源一致：构造时创建于 `:1371-1373`，watcher 捕获 clone 于
  `:1407-1419`，再原样存入 `FabricInner` `:1440-1447`；path watcher 从
  `insert_peer` 传入同一 Arc（`:2245-2251`）。`session::spawn_path_watcher` 的
  独立入口明确保留无 Fabric 生命周期的旧语义（`session.rs:314-328`），不构成
  Fabric 绕门。
- `emit_gated_on` 以 request -> gate 顺序持同步锁完成检查与同步 send
  (`:789-797`)，没有 await；shutdown 只在 `roster_commit` 之后置主门
  (`:387-390`)，未观察到反向持锁等待。

### P1-2：`merge_and_emit` TOCTOU —— 已闭合

- `shutdown_drain` 先持有 `roster_commit`，再置 `lifecycle_gate`，因此门切换不会
  越过仍在提交的名册写入（`fabric.rs:384-390`）。
- invite/revoke/display-name 均在该锁内检查门并取得 roster 锁后写入
  (`:1592-1604`, `:1613-1624`, `:1634-1644`)；`merge_and_emit` 也保持
  `roster_commit` 跨门检查与 `roster.merge` (`:2149-2175`)。redeem 的
  consume/grant 同样在 `session.rs:621-650` 的提交锁内二次检查双门。
- `lifecycle_closing()` 的 std guard 在 `:818-826` 内释放，随后才 await Tokio
  roster 锁；提交锁仍保持到 roster 写入完成。故 R7 所述 gate 后迟到 merge 写入
  不再可构造，且门内没有跨 await 的 std 锁。

### P1-3：accept 子任务、晚到 child、redeem 准入 —— 已闭合

- 外层 accept loop 的句柄已保存（`fabric.rs:1454-1455`）。drain 关闭 endpoint
  后先取出并 join 外层 loop（`:417-429`），再将 child registry 置为 `closing` 并
  take/join 全部句柄（`:479-495`）。
- registry 的注册操作是同步锁块（`:672-693`）。accept child 从 spawn 到注册之间
  没有 await（`:2371-2372`, `:2442-2450`）；`insert_peer` 创建的 path/closed/msg
  watcher 也在同一 peers 临界区登记（`:2243-2331`）。由于 registry 只在外层 loop
  已 join、且 gate 已阻止迟到 insert 后关闭，take 后不存在生产者晚到 push 窗口。
- accept redeem 分支改用 `handle_redeem_as_issuer_gated`（`:2385-2393`）；其
  `roster_commit` 内重新检查 request/gate 后才执行 consume/grant
  (`session.rs:621-642`)，主门后只关闭连接，不再写名册。
- abort fallback 均继续消费 JoinHandle（`:426-428`, `:471-474`, `:490-495`），
  没有把取消请求误当作任务已退出。

### P1-4：超时兜底语义 —— 无回归

inflight 超时现在只记录 `drain_error` 并继续完成 accept/detached 收尾
(`fabric.rs:434-500`)，完成通知在所有收尾之后以 `send_replace(true)` 写入
(`:499-505`)。首调用透传 `Err`/JoinErr (`:2016-2024`)，晚到调用订阅同一值并
在完成后返回 (`:1993-2007`)。因此“首调用显式感知、晚到者不挂死”的 R7 认可语义
保持；晚到者在不完整 drain 时仍只看到完成唤醒而非错误详情，这是既有约定，不另列
阻塞。

## 新增阻塞问题

### P1-1：`send()` 持 `peers` 锁跨网络 await，可能卡死 shutdown

证据：`Fabric::send` 在取得 `peers` 锁后，未释放 guard 就执行
`entry.conn.open_bi().await`、`write_frame(...).await` 和 `finish()`
(`crates/dweb-fabric/src/fabric.rs:1973-1982`)；而 `shutdown_drain` 必须先取得
同一 `peers` 锁执行 sweep (`:405-409`)，直到之后才调用 `endpoint.close()`
(`:417`)。上游 `noq` 的 `open_bi` 明确会在双向流额度受流控时 Pending
(`/Users/kzf/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/noq-1.2.0/src/connection.rs:331-345,1027-1050`)；写入也可因对端不读取而等待流控。

可构造时序：成员对端保持连接但不接收/读取 MSG 流，`send()` 在 `peers` guard
内挂起；随后调用 `shutdown()`，drain 在 `:405` 永久等待该 guard，无法执行
`conn.close` 或 `endpoint.close`，也就不会到达 `shutdown_done.send_replace(true)`。
此外 `send()` 没有 `shutdown_started` 准入检查，shutdown 请求后仍可进入该窗口。
这违反 `openspec/specs/fabric/session/spec.md:83-87` 的关闭后有界收敛/无任务残留
要求；现有门禁和 R8 fixture 没有覆盖 stalled send。建议复制连接后立即释放
`peers` 锁，再在门控/有界发送路径中执行网络 I/O。

## 标准轴与规格轴

标准轴未发现新的硬性规范违例：std Mutex guard 均未跨 await，事件 helper 与
accept registry 的锁序没有形成环。watcher 在早期门检查后到状态更新前虽有竞态，
但最终发送仍由 `emit_gated_on` 原子复核；它最多造成关闭竞态中的状态更新/丢事件，
不重新打开门后广播路径。

规格轴确认 R7 四项要求均有实现证据；上述 `send` 锁问题是规格 `session.md:87`
所要求的 shutdown 收敛边界之外的既存遗漏，但仍属于当前工作树必须解决的 P1。

## 评分与放行

相对 R7 **8.0**，本轮 **8.3（+0.3）**：四个既有 P1 均已闭合，门锁序、Arc
同源、accept 登记和错误超时语义均有代码证据；但 `send` 锁跨 await 使 shutdown
仍存在可重复的完成门饥饿，故当前有 1 个 P1、无 P0，未达到 `>=8.5` 放行线。

**P0：无。P1：1 项（send/peers 锁导致 shutdown 可能永不完成）。不放行。**
