# fabric/identity

## Purpose

定义组网节点的密码学身份：如何生成、派生、展示与持久化。身份是名册与门控的信任根，与网络地址解耦。

## ADDED Requirements

### Requirement: EndpointId 派生

系统 SHALL 为每个节点生成 Ed25519 keypair，并以其公钥派生稳定身份标识 EndpointId。EndpointId 的展示形式 SHALL 是确定性的字符串编码，同一公钥在任何设备上编码结果一致。

#### Scenario: 首次初始化生成身份

- **WHEN** 节点在空数据目录首次初始化
- **THEN** 系统生成新 keypair 并派生 EndpointId，且持久化密钥材料
- **THEN** 返回的 EndpointId 字符串可被外部程序用于寻址该节点

#### Scenario: 重启后身份稳定

- **WHEN** 节点使用同一数据目录再次初始化
- **THEN** 加载既有密钥材料，EndpointId 与首次生成时完全一致

### Requirement: 密钥持久化与损坏防护

密钥材料 MUST 持久化在数据目录内的专用文件中，文件权限 MUST 限制为当前用户可读写。密钥文件缺失时允许重新生成；密钥文件存在但无法解析时 MUST 报错退出，不得静默生成新身份（否则旧身份与名册成员关系将失配）。

#### Scenario: 密钥文件损坏时报错

- **WHEN** 密钥文件内容被篡改为无法解析的字节
- **THEN** 初始化失败并返回明确错误，指示密钥文件路径
- **THEN** 不产生新的 EndpointId

#### Scenario: 数据目录迁移后身份跟随

- **WHEN** 用户将整个数据目录复制到另一台机器后初始化
- **THEN** 新机器上的 EndpointId 与原机器一致
