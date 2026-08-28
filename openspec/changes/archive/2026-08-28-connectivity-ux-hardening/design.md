# Design: connectivity-ux-hardening

> （以下修订注记为**非规范历史**，规范内容以正文为准）
>
> 修订 r15（2026-08-28）：吸收 Codex R14 评审（docs/codex-uxh-review-14.md，9.2/10）：issuerMapping rows
> 拆至稳定 ASCII variantId 粒度（17 行：proof_frame 拆 4 行、post_consume 拆 3 行、consume Err 标注实际
> RosterError::Persistence + sourceClass=IO、入口条件 ASCII id）；_schema 增 variantId 字段声明；_fTestOwner
> 按 variantId 逐行绑定并写明**旧文本发送路径与 Ok(false) 静默返回必须删除**；tasks 3.4 同步该删除要求
> 与 emit 语义（true=0x14 单记录后关闭 / false=无结构化帧直接关闭）。

> 修订 r14（2026-08-28）：吸收 Codex R13 评审（docs/codex-uxh-review-13.md，9.0/10——候选放行态）：issuerMapping
> 重建为结构化 rows 数组（{stage, variant, emit, kind:0..3|null, payloadTemplate, joinerResult, close}，
> _normalization 显式限定 emit=true 行）；阶段拆分为 session_entry（首帧/入口 decode：emit=false 防御分支）/
> proof_frame（协议违规统一关闭）/ redeem_verify（实际枚举五行 + 内部 Protocol 独立行，区别于入口 decode）/
> consume_invite（Ok(false)->Consumed / Persistence 关闭）/ post_consume（grant/编码/回执写失败显式冻结，
> 不靠 ? 传播）；variant 用实际 Rust 枚举标识、kind 数值化、动态原因走 payloadTemplate+归一化；
> _fTestOwner 逐行绑定构造。

> 修订 r13（2026-08-28）：吸收 Codex R12 评审（docs/codex-uxh-review-12.md，8.6/10）：tasks 3.5 九例
> -> 十二例同步；fixture expectedRecords 统一为结构化 {kind:number, payloadHex, presented}（未知 kind=127，
> 非 ASCII 例 payloadHex=e4b8ad/presented=""），全例补 expectedViolation 显式 null，**payloadHex 与 hex 向量
> 逐字节自校验通过**；issuerMapping 重建为阶段穷尽表（redeem_verify 实际变体六行 + consume_invite 独立
> 两行 + out-of-scope 显式清单 + F 测试 owner 绑定）；matrix wire grammar 段压缩为 JSON 索引（十二例名 +
> 四字段断言 + reduction 摘要），不再重复字段值。

> 修订 r12（2026-08-28）：吸收 Codex R11 评审（docs/codex-uxh-review-11.md，8.3/10）：matrix 唯一
> 覆盖行改指 JSON 十二例（旧 .hex 引用清除）；fixture 拆分 expectedReaderOutcome（read_frame 层）与
> expectedResult（一律 join 侧归类，两层短读最终 DIAL_FAILED）；新增 not-root(0x01)/bad-pop(0x02)/
> non-ascii-payload 三例（十二例全部字节级验证）；issuerMapping 穷尽化（InviteExpired->Other 竞态兜底、
> Protocol 防御分支不发帧、非 redeem 变体显式 out-of-scope、原因规范化算法冻结：UTF-8->剥非可打印
> ASCII->截断至 255）；design D11 grammar 压缩为决策摘要 + 唯一权威指向 JSON；5s 等值边界两 scenario
> （>5s 内层附注 redeem timeout / <=5s 外层拥有唯一结果附注 join timeout）。

> 修订 r11（2026-08-28）：吸收 Codex R10 评审（docs/codex-uxh-review-10.md，8.0/10——framing P0 确认闭合）：
> fixture 重构为 contracts/redeem-err.fixtures.json（九例结构化向量：新增 len-255-other 边界与
> outer-payload-truncated 负例，每例含 expectedRecords/expectedResult/expectedViolation，无空格连续 hex，
> 新向量同样经字节级模拟验证）；**issuer 生产映射表入 fixture**（consume_invite==false->Consumed、
> BadPoP/NotRoot 直映射、WrongFabric/RecipientMismatch->Other、IO/内部错误->不发帧直接关闭归 DIAL_FAILED、
> 每类恰一条记录后关闭）；design D11 wire 规则去重为单一 grammar；D4 事件 URL tie-break 入 session delta
> scenario + tasks 3.5 断言；控制字符转义入 example delta + tasks 2.6；n0 的 urls 恒等官方默认值冻结进
> d.ts + sdk delta scenario + bootstrap matrix 行；本地豁免 CLI 透出格式（error[<variant>] 不包装 join/）
> 入 example delta + tasks 2.5；5s 等值边界冻结（joinTimeoutMs<=5s 外层拥有唯一结果）。

> 修订 r10（2026-08-28）：吸收 Codex R9 评审（docs/codex-uxh-review-9.md，6.0/10——评审直读 session.rs
> 抓到 r9 硬伤）：外层帧修正为实际实现 `u32_be(1+payload_len) + type(1B) + payload`（公共读写器零改动），
> fixture 七例向量**全部按该算法字节级模拟验证通过**（含外层头 EOF 短读例）；多记录 reduction 冻结为
> fail-closed（多条 -> TOKEN_INVALID，完整消费不位移）；兑换通道内层 5s 超时显式归 DIAL_TIMEOUT（附注
> redeem timeout，joinTimeoutMs 更短时外层先到）；matrix 去重为唯一 F 覆盖行；坏令牌+错目录 / 内层超时 /
> 多记录 / 顶层 gateway:null / n0 语义五组场景补入对应 delta；n0 冻结为 iroh 官方默认 relay 且 bootstrap
> 不探测；D4 事件 URL tie-break 取配置序最小；D10 控制字符同样 \\xNN 转义；C0.3 增主 session spec
> 兑换三段式勘误（已执行：首帧兑换请求 -> INTENT/CHALLENGE/PROOF 三段）。

