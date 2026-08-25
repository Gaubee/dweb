# fabric/roster

## Purpose

定义"受控邀请他人进入我的网"的核心语义：成员关系以独立签名的不可变事实表达，通过 union-merge 收敛，撤销前向生效。名册是连接门控与授权的唯一依据。

## ADDED Requirements

### Requirement: 签名事实模型

成员关系 SHALL 表示为不可变的签名事实（fact）：包含事实类型（Membership Grant / Member Join / Revocation）、签发者 EndpointId、主体 EndpointId、显示名、事实唯一 id、签发时间与可选过期时间。事实的规范字节序列 SHALL 由签发者 Ed25519 私钥签名；规范序列的构造规则必须确定（同一路径下的实现不引入歧义编码）。

#### Scenario: 事实可独立验证

- **WHEN** 任意节点收到一条成员事实及其签名
- **THEN** 仅凭事实内容与签发者公钥即可验证签名真伪，无需连接签发者

#### Scenario: 非规范编码被拒绝

- **WHEN** 同一事实以不同字段顺序/编码重新提交
- **THEN** 规范序列化结果一致，签名验证结果不因传输编码差异而不同

### Requirement: 邀请令牌签发与兑换

有权成员 SHALL 能签发邀请令牌：自包含的 base64url 字符串，内含 rendezvous 提示（对端连接所需信息）与一条带过期时间的 Membership Grant 事实。被邀请者通过兑换令牌获得成员身份：生成 Member Join 事实并交付给邀请者或任一在线成员。

#### Scenario: 邀请与加入

- **WHEN** 成员 A 调用邀请并获得令牌，被邀请者 B 用该令牌执行加入
- **THEN** B 获得 A 签发的 Grant 事实与自己的 Join 事实，B 出现在有效成员投影中
- **THEN** 该成员关系对网络中其它节点可见（经名册同步）

#### Scenario: 过期令牌拒绝兑换

- **WHEN** 令牌携带的 Grant 过期时间已过
- **THEN** 兑换失败并返回明确错误，B 不获得成员身份

### Requirement: Union-merge 收敛

两个节点的名册合并 SHALL 是事实集合按事实 id 的并集：同 id 事实 MUST 字节一致（不一致时以先到者为准并记录警告，视实现 bug 处理）；合并操作满足交换律与结合律。任何节点在任何时刻合并任意子集，收敛结果一致。

#### Scenario: 双向同步收敛

- **WHEN** 节点 A 与 B 各自持有不相交的事实子集并完成一次同步
- **THEN** 双方名册均等于两集合的并集

#### Scenario: 乱序与重复投递幂等

- **WHEN** 同一事实被投递多次、或事实以任意顺序到达
- **THEN** 名册状态与单次按序投递等价

### Requirement: 撤销前向生效

撤销（Revocation）事实 SHALL 使对应成员身份从有效投影中移除，但不改写也不删除既有事实历史。撤销到达前已建立的本地行为不由名册层追责（会话层负责断开）；撤销一经进入本地投影即对后续门控生效。

#### Scenario: 撤销后门控收紧

- **WHEN** 成员 A 签发针对成员 B 的 Revocation 并经同步到达节点 C
- **THEN** C 的有效成员投影不再包含 B
- **THEN** C 拒绝与 B 建立新的受门控会话

#### Scenario: 过期成员资格自然失效

- **WHEN** 某 Grant 事实的过期时间已过
- **THEN** 有效成员投影不包含该成员，无需显式 Revocation

### Requirement: 有效成员投影

系统 SHALL 从已验证事实集合推导有效成员投影：签发者自身在有效投影内、Grant 未过期、未被 Revocation 覆盖（按主体 + 可选签发者作用域）。投影是只读派生视图，可随时从事实集合重建。

#### Scenario: 投影可重建

- **WHEN** 丢弃投影缓存并从事实集合重新推导
- **THEN** 推导结果与丢弃前一致
