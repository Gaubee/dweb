# connectivity-ux-hardening 第九轮评审

评审日期：2026-08-28

评审范围：`openspec/changes/connectivity-ux-hardening/` 的 `proposal.md`、`design.md`、`tasks.md`、五个 delta、C0 contracts，并对照 `openspec/specs/` 既有规格和当前 `crates/dweb-fabric/src/session.rs`。本轮只评审文档，不修改 change 或产品代码。

验证：`openspec validate connectivity-ux-hardening --strict` 通过。该命令只能证明 OpenSpec 结构和语法有效，不能证明 C0 wire fixture 正确，也不能证明新协议能被现有会话读写器消费。

## 结论与评分

**6.0/10（相对第八轮 8.1，-2.1），不放行。**

r9 在文档层补齐了许多上一轮缺口：RedeemErrorKind 被声明嵌入 `REDEEM_ERR`、错误码和本地豁免顺序更加明确、配置矩阵和告警字段更完整，bootstrap 代理覆盖语义也保持无环。但本轮新增的“既有外层帧”定义与仓库当前实际 framing 不一致，权威 fixture 自身也有长度错误和未标记的冲突向量。因此 F 无法按 C0 实现一个可接入现有兑换通道的编解码器；这不是 strict validate 能发现的文档问题，而是 P0 wire 阻塞。

## 阻塞问题

### P0-1：r9 的外层 framing 与既有会话协议不一致

r9 在 `design.md:415`、`contracts/error-matrix.md:54-56`、`contracts/redeem-err.fixture.hex:2` 规定外层为：

```text
type(1B) + len(2B, BE) + payload
```

但当前既有实现 `crates/dweb-fabric/src/session.rs:70-104` 明确是：

```text
u32 BE length(type + payload) + type(1B) + payload
```

`write_frame()` 先写 4 字节长度再写类型；`read_frame()` 先读取 5 字节头，把前 4 字节当长度。`REDEEM_ERR` 只是类型值 `0x14`（`session.rs:52-60`），joiner 仍通过同一个 `read_frame()` 消费错误响应（`session.rs:233-238`）。

以 r9 的 canonical 向量 `14 00 03 00 00` 为例，现有读者会把 `14 00 03 00` 解释成长度 `0x14000300`，立即返回 `FrameTooLarge`，甚至不会读取 `0x14` 类型。反向地，现有 writer 对空 `Consumed` 记录会输出：

```text
00 00 00 03 14 00 00
```

所以“外层结构不变、REDEEM_OK 沿用既有格式”与实际代码及新 fixture 不能同时成立。若 F 改写公共 `read_frame/write_frame` 为 1+2 字节头，HELLO、REDEEM_INTENT、CHALLENGE、PROOF、REDEEM_OK 和常规会话也会一起改变；若只给 REDEEM_ERR 增加另一种头，则必须定义版本/识别边界和迁移协议，当前 change 没有。

**可操作修订：**二选一并在 C0、session delta、D11、tasks 3.4/3.5 只保留一个规范：

1. 推荐保留现有协议，统一写成 `u32-be(len(type+payload)) + type + payload`，并用带 4 字节长度的完整 fixture；或
2. 有意替换外层 framing，同时更新公共 frame reader/writer、`REDEEM_OK`、32 KiB 限制计算、主 session 规格和兼容/迁移边界，不能再称为“既有格式不变”。

### P0-2：权威 `redeem-err.fixture.hex` 不是自洽的可执行向量集

fixture 声明自己是“权威 fixture”（第 1 行），但按其自称的 `type + u16 payload-len + payload` 计算：

| case | 声明长度 | header 后实际字节 | 问题 |
| --- | ---: | ---: | --- |
| canonical `1400030000` | 3 | 2 | 外层长度多 1；记录本身仅 `00 00` |
| other | 10 | 10 | 长度自洽 |
| unknown `1400077F0461626364` | 7 | 6 | 外层长度多 1 |
| two-records | 12 | 12 | 长度自洽 |
| truncated `14000503046E6F` | 5 | 4 | 外层本身先短读，不能单独证明“完整外层内的记录短读” |
| zero-len | 2 | 2 | 长度自洽 |

