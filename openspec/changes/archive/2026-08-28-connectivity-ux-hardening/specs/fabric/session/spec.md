# fabric/session Specification — Delta

## MODIFIED Requirements

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

## ADDED Requirements

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
