# secret-store-abstraction 设计评审

评审日期：2026-08-26  
评审对象：`openspec/changes/secret-store-abstraction`，并核对当前工作树中 `crates/dweb-fabric/src/secret.rs` 的未提交实现。  
质量基线：`docs/codex-review-round4.md` 给出的 fabric-mvp 质量基线为 7.2/10。

## 结论先行

当前初稿的方向正确：把身份秘密从 `data_dir` 文件路径中抽离，同时保留 `FileSecretStore` 零迁移默认值；把导出定义为显式、版本化、带认证的身份迁移原语；把邀请消费的线性化决策点作为部署拓扑知识。

但当前设计不能按原样进入实现。评分 **5.0/10（设计方向 7.0，当前可实现契约 5.0）**。以下四项是放行阻塞：

1. `exists -> load -> store` 不是原子初始化协议；并发构造可能生成两个身份，`store` 也没有定义拒绝覆盖、条件覆盖或轮换语义。
2. 导入端按不可信头部直接执行 Argon2 参数；当前代码没有上限或 v1 精确值检查，攻击者可构造极大 `m_cost/t_cost/p_cost` 触发内存/CPU 拒绝服务。测试自身也因对每个字节重复 Argon2，在约 60 秒后被 SIGKILL。
3. `Fabric` 的构造生命周期没有区分 create/open/attach 的身份语义；`open` 不应在缺失身份时静默生成新身份，`create_root` 也不应在已存在 roster 时先落盘一个新身份。seed 与 roster 不匹配时必须在启动前失败且不写入。
4. 这个 token 只包含 32B identity seed，不是完整 fabric 恢复包。当前文案若称“恢复身份”尚可，若称“恢复 fabric”则错误：roster、`invites.consumed` 和其它事实仍在独立目录。必须明确身份导出与完整 fabric 快照是两个不同能力。

另有两个当前实现级阻塞：身份损坏错误的既有测试已回归为 `IdentityError::Store(Corrupted {..})`，不再匹配既有 `IdentityError::Corrupted`；`FabricConfig`/SDK 目前尚未接入 `SecretInjection`、导出导入 API，故 OpenSpec 的 SDK 任务并未实现。

## 一手信源核验

### 本地实现与规范

- `identity.rs` 原契约是 `<data_dir>/identity.key`、32B、Unix `0600`、tmp + `fsync` + `rename`，损坏长度必须报含路径的 `IdentityError::Corrupted`；见当前文件模块文档及测试。
- `fabric.rs:24-39` 的 `FabricConfig` 目前只有 `data_dir`、relay、advertise addresses；`create_root/open/attach` 在 `fabric.rs:125-151` 都调用 `NodeIdentity::load_or_create`，因此缺失身份会在 `open` 和 `attach` 中一律生成并持久化。
- `roster.rs:261-295, 864-900` 的邀请 CAS 是同一 `data_dir` 上 Unix `flock` + 临界区内重读日志；这只保证共享该目录的执行位置，不保证多执行位置加最终一致存储。
- 当前未提交 `secret.rs:100-104` 的 trait 是对象安全的同步 trait；`secret.rs:124-190` 实现了旧文件布局；`secret.rs:241-289` 导入时从 token 读取 Argon2 参数并直接派生；`secret.rs:262-274` 没有资源上限或 v1 精确值校验。
- `cargo test -p dweb-fabric --lib identity::tests::corrupted_key_file_errors_with_path` 已失败：实际错误为 `Store(Corrupted { ... })`，不是旧测试期望的顶层 `Corrupted`。完整库测试中的 Argon2 篡改遍历在 60 秒以上后进程收到 SIGKILL。

### 外部密码学资料

