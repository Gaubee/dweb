# connectivity-ux-hardening 第五轮评审

评审日期：2026-08-28

评审范围：`openspec/changes/connectivity-ux-hardening/` 的 `proposal.md`、`design.md`、`tasks.md`、五个 delta、C0 contracts，并对照 `openspec/specs/` 既有规格。此次只评审文档，未修改 change 或产品代码。`openspec validate connectivity-ux-hardening --strict` 已通过；这只能证明 OpenSpec 结构合法，不能证明协议线格式、运行时分类或跨批测试已经闭合。

## 结论与评分

**8.0/10（较第四轮 8.0 不变），不放行。**

r5 已解决第四轮提出的大部分行为矛盾：bootstrap 采用代理覆盖语义并改为全集探测；`RELAY_OFFLINE` 限定为“无直连地址 + 生效策略 none”并明确 transport-only；探针增加 DNS/默认端口/计时和可替换句柄；本地错误豁免进入 d.ts、session delta 和 error matrix；配置写入事务、D4 配置序、四组 services fixtures 与测试 owner 也已补齐。

但是 r5 新增了一个不能按文字实现的协议契约：`len(1B)` 与 `len <= 256` 不相容。与此同时，bootstrap 决策表没有覆盖“部分候选直连成功、其余候选直连失败且代理重试全部失败”的组合，任务文本也没有把新的探针适用条件和四类注入完整同步。故原两个 P0 可以判断为“主路径闭合、边界仍需补表”，但 change 仍不能进入 Apply。

## P0 阻塞

### P0-1：RedeemErrorKind 长度字段不可表达冻结的上限

证据：

- `design.md:377` 与 `contracts/error-matrix.md:49-57` 冻结完整帧为 `kind(1B) + len(1B) + payload(len <= 256)`；
- 同时规定 `len > 256` 为协议违规并要求测试超长帧；
- `specs/fabric/session/spec.md:35` 将同一线格式列为公共 session 契约。

无符号单字节长度只能表达 0..255，不能表达 256；因此当前“允许 256 字节”与“超长 >256”均无法按一字节线格式实现。实现者可能把上限改成 255，也可能引入 0 表示 256 的隐含约定，二者都会偏离另一处文档；“超长”测试也无法从 wire 输入构造。

可操作修订：二选一并在 design、C0 matrix、session delta、tasks 和 fixture 测试中统一：

1. 把上限改为 255，并保留 `len(1B)`；或
2. 使用 2 字节长度（明确端序）或明确的 sentinel 编码表达 256，同时冻结解码、最大整帧、短读和未知 kind 的消费规则。

在修订前，F 无法实现与 E/C0 相同的 wire 契约，属于阻塞。

## 原 P0 的闭合判断与残余阻塞

### 原 P0-1：bootstrap 代理覆盖语义

核心设计已经闭合：`design.md:116-128` 和 `specs/example-app/spec.md:92-107` 都要求全集直连探测；只要存在直连不可达且有任一代理可达，最终 policy 为 `from-env`，地址解析对全部候选统一走代理；混合场景也改为断言 `from-env` 与顺序无关。这消除了上一轮“首项 URL”与代理专属候选无法解析的 P0。

仍有一个 P1 级决策表缺口：部分候选直连成功、部分直连失败、代理重试对所有失败候选也失败时，`contracts/error-matrix.md:83-93` 没有对应行。`全部两路均失败` 既可能被解释为“所有候选的直连和代理都失败”，也可能被解释为“代理重试的候选都失败”；两种解释对 warning 文案和最终解析报告不同。应补一行并明确最终 `none`、哪些候选在解析阶段硬错误、warning 是否为 `both ... fail`。

### 原 P0-2：RELAY_OFFLINE 探针归因

这一轮在语义上基本闭合：`design.md:339-349`、`contracts/error-matrix.md:19-29` 和 `specs/fabric/session/spec.md:67-70` 明确只有“令牌无直连地址且策略为 none”才允许探针归因；有代理或直连地址时立即错误统一 `DIAL_FAILED`，TCP 通但 relay 协议不可用也归 `DIAL_FAILED`。DNS 首地址、默认端口、2 秒预算、诊断追加最多 `deadline+2s` 及四类注入都已写出，已消除上一轮代理路径误报。

残余风险降为 P1：DNS 使用“解析器首地址”在不同系统上顺序可能不同；短 deadline 的“在线 relay + 无 issuer”仍需明确 fake clock/阻塞句柄，不能只靠实际等待。建议把探针输入输出抽成 F 的确定性 adapter，并在 tasks 3.5 逐项列出四类注入，而不是只保留旧的关闭端口描述。