此外第 6 行 `14 00 15 00 02 'i'` 含非 hex 的 `'i'`，并与第 9 行的“实际向量”冲突；它没有被标为历史注记。一个实现可能解析第 6 行，另一个只解析第 9 行，违反 C0 “权威 fixture”定位。

**可操作修订：**删除冲突的伪向量，或明确标为非规范历史；每个 case 只保留一条可机器解析的连续 hex。修正长度后分别提供：完整外层内的 inner-record 短读，以及外层 header/payload 自身 EOF 短读。fixture 应额外冻结 `expectedRecords` 和最终 join code，避免测试只能凭注释推断。

### P1-1：多记录 payload 的最终 join 归类没有冻结

r9 允许一个 `REDEEM_ERR` payload 内有多条记录，且 fixture `two-records` 是 `Consumed` 后跟 `Other("not-root")`（`fixture:19-21`）。但 `design.md:415`、matrix `:65` 和 session delta `:35,77-80` 只定义单个 kind 的映射：`Consumed -> TOKEN_CONSUMED`，其它 -> `TOKEN_INVALID`，没有定义多个记录同时出现时的 reduction：

- 第一条优先；
- 任一非 Consumed 即 invalid；
- 任一 Consumed 即 consumed；
- 多条记录一律视为协议/令牌无效；或
- 仅保存记录列表，交给上层另行决定。

上述输入会直接影响 `TOKEN_CONSUMED` 与 `TOKEN_INVALID`，因此 `two-records` 目前只能测试“解析不位移”，不能测试稳定的 join 结果。

**可操作修订：**冻结一个 fail-closed 的 reduction 规则，并把结果写入 fixture、matrix 和 session scenario。一个可行选择是“只有恰好一条 `Consumed` 才归 `TOKEN_CONSUMED`；其它多记录组合归 `TOKEN_INVALID`，但仍完整消费 payload”，也可以选择其它规则，但必须唯一。

### P1-2：固定兑换 5s 与可配置 join deadline 的映射未定义

既有 session 规格规定兑换通道自连接建立起最多 5s（`openspec/specs/fabric/session/spec.md:41-53`），当前实现也有 `REDEEM_DEADLINE = 5s`（`session.rs:18-20,211,256`）。r9 D11 又要求 `join` 的默认 30s、可配置 1s-10min deadline 包住 connect+redeem，并把 deadline 到期归 `DIAL_TIMEOUT`（`design.md:369-371,401-410`）。

若连接已建立但 issuer 在 redeem 阶段 5s 内不回应，当前内层 timeout 返回 `redeem deadline exceeded`；D11 同时把 redeem 非结构化失败归 `DIAL_FAILED`，却没有说明该内层 timeout 是 `DIAL_TIMEOUT`，还是在 30s join deadline 前作为 `DIAL_FAILED` 结束。这样同一个“issuer 在线 relay、兑换无响应”场景仍可能得到两个稳定码。

**可操作修订：**定义 typed redeem-timeout 的优先级：要么让 redeem 使用 join 剩余 deadline 并由外层唯一产生 `DIAL_TIMEOUT`，要么明确固定 5s timeout 也映射为 `DIAL_TIMEOUT`，并在 matrix/session scenario 增加该路径和连接关闭断言。不能让它落入“非结构化失败”的泛化分支。

### P1-3：所谓“单条权威 F 测试覆盖行”和 D11 wire 段落仍重复

`contracts/error-matrix.md:63-64` 已有一条带 fixture 的 F 覆盖行，但 `:68` 又重复一条旧格式的 F 覆盖行。`design.md:415` 在同一个长段落中重复了完整的段短读/额外记录/未知 kind/ASCII 规则两次。重复内容并非纯历史注记，后续维护很容易只改到其中一份。

