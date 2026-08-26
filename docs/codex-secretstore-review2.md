# secret-store-abstraction 实现复审（HEAD d83173c）

复审日期：2026-08-26

结论先行：四项放行阻塞没有全部真实闭合。参数 DoS、open/seed-roster 语义和 SDK opaque handle 的主路径已经落地并通过现有测试；但文件 create 仍有同进程竞态，SDK 句柄并发消费可 panic，OpenSpec trait/任务状态仍与实现不一致。这些属于实现正确性或公共契约阻塞，当前不应按“全部处置”放行。

## 核验范围与门禁

- `HEAD` 为 `d83173c4c68bf658da09a738abad4e335d62f3d8`，工作树干净。
- `openspec validate secret-store-abstraction --strict`：通过。
- Herdr pane 受控执行 `cargo test --workspace -j 2 -- --test-threads=2`：全部通过；当前实际计数为 dweb-fabric 单测 62、fabric integration 4、facade 5、server 4，另有 0 个 spike 测试，即 75 个执行用例，不是提交说明中的 71。
- Herdr pane 受控执行 `cargo clippy --workspace --all-targets -j 2 -- -D warnings`：通过。
- `pnpm --dir packages/client-sdk test`：4/4 通过，包含 secret injection + identity export/import。

上述门禁证明主路径没有回归，但没有覆盖下面列出的并发、失败回滚和文档契约问题。

## 四项阻塞逐条复验

### 1. 原子初始化协议：未闭合（阻塞）

trait 形状和 `Conflict` 回读逻辑已实现：`secret.rs:149-160` 为 `load + create`，`ensure_with` 在 `Conflict` 后回读胜者（`secret.rs:268-283`）。Unix `link(2)` 目标存在返回 `Conflict`，父目录也有 `fsync`（`secret.rs:237-243`）。

但“唯一 tmp”不成立。`FileSecretStore::create` 的临时路径是
`identity.key.<process-id>.tmp`（`secret.rs:214-220`），只区分进程，不区分同一进程的线程/调用。提交的并发测试本身是双线程、同一进程（`secret.rs:493-500`），只是断言一个成功、一个失败，并未断言失败是 `Conflict`、也未断言成功返回的 seed 等于最终文件内容。

两个线程可以互相 truncate/write/remove 同一个临时文件；更坏的交错是线程 A 的 `create` 在 `link` 时发布了线程 B 已写入的 inode，A 返回成功但调用方持有的是 A seed，落盘却是 B seed。另一种交错会得到 `NotFound -> Write`，而非原子冲突。故“恰一胜且身份不分叉”的实现契约并未被当前代码保证。

### 2. 参数 DoS：代码路径已闭合，规范仍有细节漂移

`import_secret` 在 Argon2 之前检查 token 长度、base64/blob 定长、magic、version、kdf_id 和精确 `m=19456,t=2,p=1`（`secret.rs:332-371`）。现有测试覆盖恶意大参数、26 字节头逐位篡改、密文抽样认证失败、全字节截断不 panic；这一项实现上通过。

密码学选型与一手资料一致：OWASP Password Storage Cheat Sheet 当前明确给出 Argon2id 最低 `m=19456 KiB,t=2,p=1`；RFC 9106 §4 的推荐档更高，因此当前值应继续标成兼容下限而不是 RFC 首选。docs.rs `argon2 0.5.3` 提供 `Argon2id`/`ParamsBuilder`，docs.rs `chacha20poly1305 0.10.1` 明确是 RFC 8439 的纯 Rust ChaCha20-Poly1305，96-bit nonce。

不过 `design.md:38-45` 仍把 `p` 写成 `u8`，实现和 rustdoc 实际按 `u32 BE` 编码（`HEADER_LEN=26`，`secret.rs:67-70,302-304`）。这会使按设计文档实现的外部导出器与当前解析器不兼容，需在正式放行前修正文档/规范。

