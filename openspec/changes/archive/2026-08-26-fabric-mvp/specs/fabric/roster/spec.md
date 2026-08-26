# fabric/roster

## Purpose

定义"受控邀请他人进入我的网"的核心语义：一个 fabric 拥有唯一信任根（Genesis），成员关系以内容寻址的签名事实表达，经 union-merge 收敛，撤销前向生效。名册是连接门控与授权的唯一依据。

## ADDED Requirements

### Requirement: Fabric 身份与 Genesis 根

每个网络（fabric）SHALL 拥有唯一的 `FabricId` 与一条不可变的 Genesis 事实（fabric_id、root EndpointId，由 root 密钥签名）。v0.1 中仅 root EndpointId 有权签发 MemberGrant 与 Revoke；其它任何主体签发的事实 SHALL 存储但不产生任何授权效果（fail-closed）。事实的规范字节 SHALL 包含 fabric_id，跨 fabric 的事实 MUST NOT 在投影中生效。

#### Scenario: 非 root 签发不产生授权

- **WHEN** 一条签名有效但签发者非 root 的 MemberGrant 进入本地事实集合
- **THEN** 该事实被存储，但有效成员投影不因此改变

#### Scenario: 跨 fabric 事实隔离

- **WHEN** 收到 fabric_id 不匹配的事实
- **THEN** 该事实被拒绝入库并计入异常统计

### Requirement: 内容寻址事实模型

成员关系 SHALL 表示为不可变签名事实：kind（Grant/Join/Revoke）、fabric_id、签发者 EndpointId、主体 EndpointId、显示名（可选）、签发时间、可选过期时间、目标 grant id（Revoke 专用）。事实 id SHALL 为未签名规范字节的 BLAKE3 哈希（内容寻址）；规范字节使用域分隔前缀与显式长度前缀的确定性布局，签名覆盖域分隔后的规范字节，签名密钥为与 iroh Endpoint 同源的 Ed25519 密钥（不得引入第二套未绑定的签名密钥体系）。

#### Scenario: 事实可独立验证

- **WHEN** 任意节点收到一条成员事实及其签名
- **THEN** 仅凭事实内容与签发者公钥即可验证签名真伪

#### Scenario: 内容寻址幂等

- **WHEN** 同一事实（字节相同）被投递多次
- **THEN** 事实集合不变（同 id 即同内容），无重复条目

#### Scenario: 篡改被隔离

- **WHEN** 一条事实签名验证失败或解码非规范
- **THEN** 该事实进入隔离区（quarantine）并计数告警，不进入事实集合，不影响投影

### Requirement: 邀请令牌（issuer-online 单次兑换）

邀请令牌 SHALL 是自包含的 `dweb1.` 前缀 base64url 字符串，编码 InviteV1：版本、fabric_id、invite_id、签发者 EndpointId、签发者 EndpointAddr（relay URL 与可选直连地址）、过期时间、可选的预期接收者 EndpointId、max_uses=1、签发者签名。兑换 SHALL 在线进行：被邀请者以自己的 EndpointId 密钥对（fabric_id, invite_id, 连接绑定材料）生成拥有权证明（PoP），通过独立兑换通道提交给签发者；签发者验证令牌签名、root 权限仍在、未过期、PoP 正确且 invite_id 未被消费过（持久化 CAS 消费）后，签发 `MemberGrant(subject=被邀请者)` 并回执。令牌被盗用时，攻击者缺少被邀请者私钥即无法完成 PoP；重复兑换因 invite_id 单次消费而失败。

#### Scenario: 邀请与加入

- **WHEN** root 签发 InviteV1 令牌，被邀请者 B 以该令牌执行在线兑换
- **THEN** B 获得 root 签发的 MemberGrant，B 出现在有效成员投影中
- **THEN** 同一 invite_id 的第二次兑换尝试被拒绝

#### Scenario: 过期令牌拒绝兑换

- **WHEN** 令牌过期时间已过
- **THEN** 兑换失败，B 不获得成员身份

#### Scenario: 无 PoP 的窃取者被拒

- **WHEN** 攻击者仅持有令牌但无法对连接绑定材料签名
- **THEN** 兑换失败

### Requirement: Union-merge 收敛

事实集合的合并 SHALL 是按内容寻址 id 的集合并；因 id 即内容哈希，同 id 异容不再出现（哈希碰撞按 quarantine 处理）。合并满足交换律与结合律，任意节点合并任意子集收敛结果一致。事实集合 MUST 原子持久化到数据目录并在启动时重放。

#### Scenario: 双向同步收敛

- **WHEN** 节点 A 与 B 各自持有不相交事实子集并完成一次同步
- **THEN** 双方事实集合均等于两集合的并集

#### Scenario: 重启不丢授权

- **WHEN** 节点进程退出后以同一数据目录重启
- **THEN** 事实集合（含成员授权）与退出前一致

### Requirement: 撤销前向生效（root-only，精确目标）

Revoke SHALL 由 root 签发并精确指向目标 grant id（或 subject 的全部有效 grant）。撤销进入本地投影后，对应成员自投影移除且后续门控收紧；撤销不改写既有事实历史。撤销到达前已建立的连接与会话层处理（断开）之间存在风险窗口，产品语义 MUST 如实呈现该窗口，不承诺即时全局生效。

#### Scenario: 撤销后门控收紧

- **WHEN** root 签发的 Revoke 经同步到达节点 C
- **THEN** C 的有效成员投影不再包含目标成员，C 拒绝与其建立新的受门控会话

### Requirement: 有效成员投影（单根确定性闭包）

系统 SHALL 从 Genesis 出发按确定规则推导有效成员投影：root 恒为成员；MemberGrant 未过期、未被 Revoke 覆盖且签发者为 root 的 subject 是成员。Join 事实仅承载成员自述信息（如显示名），不是准入边。投影为只读派生视图，可从事实集合重建；过期与撤销判定 fail-closed。

#### Scenario: 投影可重建

- **WHEN** 丢弃投影缓存并从事实集合重新推导
- **THEN** 推导结果与丢弃前一致
