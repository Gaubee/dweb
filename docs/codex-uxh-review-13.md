# connectivity-ux-hardening 第十三轮评审

评审日期：2026-08-28

评审范围：`openspec/changes/connectivity-ux-hardening/` 的 proposal、design、tasks、五个 delta，以及 C0 contracts；对照 `openspec/specs/` 既有规格和当前 `crates/dweb-fabric/src/session.rs`、`roster.rs`。本轮仍只评审文档，不修改 change 或产品代码。

验证：`openspec validate connectivity-ux-hardening --strict` 通过。当前 fixture JSON 可解析为 12 个 case；每个 case 都具备 `expectedReaderOutcome`、`expectedRecords`、`expectedResult`、`expectedViolation`，`expectedRecords` 统一为 `{kind:number,payloadHex,presented}`。对有完整外层头的 case 复核了 `u32_be(1+payload_len)+type+payload` 长度和记录边界；旧 `.hex` 路径及“九例/七例”只在 design 顶部的非规范历史注记中出现。

## 结论与评分

**9.0/10（相对第十二轮 8.6，+0.4），暂不放行。**

r13 已实质解决 R12 的三个契约问题：tasks 统一十二例，fixture 字段和 payload 表示统一，matrix 不再复制 wire grammar。两个原 P0 的主体设计也已稳定：代理决策先于 Fabric 构造且按候选集合覆盖；外层 framing、短读分层、未知 kind 消费、fail-closed reduction 与 5 秒边界均有可测入口。

剩余风险集中在 issuer 生产映射表的可执行性，而非 fixture 字节本身。`issuerMapping` 仍有“全局每行发一条记录”与两条“不发帧”分支的文字冲突；`Protocol` 行把 session 入口的 `InviteToken::decode` 与 `redeem_verify` 内部 `RosterError::Protocol` 混成同一阶段。F 可以凭经验实现，但不能仅凭 C0 表做无歧义的 `match` 和发送时机验收，因此仍不放行。

## P0 闭合判断

### P0-1：代理所有权与 bootstrap

**已闭合。** D2、example delta 和 error-matrix 共同冻结“规范化原始候选 -> 代理决策 -> 以已决策略解析地址”的无环顺序；auto 按全部候选判断，混合直连/代理可达时统一以 `from-env` 解析全部候选，空列表不发请求，n0 不探测。`HttpProxyConfig` 在 Fabric 构造前决定，QUIC 不经 HTTP proxy，Node 侧明确使用 undici 同策略。决策表的 401/407/500 传输可达与解析层硬错误分层也无新冲突。

### P0-2：join 诊断、framing 与 reduction

**协议和分类主体已闭合，issuer 入口仍有契约阻塞。** C0 JSON 的 12 个外层向量覆盖 canonical、Other、unknown、双记录、0/255 边界、内层短读、外层头/载荷短读、NotRoot、BadPoP、非 ASCII；短读分别由 reader outcome 表示，join 最终统一为 `DIAL_FAILED`。记录格式、未知 kind 按长度消费、零长 Other、多记录 fail-closed 和 `expectedRecords` 原始字节表示已经唯一化。

## 阻塞问题

### P1-1：issuerMapping 的发送语义自相矛盾，且 Protocol 阶段错位

`contracts/redeem-err.fixtures.json:5` 的 `_normalization` 写的是“每行恰一条记录发送，发送后关闭连接”。同一表的 `redeem_verify::Protocol`（:38-40）和 `consume_invite Err(Persistence/IO)`（:50-53）又明确要求“不发帧直接关闭”。按字面读取时，F 既不能同时满足“每行一条”与“不发帧”，也不能判断是否应断开前先等待任何写入。

此外，表中 `RosterError::Protocol（令牌解码失败）` 被放在 `redeem_verify` 阶段，但当前真实流程在 `session.rs:269-275` 先调用 `InviteToken::decode`；`redeem_verify` 内部的 `RosterError::Protocol` 来自 `token.verify()`（`roster.rs:831-837`），不是入口 decode。两者都可能是协议错误，但触发阶段、是否已经发出 CHALLENGE、以及 joiner 可观察结果不同。表若用于直接生成 `match`，会把入口防御分支误当成 redeem_verify 分支。

