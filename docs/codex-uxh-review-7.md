# connectivity-ux-hardening 第七轮评审

评审日期：2026-08-28

评审范围：`openspec/changes/connectivity-ux-hardening/` 的 `proposal.md`、`design.md`、`tasks.md`、五个 delta、C0 contracts，并对照 `openspec/specs/` 既有规格。此次只评审文档，未修改 change 或产品代码。

验证：`openspec validate connectivity-ux-hardening --strict` 通过。该命令只能证明 OpenSpec 结构合法，不能证明 C0 与 delta/tasks 的全文一致性，也不能证明协议测试输入可唯一构造。

## 结论与评分

**8.2/10（相对第六轮 7.8，+0.4），不放行。**

r7 在架构上完成了重要收敛：帧长度改为 0..255，额外字节明确作为下一帧，EOF 处不完整帧才是协议违规；bootstrap 三行组合、D11 令牌错误优先级、watcher 首值语义、Host 拒绝集合、动态 ASCII 转义、配置环境变量边界和非空 relay 元组均已有设计方向。

但是 r7 仍没有做到“全文一致”：design D11 和 C0 matrix 还保留“超长”旧分类/测试要求，C0 因而同时要求删除和实现该语义；若按新语义实现，旧测试无法满足。另有多项新边界只写在 design，没有同步到对应 delta/tasks，仍会让 S/E/F 对测试入口产生不同理解。因此本轮不放行。

## P0 阻塞

### P0-1：已删除的“超传/超长”语义仍存在于权威测试契约

证据：

- 新语义已在 `design.md:398`、`specs/fabric/session/spec.md:35` 和 `contracts/error-matrix.md:52-58` 定义：长度为 0..255，额外字节一律按下一帧，EOF 处段短读才关闭连接；
- 但 `design.md:391` 仍把错误帧非法写成“截断/超长”；
- `contracts/error-matrix.md:45` 仍写“截断/超长”归 `DIAL_FAILED`，`contracts/error-matrix.md:62` 仍要求 F 测试“截断 / 超长”；
- `design.md:398` 的测试覆盖列表也仍写“载荷超传”。

这些位置不是历史说明，而是分类总函数、C0 验收和 F 测试要求。它们与“无超传语义”及“额外字节按下一帧”同时生效，导致 F 无法同时满足两套测试口径；C0 也不再是唯一可执行依据。

可操作修订：删除上述所有“超长/超传”分类和测试字样，统一使用“kind/len/payload 任一段短读（含 EOF 不完整帧）”；保留 0 与 255 边界、额外完整帧、多帧后续解析和 Other 零长度场景。历史修订说明可保留，但必须显式标为非规范历史，不得出现在当前分类/验收段落。

## 原两个 P0 的闭合判断

### P0-1 bootstrap 代理覆盖：语义已闭合，仍有同步遗漏

`design.md:124-139`、example delta `spec.md:92-107`、matrix `:84-98` 已统一为：全部候选直连探测；部分失败时仅对失败项代理重试；任一代理成功即 `from-env` 且后续全部候选统一走代理；代理全败或无代理时保留直连硬错误与对应 warning；401/5xx 传输可达但解析硬错误；legacy/gateway 逐项判定、合并去重。D6 `design.md:283` 也已删除首项特权。

matrix `:96` 已把 401/5xx 行写成 `from-env`、候选硬错误、数组任一项失败整体退出，主决策没有环。

残余是契约扩散：DWEB_RELAY_URLS 单独存在、空项过滤/去重/保序、`config set relay` 零参行为仅出现在 `design.md:298`，example delta 与 `tasks.md:29` 没有对应 requirement/scenario/task 逐项表达。E 可按 design 实现，但 C0/delta/tasks 仍不完全对齐。

### P0-2 join 诊断/探针：分类主函数已闭合

`design.md:376-393`、matrix `:34-46` 和 session delta `spec.md:35` 现在都将令牌解码、过期、地址规范化置于目录 fabric 检查之前，并明确坏令牌与错目录唯一归 `TOKEN_INVALID` 家族；探针仅在“无直连地址 + policy none”时参与 `RELAY_OFFLINE`，TCP transport-only、DNS/默认端口/2 秒预算、deadline+2 秒、四类注入和负测均已对齐。

