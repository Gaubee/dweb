# connectivity-ux-hardening 第十四轮评审

评审日期：2026-08-28

评审范围：`openspec/changes/connectivity-ux-hardening/` 的 proposal、design、tasks、五个 delta 和 C0 contracts；对照 `openspec/specs/` 以及当前 `crates/dweb-fabric/src/session.rs`、`roster.rs`。本轮只评审文档，不修改 change 或产品代码。

验证：`openspec validate connectivity-ux-hardening --strict` 通过。`redeem-err.fixtures.json` 可解析为 12 个 case；12 个 case 均具备四个期望字段，`expectedRecords` 统一为 `{kind:number,payloadHex,presented}`。对完整外层头的向量复核了 `u32_be(1+payload_len)+type+payload` 长度和记录边界；规范区的“九例/七例”和旧 `.hex` 引用已清除，剩余仅是 design 顶部标明“非规范历史”的修订记录。

## 结论与评分

**9.2/10（相对第十三轮 9.0，+0.2），暂不放行。**

r14 已解决 R13 的主要 C0 缺口：issuer mapping 改为 rows 数组，字段含 `stage/variant/emit/kind/payloadTemplate/joinerResult/close`；`emit=true` 才适用原因归一化；入口、proof、verify、consume、post-consume 阶段分开；matrix 只索引 JSON；12 个 wire fixture 的 schema 和字节向量保持一致。

阶段顺序与现有 session 控制流总体一致，但 rows 仍不是可无歧义 `match` 的最终机器契约：若干 variant 是多个条件的自由文本合并，`consume_invite` 把实际 `RosterError::Persistence` 与 IO 来源混成一个标签，且部分 variant 仍嵌入中文说明。另一个可验证的落差是当前 session 实现仍发送旧的裸文本 `REDEEM_ERR`，与 r14 规定的 no-frame/结构化单记录动作不同。故评分上调但仍不放行。

## P0 闭合判断

### P0-1：代理所有权与 bootstrap

**已闭合。** D2/D7 仍是“原始候选规范化 -> 代理决策 -> 以已决策略解析”；auto 按候选集合判定，混合场景统一 `from-env`，n0 不探测，QUIC 不经 HTTP proxy。Fabric 构造前得到显式 proxy 值，Node 侧使用 undici 同策略，401/407/500 的传输可达与解析硬错误分层无新冲突。

### P0-2：join 诊断、framing、reduction

**wire 和分类契约已闭合，生产发送路径待落地。** 12 例覆盖 reader 层/记录层短读、0/255、未知 kind、非 ASCII、多记录 reduction、两层 timeout；`expectedReaderOutcome` 与 `expectedResult` 语义唯一。issuer rows 已能定位大多数错误到阶段，但下述 P1 仍使 join 端到端行为不能仅由 C0 验收。

## 阻塞问题

### P1-1：rows 的 variant 尚未达到直接 `match` 的枚举粒度

`contracts/redeem-err.fixtures.json:28-35` 将首帧类型错误、长度错误、redeemer key 解析错误和 TLS peer 不匹配合并成一个 `proof_frame` 自由文本；`:112-119` 又将 `grant`、事实编码和 `REDEEM_OK` 写入失败合并成一个 `post_consume` 条目。它们虽然结果相同，但触发点、可构造方式、是否已消费 invite 以及测试注入点不同，不能由一个 variant 直接生成 Rust 分支覆盖证明。

`:103-109` 的 `Err(Persistence/IO)` 也不是实际 enum discriminant；`consume_invite()` 返回的是 `RosterError::Persistence { .. }`，IO 是其 source。当前 rows 的 `_schema` 声称 `variant` 使用实际标识，但这些聚合标签与该声明不符。`:19` 的 `InviteToken::decode 失败`、`:85` 的 `RosterError::Protocol（token.verify() 内部）`、`:29` 的中文条件串也仍不是无注释的稳定标识。

**可操作修改：**

1. 将 `proof_frame` 拆成四行（wrong frame type、proof length、redeemer key parse、peer mismatch），将 `post_consume` 拆成 `grant`、`encode_receipt`、`write_redeem_ok` 三行；每行提供确定性注入句柄和同一 `emit=false/close=true/DIAL_FAILED` 结果。
2. 将 `consume_invite` 行写成 `RosterError::Persistence`，另用 `sourceClass` 或 `note` 描述 IO；入口条件使用 ASCII 稳定 id（例如 `decode-invalid`），解释文字移至 `note`。
3. `_schema` 增加 `variantId`/`sourceClass` 的允许值，F 测试逐行绑定这些 id，避免用自然语言分组代替穷尽表。

### P1-2：文档动作与当前 session 实现仍不一致

r14 rows 规定 session_entry、proof_frame、内部 Protocol、Persistence、post_consume 失败均 `emit=false`，或仅在明确的 `emit=true` verify/consume 行发送结构化单记录。当前 `session.rs:259-275` 对错误首帧和 `InviteToken::decode` 失败仍写入裸字符串 `REDEEM_ERR`；`:299-301` 对 `redeem_verify` 错误也写入 `e.to_string()`；`:303-306` 对 `Ok(false)` 直接返回而没有发送 `Consumed` 记录。这些是待 F 实现的预期改动，但在进入整合前必须由测试证明，否则 C0 的 issuer rows 只是声明而非可验证的端到端契约。