**可操作修改：**

1. 将 `_normalization` 限定为 `emit=true` 的记录行；每行增加明确的 `emit: true|false`、`close: true`，禁止用全局句子覆盖 no-frame 行。
2. 把 `session_token_decode` 单列为入口阶段（`InviteToken::decode`/非法首帧：`emit=false`、直接关闭、joiner `DIAL_FAILED`）；把 `redeem_verify` 行改为实际可出现的 `RosterError::Protocol(ProtocolError::Quarantine|Encoding)`，并指定其构造方式。
3. 增加 `post_consume`/receipt 阶段的失败策略，至少覆盖 `grant`、事实编码和 `REDEEM_OK` 写入失败；若统一归内部关闭，也要在表中显式标为 out-of-scope，而不是让 `?` 的传播行为成为隐含契约。

### P1-2：issuerMapping 尚未达到“可直接 match”的机器契约粒度

表的 `variant` 是带中文注释的自由文本（如 `RosterError::Protocol（令牌解码失败）`），`kind` 使用 `"Other"`/`"NotRoot"` 等符号名，`payload` 还是“两 fabric 16hex 短标识”“(空)”等模板。它能供人理解，但不能由测试工具直接校验 Rust enum 覆盖、discriminant 数值、payload 字节或 joiner reduction。JSON 的 case 部分已经结构化，issuer 部分却仍是半结构化文本，C0 的“唯一机器权威”因此只对 reader/reduction 成立。

**可操作修改：**把 issuerMapping 改成正式数组 schema，例如 `{stage, variant, emit, kind:number|null, payloadTemplate/payloadHex, joinerResult, close}`；`kind` 使用 0..3 数值，`variant` 使用不带解释文字的实际枚举标识，说明字段另放 `note`。对动态 fabric/path 原因给出模板参数和归一化后断言，而不是只写自然语言。F 的 `_fTestOwner` 再逐行绑定构造函数/fixture 名。

## 需求覆盖核对

| 需求或实测缺陷 | 结论 | 证据与剩余风险 |
| --- | --- | --- |
| relay 为空仍签发 invite | 覆盖 | D3、roster delta、advertise 校验和 allow-relayless 逃生阀一致。 |
| 一次性直连地址随进程退出死亡 | 覆盖 | 无地址令牌在拨号前 `NO_REACHABLE_PATH`；签发不混入运行时 hints。 |
| TTL 10 分钟过短 | 覆盖 | 默认 60m，值域 1s-30d，0/999ms/溢出有场景。 |
| chat 对 relay 失败静默 | 基本覆盖 | `home_relay_status()` 流、快照优先、跳变、lastError 聚合和 shutdown 均有；实现待 F。 |
| wrong-fabric 误报 corrupted | 覆盖 | `DirFabricMismatch` 与真 `Corrupted` 分离，冲突场景冻结。 |
| 纯英文横幅、vite 风格 IP | 覆盖 | ASCII 断言、非 loopback IPv4、无回退地址和服务表场景齐全。 |
| gateway + services.json 单一入口 | 覆盖 | Host 拒绝集合、IPv6、forwarded scheme、实际端口、nullable/no-store 均有。 |
| config list/get/set 与免手输 env | 覆盖 | 优先级、URLS 隐式 custom、空项去重、原子写、零参/语法错/探测保存均有。 |
| proxy auto/on/off、多 relay 自动择优 | 覆盖 | 候选集合覆盖、统一代理、401/5xx 硬错、n0 和 iroh 原生择优均有。 |
| `--opt=value` 与 `~` 展开 | 覆盖 | 双形式等价、展开、未知选项退出码场景齐全。 |
| join 超时且零诊断 | 基本覆盖但未放行 | 8 码、探针、短读、结构化拒绝、5s 边界齐全；issuer 映射阶段与发送契约仍需冻结。 |

## Design 决策审查

