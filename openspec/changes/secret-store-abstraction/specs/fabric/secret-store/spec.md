# fabric/secret-store

## Purpose

定义节点私钥存储的抽象边界：内核不规定 secret 的存放位置与信任模型（本地文件、系统安全存储、加密托管、产品代管都是实现方），只要求读写语义正确且显式。

## ADDED Requirements

### Requirement: SecretStore trait

内核 SHALL 提供 `SecretStore` trait 作为 identity 私钥的存储抽象：`load() -> Option<32B seed>`、`store(seed)`、`exists() -> bool`。实现 MUST 保证 store 的原子性（不产生半写状态）与 load 的完整性校验（长度必须为 32B，否则报错而非返回部分数据）。内核自身的构造路径（create_root/open/attach/join_with_token）MUST 经由 SecretStore 读写私钥，不得绕过抽象直接触碰文件。

#### Scenario: 自定义存储实现可用

- **WHEN** 产品方提供一个内存/数据库/Keychain 的 SecretStore 实现
- **THEN** Fabric 以该实现构造后，身份读写全部经过它，文件系统不出现任何 identity 相关写入

#### Scenario: 非原子写入被契约排除

- **WHEN** 实现方在 store 中产生半写状态后进程崩溃
- **THEN** 该实现的 load 必须报错（由实现的原子性保证），内核不得把损坏数据当作合法 seed

### Requirement: FileSecretStore 默认实现

内核 SHALL 提供 `FileSecretStore`：现 `identity.key` 行为的等价收敛——缺失时视为无身份（由上层决定生成）、写入采用 tmp+fsync+rename 原子写、unix 权限 0600、存在但长度≠32B 时报含路径的错误。`dataDir` 便捷路径 SHALL 等价于 FileSecretStore 指向该目录。

#### Scenario: 现有用户零迁移

- **WHEN** 使用旧版本创建的 dataDir（含 identity.key）以新版本打开
- **THEN** 身份不变，行为与文件语义完全一致

### Requirement: seed 注入构造

Fabric 构造 SHALL 支持直接注入 32B seed（`with_secret` 类 API）：跳过存储读取、以注入 seed 派生身份；同时 SHALL 支持注入 SecretStore 实例。注入路径 MUST NOT 触发任何隐式存储写入（除非显式调用 store）。

#### Scenario: 注入 seed 的身份确定

- **WHEN** 两次以同一 seed 注入构造 Fabric
- **THEN** EndpointId 完全一致，且期间无存储副作用

#### Scenario: 明文 seed 不落盘

- **WHEN** 使用 seed 注入构造且未显式调用 store
- **THEN** 数据目录不出现私钥文件

### Requirement: 信任模型中立

文档（crate 级 rustdoc + design）SHALL 阐明信任模型光谱——纯本地（默认）/加密托管（密文上云、解密能力在用户）/产品代管（服务方持有明文）——并声明内核对所有位置中立：验证仅依赖密码学事实（签名/内容寻址），与 secret 存放位置无关。

#### Scenario: 文档可审计

- **WHEN** 产品方评估账号托管 key 的方案
- **THEN** 在设计文档中能找到三种信任模型的边界描述与各自的威胁模型说明