## 其余 P1 阻塞与高风险遗漏

### P1-1：bootstrap 决策矩阵仍不完整

除上述部分成功/部分失败组合外，矩阵没有分别描述以下结果：代理可达但最终统一代理解析返回 401/5xx；代理重试未发生（无有效 env）时某些候选的保存/启动错误；以及一个候选为 legacy、另一个候选为 gateway 时统一代理的最终 URL 列表。设计文字可推导部分行为，但 C0 的“逐行测试”承诺没有逐行输入、输出和 warning。应将每个候选标成 `directReachable / proxyReachable / parseResult`，再定义 policy 与最终聚合。

### P1-2：D3 的 wildcard 规则未同步到 delta 与 tasks

`design.md:173-177` 已冻结 `0.0.0.0`、`::` unspecified 拒绝，loopback 允许并注明仅同机可达；但 `specs/fabric/roster/spec.md:9` 仍只写“可解析为 ip:port”，场景 `:36-39` 只测试空串/不可解析，`tasks.md:38` 也没有 wildcard 分支。F 可能按 delta 允许通配地址，违背 design 的安全门。应把 wildcard/loopback 场景与错误前缀写入 roster delta 和 F owner 测试。

### P1-3：services fixture 与 D1 的 warning 语义不一致

`design.md:72` 规定未知服务名忽略、重复名首个生效并 WARNING；未知名没有要求 WARNING。`contracts/services.fixtures.json:48-60` 的 note 却写“未知与重复各一条服务端 WARNING”，`specs/server/spec.md:71-74` 也要求未知和重复各输出一条 WARNING。需要明确未知名是否告警，并同步 fixture 的 `expectedWarning` 字段；同时将 server warning 与客户端 `url:null` warning 分成不同字段，避免 E 把日志和用户输出混为一类。

### P1-4：协议完整帧仍缺少若干实现边界

即使修正长度字段，C0 还应明确整帧最大值、是否允许 `Other` 的零长度 payload、未知 kind 的 payload 是否必须 ASCII（当前仅呈现层剥除）、短读发生在 kind/len/payload 哪一段，以及协议违规断连是否会关闭整个兑换连接。否则“未知值不断连”和“截断断连”在流式读取器中的行为仍有实现分叉。

### P1-5：错误豁免已进入 C0，但任务与 delta 的可测性仍不均衡

`contracts/error-matrix.md:70-72` 已给 MissingIdentity、Corrupted、ROSTER_IO 前缀、JS code 和 owner；`contracts/client-sdk.d.ts.md:113-129` 也已冻结公共前缀。session delta `:62-65` 现在覆盖三类错误，边界闭环明显改善。但 `tasks.md:41-42` 的 F 测试描述仍主要列旧的关闭端口/8 码，未逐项列三类豁免、未知 kind、多帧继续解析与四种探针注入。应把 C0 每行映射到确切测试函数/fixture，避免“覆盖 matrix”成为口头要求。

### P1-6：主 SDK 规格的 lifecycle 场景仍残留旧动词

`openspec/specs/sdk/node/spec.md:10` 的 requirement 已改为工厂构造 + `shutdown()`，但场景 `:14-20` 仍写“构造并 start”和“连续调用 stop”。C0.3 只在 requirement 文字上统一，未同步场景；这会让 Apply 验收同时要求不存在的 `start/stop`。应改为具体工厂与 `shutdown()` 场景，或明确保留兼容别名。

### P1-7：RelayOptions 的组合值域仍未冻结

d.ts (`contracts/client-sdk.d.ts.md:95-99`) 允许 `mode` 与 `urls` 独立可选，因此 `mode=disabled` 搭配非空 urls、`mode=custom` 缺 urls、`mode=n0` 搭配 urls 都是类型上可传入的组合；D6 只冻结了 CLI/env 合成，未定义 SDK 直接构造时的归一化或拒绝。建议改成判别联合，或增加组合值域场景，避免 F 与调用方对空/冲突配置得出不同状态快照。

## 需求与实测缺陷覆盖核对