session delta `spec.md:11-14` 已改为首值只进快照、不产生初始事件；其后 offline->online 才发 `RelayOnline`，与 D4/tasks 一致。三类本地豁免也已明确为 `[corrupted]`、`[missing-identity]`、`[roster-io]`。

因此该 P0 的运行时分类方向可判断为闭合；唯一仍会阻塞 Apply 的是上面的 wire 旧测试残留。

## 需求与实测缺陷覆盖

| 需求/缺陷 | 结论 | 证据与残余风险 |
| --- | --- | --- |
| relay 为空仍照签 invite | 基本闭合 | D3 安全门、显式 advertise_addrs、wildcard 拒绝和 allow_relayless 已有；非法地址的重复/端口边界未冻结。 |
| 一次性直连地址随进程退出死亡 | 已闭合 | direct_addr_hints 不进签发，空路径令牌拨号前 `NO_REACHABLE_PATH`。 |
| join 超时且零诊断 | 基本闭合但受 P0 阻塞 | 8 码、豁免、总时限和探针均有；C0/design 仍有“超长”旧测试要求。 |
| chat 对 relay 失败静默 | 已闭合 | home relay 流、快照优先、首值不广播、跳变、配置序 lastError、shutdown abort+join 均一致。 |
| wrong-fabric 误报 corrupted | 已闭合 | `DirFabricMismatch` 与真 `Corrupted` 分开，令牌错误优先级已同步。 |
| TTL 10 分钟过短 | 已闭合 | 默认 60 分钟，1s-30d，溢出/0/999ms 拒绝和固定时间测试均有。 |
| 纯英文横幅与 vite 风格 IP | 基本闭合 | IP 枚举、无地址占位、动态 `\\xNN` 转义在 design 有定义；delta/tasks 尚无动态非 ASCII 场景。 |
| gateway + services.json 单一入口 | 基本闭合 | Host/IPv6/forwarded scheme/实际端口/no-store/nullable 已有；可执行 Host 拒绝清单只在 design，server delta/tasks 仍是“不可路由值”概念。 |
| config list/get/set 与免手输 env | 基本闭合 | 优先级、disabled/custom/n0、原子写、权限、离线保存已有；URLS 隐式 custom、空项规则、零参错误未同步到 delta/tasks。 |
| proxy auto/on/off、多 relay 自动择优 | 基本闭合 | 全候选探测、代理覆盖、401/5xx 解析错误、legacy 混合矩阵已补；行级测试仍受 wire/C0 残留影响。 |
| `--opt=value` 与 `~` 展开 | 已闭合 | 双形式、展开、未知选项码和定向测试边界一致。 |

## Design 决策审查

### D1 gateway/services.json

Host 拒绝集合已在 `design.md:87` 冻结为 unspecified（`0.0.0.0`、`::`、空 host）、userinfo、host:port 解析失败、端口 0 或大于 65535；其余包括 loopback 放行。IPv6 括号、可信 forwarded scheme、实际端口、无回退地址时 nullable URL 和 no-store 均可实现。

但 `specs/server/spec.md:30-32`、`:41-49` 与 `tasks.md:19-20` 没有列出同一拒绝集合，仍可能让 S 只实现“如 0.0.0.0”的部分检查。应把清单和对应场景同步到 server delta/tasks。fixtures 虽已增加 warning 字段，但 canonical 与 `unknown-and-duplicate` 没有显式空 warning/重复 warning 字段（`contracts/services.fixtures.json:4-15`、`:50-62`），测试仍需依赖 note 或自行硬编码。

### D2 bootstrap

状态机“规范化 -> 集合探测/代理决策 -> 已决策略解析”无环，候选集合不依赖顺序；部分成功/部分失败、代理解析 401/5xx、legacy+gateway 混合和空列表均有矩阵行。D6 的首项残留已删除，主 P0 方向正确。

仍需将 DWEB_RELAY_URLS 的隐式 custom、空项过滤/去重保序和零参数错误同步到 example delta/task；否则 E 的实现依据仍横跨 design 与未更新的 task 简述。

### D3 invite 门与逃生阀

relay 空且 advertise_addrs 空拒签、direct_addr_hints 排除、wildcard 拒绝、loopback 允许、allow_relayless 带外责任均已同步 roster delta 和 3.1。端口 0、重复地址和错误前缀未冻结，属于低于放行线的边界遗漏。

