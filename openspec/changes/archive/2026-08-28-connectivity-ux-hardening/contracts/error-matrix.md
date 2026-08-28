# 错误矩阵（Batch C0，ZCode 冻结；对应 tasks 0.2）

> Batch F 的内核错误归类、SDK 前缀映射与 Batch E 的 CLI 文案都以此表为唯一依据。
> CLI 输出格式：`error[join/<code>]: <建议>`（stderr，退出码 1）；invite 侧 `error[invite/<code>]: <建议>`。
> 全部文案 ASCII。

## 适用边界（R3 冻结）

8 码只覆盖 join 的**网络工作流**（解码/过期/目录归属/地址规范化/connect/redeem）。本地数据面错误**豁免**，按原生变体 kebab 前缀透出（同样退出码 1，不冒充 join 码）：

| 豁免错误 | 透出前缀 | 说明 |
| --- | --- | --- |
| MissingIdentity | `[missing-identity]` | 目录缺身份 |
| RosterError::Corrupted | `[corrupted]` | 名册真损坏（magic/校验和/事实流） |
| 名册 merge/持久化 IO | `[roster-io]` | join 成功后写盘失败 |

## relay 探针（RELAY_OFFLINE / DIAL_TIMEOUT 附注的判据）

**适用条件（全部成立才用探针分类 RELAY_OFFLINE，否则立即错误一律 DIAL_FAILED）**：

1. 令牌含 relay URL 且**无直连地址**；
2. 生效代理策略为 `none`（直连探针与 iroh 实际路径一致；有代理或令牌含直连地址时不归因 relay）。

探针：对 relay URL 的 socketaddr 做有界 **2s** `TcpStream::connect`（域名先解析、取解析器首个地址、DNS 计入预算；无显式端口按 scheme 默认 80/443）。**transport-only**：TCP 成功只证明传输可达，不证明 relay 协议可用（协议死归 DIAL_FAILED，有意语义）。探针在分类时点触发，属诊断追加，join 总耗时可超出 `join_timeout_ms` 最多 2 秒（文档写明）。

- connect 立即错误 + 探针失败 -> RELAY_OFFLINE；探针成功 -> DIAL_FAILED；
- deadline 到期 + 探针成功 -> DIAL_TIMEOUT 附注 `issuer likely offline`；探针失败/不适用 -> 附注原始错误类别。

F 提供内部可替换探针函数句柄。确定性注入集（无墙钟）：关闭端口（127.0.0.1:9 秒拒=探针失败）、不存在域名（DNS 失败=探针失败）、本地 listener 接受即关（探针成功+协议死 → DIAL_FAILED）、在线 relay + 无 issuer + 短 deadline（探针成功 → DIAL_TIMEOUT 附注构造）。

## join 分类总函数（有序、互斥、穷尽；与 design D11 一致）

```
 1. 解码失败（格式/签名/版本/保留位）                 -> TOKEN_INVALID
 2. is_expired(now)                                   -> TOKEN_EXPIRED
 3. 令牌地址规范化失败（relay_url 非空但坏 / 直连地址坏）-> TOKEN_INVALID（附原因）
 4. 本地数据面加载失败（缺身份/真损坏/读写 IO）          -> 豁免透出（missing-identity/corrupted/roster-io）
 5. 既有目录名册 fabric != 令牌 fabric（DirFabricMismatch）-> WRONG_FABRIC
 6. relay_url 为空且直连地址为空                        -> NO_REACHABLE_PATH（拨号前，零等待）
    [顺序: 令牌错误(1/2/3) -> 本地豁免(4) -> 目录归属(5) -> 空路径(6) -> 网络;
     坏令牌+错目录 => TOKEN_INVALID；空路径令牌+损坏名册 => [corrupted]]
 7. deadline（默认 30s，包住 connect+redeem）内：
    a. connect 立即错误：探针适用条件全部成立且探针失败   -> RELAY_OFFLINE
                           其余一切立即错误              -> DIAL_FAILED
    b. redeem 阶段失败：结构化拒绝（见下）              -> TOKEN_CONSUMED / TOKEN_INVALID
                         非结构化（连接中断/IO/坏帧/事实解码/
                         错误帧段短读[含 EOF 不完整帧]）        -> DIAL_FAILED（附原因）
    c. deadline 到期                                   -> DIAL_TIMEOUT（附注按探针结果）
    d. 兑换通道内层 5s 超时                              -> DIAL_TIMEOUT（附注 redeem timeout）
       [等值边界: joinTimeoutMs <= 5s 时外层 deadline 拥有唯一结果（附注 join timeout，
        不追加 redeem 附注）；> 5s 时内层 5s 先到（附注 redeem timeout）。两路都关连接]
```

`RedeemErrorKind` **完整帧格式**（F 在会话层实现）：