- OWASP Password Storage Cheat Sheet 的当前 Argon2id 最低配置是 **19 MiB memory、iteration count 2、parallelism 1**：<https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#argon2id>。所以 `m=19456 KiB,t=2,p=1` 是 OWASP 下限，不能写成 RFC 9106 的推荐配置。
- RFC 9106 §4 给出的通用推荐是 Argon2id `m=2^21 KiB (2 GiB), t=1, p=4`；受限内存的第二推荐是 `m=2^16 KiB (64 MiB), t=3, p=4`，并建议按设备时间/内存预算选择：<https://www.rfc-editor.org/rfc/rfc9106#section-4>。dweb 的 19 MiB 方案可作为跨端最低档，但应标注为产品兼容下限，并在产品层做设备基准和口令策略。
- `argon2 0.5.3` docs.rs 的 `ParamsBuilder` 允许 `m_cost` 在 `8*p` 到 `2^32-1`、`t_cost` 在 `1` 到 `2^32-1`、`p_cost` 在 `1` 到 `2^24-1`；库本身不会替应用执行 OWASP 下限或资源上限：<https://docs.rs/argon2/0.5.3/argon2/struct.ParamsBuilder.html>。
- `argon2 0.5.3` crates.io 元数据确认其为 RustCrypto 的 Argon2d/Argon2i/Argon2id 实现，当前工作树锁定版本为 0.5.3：<https://crates.io/crates/argon2/0.5.3>。
- `chacha20poly1305 0.10.1` docs.rs 说明其为 RFC 8439 的纯 Rust ChaCha20-Poly1305 AEAD；示例使用 256-bit key、96-bit nonce，并要求同一 key 下 nonce 唯一：<https://docs.rs/chacha20poly1305/0.10.1/chacha20poly1305/>。RFC 原文见 <https://www.rfc-editor.org/rfc/rfc8439#section-2.8>。
- `chacha20poly1305 0.10.1` crates.io 元数据确认当前依赖版本和 `aead`/`zeroize` 依赖：<https://crates.io/crates/chacha20poly1305/0.10.1>。

以上资料支持选用 Argon2id + ChaCha20-Poly1305，但不支持“无上限地执行头部参数”或把 19 MiB 宣称为 RFC 的首选参数。

## 逐项批判

### 1. SecretStore trait

**同步 vs async。** v1 保留同步 trait 是可以成立的，前提是契约只承诺短时本地/系统安全存储；网络账号系统不应在 Tokio worker 上执行阻塞同步 I/O，应先在产品层解密成一次性 seed 再走 `Seed` 注入。若未来需要真正远端 store，另立 `AsyncSecretStore`（返回 boxed future 以保持 `dyn` 对象安全），不要把当前 `dyn SecretStore` 突然改成不可对象化的 `async fn` trait。文档必须写明同步 store 不得做未界定的网络等待。

**对象安全。** `fn exists/load/store(&self)` 没有泛型、`Self` 返回值或 async RPIT，因此当前形状对象安全；`Send + Sync` 适合被异步 Fabric 共享，`'static` 则把借用型 store 排除，但与 `Arc<dyn SecretStore>` 的长期持有一致。对象安全不是当前问题，原子语义才是。

**`exists` 是错误抽象。** `exists()` 与随后 `load()` 之间有 TOCTOU；权限错误还可能被 `Path::exists()` 折叠成 false。初始化只需要一次 `load`，创建必须是存储后端提供的原子 `create-if-absent`。建议 v1 trait 为：

```rust
pub trait SecretStore: Send + Sync + 'static {
    fn load(&self) -> Result<Option<SecretSeed>, SecretStoreError>;
    fn create(&self, seed: &SecretSeed) -> Result<(), SecretStoreError>; // 已有值 => Conflict
    fn replace(&self, expected: SecretFingerprint, seed: &SecretSeed)
        -> Result<(), SecretStoreError>; // 显式轮换/改包裹
}
```

`SecretSeed` 是带 `Zeroize + ZeroizeOnDrop` 的 32B newtype；其 `Debug` 必须固定输出 `[REDACTED]`。如 v1 不实现轮换，`replace` 可以暂不公开，但至少必须有 `create` 而不是可静默覆盖的 `store`。导入默认走 `create`，已有身份返回 `Conflict`。

