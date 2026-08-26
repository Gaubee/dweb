# design — secret-store-abstraction

## 定位纠正（Owner 指令，2026-08-26）

dweb 追求**去中心**（无不可替代控制点、用户主权），**不是去云**。内核不规定信任模型：

```text
纯本地（默认）          加密托管                  产品代管
key 只在设备            密文上云、口令派生在用户    服务方持明文 key
（FileSecretStore）     （secret-export 原语）     （产品自选，内核中立）
```

内核守住的三件事：
1. **identity**：secret 注入/导出是显式可审计操作；存放位置 = SecretStore 实现，产品自选。
2. **roster.facts**：事实验证自包含（签名 + BLAKE3 内容寻址），从哪来、存哪都不影响真伪；持久化抽象等到 Automerge StorageAdapter 层（另立 change）。
3. **invites.consumed**：单次兑换的正确性 = 存在**一个线性化决策点**。本地 flock 是 v0.1 实现；产品把 redeem 路由到自有后端则 CAS 天然单点。**不成立的组合：多执行位置 + 最终一致存储**——这是部署拓扑知识，写入文档而非 SDK 禁令。

## D1：SecretStore trait（同步、对象安全；codex 复审定稿）

```rust
pub struct SecretSeed([u8; 32]);  // Zeroize + ZeroizeOnDrop, Debug = [REDACTED]

pub trait SecretStore: Send + Sync + 'static {
    fn load(&self) -> Result<Option<SecretSeed>, SecretStoreError>;
    fn create(&self, seed: &SecretSeed) -> Result<(), SecretStoreError>;
    // 线性化 insert-if-absent：已有身份 => Conflict，绝不覆盖。replace 轮换不在 v1。
}
```

- 同步 trait：契约只承诺短时本地/系统安全存储；**实现不得做未界定的网络阻塞**（远端托管在产品层解密为一次性 seed 后走 Seed 注入）。
- `ensure_with(store)`：load→Some 恢复；None→生成+create；Conflict→回读复用胜者（并发不分叉）。
- `NodeIdentity::with_seed(seed)`：纯注入，零存储副作用。
- `load_or_create(data_dir)` = `with_store(FileSecretStore::new(dir))` 的便捷封装。
- FileSecretStore::create：唯一 tmp（pid+原子计数）+ create_new + fsync + `link(2)`（EEXIST→Conflict）+ 父目录 fsync；非 Unix 返回 Unsupported（fail-closed）。

## D2：secret-export 格式（v1；codex 复审后定稿）

```text
"dwebkey1." + base64url_nopad(
    magic b"dweb/key/v1\0" | version u8(=1) | kdf_id u8(=1 Argon2id)
    | m_cost u32 BE | t_cost u32 BE | p_cost u32 BE
    | salt[16] | nonce[12] | AEAD_ciphertext(seed[32]) || tag[16]
)
```

- KDF：Argon2id，v1 固化 m=19456 KiB、t=2、p=1（OWASP 下限档，非 RFC 9106 首选）。
- AEAD：ChaCha20-Poly1305（RustCrypto `chacha20poly1305`），nonce 随机不复用。
- AAD = `b"dweb/key/aad\0" || header || salt || nonce`（全部 metadata 显式认证）。
- **导入只接受 v1 精确参数**（结构性校验全部在 Argon2 之前，防参数头部 DoS）；参数升级走新版本号。
- 依赖：`argon2`、`chacha20poly1305`（RustCrypto 系，审计过，纯 Rust 可移植）。
- API：`export_secret(identity, passphrase) -> Result<String>`；`import_secret(s, passphrase) -> Result<SecretSeed>`（不落盘；落盘由调用方经 SecretStore 的 create 显式决定）。
- 中间明文（seed 临时数组、解密 plaintext）zeroize；本 token 是 identity export，不含 roster。

## D3：Fabric/SDK 面

- Rust：`FabricConfig` 增加 `secret: SecretInjection`（`Default(dataDir)` | `Seed([u8;32])` | `Store(Arc<dyn SecretStore>)`）；dataDir 路径时 roster 仍走该目录，seed/store 注入时 roster 目录仍由 dataDir 指定（roster 与 secret 解耦）。
- SDK（codex 复审定稿）：opaque `SecretSeedHandle`（一次性 take、失败归还 put_back、endpointId 派生）+ 顶层 `importSecret(token, passphrase)` + 实例 `exportSecretPassphrase(passphrase)`；身份注入为工厂参数 `secret?: SecretSeedHandle`（napi object 不支持 class 字段）；**明文 hex seed 不经 JS**。KDF 调用经 spawn_blocking，不阻塞 Node 主线程。
- 明确不做：JS 自定义 store 回调（napi 摩擦）、云端 FactStore、可插拔 InviteLog、Automerge StorageAdapter。

## 风险

| 风险 | 对策 |
| --- | --- |
| argon2 编译面（blake2/blink?）影响移动端 | argon2 纯 Rust，无 C 依赖；Android/iOS cargo target 可编译，spike 验证 |
| 明文 seed 经 JS 注入的暴露面 | 文档明示：属产品代管/半托管信任模型；默认路径不受影响 |
| 导出口令弱 | 格式固化 KDF 下限；文档建议产品层叠加自家口令策略 |
| trait 未来需要 async | 先同步 + 内部 spawn_blocking 可迁；不为假想需求提前复杂化 |
