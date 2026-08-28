# connectivity-ux-hardening 第十一轮评审

评审日期：2026-08-28

评审范围：`openspec/changes/connectivity-ux-hardening/` 的 `proposal.md`、`design.md`、`tasks.md`、五个 delta、C0 contracts；对照 `openspec/specs/` 既有规格及当前 `crates/dweb-fabric/src/session.rs`、`roster.rs`。本轮只评审文档，不修改 change 或产品代码。

验证：`openspec validate connectivity-ux-hardening --strict` 通过。该命令只能证明 OpenSpec 结构合法，不能证明 C0 文件引用存在、fixture 字段语义一致，亦不能证明 issuer 生产路径已经按映射表发帧。

## 结论与评分

**8.3/10（相对第十轮 8.0，+0.3），暂不放行。**

r11 真实修复了第十轮最重要的边界缺口：fixture 已迁移为结构化 JSON，补齐 255-byte 记录与外层 payload EOF，且九个 hex 向量按当前 `write_frame/read_frame` 算法模拟后长度和记录流一致；多记录 fail-closed、issuer 映射表、5s 等值边界和 n0/跨层入口也有明显推进。

但当前仍有会阻塞并行验收的契约问题：错误矩阵还指向已经删除的七例 `.hex` 文件；JSON 把内部 `IO_ERROR` 写进声称代表 join 最终分类的 `expectedResult`；issuer 映射没有把所有 `RosterError` 变体及原因截断规则冻结为可执行表；已声称删除的 design wire grammar 仍重复存在；kind 1/2、非 ASCII 和等值 timeout 的独立覆盖入口仍不完整。这些问题不推翻 framing P0，但会使 F/E 对同一失败路径得出不同完成判定。

## P0 闭合判断

### 原 P0-1：代理所有权与 bootstrap

**判断：r11 未重新打开原 P0，主路径已闭合。**

D2 已形成“规范化 -> 代理决策（只看原始候选） -> 地址解析（使用已决策略）”的无环状态机。auto 按候选集合处理混合可达性，from-env 时所有候选统一经代理解析；n0 不探测；QUIC 不经 HTTP proxy；`FabricConfig.http_proxy` 的 None/FromEnv/Url 由 F 显式映射。error-matrix 的 bootstrap 表也保留了 401/5xx 硬错误和整体退出码 1。

剩余风险为契约同步质量而非决策环：matrix 的旧 fixture 引用会使 F 无法按唯一基准执行测试（见 P1-1）。

### 原 P0-2：join 诊断与外层 framing

**判断：协议 framing 和主要分类路径已闭合；契约仍有 P1 阻塞。**

当前 `session.rs:70-104` 的公共算法是：

```text
u32_be(1 + payload_len) + type(1B) + payload
```

九个 JSON case 的逐字节复核结果如下：

| case | 实际总字节 | 外层长度域 | 记录/reader 结果 | JSON 期望 |
| --- | ---: | ---: | --- | --- |
| canonical | 7 | 3 | `Consumed/len=0` | TOKEN_CONSUMED |
| other | 15 | 11 | `Other/len=8` | TOKEN_INVALID |
| unknown-kind | 11 | 7 | `0x7f/len=4`，按 Other | TOKEN_INVALID |
| two-records | 17 | 13 | 两条完整记录 | TOKEN_INVALID |
| len-255-other | 262 | 258 | `Other/len=255` | TOKEN_INVALID |
| inner-truncated | 9 | 5 | 外层完整、内层记录短读 | DIAL_FAILED |
| zero-len-other | 7 | 3 | Other 零长度合法 | TOKEN_INVALID |
| outer-header-truncated | 3 | 不足 5B | `read_frame` 头部 EOF | IO_ERROR |
| outer-payload-truncated | 9 | 声明 11，实际 payload 4B | `read_frame` payload EOF | IO_ERROR |

长度域、type `0x14`、payload 边界和 255 上限均与实现一致；`REDEEM_OK(0x13)` 沿用公共格式。多记录 reduction 也已冻结为恰一条 Consumed 才是 TOKEN_CONSUMED，恰一条其它已知或多条记录均 TOKEN_INVALID，未知 kind 按长度消费后作为 Other。

## 阻塞问题

### P1-1：唯一权威 matrix 仍引用不存在的旧 fixture

`contracts/error-matrix.md:71-74` 仍写 `contracts/redeem-err.fixture.hex` 七例；该文件已被删除，现存权威文件是 `contracts/redeem-err.fixtures.json` 九例。tasks `3.5` 已改为 JSON 九例，design 顶部修订注记也声称已迁移，因此三层已经出现直接矛盾。

