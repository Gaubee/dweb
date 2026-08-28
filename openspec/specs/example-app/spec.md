# example-app Specification

## Purpose
定义使用 `@jixo/opendweb-client-sdk` 的示例应用的可观察行为。它是整套组网能力的端到端验收载体：两个进程在无自建中心服务的前提下完成组网、受控邀请与消息交换。

## Requirements

### Requirement: CLI 命令面

example CLI SHALL 提供命令：`init`、`id`/`info`、`invite`、`join`、`members`、`connect`、`send`、`chat`、`name`、`revoke`，并新增 `config <list|get|set|unset>`。全部用户面字符串（横幅、帮助、错误、WARNING）SHALL 为英文且全部字符码位 < 128。选项解析 SHALL 同时接受 `--opt value` 与 `--opt=value` 形式（语义完全等价）及布尔 flag；路径类值 SHALL 做 `~` 展开；未知选项 MUST 以退出码 2 报错并列出已知选项。invite 的 TTL 默认值 SHALL 为 60 分钟，`--ttl` SHALL 接受 `ms|s|m|h|d` 后缀时长（裸数字按毫秒解析），解析结果 MUST 落在 1 秒至 30 天值域内，越界或为零 MUST 报错。`invite` SHALL 支持 `--allow-relayless` 透传 SDK 逃生阀并打印 WARNING（token has no relay path; the caller is responsible for an out-of-band reachable path）。

#### Scenario: 查看身份

- **WHEN** 运行 `info`
- **THEN** 打印 EndpointId 与 fabric-id

#### Scenario: 选项两种形式等价

- **WHEN** 分别以 `--data /tmp/a` 与 `--data=/tmp/a` 运行同一命令
- **THEN** 两者解析结果与行为完全一致

#### Scenario: 路径波浪号展开

- **WHEN** 以 `--data ~/fab` 运行（shell 未展开时）
- **THEN** 数据目录解析为 `$HOME/fab`

#### Scenario: TTL 默认值与后缀

- **WHEN** 不带 `--ttl` 运行 `invite`，或以 `--ttl 15m` 运行
- **THEN** 令牌过期时间分别为 60 分钟与 15 分钟后

#### Scenario: TTL 越界报错

- **WHEN** 以 `--ttl 0`、`--ttl 40d` 或 `--ttl 999ms` 运行 `invite`
- **THEN** CLI 报错退出并提示值域（1s 至 30d），不签发令牌

#### Scenario: TTL 下界接受

- **WHEN** 以 `--ttl 1000ms` 或 `--ttl 1s` 运行 `invite`
- **THEN** 令牌正常签发，过期时间为 1 秒后

#### Scenario: 未知选项报错

- **WHEN** 运行 `chat --foo bar`
- **THEN** CLI 以退出码 2 退出并提示未知选项及已知选项列表

#### Scenario: allow-relayless 警告

- **WHEN** relay 未配置时以 `--allow-relayless` 运行 `invite`
- **THEN** 令牌签发，且 WARNING 说明令牌无 relay 路径、调用方须自行提供带外可达路径

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

### Requirement: 持久配置文件