**可操作修订：**每个规范层只保留一份 wire grammar 和一份 F owner 行；历史修订记录继续留在顶部，并明确“非规范历史”。

### P1-4：承诺的“坏令牌 + 错目录”冲突 scenario 仍缺失

r9 声称两条冲突场景均已进入 session delta，但 `specs/fabric/session/spec.md:72-75` 只有“空路径令牌 + 损坏名册 -> `[corrupted]`”。没有独立的 BDD scenario 构造“坏令牌 + 错目录 -> TOKEN_INVALID”；该规则只在 prose/matrix（`matrix:40-41`、`design:399-400`）出现。令牌解码失败通常发生在目录检查前，必须有场景防止实现先打开目录并返回 `WRONG_FABRIC`。

**可操作修订：**在 session delta 增加该场景，明确坏签名/坏编码令牌、属于另一个 fabric 的目录、期望 `[token-invalid]`，并把对应 owner 行加入 matrix。

### P1-5：`n0` 与 nullable 顶层 gateway 的消费语义仍不够明确

D6 将 `DWEB_RELAY=n0` 写成“忽略文件 relay”（`design.md:313`），但没有明确这是使用 iroh 内置 N0 relay，还是整体禁用；d.ts 又把 `n0` 作为独立 `RelayOptions`/`RelayStatus.mode`。这会影响 `relayStatus().urls/online`、D2 是否探测和 `config list` 的显示。

另外 nullable fixture 将顶层 `gateway` 设为 `null`（`services.fixtures.json:54-76`），D1 的 schema 文字主要约束服务条目的 `url: string|null`，example delta 只给了 `enabled:true, url:null` 服务项场景（`specs/example-app/spec.md:124-127`），没有顶层 `gateway:null` 的客户端行为。

**可操作修订：**冻结 `n0` 的实际 URL/探测/状态语义；明确顶层 gateway 是否为 `string|null`，并增加客户端遇到 `gateway:null` 的 warning、跳过或硬错场景。

## 需求覆盖核对

| 需求或实测缺陷 | 结论 | 证据与剩余风险 |
| --- | --- | --- |
| relay 为空仍签发 invite | 基本覆盖 | D3、roster delta 和 tasks 3.1 有安全门、显式 `advertise_addrs`、wildcard/端口 0、allow-relayless；实际签发代码仍需按任务替换 `direct_addr_hints` 路径。 |
| 一次性直连地址退出即死亡 | 覆盖 | 签发路径禁止混入运行时 hints；空路径在拨号前归 `NO_REACHABLE_PATH`。 |
| TTL 10 分钟过短 | 覆盖 | 默认 60m，1s-30d，0/999ms/溢出拒绝，固定时间构造测试。 |
| chat 对 relay 失败静默 | 覆盖 | `home_relay_status()` 流、快照首值、跳变事件、配置序 `lastError`、shutdown abort+join 和 chat warning 均有。 |
| wrong-fabric 误报 corrupted | 基本覆盖 | `DirFabricMismatch` 与真 `Corrupted` 分离，16 hex 标识冻结；坏令牌+错目录 scenario 尚缺。 |
| 纯英文横幅、vite 风格 IP | 覆盖 | Network IPv4 枚举、占位行、NAME/PORT 和动态 ASCII 转义均有。 |
| gateway + services.json 单一入口 | 基本覆盖 | Host/IPv6/forwarded scheme/实际端口/no-store/nullable 有；顶层 gateway null 的客户端行为仍未冻结。 |
| config list/get/set 与免手输 env | 覆盖但有语义缺口 | 持久文件、优先级、权限、原子写、URLS 隐式 custom、空项去重、零参和离线保存均有；`n0` 语义仍需补足。 |
| proxy auto/on/off、多 relay 自动择优 | 覆盖 | D2 集合判定、代理覆盖、401/5xx 分层、全量下发 iroh 原生择优、QUIC 不经代理均一致。 |
| `--opt=value` 与 `~` 展开 | 覆盖 | args requirement 和成对测试明确。 |
| join 超时且零诊断 | 未闭合 | 8 码、探针和豁免已写清，但外层 framing、fixture 和 5s/30s timeout 映射仍阻断真实 join。 |