> 修订 r9（2026-08-28）：吸收 Codex R8 评审（docs/codex-uxh-review-8.md，8.1/10）：**冻结
> RedeemErrorKind 外层落位**——记录嵌于既有 REDEEM_ERR(0x14) 外层帧 payload（外层结构/32KiB/5s 上限
> 不变，REDEEM_OK 沿用），新增 contracts/redeem-err.fixtures.json 九例结构化向量（hex/expectedRecords/expectedResult/expectedViolation + issuerMapping）；D11 顺序固化为
> 令牌错误 -> 本地数据面豁免 -> 目录归属 -> 空路径 -> 网络（冲突场景两条入 session delta）；规范正文
> "超传"字样改正面表述；nullable fixture 补精确服务端告警串；C0 配置矩阵补 URLS 隐式 custom/空项/
> 零参/语法错/探测保存行，bootstrap 各行补最终退出码聚合；[bad-proxy-url] 入公共稳定码表 + sdk delta
> 场景。

> 修订 r8（2026-08-28）：吸收 Codex R7 评审（docs/codex-uxh-review-7.md，8.2/10）：规范段落"超长/超传"
> 字样清除、历史注记标记非规范；DWEB_RELAY_URLS 隐式 custom/空项过滤/零参报错/动态转义进 delta+tasks；
> Host 拒绝清单同步 server delta+tasks；fixtures 结构化告警字段补全；advertise 增端口 0 拒绝/重复去重/
> [bad-advertise-addr] 前缀；D10 转义冻结 UTF-8 字节小写十六进制。

> 修订 r7（2026-08-28）：吸收 Codex R6 评审（docs/codex-uxh-review-6.md，7.8/10）：255 上限同步到权威
> matrix 与 tasks（r6 漏网）；**删除"载荷超传"语义**——帧后额外字节一律按下一帧解析（v1 issuer 单帧后
> 关闭、接收端逐帧至 EOF），段短读（含 EOF 不完整帧）才是协议违规；D11 顺序改为令牌自身错误（解码/
> 过期/地址规范化）全部优先于目录检查，冲突输入唯一归类；D6 删"首个用于 D2"特权（全候选参与 bootstrap）；
> session"首次可达"scenario 改为快照 online 无初始事件；matrix 401/5xx 行 policy 显式 from-env + 整体
> 失败聚合；Host 拒绝集合冻结为可执行清单（unspecified/userinfo/解析失败/端口越界，其余放行含 loopback）；
> D10 冻结动态值 \xNN 转义；fixtures 增结构化 expectedClientWarning/expectedServerWarnings；
> RelayOptions custom urls 改非空元组类型 + 空数组构造 reject 场景；DWEB_RELAY_URLS 单独存在=隐式
> custom、逗号空项过滤去重、config set 零参报错。

> 修订 r6（2026-08-28）：吸收 Codex R5 评审（docs/codex-uxh-review-5.md，8.0/10）：RedeemErrorKind 帧上限
> 修正为单字节可表达的 255（段短读=协议违规关兑换连接，Other 允许零长载荷，未知 kind 按 len 原样消费，额外字节按下一帧）；
> bootstrap 决策表补部分成功/部分失败、代理可达但解析 401/5xx、legacy+gateway 混合三行；D2 状态机同步
> 部分失败分支；wildcard 拒绝同步 roster delta 与 tasks；未知名=静默忽略（仅重复名 WARNING）统一
> fixture/server delta；D4 首值只进快照不广播；主 SDK 规格生命周期场景动词改工厂+shutdown（已执行）；
> d.ts RelayOptions 改判别联合（非法组合构造期拒绝）；tasks 3.5 逐项列举四类探针注入/豁免三态/帧测试。
> r5 及更早要点见 docs/codex-uxh-review-{1..4}.md。

> 修订 r5（2026-08-28）：吸收 Codex R4 评审（docs/codex-uxh-review-4.md，8.0/10）全部处置：
> D2 代理决策改**代理覆盖语义**（任一候选不能直连到达即统一 from-env，混合场景语义自洽）；RELAY_OFFLINE
> 探针限定适用条件（令牌无直连地址 + 策略 none），transport-only 语义 + DNS/默认端口/计时边界冻结 +
> 四类确定性注入集；RedeemErrorKind 冻结完整帧格式（kind+len(0..255)+payload，段短读=协议违规断连、额外字节按下一帧，
> 未知 kind 按 len 消费不错位）；豁免 3 前缀（missing-identity/corrupted/roster-io）进入 d.ts/sdk delta/
> session delta/error-matrix owner 行；config set relay 事务语义冻结（语法错不写、探测败仍写+非零+逐项
> WARNING）；D4 lastError 改按内核显式配置序号排序（不信任 watcher 顺序）；advertise_addrs 拒绝通配地址；
> fixtures 扩为四组（canonical/disabled/nullable/unknown+dup）；error-matrix E 列拆 E mock 与 ZCode 4.1；
> allow-relayless 文案统一带外责任；sdk 主规格 start/stop 措辞基线差异由 C0.3 统一为工厂+shutdown（已执行）。
> r2-r4 要点见 docs/codex-uxh-review-{1,2,3}.md。

## 0. 背景与根因

2026-08-28 三机实测排查（子代理二分法全链路验证）定位的根因链：

```
invite 进程缺 DWEB_RELAY 环境
  -> RelayConfig::Disabled -> relay_url = ""
  -> 令牌 issuer_relay_url 为空
  -> 一次性 invite 进程退出，直连地址（临时端口）全部死亡
  -> join 侧无可达路径 -> 无限超时，零诊断信息
```

链路各环节单独验证均无罪：relay 服务端（spike 裸 iroh 客户端桥接成功）、iroh 拨号（带死地址提示也能 echo）、fabric 协议（好令牌全链路成功）。**罪魁是"签发了已知不可达的令牌"这一静默行为**。本 change 的设计原则：

> **任何一层都不许静默吞掉可达性信息：不可达的凭据不签发，已配置的路径状态要外显，连接失败要分类可诊断，配置错误要当场报错。**

## D1 — Gateway 单一入口（server）

### 约束

iroh relay 服务端（`iroh_relay::server::Server::spawn`）**独占自己的 TCP 监听器**，不暴露 tower Service，无法挂到 axum 路由后面；relay 协议（HTTP/2 + WS 升级）与我们的 HTTP API 也无法在同一端口做协议嗅探分发。**真·单端口合并在 v0.2 不可行**（重写 relay 协议栈，明确拒绝）。