这不是历史注记：该行位于 matrix 的“唯一权威 F 覆盖行”内，F 若按 matrix 执行会寻找不存在的输入，无法判断是否完成九例、issuerMapping 和 expected 字段覆盖。

**建议：**将 matrix 唯一覆盖行改为 JSON 九例，并明确读取 `issuerMapping`、`cases[*].expectedRecords/expectedResult/expectedViolation`；对旧路径做全局搜索，历史注记之外不得再出现。

### P1-2：fixture 的 `expectedResult` 混合了 join 分类和 reader 内部错误

JSON 顶部说明称 `expectedResult` 是“join 侧最终归类”，但 `outer-header-truncated` 与 `outer-payload-truncated` 填的是 `IO_ERROR`。`IO_ERROR` 既不在 8 个 join 码，也不在三类本地豁免；session delta 和 matrix 对错误帧/IO 的最终 join 归类是 `DIAL_FAILED`。当前测试若断言 `expectedResult`，会得到两个互斥答案。

**建议：**二选一并全层同步：

1. 保留 `expectedResult` 为 join 结果，将两例改为 `DIAL_FAILED`，另增 `readerOutcome: header-short-read|payload-short-read`；或
2. 将字段改名为 `expectedReaderResult`，新增 `expectedJoinResult: DIAL_FAILED`，并在 matrix/session delta 统一引用新字段。

不能用注释同时赋予一个字段两种语义。

### P1-3：issuer 映射仍非穷尽、且生产实现与文档不一致

`redeem-err.fixtures.json:4-10` 的表覆盖了 `BadPoP`、`InviteNotRoot`、`WrongFabric`、`InviteRecipientMismatch` 和 catch-all“其它结构化拒绝”，但没有逐项列出实际 `RosterError` 枚举中的 `InviteExpired`，也没有说明 `Protocol`、`Persistence` 在 redeem 前后各阶段的边界。`RosterError` 当前还包含 `InvalidRevokeTarget`、`NotFound`、`AlreadyExists` 等非 redeem 变体，契约应明确它们是 out-of-scope，而不是隐含落入“其它”。

当前 `session.rs:269-275,297-306` 仍发送旧文本 payload，`consume_invite == false` 仍直接返回且不发送 `Consumed` 记录。实现尚未落地本身不是文档错误，但 C0 必须规定所有生产分支的唯一结果，否则 F 只能验证 parser fixture，不能验证真实二次兑换、过期竞态和 BadPoP 路径。

此外“原因转可打印 ASCII、≤255B”没有冻结过滤、转义、截断顺序；不同实现可能产生不同 wire payload。

**建议：**在 C0 增加按 `RosterError` 变体的穷尽表：适用阶段、kind、payload 规范化算法、恰一条记录、发送后关闭；明确 `InviteExpired` 是 Other/TOKEN_INVALID 还是不走 issuer 帧，并为 `Protocol` 的 malformed-token 路径声明 joiner 已在拨号前拒绝的前提。

### P1-4：design D11 的 wire grammar 仍重复

design `:438` 仍完整重述外层帧、kind/len、短读、未知 kind、ASCII 呈现和 reduction，只在中间声称“完整 wire grammar 唯一权威定义见 JSON 与 matrix”。r11 修订注记宣称“重复副本删除”，但正文并未删除；matrix 自身也有一份 grammar。

这会让下一次边界修订再次产生三处不同步，直接违反本 change 要求的“全文唯一性”。

**建议：**C0 JSON 作为机器 fixture 权威，matrix 只保留短引用和覆盖索引，design D11 只描述决策及引用；删除 `:438` 的重复 grammar。保留 r11 顶部注记作为非规范历史即可。

### P1-5：覆盖入口仍少于声明的完整边界

1. 九个 fixture 的 `expectedRecords` 只实际构造了 kind `0x00`、`0x03` 和未知 `0x7f`；已知 `NotRoot(0x01)`、`BadPoP(0x02)` 没有 JSON 向量。tasks 3.5 说覆盖 known kinds，但只能依赖测试另造输入，C0 并未给出唯一样本。
2. 九个 fixture 没有非 ASCII payload；tasks 3.5 和 D10 要求非 ASCII 呈现层行为，当前只能靠未冻结的临时构造测试。
3. session delta 没有“多个 relay 同周期上线取配置序最小”的独立 scenario；tasks 3.5 有文字断言，但 delta 的可测行为没有 owner 对应。
4. design/matrix 已写 `joinTimeoutMs <= 5s` 外层优先、`>5s` 内层优先，但 session delta 只有“join 总时限更长”的内层场景，没有等值边界和两路关闭/附注的 scenario。该规则仍可能在实现时由 timer race 解释不同。