## Design 决策审查

### D1 gateway/services.json

Host 拒绝集合、IPv6 括号剥离、loopback 放行、非 loopback IPv4 回退、无回退时 URL 为 null、实际服务端口、可信 `X-Forwarded-Proto`、no-store、未知名静默和重复名 warning 均已形成可执行方向。主要残余是顶层 `gateway:null` 的 schema/客户端行为未和服务条目 nullable 一样写成场景；fixture 的 nullable warning 已有精确服务端串，但客户端 warning 仍是泛化的 `no reachable url`。

### D2 bootstrap

“规范化 -> 代理决策 -> 地址解析”是无环的；空列表不发请求，所有候选参与直连探测，混合可达时统一经代理，404/200 非 JSON 才 legacy，401/5xx 在解析阶段硬错，legacy/gateway 逐项合并去重。该方向本身已比 r8 清楚。

需要把外层 wire 问题与 bootstrap 分开处理：D2 只决定 HTTP 控制面策略，不应隐含改变 F 的兑换 frame。另需冻结 `n0` 的实际行为及代理 URL 可接受 scheme，避免 `parseable URL` 与 `ProxyAgent`/iroh 的可用 URL 集合不同。

### D3 invite 安全门

relay URL 为空且显式 `advertise_addrs` 为空时拒签，逃生阀带外责任措辞、构造期地址校验、wildcard/端口 0 拒绝、loopback 接受、去重保序和不混入 hints 均一致。这个决策与原事故直接对应。

### D4 `home_relay_status()`

iroh 1.1.0 实际公开 `home_relay_status()`、`RelayStatus::is_connected()`、`last_error()` 和 `proxy_from_env()`，所以直接消费状态流、任一 relay online、聚合跳变、首值只入快照、配置序 `lastError`、显式 abort+join 是可落地的。多 relay 同时上线时 `RelayOnline.url` 仍按 watcher 到达顺序取“首个连上”，而 `lastError` 才有配置序确定性；如果 URL 本身是公共事件字段，建议也冻结 tie-break，而不是依赖事件顺序。

### D5 DirFabricMismatch

专用变体、16 hex 短标识、换数据目录指引与 issuer 侧既有 `WrongFabric -> Other -> TOKEN_INVALID` 的区分是合理的。session delta 缺少坏令牌+错目录场景，使顺序的可回归性不足。

### D6 配置优先级

flag > env > file > default、`DWEB_RELAY=disabled` 整体覆盖、custom 缺 URL 硬错、URLS 隐式 custom、空项过滤去重、非法 JSON、语法错不写、探测失败仍保存并逐项 warning 已足够详细。缺口是 `n0` 的明确含义，以及环境变量“同项整体失效”与 `DWEB_RELAY`/`DWEB_RELAY_URLS` 联合输入在 `n0`、`custom`、仅 URLS 三种组合下的最终状态应再给一张唯一表。

### D7 代理所有权

`FabricConfig.httpProxy: None|FromEnv|Url` 映射 iroh builder，auto 在 Fabric 构造前决定，Node 侧使用显式 `undici` `ProxyAgent`，环境顺序与 iroh 一致，QUIC 不经 HTTP proxy，多 relay 全量交给 iroh 原生择优，这些方向已闭合。实现契约仍应冻结有效 proxy scheme 和 iroh `proxy_from_env` 的 CGI 特殊行为，否则“同一策略”在特定运行环境下可能分叉。

