# Proposal: connectivity-ux-hardening

## Why

0.1.0 发布后的三机实测（Mac 本机 + 远端 Mac mini relay + Windows 加入方）暴露了一类共同根因的问题：**连接链路的可用性信息在每一层都被静默吞掉，用户只能看到"超时"**。

实证事故链（2026-08-28 子代理全链路排查结论）：

1. `invite` 在 relay 未配置（`DWEB_RELAY` 缺省 = disabled）时照常签发 **relay 字段为空** 的令牌；
2. 一次性 invite 进程的直连地址（临时端口）随进程退出即死，令牌永久不可兑换；
3. join 侧只能拿到死地址 + 空 relay，表现为无限等待后超时，无任何诊断信息；
4. chat 启动时对 home relay 的连接结果不外显，"ready" 不代表 relay 可用；
5. 数据目录属于另一 fabric 时报 "corrupted"，误导用户以为数据损坏；
6. 全部配置依赖环境变量逐终端手输，跨设备操作极易漏带。

同时用户对 server CLI 提出呈现层需求：英文输出、枚举可用 IP（vite 风格）、单一配置入口（gateway）+ 服务表。

## What Changes

### 1. 服务端 gateway 与服务清单（server spec）

- HTTP 端口更名为 **gateway**（默认 8787），承载 rendezvous + healthz + 服务清单；
- 新增 `GET /services.json`：机器可读的服务清单（relay 是否启用及其 URL），URL 按请求 Host 派生；
- relay 受 iroh `RelayServer` 独占监听器约束无法合并入 gateway 端口，作为独立服务在清单中暴露；
- 启动横幅改为**纯英文**、vite 风格枚举本机全部非 loopback IPv4、单一配置入口提示 + `NAME | PORT` 服务表。

### 2. 客户端 gateway 解析（example spec）

- example CLI 的 relay 配置值经**无环 bootstrap 状态机**处理（代理决策先于地址解析）：gateway URL 取 `/services.json` 解析实际 relay URL；仅 404/非 JSON 判定为 0.1.0 裸 relay 直连（legacy 兼容）；超时/5xx 等网关故障硬错误输出诊断，不再静默回退。

### 3. invite 安全门（fabric/roster spec）

- 内核 `invite()` 在 relay 为空且无显式 `advertise_addrs` 时**拒绝签发**（新错误 `InviteWithoutRelay`）——令牌已知不可兑换，内核不签发不可达的信任凭据；
- 显式 `allow_relayless` 逃生阀（SDK `invite()` 第三参 opts）供确有直连配置的库用户使用。

### 4. 连接可观测与 join 可诊断失败（fabric/session + sdk/node spec）

- 内核新增 `RelayOnline`/`RelayOffline` 事件（直接消费 iroh `home_relay_status()` 状态流，聚合跳变触发，非轮询；Fabric shutdown 显式 abort watcher）；
- SDK 暴露 `relayStatus()` 快照（含 `lastError`）与 `relay-online`/`relay-offline` 事件（必携带快照同构 payload），快照优先、事件补充；
- example chat 启动时打印 relay 状态，离线时输出醒目 WARNING；
- **join 增加总时限（默认 30s，包住 connect+redeem）与互斥穷尽的稳定错误分类**（8 码：`TOKEN_INVALID/TOKEN_EXPIRED/WRONG_FABRIC/NO_REACHABLE_PATH/RELAY_OFFLINE/DIAL_FAILED/DIAL_TIMEOUT/TOKEN_CONSUMED`；冻结兑换拒绝的 `RedeemErrorKind` wire discriminant）：空 relay 令牌在拨号前即秒败并指路（`NO_REACHABLE_PATH`），issuer 离线导致的超时归类为 `DIAL_TIMEOUT` 并附注成因——原始事故在 join 侧零等待闭环。

### 5. 错误语义纠正（fabric/roster spec）

- 目录归属 fabric 不匹配从 `Corrupted` 拆分为专用 `DirFabricMismatch` 错误（避让 `redeem_verify` 既有的 `WrongFabric` 跨事实语义），文案给出可操作指引（换 `--data` 目录）。

### 6. example CLI 配置化与参数健壮性（example spec）

- `~/.opendweb/config.json` 持久配置 + `config list|get|set|unset` 子命令（relay（单值或数组）/ proxy / data / inviteTtlMs / joinTimeoutMs），完整优先级决策表（flag > env > file > default）；
- `--opt=value` 与 `--opt value` 双形式、`~` 展开、未知选项报错；
- invite TTL 默认 10 分钟 → **60 分钟**（值域 1s–30d），`--ttl` 接受 `30s/15m/2h/1d` 时长后缀（裸数字仍为 ms）；
- proxy 策略三态 `auto|on|off`，**显式代理所有权**：`FabricConfig.httpProxy`（none|from-env|url）直配 iroh endpoint builder（iroh 不读环境变量，已实证）；auto 在 Fabric 构造前探测直连可达性并决定策略；
- 全部用户面 CLI 文案改英文且**全 ASCII（码位 < 128）**。

### 7. 实施编排前置（工程约束）

- **Batch C0 契约冻结**（ZCode 亲写）：SDK 完整 d.ts 契约、services.json fixture、错误码矩阵先于子代理并行批次落盘；README/版本号/锁文件/生成产物为唯一 owner 文件。

## Impact

- **涉及代码**：`crates/dweb-server`、`crates/dweb-fabric`、`packages/opendweb`、`packages/server-binary`、`packages/example`、`packages/client-sdk`、README。
- **破坏性变更**（pre-1.0 可接受）：SDK `invite()` 增加可选第三参（向后兼容）；`RosterError::Corrupted` 的 fabric 不匹配分支拆分为 `DirFabricMismatch`（错误变体枚举变更）；server HTTP 端口语义更名为 gateway（环境变量 `DWEB_HTTP_BIND` 保留为别名）。
- **不做**：relay 协议并入单端口（iroh 上游约束）；发布新 npm 版本（本轮收尾为 archive + commit + push，发版待用户指令）。
- **规格影响**：`server`、`example-app`、`fabric/roster`、`fabric/session`、`sdk/node` 五个 capability 的 delta。
