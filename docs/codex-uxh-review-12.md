# connectivity-ux-hardening 第十二轮评审

评审日期：2026-08-28

评审范围：openspec/changes/connectivity-ux-hardening/ 的 proposal.md、design.md、tasks.md、五个 delta、C0 contracts；对照 openspec/specs/ 既有规格以及当前 crates/dweb-fabric/src/session.rs、roster.rs。本轮只评审文档，不修改 change 或产品代码。

验证：openspec validate connectivity-ux-hardening --strict 通过。另以 Node JSON 解析和当前 write_frame/read_frame 的长度算法复核 fixture。严格校验不能发现 tasks 文案残留、字段缺省、authority 层重复，亦不证明 issuer 代码已经切换到新 wire。

## 结论与评分

**8.6/10（相对第十一轮 8.3，+0.3），暂不放行。**

r12 已解决第十一轮最实质的分类问题：C0 fixture 的 expectedReaderOutcome 与 expectedResult 分离，两层短读最终都指向 DIAL_FAILED；十二个向量的外层长度、记录边界和已知 kind 0x00-0x03 均可按现有公共 reader/writer 解释；issuer 映射已覆盖过期竞态、PoP、root、recipient、fabric 和内部错误策略；tie-break、控制字符、n0、豁免 CLI 和 5s 等值场景也落到了对应 delta。

但契约尚未达到“全文唯一且可机械验收”：tasks.md 仍声明九例，新增三例有字段缺省且 payload 期望表示不统一；matrix 虽已改引用 JSON，仍保留一整份 wire grammar 而非仅索引；issuerMapping 的首个键不是实际 RosterError 变体名，且未把 redeem 阶段边界与当前枚举逐项绑定。上述问题会使 C0、F 和整合验收对完成条件产生不同解释，故仍不放行。

## P0 闭合判断

### P0-1：代理所有权与 bootstrap

**已闭合。** D2 的顺序仍是“规范化 -> 代理决策（原始候选） -> 地址解析（已决策略）”，auto 按候选集合决定 none/from-env，混合部署统一走代理解析；n0 不探测，QUIC 不经 HTTP proxy；HttpProxyConfig 的 None/FromEnv/Url 在 Fabric 构造前决定。C0 matrix 无新的 proxy URL 或 DWEB_RELAY_URLS 冲突。

### P0-2：join 诊断、framing 与 reduction

**协议 framing 已闭合，分类契约接近闭合。** session.rs:70-104 的算法为：

    u32_be(1 + payload_len) + type(1B) + payload

JSON 十二例均为无空格连续 hex。复核得到：canonical、other、unknown、two-records、len-255-other、zero-len-other、not-root、bad-pop、non-ascii-payload 的外层长度和 payload 边界正确；inner-truncated 在 read_frame 成功后于记录层短读；outer-header-truncated 在 5B 外层头之前 EOF；outer-payload-truncated 的长度域大于实际 payload，read_frame 在 payload 段 EOF。两层短读均以 expectedReaderOutcome 区分，并以 expectedResult=DIAL_FAILED 作为 join 最终结果。

reduction 也已是 fail-closed：恰一条 Consumed -> TOKEN_CONSUMED，恰一条其它已知 -> TOKEN_INVALID，多条完整消费后 -> TOKEN_INVALID，未知 kind 按 len 消费并作为 Other。len=255 的总帧长 262B 与单字节长度域一致。

## 阻塞问题

### P1-1：tasks 仍把十二例写成九例

tasks.md:42 仍写“以 contracts/redeem-err.fixtures.json 九例结构化向量为基准”，而 matrix:71-75、JSON 本身和 design r12 注记均为十二例。这是规范任务正文，不是历史注记；F 的完成报告按 tasks 仍可能漏测 not-root、bad-pop、non-ascii-payload。

**建议：**改为十二例，并把四个字段断言及 issuerMapping 消费要求保留在同一行；全局搜索“九例/七例”时仅允许非规范历史注记出现。

### P1-2：十二例 JSON 的字段/schema 仍不完全自洽

1. r12 要求每例包含 expectedViolation，但 not-root、bad-pop、non-ascii-payload 三例缺少该字段（解析后为 undefined，不是显式 null）。
2. expectedRecords 的 kind 在多数 case 为 JSON number，unknown-kind 却是字符串 “0x7F”；机器测试必须额外支持两种类型，C0 没有冻结该 schema。
3. non-ascii-payload 的 hex 是 UTF-8 e4b8ad，但 expectedRecords payload 是字面量字符串 \\u00e4\\u00b8\\u00ad，既不是原始 payload bytes，也不是注记所说的“呈现层剥除后空原因”。这会让逐例断言 expectedRecords 产生不同答案。

**建议：**每例显式补 expectedViolation:null；将记录改成结构化对象 { kind:number, payloadHex:string, presented:string }（未知 kind 用 127），或至少统一 kind 数字、payload 原始 hex 与呈现值三者的定义。非 ASCII 例应明确 payloadHex=e4b8ad、presented=""。

