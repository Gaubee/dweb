# server

## ADDED Requirements

### Requirement: 公网 URL 覆盖（反代/隧道部署）

服务端 SHALL 支持为 gateway 与 relay 分别声明公网 URL：`--public-gateway` /
`--public-relay`（CLI）与 `DWEB_PUBLIC_GATEWAY_URL` / `DWEB_PUBLIC_RELAY_URL`
（环境变量），优先级 flag > env > 未设置。覆盖值 MUST 在启动期通过 fail-fast
校验（非法值以退出码 2 终止）：`http(s)://host[:port]` 形态，拒绝 path（空或
`/` 之外）、query、fragment 与 userinfo。按条目独立生效：已覆盖条目 MUST
完全跳过 Host 头/scheme/回退地址派生（且不受 `DWEB_TRUST_PROXY` 影响），
未覆盖条目行为 MUST 与无覆盖时逐字节一致。relay 禁用时 relay 条目维持
`enabled:false, url:null`，覆盖值被忽略且无告警。本机制为厂商中立的反代
适配层：任何终结 TLS 并回源 HTTP/WS 的 front-end（反向代理、隧道）均适用。

#### Scenario: 双覆盖全量生效

- **WHEN** 服务端以 `--public-gateway https://gw.example.com --public-relay https://relay.example.com` 启动，任意 Host 头请求 `/services.json`
- **THEN** gateway 与 rendezvous URL 为 `https://gw.example.com[...]`，relay URL 为 `https://relay.example.com`

#### Scenario: 部分覆盖

- **WHEN** 仅设置 `DWEB_PUBLIC_RELAY_URL=https://relay.dweb.example.com`
- **THEN** gateway/rendezvous 条目维持 Host 派生，relay 条目为覆盖值

#### Scenario: 覆盖独立于回退探测

- **WHEN** 双覆盖已设置，且请求 Host 头属拒绝集合、本机无任何非 loopback IPv4
- **THEN** 全部 URL 来自覆盖值，不产生 `no non-loopback IPv4 available` WARNING

#### Scenario: 非法覆盖值启动失败

- **WHEN** 覆盖值含 path 前缀（如 `https://ex.com/dweb`）或非 http(s) scheme
- **THEN** 启动以退出码 2 失败并输出 `error: invalid public ... url: <value>` 类错误

#### Scenario: relay 禁用时覆盖被忽略

- **WHEN** `--no-relay` 与 `--public-relay` 同时给出
- **THEN** relay 条目为 `enabled:false, url:null`，无告警

## MODIFIED Requirements

### Requirement: 服务清单（services.json）

gateway SHALL 提供 `GET /services.json`（`Content-Type: application/json`、`Cache-Control: no-store`）返回机器可读的服务清单：服务端标识与版本、gateway URL、各服务条目（rendezvous、relay）的启用状态与 URL。URL 派生规则（按条目独立）：

- 若该条目已设置公网覆盖（`DWEB_PUBLIC_GATEWAY_URL` / `DWEB_PUBLIC_RELAY_URL`，见"公网 URL 覆盖"要求），条目 URL MUST 为覆盖值（rendezvous 为 gateway 覆盖值 + `/rendezvous`），跳过以下派生规则；
- 否则 scheme 跟随请求 scheme；`X-Forwarded-Proto` 仅在 `DWEB_TRUST_PROXY=1` 时采信，否则一律 `http`；
- host 取 `Host` 头主机部分，拒绝集合冻结为：unspecified 地址（`0.0.0.0`、`::`、空 host）、含 userinfo 的形态（`user:pass@host`）、host:port 解析失败、端口 0 或大于 65535；其余一律放行（含 loopback）；校验失败或无 Host 头时 MUST 回退为本机首个非 loopback IPv4；
- 每个派生条目 MUST 使用该服务实际监听的端口。

relay 禁用时其条目 MUST 为 `enabled: false` 且 `url: null`。清单字段只增不删不改语义。gateway SHALL 另在 `GET /` 提供同信息的人类可读纯文本摘要（全 ASCII）。

#### Scenario: gateway URL 解析 relay 地址

- **WHEN** 客户端以 LAN IP 访问 `http://192.168.2.13:8787/services.json`
- **THEN** 响应中 relay 条目的 URL 以 `192.168.2.13` 为主机、以实际 relay 端口为端口

#### Scenario: 无 Host 头回退网卡地址

- **WHEN** 请求缺失 Host 头且绑定地址为 `0.0.0.0`
- **THEN** 清单 URL 使用本机首个非 loopback IPv4，而非 `0.0.0.0`