### 方案：gateway 端口 + 服务清单

```
                        +------------------------------------------+
                        |  gateway :8787 (axum)                    |
                        |  ├── GET /            human summary      |
  client config entry ->|  ├── GET /healthz     liveness           |
  http://IP:8787        |  ├── GET /services.json  machine list   |
                        |  └── /rendezvous/{id}  announce/resolve  |
                        +------------------------------------------+
                        |  relay :3340 (iroh RelayServer, own port)|
                        +------------------------------------------+
```

rendezvous 本就在 gateway 端口上（0.1.0 现状），**唯一新增是服务清单**。客户端拿 gateway URL 即可自动发现 relay。

### `GET /services.json` 契约（v1，随 Batch C0 冻结 fixture）

```json
{
  "server": "opendweb",
  "version": "<semver>",
  "gateway": "http://<host>:<gateway-port>",
  "services": [
    { "name": "rendezvous", "enabled": true,  "url": "http://<host>:<gateway-port>/rendezvous" },
    { "name": "relay",      "enabled": true,  "url": "http://<host>:<relay-port>" }
  ]
}
```

URL 派生规则（按序）：

1. **scheme**：跟随请求 scheme；反代后 HTTPS 由 `X-Forwarded-Proto` 提供，仅当 `DWEB_TRUST_PROXY=1` 时采信（默认不信任，取 `http`）；
2. **host**：取 `Host` 头的主机部分（含 `[ipv6]:port` 括号形态的正确剥离），但**校验拒绝集合冻结为**：unspecified 地址（`0.0.0.0`、`::`、空 host）、含 userinfo 的形态（`user:pass@host`）、host:port 解析失败、端口 0 或 >65535——**其余一律放行（含 loopback**，本机调试合法**）**；校验失败或无 Host 头（HTTP/1.0）→ 回退**本机首个非 loopback IPv4**（与横幅同一枚举函数）；**回退也无可用地址**（无任何非 loopback IPv4）→ gateway 与各服务条目的 `url` 字段为 `null`（`enabled` 照实），并在服务端日志 WARNING——绝不产出 `0.0.0.0` 这类不可达 URL；
3. **port**：各服务条目用**实际监听端口**（gateway 条目用 gateway 绑定端口，relay 条目用 relay 实际绑定端口）。

响应头：`Content-Type: application/json`；`Cache-Control: no-store`。relay 被禁用时条目为 `"enabled": false, "url": null`。**nullable 组合冻结**：`url` 类型为 `string | null`——`enabled:true` 但无可用回退地址时 `url` 可为 null，客户端视同禁用该服务项并 WARNING；未知服务名忽略（前向兼容）；重复服务名以首个为准并 WARNING；relay URL scheme 校验 http(s)。字段只增不删不改语义，fixture 代表 wire 的全部 required 字段集。`GET /` 返回同信息纯文本摘要（`Content-Type: text/plain; charset=utf-8`，全 ASCII）。

### 启动横幅（全 ASCII，码位 < 128）

```
  * opendweb server v0.2.0
  > Local:   http://localhost:8787
  > Network: http://192.168.2.13:8787
             http://10.211.55.2:8787

  Use any Network address as the single config entry for clients.

    NAME         PORT   STATE
    gateway      8787   entry point
    rendezvous   8787   merged into gateway
    relay        3340   enabled

  Press Ctrl+C to stop
```

- IP 枚举：横幅所在的 JS 层用 `os.networkInterfaces()`，过滤 loopback 与非 IPv4，去重排序；**全部网卡不可枚举时打印 `(no non-loopback IPv4 found)` 而非省略**；
- 横幅由 `packages/opendweb/bin/opendweb.mjs` 打印（它知道最终 bind 配置；server 进程只负责 /services.json）；
- **ASCII 纪律适用于所有用户面输出**（横幅、WARNING、帮助、错误），测试断言输出匹配 `[\x00-\x7F]*`（而非仅排除 CJK）。

### CLI / 环境变量映射

| 0.1.0 | 0.2.0 canonical | 兼容别名 |
| --- | --- | --- |
| `--http <bind>` | `--gateway <bind>` | `--http` 继续接受 |
| `DWEB_HTTP_BIND` | `DWEB_GATEWAY_BIND` | `DWEB_HTTP_BIND` 继续接受 |
| `--relay <bind>` / `DWEB_RELAY_HTTP_BIND` | 不变 | - |

## D2 — 客户端 bootstrap 状态机（gateway 解析 × 代理策略，评审 R2-P0-1 去环）

D2（地址解析）与 D7（代理所有权）**不得互相依赖**。冻结为单一状态机，输入只有**用户原始配置**（config 文件/env/flag 合成后的 relay 值 + proxy 值），不依赖任何解析产物：

