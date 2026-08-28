# connectivity-ux-hardening 第十五轮评审

评审日期：2026-08-28

评审范围：`openspec/changes/connectivity-ux-hardening/` 的 proposal、design、tasks、五个 delta 和 C0 contracts；对照 `openspec/specs/` 既有规格以及当前 `crates/dweb-fabric/src/session.rs`、`roster.rs`。本轮只评审文档，不修改 change 或产品代码。

验证结果：

- `openspec validate connectivity-ux-hardening --strict` 通过。
- `redeem-err.fixtures.json` 可解析为 12 个 case，四个 expected 字段齐全，`expectedRecords` 统一为 `{kind:number,payloadHex,presented}`。
- issuerMapping 有 17 行；`variantId` 数量为 17 且全部唯一、ASCII；`emit=true` 行的 kind 均为 0..3，`emit=false` 行 kind 均为 null，所有行 `close=true`。
- 旧 `.hex`、九例/七例引用在规范区已清除，design 顶部历史注记明确为非规范。

## 结论与评分

**9.6/10（相对第十四轮 9.2，+0.4），放行。**

r15 已闭合 R14 的两项文档阻塞：issuer mapping 从聚合条件拆为稳定 `variantId` 行，且每行有显式 stage、emit、kind、payloadTemplate、joinerResult、close；tasks 3.4 明确要求删除旧裸文本 `REDEEM_ERR` 发送路径及 `consume_invite Ok(false)` 静默返回。C0 fixture、error-matrix、design、session delta 和 tasks 对同一 wire/reduction 语义的引用一致，具备进入实现和整合验收的条件。

当前 `session.rs` 仍是 r15 之前的生产代码（仍有旧文本错误帧和静默 `Ok(false)` 路径），但 change 明确把删除与 17 行映射列为 Batch F 的实现及测试门禁；这属于尚未执行的任务，不构成本文档评审的阻塞。4.1 必须证明实现已切换后才能归档。

## P0 闭合判断

### P0-1：代理所有权与 bootstrap

**闭合。** D2/D7 的状态机、候选集合判定、混合可达性代理覆盖、空列表/n0 不探测、Fabric 构造前的 `HttpProxyConfig` 决策和 undici 同策略均一致。QUIC 排除 HTTP proxy，401/407/500 的传输可达与解析层硬错误边界明确。

### P0-2：join 诊断、framing、issuer reduction

**闭合。** 12 个 fixture 覆盖外层/记录短读、0/255 边界、未知 kind、非 ASCII、多记录 fail-closed、reader outcome 与 join result 分层；issuer rows 已覆盖 session_entry、proof_frame、redeem_verify、consume_invite、post_consume 的生产动作。结构化错误帧和 no-frame 防御分支均有明确的 emit/close/result 口径。

## Issuer Mapping 审查

### 可直接 match 的粒度

17 个 `variantId` 已拆为稳定 ASCII id：

- session_entry：`entry-wrong-first-frame`、`entry-decode-invalid`；
- proof_frame：wrong frame type、bad length、bad redeemer key、peer mismatch 四行；
- redeem_verify：WrongFabric、InviteNotRoot、InviteExpired、RecipientMismatch、BadPoP、内部 Protocol 六行；
- consume_invite：`Ok(false)` 与 `RosterError::Persistence` 两行；
- post_consume：grant、receipt encode、REDEEM_OK write 三行。

每行均可由 stage + variantId 定位，`emit/kind` 关系机械可检查；`emit=true` 统一为 REDEEM_ERR(0x14) 外层单记录后关闭，`emit=false` 统一为无结构化帧关闭并由 joiner 得到 DIAL_FAILED。`RosterError::Persistence` 与其 IO source 已分开表达，动态 WrongFabric 原因通过 payloadTemplate 和既有 16 hex 规则归一化。

### tasks 删除要求

`tasks.md:41-42` 明确写入：删除旧文本 REDEEM_ERR 发送路径、删除 `Ok(false)` 静默返回；按 17 行 variantId 实现 emit 语义，并在 3.5 逐行断言结构化帧、无帧关闭、joiner 结果。此处已从建议变成可验收任务。

## 需求覆盖核对