### D4 home_relay_status()

状态流消费、任一 relay online、聚合跳变、配置序 lastError、首值仅进快照、shutdown abort+join 和无后续事件已在 design/session/tasks 对齐；r6 的初始事件矛盾已消除。

### D5 DirFabricMismatch

proposal、design、roster/session/sdk delta 和 C0 均使用 `DirFabricMismatch` / `[wrong-fabric]`，issuer 侧 `WrongFabric` 仍通过 Other -> `TOKEN_INVALID`。D11 当前顺序已明确令牌自身错误优先于目录检查，无新的命名冲突。

### D6 配置优先级与事务

flag > env > file > default、disabled 整体覆盖、custom 缺 URL 硬错误、非法 JSON、语法错不写、探测失败仍保存并逐项 warning 均可实现。r7 新增的“DWEB_RELAY_URLS 单独存在即隐式 custom、空项过滤/去重保序、config set 零参报错”只在 `design.md:298` 出现；example delta `spec.md:53-88` 和 tasks `2.2` 未提供可测场景，需补齐。

### D7 proxy auto/on/off

`HttpProxyConfig { None, FromEnv, Url }` 所有权、Fabric 构造前决策、undici 显式依赖、环境顺序和 QUIC 不走 HTTP proxy 已保持一致。代理覆盖矩阵现在闭合；C0 wire 残留和 delta/task 同步缺口仍阻塞并行验收。

### D10 ASCII

design `:344` 已冻结动态值非 ASCII 按字节 `\\xNN` 转义，能保证路径、URL、原因等动态内容仍满足 ASCII 断言。但需明确 UTF-8 字节编码和十六进制大小写，并在 example/server delta 和 tasks 增加含非 ASCII 动态值的断言；否则“全部输出 ASCII”只有静态文案层面的测试保障。

### D11 join 错误分类与 wire

令牌自身错误顺序、8 码/3 豁免、探针适用条件、deadline、`RedeemErrorKind` 0..255、Other 零长、未知 kind、多帧和 EOF 短读均已有明确语义。额外字节按下一帧后，帧格式在协议层已可唯一解析。

仍必须清理 design `:391,398` 与 matrix `:45,62` 的“超长”旧字样；这些段落属于当前分类和测试口径，不是可忽略的历史描述。

### D12 批次编排

S/E/F 目录和唯一 owner 文件仍互斥；C0 先于并行批次；E mock 与 ZCode 4.1 真实联测边界清楚。当前跨批不足主要是文字同步：

1. C0/design 的 wire 测试行仍要求已删除的超长语义；
2. DWEB_RELAY_URLS 新配置规则没有进入 example delta/tasks；
3. Host 拒绝清单只在 design，没有进入 server delta/tasks；
4. 动态 ASCII 转义没有进入 delta/task 场景；
5. fixture warning 字段没有在每组保持结构化完整性。

这些问题不改变 S/E/F 的源码目录所有权，但会让子代理对“任务完成”产生不同判定。

## 五个 delta 与既有规格

| delta | 评价 |
| --- | --- |
| `server` | services.json、Host/IPv6/forwarded scheme/实际端口/disabled/null、未知静默和重复 warning 已有；Host 可执行拒绝集合和 fixture warning 结构未完全同步。 |
| `example-app` | 全候选代理覆盖、401/5xx、config 事务、TTL、ASCII、join stderr 均有；URLS 隐式 custom/空项/零参和动态转义缺 scenario/task。 |
| `fabric/roster` | invite 门、wildcard、逃生阀、DirFabricMismatch/真损坏分界可测；advertise 地址重复与端口边界未冻结。 |
| `fabric/session` | 首值事件、令牌错误优先级、8 码豁免、EOF 短读、0/255、多帧和未知 kind 已同步；design/matrix 旧超长测试残留破坏 C0 一致性。 |
| `sdk/node` | RelayOptions 非空元组、空数组构造 reject、relayStatus、事件 payload、取消订阅、joinTimeout 和错误前缀齐全；无新的公共 API 矛盾。 |

与 `openspec/specs/` 对照：主 SDK 生命周期已是工厂 + `shutdown()`，主规格包名已勘误；server 独立 relay listener、session 5s 兑换通道、roster root/PoP/单次消费和 example 端到端目标未被本 change 破坏。r7 没有引入既有规格冲突，残余主要是 change 内部同步。

