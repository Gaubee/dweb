# secret-store-abstraction 终验（第三轮）

复验 HEAD：`f81cf21f555d77328ba561a8f2bad5b6d206aa80`。`openspec validate secret-store-abstraction --strict` 通过；当前工作区已有记录的 cargo 75、clippy、SDK 5/5、example/server-binary 门禁均通过。

## 七项核验

| 项目 | 结论 | 源码证据与残留 |
| --- | --- | --- |
| P0-1 原子 create | **闭合** | `secret.rs:214-225` 使用 pid+`AtomicU64` 临时名和 `create_new`；`:242-253` 用 hard-link 的 EEXIST 映射 `Conflict`，并 fsync 父目录；`:504-527` 断言恰一胜、败者 Conflict、落盘 seed 与胜者一致。残留仅为崩溃遗留 tmp 在极端 PID 复用时可能令后续 create 返回写错误。 |
| P0-2 句柄消费 | **核心闭合，API 清理未完全闭合** | `packages/client-sdk/src/fabric.rs:58-75,130-145` 已是互斥单次 `take`，失败路径归还；`:209-229` 先 decode token 再消费；并发 allSettled 测试无 panic。但 `available` getter 仍保留（`:124-128`，d.ts `:71-73`），与“删除 available”要求不符，虽不再参与 check-then-act。 |
| P0-3 trait/契约 | **闭合** | spec `:9-26` 与 design `:18-34` 均定稿为同步对象安全 `load + create`、Conflict、并发恰一胜；实现一致。 |
| P1 create_root 副作用 | **串行闭合，并发窗口未闭合** | `crates/dweb-fabric/src/fabric.rs:204-214` 先检查 roster 再解析身份，已有 roster 的串行失败不创建 identity；但检查与 `Roster::create` 仍非同一临界区，两个并发 create_root 仍存在 TOCTOU。 |
| P1 AAD/KDF DoS | **闭合** | `secret.rs:311-315` 和 `:391-395` 的 AAD 覆盖 domain、header、salt、nonce；`:357-379` 在 Argon2 前校验 magic/version/kdf_id 及 v1 精确参数。 |
| P1 zeroize | **闭合** | 导出 seed 临时数组/key 在 `secret.rs:317-328` 清零；导入 key/plaintext 在 `:402-408` 清零，`SecretSeed` 具 `ZeroizeOnDrop`。 |
| P1 async/docs/tasks | **实现闭合，任务状态有残留** | SDK import/export 均经 `spawn_blocking`（`packages/client-sdk/src/fabric.rs:151-157,358-365`），README 小节存在；但 `openspec/.../tasks.md:16` 的 2.2 仍为 `[ ]`，且 README `:70` 注释把身份导出前缀写成 `dweb1...`，实际为 `dwebkey1.`。 |

## 评分

**9.0/10，较上轮 6.8 上升 2.2 分。** 三个 P0 的运行时阻塞点及加密参数/zeroize/异步隔离已落地；扣分来自 `available` 残留、create_root 并发 TOCTOU、临时文件极端碰撞边界和 tasks/README 文档不一致。上述均未重新引入已修复的句柄 panic 或 KDF 参数 DoS。

## 放行结论

**核心功能可有条件放行；正式收尾前清理 `available`/tasks 2.2、修正 README 前缀，并明确是否补齐 create_root 原子临界区。**