```
输入: rawRelay (string|string[]) , proxy: auto|on|off , env 代理变量
                                        |
                [1] 规范化: 每项必须是 http(s) URL；非法 => 配置错误退出
                                        |
              [2] proxy 决策（只看 rawRelay，不看点位产物；空列表不发任何请求，policy=none）
                 off  -> policy = none
                 on   -> policy = from-env（环境无任何有效代理 URL => 配置错误退出）
                 auto -> 对 rawRelay 的**全部**候选做有界 HTTP 请求（去顺序依赖，
                         **代理覆盖语义**：只要有候选不能直连到达，就统一经代理）:
                          a. 逐候选直连 GET <raw>/services.json   (3s)
                          b. 全部候选直连可达                       -> policy = none
                          c. 存在直连不可达候选 且 env 有代理 ->
                             对不可达者经代理重发，任一代理可达      -> policy = from-env
                             （后续地址解析对**全部**候选统一走代理；
                              直连可达的候选经代理解析失败则该项硬错误，
                              诊断可见——混合部署的正确性由代理路由保证）
                          d. 失败候选的代理重试也全部失败（无论其余候选
                             直连是否可达）                        -> policy = none；
                             可达候选正常解析，失败候选在解析阶段以直连硬错误，
                             针对失败项输出 both-fail WARNING
                             (仅当代理实际尝试并失败后才允许 "both ... fail" 文案)
                          e. 无 env 代理且存在直连不可达候选          -> policy = none + 不同 WARNING
                             （该类候选在解析阶段将以直连方式硬错误，诊断可见）
                 分层说明：可达性 = 收到任何完整 HTTP 响应（含 401/407/500——只证明
                 传输路径通，407 即"代理路径可达"）；随后的地址解析步骤对 401/5xx 仍
                 硬错误（可用性判定晚于传输判定）
                                        |
              [3] 地址解析（用已决 policy 发请求）
                 对每个 raw 项独立执行:
                   GET <url>/services.json (3s, 按 policy 走/不走代理)
                   |- 200 + 合法 JSON + relay enabled -> gateway: 取 relay.url
                   |- 200 + 合法 JSON + relay disabled -> 该项产出 disabled 信号
                   |- 404 或 200 但非 JSON             -> legacy: 该项按裸 relay URL
                   |- 超时 / 5xx / 4xx(404 外)          -> 硬错误（无 fallback）:
                        error: gateway <url> unreachable (timeout|http <code>)
                 产出: relay URL 列表（逐项解析、去重）; 若全部项均为 disabled
                 信号 -> 进入 disabled 模式 + WARNING
                 混合数组中 disabled 项被忽略并 WARNING，其余照常生效
```

关键规则：

- **可达性判据**：任何**完整完成的 HTTP 响应**（无论状态码，含 404）都证明该 URL 直连/代理可达——这正是 legacy relay（iroh relay server 对未知路径回 404，无 /healthz）的探测方式；只有连接错误/超时才是"不可达"。因此步骤 2a 对 legacy 值同样有效；
- **fallback 收窄**：仅 `404` 或 `200+非 JSON` 判定为 legacy 裸 relay；超时、5xx、401 等一律硬错误输出诊断（不再吞掉网关故障冒充 relay）；
- **数组语义**：逐项独立解析（每项各自判定 gateway/legacy），解析失败的项使整个启动失败；结果列表去重后全量下发 `RelayConfig::Custom`；
- **`config set relay` 数组写入与事务语义**：变参形式 `config set relay <url1> <url2> [...]`；语法校验失败（非 http(s) URL）→ 不写入、非零退出；探测（bootstrap 解析 + 可达性）失败 → **仍写入**（离线预填是合法场景），非零退出并输出每项探测结果 WARNING（`saved but unreachable: <url> (<reason>)`）；数组部分失败同规则（整体保存、逐项报告）；`config list` 显示保存值不重探测；
- 解析与探测发生在 example CLI 层；SDK 保持"哑"的 urls 列表接口。

### HTTP 客户端与代理环境语义（评审 R2 事实修正）

- Node 18 全局 fetch 的 undici 实现**不等于**应用可 `import 'undici'`：`packages/example` MUST 显式依赖 `undici`（Batch E 在自己的 package.json 提出版本，**lockfile 更新归 ZCode 唯一 owner**）；
- 代理读取顺序（与 iroh 1.1 `proxy_from_env()` 一致，冻结）：`HTTP_PROXY` > `http_proxy` > `HTTPS_PROXY` > `https_proxy`；空值视为未设置；首个可解析为 URL 的生效，非法 URL 忽略并继续（探测侧同规则）；
- CLI 侧 `httpGet(url, { policy })`：none → 原生 fetch 直连；from-env → `new ProxyAgent(proxyUrl)` 作 dispatcher；url 形式策略不暴露给 CLI（SDK 专属）。

## D3 — invite 安全门（fabric 内核）

### 语义

`Fabric::invite()` 在以下条件同时成立时**拒绝签发**：

- 解析出的 relay URL 为空（`RelayConfig::Disabled` 或 `Custom([])`）；
- 且 `advertise_addrs` 为空。

返回新错误 `FabricError::InviteWithoutRelay`（错误信息：解释为什么拒签 + 指引配置 relay 或显式 `allow_relayless`）。

### `advertise_addrs` 的来源冻结（评审 P1-4）

安全门**只信一个来源**：`FabricConfig.advertise_addrs`（用户显式配置字段，Rust 构造入口 + SDK `FabricOptions.advertiseAddrs`）。约束：

- 每项必须非空字符串且可解析为 `ip:port`（或 `[ipv6]:port`）；**通配地址（`0.0.0.0`、`::` 的 unspecified 形态）拒绝**（必须具体可拨）；loopback 允许但文档注明仅同机可达；构造时校验，非法项直接报错（不是静默丢弃）；
- **永不混入** `direct_addr_hints()`（运行时临时绑定端口）——签发路径只看显式字段，hint 地址只用于拨号侧；
- SDK 输入数组中空字符串视为配置错误。

### 理由

- CLI 一次性 invite 进程的直连地址是**本进程临时端口**，进程退出即死；且兑换要求 issuer-online，一次性进程本来就无法完成兑换（README 需加粗说明）。relay 为空的令牌在当前所有已知用法中都是**签出即报废**；
- `advertise_addrs` 非空是用户显式声明的持久地址（如固定 LAN IP），此时 relay-less 令牌有真实可用路径，允许签发；
- 内核不应签发已知不可达的信任凭据——这是"受控邀请"语义的完整性要求，不是 UX 糖。

### 逃生阀

库用户确有直连场景时：

```rust
pub struct InviteOptions { pub allow_relayless: bool }   // Default: false
pub async fn invite(&self, ttl_ms: u64, recipient: Option<&str>) -> Result<String, FabricError> {
    self.invite_with(ttl_ms, recipient, InviteOptions::default()).await
}
pub async fn invite_with(&self, ttl_ms: u64, recipient: Option<&str>, opts: InviteOptions) -> ...
```

`allow_relayless = true` 时即便 advertise_addrs 也为空仍签发；SDK `invite(ttlMs, forId, opts?)` 透传，example `invite --allow-relayless` 透传并打印 WARNING——文案**不得声称令牌自带可达直连地址**，而是说明"token has no relay path; the caller is responsible for providing an out-of-band reachable path to the issuer"。

## D4 — relay 可观测（fabric + SDK）