**建议：**扩充 JSON 至包含已知 kind 1/2、非 ASCII，以及 reader-vs-join 映射字段；在 session delta 增加 tie-break 和 `<=5s`/`>5s` 两个有界场景，并在 matrix owner 列逐项指向这些 scenario。

## 需求覆盖核对

| 需求或实测缺陷 | 结论 | 证据与剩余风险 |
| --- | --- | --- |
| relay 为空仍签发 invite | 覆盖 | D3、roster delta、tasks 3.1 有拒签门、显式 advertise 和逃生阀；实现待 F 落地。 |
| 一次性直连地址退出即死亡 | 覆盖 | relay/直连路径为空时拨号前 NO_REACHABLE_PATH；不把 hints 当签发地址。 |
| TTL 10 分钟过短 | 覆盖 | 默认 60m，1s-30d，0/999ms/溢出拒绝，固定时间测试。 |
| chat 对 relay 失败静默 | 基本覆盖 | watcher 流、快照优先、跳变、配置序 lastError、shutdown；tie-break scenario 仍缺。 |
| wrong-fabric 误报 corrupted | 覆盖 | DirFabricMismatch 与真损坏分离，16 hex 和冲突场景已冻结。 |
| 纯英文横幅、vite 风格 IP | 覆盖 | 多网卡枚举、占位行、NAME/PORT、ASCII 断言。 |
| gateway + services.json 单一入口 | 覆盖 | Host/IPv6/forwarded scheme/实际端口/no-store/nullable 和顶层 gateway null 已写。 |
| config list/get/set 与免手输 env | 覆盖 | 持久配置、优先级、隐式 custom、空项去重、原子写、零参/语法错/探测保存。 |
| proxy auto/on/off、多 relay 自动择优 | 覆盖 | D2 候选集合、代理覆盖、401/5xx 分层、全量交给 iroh 原生择优；matrix fixture 引用需修复。 |
| `--opt=value` 与 `~` 展开 | 覆盖 | D8 与 tasks 2.1 成对解析、展开、未知选项退出码。 |
| join 超时且零诊断 | 基本覆盖但未放行 | 8 码、探针、结构化拒绝、5s 规则均有；issuer 生产映射和 fixture 字段语义仍不唯一。 |

## Design 决策审查

### D1 gateway/services.json

Host 拒绝集合、IPv6 括号剥离、loopback 放行、无效 Host 回退、无回退地址时 `url:null`、实际端口、可信 forwarded scheme、no-store、未知名静默和重复 warning 已形成可实现契约。nullable fixture 的服务端精确 warning 已写入 JSON。server delta 与 tasks 1.2 逐项断言方向一致。

### D2 bootstrap 与 D7 proxy_url

状态机无环，代理决策只使用原始 URL/环境，地址解析使用已决策略；可达性（任意完整 HTTP 响应）与可用性（解析层 401/5xx 硬错误）分层。混合可达时 from-env 覆盖全部候选，空列表不发请求，n0 不探测。`None|FromEnv|Url` 由 Fabric 构造前决定，undici 为 example 显式依赖，QUIC 不经代理。当前主要问题是 C0 matrix 旧文件名导致实现验收入口不唯一。

### D3 invite 安全门与 D5 目录归属

relay 空且 advertise 为空拒签，allowRelayless 责任外置；wildcard、端口 0、重复地址等边界已写。DirFabricMismatch 避让 redeem_verify 的 WrongFabric，真损坏仍 Corrupted。两处与 roster delta 一致。

### D4 home_relay_status

直接消费 `.stream()`，任一 relay 在线、聚合态跳变、首值只入快照、配置序 `lastError`、shutdown abort+join 的主决策合理。D4 URL tie-break 的文字已在 design/tasks 出现，但缺少 session delta 的独立可测场景，属于契约覆盖缺口。

### D6 配置优先级

flag > env > file > default、disabled 整体覆盖、URLS 隐式 custom、空项过滤去重、n0、非法 JSON、事务写入和探测失败仍保存均可实现。n0 的 d.ts urls 已冻结为官方 URL。无新决策矛盾。

### D9/D10 TTL 与 ASCII

TTL 值域和溢出处理清楚。动态值按 UTF-8 byte 以小写 `\\xNN` 转义，控制字符也保持单行；但 example delta 只有非 ASCII 场景，没有控制字符独立场景，D10 的测试入口仍不足。

### D11 join 分类、探针和 reduction

令牌错误 -> 本地豁免 -> 目录归属 -> 空路径 -> 网络的顺序明确；2s transport-only 探针、四类确定性注入、8 码和本地三类豁免均覆盖主要路径。结构化记录嵌入既有 `REDEEM_ERR(0x14)` 外层，255 上限、未知 kind 消费和多记录 fail-closed 逻辑正确。