### D8/D9/D10

D8 双形式选项、未知选项退出码和 `~` 展开可测；D9 默认 60m、1s-30d 和溢出边界一致；D10 静态文案和 UTF-8 字节小写 `\\xNN` 转义已同步到 delta/tasks。动态值中包含换行或控制字节时虽仍满足码位 <128，但可能破坏一行一错误的 CLI 解析，建议在呈现层同时冻结行分隔/控制字符处理。

### D11 join 诊断

D11 的令牌错误 -> 本地豁免 -> 目录归属 -> 空路径 -> 网络顺序、探针适用条件、2s DNS/连接预算、deadline+2s 上界和八码表方向合理。但 P0 wire 层级使 RedeemErrorKind 无法接入当前 reader；多记录 reduction 和内层 5s timeout 的归类缺失又使“互斥穷尽”仍不是真正总函数。

### D12 批次编排

S/E/F 的源码目录和唯一 owner 文件清单互斥，C0 先行，E mock 与 ZCode 4.1 真实联测边界、随机端口纪律、lockfile 唯一 owner 都清楚。C0 的 framing/fixture 不正确时，F 无法完成 3.4/3.5，E 的 join 错误 mock 也无法证明与真实 outer frame 对齐；因此并行图“结构上可并行”，但当前契约还不足以安全启动并行实现。

## 五个 delta 与既有规格

| delta | 评价 |
| --- | --- |
| `server` | gateway、services.json、Host/IPv6/forwarded scheme、实际端口、disabled/null、未知静默和重复 warning 均有；Host 清单主要集中在 requirement/tasks，顶层 gateway null 客户端消费仍缺场景。 |
| `example-app` | CLI、config 子命令、TTL、隐式 custom、空项/去重、零参、ASCII、bootstrap 代理覆盖和 join stderr 均有；缺少多记录 RedeemErrorKind 的最终结果，以及 gateway null/n0 场景。 |
| `fabric/roster` | invite 门、advertise 地址校验、wildcard/端口 0、逃生阀、DirFabricMismatch/真损坏分界可测；与 D11 顺序相关的坏令牌+错目录场景不在 session delta。 |
| `fabric/session` | watcher、8 码、豁免、探针和错误码场景齐全；RedeemErrorKind 的外层 framing 与现有实现冲突，fixture 不能作为真实测试基准，多记录最终归类未冻结。 |
| `sdk/node` | relayStatus 三态、事件 payload、取消订阅、第三参 invite、join timeout、错误前缀和非空 custom 元组齐全；`[bad-proxy-url]` 已列公共 d.ts，但 proxy URL scheme/多记录结果仍需补充。 |

与既有主规格对照：SDK 主规格的工厂 + `shutdown()`、包名勘误、roster 的 root/PoP/单次消费目标没有被 r9 文案反向否定；session 仍要求独立兑换 ALPN、5s 通道和 32 KiB 上限。但主 session 规格 `openspec/specs/fabric/session/spec.md:41-43` 还写“首帧必须是兑换请求（令牌 + PoP）”，而当前实现是 `REDEEM_INTENT -> CHALLENGE -> PROOF` 三段（`session.rs:256-291`）。这是既有规格与实现的基线矛盾，r9 不能把它当作“既有外层格式已确定”的证明；至少应在本 change 的兼容边界中明确是否一并勘误。

## Scenario 可测性与契约质量

