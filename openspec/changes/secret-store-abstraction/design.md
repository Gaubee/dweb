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

## D1：SecretStore trait（同步、对象安全）

```rust
pub trait SecretStore: Send + Sync + 'static {
    fn exists(&self) -> Result<bool, SecretStoreError>;
    fn load(&self) -> Result<Option<[u8; 32]>, SecretStoreError>;
    fn store(&self, seed: &[u8; 32]) -> Result<(), SecretStoreError>;  // 实现保证原子
}
```

- 同步 trait：secret 读写都是微小操作，异步徒增绑定摩擦；移动端 Keychain 同步 API 亦常见。
- `NodeIdentity::with_store(store)`：load→Some 则恢复、None 则生成并 store（与现 load_or_create 语义对齐，但"生成并写回"仅发生在无身份时）。
- `NodeIdentity::with_seed(seed)`：纯注入，零存储副作用。
- `load_or_create(data_dir)` 保留 = `with_store(FileSecretStore::new(dir))`。

## D2：secret-export 格式（v1）

```text
"dwebkey1." + base64url_nopad(
    magic b"dweb/key/v1\0" | version u8(=1)
    | argon2id_m u32 | argon2id_t u32 | argon2id_p u8
    | salt[16] | nonce[12] | AEAD_ciphertext(seed[32]) + tag[16]
)
```

- KDF：Argon2id，v1 固化 m=19456 KiB、t=2、p=1（OWASP 2024 下限）。
- AEAD：ChaCha20-Poly1305（RustCrypto `chacha20poly1305`）。
- 域分离：magic+version+参数入 AAD；导入严格按头部执行，参数升级走版本号。
- 依赖：`argon2`、`chacha20poly1305`（RustCrypto 系，审计过，纯 Rust 可移植）。
- API：`export_secret(identity, passphrase) -> Result<String>`；`import_secret(s, passphrase) -> Result<[u8;32]>`（返回 seed，落盘与否由调用方经 SecretStore 决定；store 目标已有身份时报冲突，除非调用方显式覆盖）。

## D3：Fabric/SDK 面

- Rust：`FabricConfig` 增加 `secret: SecretInjection`（`Default(dataDir)` | `Seed([u8;32])` | `Store(Arc<dyn SecretStore>)`）；dataDir 路径时 roster 仍走该目录，seed/store 注入时 roster 目录仍由 dataDir 指定（roster 与 secret 解耦）。
- SDK：`FabricOptions.secretSeed?: string`（hex）；`Fabric.exportSecretPassphrase(passphrase)` 实例方法；`Fabric.importSecret(token, passphrase)` 静态（返回 hex seed 供再次注入）。明文 seed 过 JS 是产品方的信任模型选择，内核不设障。
- 明确不做：JS 自定义 store 回调（napi 摩擦）、云端 FactStore、可插拔 InviteLog、Automerge StorageAdapter。

## 风险

| 风险 | 对策 |
| --- | --- |
| argon2 编译面（blake2/blink?）影响移动端 | argon2 纯 Rust，无 C 依赖；Android/iOS cargo target 可编译，spike 验证 |
| 明文 seed 经 JS 注入的暴露面 | 文档明示：属产品代管/半托管信任模型；默认路径不受影响 |
| 导出口令弱 | 格式固化 KDF 下限；文档建议产品层叠加自家口令策略 |
| trait 未来需要 async | 先同步 + 内部 spawn_blocking 可迁；不为假想需求提前复杂化 |
