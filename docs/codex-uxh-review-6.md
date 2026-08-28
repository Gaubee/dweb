# connectivity-ux-hardening 第六轮评审

评审日期：2026-08-28

评审范围：`openspec/changes/connectivity-ux-hardening/` 的 `proposal.md`、`design.md`、`tasks.md`、五个 delta、C0 contracts，并对照 `openspec/specs/` 既有规格。此次只评审文档，未修改 change 或产品代码。

验证：`openspec validate connectivity-ux-hardening --strict` 通过。该命令只验证 OpenSpec 结构，不能证明 C0 契约之间的文字一致性、wire 帧可实现性或测试场景能够构造。

## 结论与评分

**7.8/10（相对第五轮 8.0，-0.2），不放行。**

r6 的主要行为方向是正确的：bootstrap 已补部分成功/失败和 legacy+gateway 组合；代理覆盖、探针适用条件、四类注入、豁免错误、wildcard、未知服务名和 RelayOptions 判别联合均有明显收敛。原两个 P0 的主路径可以描述并实现。

但 r6 的“全部处置”没有落到唯一权威契约：C0 错误矩阵和 tasks 仍保留不可表达的 `len <= 256`；D6 仍写“首个用于 D2 解析”，与全候选探测相反；D4 的“首值不广播”与 session delta 的“首次可达必观察 RelayOnline”相反；流式帧的“载荷超传”也没有定义可判定的外层边界。上述问题会让 F/E 得出不同实现和测试结果，不能进入 Apply。

## P0 阻塞

### P0-1：C0 wire 契约仍冻结了不可表达的 256 字节

证据：

- `design.md:388` 与 `specs/fabric/session/spec.md:35` 已改为 `len(1B)`、`len <= 255`、整帧 257 字节；
- 但 C0 唯一依据 `contracts/error-matrix.md:49-61` 仍写 `payload ... len <= 256`、`len > 256`；
- `tasks.md:41` 仍写 `Other <=256B`。

无符号单字节长度只能表达 0..255。当前 F 的帧编解码、E 的错误映射和 C0 的“逐行测试”不能对同一输入达成一致；`len > 256` 也不能按一字节字段构造。r6 的 design/session 修订没有闭合权威 matrix/tasks。

可操作修订：在 `error-matrix.md`、`tasks.md` 和 design 的历史注记中统一为 255；明确 `0..255` 的值域、最大整帧 257、Other 零长度、kind/len/payload 各段短读和超传测试。C0 修订后重新运行 strict validate。

### P0-2：流式协议无法区分“载荷超传”和下一帧

证据：

- `design.md:388`、session delta `spec.md:35` 要求“载荷流超传”即协议违规、关闭整个兑换连接；
- 同一段又要求未知 kind 按 `len` 消费，且“后续帧可继续解析”；
- 当前只定义 `kind + len + payload` 的连续字节流，没有外层消息长度、帧数或结束标记。

当 `len=1` 的帧后多出一个字节时，解析器无法判断该字节是超传 payload，还是下一帧的 kind。若按后续帧解析，就不能检测超传；若按超传关闭，就违反多帧继续解析。测试“载荷超传”因此不可唯一构造，直接影响 DIAL_FAILED 分类。

可操作修订：二选一并同步 F/C0/tests：

1. 定义兑换响应为有外层 record/message 边界（或明确“仅一个响应帧后必须 EOF”），超出该边界才叫超传；或
2. 删除“超传”语义，只保留每段短读/长度上限违规，并明确额外字节一律作为下一帧。

同时冻结短读发生位置、连接关闭范围和未知 kind 多帧样例。

## 原两个 P0 的闭合判断与残余阻塞

### P0-1 bootstrap 代理覆盖

主路径已基本闭合。`design.md:124-139`、example delta `spec.md:92-107` 和 matrix `:83-97` 都要求全集直连探测；部分失败时代理覆盖全部候选；代理重试全败时保留可达项、失败项直连硬错误并输出相应 warning；401/5xx 只在传输层视为可达，在解析层硬错误；legacy 与 gateway 逐项合并去重。

仍有两个契约缺口：

- `design.md:273` 仍写“数组……首个用于 D2 解析”，与全集探测、顺序无关和后续全部经代理的语义直接冲突。应删除“首个”，改为全部候选参与 D2，只有解析结果逐项合并；
- matrix `:95` 的 policy 写成“（policy 不变）”，没有明确该行的输入 policy（应至少写 `from-env`）以及解析失败后的候选级 warning/整体退出结果。E 的逐行 mock 仍可实现出两种答案。

