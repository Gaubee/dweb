# fabric/session Specification

## Purpose
定义会话承载：节点间如何建立连接（EndpointAddr 显式寻址、P2P 直连优先、relay 回退）、常规会话如何被名册门控、兑换通道如何工作、以及不透明二进制 envelope 的双向收发与资源边界。会话层不解析业务数据。

## Requirements

### Requirement: 显式寻址建连

EndpointId 是身份不是地址。节点发起连接 SHALL 提供对端的可达信息：relay URL 与/或直连地址（EndpointAddr），来源为邀请令牌、同步的地址记录或显式配置。仅凭 EndpointId 且无任何地址线索时，连接 SHALL 快速失败并给出可诊断错误。直连优先（QUIC + NAT 穿透），不可达时经配置的 relay 桥接；默认 relay 与自托管 relay 均为可配置项，两者对上层 API 行为一致。

#### Scenario: 直连成功

- **WHEN** 两节点在同一局域网且 UDP 可达，A 以对端 EndpointAddr 连接 B
- **THEN** 连接建立，上层可立即收发消息

#### Scenario: relay 回退

- **WHEN** 两节点间 UDP 直连不可达，且配置了可用 relay
- **THEN** 连接经 relay 桥接建立，API 层可观测到当前路径类型（direct / relay）

#### Scenario: 无地址线索快速失败

- **WHEN** 仅以 EndpointId 发起连接且无 relay/直连地址
- **THEN** 快速失败，错误信息说明缺少可达地址

### Requirement: 常规会话门控（先门控后数据）

常规 ALPN 的接受侧 MUST 在完成任何应用数据交换前校验对端 EndpointId 属于本地有效成员投影；非成员连接在 TLS 握手后即被关闭，不进入消息收发阶段。发起侧同样 MUST 先做本地门控再拨号。成员撤销进入本地投影后，既有会话被主动断开。

#### Scenario: 非成员连接被拒

- **WHEN** 未知 EndpointId 的节点尝试与成员节点建立常规会话
- **THEN** 连接在应用数据交换前被关闭

#### Scenario: 撤销后既有连接断开

- **WHEN** Revoke 事实进入本地投影且被撤销者存在既有会话
- **THEN** 该会话被主动断开，后续重连被门控拒绝

### Requirement: 兑换通道（独立 ALPN）

邀请兑换 SHALL 使用独立于常规会话的 ALPN。兑换连接 MUST 限制为单条双向流、按三段式交换（REDEEM_INTENT（令牌）→ CHALLENGE（32B 质询）→ PROOF（PoP 签名））、总字节数不超过上限（32 KiB）、自连接建立起不超过时限（5s）；超限或超时即断开。签发者侧对 invite_id 的消费 MUST 持久化且原子（单次成功）。兑换完成后连接即关闭，兑换通道 MUST NOT 承载 HELLO、名册同步或业务消息。

#### Scenario: 兑换后通道关闭

- **WHEN** 被邀请者完成一次成功兑换
- **THEN** 连接被关闭，后续通信走常规 ALPN（届时已是成员）

#### Scenario: 兑换超时断开

- **WHEN** 连接建立后 5s 内未收到合法首帧
- **THEN** 连接被服务侧断开

### Requirement: 名册随连接同步

两个成员节点完成受门控连接后，双方 SHALL 经控制流交换名册事实（v0.1 允许全量交换）并按 union-merge 收敛。控制流归属明确：由发起方开启单条控制双向流，接受方仅在该流上回应；同步在门控通过后自动进行。

#### Scenario: 连接即同步

- **WHEN** A 与 B 建立连接，B 持有 A 未见过的事实
- **THEN** 连接稳定后 A 的事实集合包含这些事实，双方发出名册更新通知

### Requirement: 不透明 envelope 收发与资源边界

成员间 SHALL 能经控制流之外的消息流交换任意字节 envelope：发送方提交字节序列，接收方以回调/事件获得发送者 EndpointId 与字节内容。会话层 MUST NOT 解析、修改或依赖 envelope 内容；单连接内消息保序。帧协议 MUST 施加资源上限：单帧长度上限（默认 1 MiB）、单次同步的事实数与总字节数上限、读取超时；对端声明的长度超限时拒绝该帧而不是预分配内存。

#### Scenario: 双向消息

- **WHEN** A 向在线成员 B 发送一段字节，随后 B 向 A 回发一段字节
- **THEN** 双方各自收到对方发来的原始字节，内容与发送时完全一致

#### Scenario: 对端离线时发送

- **WHEN** A 向不在线的成员发送消息
- **THEN** v0.1 明确返回"对端不可达"错误，不做存储转发

#### Scenario: 超长帧被拒

- **WHEN** 对端声明超过单帧上限的长度
- **THEN** 该帧被拒绝且连接按协议错误处理，不发生大额内存分配

