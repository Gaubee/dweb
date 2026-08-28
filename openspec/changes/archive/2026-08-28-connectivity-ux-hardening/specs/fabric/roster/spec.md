# fabric/roster Specification — Delta

## MODIFIED Requirements

### Requirement: 邀请令牌（issuer-online 单次兑换）

邀请令牌 SHALL 是自包含的 `dweb1.` 前缀 base64url 字符串，编码 InviteV1：版本、fabric_id、invite_id、签发者 EndpointId、签发者 EndpointAddr（relay URL 与可选直连地址）、过期时间、可选的预期接收者 EndpointId、max_uses=1、签发者签名。兑换 SHALL 在线进行：被邀请者以自己的 EndpointId 密钥对（fabric_id, invite_id, 连接绑定材料）生成拥有权证明（PoP），通过独立兑换通道提交给签发者；签发者验证令牌签名、root 权限仍在、未过期、PoP 正确且 invite_id 未被消费过（持久化 CAS 消费）后，签发 `MemberGrant(subject=被邀请者)` 并回执。令牌被盗用时，攻击者缺少被邀请者私钥即无法完成 PoP；重复兑换因 invite_id 单次消费而失败。

**签发安全门**：当解析出的 relay URL 为空且显式直连地址列表（`advertise_addrs` 配置字段）为空时，签发操作 MUST 拒绝并返回专用错误 `InviteWithoutRelay`（含原因与配置指引），不得产出已知不可达的令牌。安全门只信显式配置来源：`advertise_addrs` MUST 在构造期校验（每项非空且可解析为 ip:port/[ipv6]:port、**拒绝通配地址**（0.0.0.0、:: unspecified）与**端口 0**（必须具体可拨；loopback 允许但文档注明仅同机可达）、重复项去重保序，非法项以 `[bad-advertise-addr]` 前缀报错），签发路径 MUST NOT 混入运行时探测地址（direct_addr_hints）。显式 `allow_relayless` 逃生阀 MUST 可绕过该门，供确有直连可达配置的调用方使用。

#### Scenario: 邀请与加入

- **WHEN** root 签发 InviteV1 令牌，被邀请者 B 以该令牌执行在线兑换
- **THEN** B 加入 fabric 并获得完整名册

#### Scenario: 单次兑换

- **WHEN** 同一令牌被第二次尝试兑换
- **THEN** 同一 invite_id 的第二次兑换尝试被拒绝

#### Scenario: 无 relay 且无持久直连地址时拒签

- **WHEN** relay 配置为空（disabled 或空列表）且 advertise_addrs 为空，调用 `invite`
- **THEN** 返回 InviteWithoutRelay 错误，不产出令牌

#### Scenario: 显式直连地址放行

- **WHEN** relay 为空但 advertise_addrs 配置了持久地址，调用 `invite`
- **THEN** 令牌正常签发，其中 relay 字段为空、直连地址为配置值

#### Scenario: 逃生阀放行

- **WHEN** relay 与 advertise_addrs 均为空，但调用方显式设置 allow_relayless
- **THEN** 令牌照常签发（可达性责任归调用方）

#### Scenario: 非法 advertise_addrs 构造报错

- **WHEN** 构造 Fabric 配置时 advertise_addrs 含空字符串、不可解析项、通配地址（0.0.0.0 / ::）或端口 0
- **THEN** 构造期以 `[bad-advertise-addr]` 前缀报错，不进入运行；loopback 与重复项（去重）被接受

#### Scenario: 过期令牌拒绝兑换

- **WHEN** 令牌过期时间已过
- **THEN** 兑换失败，B 不获得成员身份

#### Scenario: 无 PoP 的窃取者被拒

- **WHEN** 攻击者仅持有令牌但无法对连接绑定材料签名
- **THEN** 兑换失败

## ADDED Requirements

### Requirement: 目录 fabric 归属不匹配的独立错误

数据目录中持久化名册的 fabric_id 与当前操作目标 fabric_id 不一致时，MUST 返回专用错误 `DirFabricMismatch`（携带目录路径、存储 fabric 与目标 fabric 的短标识——各为 16 个 hex 字符），不得归入文件损坏（Corrupted）类错误，也不得复用既有 `WrongFabric`（令牌/事实跨 fabric 校验）变体；错误信息 SHALL 给出可操作指引（更换数据目录）。文件真正损坏（magic/校验和/事实流解析失败）仍 SHALL 返回 Corrupted。

#### Scenario: join 目录归属不匹配

- **WHEN** 目录内名册属于 fabric A（预先 init 产生），以 fabric B 的令牌执行 join
- **THEN** 返回 DirFabricMismatch 错误，信息含两个 fabric 的 16 hex 短标识与目录路径

#### Scenario: 真损坏仍报 Corrupted

- **WHEN** 名册文件字节被篡改导致 BLAKE3 校验失败
- **THEN** 返回 Corrupted 错误，而非 DirFabricMismatch
