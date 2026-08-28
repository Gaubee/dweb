# connectivity-ux-hardening 实现复审报告（R4）

日期：2026-08-28  
复审对象：当前工作树 `git diff` 与未跟踪文件；非文档复审。  
基准：`openspec/changes/connectivity-ux-hardening/` 的 D1-D12、C0 contracts、五个 delta 与 `tasks.md`。

## 结论

评分 **7.6/10**，相对 R3 的 7.1 分上升 0.5。R3 所列七项 P1 修复均能在当前源码中找到对应实现，兑换通道主要 silent-close 路径已有真实连接时延测试，`read_frame` 边界也已修正。当前仍不放行：本轮发现四个新的/残留 P1，其中兑换失败误发 `RosterUpdated` 是确定性的行为回归，single-flight 的竞态会重复拨号或令等待者虚假等待 20 秒，`send.finish()` 失败不满足 D11 的立即关闭约束，D2 对合法但错误形状的 JSON 错误回退为 legacy。

门禁证据按用户提供结果接受：workspace cargo test 11 组全绿（含 redeem_wire 21）、clippy `-D warnings` 全绿、SDK/example/opendweb/server-binary JS 分别 12/108/12/5 全绿。轻量复核 `git diff --check` 通过，当前 `redeem-err.fixtures.json` 为 12 例、`issuerMapping.rows` 为 17 行，生成 `index.d.ts` 中事件/relay/proxy/deriveErrorCode 声明各只出现一份。未重复运行重量级 workspace 构建。

## 阻塞问题

### P1-1：兑换拒绝后无条件广播 `RosterUpdated`

证据：`crates/dweb-fabric/src/fabric.rs:1671-1685`。

accept loop 将 `handle_redeem_as_issuer` 的结果绑定到 `_res` 后，无论成功回执、结构化拒绝、协议违规、I/O 失败还是 deadline，都会执行 `events.send(FabricEvent::RosterUpdated)`。拒绝路径没有新增名册事实，`consume_invite == false` 也没有新增事实；SDK 消费者会收到伪造的名册变更，可能触发刷新、持久化或错误的 UI 状态。这是相对于旧的 `if res.is_ok()` 守卫的明确回归，也与 sdk/session delta 的事件语义冲突。

建议让 handler 返回 `RedeemOutcome`（例如 `Committed`/`Rejected`），只有实际提交名册变更时广播；至少先恢复 `res.is_ok()` 守卫，并为所有 17 个拒绝行增加“无 roster-updated”断言。若 grant 已提交但回执写失败，应由 outcome 明确表示“已提交”，避免简单按传输结果丢失事实变更事件。

### P1-2：`connect` single-flight 不是稳定的单航班

证据：`crates/dweb-fabric/src/fabric.rs:1218-1275`。

实现先检查 `peers`，再领取 `connect_inflight`。如果首飞在第二调用者取得 map 锁前已完成并移除 entry，第二调用者会看见空 map、重新插入航班并重复拨号，仍可能触发同 NodeId 的 iroh 去重窗口和重复事件。等待方使用 `Notify::notify_waiters()`；通知不保留 permit，owner 在 waiter 真正建立 `notified()` 等待前完成时通知丢失，等待方会无谓睡满 20 秒。owner future 被取消/abort 时没有 finally/Drop 清理，entry 会永久残留，之后每次调用都等待 20 秒后返回通用重试错误；`shutdown` 也不清理或唤醒该 map。

建议用带共享结果的 `watch`/`oneshot` flight state，owner 在 Drop/finally 中移除自身 entry 并唤醒所有 waiter；声明 owner 后在同一临界协议下再次复查 `peers`，不能依赖先前检查。增加并发成功、首飞失败、完成与 waiter 注册交错、owner 取消、shutdown 中断、断开后立即重拨的测试，并断言拨号次数和事件次数均为 1。

### P1-3：`send.finish()` 失败未进入 silent-close

证据：`crates/dweb-fabric/src/session.rs:606-618`。

emit=true 和成功回执路径都执行 `let _ = send.finish()`。`finish` 是发送流收尾 I/O；失败时 emit 路径仍返回 `InnerErr::Emitted`，由 accept loop 等待连接关闭，成功路径甚至返回 `Ok(())`。因此失败可能绕过 D11 要求的“写失败立即关闭”，并与当前对 emit=false 的 `<2s` 关闭契约不一致。现有真实连接测试覆盖 write/read/EOF，但没有 finish 失败注入。