### 内核（评审 P1-1 重写：消费 iroh 状态 watcher，不自造轮询）

iroh 1.1.0 公开 `Endpoint::home_relay_status() -> impl Watcher<Value = Vec<RelayStatus>>`；`RelayStatus { url, is_connected(), last_error() }`。内核 watcher 直接消费其 `.stream()`：

- **聚合语义**：`online` = 列表中**任一** relay `is_connected()`（与 `RelayMode::Custom` 多 relay 的可用性直觉一致）；全部未连接为 `offline`；
- **事件触发**：聚合态**跳变**时广播 `FabricEvent::RelayOnline { url }`（取触发跳变的 relay；同时连上多个时取**配置序最小**者，不依赖 watcher 到达顺序）/ `FabricEvent::RelayOffline`；同一态内的 relay 间切换、last_error 变化不触发事件（避免噪声），但反映在快照里；
- **初始快照竞态**（评审 P1-10）：事件只承诺"订阅之后的跳变"；**初始状态必须经快照 API 获取**——chat 启动先调 `relayStatus()` 再订阅。**watcher 启动时的首个状态只更新快照缓存、不广播事件**（避免快照优先的消费方重复计数）；SDK `relayStatus()` 直接读缓存 + watcher 当前值，不等待；
- **生命周期**（评审 R2-P1-1 修正）：iroh 的 watcher 流只在**最后一个 Endpoint clone drop** 时断开，`Endpoint::close()` 不会结束它——因此 Fabric shutdown 流程 MUST 显式 `abort` watcher task 并 join 确认退出，然后才释放 endpoint；测试断言 shutdown 后无任务残留、无后续事件；
- **lastError 聚合规则**：内核在自身缓存中保存**带配置序号的候选列表**（不信任 watcher 返回顺序——iroh 不保证保留配置序），按序号显式排序后取**首个未连接且带 last_error 的 relay**（确定性）；全部已连接时为 null；
- **事件 payload 投影**：Rust 事件 `RelayOnline { url }` / `RelayOffline`；SDK 层投递的事件对象**必携带完整快照** `relay: RelayStatusJs`（非可选字段，d.ts 以判别联合表达），杜绝"relay 事件无 payload"；

### SDK

```ts
relayStatus(): Promise<{
  mode: "disabled" | "custom" | "n0";
  urls: string[];
  online: boolean | null;      // null <=> mode === "disabled"
  lastError: string | null;    // 最近一次连接错误（脱敏：仅错误类别+host，不含 URL 凭证段）
}>
```

事件（既有 `on()` 通道新增 type）：`relay-online` / `relay-offline`，payload 同快照结构。**快照优先、事件补充**的使用模式写入 SDK 文档。

### example chat

```
chat ready as <id> (~/.dweb-example)
relay: online (http://192.168.2.13:3340)
```

启动先快照；离线时输出 `WARNING: relay offline (last error: <category>) -- direct connections only; invites will fail until a relay is reachable`，`relay-online` 事件到达时打印一行恢复提示。

## D5 — 目录归属不匹配的独立错误

现状：`Roster::decode_persisted` 里 fabric 不匹配返回 `Corrupted { reason: "file is for fabric X, requested Y" }`——用户看到 "corrupted" 以为数据损坏（Windows 实测事故）。

**命名避让**（评审 P1-5）：`RosterError::WrongFabric { got, expected }` 已被 `redeem_verify` 用于"令牌 fabric ≠ 本名册 fabric"的跨事实语义，不可复用。新增专用变体：

```rust
#[error("data dir {path} belongs to fabric {stored}, but this operation targets fabric {requested}; use a fresh --data directory")]
DirFabricMismatch { path: PathBuf, stored: FabricId, requested: FabricId },
```

- FabricId 以短 hex 展示（**前 16 个 hex 字符**，冻结在 spec，避免实现漂移）；
- `decode_persisted` 的不匹配分支迁移到该变体；真损坏（magic/校验和/事实流解析失败）仍是 `Corrupted`；
- SDK `fabric_err` 将其映射为消息前缀 `[wrong-fabric]` 的英文文案，JS 层据此前缀设置 `err.code = "WRONG_FABRIC"`（napi Error 无自定义 code 通道，消息前缀是 v0.2 的务实约定，写入 SDK 文档）。

## D6 — example CLI 配置文件

路径：`~/.opendweb/config.json`（目录 0700、文件 0600；加载时若发现权限过宽，收紧并 WARNING；写入永远 tmp+rename 原子替换）。

```json
{
  "relay": "http://192.168.2.13:8787",
  "proxy": "auto",
  "data": "~/.dweb-example",
  "inviteTtlMs": 3600000
}
```

`relay` 值 schema：**单个字符串或字符串数组**（数组时全列表进入 `RelayConfig::Custom`，多 relay 选择/故障切换由 iroh 原生处理；**全部候选参与 D2 bootstrap 探测与解析，逐项合并去重，无首项特权**）。

### 优先级决策表（评审 P1-7 冻结）

| 项 | CLI flag | 环境变量 | 配置文件 | 默认 |
| --- | --- | --- | --- | --- |
| data | `--data` | `DWEB_DATA` | `data` | `~/.dweb-example` |
| relay | `--relay <url...>`（可多次） | `DWEB_RELAY` + `DWEB_RELAY_URLS` | `relay`（变参 `config set relay u1 u2` 写数组） | （disabled） |
| proxy | `--proxy auto|on|off` | `DWEB_PROXY` | `proxy` | `auto` |
| ttl | `--ttl <dur>` | - | `inviteTtlMs` | `3600000` |
| join timeout | `--join-timeout <dur>` | - | `joinTimeoutMs` | `30000` |

规则与边界：