**错误类型。** `Custom(String)` 会丢失来源和可分类性。至少需要 `NotFound`（仅在 API 需要）、`Corrupted { location, reason }`、`Permission`、`Unavailable`、`Conflict`、`Io`、`Unsupported`；错误文本绝不包含 seed/passphrase。兼容旧 API 时将 File store 的 `Corrupted/Read/Write` 映射回旧 `IdentityError` 变体，不能让零迁移测试退化成一个新的包装层。

**并发与持久化。** `create` 必须由后端线性化。File store 用 `create_new` 或同目录锁保护“检查不存在 + rename”；多个进程不能共用固定 `<key>.tmp`。替换需要唯一临时文件、写入、文件 `fsync`、rename 后父目录 `fsync`；Windows 的 `rename` 不能假定等价于 Unix 覆盖替换，应使用平台原子替换 API 或 v1 明确只允许 create-once。

### 2. FileSecretStore

旧布局保持 `<data_dir>/identity.key`，确保现有用户零迁移，但“默认实现等价”应包括错误映射、并发、崩溃恢复和权限，而不只是路径。

Unix `0600` 只约束文件本身；应同时考虑目录权限、符号链接/硬链接替换和临时文件遗留。`path.exists()` 不应吞掉 EACCES。非 Unix 当前 `restrict_permissions` 是 no-op（`secret.rs:333-337`），不能继续宣称同等安全：Windows 应创建/校验只允许当前用户和系统的 DACL；不具备可验证 ACL 的平台应返回 `Unsupported` 或明确降级为宿主责任并在文档中标红。跨平台契约必须分别测试，而不是用一个空函数掩盖差异。

### 3. with_seed 与 FabricConfig

`with_seed` 的零存储副作用是正确且必要的，但必须是只读注入，不得隐式回写 store。配置建议如下：

```rust
pub enum SecretInjection {
    Default,                         // 运行时由 data_dir 解析 FileSecretStore
    Seed(SecretSeed),                // 纯注入，绝不读写 store
    Store(Arc<dyn SecretStore>),     // load/create 按构造模式决定
}

pub struct FabricConfig {
    pub data_dir: PathBuf,           // v1 仍表示 roster/facts/invites 目录
    pub secret: SecretInjection,
    pub relay: RelayConfig,
    pub advertise_addrs: Vec<String>,
}
```

不要做 `Default(dataDir)` 这种同时复制路径的枚举值：用户修改 `data_dir` 后会出现两个不一致路径。`Default` 在 `create/open/attach` 内根据最终 `data_dir` 解析；若未来需要完全分离路径，再增加显式 `SecretInjection::File(PathBuf)`。`FabricConfig` 的 `Debug` 必须手写，Seed 只显示 `[REDACTED]`；否则 `#[derive(Debug)]` 会把 32B seed 打入日志。`Clone` 可以保留，因为 `Arc` 可克隆，但应意识到 Seed 会产生额外内存副本。

构造模式必须明确：

| 操作 | Default/Store 缺失身份 | Seed | roster 规则 |
| --- | --- | --- | --- |
| `create_root` | 仅在 roster 不存在时原子 create；已存在 roster 先报 AlreadyExists | 仅创建新 fabric | 不得覆盖既有 roster |
| `open` | **只允许 load，缺失报 MissingIdentity，不生成** | 直接使用 | 读取 roster 后校验 seed 对应 EndpointId 是 root/有效成员 |
| `attach` | 可在空 roster 中 create 新身份 | 直接使用 | 允许空 roster；收到 Genesis/join 后再建立成员投影 |
| `join_with_token` | 等价 attach，再执行 verify -> CAS consume -> grant | 同上 | token.fabric_id 必须与 attach 的 roster 一致 |

启动顺序应保证：发现既有 roster 或身份冲突时，不先生成并落盘新 seed；Seed 与 roster 不一致返回 `IdentityRosterMismatch`，不触发任何写入。`open` 的成员校验不能只依赖 endpoint 能否签名，因为任意 seed 都能签名；必须检查 roster 的 Genesis/root 或有效成员投影。