| 需求或实测缺陷 | 结论 | 证据 |
| --- | --- | --- |
| relay 为空仍签发 invite | 覆盖 | D3 安全门、advertise 校验、allow-relayless 逃生阀。 |
| 一次性直连地址退出即死亡 | 覆盖 | 空路径拨号前 NO_REACHABLE_PATH，不混入运行时 hints。 |
| TTL 10 分钟过短 | 覆盖 | 默认 60m，1s-30d 值域和边界场景。 |
| chat 对 relay 失败静默 | 覆盖 | home relay stream、快照优先、跳变事件、lastError、tie-break、shutdown。 |
| wrong-fabric 误报 corrupted | 覆盖 | DirFabricMismatch 与真 Corrupted 分离。 |
| 纯英文横幅、vite 风格 IP | 覆盖 | ASCII、IPv4 枚举、无回退地址和服务表场景。 |
| gateway + services.json 单一入口 | 覆盖 | Host/IPv6/forwarded scheme/实际端口/nullable/no-store。 |
| config list/get/set 与免手输 env | 覆盖 | 优先级、URLS 隐式 custom、空项去重、原子写、错误事务。 |
| proxy auto/on/off、多 relay 择优 | 覆盖 | 候选集合代理覆盖、硬错误、n0、iroh 原生择优。 |
| `--opt=value` 与 `~` 展开 | 覆盖 | 双形式等价、波浪号展开、未知选项退出码。 |
| join 超时且零诊断 | 覆盖 | 8 码总函数、2s 探针、结构化拒绝、12 fixture、5s 边界及 CLI 契约。 |

## Design、delta、C0 一致性

- D1/D3/D4/D6/D7/D9/D10/D11 与 server、example-app、fabric/roster、fabric/session、sdk/node delta 对齐；没有发现 r15 新增的优先级、Host、relay 状态、TTL 或 ASCII 矛盾。
- C0 JSON 是 wire 与 issuer mapping 的唯一机器权威；error-matrix 只索引 12 个 case、四字段口径和 reduction 摘要；design D11 是决策摘要，delta 是 capability 行为规范，职责边界清楚。
- issuerMapping 的 `_schema`、17 行 invariant、`_fTestOwner` 与 tasks 3.4/3.5 同步；五个 delta 的 Scenario 可由这些行和 fixture 构造，未再出现旧数量或旧 fixture 路径。
- 与既有主规格的三段式兑换流程、32 KiB/5s 资源边界、工厂构造 + `shutdown()`、n0 默认 relay 和错误前缀无冲突。

## 批次 S/E/F 并行审查

S/E/F 的物理目录所有权继续互斥，C0、lockfile、README、生成 d.ts 和主规格勘误由 ZCode 唯一维护。E 可独立 mock bootstrap/CLI，F 可用 12 fixture 和 17 rows 做纯函数/内核测试，S 不依赖 F 的内部文件。跨批只保留已显式写入 C0 的 API、错误码、fixture 和 4.1 联测契约，足以并行。

## 实施门禁（非文档阻塞）

归档前仍必须由 F/4.1 证明：

1. `session.rs` 删除旧文本 REDEEM_ERR，并按 emit 行写入外层 0x14 单记录。
2. `Ok(false)` 发送 canonical Consumed 记录，所有 emit=false 行无结构化帧且连接关闭。
3. 17 个 variantId 都有确定性构造测试，post-consume 失败不依赖隐式 `?` 传播。
4. 12 个 fixture 用既有 read_frame/write_frame round-trip 和负例验证，随后完成 S/E/F 联测与全量门禁。

这些是 tasks 中已经冻结的实现验收条件，不再降低 change 文档的放行结论。

## 综合评分依据

| 维度 | 评分 | 依据 |
| --- | ---: | --- |
| 需求覆盖 | 10.0/10 | 原始事故、CLI、gateway/services、代理、relay 状态、TTL 与 join 诊断均有明确且可测落点。 |
| 技术决策一致性 | 9.6/10 | bootstrap、探针、framing、reduction、timeout 和 issuer 阶段均已闭合。 |
| 可测性与契约 | 9.4/10 | 12 case 与 17 rows 的 schema、唯一 id、emit/kind/close 约束可机械检查。 |
| 并行编排 | 9.5/10 | C0 前置、S/E/F ownership、测试 owner 和 4.1 边界清楚。 |

综合为 **9.6/10**，相对第十四轮 **+0.4**。change 文档达到放行线。