建议将 `finish()` 错误映射为 `InnerErr::Silent`，由统一出口立即 `conn.close`；成功回执若名册已提交，需同时返回明确的提交状态。提供可替换 SendStream/最小连接故障注入，覆盖 emit 与 receipt 两条 finish 失败路径及关闭上界。

### P1-4：D2 将合法 JSON 错形误判为 legacy

证据：`packages/example/src/relay-resolve.mjs:52-60`，以及相反语义的测试 `packages/example/test/relay-resolve.test.mjs:94-98`。

`JSON.parse` 成功后，只有“非 null 且为非数组 object”才写入 `manifest`；数组、标量、`null` 都令 `manifest === null`，随后按 200 legacy 裸 relay 返回。D2/spec 明确只允许 `404` 或 `200 + 非 JSON` 回退；合法 JSON 但不是 manifest 是网关协议错误，不能静默当作旧 relay。当前测试反而冻结了 `200 + [1,2,3] -> legacy`，使门禁与规范相反。

建议区分 parse 失败与 parse 成功：只有响应体不是 JSON（可结合 `Content-Type`）时允许 legacy；合法 JSON 的非对象、缺少正确 `services` 形状或字段类型错误应返回可诊断的硬错误，并把测试改为断言不回退。对象中无 relay 条目仍按 C0 的 disabled/unknown-service 语义处理，不能与顶层 JSON 错形混淆。

## P0 关闭语义复核

R3 的主要 P0 缺口已基本闭合。`session.rs:522-635` 以 `InnerErr::Silent/Emitted` 分流：`accept_bi`、首帧/证明帧读取、challenge/proof 写入、协议校验、verify/consume/grant/事实编码、写帧错误和 handler deadline 都能走 silent close；只有结构化拒绝写完记录后交由 accept loop 有界等待。`fabric.rs:1677-1687` 的连接等待也避免了立即 `CONNECTION_CLOSE` 抢在流数据之前。`redeem_wire` 的真实连接测试覆盖无 bidi 流、首帧 EOF、截断头和主要 17 行出口，且 `expect_no_structured_frame` 断言主要无帧路径小于 2 秒。

但 P0 的“所有 I/O 异常”边界仍被 `send.finish()` 忽略（P1-3）。在该问题修复前，不能把 P0 说成完全闭合；其余 read/write/timeout 路径没有发现新的绕过。

## R3 七项处置核对

1. **P1-1 probe permit**：`default_relay_probe` 将 permit move 入 `spawn_blocking` 闭包，外层 2 秒 timeout 只停止等待，任务结束前不会释放唯一 permit；连续超时不会堆积 blocking task。该修复成立，代价是异常阻塞任务期间后续探针按失败处理，符合“在途即失败”契约。
2. **P1-2 issuer 映射**：`redeem_verify_emit` 对当前 `RosterError` 变体显式枚举，无 `_` 兜底；5 个结构化变体和 Protocol/非兑换变体均有分支。17 行 JSON 测试验证计数、ASCII、emit-kind/result 不变量，但尚未逐 variantId 投影到实现，列为 P2 契约强度风险。
3. **P1-3 d.ts**：`index.d.ts` 现在有唯一 `FabricEventJs`、`RelayStatusJs`、`RelayOptions`、`HttpProxyOptions` 与 `deriveErrorCode`，脚本使用 `fileURLToPath`，`relayStatus` 为 Promise。语义修复成立；`FabricOptions.httpProxy` 仍内联联合类型且额外导出 `HttpProxyUrl`，与 C0 的别名使用不完全一致，列为 P2。
4. **P1-4/P1-5 ASCII 与 relay 展示**：chat 不再把配置首项当作在线 relay URL，改显示候选数；lastError 和 Network 行动态值经过 `asciiEscape`。具体 tie-break URL 仍由 SDK 丢弃，但当前用户面不再误报首项，且 activeUrl 已明确留给后续 change。`buildBanner` 的 Local host/port/version 仍未统一转义，见 P2。
5. **P1-6 connect single-flight**：按 EndpointId 增加 `connect_inflight` 与 `connect_dial`，普通并发拨号的基本结构已存在；但本报告 P1-2 说明其临界竞态、丢唤醒与取消语义尚未真正闭合。
6. **P1-7 frame limit**：`read_frame` 使用 `4 + len > limit`，并有 exactly-limit 合法、over-limit 拒绝的真实流测试；该修复成立。