### 4. secret-export 格式

**选型。** Argon2id + ChaCha20-Poly1305 是合理的跨平台组合。19,456 KiB/2/1 与 OWASP 最低配置同构；它不是 RFC 9106 的首选 profile，应把“最低兼容档”和“产品基准档”分开。16B salt 满足 RFC 9106 的 128-bit 建议；12B nonce 与 RFC 8439/`chacha20poly1305` API 一致；每次导出必须随机生成 nonce，禁止同一派生 key 重复 nonce。

**参数固化 vs 协商。** v1 的参数既然固化，就必须在解析完 header 后、派生之前要求精确等于 `m=19456,t=2,p=1`；不能把可篡改 header 当成协商输入。否则只要修改 4 字节 m 就可令导入端尝试 GB 级内存。未来提高参数必须使用新版本号和该版本的明确允许集合；若为了历史兼容读取旧 token，也只允许已知版本/已知参数，不接受任意 u32。

**AAD。** 当前实现只把 `header` 放进 AAD（`secret.rs:220-228, 279-283`）。修订后 AAD 应为固定域常量 + 完整 metadata（prefix/magic/version/algorithm/参数/salt/nonce）；这样所有可见字段都直接被认证。salt 改变本身会改变 KDF key，nonce 改变通常会导致认证失败，但不能以“间接生效”代替格式明确的 metadata 认证。

**建议保持 v1 wire 兼容的布局：**

```text
ASCII "dwebkey1." || base64url-no-pad(
  magic b"dweb/key/v1\\0"
  || version u8 = 1
  || kdf_id u8 = ARGON2ID
  || m_cost u32 BE = 19456
  || t_cost u32 BE = 2
  || p_cost u32 BE = 1
  || salt[16]
  || nonce[12]
  || ciphertext(seed[32])
  || tag[16]
)
```

若必须保留初稿的 `p u8`，至少要在规范中固定其编码，不能让未来版本猜测；新增 `kdf_id` 和 `p u32` 更易演进，但会形成新的 wire revision。解析器必须先限制 token 总长度，再严格 base64、magic、version、字段长度，最后执行精确参数检查。错误口令和篡改统一返回认证失败，不泄露“哪一部分猜对了”。加密失败不能被误报为 `Kdf` 错误。

**口令。** 口令按 UTF-8 字节使用，不做隐式 Unicode 规范化；协议应规定空口令拒绝、最大字节长度和产品层最小强度策略。内核不能声称 Argon2 下限能弥补用户选择的弱口令。导出/导入中的中间 key、plaintext seed 和 ciphertext buffer 应尽可能使用 zeroize；Rust 返回的可复制值仍要在 API 文档中标注生命周期。

**轮换与多接收方。** 口令轮换只是重新导出同一 seed，不是 identity key rotation。identity seed 轮换会改变 EndpointId，并需要 roster 中的旧钥到新钥的签名迁移/epoch 协议，v1 不应假装已经支持。多接收方也不进入 v1；未来若需要账号托管、多个恢复方或设备密钥，应新建“随机 DEK + 每接收方包裹 DEK”的 envelope/HPKE/age 类 v2，不把多个口令拼进 v1。

**fabric_id。** 通用 `export_secret(identity, passphrase)` 不应强制包含单一 `fabric_id`：同一身份可以被产品有意注入多个 fabric，且当前 token 的语义是 identity material。可是 `Fabric::open` 必须校验 roster 与 EndpointId；若产品要导出“某个 fabric 的完整恢复包”，应另立 fabric snapshot 格式，包含 fabric_id、roster/facts、consumed-invite 状态及其版本，而不是给 identity token 偷塞一个不可解释的上下文。高层 API 可以接受 `expected_fabric_id` 做导入后校验，但不能把身份 token 宣称为完整恢复。

### 5. SDK 面

不建议 `FabricOptions.secretSeed?: string`。明文 hex 会产生不可控的 JS 字符串副本，容易进入日志、异常、heap dump 和 telemetry；它也会绕过 Rust 侧 zeroize。优先级如下：

