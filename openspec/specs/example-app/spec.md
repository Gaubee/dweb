# example-app Specification

## Purpose
定义使用 `@dweb/client-sdk` 的示例应用的可观察行为。它是整套组网能力的端到端验收载体：两个进程在无自建中心服务的前提下完成组网、受控邀请与消息交换。

## Requirements

### Requirement: CLI 命令面

示例应用 SHALL 提供命令：打印本节点 EndpointId、签发邀请、加入（兑换令牌）、列出成员、向成员发送文本消息、进入交互聊天模式。命令输出 MUST 面向人类可读，关键身份信息（EndpointId、邀请令牌）便于复制。

#### Scenario: 查看身份

- **WHEN** 运行身份命令
- **THEN** 输出本节点 EndpointId 与数据目录位置

### Requirement: 双进程端到端组网

在无任何官方公共设施依赖（仅可选自托管 relay/rendezvous）的环境下：进程 A 签发邀请，进程 B 兑换加入，随后双方 SHALL 互发文本消息且各自正确显示对方消息与身份。

#### Scenario: 邀请-加入-聊天

- **WHEN** 进程 A `invite` 产出令牌，进程 B 以该令牌 `join`，双方进入聊天模式互发消息
- **THEN** 双方各自收到对方消息，成员列表包含双方
- **THEN** 全程无中心账号系统参与

#### Scenario: 撤销后拒绝

- **WHEN** A 撤销 B 后，B 尝试向 A 发送消息
- **THEN** 发送失败并提示不再是成员

### Requirement: 可作为开发者的参考样板

示例应用的源码 SHALL 保持最小与线性（不引入与演示无关的框架），使第三方开发者能以它为模板接入自己的应用。

#### Scenario: 从示例出发

- **WHEN** 开发者阅读示例源码并复制其初始化与连接模式
- **THEN** 可以在自己应用中复用同样的 API 调用序列完成组网