CLI SHALL 将连接偏好持久化于 `~/.opendweb/config.json`（目录 0700、文件 0600——Windows 上为尽力而为语义，文档注明依赖用户 profile ACL；加载时发现权限过宽 SHALL 收紧并 WARNING；写入 SHALL 以 tmp+rename 原子替换）。已知键冻结为：`relay`（字符串或字符串数组；`config set relay <url1> <url2> [...]` 变参写入数组）、`proxy`（auto|on|off）、`data`（默认数据目录）、`inviteTtlMs`（数值，1s 至 30d 值域）、`joinTimeoutMs`（数值，1s 至 10min 值域）。配置生效优先级 MUST 为：CLI flag > 环境变量（DWEB_DATA/DWEB_RELAY/DWEB_RELAY_URLS/DWEB_PROXY）> 配置文件 > 内置默认（`--join-timeout <dur>` 与 `joinTimeoutMs` 无 env 项）；同项高优先级存在则低优先级整体失效。环境变量 `DWEB_RELAY=disabled` SHALL 使 relay 整体禁用（覆盖文件 relay 值）；`DWEB_RELAY=custom` 但 `DWEB_RELAY_URLS` 缺失或全空 MUST 启动报错（指明缺什么）；`DWEB_RELAY`/`DWEB_PROXY` 非法取值 MUST 启动报错（指明合法值集合），不回退默认；`DWEB_RELAY` 完全缺席而文件 `relay` 存在时按 custom 模式采用文件值（数组时全列表生效，多 relay 选择由 iroh 原生处理）。非法配置文件（JSON 解析失败/未知键/值类型或值域错误）MUST 硬错误退出并指明路径与原因。`config set relay <url...>` SHALL 当场执行 bootstrap 解析与探测并回显结果。

#### Scenario: 优先级合成

- **WHEN** 配置文件 `relay=http://a:8787` 且环境变量 `DWEB_RELAY_URLS=http://b:3340`（DWEB_RELAY=custom）
- **THEN** 运行时使用 `http://b:3340`

#### Scenario: 显式禁用覆盖文件

- **WHEN** 配置文件 `relay=http://a:8787` 且环境变量 `DWEB_RELAY=disabled`
- **THEN** 运行时 relay 禁用

#### Scenario: config 子命令

- **WHEN** 依次执行 `config set proxy off`、`config get proxy`、`config unset proxy`
- **THEN** get 输出 `off`；unset 后 get 报告默认值；`config list` 标注各键的取值来源（flag/env/file/default）

#### Scenario: 非法配置文件硬错误

- **WHEN** `~/.opendweb/config.json` 内容不是合法 JSON
- **THEN** CLI 启动报错退出，错误信息含文件路径

#### Scenario: config set relay 离线预填

- **WHEN** 网络不可达时执行 `config set relay <url>`（URL 语法合法）
- **THEN** 值被写入配置文件，CLI 以非零码退出并输出 `saved but unreachable` WARNING；`config list` 显示该保存值

#### Scenario: config set relay 语法错误不写入

- **WHEN** 执行 `config set relay not-a-url`
- **THEN** 不写入任何变更，CLI 非零码退出并提示非法 URL

#### Scenario: URLS 单独存在视为隐式 custom

- **WHEN** `DWEB_RELAY` 未设置但 `DWEB_RELAY_URLS` 存在（逗号分隔）
- **THEN** 按隐式 custom 模式采用该列表；空项过滤后去重保序，全空则启动报错

#### Scenario: config set relay 零参数报错

- **WHEN** 执行 `config set relay`（无 URL 参数）
- **THEN** 报错并列出用法，不写入

#### Scenario: 动态值非 ASCII 与控制字符转义

- **WHEN** 错误信息中的动态值（路径/URL/原因）含非 ASCII 字节（如中文路径的目录）或控制字符（<0x20 与 0x7F，含换行）
- **THEN** CLI 输出按 UTF-8 字节以小写十六进制 `\xNN` 转义，整行仍满足全 ASCII 断言，且一行一错误（控制字符不产生额外行）

#### Scenario: 数组 relay

- **WHEN** `config set relay` 写入两个 URL 的数组后运行 `chat`
- **THEN** 两个 relay 均作为候选生效

### Requirement: bootstrap 状态机（gateway 解析与代理决策）

