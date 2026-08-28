# connectivity-ux-hardening 第三轮评审

评审范围：`openspec/changes/connectivity-ux-hardening/` 的 proposal、design、tasks、五个 delta 与 C0 contracts，并核对 `openspec/specs/` 和当前 iroh 1.1.0/kernel/SDK 接口。仅评审文档，未修改 change 或产品代码。`openspec validate connectivity-ux-hardening --strict` 通过；该结果只证明 OpenSpec 结构合法，不代表运行时分类和跨批契约已经实现。

## 结论与评分

**7.5/10（较上一轮 6.5 提升 1.0），仍阻塞，不放行。**

本轮可以确认 P0-1 已实质闭合：D2/D7 被合并为“原始输入规范化 -> 代理决策 -> 地址解析”的单一状态机，`undici` 依赖、代理环境变量顺序和 legacy fallback 规则均有明确归属。P0-2 也从“没有诊断契约”推进到有 8 码、有 deadline、有 wire discriminant、有测试 owner 的设计。

不过“互斥、穷尽的总函数”仍不成立。redeem 中途的非结构化传输错误、数据目录/名册读写错误，以及 `RELAY_OFFLINE` 所需的 relay 归因在文档中没有稳定、可实现的落点。另有数个 proposal、delta、C0 之间的小冲突，足以让并行实现产生不同解释。

## P0 阻塞

### P0-2 尚未真正成为 8 码总函数

`design.md:323-345` 和 `contracts/error-matrix.md:7-33` 的排序已经清楚，但覆盖范围仍只描述了 token 地址、`connect()`、结构化 redeem rejection 和 deadline。下列实际失败路径没有归类：

1. `connect()` 成功后，`redeem` 在 deadline 前发生连接关闭、读写 IO、错误 frame、`SignedFact::decode_all` 或其它非 `RedeemErrorKind` 错误。当前 session 实现将这些错误作为 `SessionError`/自由文本返回；D11 只有“结构化拒绝”与“到期”两条 redeem 分支，不能保证 CLI 永远得到 8 码之一。
2. `Fabric::join` 之前或之后的目录打开、名册损坏、缺失身份、事实 merge/持久化失败也可能直接返回 `Corrupted`、IO 或 `MissingIdentity`。roster delta 明确真损坏仍应是 `Corrupted`，所以“join 失败必为 8 码”与现有错误语义互相冲突。需要明确 8 码只覆盖“token/address/connect/redeem 网络工作流”，还是新增 data/protocol 类 code；不能同时声称全量穷尽。
3. `RELAY_OFFLINE` 依赖“立即错误可归因于令牌中的 relay 候选”。公开 `iroh::endpoint::ConnectError` 的高层变体并不提供一个稳定的 relay URL 归因字段；多 relay 还可能返回聚合错误。仅写“错误端点 == issuer relay”（`design.md:343`）不是实现算法。若要保留此码，必须规定显式 relay probe/错误上下文的来源和多候选聚合；否则将该类并入 `DIAL_FAILED` 或 `DIAL_TIMEOUT`。
4. `DIAL_TIMEOUT` 的附注条件“判定时点 token relay 可达”也没有定义观测数据。D4 的 `home_relay_status()` 已正确排除为 join 的观测量，但 token relay 的可达性不能从该 watcher 得出。

**可操作修订：**先把错误边界写清楚：配置、目录、持久化和真实损坏错误是否豁免于 join 8 码；若豁免，CLI 的错误契约要声明保留的非 join 错误及退出行为。对 redeem 的所有非结构化失败增加明确映射（通常为 `DIAL_FAILED`，或按 relay 归因），对 `RedeemErrorKind::Other` 限制长度并定义未知 discriminant 的处理。为 `RELAY_OFFLINE` 规定可测试的 per-candidate probe/错误上下文，或删除该码。只有完成后，8 码才可称互斥且穷尽。

## P1 阻塞与高风险遗漏

