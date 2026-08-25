# fabric/session

## Purpose

定义会话承载：节点间如何建立连接（P2P 直连优先、relay 回退）、连接如何被名册门控、以及不透明二进制 envelope 的双向收发。会话层不解析业务数据。

## ADDED Requirements

### Requirement: 按 EndpointId 建连

节点 SHALL 能仅凭对端 EndpointId 发起连接：优先 QUIC 直连（含 NAT 穿透），无法直连时 SHALL 经配置的 relay 桥接。默认 relay 与自托管 relay 均为可配置项；两者对上层 API 行为一致。

#### Scenario: 直连成功

- **WHEN** 两节点在同一局域网且 UDP 可达，A 按 EndpointId 连接 B
- **THEN** 连接建立，上层可立即收发消息，无需手工提供地址

#### Scenario: relay 回退

- **WHEN** 两节点间 UDP 直连不可达，且配置了可用 relay
- **THEN** 连接经 relay 桥接建立，消息收发行为与直连一致
- **THEN** API 层可观测到当前路径类型（direct / relay）

### Requirement: 连接门控

节点 MUST 仅与本地有效成员投影中的 EndpointId 建立/接受受门控会话。唯一例外是邀请兑换通道：非成员被允许发起一次性连接用于兑换邀请令牌，兑换完成后该例外连接即告结束，后续会话按普通门控规则处理。

#### Scenario: 非成员连接被拒

- **WHEN** 未知 EndpointId 的节点尝试与成员节点建立会话
- **THEN** 连接被拒绝，不进入消息收发阶段

#### Scenario: 撤销后既有连接断开

- **WHEN** Revocation 事实进入本地投影且被撤销者存在既有会话
- **THEN** 该会话被主动断开，后续重连被门控拒绝

### Requirement: 名册随连接同步

两个成员节点完成受门控连接后，双方 SHALL 交换名册事实（v0.1 允许全量交换），并按 union-merge 收敛。同步在连接建立后自动进行，无需上层显式调用。

#### Scenario: 连接即同步

- **WHEN** A 与 B 建立连接，B 持有 A 未见过的事实
- **THEN** 连接稳定后 A 的名册包含这些事实，双方发出名册更新通知

### Requirement: 不透明 envelope 收发

成员间 SHALL 能交换任意字节 envelope：发送方提交字节序列，接收方以回调/事件获得发送者 EndpointId 与字节内容。会话层 MUST NOT 解析、修改或依赖 envelope 内容；单连接内消息保序。

#### Scenario: 双向消息

- **WHEN** A 向在线成员 B 发送一段字节，随后 B 向 A 回发一段字节
- **THEN** 双方各自收到对方发来的原始字节，内容与发送时完全一致

#### Scenario: 对端离线时发送

- **WHEN** A 向不在线的成员发送消息
- **THEN** v0.1 明确返回"对端不可达"错误，不做存储转发（不伪装成已送达）

### Requirement: 连接生命周期可观测

上层 SHALL 能观测成员的上线/下线事件，以及自身启动/停止的完成信号。

#### Scenario: 对端断开可观测

- **WHEN** 成员 B 的进程退出
- **THEN** A 在有限时间内收到 B 的下线事件