- **D1/D3/D5：** services Host 派生、wildcard/端口拒绝、nullable、advertise 来源冻结、invite 门和 `DirFabricMismatch` 与 delta 对齐；loopback 允许的同机语义已注明。
- **D2/D7：** bootstrap 状态机无环，auto 代理覆盖方案按集合判定且顺序无关；Fabric/undici 显式拥有代理，QUIC 排除在外。
- **D4：** 流消费、任一在线聚合、首值仅快照、配置序 tie-break、lastError 脱敏及显式 abort+join 与 session delta 对齐。
- **D6/D8/D9/D10：** 配置优先级、`DWEB_RELAY_URLS` 隐式 custom、CLI 双形式/波浪号、TTL 值域和 UTF-8 byte `\\xNN` 转义均有测试入口；历史注记中的旧数量不属于规范正文。
- **D11：** 令牌错误、本地豁免、目录归属、空路径、网络的总函数及 2 秒探针判据仍互斥穷尽；wire grammar 已声明 JSON 为机器权威，但 issuerMapping 尚未真正结构化，见 P1-1/P1-2。

## 五个 delta、C0 与既有规格

| delta | 评价 |
| --- | --- |
| server | gateway/services、Host/IPv6/forwarded scheme、实际端口、nullable、告警和 ASCII banner 可测，无新冲突。 |
| example-app | CLI、配置、bootstrap、n0、代理、动态值转义、8 码和豁免 stderr 场景一致。 |
| fabric/roster | invite 安全门、advertise 校验、目录 mismatch/corrupted 分离一致。 |
| fabric/session | watcher、timeout、分类、framing、reduction 和 12 case 索引齐全；issuer 阶段需按 P1 修正。 |
| sdk/node | RelayStatus、事件 payload、取消订阅、invite 三参、proxy/timeout 和错误前缀与 C0 一致。 |

与既有主规格对照：三段式 `REDEEM_INTENT -> CHALLENGE -> PROOF`、32 KiB/5s 外层限制、工厂构造 + `shutdown()`、n0 URL 和错误前缀均无新冲突。delta 对 wire 规则的重复属于面向 capability 的行为要求；matrix 已不再复制机器字段值。

## 批次 S/E/F 并行审查

S、E、F 的目录 ownership 仍互斥，C0、锁文件、README、生成 d.ts 和主规格勘误由 ZCode 唯一维护。E 可独立 mock bootstrap/CLI，F 可独立读取 JSON 并测试既有 reader/writer；4.1 真实联测归 ZCode，资源和随机端口纪律明确。

跨批契约目前只剩 issuerMapping：F 不应自行猜测 Protocol 所属阶段、no-frame 行的发送顺序，或动态原因的 payload 断言。完成 P1-1/P1-2 后，C0 才能作为 S/E/F 无歧义的共同输入。

## 放行条件

1. 拆分 `session_token_decode`、`redeem_verify`、`consume_invite`、`post_consume` 阶段，消除“每行发一条”与 no-frame 行的冲突。
2. 将 issuerMapping 变成带 `emit/kind/payloadTemplate/joinerResult/close` 的结构化数组，并用实际 Rust variant/discriminant 表示。
3. F 以该表逐行构造测试；同时证明入口 Protocol、redeem_verify Protocol、Persistence、grant/receipt 失败都按表关闭并产生预期 joiner 结果。
4. 再跑 strict validate、fixture round-trip 和规范区旧引用搜索；实现层切换结构化 `REDEEM_ERR` 后做 4.1 联测。

## 综合评分依据

| 维度 | 评分 | 依据 |
| --- | ---: | --- |
| 需求覆盖 | 9.8/10 | 原始事故、TTL、relay/chat、wrong-fabric、CLI、gateway/services、配置、代理和诊断均有落点。 |
| 技术决策一致性 | 9.1/10 | D1/D2/D3/D4/D6/D7/D10/D11 主路径合理；issuer 阶段和发送语义仍需拆分。 |
| 可测性与契约 | 8.7/10 | 12 例字段和字节边界已统一；issuerMapping 仍半结构化且有全局语义矛盾。 |
| 并行编排 | 9.0/10 | owner、C0 前置和 E/F 边界清楚；issuer 表修正后才可无歧义并行。 |

综合为 **9.0/10**，相对第十二轮 **+0.4**。r13 已达到候选放行状态，但 issuerMapping 的阶段、发送动作和机器 schema 再冻结前，仍不放行。