CLI 启动 SHALL 以无环状态机处理 relay 配置：先规范化原始 URL 列表（非法项为配置错误），再做代理决策（仅依据原始值与环境，不依赖解析产物），最后按已决策略做地址解析。代理决策（`auto`，**按候选集合判定，无顺序依赖，代理覆盖语义**）：对全部原始候选逐一直连发起有界 HTTP 请求（3 秒超时，空列表不发任何请求）——全部候选直连收到完整响应则策略为 none；存在直连不可达候选且环境有代理，则对不可达者经代理重发，任一经代理收到完整响应则策略为 from-env（**后续地址解析对全部候选统一经代理**；直连可达候选经代理解析失败则该项硬错误，诊断可见——混合部署的正确性由代理路由保证）；全部两路均失败则策略为 none 并 WARNING（该文案仅在实际尝试过代理并失败后出现）；无环境代理且存在直连不可达候选则策略为 none 并输出不同的 WARNING（该类候选随后以直连方式硬错误）。**可达性判据**：收到任何完整 HTTP 响应（含 404/401/407/500——只证明传输路径通）即视为该路径可达——iroh relay 服务端对未知路径回 404，此即 legacy 探测方式；仅连接错误/超时为不可达。地址解析（按已决策略统一执行）：`200` 且 JSON 合法且 relay 启用则采其 URL；relay 禁用或条目 `url` 为 null 则该项产出 disabled 信号（混合数组中 disabled 项被忽略并 WARNING，全部为 disabled 则整体进入禁用模式并 WARNING）；**仅** `404` 或 `200 但非 JSON` 判定为 0.1.0 legacy 裸 relay；超时、5xx、404 之外的 4xx SHALL 硬错误输出诊断（`error: gateway <url> unreachable (...)`，退出码 1，无 fallback）。数组配置 SHALL 逐项独立解析、失败即整体失败、结果去重后全量生效。

#### Scenario: 空 relay 配置不发探测

- **WHEN** relay 未配置（disabled）时启动任意命令
- **THEN** bootstrap 不发起任何 HTTP 请求，代理策略为 none

#### Scenario: proxy=on 无环境代理报错

- **WHEN** `proxy=on` 且环境不存在任何有效代理 URL 时启动
- **THEN** CLI 配置错误退出并提示缺少可用代理

#### Scenario: 数组混合可达性（代理覆盖语义）

- **WHEN** relay 数组含一个仅直连可达的候选与一个仅代理可达的候选（auto 模式，任意顺序）
- **THEN** 代理策略为 from-env、地址解析对全部候选统一经代理，结果与数组顺序无关

#### Scenario: 顶层 gateway 字段为 null

- **WHEN** services.json 顶层 `gateway` 为 null（服务端无可枚举地址）
- **THEN** gateway 字段仅为信息性，客户端照常消费 relay 条目（relay url 为 null 才视同禁用），无额外告警

#### Scenario: n0 模式语义

- **WHEN** 配置 relay 模式为 n0
- **THEN** 使用 iroh 官方默认 relay（https://relay.iroh.network）；`config list` 显示 mode n0 与该 URL；bootstrap 不对 n0 探测（公网可用性非本机配置问题）；relayStatus().mode 为 "n0"、urls 为该默认值

#### Scenario: 服务条目 url 为 null

- **WHEN** services.json 某服务条目为 `enabled:true, url:null`
- **THEN** 该条目视同禁用，CLI 输出 WARNING 并跳过

#### Scenario: 旧版直连 relay URL 兼容

- **WHEN** relay 配置值为 `http://192.168.2.13:3340`（无 services.json，返回 404）
- **THEN** 该值按裸 relay URL 使用，组网行为不变

#### Scenario: 服务端禁用 relay 时客户端进入禁用模式

- **WHEN** gateway 的 services.json 显示 relay 禁用
- **THEN** CLI 进入 relay 禁用模式并输出 WARNING，不把 gateway 端口当作 relay 使用

#### Scenario: gateway 超时不回退

- **WHEN** relay 配置值指向的 gateway 请求超时或返回 5xx
- **THEN** CLI 硬错误退出并输出网关不可达诊断，不回退裸 relay 模式

#### Scenario: 混合数组逐项解析