- **wire**：目标场景覆盖了段短读、0/255、非 ASCII、未知 kind、额外完整记录和 Other 零长，但外层 header 选择错误、canonical/unknown/truncated 长度不自洽；需先修正 C0 才能执行。
- **多记录**：`two-records` 能测消费不位移，却没有预期 join code，无法验证错误分类总函数。
- **bootstrap**：候选集合、混合代理覆盖、空列表、legacy/gateway、401/5xx 和最终退出码大多可由 mock `httpGet` 构造；D2 与 D7 的状态机无环。
- **D11**：八码和三类豁免 owner 行齐全，但固定 5s redeem timeout、坏令牌+错目录和顶层 gateway null 缺少 scenario。
- **D4**：首值快照无初始事件、跳变、配置序 lastError、shutdown 无残留均可观察；同时上线事件 URL 的 tie-break 仍受 watcher 顺序影响。
- **server/ASCII/config**：Host 拒绝清单、nullable 精确服务端 warning、URLS 隐式 custom、零参/语法错/探测保存、动态转义均已进入 delta/tasks；C0 与 D6 的 n0 组合仍需一个最终表。

## 批次并行审查

文件所有权在目录级是互斥的：S 负责 server、opendweb、server-binary/docker；E 负责 example；F 负责 fabric/client-sdk；C0 和根/生成/lockfile/README 等唯一 owner 由 ZCode 管理。E 的 mock 测试与 4.1 真实联测边界也已区分。

跨批 API 仍有三处实际阻塞：

1. F 的 frame reader/writer 需要先知道外层 framing，C0 当前给出的 fixture 不能提供该事实；
2. F 的多记录结果不能由 matrix/delta 推导，E 无法冻结对应 JS code mock；
3. F 的内层 5s timeout 与 E 的 `joinTimeoutMs` 没有共同错误映射。

因此“先 C0 再 S/E/F”的编排顺序正确，但当前 C0 还未达到可并行冻结的质量；不能以 strict validate 通过替代契约审定。

## 可操作的放行条件

1. 选择并在 C0 唯一冻结外层 framing；推荐保留现有 `u32-be(len(type+payload)) + type + payload`，重写六例完整向量，并同步 session delta、D11、matrix 和 tasks。
2. 删除 fixture 第 6 行冲突伪向量；为每个 case 提供机器可解析 hex、声明长度校验和 expected decoded records/result code。
3. 冻结多记录 reduction 规则，至少给 `two-records` 一个确定的最终 code；保持未知 kind 按长度消费但不能让上层分类依赖实现者猜测。
4. 明确 5s redeem deadline 与 1s-10min join deadline 的优先级、错误码和连接关闭语义；补 matrix 与 session scenario。
5. 删除 matrix 重复 F 覆盖行及 design D11 重复 wire 段落，确保规范正文只有一份正向 framing 描述。
6. 把“坏令牌 + 错目录”场景加入 session delta，并补顶层 `gateway:null`、`n0` 最终语义场景/配置矩阵。
7. 重新运行 strict validate，并用现有 `session.rs` 的 reader/writer 对 fixture 做至少一轮字节级 round-trip/negative 解析验证，再进入 S/E/F Apply。

## 综合评分依据

| 维度 | 评价 |
| --- | --- |
| 需求覆盖 | 8.8/10：原始事故、TTL、chat/relay、wrong-fabric、CLI 参数、gateway/services、配置化、代理和错误码均有明确落点；顶层 nullable、n0 和部分 join 边界仍欠场景。 |
| 技术决策一致性 | 4.5/10：D2/D3/D4/D6/D7 主方向合理，但 D11 宣称的“既有 outer frame 不变”与实际协议直接冲突，且固定 redeem timeout 映射未定义。 |
| 可测性与契约 | 3.8/10：矩阵和 owner 细致，但权威 fixture 长度错误、包含冲突伪向量、multi-record 无最终归类，不能作为 F 的可执行基准。 |
| 并行编排 | 7.0/10：S/E/F 目录和唯一 owner 清楚，C0 前置合理；wire fixture 和跨层错误映射未冻结，实际会阻止 F/E 并行验收。 |

综合为 **6.0/10**，相对第八轮 **-2.1**。r9 的文字同步工作是实质进步，但 framing 回归和权威 fixture 不可执行使两个 P0 仍未闭合，当前不具备放行条件。