**可操作修改：**在 tasks 3.4/3.5 明确“旧文本 REDEEM_ERR 发送路径必须删除”；为每个 `emit=true` row 断言外层 0x14 + 单条记录，为每个 `emit=false` row 断言没有结构化帧、连接关闭、joiner `DIAL_FAILED`；为 `Ok(false)` 绑定 canonical fixture 并断言 `TOKEN_CONSUMED`。

## 需求覆盖核对

| 需求或实测缺陷 | 结论 | 证据与剩余风险 |
| --- | --- | --- |
| relay 为空仍签发 invite | 覆盖 | D3、advertise 校验和 allow-relayless 逃生阀一致。 |
| 一次性直连地址退出即死亡 | 覆盖 | 空路径拨号前 `NO_REACHABLE_PATH`，不混入运行时 hints。 |
| TTL 10 分钟过短 | 覆盖 | 默认 60m，值域 1s-30d，边界场景明确。 |
| chat 对 relay 失败静默 | 基本覆盖 | watcher 流、快照优先、lastError、tie-break、shutdown 均有；实现待 F。 |
| wrong-fabric 误报 corrupted | 覆盖 | `DirFabricMismatch` 与真 `Corrupted` 分离。 |
| 英文横幅与 vite 风格 IP | 覆盖 | ASCII 码位、非 loopback IPv4 和无回退地址均有场景。 |
| gateway + services.json 单一入口 | 覆盖 | Host 拒绝集合、IPv6、forwarded scheme、实际端口、nullable/no-store 均有。 |
| config list/get/set 与免手输 env | 覆盖 | 优先级、URLS 隐式 custom、空项去重、事务写入和错误场景齐全。 |
| proxy auto/on/off、多 relay 择优 | 覆盖 | 候选集合代理覆盖、硬错误、n0 和 iroh 原生择优已冻结。 |
| `--opt=value` 与 `~` 展开 | 覆盖 | 双形式等价、波浪号和未知选项退出码有场景。 |
| join 超时且零诊断 | 基本覆盖但未放行 | 8 码、探针、wire fixture、issuer rows 均有；发送路径尚未切换且 rows 仍需细分。 |

## Design、delta、C0 与批次

- D1/D3/D4/D6/D7/D9/D10 和五个 delta 的核心规则无新冲突；tie-break、控制字符、n0 和 12 case 引用均已对齐。
- D11 已声明 JSON 是 wire/issuer 的唯一机器权威，matrix 仅列 case 名、四字段口径和 reduction 摘要；当前 matrix 不再重复字段值。session delta 仍以规范语言重述行为，这是 capability 规格需要，不构成第二个机器 fixture。
- S/E/F 目录 ownership、C0 前置、lockfile/README/d.ts 唯一 owner 和 4.1 整合边界仍互斥。E 可独立 mock，F 的 fixture reader 和 issuer rows 仍受 P1 的 variant 粒度影响；修正后可并行。
- 与既有 `fabric/session` 主规格的三段式 `INTENT -> CHALLENGE -> PROOF`、32 KiB/5s 和工厂 + `shutdown()` 无冲突；本轮没有发现旧数量或旧 `.hex` 规范引用残留。

## 放行条件

1. 将 issuer rows 的聚合 variant 拆成稳定 ASCII id，并为每一行给出实际 source/discriminant、注入构造、emit、kind、payload、close 和 joiner result。
2. 删除 session.rs 的旧文本 `REDEEM_ERR` 发送和 `Ok(false)` 静默返回，按 rows 实现结构化单记录或 no-frame 关闭。
3. F 逐行测试并在 4.1 证明入口/verify/consume/post-consume 的结构化帧、连接关闭和最终错误码；保留 12 个 fixture 的 round-trip/负例覆盖。
4. 重新运行 strict validate、fixture 字节校验和规范区旧引用搜索。

## 综合评分依据

| 维度 | 评分 | 依据 |
| --- | ---: | --- |
| 需求覆盖 | 9.9/10 | 原始事故、TTL、relay/chat、wrong-fabric、CLI、gateway/services、配置、代理和诊断均有落点。 |
| 技术决策一致性 | 9.3/10 | bootstrap、framing、reduction、探针、timeout 和阶段顺序合理；发送路径仍待实现对齐。 |
| 可测性与契约 | 8.8/10 | 12 case 和 rows 字段显著增强；variant 聚合与自由文本仍阻碍直接 match。 |
| 并行编排 | 9.2/10 | C0、owner 和批次边界清楚；issuer rows 细分完成后即可无歧义并行。 |

综合为 **9.2/10**，相对第十三轮 **+0.2**。r14 已接近放行线，但 issuer rows 的可执行粒度和 session 生产发送路径仍需闭合，暂不放行。