### 3. Fabric 构造语义：主路径闭合，失败副作用未闭合

已确认：

- `open` 使用 `allow_create=false`，缺身份返回 `MissingIdentity`（`fabric.rs:160-172,211-225`）。
- `open` 和非空 `attach` 校验 EndpointId 是否为 roster 有效成员，错误为 `IdentityRosterMismatch`（`fabric.rs:218-224,236-244`）。
- `Seed` 路径直接构造身份，不读取/写入 SecretStore（`fabric.rs:186-199`）；facade 测试覆盖缺身份、mismatch、零副作用和导出往返。
- `create_root` 仍由 `Roster::create` 拒绝既有 `roster.facts`（`roster.rs:193-205`）。

仍有一个可观测副作用：`create_root` 先 `resolve_identity(..., true)` 再检查 roster（`fabric.rs:203-206`）。在默认 FileSecretStore 下，已有 roster 但缺 `identity.key` 时，会先生成并写入新 identity，随后才返回 `RosterError::AlreadyExists`。这违反设计稿“发现既有 roster/冲突时写入前失败”的更强语义，且会污染目录。

### 4. 命名、范围与 SDK 面：主路径闭合，契约/生命周期未闭合

身份导出文案、`identity export != fabric recovery`、CAS 拓扑约束和同步 store 不得做未界定网络阻塞均已写入 `secret.rs` rustdoc 与 spec/design；SDK 也确实使用 opaque `SecretSeedHandle`，不把明文 hex seed 交给 JS（`packages/client-sdk/src/fabric.rs:92-147`）。

但 SDK 句柄有两个阻塞问题：

1. `to_options` 先调用 `available()` 再调用 `take()`（`packages/client-sdk/src/fabric.rs:58-70`）。两个并发工厂调用都可能先观察到可用，后者的 `take()` 返回错误，却被 `expect("checked available")` 解包；这是可触发 panic 的公共 N-API 路径。必须用一次带锁的原子 `take`，不能用检查后再消费。
2. 句柄在工厂真正成功前就被消费。`join_with_token` 先 `to_options` 消费句柄，之后才 decode token、attach、联网 join（`packages/client-sdk/src/fabric.rs:188-202`）；create/open/attach 失败也会烧掉句柄，调用方无法重试。一次性句柄应在可验证的输入检查完成后消费，或提供失败可恢复的事务边界。

另外，`tasks.md:16` 仍把 SDK export/import 任务 2.2 标成 `[ ]`，与已提交 Rust/d.ts 实现矛盾；`tasks.md:21` 声称 README 已增加身份存储与恢复小节，但本提交没有 README diff，任务证据也不真实。`openspec validate` 不会验证这些任务状态与源码一致性。

## 新发现问题（按严重度）

### P0 / 放行阻塞

1. **FileSecretStore 临时文件并非唯一且可能身份分叉。** `secret.rs:214-240`；修复为每次调用唯一、不可预测、使用 `create_new` 的临时文件，或用同目录锁/平台原子 API；测试必须断言胜者 identity 与最终 load 完全相同，并覆盖同进程多线程。
2. **SecretSeedHandle 检查-消费竞态可 panic。** `packages/client-sdk/src/fabric.rs:62-70`；删除 `available()+expect`，以单次互斥 `take()` 返回分类错误；补并发构造测试。
3. **OpenSpec 公共契约与实现不一致。** `openspec/.../specs/fabric/secret-store/spec.md:9-11` 和 `design.md:20-25` 仍要求 `exists/load/store`，实现却只有 `load/create`（`secret.rs:157-160`）。这是有意的原子 insert-if-absent 改名也必须同步 spec/design；否则下游实现者会按旧接口实现，无法与 HEAD 链接。

### P1 / 发布前应修复