1. `importSecret(token, passphrase)` 返回 native `SecretSeedHandle`（内部 zeroize，`Debug` 脱敏），`FabricOptions.secret` 接受该 handle；SDK 默认只传递 token 和口令。
2. 若 N-API 约束暂时不允许 opaque handle，接受 `Buffer` 而非字符串，构造完成后尽力清零输入 Buffer，并在文档中明确 V8 仍可能保留副本；不要在错误文本或日志中打印它。
3. 不提供 JS 自定义 `SecretStore` 回调；这是初稿 out of scope 的正确判断。产品云托管通过产品自己的网络层取回密文/解密材料，再注入一次性 handle。

导出 API 只返回加密 token 字符串；导入 API 默认返回 opaque handle 或 Rust 侧受保护材料，而不是 hex seed。类型声明、错误枚举和 shutdown 后行为必须与现有 SDK 契约同步。

## 缺失的设计点

1. **身份创建与 roster 创建的事务边界。** 需要定义失败时是否允许只留下 identity.key；建议 `create_root` 先在同一 data-dir 锁下检查 roster，再使用 `create-if-absent`，并在 roster 持久化失败时提供可审计恢复/清理策略。
2. **Store 的原子 create/replace。** 当前 spec 只说 `store` 原子，没有说不可覆盖、条件覆盖或版本；这不足以满足并发初始化、导入冲突和未来轮换。
3. **seed 与 roster 不一致。** `open` 必须拒绝；`attach` 的空 roster 是唯一允许暂时没有成员的模式；收到 Genesis 后必须验证当前身份是否被授权。
4. **FileSecretStore 的非 Unix 权限。** no-op 不是跨平台安全契约；需要 Windows ACL/失败关闭策略，目录和 symlink 处理也需要明确。
5. **导出范围。** 当前 token 只有 seed，必须命名为 identity export。完整 fabric recovery 需要独立 snapshot change，否则用户会以为 roster/facts 也被备份。
6. **资源上限。** 解析 token 的总长度、passphrase 最大长度、Argon2 内存/时间上限、并发导入数和取消/超时策略都缺失。对不可信 token 不能让一次导入阻塞整个 Tokio worker。
7. **秘密生命周期。** `[u8;32]`、`NodeIdentity::seed()`、SDK 参数和异常路径会复制明文；需要 zeroize newtype、脱敏 Debug、日志规则和内存转移说明。
8. **文件 durability/并发。** 固定 `.tmp`、缺少父目录 fsync、Windows replace 语义、异常退出后的 tmp 文件处理未定义。
9. **错误兼容。** 既有 `IdentityError` 变体是对外可观察契约；包装 `Store` 不能破坏旧调用者/测试。
10. **部署拓扑。** 现有 `flock` 是 Unix、本地目录级决策点；自定义 Store 不能自动给 `invites.consumed` 提供 CAS。文档应要求 redeem 请求只进入一个线性化执行位置，或把 CAS 交给明确的后端。

## 与 open2fa Encrypted Export 的同构与冲突

以下判断基于本地一手文档，不推测 open2fa 尚未定义的二进制格式：

