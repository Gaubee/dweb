# hardening-backlog 独立收口复审报告（R9）

日期：2026-08-29  
原始需求：复核 R8-1 `send()` 持 `peers` 锁跨网络 await 的关闭完成门饥饿；确认
R9 将 I/O 移至锁外并以 10 秒有界，评定是否放行。  
范围：当前工作树的 R9 目标实现；基线 `HEAD` = `cddf3b9`。该工作树混有 R1-R9
未提交修改，故按现态代码和本轮明确验收点核验，不对其余 diff 作 R9 归因。

## 结论

R8 唯一遗留的 P1 已闭合。`send()` 不再持 `peers` 锁等待网络；关闭开始后的新
发送被拒绝，而已取得连接副本的发送不会再占住 shutdown 的 peers sweep。其 I/O
整体有 10 秒上限，调用方得到明确超时。未发现其它持 `peers`、`roster` 或
`roster_commit` 锁跨网络 await 的路径。

**P0：无。P1：无。评分：9.2/10。放行。**

## R8-1 闭合核验

| 验收点 | 代码证据 | 结论 |
| --- | --- | --- |
| 锁内零网络 I/O | `crates/dweb-fabric/src/fabric.rs:1980-1994` 在 `peers` guard 内仅检查 `shutdown_started`、查表并 `conn.clone()`；块结束即释放 guard。 | 通过 |
| 准入位置 | `fabric.rs:1981-1987` 先取得 `peers`，再同步读取 `shutdown_started`；`shutdown()` 在 `:2018-2025` 同步置位。 | 通过；若 clone 后才开始关闭，drain 仍可立刻取得 peers 锁。 |
| I/O 与超时语义 | `fabric.rs:1995-2006` 锁外执行 `open_bi().await`、`write_frame(...).await`、`finish()`；同一 future 被 `SEND_IO_TIMEOUT`（`:923-925`，10 秒）整体包住，超时返回含 `stalled`/`flow-control window exhausted` 的错误。 | 通过 |
| shutdown 完成门 | `shutdown_drain()` 在 `fabric.rs:405-409` 对已释放的 peers 锁同步 close 后即释放，再开始 watcher/endpoint 的 await 收尾（`:412-501`）。 | 通过；R8 所述完成门饥饿时序不可再构造。 |

## 锁路径复核

逐处审阅了 `peers.lock().await`、`roster.lock().await` 和
`roster_commit.lock().await` 的所有生产路径。`disconnect`（`fabric.rs:1948-1955`）、
`register_dialed`（`:2153-2159`）、消息 watcher（`:2323-2333`）均先取值/克隆或
移除条目，再进入网络 await；`acceptor_hello` 的 roster 快照也在
`session.rs:424-428` 的 `write_frame` 前释放。名册提交路径
`fabric.rs:1597-1648,2176-2213` 与 `session.rs:623-650` 只跨本地 Tokio roster
mutex 获取及同步名册写入，不跨网络 I/O。**无须列出的残留路径。**

## 标准轴与规格轴

标准轴未发现 R9 新增的文档化规范硬违例或代码嗅觉；`SEND_IO_TIMEOUT` 命名、作用域
和现有错误承载方式一致。规格轴确认 clone 与 shutdown 并发时，shutdown 不等待该
send future，且会关闭其连接，符合
`openspec/specs/fabric/session/spec.md:83-87` 的关闭后无任务残留、无后续事件边界。

本轮独立通过：`git diff --check`、`cargo fmt --all -- --check`。用户提供的全量
clippy/test/JS/探针全绿证据用于门禁结论；遵循本机重负载受控规则，未并发重跑
workspace 级 Rust 门禁。

## 评分与变化

相对 R8 的 **8.3/10**，本轮为 **9.2/10（+0.9）**：唯一 P1 的锁等待链已被切断，
超时和准入语义均有行级代码证据，且未引入新的 P0/P1。保留 0.8 分仅反映本轮未独立
重演“对端停读/流控耗尽”的故障注入；这属于回归覆盖增强空间，不构成放行阻塞。