- **WHEN** relay 配置为数组且其中一项来自禁用 relay 的 gateway、另一项为 legacy relay
- **THEN** legacy 项生效、禁用项被忽略并输出 WARNING

### Requirement: 代理策略三态（显式所有权）

CLI SHALL 支持 `proxy` 配置键三态，并将结果作为**显式代理配置**传入 SDK（内核映射到 iroh endpoint 构建器；iroh 不读取进程环境变量）。决策时序与探测算法遵循 bootstrap 状态机 requirement（Fabric 构造之前完成）；CLI 自身的 HTTP 请求（services.json 解析、探测）SHALL 遵循同一策略。代理环境变量读取顺序 SHALL 与 iroh `proxy_from_env` 一致（HTTP_PROXY > http_proxy > HTTPS_PROXY > https_proxy；空值视为未设置；非法 URL 忽略）。QUIC 数据面（直连与 NAT 穿透）不经 HTTP 代理，此事实 SHALL 在文档中写明。代理 HTTP 客户端 SHALL 使用显式声明的 `undici` 依赖（非假设 Node 内置可导入）。

#### Scenario: 自动模式直连可达

- **WHEN** shell 设置了 `http_proxy` 且 `proxy=auto`，relay 直连探测成功
- **THEN** 传给 SDK 的代理策略为 none，relay 连接不走系统代理

#### Scenario: 自动模式回退代理

- **WHEN** relay 直连不可达、环境存在可用代理
- **THEN** 传给 SDK 的代理策略为 from-env

#### Scenario: 强制关闭代理

- **WHEN** `proxy=off` 且 shell 设置了代理变量
- **THEN** 传给 SDK 的代理策略为 none

### Requirement: join 可诊断失败

`join` SHALL 受总时限约束（默认 30 秒，`--join-timeout <dur>` 可调），失败时 SHALL 以稳定错误码输出到 stderr 并以非零码退出，格式 `error[join/<code>]: <可操作建议>`。错误码集合冻结为 8 码（本地数据面豁免错误以 `error[<variant>]` 形式透出——variant 为 missing-identity/corrupted/roster-io——不包装为 `error[join/<code>]`）：`TOKEN_INVALID`、`TOKEN_EXPIRED`、`WRONG_FABRIC`、`NO_REACHABLE_PATH`（令牌既无 relay 也无直连地址，拨号前立即失败）、`RELAY_OFFLINE`、`DIAL_FAILED`（立即拨号错误且不可归因 relay）、`DIAL_TIMEOUT`（时限内未完成；relay 在线时附注 issuer 可能离线）、`TOKEN_CONSUMED`。

#### Scenario: 空路径令牌秒败

- **WHEN** 以 relay 与直连地址均为空的令牌执行 `join`
- **THEN** 立即（不等待 30 秒）以 `NO_REACHABLE_PATH` 失败，stderr 提示令牌无可达路径

#### Scenario: 超时归类

- **WHEN** 签发者离线导致 join 在时限内未完成
- **THEN** 以 `DIAL_TIMEOUT` 失败，错误信息附注 issuer 可能离线

#### Scenario: 目录归属不匹配

- **WHEN** 以属于 fabric A 的数据目录兑换 fabric B 的令牌
- **THEN** 以 `WRONG_FABRIC` 失败，错误信息含两个 fabric 的短标识与"使用新数据目录"指引，不使用 "corrupted" 措辞

### Requirement: 连接状态外显

`chat` 启动 SHALL 先调用 relay 状态快照再订阅跳变事件（快照优先，避免初始事件竞态），打印 relay 状态（online + URL，或含最近错误类别的离线 WARNING），并在 relay 恢复时打印提示。

#### Scenario: relay 离线警告

- **WHEN** 配置的 relay 不可达时启动 `chat`
- **THEN** 输出包含 relay offline 的 WARNING 行（含最近错误类别）

#### Scenario: relay 恢复提示

- **WHEN** chat 运行中 relay 从离线恢复
- **THEN** 输出一行恢复提示