#### Scenario: 无可用回退地址

- **WHEN** Host 头无效回退时本机不存在任何非 loopback IPv4
- **THEN** 未覆盖的 gateway 与各服务条目的 `url` 为 `null`（`enabled` 照实），服务端日志 WARNING，绝不产出 `0.0.0.0` 形态 URL

#### Scenario: IPv6 Host 头

- **WHEN** 请求 Host 头为 `[fd00::1]:8787` 形态
- **THEN** 清单 URL 主机部分正确剥离括号为 `fd00::1`，URL 使用括号 IPv6 形态

#### Scenario: 反代 scheme 信任边界

- **WHEN** 请求带 `X-Forwarded-Proto: https` 且未设置 `DWEB_TRUST_PROXY=1`
- **THEN** 派生条目 URL scheme 仍为 `http`（覆盖条目不受影响）

#### Scenario: relay 禁用的清单条目

- **WHEN** 服务端以 `--no-relay` 启动
- **THEN** `services.json` 中 relay 条目为 `enabled: false`、`url: null`

#### Scenario: 字段稳定性

- **WHEN** 对比本 change 冻结的 fixture 组（contracts/services.fixtures.json 的 canonical 案例字段集）与本实现输出
- **THEN** 字段名与结构完全一致（仅 host/port/version 值不同）

#### Scenario: 公网覆盖 fixture 快照

- **WHEN** 以 contracts/services.fixtures.json 的 public-* 案例构造清单
- **THEN** 实现输出与 fixture manifest 完全一致（覆盖值原样出现在对应条目）

#### Scenario: 未知与重复服务名

- **WHEN** 清单构造时包含未知服务名条目或同名重复条目
- **THEN** 未知条目被静默忽略（前向兼容，无告警），重复条目以首个为准并在服务端日志输出一条 WARNING

#### Scenario: relay URL scheme 校验

- **WHEN** relay 条目构造时派生 scheme 非 http(s)
- **THEN** 该条目按禁用处理并在日志 WARNING，不产出非 http(s) URL

#### Scenario: 人类可读摘要

- **WHEN** 访问 `GET /`
- **THEN** 返回纯文本摘要，内容与清单一致且全部字符码位 < 128

### Requirement: 启动横幅（单一配置入口呈现）

CLI 启动横幅 SHALL 为纯英文且全部字符码位 < 128，vite 风格枚举本机全部非 loopback IPv4 的 gateway URL（Local + Network；无可枚举地址时 SHALL 打印占位说明行而非省略该节），并以 `NAME | PORT` 表格列出各服务及状态，向用户传达"任一 Network 地址即客户端唯一配置入口"。设置公网覆盖时，横幅 SHALL 另列 Public 节逐行给出已设置的公网 URL（公网部署下它才是客户端应配置的入口）。

#### Scenario: 多网卡地址枚举

- **WHEN** 服务器具有多个非 loopback IPv4 地址并启动
- **THEN** 横幅逐一列出各地址的 gateway URL，无遗漏、无重复

#### Scenario: 横幅 ASCII 纪律

- **WHEN** 任意配置下启动并捕获 stdout
- **THEN** 横幅全部字符码位 < 128

#### Scenario: 公网覆盖的横幅呈现

- **WHEN** 以 `--public-gateway` / `--public-relay`（或对应 env）启动
- **THEN** 横幅 Public 节列出已设置的公网 URL；未设置的条目不出现

### Requirement: Docker 交付

项目 SHALL 提供 Docker 镜像并以 `ghcr.io/gaubee/dweb` 名发布。镜像 SHALL 通过环境变量完成全部配置（端口、relay 开关等），无配置时使用合理默认值启动。项目 SHALL 另提供 compose 部署参考物：dweb 服务与隧道 sidecar（以 Cloudflare Tunnel 的 `cloudflared` 为参考实现，`TUNNEL_TOKEN` 注入、公网入口在面板侧配置）共同编排，且隧道拓扑下 MUST NOT 向宿主发布任何端口（暴露面完全收敛到隧道）。

#### Scenario: 默认配置启动

- **WHEN** 以无环境变量方式运行镜像
- **THEN** 服务端以默认端口启动并响应健康检查

#### Scenario: compose 隧道部署

- **WHEN** 以 `docker compose up`（提供 TUNNEL_TOKEN 与公网覆盖 env）启动
- **THEN** dweb 服务不发布宿主端口，公网入口经 sidecar 隧道可达，`/services.json` 公告公网 URL