- `open2fa/CONTEXT.md:47-49` 将 Encrypted Export 定义为用户主动创建、可选、完整性认证的加密归档；`tasks/open2fa-v1/.issues/closed/12-simplify-recovery-to-optional-encrypted-export.md:11-20` 明确 v1 只做主动 `export -> import`，不做强制 onboarding、自动备份、门限/社会化恢复或独立 Recovery Kit 生命周期。这与 dweb“显式导出、无隐式云控制点、out of scope 云 FactStore”同构。
- open2fa 文档同时说导出是**完整**归档，包含恢复 Auth Service 控制权和全部 Credential 所需数据；dweb 当前 token 只有 identity seed，roster/facts/invites 仍在 `data_dir`，因此不能复用“完整恢复”措辞。这是本 change 最大的产品语义冲突。
- `open2fa/CONTEXT.md:15-20` 区分逻辑 Root Principal、Root Key 与 Key Epoch；`closed/09...:18-23` 说 v1 保留轮换能力但使用一个活跃 Root Key。dweb 当前单个 iroh `SecretKey` 同时承担 transport、fact、invite、PoP 签名，导出 seed 等价于复制全部当前 authority。二者都可以使用“密钥材料受保护导出、逻辑身份与承载位置分离”的原则，但 dweb 不能暗示已有 Principal/Device/Epoch 轮换语义。
- open2fa `closed/12...:19-20` 要求内部存储密钥结构与导出文件结构正交；dweb 应保持同样边界：SecretStore 负责在线身份材料，secret-export 负责显式迁移；不要因为导出而把 roster 持久化或 Automerge Adapter 拉进本 change。
- open2fa 的多 Root、门限、Recovery Kit、自动备份均是明确 out of scope；因此 dweb v1 不做多接收方/门限是相容的。未来账号托管可作为密文存储 Adapter，但不能把账号服务升级成 dweb 的不可替代信任根。

## 修订后的完整设计（可直接替换 design.md）

### 目标与边界

`secret-store-abstraction` 只抽象**identity seed 的存放与显式迁移**。它不抽象 roster/facts/invites 的持久化，不实现云 FactStore、InviteLog Adapter、Automerge Adapter，也不规定产品采用本地、加密托管或产品代管哪种信任模型。

```text
identity seed
  └─ SecretStore: File / Keychain / product backend / explicit Seed

roster.facts + invites.consumed
  └─ 当前仍由 data_dir 持久化；未来另立 StorageAdapter change

invite redeem
  └─ verify -> 一个线性化 CAS 决策点 -> grant
```

### SecretSeed 与 SecretStore

```rust
#[repr(transparent)]
pub struct SecretSeed([u8; 32]); // Zeroize + ZeroizeOnDrop; Debug 脱敏

pub trait SecretStore: Send + Sync + 'static {
    fn load(&self) -> Result<Option<SecretSeed>, SecretStoreError>;
    fn create(&self, seed: &SecretSeed) -> Result<(), SecretStoreError>;
    // v1 可暂不实现；若公开，必须带 expected fingerprint，禁止无条件覆盖。
    fn replace(&self, expected: SecretFingerprint, seed: &SecretSeed)
        -> Result<(), SecretStoreError>;
}
```

`load` 的 `None` 表示后端确认不存在；权限/网络/损坏必须是错误。`create` 是线性化 insert-if-absent，已有值返回 `Conflict`。所有实现必须保证不会返回部分 seed；原子性、完整性和并发语义属于实现契约，而非调用方猜测。

v1 保留同步 trait，但文档规定实现不得进行未界定的网络阻塞；远端托管使用产品层 `import -> SecretSeedHandle/Seed`。未来真正需要异步后端时，另立对象安全的 `AsyncSecretStore`。

`FileSecretStore` 默认路径仍为 `<data_dir>/identity.key`，读长度必须为 32B，Unix 文件权限为 0600；创建使用唯一临时文件 + fsync + 原子 rename + 父目录 fsync；已有文件不可由 `create` 覆盖。Windows 使用可验证的用户/系统 ACL 和原子替换 API；无法满足时返回 `Unsupported`。保留旧 `IdentityError::Corrupted/Read/Write` 映射，保证零迁移行为可观察等价。

### FabricConfig 与构造语义

```rust
pub enum SecretInjection {
    Default,
    Seed(SecretSeed),
    Store(Arc<dyn SecretStore>),
}

pub struct FabricConfig {
    pub data_dir: PathBuf, // v1 roster/facts/invites 目录
    pub secret: SecretInjection,
    pub relay: RelayConfig,
    pub advertise_addrs: Vec<String>,
}
```

`Default` 在运行时用最终 `data_dir` 构造 `FileSecretStore`，避免复制路径。配置 Debug 脱敏。`create_root`、`open`、`attach` 按前述表格执行；启动时先判定 roster 状态和身份来源，任何冲突都在写入前返回。`open` 必须验证当前 EndpointId 是 roster root 或有效成员；`attach` 可暂时为空，`join` 后再验证并持久化；seed 注入从不隐式 store。