### Requirement: 连接生命周期可观测

连接建立、断开与中继可达性 SHALL 以事件对外暴露。中继观测 SHALL 直接消费 endpoint 的 home relay 连接状态流（不自造轮询）：聚合语义为 relay 列表中任一连接即视为在线；聚合态跳变时广播 RelayOnline/RelayOffline 事件（同一态内的 relay 间切换与错误信息变化不触发事件，但反映在状态快照中）。快照中的 lastError SHALL 取候选列表中首个未连接且带错误的 relay 之错误（配置序，确定性）。当前状态 SHALL 经快照查询获取（快照值先于事件可用，消费方以快照为初始事实、事件仅承载后续跳变；事件 SHALL 携带快照同构 payload）。relay 配置为禁用时 SHALL 不进行监测、不产生中继事件。

**生命周期**：home relay 状态流不随 `Endpoint::close()` 结束（仅最后一个 Endpoint clone 释放时断开），因此 Fabric 关闭流程 MUST 显式终止 watcher 任务并确认退出后才释放 endpoint；关闭后 MUST 无任务残留、无后续事件。

#### Scenario: relay 首次可达

- **WHEN** 节点以自托管 relay 启动且 relay 可达
- **THEN** 快照查询报告在线；**不产生初始事件**（watcher 首值只入快照）；此后的 offline->online 跳变才产生 RelayOnline 事件

#### Scenario: relay 全程禁用

- **WHEN** 节点以 relay 禁用模式运行
- **THEN** 不产生任何中继事件，relay 状态查询返回"不可用"（null）而非 false

#### Scenario: 多 relay 同时上线的事件 URL

- **WHEN** 多个 relay 在同一探测周期内同时连上（聚合态 offline->online 跳变）
- **THEN** RelayOnline 事件携带的 URL 取配置序最小的 relay，不依赖 watcher 到达顺序

#### Scenario: relay 掉线与恢复

- **WHEN** 可达的 relay 服务停止后再恢复
- **THEN** 依次观察到 RelayOffline 与 RelayOnline 事件

#### Scenario: 对端断开可观测

- **WHEN** 成员 B 的进程正常退出并关闭连接
- **THEN** A 收到 B 的下线事件

### Requirement: join 可诊断失败

`join` SHALL 受单一总时限约束（默认 30 秒，可配 `join_timeout_ms`，值域 1 秒至 10 分钟），时限 MUST 包住 connect 与 redeem 兑换的完整工作流，到期 MUST 取消等待并关闭已建立连接。8 码 SHALL 只覆盖 join 的网络工作流；本地数据面错误（缺身份、名册真损坏、名册读写 IO）SHALL 在目录加载步骤豁免并按原生错误变体透出（位于令牌自身错误之后、目录归属检查之前），不冒充网络错误码。join 网络失败 SHALL 归类为互斥穷尽的稳定错误码集合之一（按序判定：令牌自身错误 -> 本地数据面豁免 -> 目录归属 -> 空路径 -> 网络工作流；坏令牌加错目录唯一归类为 TOKEN_INVALID 家族，空路径令牌加损坏名册唯一归类为 corrupted 豁免）：`TOKEN_INVALID`（解码失败，或令牌 relay/直连地址非空但格式非法）、`TOKEN_EXPIRED`、`WRONG_FABRIC`（目录归属不匹配）、`NO_REACHABLE_PATH`（令牌既无 relay 也无直连地址——拨号前立即失败，零等待）、`RELAY_OFFLINE`（connect 立即错误、令牌无直连地址、生效代理策略为 none、且对令牌 relay URL 的有界 2s TCP 探针失败——transport-only 语义，DNS 计入预算，不解析 iroh 错误内部、不依据加入方 home relay 状态；探针为诊断性追加，join 总耗时最多超出时限 2 秒）、`DIAL_FAILED`（其余立即拨号错误，及 redeem 阶段非结构化失败——连接中断/IO/坏帧/事实解码/错误帧本身非法）、`DIAL_TIMEOUT`（时限到期；附注按探针结果：探针成功则 issuer 可能离线）、`TOKEN_CONSUMED`（兑换结构化拒绝 Consumed）。兑换拒绝 SHALL 使用结构化 wire discriminant `RedeemErrorKind`，其记录作为既有 `REDEEM_ERR`（0x14）外层帧的 payload（外层帧 = `u32_be(1+payload_len) + type(1B) + payload`，与既有 write_frame/read_frame 逐字节一致、公共读写器零改动；32KiB/5s 上限不变，`REDEEM_OK` 沿用既有格式），每条记录为 `kind(1B) + len(1B) + payload(len ≤ 255)`（单条最大 257 字节，v1 单条）：0x00 Consumed、0x01 NotRoot、0x02 BadPoP、0x03 Other；Other 允许零长度载荷；记录段短读（kind/len/payload 任一段不足，含外层 payload 末尾的不完整记录）为协议违规——关闭整个兑换连接并归 DIAL_FAILED；外层 payload 边界内的额外完整字节一律按下一记录解析；未知 kind 按记录长度原样消费载荷并映射 Other("unknown-kind")；payload 呈现层仅保留可打印 ASCII。多记录 reduction SHALL 为 fail-closed：恰一条 Consumed -> TOKEN_CONSUMED，恰一条其它已知 kind -> TOKEN_INVALID，多条记录 -> TOKEN_INVALID（完整消费不位移），未知 kind 按 Other("unknown-kind") 参与判定；NotRoot/BadPoP/Other SHALL 映射为 TOKEN_INVALID；既有 issuer 侧 `WrongFabric`（令牌/名册不符）经 Other 透出为 TOKEN_INVALID，`WRONG_FABRIC` 码专属于目录归属不匹配。

