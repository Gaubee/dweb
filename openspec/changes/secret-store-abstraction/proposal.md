# secret-store-abstraction

## Why

fabric-mvp 把节点身份/名册/邀请消费记录绑死在 `dataDir` 文件路径上，等于内核隐式规定了"本地文件 + 系统权限"这一种信任模型。产品定位纠正（Owner，2026-08-26）：dweb 追求的是**去中心（无不可替代控制点、用户主权），不是去云**——账号系统加密托管设备 key、云端恢复、Keychain 存储都是合法的产品形态。内核的职责是**不预设信任模型**：把 secret 的存放位置变成可注入的实现细节，同时提供显式、可审计的注入/导出操作。

## What Changes

- 内核（crates/dweb-fabric）新增 `SecretStore` trait：identity 私钥的 load/store 抽象；现文件行为（0600/原子写/损坏报错）收敛为默认实现 `FileSecretStore`。
- 新增**加密导出/导入**格式（口令派生密钥 + AEAD）：显式的身份迁移/恢复原语——这是"加密托管/云恢复"类产品的构建材料。
- Fabric 构造 API 支持注入 SecretStore 与注入 seed（`with_secret`），`dataDir` 保留为便捷默认。
- SDK（@dweb/client-sdk）暴露 `exportSecret(passphrase)` / `importSecret` / seed 注入选项。
- 设计文档新增**信任模型光谱**（纯本地/加密托管/产品代管）与 **CAS 拓扑约束**（单次兑换需要线性化决策点；多执行位置 + 最终一致存储的组合不成立）——作为部署知识而非 SDK 禁令。
- **BREAKING**（内核内部）：`NodeIdentity::load_or_create(data_dir)` 重构为基于 SecretStore 的构造，保留同名便捷函数向后兼容。

## Capabilities

### New Capabilities
- `fabric/secret-store`: SecretStore trait、FileSecretStore 默认实现、seed 注入构造——内核不规定 secret 的存放位置与信任模型。
- `fabric/secret-export`: 加密导出/导入格式——显式可审计的身份迁移原语，供加密托管/云恢复类产品组装。

### Modified Capabilities
- `fabric/identity`: 密钥持久化需求从"数据目录文件"改为"SecretStore 实现"；文件行为降级为默认实现的行为契约。

## Impact

- `crates/dweb-fabric`：identity 模块重构、新增 secret 模块；新增依赖 argon2/chacha20poly1305（RustCrypto，审计过）。
- `packages/client-sdk`：FabricOptions 增加 secret 注入项 + exportSecret API；index.d.ts 同步。
- 现有 dataDir 用户零迁移成本（默认实现等价）。
- 明确不做（out of scope）：云端 FactStore、可插拔 InviteLog、JS 侧自定义 store 回调（napi 摩擦大收益小）、Automerge StorageAdapter（那是 roster 持久化的正确抽象层，另立 change）。