4. **create_root 失败前写入 identity。** `fabric.rs:203-205`；应先读取/锁定 roster 状态，再决定是否允许 create，避免 AlreadyExists 路径留下新 key。
5. **构造失败会不可逆消费 SDK 句柄。** `packages/client-sdk/src/fabric.rs:188-202`；把 token decode、fabric-id 校验和可失败的本地准备置于消费前，或设计可重试的 handle transaction。
6. **AAD 注释比实现更强。** rustdoc/design 声称“全部 metadata”入 AAD（`secret.rs:34-36,306-308`），实现只把 `domain + header` 放入 AAD，salt/nonce 在 AAD 外（`secret.rs:322-325,383-384`）。salt 改变会通过 KDF 间接失败、nonce 改变会通常认证失败，但这不等于“显式认证全部 metadata”；应统一实现和规范。
7. **同步 SDK 派生路径阻塞调用线程。** `import_secret` 是同步 N-API 函数（`packages/client-sdk/src/fabric.rs:139-147`），直接执行 Argon2；`export_secret_passphrase` 虽标 async，仍在 async 方法体直接调用 `self.inner.export_secret`（`302-315`）。应明确 worker/`spawn_blocking` 策略并加响应性测试，避免不可信导入阻塞 Node 主线程或 Tokio worker。

### P2 / 安全卫生与后续边界

8. `identity.seed()` 返回的临时 `[u8;32]`（`secret.rs:273,314`）和解密产生的 `plaintext Vec`（`secret.rs:385-398`）没有统一 zeroize；`SecretSeed` 本身虽 `ZeroizeOnDrop`，中间副本仍可能留在内存。应在 API 文档和实现中明确清零边界。
9. v1 没有 `fabric_id` 是合理的：token 是 identity export，不是 fabric recovery；不能为满足恢复产品而偷偷把 roster/facts/invites 塞入该格式。完整 fabric 快照应另立版本化 change。

## 与 open2fa Encrypted Export 的同构/冲突

这里使用 `/Users/kzf/Dev/GitHub/open2fa` 的一手文档，而不是猜测未定义的二进制格式：`CONTEXT.md:47-49` 将 Encrypted Export 定义为用户主动、可选、完整性认证的加密归档；closed issue 12（`tasks/open2fa-v1/.issues/closed/12-simplify-recovery-to-optional-encrypted-export.md:11-20`）明确 v1 只做主动 export→import，不做强制 onboarding、自动备份、门限/社会化恢复或独立 Recovery Kit 生命周期。dweb 的“显式导出、托管方只持密文、内核不规定云/本地信任模型”与此同构。

冲突在范围：open2fa 的 Encrypted Export 是**完整归档**，恢复 Auth Service 控制权和全部 Credential 数据；dweb `dwebkey1.` 只含 32B identity seed，roster/facts/invites 留在 data_dir，因此只能称 identity export。另一个结构差异是 open2fa 明确区分 Root Principal、Root Key、Device Principal、Key Epoch（`CONTEXT.md:11-24`），而 dweb 当前单一 iroh SecretKey 同时承担 transport/fact/invite/PoP 权威；dweb v1 不应暗示已有逻辑 Principal 或 key-epoch 轮换。多接收方/门限恢复保持 out of scope 与 open2fa v1 决策一致。

## 评分与放行结论

**最终评分：6.8/10（相对初稿 5.0，+1.8）。**

加分来自：SecretInjection 形状正确、open 缺身份和 seed-roster mismatch 语义已落地、v1 KDF 参数 DoS 防护真实存在、opaque SDK handle 和身份导出范围清晰、主要门禁全绿。扣分来自：原子 create 仍有真实竞态、SDK 并发可 panic 且失败不可重试、OpenSpec trait/任务状态/导出头布局漂移，以及中间明文清零和 AAD 规范不一致。

一句话放行结论：**当前不放行；先修复 P0 的文件 create、SDK handle 原子消费和 OpenSpec 契约漂移，再进行一次复审。**