1. **D2 bootstrap 虽无环，但全局策略仍按 `rawRelay[0]` 决定。** `design.md:108-140` 对数组逐项解析，却只探测第一项。第一项 legacy relay 直连返回 404 会锁定 `none`，第二项只经 proxy 可达的 gateway 随后会硬失败；反过来排序则行为不同。若这是有意的“首项权威”，应明确其限制并在数组中禁止不同传输能力混排；否则应对候选集合做统一决策并冻结择优算法。空 relay/`DWEB_RELAY=disabled` 时 `rawRelay[0]` 为空的分支也未在状态机图中定义，应直接产出 disabled/none 而不发请求。
2. **auto 的“可达”与地址解析的“可用”需分层。** 设计把任何完整 HTTP 响应（包括 401、500、代理 407）视为可达，这可以决定 transport path，但随后同一 URL 又会硬错误。必须说明 407/代理认证失败是否算“proxy success”，以及 `proxy=on` 没有任何有效 proxy URL 时是硬错误还是 none；当前仅说非法 URL 忽略，未覆盖显式 on。
3. **services manifest 的 schema 仍不够冻结。** D1 允许无可回退地址时 `gateway`/service URL 为 `null`（`design.md:65-71`），但 `services.fixture.json` 只包含字符串 URL，D2 对 `enabled:true, url:null` 没有处理规则。应冻结 nullable 组合、未知/重复 service 名称、relay URL scheme 校验，并明确 fixture 是否代表 wire 的全部 required 字段。
4. **C0 类型已改善但仍有逃生阀文案冲突。** `contracts/client-sdk.d.ts.md:68-72` 说 `allowRelayless` “须配合显式 advertiseAddrs”，而 D3 `design.md:187` 和 roster delta 的场景允许两者都为空并由调用方承担带外路径责任。统一注释、spec 和错误建议，避免 SDK 使用者误以为 token 一定带地址。
5. **`RedeemErrorKind` 只有名字，没有可互操作的 wire 编码。** `contracts/error-matrix.md:27-32` 的 enum 没有 numeric discriminant、版本/长度上限、未知值行为；`Other(String)` 还可能把任意长或非 ASCII 文本带上 wire。冻结编码值、最大 payload、未知值降级和脱敏规则，并把 protocol/session 文件列入 F 任务。
6. **测试“可构造”仍有两个不稳定点。** `RELAY_OFFLINE` 的“起 relay 后 kill”可能返回 timeout 或连接拒绝，不能稳定证明立即 relay 归因；`TOKEN_EXPIRED` 的 `--ttl 1s 等待` 依赖墙钟，容易抖动。改用固定已过期 token、闭合端口/注入的确定性错误上下文，或在测试边界中明确允许的分类。
7. **proposal 没有完全同步 r3。** `proposal.md:49` 的已知配置键仍漏 `joinTimeoutMs`；`proposal.md:62` 仍写 fabric mismatch 拆成 `WrongFabric`，与 proposal:45、design、roster delta 的 `DirFabricMismatch` 相反。proposal 是 change 的产品摘要，这两处会误导实施和验收，应在进入 Apply 前修正。
8. **C0/任务文字仍有 snake/case 轻微不一致。** `tasks.md:43` 仍写错误前缀 `[<code>]`，而 C0、SDK delta 已冻结 `[<kebab-code>]`；`tasks.md:39-42` 的 8 码实现和错误矩阵没有明确把 redeem 非结构化错误、目录/merge 豁免写入 owner 测试。统一术语并将例外路径列入任务。

## P0/P1 需求覆盖核对

| 需求或实测缺陷 | 判断 | 说明 |
| --- | --- | --- |
| relay 为空仍签 invite | 已闭合 | D3 的显式 `advertise_addrs` 门、构造期校验、`direct_addr_hints` 排除和 escape-hatch 警告均明确。 |
| 一次性直连地址随进程退出死亡 | 已闭合 | 不再把运行时临时 hint 写入 token；无路径令牌在拨号前秒败。 |
| join 超时且零诊断 | **部分闭合，仍 P0** | deadline、8 码和 CLI 格式存在，但非结构化 redeem/目录错误/relay 归因仍不穷尽。 |
| chat relay 失败静默 | 基本闭合 | watcher、快照优先、跳变事件、lastError 和 shutdown 规则已写；空状态的 online 语义仍需实现时固定。 |
| wrong-fabric 误报 corrupted | 基本闭合 | `DirFabricMismatch` 已在 delta 和 design 统一；proposal 残留术语必须修正。 |
| TTL 10 分钟过短 | 已闭合 | 默认 60m、1s-30d、999ms 拒绝/1000ms 接受已对齐；过期测试应去墙钟化。 |
| 英文 ASCII 横幅与 vite 风格 IP | 已闭合 | `<128`、多网卡、无地址占位和服务表均有规则。 |
| gateway + services.json 单一入口 | 基本闭合 | Host/IPv6/scheme/实际端口/disabled/fallback 均有描述；nullable schema 需补齐。 |
| config list/get/set/unset 与免手输 env | 基本闭合 | 持久化、优先级、权限、join timeout 和数组写入均有入口；空 relay bootstrap、`proxy=on` 无 env 行为需补。 |
| proxy auto/on/off、多 relay 自动择优 | 基本闭合但有 P1 | D2 无环且显式依赖可落地；只探测首项导致数组顺序依赖，不能宣称完整多链路择优。 |
| `--opt=value`、`~`、未知选项 | 已闭合 | requirement、场景和 E 自主测试一致。 |