- 优先级统一 **flag > env > file > default**；同项高优先级存在则低优先级整体失效（不逐字段合并）；
- `DWEB_RELAY` 取值 `disabled|custom|n0`：显式 `disabled` 时即使文件配了 `relay` 也**整体禁用 relay**；`custom` 时 URL 列表取 `DWEB_RELAY_URLS`（逗号分隔，**空项过滤后去重保序**；全空为配置错误）；**`DWEB_RELAY` 未设但 `DWEB_RELAY_URLS` 单独存在** → 视为隐式 `custom` + 该列表（显式 URL 意图明确）；`n0` 使用 iroh 官方默认 relay（https://relay.iroh.network，urls 为该值；bootstrap 不探测公网可用性，仅 relayStatus 反映状态）；**非法取值**（如 `DWEB_RELAY=foo`、`DWEB_PROXY=bar`）一律启动报错而非回退默认；`config set relay` 零个 URL 参数 → 报错列出用法；
- 环境变量**完全缺席**（`DWEB_RELAY` unset）而文件 `relay` 存在 → `custom` + 文件列表；两者皆无 → `disabled`（0.1.0 行为，受 D3 门保护）；
- `config set/unset` 只改文件；`config list` 输出合成后的有效值 + 每项来源标注（flag/env/file/default）；
- **非法配置文件**（JSON 解析失败 / 未知键 / 值类型或值域错误）：硬错误退出（路径 + 行列信息），不静默忽略；`config unset <未知键>` 同样报错；
- 已知键集冻结：`relay | proxy | data | inviteTtlMs | joinTimeoutMs`（未知键 = 配置错误，前向兼容靠"只增键"承诺）；
- **权限**：unix 目录 0700 / 文件 0600；Windows 上该语义为尽力而为（NTFS 无等价 POSIX 位），文档注明"Windows 下依赖用户 profile 目录 ACL，不额外模拟"。

## D7 — 代理所有权（评审 R2 收窄：只定所有权映射，决策时序在 D2 状态机）

### 事实基础（已在 iroh 1.1.0 源码实证）

- iroh endpoint 的 relay 客户端**不读环境变量**：`Endpoint::builder()` 默认 `proxy_url: None`（不走代理）；显式 `.proxy_url(url)` 或 `.proxy_from_env()`（读取顺序 `HTTP_PROXY > http_proxy > HTTPS_PROXY > https_proxy`）才走代理；
- 因此"剥 process.env 就能控制 relay 连接"不成立；环境变量只影响 CLI 层 HTTP 请求（services.json 解析、探测），且经 D2 的显式 policy 决策；
- QUIC 数据面（直连 + NAT 穿透）永远不经 HTTP 代理，这是 iroh 事实行为，写入 README。

### 代理所有权契约

```
FabricConfig 新增:
  http_proxy: HttpProxyConfig
  enum HttpProxyConfig { None, FromEnv, Url(String) }   // Default = None
映射:
  None    -> builder 不设 proxy（iroh 默认直连）
  FromEnv -> builder.proxy_from_env()（顺序同上，由 iroh 冻结）
  Url(u)  -> builder.proxy_url(u)（SDK 专属形态；非法 URL 构造报错）
SDK: FabricOptions.httpProxy: "none" | "from-env" | { url } （缺省 "none"）
```

auto/on/off 的**决策时序与探测算法全部在 D2 状态机**（Fabric 构造之前完成，endpoint 只建一次）；本节只冻结所有权映射与 iroh 的 env 语义。多 relay 择优维持 R1 决议：全量下发 `RelayConfig::Custom`，iroh 原生选择与故障切换，不自研选路。

## D8 — CLI 参数健壮性

- `--opt value` 与 `--opt=value` 双形式（语义完全等价，测试成对断言）；布尔 flag（`--allow-relayless`）；
- 路径类值（`--data`、`config set data`）做 `~` 展开（`os.homedir()`），引号由 shell 处理、CLI 不再做二次剥离；
- 未知选项：`error: unknown option --foo`（列出该子命令已知选项）退出码 2；
- 统一解析器替换现有手写 `opt()`/`positionals` 过滤逻辑（`args.mjs` 模块，纯函数可单测）。

## D9 — TTL 默认与格式（评审 P1-11 补边界）

- 默认 `10m -> 60m`；`--ttl` 接受 `30s|15m|2h|1d` 等后缀与裸数字（=ms，0.1.0 兼容）；
- **值域**：解析结果必须 `1000 <= ttl_ms <= 30d(2592000000)`；`0`、负数、超上界均为硬错误（提示值域）；后缀解析溢出（如 `999999999d`）按超上界报错而非回绕；
- `config` 的 `inviteTtlMs` 同值域校验（config set 时即校验）；
- 内核 ttl_ms 语义不变（内核不设下限，边界属 CLI/config 层）。

## D10 — 全 ASCII 输出纪律

`opendweb`、`dweb-example` 全部用户面字符串（横幅、WARNING、帮助、错误）**码位 < 128**；样例见 D1（`*`/`>` 代替 Unicode 符号，`--` 代替 em dash）。**动态值转义冻结**：输出中的动态内容（路径、URL、错误原因等用户/系统数据）若含非 ASCII 字节，先按 UTF-8 编码，再逐字节以**小写十六进制** `\xNN` 转义后输出（**控制字符**（<0x20 与 0x7F，含换行）同样 `\xNN` 转义，保证一行一错误）——全输出恒满足 ASCII 断言。测试断言输出匹配 `^[\x00-\x7F]*$`。代码注释维持各文件现状。README 面向 npm 公开受众，关键段落同步英文。

## D11 — join 可诊断失败（评审 R3：适用边界 + 探针归因）

原始事故的直接受害者是 join 侧。契约：

### 适用边界（评审 R3 明确）

8 码**只覆盖 join 的网络工作流**（解码/过期/目录归属/地址规范化/connect/redeem）。以下错误**豁免**于 8 码，按其原生变体直接透出（CLI 以 `error[<kebab-variant>]` 呈现、退出码 1，不冒充 join 码）：数据目录与身份错误（`MissingIdentity` 等）、名册真损坏（`Corrupted`）、名册 merge/持久化 IO 错误。即"join 失败必为 8 码"仅指网络工作流；本地数据面错误保持既有语义（与 roster delta 的"真损坏仍 Corrupted"一致）。

### 总时限与范围

`Fabric::join` 的 deadline **包住整个 join 网络工作流**（connect + redeem 兑换应答），到期取消等待并关闭已建立的连接，归类超时错误。默认 **30s**，`FabricConfig.join_timeout_ms` 可配（值域 1s–10min）。产品入口：CLI `--join-timeout <dur>`（时长后缀同 D9）、config 键 `joinTimeoutMs`、优先级 flag > file > 默认（无 env 项）。