因此代理主算法可放行方向正确，但契约尚未无歧义冻结。

### P0-2 join 诊断与探针

探针适用条件已正确收窄为“令牌无直连地址 + 生效策略 none”，并明确 TCP transport-only、DNS/默认端口、2 秒预算、deadline+2 秒上界和可替换句柄。该部分不再把代理路径或加入方 home relay 误归因于 `RELAY_OFFLINE`。

但错误总函数仍有优先级矛盾：`design.md:366-373` 与 matrix `:34-39` 先在步骤 3 返回 `WRONG_FABRIC`，随后步骤 4 才处理地址规范化，却又声明令牌错误 1/2/4 优先于目录本地错误。若目录 fabric 不匹配且 token 地址非法，当前文档同时允许 `WRONG_FABRIC` 与 `TOKEN_INVALID`。应把 token 解码/过期/地址规范化统一置于目录检查之前，或明确冲突输入的唯一归类并补场景。

此外，session delta `spec.md:11-14` 仍要求 relay 首次可达时订阅方观察 `RelayOnline`；design D4 `design.md:218` 和 tasks `tasks.md:42` 明确 watcher 首值只入快照、不广播。应将该 scenario 改为“快照 online 且无初始事件”，另加 offline->online 跳变场景。

## 需求与实测缺陷覆盖

| 需求/缺陷 | 结论 | 证据与残余风险 |
| --- | --- | --- |
| relay 为空仍照签 invite | 基本闭合 | D3 安全门、显式 advertise_addrs、wildcard 拒绝和 allow_relayless 已有；需保持三分支测试与 C0 前缀一致。 |
| 一次性直连地址随进程退出死亡 | 已闭合 | direct_addr_hints 不进入签发，空路径令牌在拨号前 `NO_REACHABLE_PATH`；loopback 责任已注明。 |
| join 超时且零诊断 | 部分闭合，仍阻塞 | 8 码、deadline、探针和豁免已覆盖，但 matrix 长度冲突、帧超传不可判定、错误优先级矛盾尚未解决。 |
| chat 对 relay 失败静默 | 基本闭合 | home relay 流、快照优先、跳变、配置序 lastError、shutdown abort/join 均有；session 首值 scenario 仍冲突。 |
| wrong-fabric 误报 corrupted | 已闭合 | `DirFabricMismatch` 与真 `Corrupted` 分开，短标识冻结；需修正总函数冲突顺序。 |
| TTL 10 分钟过短 | 已闭合 | 默认 60 分钟，1s-30d，溢出/0/999ms 拒绝和固定时间测试均有。 |
| 纯英文横幅与 vite 风格 IP | 基本闭合 | 非 loopback IPv4、无地址占位、ASCII 断言已有；动态路径/原因的非 ASCII 转义规则仍未定义。 |
| gateway + services.json 单一入口 | 基本闭合 | Host/IPv6/forwarded scheme/实际端口/no-store/nullable 已有；“不可路由值”仍是自然语言集合，建议补可执行白名单。 |
| config list/get/set 与免手输 env | 基本闭合 | 优先级、disabled/custom/n0、原子写、权限和 saved-but-unreachable 已有；单独设置 `DWEB_RELAY_URLS`、空变参和 trim/重复规则仍未冻结。 |
| proxy auto/on/off、多 relay 自动择优 | 基本闭合，仍有 P1 | 全集探测和代理覆盖矩阵已补；D6“首个 D2”残留、matrix 401/5xx policy 未定。 |
| `--opt=value` 与 `~` 展开 | 已闭合 | 双形式、展开、未知选项码和定向测试边界一致。 |

## Design 决策审查

### D1 gateway/services.json

Host 校验、IPv6 括号剥离、可信 forwarded scheme、实际端口、no-store、无回退地址时 nullable URL 已形成可实现方向；未知服务静默忽略、重复服务首个加一条 WARNING 也已在 design/fixture/server delta 统一。

仍需把“不可路由值”定义为可执行规则（至少列明 unspecified、userinfo、非法 host/port、loopback 是否允许），并让 fixture 用结构化 `expectedWarnings` 表达重复项 warning。当前 `unknown-and-duplicate` 只有中文 note，没有机器可断言的 warning 字段（`contracts/services.fixtures.json:48-60`）。

### D2 bootstrap