| 需求/缺陷 | 结论 | 证据与残余风险 |
| --- | --- | --- |
| relay 为空仍照签 invite | 基本闭合 | D3 的安全门、显式 `advertise_addrs`、wildcard 拒绝和 escape hatch 已写；roster delta/tasks 尚缺 wildcard 场景。 |
| 一次性直连地址随进程退出死亡 | 已闭合 | 临时 `direct_addr_hints` 永不进入签发；无路径 token 在拨号前 `NO_REACHABLE_PATH`。loopback 允许且责任已文档化。 |
| join 超时且零诊断 | 部分闭合，仍阻塞 | 8 码、豁免、探针和 deadline 具备；wire 长度不可表达 256，且 bootstrap/探针边界测试仍缺。 |
| chat 对 relay 失败静默 | 基本闭合 | watcher 流、快照优先、跳变、lastError 配置序和 shutdown abort/join 已冻结；首次事件与 fake-clock 测试仍需明确。 |
| wrong-fabric 误报 corrupted | 已闭合 | `DirFabricMismatch`、16 hex 短标识、真损坏 `Corrupted`、SDK 前缀均同步。 |
| TTL 10 分钟过短 | 已闭合 | 默认 60 分钟，值域 1s-30d，999ms 拒绝/1000ms 接受，过期测试固定过去时间。 |
| 纯英文 ASCII 横幅与 vite 风格 IP | 基本闭合 | 非 loopback IPv4、无地址占位、服务表和 `<128` 断言均有；无地址情况下 manifest null 与 banner fixture 需保持同源。 |
| gateway + services.json 单一入口 | 基本闭合 | 独立 relay listener、Host/IPv6/forwarded scheme/实际端口/no-store/null fallback 和未知/重复/scheme 场景均有；warning 字段语义需统一。 |
| config list/get/set 与免手输 env | 基本闭合 | 优先级、disabled/custom/n0、数组、权限和 `config set` 保存失败语义已写；仍需补 SDK RelayOptions 值域。 |
| proxy auto/on/off、多 relay 自动择优 | 基本闭合，仍有 P1 | 全集探测、代理覆盖和统一代理解析已与混合场景一致；部分直连成功/代理全失败的矩阵行未冻结。 |
| `--opt=value` 与 `~` 展开 | 已闭合 | 双形式、展开、未知选项码和 E 单测边界一致。 |

## Design 决策审查

### D1：gateway/services.json

Host 校验、IPv6 括号剥离、可信 forwarded scheme、实际端口、no-store 和无回退地址的 nullable manifest 已形成可实现契约；独立 relay listener 也与既有 server 约束相容。剩余问题是“未知服务是否 WARNING”与 fixture 的矛盾，以及“不可路由值”集合仍是自然语言而非完整白名单。建议把服务条目归一化结果与 warning 分开建模。

### D2：bootstrap

当前状态机是真正单向的：规范化 -> 集合探测/代理决策 -> 统一策略地址解析。代理覆盖方案解决了直连/代理混合候选的顺序依赖，且空列表不发请求、404/非 JSON legacy、401/5xx 硬错误都已保留。尚缺部分失败组合的总表行，导致 warning/最终错误聚合有解释空间。

### D3：invite 门与逃生阀

relay 为空且无显式地址拒签、`direct_addr_hints` 排除、wildcard 拒绝、loopback 允许和带外责任均已在 design/C0/d.ts 对齐；roster delta 与 tasks 的粒度落后于 design，需要补齐才能让 F 的验收可测。

### D4：home_relay_status()

watcher 流消费、任一 relay online、聚合态跳变、快照优先、禁用不监测、abort+join 以及显式配置序排序均已正确处理。仍应在 SDK 场景明确 watcher 首值是否对已订阅者广播，避免“启动快照”和首个 online 事件重复计数。

### D5：DirFabricMismatch

设计、proposal、roster/session/sdk delta 和 C0 前缀均使用 `DirFabricMismatch`/`WRONG_FABRIC`，与 redeem 侧既有 `WrongFabric` 分离；本轮无新矛盾。

### D6：配置优先级与事务

flag > env > file > default、disabled 整体覆盖、非法 JSON/键/值硬错误、语法错误不写、探测失败仍保存并逐项 warning 的语义已足以实现；需要把部分候选失败时后续启动的保存值/重新探测行为在矩阵中明确。

### D7：proxy auto/on/off

`None|FromEnv|Url` 所有权、构造前决策、undici 依赖、环境变量顺序及 QUIC 不走 HTTP proxy 均与 D2 相容。原 P0-2 的错误归因已通过 probe 适用条件收窄解决。剩余是 auto 决策表不完整和 probe 首地址跨平台差异，属于契约完善而非架构方向错误。

## 五个 delta 与既有规格