但 `IO_ERROR` 字段冲突、issuer 映射未穷尽、已知 kind/非 ASCII fixture 缺口以及 5s 等值 scenario 缺失，使“互斥穷尽且每码可构造”尚未完全可验。

## 五个 delta 与既有规格

| delta | 评价 |
| --- | --- |
| server | gateway/services、Host/IPv6/forwarded scheme、实际端口、disabled/null、未知静默、重复 warning 和 ASCII banner 可测。 |
| example-app | CLI、配置、TTL、bootstrap 代理覆盖、n0、gateway null、8 码和豁免 stderr 形式已覆盖；控制字符场景缺失。 |
| fabric/roster | invite 门、advertise 校验、wildcard/端口 0、逃生阀、DirFabricMismatch/真损坏边界一致。 |
| fabric/session | framing、九例意图、reduction、探针、issuerMapping 和 timeout 规则已有主线；matrix 仍引用旧 fixture，且等值/tie-break scenario 缺失。 |
| sdk/node | relayStatus、事件 payload、取消订阅、n0 URL、invite 三参、join timeout、错误前缀和 custom 非空元组一致；issuer 映射产生的真实错误仍待 F/4.1。 |

与既有主规格对照：`openspec/specs/fabric/session/spec.md` 的三段式 `REDEEM_INTENT -> CHALLENGE -> PROOF`、5s/32KiB 约束与 change 一致；SDK/example 的包名和生命周期勘误仍一致。既有主规格的“超长帧被拒”是通用资源边界，不与本 change 的记录短读语义冲突。

## 批次 S/E/F 并行审查

物理目录所有权仍互斥：S 管 server，E 管 `packages/example`，F 管 fabric/client-sdk，C0、锁文件、README、生成 d.ts 和主规格勘误由 ZCode 唯一维护。E 可用 mock 独立完成 args/config/bootstrap，F 可在公共 reader/writer 之上实现记录 parser；e2e 自起随机端口纪律也已写入 design/tasks。

但跨批 API 还存在三项阻塞：

1. F 的完成基准同时来自 matrix 旧 `.hex` 和 tasks 新 JSON，无法唯一判定 fixture 完成；
2. F 需要从 issuerMapping 推导生产发送行为，但 `InviteExpired`、Protocol 阶段和原因截断未冻结；
3. E/F 的等值 timeout、D4 tie-break、kind 1/2/非 ASCII 测试需要自行造 fixture 或场景，超出了“C0 先冻结、owner 行逐项覆盖”的承诺。

因此目录所有权虽互斥，契约所有权尚未足以让三批完全并行验收。

## 可操作的放行条件

1. 修正 matrix 的唯一 F 覆盖行，删除旧 `.hex` 引用并改指 JSON 九例；
2. 拆分 fixture 的 reader outcome 与 join result，统一 outer payload EOF -> DIAL_FAILED 的最终归类；
3. 将所有适用 `RosterError` 变体、阶段、kind、payload ASCII 规范化/截断及关闭语义写成穷尽 issuer 表，并把二次兑换、BadPoP、InviteExpired/RecipientMismatch 场景绑定到表；
4. 删除 design D11 的重复 wire grammar，仅引用 C0 JSON/matrix；补 kind 1/2、非 ASCII、D4 tie-break、5s 等值边界的结构化场景与 owner；
5. 全局搜索旧 fixture 名称和过时“七例”规范引用，重新运行 strict validate，并由 F 用既有 `read_frame/write_frame` 对所有 C0 case 做 round-trip、reader outcome 到 join code 的映射验证。

## 综合评分依据

| 维度 | 评价 |
| --- | --- |
| 需求覆盖 | 9.6/10：原始事故、TTL、chat/relay、wrong-fabric、CLI、gateway/services、配置、代理和 join 诊断都有落点。 |
| 技术决策一致性 | 8.5/10：外层 framing、bootstrap、探针、reduction、5s 优先级和 n0 均合理；issuer 分支与 wire grammar 仍有未冻结边界。 |
| 可测性与契约 | 7.6/10：JSON 九例长度正确且字段结构更好，但 matrix stale 引用、IO_ERROR 双语义、known-kind/ASCII/等值场景缺口会阻塞自动验收。 |
| 并行编排 | 8.1/10：S/E/F 物理 owner 清楚，C0 前置和 mock/e2e 边界合理；fixture 与 issuer 映射仍使 F/E 依赖跨文档猜测。 |

综合为 **8.3/10**，相对第十轮 **+0.3**。r11 已把 framing P0 推进到可复核状态，但在清理上述 P1 前仍不放行。
