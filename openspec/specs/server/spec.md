# server Specification

## Purpose
定义自托管服务端（一个二进制 + 一个 Docker 镜像）的行为契约：iroh relay 桥接与 rendezvous 登记/解析。开发者部署它即可为自己的组网提供回退与寻址基础设施，不依赖任何官方公共节点。

## Requirements

### Requirement: relay 桥接

服务端 SHALL 运行 iroh relay（`iroh-relay` crate 的 server feature）：接受客户端的 relay 协议连接，端口拓扑 MUST 明确可配置——HTTP(S) 端口（relay 控制与 WebSocket 桥接）与 QUIC/UDP 端口（数据面）分开配置。无 TLS 的本地/内网部署 SHALL 可用（明文 HTTP relay），生产部署的 TLS 终结职责 MUST 在文档中写明（反代终结 TCP/WS；QUIC 数据面需要原生证书或明确降级说明）。relay MUST NOT 能解密端到端会话内容；relay 不是成员授权点，其访问控制（若启用）仅限制 relay 使用。客户端 SHALL 能通过配置将本服务端指定为自定义 relay 并完成经 relay 的组网。

#### Scenario: 硬 NAT 双方经自托管 relay 组网

- **WHEN** 两节点直连不可达，均配置本服务端为 relay
- **THEN** 两节点完成连接并交换消息，路径类型为 relay

### Requirement: rendezvous 登记/解析（可选，不可信发现辅助）

服务端 SHALL 提供 HTTP API：节点可登记自己的 EndpointId 与可达地址（含 TTL），其它节点可按 EndpointId 查询仍在 TTL 内的登记项。登记请求 MUST 携带 EndpointId 对应私钥的签名（含时间戳与随机数防重放），服务端 MUST 验证签名后受理；过期的登记项 MUST NOT 出现在查询结果中。本 API 是发现辅助而非信任边界：客户端 MUST 把查询结果视为不可信输入，最终以 EndpointId 的 TLS 认证为准；常规会话与兑换的正确性 MUST NOT 依赖本 API。

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

服务端 SHALL 提供 `GET /healthz` 返回存活状态，供容器编排与监控使用。HTTP 服务 SHALL 称为 **gateway**（默认 8787 端口），除健康检查外还承载 rendezvous 与服务清单。gateway 的监听地址 MUST 可通过 `--gateway`（CLI）与 `DWEB_GATEWAY_BIND`（环境变量）配置；旧名 `--http` 与 `DWEB_HTTP_BIND` MUST 作为兼容别名继续生效。

#### Scenario: 健康检查

- **WHEN** 服务端运行中收到 `GET /healthz`
- **THEN** 返回成功状态码

#### Scenario: 旧环境变量兼容

- **WHEN** 仅设置 `DWEB_HTTP_BIND` 启动服务端
- **THEN** gateway 监听该地址，行为与 `DWEB_GATEWAY_BIND` 一致

#### Scenario: 默认端口与显式配置等价

- **WHEN** 无任何配置启动，或以 `--gateway 0.0.0.0:9999` 启动
- **THEN** 分别监听 8787 与 9999，`/healthz` 与 `/services.json` 均按实际端口响应

### Requirement: Docker 交付

项目 SHALL 提供 Docker 镜像并以 `ghcr.io/gaubee/dweb` 命名发布。镜像 SHALL 通过环境变量完成全部配置（端口、relay 开关等），无配置时使用合理默认值启动。

#### Scenario: 默认配置启动

- **WHEN** 以无环境变量方式运行镜像
- **THEN** 服务端以默认端口启动并响应健康检查

### Requirement: 服务清单（services.json）

gateway SHALL 提供 `GET /services.json`（`Content-Type: application/json`、`Cache-Control: no-store`）返回机器可读的服务清单：服务端标识与版本、gateway URL、各服务条目（rendezvous、relay）的启用状态与 URL。URL 派生规则：