| delta | 评价 |
| --- | --- |
| `server` | 已覆盖 Host/IPv6/forwarded scheme/实际端口/disabled/null、未知/重复服务和非法 scheme；但 unknown warning 需要与 D1/fixture 统一。 |
| `example-app` | bootstrap 代理覆盖场景已改为 `from-env` + 全候选统一代理，config set 事务和 allow-relayless 文案一致；缺部分失败矩阵行和 RelayOptions/fixture 组合的明确行为。 |
| `fabric/roster` | invite 门、escape hatch、DirFabricMismatch 和真损坏分界正确；wildcard 拒绝尚未进入 delta 场景。 |
| `fabric/session` | join 8 码、三类豁免、探针不适用、RedeemErrorKind 和 shutdown 均有场景；完整帧长度字段矛盾是当前最大协议阻塞。 |
| `sdk/node` | d.ts、错误前缀、relay 状态、事件 payload、unsubscribe 和 lifecycle requirement 已同步；主规格场景仍残留 start/stop。 |

与 `openspec/specs/` 对照：server 的独立 relay/gateway、session 的显式寻址与 5s 兑换通道、roster 的 root/PoP/单次兑换、example 的端到端组网均未被 r5 方向破坏。主 SDK requirement 的生命周期已改为工厂 + `shutdown()`，但其旧场景文字未同步，属于当前仍存在的规格冲突；包名勘误已正确落盘。

## 批次 S/E/F 与跨批契约

### 已具备的并行条件

- C0 仍先于 S/E/F，且 d.ts、四组 services fixtures、error matrix、事件 payload 集中冻结。
- S、E、F 的源码目录互斥；根 package、lockfile、README、版本、生成 d.ts 和主规格由 ZCode 唯一 owner。
- E 只交付纯函数/mock 测试，真实 S/F e2e 归 4.1；随机端口、自起服务、定向测试和 herdr 全量门禁纪律清晰。
- F 拥有探针句柄与 session frame，E 拥有 proxy/relay-resolve，跨批的主要 API（`httpProxy`、`joinTimeoutMs`、invite opts、错误前缀）已有 C0 类型或矩阵。

### 仍不足的跨批契约

1. `len(1B)`/256 的协议矛盾使 F frame 与 E 错误映射无法对同一输入验收。
2. error matrix 虽已拆 E mock/ZCode 4.1，但 bootstrap 部分失败组合没有对应行；E 的“逐行”测试无法覆盖一个未定义行。
3. tasks 3.4/3.5 未完整复述 probe 适用条件、`deadline+2s` 和四类注入，不能只依赖自然语言 D11 才算任务完成。
4. D3 wildcard 规则、D1 unknown warning 和主 SDK lifecycle 场景仍有 delta/主规格不同步，可能在 S/F/C0.3 验收时重新产生分歧。

## 可操作的放行条件

1. 修正 RedeemErrorKind 长度编码：明确 255 上限或采用可表达 256 的长度格式，并补整帧/短读/未知值测试。
2. 补齐 bootstrap 决策矩阵的部分成功/部分失败、401/5xx 统一代理解析和无 env 分支，明确 policy、warning、逐项错误聚合。
3. 将 wildcard advertise 地址、services unknown warning、fixture warning 字段和 RelayOptions 组合值域同步到对应 delta/C0/tasks。
4. 在 tasks 3.4/3.5 明列探针适用条件、DNS 首地址/预算、`deadline+2s` 和四类可替换注入；为短 deadline 增加 fake clock 或阻塞句柄。
5. 修正主 SDK 规格的 `start/stop` 场景，确保 C0、delta、tasks 和主规格都只使用工厂 + `shutdown()`。

完成以上修改并重新运行 strict validate 后，才具备无歧义并行 Apply 条件；当前不放行。

## 综合评分依据

| 维度 | 评价 |
| --- | --- |
| 需求覆盖 | 8.8/10：原始事故、TTL、ASCII/gateway、持久配置、代理三态、relay 观测和 join 诊断均有落点。 |
| 技术决策一致性 | 7.8/10：D2/D7 的主路径已合理，wire 长度与部分矩阵行仍会改变实现结果。 |
| 可测性与契约 | 7.5/10：C0、fixtures、豁免和注入显著增强，但协议上限和任务覆盖尚未完全冻结。 |
| 并行编排 | 8.3/10：owner/边界清晰，残余契约缺口仍会阻塞 F/E 对齐。 |

综合为 **8.0/10**，相对第四轮 **+0.0**：r5 的行为和工程修订本应加分，但新增的不可表达 wire 上限以及仍未覆盖的 bootstrap 组合抵消了改进。
