# fabric/session

## Purpose

定义会话承载：节点间如何建立连接（EndpointAddr 显式寻址、P2P 直连优先、relay 回退）、常规会话如何被名册门控、兑换通道如何工作、以及不透明二进制 envelope 的双向收发与资源边界。会话层不解析业务数据。

## ADDED Requirements

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

邀请兑换 SHALL 使用独立于常规会话的 ALPN。兑换连接 MUST 限制为单条双向流、首帧必须是兑换请求（令牌 + PoP）、总字节数不超过上限（32 KiB）、自连接建立起不超过时限（5s）；超限或超时即断开。签发者侧对 invite_id 的消费 MUST 持久化且原子（单次成功）。兑换完成后连接即关闭，兑换通道 MUST NOT 承载 HELLO、名册同步或业务消息。

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

上层 SHALL 能观测成员的上线/下线事件与自身启动/停止的完成信号。下线判定为本地推断（连接关闭/心跳超时），不承诺绝对时限；关闭遵循 iroh 语义（显式 close，进程退出不遗留错误状态）。

#### Scenario: 对端断开可观测

- **WHEN** 成员 B 的进程正常退出并关闭连接
- **THEN** A 收到 B 的下线事件