- scheme 跟随请求 scheme；`X-Forwarded-Proto` 仅在 `DWEB_TRUST_PROXY=1` 时采信，否则一律 `http`；
- host 取 `Host` 头主机部分，拒绝集合冻结为：unspecified 地址（`0.0.0.0`、`::`、空 host）、含 userinfo 的形态（`user:pass@host`）、host:port 解析失败、端口 0 或大于 65535；其余一律放行（含 loopback）；校验失败或无 Host 头时 MUST 回退为本机首个非 loopback IPv4；
- 每个服务条目 MUST 使用该服务实际监听的端口。

relay 禁用时其条目 MUST 为 `enabled: false` 且 `url: null`。清单字段只增不删不改语义。gateway SHALL 另在 `GET /` 提供同信息的人类可读纯文本摘要（全 ASCII）。

#### Scenario: gateway URL 解析 relay 地址

- **WHEN** 客户端以 LAN IP 访问 `http://192.168.2.13:8787/services.json`
- **THEN** 响应中 relay 条目的 URL 以 `192.168.2.13` 为主机、以实际 relay 端口为端口

#### Scenario: 无 Host 头回退网卡地址

- **WHEN** 请求缺失 Host 头且绑定地址为 `0.0.0.0`
- **THEN** 清单 URL 使用本机首个非 loopback IPv4，而非 `0.0.0.0`

#### Scenario: 无可用回退地址

- **WHEN** Host 头无效回退时本机不存在任何非 loopback IPv4
- **THEN** gateway 与各服务条目的 `url` 为 `null`（`enabled` 照实），服务端日志 WARNING，绝不产出 `0.0.0.0` 形态 URL

#### Scenario: IPv6 Host 头

- **WHEN** 请求 Host 头为 `[fd00::1]:8787` 形态
- **THEN** 清单 URL 主机部分正确剥离括号为 `fd00::1`，URL 使用括号 IPv6 形态

#### Scenario: 反代 scheme 信任边界

- **WHEN** 请求带 `X-Forwarded-Proto: https` 且未设置 `DWEB_TRUST_PROXY=1`
- **THEN** 清单 URL scheme 仍为 `http`

#### Scenario: relay 禁用的清单条目

- **WHEN** 服务端以 `--no-relay` 启动
- **THEN** `services.json` 中 relay 条目为 `enabled: false`、`url: null`

#### Scenario: 字段稳定性

- **WHEN** 对比本 change 冻结的 fixture 组（contracts/services.fixtures.json 的 canonical 案例字段集）与本实现输出
- **THEN** 字段名与结构完全一致（仅 host/port/version 值不同）

#### Scenario: 未知与重复服务名

- **WHEN** 清单构造时包含未知服务名条目或同名重复条目
- **THEN** 未知条目被静默忽略（前向兼容，无告警），重复条目以首个为准并在服务端日志输出一条 WARNING

#### Scenario: relay URL scheme 校验

- **WHEN** relay 条目构造时 URL scheme 非 http(s)
- **THEN** 该条目按禁用处理并在日志 WARNING，不产出非 http(s) URL

#### Scenario: 人类可读摘要

- **WHEN** 访问 `GET /`
- **THEN** 返回纯文本摘要，内容与清单一致且全部字符码位 < 128

### Requirement: 启动横幅（单一配置入口呈现）

CLI 启动横幅 SHALL 为纯英文且全部字符码位 < 128，vite 风格枚举本机全部非 loopback IPv4 的 gateway URL（Local + Network；无可枚举地址时 SHALL 打印占位说明行而非省略该节），并以 `NAME | PORT` 表格列出各服务及状态，向用户传达"任一 Network 地址即客户端唯一配置入口"。

#### Scenario: 多网卡地址枚举

- **WHEN** 服务器具有多个非 loopback IPv4 地址并启动
- **THEN** 横幅逐一列出各地址的 gateway URL，无遗漏、无重复

#### Scenario: 横幅 ASCII 纪律

- **WHEN** 任意配置下启动并捕获 stdout
- **THEN** 横幅全部字符码位 < 128