状态机顺序“规范化 -> 集合探测/代理决策 -> 已决策略解析”无环，空列表不发请求、完整 HTTP 响应作为可达性、404/非 JSON legacy fallback、401/5xx 解析硬错误均清晰。D6 的“首个用于 D2”是直接矛盾；matrix 的 401/5xx 行还缺 policy 和聚合输出。删除顺序依赖文字并补齐行级输入/输出后才可冻结。

### D3 invite 门与逃生阀

relay 空且 advertise_addrs 空拒签、direct_addr_hints 排除、wildcard 拒绝、loopback 允许、allow_relayless 带外责任均已进入 roster delta 和 tasks，主路径闭合。仍需统一非法地址的错误前缀/CLI 呈现，以及明确 advertise 地址是否允许重复、端口 0 等边界。

### D4 home_relay_status()

直接消费状态流、任一 relay online、聚合态跳变、配置序 lastError、快照先于事件、首值不广播、shutdown 显式 abort+join 都是一致的技术方向。session delta 的“首次可达必发 RelayOnline”必须改掉，否则 F 会同时实现广播和不广播两种行为。

### D5 DirFabricMismatch

设计、proposal、roster/session/sdk delta 均使用 `DirFabricMismatch` 与 `[wrong-fabric]`，并保留 issuer 侧既有 `WrongFabric` 作为 `Other -> TOKEN_INVALID`。剩余问题是总函数步骤 3/4 的优先级冲突，而不是命名。

### D6 配置优先级与事务

flag > env > file > default、`DWEB_RELAY=disabled` 整体覆盖、custom 缺 URL 硬错误、非法 JSON 硬错误、语法错不写、探测失败仍保存并逐项 warning 的语义可实现。`DWEB_RELAY_URLS` 单独存在时是否忽略/报错、`config set relay` 零参数行为、逗号分隔空项及去重仍未冻结；另有“首个用于 D2”矛盾。

### D7 proxy auto/on/off

`HttpProxyConfig { None, FromEnv, Url }` 的所有权、Fabric 构造前决策、undici 显式依赖、代理环境顺序和 QUIC 不走 HTTP proxy 已对齐。D2 集合算法解决了混合可达性；剩余仅是 matrix policy 行和 D6 残留，修订后可实现。

### D11 join 错误分类与 wire

8 码 + 3 个本地豁免的边界已有 owner、前缀和场景；探针四类注入与负测已进入 tasks 3.5。当前阻塞是：C0 仍 256；帧流没有超传判定边界；地址错误优先级与总函数顺序冲突；session 的本地 IO 场景没有明确写 `[roster-io]`（matrix/d.ts 已明确），应同步为精确前缀。

### D12 批次编排

S/E/F 的源码目录和唯一 owner 文件仍互斥，C0 先于并行批次，E mock 与 ZCode 4.1 整合边界也清晰。并行仍受以下契约缺口阻塞：

1. matrix/tasks 的 256 与 design/session 的 255 使 F frame 与 E mapping 不可对齐；
2. D6 “首个 D2”使 E 的集合探测与 D2 全候选语义冲突；
3. session 首值事件 scenario 与 D4/tasks 相反；
4. tasks 3.4 的旧 `Other <=256B` 描述未同步，尽管 3.5 已列 255 相关测试意图；
5. 3.5 写“载荷超传”但无可构造边界，需先修 wire 设计。

## 五个 delta 与既有规格

| delta | 评价 |
| --- | --- |
| `server` | Host/IPv6/forwarded scheme/实际端口/disabled/null、未知静默和重复 warning 已覆盖；Host 不可路由集合与 fixture warning 结构仍可加强。 |
| `example-app` | 全候选代理覆盖、三态 proxy、config 事务、TTL、ASCII、join stderr 契约均有；D6 “首个”残留和 matrix policy 空值会影响 E 行级测试。 |
| `fabric/roster` | invite 门、wildcard、逃生阀、DirFabricMismatch/真损坏分界均可测；重复 advertise/端口边界未冻结。 |
| `fabric/session` | 8 码、豁免、探针、帧格式和 shutdown 有完整文字；首次 RelayOnline 与 D4 冲突，帧超传和总函数优先级未闭合。 |
| `sdk/node` | 判别联合 RelayOptions、relayStatus、事件 payload、取消订阅、joinTimeout 与错误前缀齐全；custom 空 urls 的静态值域仍比注释宽。 |