## Scenario 可测性

- **wire**：新定义下可构造 kind/len/payload 各段 EOF 截断、0/255 边界、非 ASCII、未知 kind、完整额外帧和 Other 零长；必须删除 matrix/design 的旧“超长”测试行，否则无法形成唯一测试集合。
- **bootstrap**：主要候选组合、传输可达/解析可用性分层和整体失败已在 matrix；仍需把 URLS 隐式 custom、空项过滤去重和 zero-arg 写入补到 example delta/task。
- **D11**：令牌自身错误优先于目录检查、探针四类注入和本地三类豁免均有 owner；地址错误与目录 mismatch 的冲突输入应在 matrix 保留一个明确场景，防止回归。
- **D4**：首值无事件、随后状态跳变、配置序 lastError、shutdown 无残留已有测试文字且互相一致。
- **server/ASCII**：Host 清单与动态 `\\xNN` 规则需要进入 delta 的独立场景；fixture 需要对“无 warning”和“重复 warning”都提供结构化期望。

## P0/P1 阻塞清单

### P0

1. design D11 与 C0 error-matrix 仍含“截断/超长”分类和超长测试行，与 r7 明确删除超传语义相矛盾；C0/F 无法同时满足两套协议测试口径。

### P1

1. DWEB_RELAY_URLS 隐式 custom、空项过滤/去重保序、config set relay 零参只写在 design，未同步 example delta/tasks。
2. Host 拒绝集合只写在 design，server delta/tasks 仍使用宽泛“不可路由值”，S 的测试边界不完整。
3. `services.fixtures.json` 的 expected warning 字段不覆盖 canonical/unknown+duplicate 的显式空值/重复 warning，fixture 不能独立驱动全部告警断言。
4. D10 动态值 `\\xNN` 转义缺 UTF-8/大小写细节，且没有 delta/task 场景验证非 ASCII path/URL/reason。
5. roster advertise_addrs 的重复项、端口 0 和错误前缀仍未冻结；RelayOptions 之外的 CLI/config relay 数组边界也未完全列场景。
6. design/matrix 的历史说明虽可保留，但必须与规范段落物理区隔，避免实现者把旧 `超长` 测试重新带入任务。

## 可操作的放行条件

1. 删除 design `:391,398` 和 matrix `:45,62` 的“超长/超传”分类与测试，只保留短读/EOF、不完整帧、0/255、多帧、未知 kind、Other 零长；全局搜索确认无规范段落残留。
2. 将 DWEB_RELAY_URLS 隐式 custom、空项过滤/去重保序、零参数错误分别写入 example delta scenario、tasks 2.2/2.6 和 C0 matrix。
3. 将完整 Host 拒绝清单写入 server delta 与 tasks 1.1/1.2，并为 fixture 的每个案例提供 `expectedClientWarning`/`expectedServerWarnings`（无 warning 也显式为空）。
4. 将动态 ASCII 转义定义为 UTF-8 字节、固定十六进制大小写，并补含非 ASCII 动态值的 E/S 测试。
5. 补 advertise 地址重复/端口边界和配置数组边界场景，重新运行 strict validate 后再进入 Apply。

完成以上修订后，原两个 P0 的运行时设计和 r7 wire 主语义即可放行；当前仍不放行。

## 综合评分依据

| 维度 | 评价 |
| --- | --- |
| 需求覆盖 | 9.2/10：原始事故、TTL、ASCII/gateway、持久配置、三态代理、relay 观测和 join 诊断均有落点，新增边界大多已补。 |
| 技术决策一致性 | 8.1/10：bootstrap、D11 顺序、D4 初始事件和 wire 主定义已合理；规范段落仍有旧超长术语。 |
| 可测性与契约 | 7.5/10：帧主语义已可构造，C0 残留测试行及 design-only 配置/Host/ASCII 边界仍破坏全文冻结。 |
| 并行编排 | 8.1/10：owner/批次边界清晰，跨批契约缺口集中在少数同步项；wire 残留仍足以阻塞 F/E。 |

综合为 **8.2/10**，相对第六轮 **+0.4**：r7 实质解决了帧不可表达和 D11/D4 的主要矛盾，但权威 C0 仍留有互斥测试要求，且多个新规则尚未进入 delta/tasks，因此尚未达到放行线。