#### Scenario: 空路径令牌秒败

- **WHEN** join 输入的令牌不含 relay URL 且不含直连地址
- **THEN** 不发起拨号、不消耗时限，立即以 NO_REACHABLE_PATH 失败

#### Scenario: 时限到期归类

- **WHEN** join 在时限内未完成且 relay 在线
- **THEN** 以 DIAL_TIMEOUT 失败，错误信息含 issuer 可能离线的附注

#### Scenario: relay 不可达归类

- **WHEN** 令牌含 relay URL 且 connect 立即失败，同时对该 relay URL 的 TCP 探针（测试注入关闭端口）失败
- **THEN** 以 RELAY_OFFLINE 失败

#### Scenario: 立即拨号错误归类

- **WHEN** connect 立即失败但对令牌 relay 的 TCP 探针成功，或 redeem 阶段发生连接中断/坏帧等非结构化失败
- **THEN** 以 DIAL_FAILED 失败，错误信息含原因

#### Scenario: 地址非法归入令牌无效

- **WHEN** 令牌的 relay URL 非空但不可解析为 URL
- **THEN** 以 TOKEN_INVALID 失败（附原因），不进入拨号

#### Scenario: 本地数据面错误豁免

- **WHEN** join 过程中名册文件校验失败（真损坏）、目录缺身份或名册读写 IO 失败
- **THEN** 分别以 `[corrupted]` / `[missing-identity]` / `[roster-io]` 前缀错误透出，不归类为 8 码；令牌自身错误优先于目录检查判定

#### Scenario: 探针不适用时的归类

- **WHEN** 令牌含 relay URL 但也含直连地址，或生效代理策略非 none，connect 立即失败
- **THEN** 归类为 DIAL_FAILED（附原始原因），不判 RELAY_OFFLINE

#### Scenario: 空路径令牌与损坏名册冲突

- **WHEN** 令牌合法但无 relay 与直连地址，且数据目录名册文件真损坏
- **THEN** 以 `[corrupted]` 豁免错误失败（本地数据面检查先于空路径判定），不返回 NO_REACHABLE_PATH

#### Scenario: 兑换通道内层超时归类（joinTimeoutMs > 5s）

- **WHEN** 连接已建立但 issuer 在兑换通道 5 秒时限内未完成应答，且 join 总时限大于 5 秒
- **THEN** 以 DIAL_TIMEOUT 失败并附注 redeem timeout，不落入非结构化失败分支

#### Scenario: join 时限不大于内层时限的等值边界

- **WHEN** joinTimeoutMs <= 5 秒且 issuer 无应答
- **THEN** 外层 join deadline 拥有唯一结果：以 DIAL_TIMEOUT 失败、附注 join timeout（不追加 redeem 附注）；连接被关闭

#### Scenario: 坏令牌与错目录冲突

- **WHEN** 令牌解码/签名失败，且数据目录属于另一个 fabric
- **THEN** 以 `[token-invalid]` 失败（令牌自身错误优先于目录检查），不返回 WRONG_FABRIC

#### Scenario: 多记录兑换拒绝

- **WHEN** REDEEM_ERR payload 含 Consumed 与 Other 两条记录
- **THEN** 完整消费不位移，最终归类 TOKEN_INVALID（多记录 fail-closed）

#### Scenario: 兑换结构化拒绝

- **WHEN** issuer 以 RedeemErrorKind::Consumed 拒绝兑换
- **THEN** join 以 TOKEN_CONSUMED 失败；其余 RedeemErrorKind 以 TOKEN_INVALID 失败；未知编码值按 Other 降级不断连

#### Scenario: watcher 随关闭终止

- **WHEN** Fabric shutdown 完成
- **THEN** watcher 任务已退出，不再产生中继事件