### P1-3：matrix 仍重复完整 wire grammar，和“仅索引”声明冲突

design:446 已将 D11 压缩为决策摘要，并声明 JSON 是机器 grammar 唯一权威、matrix 只作索引；但 contracts/error-matrix.md:54-79 仍完整描述外层帧、记录长度、未知 kind、短读、ASCII 呈现、reduction 和映射。这使 JSON、matrix、delta 三处继续成为可漂移的规范副本。

**建议：**matrix 保留错误分类表、JSON case 名称和测试 owner 索引；wire grammar、issuerMapping 和每例字段只引用 JSON。若保留摘要，必须标为非规范且不得重复字段值。

### P1-4：issuerMapping 的“穷尽”仍有伪变体和阶段歧义

redeem-err.fixtures.json:6 将 consume_invite==false 命名为 redeem_verify::InviteConsumed，但实际 RosterError 没有 InviteConsumed 变体，消费结果来自独立的 consume_invite() -> Ok(false)。表虽在语义上表达了 Consumed，但无法直接作为 Rust match 覆盖证明。

此外，表把 InviteExpired -> Other("invite expired") 作为 issuer 竞态兜底，却没有把每个 redeem_verify 阶段与 joiner 的前置分类绑定；Protocol 解码失败“不发帧”的防御分支也需要明确只适用于 issuer 接收到绕过 joiner 前置 decode 的异常输入。当前 session.rs:269-275,297-306 仍发送旧文本或在 consume_invite==false 时不发帧，说明文档到生产发送路径尚未形成可验证的端到端闭环。

**建议：**把表改为显式阶段/结果矩阵：redeem_verify 每个实际变体（WrongFabric、InviteNotRoot、InviteExpired、InviteRecipientMismatch、BadPoP、Protocol）及独立 consume_invite 结果各占一行；对 Persistence/Corrupted/DirFabricMismatch/InvalidRevokeTarget/NotFound/AlreadyExists 标注适用阶段和 out-of-scope。每行指定 kind、payload normalization、恰一条记录、发送后关闭，并为 F 的测试 owner 绑定具体枚举构造。

## 需求覆盖核对

| 需求或实测缺陷 | 结论 | 证据与剩余风险 |
| --- | --- | --- |
| relay 为空仍签发 invite | 覆盖 | D3、roster delta、tasks 3.1 的拒签门、advertise 校验和逃生阀已一致。 |
| 一次性直连地址退出即死亡 | 覆盖 | 空路径拨号前 NO_REACHABLE_PATH；不混入运行时 hints。 |
| TTL 10 分钟过短 | 覆盖 | 默认 60m，值域 1s-30d，溢出/0/999ms 场景明确。 |
| chat 对 relay 失败静默 | 基本覆盖 | home relay watcher、快照优先、跳变、配置序 lastError、tie-break 与 shutdown 均有；实现待 F。 |
| wrong-fabric 误报 corrupted | 覆盖 | DirFabricMismatch 与真损坏分离，16 hex 与冲突场景一致。 |
| 纯英文横幅、vite 风格 IP | 覆盖 | 全 ASCII、非 loopback IPv4 枚举、无地址占位和服务表均有。 |
| gateway + services.json 单一入口 | 覆盖 | Host/IPv6/forwarded scheme/实际端口/no-store/nullable 与 gateway null 语义均有。 |
| config list/get/set 与免手输 env | 覆盖 | 优先级、隐式 custom、空项去重、原子写、零参/语法错/探测保存均有。 |
| proxy auto/on/off、多 relay 自动择优 | 覆盖 | 候选集合代理覆盖、401/5xx 硬错、n0 不探测、全量交给 iroh 原生择优。 |
| --opt=value 与 ~ 展开 | 覆盖 | 双形式等价、展开、未知选项退出码有 tasks 与 delta 场景。 |
| join 超时且零诊断 | 基本覆盖但未放行 | 8 码、探针、两层短读、结构化拒绝和 5s 等值规则已写；issuer 生产映射与 C0 schema 仍有歧义。 |

## Design 决策审查

### D1 / D3 / D5：服务清单、invite 门和目录错误

Host 拒绝集合、IPv6 括号、loopback、回退 IPv4、nullable/no-store、实际服务端口、advertise wildcard/端口 0、allowRelayless 和 DirFabricMismatch 均与对应 delta 一致。没有发现新的 Host 派生或安全门矛盾。

### D4 home_relay_status

直接消费 watcher stream，任一 relay 在线，聚合态跳变才发事件，首值只进快照，配置序最小 URL tie-break，shutdown abort+join；session delta 已有“同周期上线”场景。该处 R11 报告的缺口已由当前工作树修复。

### D6 / D7：配置优先级与 proxy_url