```
wire grammar（外层帧/记录格式/多记录 reduction/issuer 阶段映射/原因规范化算法）的**唯一机器权威 = contracts/redeem-err.fixtures.json**（十二例结构化向量 + issuerMapping 阶段穷尽表），本文件不重复其字段值，仅索引：

- 十二例 case 名：canonical / other / unknown-kind / two-records / len-255-other / inner-truncated / zero-len-other / outer-header-truncated / outer-payload-truncated / not-root / bad-pop / non-ascii-payload
- 每例断言四字段：expectedReaderOutcome（read_frame 层）/ expectedRecords（{kind:number, payloadHex, presented}）/ expectedResult（join 侧）/ expectedViolation
- reduction 摘要：恰一条 Consumed -> TOKEN_CONSUMED；恰一条其它已知 kind -> TOKEN_INVALID；多条 -> TOKEN_INVALID（完整消费不位移）；未知 kind 按 Other("unknown-kind") 参与判定
```

## 码表（8 码 + invite 1 码）

> E 列语义（与 D12 批次边界一致）：**E mock** = E 子代理用 mock 完成；**4.1** = 依赖真实 S/F 产物的联测，owner 是 ZCode 整合期，不是 E 的完成条件。

| code | 消息前缀（kebab） | err.code（JS 派生） | CLI 建议（ASCII） | F 测试 owner | E mock / ZCode 4.1 |
| --- | --- | --- | --- | --- | --- |
| MISSING_IDENTITY（豁免） | `[missing-identity]` | MISSING_IDENTITY | `data dir has no identity; run init first` | rust 单测（空目录 join） | E mock 前缀派生；4.1 e2e |
| CORRUPTED（豁免） | `[corrupted]` | CORRUPTED | `roster file is corrupted; see <path>` | rust 单测（篡改校验和） | E mock 前缀派生 |
| ROSTER_IO（豁免） | `[roster-io]` | ROSTER_IO | `failed to read/write roster; check disk and permissions` | rust 单测（写盘失败注入） | E mock 前缀派生 |
| WRONG_FABRIC | `[wrong-fabric]` | WRONG_FABRIC | `data dir <path> belongs to fabric <stored16> but the token is for fabric <wanted16>; use a fresh --data directory` | rust 单测（目录 A + 令牌 B） | E mock 前缀派生；4.1 e2e：目录 A + 令牌 B |
| NO_REACHABLE_PATH | `[no-reachable-path]` | NO_REACHABLE_PATH | `the token carries no relay URL and no direct addresses (likely signed without a relay); ask the inviter to re-sign with a relay configured` | rust 单测（空路径令牌，断言零拨号） | E mock 前缀派生；4.1 e2e：秒败 + stderr 格式 |
| RELAY_OFFLINE | `[relay-offline]` | RELAY_OFFLINE | `configured relay(es) are unreachable; check the server or network` | rust 集成（relay URL 指向 127.0.0.1 关闭端口，探针秒拒，确定性） | E mock（Fabric mock 断言映射） |
| DIAL_FAILED | `[dial-failed]` | DIAL_FAILED | `could not reach the issuer: <reason>; verify network paths and direct addresses` | rust 单测（探针成功路径的立即错误注入 + redeem 非结构化中断） | E mock 同上 |
| DIAL_TIMEOUT | `[dial-timeout]` | DIAL_TIMEOUT | `issuer did not respond within <N>s (relay online: issuer likely offline; invites must be redeemed while the inviter is running)` | rust 单测（短 deadline + 在线 relay 无 issuer） | E mock 前缀派生；4.1 e2e：短 --join-timeout |
| TOKEN_CONSUMED | `[token-consumed]` | TOKEN_CONSUMED | `this invite token was already used; invites are single-use` | rust 集成（二次兑换） | E mock 前缀派生；4.1 e2e：二次 join |
| INVITE_WITHOUT_RELAY（invite） | `[invite-without-relay]` | INVITE_WITHOUT_RELAY | `no relay configured; set one via 'config set relay <url>' or pass --allow-relayless for an out-of-band reachable path` | rust 单测（三分支） | E mock 前缀派生；4.1 e2e：无 relay invite |
| TOKEN_EXPIRED | `[token-expired]` | TOKEN_EXPIRED | `the invite token has expired; ask the inviter for a new one` | rust 单测（**固定过去时间构造**，无墙钟等待） | E mock 前缀派生；4.1 e2e：固定构造 |
| TOKEN_INVALID | `[token-invalid]` | TOKEN_INVALID | `the invite token is malformed or has a bad signature; ask the inviter for a new one` | rust 单测（坏签名 + 地址非法两种构造）+ mjs 前缀断言 | E mock 前缀派生；4.1 e2e：篡改令牌串 |