与 `openspec/specs/` 对照：主 SDK 生命周期已修正为工厂 + `shutdown()`，主规格包名勘误已落盘；server 独立 relay listener、session 5s 兑换通道、roster root/PoP/单次消费和 example 端到端目标未被本 change 方向破坏。session delta 的首值事件冲突是 change 内部冲突，不是既有主规格冲突。

## Scenario 可测性与契约质量

- 帧测试集合已列出各段截断、长度上限、非 ASCII、未知 kind、多帧和 Other 零长，但 C0 旧上限及“超传/下一帧”边界使其中两类无法唯一构造；应先冻结外层边界再写 fixture。
- bootstrap 表现在覆盖主要集合组合，仍需把每行明确为候选级输入（directReachable、proxyReachable、parseResult）、policy、最终 relay 列表、warning 和整体退出结果。尤其 matrix `:95` 不能用“policy 不变”代替值。
- watcher 测试已要求首值不广播、配置序 lastError、shutdown 无残留，但 session delta scenario 尚未同步；该项必须改为可观察的快照/跳变序列。
- roster wildcard、services unknown/duplicate、RelayOptions 判别联合均已有场景；应补 `custom` 空 urls、`DWEB_RELAY_URLS` 单独存在和动态 ASCII 值转义场景。

## P0/P1 阻塞清单

### P0

1. C0 `error-matrix` 与 tasks 仍为 `len(1B)+payload<=256`，与 255 规范冲突，无法表达/测试边界。
2. “载荷超传”与“未知 kind 后续帧”在当前裸流格式下不可区分，wire 行为无法实现唯一分类。

### P1

1. D6 “首个用于 D2 解析”与全集、顺序无关 bootstrap 冲突。
2. matrix 401/5xx 解析行没有明确 policy、候选级 warning 和整体退出聚合。
3. D11 步骤 3/4 与“令牌错误优先”注释相反；session 首次 RelayOnline scenario 与 D4 首值不广播相反。
4. D1 wildcard/不可路由集合和 services warning 缺少结构化、可执行 fixture；dynamic user values 的 ASCII 转义未冻结。
5. `RelayOptions` 注释要求 custom urls 非空，但 `Array<string>` 静态可传空数组，构造期拒绝行为未在 delta/task scenario 明确。
6. session 本地 IO 场景写作泛化的 `IO`，未与 `[roster-io]` 前缀逐字冻结；tasks 3.4 仍保留 256 旧术语。

## 可操作的放行条件

1. 以 255 为唯一上限同步 `error-matrix.md`、tasks 3.4、所有历史/注记中可能被实现者读取的 wire 文本；补 0、255、256 和短读样例。
2. 为兑换响应增加明确外层 frame/message 边界，或删除不可判定的“载荷超传”语义；同步协议测试和 DIAL_FAILED 映射。
3. 删除 D6 的“首个用于 D2 解析”，将 matrix 401/5xx 行写成 `from-env` 及确定的错误聚合；补完整候选级决策表。
4. 调整总函数顺序或明确冲突优先级，令 token 地址错误与目录 mismatch 只有一个结果；把 session 首次可达 scenario 改成“快照 online、无初始事件”。
5. 将 services warning、Host 可路由值、RelayOptions 空数组、`DWEB_RELAY_URLS` 单独存在和动态 ASCII 转义写成结构化场景，并同步 C0/tasks。

完成以上修订并重新执行 strict validate 后，才具备无歧义并行 Apply 条件；当前不放行。

## 综合评分依据

| 维度 | 评价 |
| --- | --- |
| 需求覆盖 | 8.9/10：原始事故、TTL、ASCII/gateway、持久配置、三态代理、relay 观测和 join 诊断均有落点。 |
| 技术决策一致性 | 7.4/10：D2/D7 主路径合理，但 D6 首项残留、D4/session 事件冲突、D11 优先级冲突会改变实现结果。 |
| 可测性与契约 | 7.0/10：bootstrap 场景显著补齐，wire 权威上限和超传边界仍不能构造，matrix/tasks 也未同步。 |
| 并行编排 | 7.7/10：owner/批次边界清晰，但 C0/E/F 对 wire、D2 和 watcher 初值的解释仍不一致。 |

综合为 **7.8/10**，相对第五轮 **-0.2**：r6 的设计正文有实质进展，但关键修订没有同步到唯一权威 C0/tasks，且新增/保留了两个会改变运行时行为的矛盾（流式帧超传边界、首值事件语义），因此不能放行。