## D1-D12 与实现对照

- **D1/server**：gateway/services.json 的 Host 派生、实际 gateway/relay 端口、nullable URL、`no-store`、X-Forwarded-Proto 信任开关、Host 拒绝集合、unknown 静默忽略与 duplicate 首项告警均在 `crates/dweb-server/src/services.rs` 有实现和测试。IPv6 括号剥离、通配/端口校验与无回退 warning 对齐。风险是 Rust 回退取 `getifaddrs` 首项，而 JS `networkIPv4s()` 排序，D1 所称“同一枚举语义”未完全确定。
- **D2/D7 bootstrap/proxy**：规范化 -> 原始值代理决策 -> 已决策略解析的无环结构成立；全候选集合判定、混合场景统一 from-env、n0/disabled 短路、env 顺序、undici、窄 fallback 均可见。P1-4 是唯一明显的解析契约偏差。
- **D3 invite**：relay 为空且 advertise 为空时拒签，allow-relayless 独立逃生；advertise 构造期拒绝 unspecified/端口 0、去重保序，签发不混入临时 hints，代码与测试一致。
- **D4 watcher**：消费 `home_relay_status().stream()`，任一 relay online 聚合、首值只进快照、跳变广播、配置序 tie-break、配置序 lastError、shutdown abort+join 均已实现并有纯函数/集成测试。SDK 仍只投递快照，不暴露实际 active URL，但 example 已停止打印错误首项。
- **D5/D11 join**：令牌预检在目录检查前，DirFabricMismatch 与 issuer WrongFabric 分开，空路径零拨号，探针条件和 2 秒预算、8 码顺序、redeem wire/reduction/5 秒边界均有实现。`join_with_deadline` 继续用 detached connect task，资源生命周期列 P2。
- **D6 配置**：flag > env > file > default、URLS 隐式 custom、空项去重、原子写、权限收紧、config set 保存后逐项探测均已实现。`known_addrs` 仍会优先覆盖配置 relay 候选，且没有 TTL/容量，未由 D6 冻结，列 P2。
- **D8-D10 CLI**：双形式参数、tilde、TTL/join timeout、三态 proxy、ASCII helper 和稳定前缀基本对齐；`buildBanner` Local 动态字段残留未转义。
- **D12/C0**：批次 owner 和 C0 fixture 结构足以支撑并行，F 测试使用 `include_str!` 读取 12 例 JSON，服务 fixture 也由 server/example 读取。当前 `index.d.ts` 别名“声明存在但 FabricOptions 未引用”是唯一明显的层级漂移；issuer 17 行仍是文档不变量测试而非逐行实现投影。

## Wire、reduction 与 issuer 事务

外层 framing 与实现一致：`u32_be(1 + payload_len) + type + payload`，`read_frame` 的整帧上限计算已是 `4 + len`。`REDEEM_ERR` 记录按 kind/len/payload 逐条消费，len 上限 255，短读归 DIAL_FAILED，未知 kind 按长度消费并降级 Other，多记录 fail-closed；`REDEEM_OK` 没有被新 parser 改写。12 例 fixture 通过 include_str! 进入测试，并覆盖边界、短读、未知值、额外完整记录和零长 Other。

issuer 事务已把 verify/consume/grant/事实编码留在 roster 锁内，把帧写 I/O 移到锁外，方向正确。显式 `RosterError` match 防止新增枚举无裁决；但测试只证明 JSON 的 17 行数量和 kind 集合，并未把每个 variantId 映射到真实构造器/阶段出口，仍有契约漂移风险。另需修正成功/拒绝后的事件 outcome（P1-1）。

## iroh 同 NodeId 对策与公共 API

disconnect 排空、recent-disconnect 预沉降、HELLO 有界等待、干净 close、2.5 秒退避单次重试，是根据本机实证设计的合理 workaround，避免取消 iroh connect 造成半开连接卡住 NodeId。代价是失败路径额外延迟约 7.5 秒，且 P1-2 的 single-flight 竞态会抵消其收益；应先修 flight state，再保留现有实验性 workaround。`join_with_deadline` 的 detached connect task 仍未纳入 shutdown 可等待集合，成功/失败后的后台任务资源上界缺少测试，列 P2。