## bootstrap 探测决策表（E 的 proxy.mjs 单测，mock httpGet；按候选集合判定，无顺序依赖）

| 输入（proxy=auto） | 直连探测 | 经代理探测 | policy | 附注 |
| --- | --- | --- | --- | --- |
| 全部候选直连收到完整响应 | - | - | none | - |
| 部分候选直连可达，其余直连失败 | 失败者经代理全部失败 | none | **最终：整体退出码 1**（数组任一项解析失败即整体失败）；可达候选不救回；针对失败项输出 both-fail WARNING（`relay unreachable both directly and via proxy: <url>`） |
| 部分候选直连可达，其余直连失败 | 失败者经代理任一成功 | from-env | 全部候选统一经代理解析 |
| 全部候选直连失败（连接错误/超时） | - | 任一候选经代理收到完整响应 | from-env | - |
| 全部候选直连失败 | - | 全部失败 | none | WARNING：`relay unreachable both directly and via proxy; check the server`（仅当代理实际尝试并失败） |
| 全部候选直连失败 | - | 未尝试（无 env 代理） | none | WARNING：`relay unreachable directly and no proxy configured` |
| 空候选列表（disabled/空配置） | 不发请求 | 不发请求 | none | 无探测 |
| n0 模式 | 不探测（公网可用性非本机配置问题） | 不探测 | none | urls 恒为官方默认；状态经 relayStatus 反映 |
| proxy=on 且环境无有效代理 URL | - | - | 配置错误 | `error: proxy=on but no usable proxy in environment`（退出码 1） |
| 代理可达但统一代理解析返回 401/5xx | - | - | from-env（该行前提：直连失败、代理可达） | **最终：整体退出码 1**；该候选硬错误（`error: gateway <url> unreachable (http <code>)`）；数组任一项解析失败即整体失败，可达候选不救回 |
| legacy relay（404 也算完整响应） | 404 | - | none | 该 URL 判定 legacy 裸 relay |
| legacy 与 gateway 候选混合 | 按各自类型独立判定 | - | 按上面各行合成 | 每项独立判定类型（404/非JSON→legacy；200+JSON→gateway），结果列表合并去重 |

注 1：**可达性 = 收到任何完整 HTTP 响应**（含 401/407/500——只证明传输路径通；407 即"代理路径可达"）——iroh relay server 对未知路径回 404，这正是 legacy 探测方式；只有连接错误/超时算不可达。可用性判定（地址解析阶段对 401/5xx 硬错误）晚于传输判定。
注 2：`enabled:true, url:null` 的服务条目视同禁用（WARNING + 跳过）。

## chat / config 路径（E 实现，非内核）

| 场景 | CLI 行为 |
| --- | --- |
| relay 离线（chat 启动快照） | `WARNING: relay offline (last error: <category>) -- direct connections only; invites will fail until a relay is reachable` |
| services.json relay disabled | `WARNING: gateway reports relay disabled; running without relay` |
| gateway 超时/5xx/401（非 404、非 JSON） | `error: gateway <url> unreachable (timeout|http <code>)`（退出码 1，无 fallback） |
| 配置文件非法 | `error: invalid config file <path>: <reason>`（退出码 1） |
| DWEB_RELAY=custom 且 DWEB_RELAY_URLS 缺失/全空（空项过滤后） | `error: DWEB_RELAY=custom requires DWEB_RELAY_URLS`（退出码 1） |
| DWEB_RELAY 未设但 DWEB_RELAY_URLS 单独存在 | 隐式 custom + 该列表（空项过滤、去重保序） |
| DWEB_RELAY_URLS 逗号空项 | 过滤空项；全空按上一行报错；非全空去重保序生效 |
| config set relay 零参数 | `error: config set relay requires at least one URL`（退出码 1，不写入） |
| config set relay 语法非法项 | `error: invalid relay URL: <v>`（退出码 1，不写入） |
| config set relay 探测不可达 | 仍写入 + 非零退出 + 逐项 `saved but unreachable: <url> (<reason>)` |
| DWEB_RELAY/DWEB_PROXY 非法值 | `error: invalid DWEB_RELAY value: <v> (expected disabled|custom|n0)`（退出码 1） |
| 未知选项 | `error: unknown option --<name> (known: ...)`（退出码 2） |
| TTL 越界 | `error: --ttl out of range (1s..30d)`（退出码 1） |

## 验收口径

- F 与 E 的最低覆盖 = **上表每行各自的 owner 列所指测试**（不再是"抽样"）；RELAY_OFFLINE/DIAL_FAILED 在 E 侧允许 mock 映射断言（真实网络路径归 F 的 rust 集成）；
- 依赖真实 server（S 产物）或真实 SDK（F 产物）的 E e2e 归 ZCode 4.1 整合期联测，不属 E 子代理完成条件。