## 五个 delta 与主规格一致性

- **server**：delta 场景已覆盖实际端口、Host/IPv6、可信 forwarded scheme、无回退地址、disabled relay、摘要和 ASCII banner。与主 server 的独立 relay 端口和 rendezvous 约束相容；manifest nullable 组合尚未进入场景。
- **example-app**：bootstrap、fallback、数组、代理和 join 8 码均有 requirement，但状态机空输入、proxy on 无环境、401/407 行为和 8 码真实 e2e 的边界仍缺场景。
- **fabric/session**：watcher 与 D11 文字已同步，场景覆盖 8 码的主要网络/兑换分支；redeem 传输错误、目录损坏豁免和 relay per-candidate 归因仍缺。
- **fabric/roster**：拒签和 `DirFabricMismatch` 与主 roster 的单次在线兑换相容；escape-hatch 注释与 C0 d.ts 冲突。
- **sdk/node**：options、join timeout、字面量 relay mode、判别事件 union 和 unsubscribe 已与 C0 基本一致；join 8 码的 SDK 场景仍只有空路径和 timeout 两个样例，建议至少增加 invalid/failed/consumed 的前缀断言。

当前主规格没有新的目标相反冲突。工作树中的 `openspec/specs/sdk/node/spec.md` 与 `openspec/specs/example-app/spec.md` 包名勘误已存在未提交修改；D12 已将两者列为 ZCode owner，这个 owner 边界是正确的，但不应在 change 完成前把未提交基线视作归档结果。

## 批次与并行性

R3 的批次设计基本足以并行：C0 已勾选并先于 S/E/F；S、E、F 源码 glob 互斥；锁文件、README、版本、生成 d.ts、两份主规格均有 ZCode owner；E 的自主测试与真实 S/F 联测也已拆开；随机端口和定向测试纪律清楚。

仍需两点才能安全启动：

1. C0 必须在 P0-2 的错误边界、wire 编码和 D2 数组策略修订后重新冻结。否则 F 可能按“全量 8 码”实现，E 按“网络 8 码、目录错误豁免”实现，4.1 才暴露冲突。
2. `undici` manifest 由 E 提议、lockfile 由 ZCode 落地的安排正确；应额外在 E 任务中声明 `proxy=on`/无有效 env、rawRelay 为空和多项不同可达性的 mock case，并在 F 任务中声明 redeem transport/merge 错误的 owner。否则文件 ownership 虽互斥，行为契约仍不互斥。

## 建议的放行条件

1. 明确 8 码的适用边界，补齐 redeem transport、directory/storage 和 merge 路径；给 `RELAY_OFFLINE` 提供可观察、可注入的 per-candidate 归因，或删除该码。
2. 统一 proposal、tasks、delta、C0 的 `DirFabricMismatch`、kebab 前缀和 `joinTimeoutMs` 文案。
3. 为 rawRelay 为空、首项/后续项代理能力不同时的 bootstrap、proxy on 无有效 env、manifest nullable 组合补场景和决策。
4. 为 RedeemErrorKind 冻结数字编码、未知值、长度和脱敏规则，并将确定性 fixture/错误注入写入 F/E owner 测试。

满足上述条件并重新运行 strict validate 后，才可进入 S/E/F 并行 Apply；当前不放行。