`FabricConfig.relay_ca_tls: Option<iroh_relay::tls::CaTlsConfig>` 对自签 relay 测试和自托管 CA 确实有用，`None` 保持平台根；但它把上游类型和 `insecure_skip_verify()` 能力直接暴露给公共 Rust 配置，且未进入 C0 SDK 契约。若是正式自托管能力，应在设计/API 文档冻结受限抽象；若仅为测试注入，应 feature-gate/test-only，列 P2 安全与耦合风险。

## 测试覆盖与未覆盖边界

- F：12 fixture 的编译期 JSON、read/write round-trip、reduction、17 行主要真实连接构造、silent close 时延、frame limit、probe 注入与 watcher 集成均有门禁证据。缺口是 finish 失败、single-flight 交错/取消、以及拒绝路径不广播 `RosterUpdated` 的断言。
- E：108 项覆盖参数、配置、proxy、候选集合、n0/disabled、空 env、URLS 隐式 custom、config set 保存语义和 ASCII。缺口是合法 JSON 错形应硬错误；现有对应测试语义反向。
- SDK：12 项覆盖 relayStatus、事件、错误码、构造校验；产物声明唯一性已改善，但缺少 TypeScript 消费者编译门禁，且 alias 使用仍漂移。
- S：25 项覆盖 Host 拒绝、nullable、unknown/duplicate、scheme、实际端口和 no-store；跨平台回退顺序及 banner Local 动态转义没有完整断言。

## P2 非阻塞风险

1. `send.finish()` 修复后仍建议保留故障注入测试，避免回归（当前按 P1 处理，修复前不放行）。
2. `join_with_deadline` 的 detached connect task 未纳入 shutdown；`connect_inflight` 也应在 shutdown 时清理/唤醒。
3. `known_addrs` 在目录 fabric mismatch 检查前写入，且命中 learned 地址会直接跳过 custom relay 列表；建议成功归属校验后再学习，并加 TTL/容量与 merge 优先级契约。
4. `relay_ca_tls` 直接暴露 iroh 类型并允许 insecure skip verify，需公共 API 文档或内部化。
5. `FabricOptions.httpProxy` 应改为引用 `HttpProxyOptions`，删除或内部化 `HttpProxyUrl`；补 `tsc --noEmit` 最小消费者 fixture。
6. `buildBanner` 的 Local host、port、version 仍直接插值。有效 CLI 绑定通常已被 server 解析器限制为 ASCII IP/端口，因此实际可利用面较小，但 D10 是全动态值契约，应统一 `asciiEscape`。
7. JS `on()` 包装无条件读取 `Native.Fabric.prototype.off`；若继续声称兼容旧二进制，应 feature-detect，否则删除旧版兼容注释。
8. Rust `primary_non_loopback_ipv4` 取接口枚举首项，JS 横幅排序后取首项；应共享排序规则或在 D1 明确“列表展示与服务回退可不同”。
9. `fix-dts.mjs` 依赖生成文本中的 marker 与字符串替换，当前产物唯一但对 NAPI 生成形状变化较脆，宜改为结构化/稳定生成步骤。

## 修复优先级与放行判定

合并前顺序：

1. 修复 accept loop 的 redeem outcome，禁止拒绝/失败伪造 `RosterUpdated`。
2. 将 connect flight 改为共享结果 + 可取消清理的状态机，补交错/取消/shutdown 测试。
3. 处理两处 `send.finish()` 错误并验证关闭上界。
4. 收窄 D2 legacy fallback，修正反向 JSON 错形测试。
5. 随后处理 d.ts alias、banner ASCII、detached task、known_addrs 和 relay_ca_tls 的 P2 收口。

**放行判定：不放行。** 当前 P0 主要路径已闭合，但上述四个 P1 会造成错误事件、重复拨号/长时间卡顿、关闭语义违约或错误 relay 解析，不能仅以全量门禁通过替代修复。

## 评分依据

加分项：R3 七项修复大部分与代码一致；probe 资源上界、显式 RosterError match、d.ts 生成去重、ASCII chat/Network、single-flight 基础结构和 frame 边界均有可定位实现；外层 wire、12 fixture、reduction、issuer 锁内事务、watcher 快照和真实 relay 测试证据较强。

扣分项：四个 P1 未闭合，且其中两个（无条件名册事件、single-flight 竞态）是新增行为回归/并发缺陷；fixture/测试仍漏掉 finish 与并发取消边界；D2 有现有测试与规范相反；若干 P2 公共 API 和生命周期边界尚未冻结。

最终评分：**7.6/10（R3 7.1，+0.5）**。