flag > env > file > default、disabled 整体覆盖、URLS 隐式 custom、n0 固定官方 URL、auto 候选集合判定和 Fabric 构造前显式 proxy 均闭合。DWEB_RELAY_URLS 空项过滤及 proxy env 顺序没有新冲突。

### D8 / D9 / D10：CLI 参数、TTL 与 ASCII

双形式参数、~ 展开、TTL 值域/溢出和 UTF-8 byte 的小写 \\xNN 转义（含控制字符）均已有 delta/tasks 场景。R11 报告称控制字符场景缺失已被当前 example delta 修复。

### D11：join 分类、探针和 wire

有序总函数、2s transport-only 探针、8 码、三类本地豁免、两层短读、未知 kind 消费和 fail-closed reduction 结构合理；joinTimeoutMs <=5s 外层优先、>5s 内层优先且两路关连接已进入 session delta。剩余风险集中在 C0 JSON schema、matrix 重复定义和 issuer mapping 的实际枚举闭合。

## 五个 delta、C0 与既有规格

| delta | 评价 |
| --- | --- |
| server | gateway/services、Host/IPv6/forwarded scheme、实际端口、nullable、未知静默/重复 warning 和 ASCII banner 可测，无新冲突。 |
| example-app | CLI、配置、bootstrap、n0、控制字符、8 码和豁免 stderr 已覆盖；不依赖真实 SDK 的 mock 边界清楚。 |
| fabric/roster | invite 安全门、advertise 校验、wildcard/端口 0、逃生阀、DirFabricMismatch/Corrupted 一致。 |
| fabric/session | watcher tie-break、两种 timeout、framing、reduction、探针和冲突顺序齐全；tasks 的九例残留仍与 C0/matrix 矛盾。 |
| sdk/node | relayStatus 三态、n0 URL、事件 payload、取消订阅、invite 三参、proxy/timeout 和错误前缀一致；真实 issuer 错误帧仍待 F 落地。 |

与主规格对照：openspec/specs/fabric/session/spec.md 的三段式 REDEEM_INTENT -> CHALLENGE -> PROOF、5s/32KiB 约束一致；SDK/example 的工厂 + shutdown() 与包名勘误一致。既有通用“超长帧被拒”场景不与本 change 的记录短读规则冲突。

## 批次 S/E/F 并行审查

S、E、F 的物理目录所有权仍互斥，C0/锁文件/README/生成 d.ts/主规格勘误由 ZCode 唯一维护。E 可独立 mock bootstrap 与 CLI，F 可基于公共 reader/writer 做 JSON fixture parser，4.1 再做真实联测；随机端口和受控资源纪律清楚。

当前仍有三项跨批依赖：

1. tasks 仍是九例，matrix 是十二例，F 完成口径不唯一；
2. JSON expectedRecords 的 kind/payload 表示不统一，E/F 需要自行决定解析方式；
3. issuerMapping 不是可直接对照 Rust 枚举的穷尽表，F 无法仅凭 C0 选择发送时机和关闭语义。

因此批次目录边界成立，但 C0 契约尚未达到无歧义并行验收。

## 可操作的放行条件

1. 将 tasks 3.5 的九例更新为十二例，清理全文非历史的旧数量/旧 fixture 引用。
2. 为全部 case 补齐 expectedViolation；统一 expectedRecords 为数值 kind + 原始 payload 表示，并显式记录非 ASCII 的呈现结果。
3. 删除 matrix 的重复 wire grammar，使其只保留 JSON case/owner 索引；保留 JSON 为唯一机器权威。
4. 将 issuerMapping 改成真实 RosterError/consume_invite 阶段穷尽表，冻结 normalization、截断、单帧/关闭语义，并由 F 添加对应构造场景。
5. 重新执行 strict validate、旧引用全局搜索和 fixture round-trip；在进入 4.1 前，由 F 证明 expectedReaderOutcome -> expectedResult 映射以及 issuer-to-join 的结构化帧路径。

## 综合评分依据

| 维度 | 评价 |
| --- | --- |
| 需求覆盖 | 9.8/10：原始事故、TTL、chat/relay、wrong-fabric、CLI、gateway/services、配置、代理和 join 诊断均有明确落点。 |
| 技术决策一致性 | 8.8/10：framing、reduction、探针、5s 优先级、n0、D1/D2/D4/D6/D7/D10 主路径合理；issuer 枚举阶段仍需精确化。 |
| 可测性与契约 | 7.9/10：十二例边界和字段分层显著改善，但 tasks 数量残留、字段缺省/异构和 matrix duplicate 会阻塞机械验收。 |
| 并行编排 | 8.4/10：S/E/F owner 与 C0 前置清楚；F 的 issuer mapping 和 fixture schema 仍需补一次统一冻结。 |

综合为 **8.6/10**，相对第十一轮 **+0.3**。r12 已使两个原 P0 达到可复核状态，但上述 P1 未清理前仍不放行。