### relay 探针（评审 R4：适用条件收窄 + 全语义冻结）

iroh 公开 `ConnectError` 无稳定 relay 归因字段——**不解析 iroh 错误内部**，改用内核自做的**显式 TCP 探针**。为避免与代理路径不一致的误报（R4-P0-2），**RELAY_OFFLINE 仅在以下全部条件成立时适用**：

1. 令牌含 relay URL 且**无直连地址**；
2. 生效代理策略为 `none`（无代理时直连探针才与 iroh 实际路径一致；有代理或令牌含直连地址的立即错误一律 `DIAL_FAILED`，附原始原因）。

**探针语义冻结**（transport-only，确定性可注入）：

- 对 relay URL 的 socketaddr 做 `TcpStream::connect`；域名先解析，**取解析器返回的首个地址**（A/AAAA 按系统序）；URL 无显式端口时按 scheme 取默认端口（http=80/https=443）；
- **DNS 解析计入 2s 预算**；连接成功即探针成功——**探针只证明 TCP 传输可达，不证明 relay 协议可用**（TCP 通而协议死的情形归 DIAL_FAILED，这是有意的 transport-only 语义）；
- **计时关系**：探针在分类时点触发（connect 立即错误或 deadline 到期后），属诊断性追加，最多使 join 总耗时超出 `join_timeout_ms` 2 秒——此上界写入文档；
- 测试注入（F 内部提供可替换的探针函数句柄）：关闭端口（127.0.0.1:9，秒拒=探针失败）、不存在的域名（DNS 失败=探针失败）、本地 TCP listener 接受后立即关闭（探针成功、协议死 → DIAL_FAILED 构造）、在线 relay + 无 issuer + 短 deadline（探针成功 → DIAL_TIMEOUT 附注 issuer likely offline 构造，无墙钟依赖）。

### 分类总函数（有序、互斥、穷尽；实现按此顺序判定）

```
输入: token_str, data_dir, join_deadline
 1. 解码失败（格式/签名/版本/保留位）            -> TOKEN_INVALID
 2. is_expired(now)                              -> TOKEN_EXPIRED
 3. 令牌地址规范化：relay_url 非空但不可解析为 URL，
    或任一直连地址不可解析为 SocketAddr           -> TOKEN_INVALID（附原因）
 4. 本地数据面加载（打开目录/名册）：缺身份/真损坏/读写 IO 失败
    -> 豁免透出（[missing-identity]/[corrupted]/[roster-io]）
 5. 既有目录名册 fabric != 令牌 fabric            -> WRONG_FABRIC (DirFabricMismatch)
 6. relay_url 为空且直连地址为空                  -> NO_REACHABLE_PATH（拨号前，零等待）
    [令牌自身错误(1/2/3) -> 本地数据面豁免(4) -> 目录归属(5) -> 空路径(6) -> 网络工作流；
     冲突输入唯一归类：坏令牌+错目录 => TOKEN_INVALID；空路径令牌+损坏名册 => [corrupted]]
 7. deadline 内执行 connect+redeem：
    a. connect 立即错误（拒绝/DNS/协议）：
       探针适用条件全部成立（无直连地址+策略 none）且探针失败 -> RELAY_OFFLINE
       其余一切立即错误                                   -> DIAL_FAILED（附原因）
    b. redeem 阶段失败：
       结构化拒绝 RedeemErrorKind                 -> TOKEN_CONSUMED / TOKEN_INVALID
       非结构化失败（连接中断/IO/坏帧/事实解码/
       错误帧段短读[含 EOF 不完整帧]）           -> DIAL_FAILED（附原因）
    c. deadline 到期                             -> DIAL_TIMEOUT（附注按探针结果，
                                                     探针不适用时附注原始错误类别）
    d. 兑换通道内层 5s 超时（REDEEM_DEADLINE）      -> DIAL_TIMEOUT（附注 redeem timeout，
                                                     不落入非结构化失败泛化分支）
       [等值边界：joinTimeoutMs <= 5s 时外层 deadline 拥有唯一结果（附注 join timeout，
        不追加 redeem 附注）；> 5s 时内层先到。两路都关闭连接]
```

**RELAY_OFFLINE 判据**：上述显式 TCP 探针（错误端点 == 令牌 relay 候选），**不依据**加入方 home relay 状态（观测量错对象），**不解析** iroh 错误内部（无稳定归因字段）。

**兑换拒绝的 wire discriminant**（决策摘要；机器可执行 grammar 唯一权威 = `contracts/redeem-err.fixtures.json`——外层帧/记录格式/reduction/issuer 生产映射全部在该 JSON 冻结，matrix 帧块仅作索引）：记录嵌于既有 `REDEEM_ERR(0x14)` 外层帧 payload（外层 `u32_be(1+payload_len)+type+payload` 与 session.rs 逐字节一致，公共读写器零改动，REDEEM_OK 沿用）；记录 `kind(1B)+len(1B,0..255)+payload`；多记录 reduction fail-closed（恰一条 Consumed -> TOKEN_CONSUMED，多条 -> TOKEN_INVALID 完整消费不位移，未知 kind 按 Other("unknown-kind") 参与判定）。映射：`Consumed -> TOKEN_CONSUMED`；`NotRoot / BadPoP / Other -> TOKEN_INVALID`（原因附消息，长度同限）。既有 `redeem_verify` 的 `RosterError::WrongFabric`（issuer 侧令牌/名册不符）经 `Other` 透出为 TOKEN_INVALID——`WRONG_FABRIC` 码**专属于**目录归属不匹配（步骤 5）。协议文件（session 帧编解码）属 Batch F 所有权，测试覆盖（以 C0 外层 fixture——含 0x14 外层头的完整字节向量——为基准）：各段短读（含外层 payload 末尾不完整记录）、0/255 边界载荷、非 ASCII、未知值、payload 内额外完整记录按新记录、Other 零长、REDEEM_OK 不受影响。

### SDK/CLI 呈现

