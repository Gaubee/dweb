# server

## Purpose

定义自托管服务端（一个二进制 + 一个 Docker 镜像）的行为契约：iroh relay 桥接与 rendezvous 登记/解析。开发者部署它即可为自己的组网提供回退与寻址基础设施，不依赖任何官方公共节点。

## ADDED Requirements

### Requirement: relay 桥接

服务端 SHALL 运行 iroh relay：接受客户端的 relay 协议连接（QUIC/UDP 与 HTTPS 端口可配置），为无法直连的节点对桥接流量。relay MUST NOT 能解密端到端会话内容。客户端 SHALL 能通过配置将本服务端指定为自定义 relay 并完成经 relay 的组网。

#### Scenario: 硬 NAT 双方经自托管 relay 组网

- **WHEN** 两节点直连不可达，均配置本服务端为 relay
- **THEN** 两节点完成连接并交换消息，路径类型为 relay

### Requirement: rendezvous 登记/解析

服务端 SHALL 提供 HTTP API：节点可登记自己的 EndpointId 与可达地址（含 TTL），其它节点可按 EndpointId 查询仍在 TTL 内的登记项。登记请求 MUST 携带 EndpointId 对应私钥的签名，服务端 MUST 验证签名后受理；过期的登记项 MUST NOT 出现在查询结果中。

#### Scenario: 登记后可解析

- **WHEN** 节点 A 以签名请求登记，随后任意节点查询 A 的 EndpointId
- **THEN** 查询返回 A 登记的地址信息

#### Scenario: 签名无效的登记被拒

- **WHEN** 登记请求签名验证失败
- **THEN** 返回认证错误，不产生登记项

#### Scenario: TTL 过期

- **WHEN** 登记项 TTL 已过且未续期
- **THEN** 查询不再返回该登记项

### Requirement: 健康检查

服务端 SHALL 提供 `GET /healthz` 返回存活状态，供容器编排与监控使用。

#### Scenario: 健康检查

- **WHEN** 服务端运行中收到 `GET /healthz`
- **THEN** 返回成功状态码

### Requirement: Docker 交付

项目 SHALL 提供 Docker 镜像并以 `ghcr.io/gaubee/dweb` 命名发布。镜像 SHALL 通过环境变量完成全部配置（端口、relay 开关等），无配置时使用合理默认值启动。

#### Scenario: 默认配置启动

- **WHEN** 以无环境变量方式运行镜像
- **THEN** 服务端以默认端口启动并响应健康检查
