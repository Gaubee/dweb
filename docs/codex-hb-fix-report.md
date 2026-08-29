# Fabric 生命周期收敛修复简报（R8）

日期：2026-08-29  
范围：`crates/dweb-fabric/src/fabric.rs`、`crates/dweb-fabric/src/session.rs` 及
Fabric 生命周期回归测试。未提交、未 push。

## 修复决策

1. **统一事件门（[R8-1]）**
   - relay watcher、path watcher、revoke、display-name、join/redeem 成功通知和
     peer/message 事件全部经 `emit_gated`/`emit_gated_on`。
   - `shutdown_started` 作为同步请求门，`lifecycle_gate` 作为最终主门；检查与
     `broadcast::send` 在同一同步临界区完成，门内不发生 `await`。
   - 保留独立 `session::spawn_path_watcher` 入口；Fabric 使用带门的
     `spawn_path_watcher_gated`，避免无关公共 API 语义回归。

2. **名册提交原子化（[R8-1]）**
   - 新增 `roster_commit` Tokio 锁，覆盖 invite/revoke/display-name、
     `merge_and_emit` 以及 issuer redeem 的 consume/grant。
   - shutdown drain 先取得该锁，再置 `lifecycle_gate`；因此门置位后不存在
     仍持提交锁的名册写入者。`merge_and_emit` 在同一提交锁内检查门并 merge，
     不再有顶部门检查穿过 `roster.lock().await` 的 TOCTOU。

3. **接受任务收敛（[R8-2]）**
   - 保存外层 accept loop 的 `JoinHandle`；shutdown 关闭 endpoint 后先 join 外层
     loop，再将 accept child、path/closed/message watcher 登记表置为 closing 并
     全量收割。
   - spawn 与登记之间无 `await`；closing 后登记方拿回句柄并立即 abort/join。
   - 所有 abort fallback 都继续消费 `JoinHandle`，不把“已请求取消”当作“已退出”。

4. **redeem 准入（[R8-1]）**
   - Fabric accept child 使用 `handle_redeem_as_issuer_gated`；consume/grant 在
     `roster_commit` 内检查请求门和主门后才提交。门后只允许关闭连接，不再写名册。
   - 独立 wire 测试入口保留原 `handle_redeem_as_issuer`，其使用独立的本地提交门。

## 新不变量

- `lifecycle_gate == true` 后，Fabric 内所有名册写入和生命周期事件发送均为零。
- `roster_commit -> lifecycle_gate` 是固定锁序；持 gate 的同步临界区不等待任何
  Tokio 锁。
- accept loop join 完成后才会关闭 child registry；registry `closing` 后不存在
  未登记任务，完成通知前所有已登记句柄均已 join。
- `connect_inflight` 的准入与登记仍由同一锁保护，`draining` 后不产生新 owner。

## 验证

- `cargo check -p dweb-fabric -j2`：通过。
- `cargo test -p dweb-fabric --lib -j2`：`99 passed; 0 failed`。
- `cargo test -p dweb-fabric --test join_classification -j2 -- --test-threads=2`：
  `27 passed; 0 failed`。
- `rustfmt --edition 2024 --check crates/dweb-fabric/src/fabric.rs crates/dweb-fabric/src/session.rs`：通过。
- `git diff --check -- crates/dweb-fabric`：通过。

## 仍存风险（诚实声明）

- 若已有 iroh connect owner 超过 5 秒仍不退出，shutdown 会保留明确的失败结果
  （首调用返回 `Err`），而不是伪报成功；该极端 owner 的最终退出仍依赖 iroh
  自身取消/收敛，未声称已消除底层阻塞。
- abort/join 依赖当前任务在 Tokio 可取消点运行；现有 accept、watcher 和 redeem
  路径均为异步等待点，但未对任意未来新增的非让渡同步代码作形式化证明。
- 受本轮资源与范围约束，未运行 workspace、dweb-server 或 client-sdk 的构建/测试；
  本报告只把上述 dweb-fabric 检查和 27 用例 fixture 作为实证。