- SDK 错误消息以 `[<kebab-code>]` 前缀标识（如 `[dial-failed]`），JS 侧派生 `err.code = <SCREAMING_SNAKE>`；前缀集合在 contracts/error-matrix.md 冻结（**8 码**，含 DIAL_FAILED）；**豁免的本地数据面错误同样打 kebab 前缀透出**（`[missing-identity]`、`[corrupted]`、`[roster-io]`，JS 侧派生同名 SCREAMING_SNAKE code），不占用 8 码；
- example CLI：join 失败打印 `error[join/<code>]: <可操作建议>`（网络工作流 8 码）或 `error[<variant>]: ...`（豁免错误）到 stderr，退出码 1；**8 码每个至少一个可重复构造的确定性测试场景**（过期用固定过去时间令牌构造、relay 探针用关闭端口注入，均无墙钟依赖），owner 与测试文件见 error-matrix。

## D12 — 实施编排（评审后新增 Batch C0）

### 批次与文件所有权

| 批次 | owner | 文件所有权 |
| --- | --- | --- |
| **C0 契约冻结** | **ZCode 亲写**，先于一切 | `openspec/changes/.../contracts/`：client-sdk 完整 d.ts 契约、services.json fixture、错误码矩阵、事件 payload 类型 |
| **S（server）** | 子代理 | `crates/dweb-server/**`、`packages/opendweb/**`、`packages/server-binary/**`、`docker/**` |
| **E（example）** | 子代理 | `packages/example/**` |
| **F（fabric/SDK）** | 子代理 | `crates/dweb-fabric/**`、`packages/client-sdk/**` |

**唯一 owner 文件**（禁止子代理触碰，变更需求写进报告由 ZCode 落盘）：根 `package.json`、**锁文件**（含 Batch E 提议的 `undici` 依赖——E 在 `packages/example/package.json` 提出版本，lockfile 由 ZCode 统一更新）、`README.md`、各包 `version` 字段、生成产物 `index.d.ts`（由 F 报告 API，ZCode 校对落盘）、**两份主规格勘误文件**（`openspec/specs/sdk/node/spec.md`、`openspec/specs/example-app/spec.md` 的旧包名修正——后者 `@dweb/client-sdk` 残留一并列入 C0.3，由 ZCode 执行）。

**主规格包名勘误**：`openspec/specs/sdk/node/spec.md` 与 `openspec/specs/example-app/spec.md` 的 `@dweb/*` 是旧名残留（实际包 `@jixo/opendweb-*`），由 ZCode 在本 change 落地时一并修正。

### 并行依赖图

```
C0 (ZCode) ──> S ──┐
             ├─────┼──> ZCode 整合验收（4.x）──> Codex 复审 ──> 收尾
             ──> F ─┘
   E 依赖 C0 的 d.ts 契约与 services.json fixture（开发期对着契约编码，
   不需要 F 的二进制存在）
```

**E 的完成边界**（评审 R2 拆分）：E 的 e2e 仅覆盖**不依赖 S/F 新产物**的部分（args/config 纯函数 + `httpGet`/解析的 mock 测试——mock 掉 services.json 响应与 Fabric 构造）；依赖真实 server（services.json 实测）与真实 SDK（invite 三参、错误码、relayStatus）的 e2e 属 **ZCode 4.1 整合期联测**，不是 E 子代理的完成条件。

### e2e 测试纪律（子代理通用）

- 每个用例**自起**所需服务：spawn `dweb-server`（随机空闲端口），用例结束 `kill` + 等待退出，禁止复用常驻进程、禁止绑定固定端口；
- 断言用输出/HTTP 探测，不 sleep 轮询超过必要（有界重试）；
- 子代理只跑**定向**测试（`cargo test -p <crate> --lib <filter>`、`node --test <file>`）；全量 `cargo test/clippy --workspace -j2`、跨包 e2e 由 ZCode 在 herdr pane 受控执行——这是批次"完成报告"的边界，不是子代理的完成条件。

### 测试策略

- **S**：rust 单测（services.json 的 Host 派生/校验拒绝/回退、disabled 条目、GET / 摘要）；opendweb mjs 测试（横幅全 ASCII、Network 枚举、`--gateway`/别名）；server-binary e2e（随机端口起服务断言 /services.json）。
- **E**：`args.mjs`/`config.mjs`/`proxy.mjs`/`relay-resolve.mjs` 纯函数单测（双形式等价、决策表逐行、非法 JSON、数组 relay、探测矩阵 mock `httpGet`）；e2e（config 文件驱动 relay、无 relay invite 报错、`--allow-relayless` WARNING、wrong-fabric 文案、TTL 后缀与越界、join 各错误码、横幅/错误全 ASCII）。
- **F**：rust 单测（invite 门三分支 + advertise_addrs 校验、DirFabricMismatch 变体与消息、watcher 聚合/跳变/快照、join deadline 与 NO_REACHABLE_PATH 秒败）；集成（好 relay → RelayOnline；disabled → 无事件且 status.online=null）；SDK mjs（第三参透传、relayStatus 三态、事件透传、错误码前缀）。

## 已否决的替代方案

- **relay 并入 gateway 单端口**：iroh RelayServer 不暴露可组合的 Service 面；协议嗅探分发（H2 prior-knowledge vs WS upgrade）脆弱且不可维护。v0.2 以 services.json 契约替代，若上游开放组合面再评估。
- **invite 空 relay 仅警告不拒签**：实测事故的直接根因就是"签了但没人看警告"；且一次性进程 + issuer-online 语义下该令牌必然报废，拒签是唯一诚实行为。逃生阀已保留给显式直连配置的库用户。
- **配置文件放 data 目录内**：config 管理的是机器级连接偏好（relay/proxy），跨 fabric 共享；data 目录是单 fabric 的身份+名册，语义不同，混放会让"换目录加入新 fabric"丢失网络配置。
- **自研多 relay 选路**：iroh 原生支持 relay 列表的选择与故障切换，应用层重排只会与内核状态打架；auto 探测仅服务代理决策与死 relay 提示（评审 P1-8 决议：缩小为"全量下发 + 原生择优"）。
- **JS 层剥 env 控制一切代理**：iroh 不读 env（实证见 D7）；该方案对 relay 连接无效（评审 P0-1 决议：显式 HttpProxyConfig 所有权）。
