# fabric/secret-export Specification

## Purpose
定义身份的加密导出/导入格式：显式、可审计的迁移/恢复原语。它是"加密托管、云恢复、账号系统帮用户存 key"类产品的构建材料——托管方持有密文，解密能力始终在持有口令的用户手里。

## Requirements

### Requirement: 加密导出格式

内核 SHALL 提供身份导出：以用户口令派生密钥（Argon2id，参数随格式版本固化并写入头部），对 32B seed 做 AEAD 加密（ChaCha20-Poly1305），输出自包含字符串 `dwebkey1.` + base64url( header || salt || nonce || ciphertext || tag )。头部 SHALL 含版本号与 KDF 参数，域分离常量 MUST 覆盖全部被签名/加密字段。导出操作 MUST 是显式调用（任何构造路径不得隐式导出）。

#### Scenario: 导出-导入往返

- **WHEN** 以口令 A 导出身份，再以口令 A 导入到新环境
- **THEN** 恢复出的 EndpointId 与原身份一致

#### Scenario: 错误口令失败

- **WHEN** 以口令 B 导入用口令 A 导出的密文
- **THEN** 导入失败（AEAD 认证失败），不产生任何部分恢复

#### Scenario: 篡改被拒

- **WHEN** 密文任意字节被篡改后导入
- **THEN** 导入失败并报格式/认证错误，不 panic

### Requirement: 导入的显式性

导入 SHALL 返回 seed/身份材料给调用方（或经调用方提供的 SecretStore 落盘），不得隐式覆盖已有身份；目标位置已有身份时 MUST 由调用方显式决定覆盖与否。

#### Scenario: 不覆盖既有身份

- **WHEN** 导入时目标 SecretStore 已有身份且调用方未显式授权覆盖
- **THEN** 导入报冲突错误，原身份不受影响

### Requirement: KDF 参数有下限

导出格式固化的 Argon2id 参数 MUST 不低于当时公认的安全下限（m≥19MiB、t≥2、p≥1），且导入方 MUST 严格按头部参数执行（不为兼容而放松），参数升级通过新版本号表达。

#### Scenario: 参数随版本演进

- **WHEN** 未来版本提高 KDF 参数
- **THEN** 旧格式仍可导入（按其头部参数），新导出使用新参数并递增版本
