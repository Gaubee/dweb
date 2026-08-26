# tasks — secret-store-abstraction

> 执行约束：cargo 命令沿用本地 CARGO_TARGET_DIR；共享文件（根 Cargo.toml/lock）由主会话统一落盘。

## 1. 内核

- [x] 1.1 `crates/dweb-fabric/src/secret.rs`：SecretStore trait + SecretStoreError + FileSecretStore（从 identity.rs 收敛文件行为，语义不变）
- [x] 1.2 identity.rs 重构：`with_store` / `with_seed`；`load_or_create` 变为便捷封装（BREAKING 内部、外部等价）
- [x] 1.3 secret.rs：export/import（Argon2id + ChaCha20-Poly1305，`dwebkey1.` 格式，AAD 域分离）
- [x] 1.4 Fabric 构造支持 SecretInjection（Default/Seed/Store）；seed 注入零存储副作用
- [x] 1.5 测试：自定义 mock store 全程无文件写入 / 旧 dataDir 零迁移 / seed 注入确定性 / 导入导出往返+错误口令+篡改+截断 fuzz（不 panic）/ KDF 参数入头 / 冲突不覆盖

## 2. SDK

- [x] 2.1 身份注入 API（实现为工厂参数 secret?: SecretSeedHandle——napi object 不支持 class 字段，codex 方案优先级一致的 opaque handle）
- [x] 2.2 `exportSecretPassphrase(passphrase)` / 静态 `importSecret(token, passphrase)`；d.ts 同步（fix-dts 后处理）
- [x] 2.3 node --test：seed 注入身份稳定、export→import→再注入恢复同 EndpointId、错误口令拒绝

## 3. 文档与收尾

- [x] 3.1 design/rustdoc：信任模型光谱 + CAS 拓扑约束；README 增"身份存储与恢复"小节
- [x] 3.2 全门禁（cargo fmt/clippy/test + node 套件）+ spec commit 纪律
- [x] 3.3 Codex 设计/实现双评审闭环（讨论→修订→复审）