### dwebkey1 v1

```text
"dwebkey1." + base64url-no-pad(
  magic || version=1 || kdf_id=argon2id
  || m_cost=19456(u32 BE) || t_cost=2(u32 BE) || p_cost=1(u32 BE)
  || salt[16] || nonce[12]
  || ChaCha20-Poly1305(seed[32], AAD=domain || all metadata)
)
```

OWASP 下限是 v1 的兼容档，不是 RFC 9106 首选；产品应基准测试并可在未来版本提高参数。v1 导入只接受精确已知参数，先做 token/字段长度上限检查，拒绝任何其它参数后才执行 Argon2id。Argon2 输出 32B key；AEAD 使用 RFC 8439 ChaCha20-Poly1305，nonce 每次随机且同 key 不复用。错误口令、篡改和认证失败统一为不可区分的 Auth 错误；格式/版本错误在未派生前返回。passphrase 按 UTF-8 原样处理，拒绝空值并限制最大长度。

该 token 是**identity export**，不携带完整 roster。低层 import 返回受保护的 `SecretSeed`；高层 `Fabric::import_secret` 可要求 `expected_fabric_id` 并在应用 roster 上校验，但完整 fabric snapshot 必须另立版本化 change。口令重置是重新导出；identity key rotation、Key Epoch、multi-recipient 不进入 v1。

### SDK

SDK 公开 `exportSecret(passphrase): Promise<string>`，导入返回 native opaque `SecretSeedHandle`；`FabricOptions.secret` 接受 handle。暂不公开 `secretSeed: string`。若平台只能接收 `Buffer`，构造后尽力清零并明确 V8 副本风险。任何 seed、passphrase、token 不写日志；错误只返回分类码/脱敏信息。JS 自定义 store 回调继续 out of scope。

### CAS 拓扑知识

`invites.consumed` 的正确性要求一次 redeem 在一个线性化点完成 verify 后的 consume。Unix 同 data-dir 的 flock 是 v0.1 实现；后端 CAS 是另一种实现。多执行位置 + 最终一致存储不成立。该约束写入部署文档和运行时诊断，不伪装成 SecretStore 能力，也不由 SDK 试图自动修复。

## 验收门槛

在实现评审前至少增加以下测试：

- 两个进程/线程同时初始化同一 Store，恰好一个 `create` 成功，另一个收到 Conflict，身份不分叉。
- `open` 缺失身份不生成、不写入；Seed 与 roster 不匹配无副作用；attach 空 roster 仍可 join。
- 任意 header 参数篡改在 Argon2 前被拒绝；最大 token/passphrase 受限；恶意大参数不会分配大内存或阻塞 worker。
- File store 崩溃点、唯一 tmp、父目录 durability、权限错误、Windows ACL/replace（或明确 unsupported）契约测试。
- identity export 往返只证明 EndpointId 恢复；另有测试证明它不声称恢复 roster；完整 snapshot 若需要则单独测试。
- SDK 不再要求明文 hex seed；opaque handle/Buffer 生命周期、错误脱敏和 d.ts consumer fixture 有测试。
- 旧 dataDir、旧 `IdentityError` 变体、损坏 32B 之外文件的行为保持兼容。

## 评分与放行

**5.0/10。**

- 方向与边界：2.0/2.0
- 密码学原语选择与版本化意图：1.5/2.0
- 存储/并发/故障语义：0.5/2.0
- Fabric 生命周期与 roster 绑定：0.5/2.0
- SDK 与跨平台交付：0.5/2.0

修复四个阻塞项、补齐 `FabricConfig`/SDK 契约、恢复旧错误语义并通过上述验收后，可在“身份迁移 v1、非完整 fabric recovery”的明确范围内进入实现复审。公网/生产发布仍不能仅凭本 change 宣称云托管安全、跨平台同等文件权限或完整灾难恢复。

