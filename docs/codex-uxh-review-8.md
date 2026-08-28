# connectivity-ux-hardening 第八轮评审

评审日期：2026-08-28

评审范围：`openspec/changes/connectivity-ux-hardening/` 的 `proposal.md`、`design.md`、`tasks.md`、五个 delta、C0 contracts，并对照 `openspec/specs/` 既有规格。此次只评审文档，不修改 change 或产品代码。

验证：`openspec validate connectivity-ux-hardening --strict` 通过。该命令只能证明 OpenSpec 结构合法，不能证明规范段落、C0 合约、delta 和 tasks 的全文语义一致，也不能证明兑换 wire 在现有外层帧协议中的落位唯一。

## 结论与评分

**8.1/10（相对第七轮 8.2，-0.1），不放行。**

r8 已解决第七轮指出的绝大多数直接矛盾：长度值域统一为 0..255，额外完整字节按下一帧，D11 的令牌错误顺序、D2 的候选集合代理覆盖、D4 的首值快照语义、Host 拒绝集合、动态 ASCII 转义、fixtures 结构字段和 RelayOptions 非空元组均已补齐。评分略降不是因为这些修订无效，而是复核现有兑换协议后发现新的冻结缺口：`RedeemErrorKind` 的 257 字节记录与既有兑换外层 frame 的关系没有写死；此外仍有一个规范正文残留术语和一个 fixture 告警期望反例。它们会让 F/S 的实现或测试出现不同结果。

## 阻塞问题

### P0-1：RedeemErrorKind 没有定义在既有兑换外层帧中的位置

当前 change 在 `design.md:400`、`specs/fabric/session/spec.md:35` 和 `contracts/error-matrix.md:49-62` 定义了“完整帧 = `kind(1B)+len(1B)+payload`”，但没有说明它是：

1. 现有 `REDEEM_ERR` 类型帧的 payload（外层仍有兑换通道的 frame header）；还是
2. 替换兑换通道现有 frame 编码的顶层记录。

既有主规格只冻结了独立兑换 ALPN、单条双向流和首帧请求（`openspec/specs/fabric/session/spec.md:41-48`），没有消除这两种解释。若 F 将 257B 记录直接写入现有外层读取器，而另一实现把它嵌入 `REDEEM_ERR` payload，E 的 mock 和真实 join 将互不兼容。当前“额外字节按下一帧”也没有说明是外层 frame 还是错误 payload 内的下一条记录；成功 `REDEEM_OK` 的边界、EOF 和现有 32KiB 兑换总量限制同样未关联。

**可操作修订：**在 session delta、D11 和 matrix 同一处明确层级。例如冻结“现有 `REDEEM_ERR` 外层 frame 的 payload 必须是一个或多个 RedeemErrorKind 记录；每条记录 2+len 字节，读取至该外层 payload 结束；短读关闭整个兑换连接；`REDEEM_OK` 仍使用既有外层 frame”。若要替换外层，则必须同步主 session 规格、成功响应格式、总量上限和测试向量。C0 应提供带外层 header 的完整 fixture，而不仅是内层字节串。

### P1-1：规范正文仍保留被 r8 明确要求清除的“超传”字样

历史注记已正确标记为“非规范历史”，但当前规范正文仍有：

- `design.md:400`：`无"超传"语义`；
- `contracts/error-matrix.md:56`：`无"超传"语义`。

这两处属于 D11 wire 定义和 C0 权威矩阵，不是历史说明。虽然否定式本身不会重新引入旧行为，但与 r8 的机械验收要求“规范段落全部清除该字样”不一致，也会使全文扫描和下游复制测试文本失败。

**可操作修订：**改成“帧后额外完整字节按下一帧解析”，不要在规范正文出现该旧术语；保留该词只可放在顶部历史注记，且继续标明非规范历史。删除 matrix 中重复的两条 F 测试覆盖行，只保留一条权威测试清单。

### P1-2：nullable fixture 的服务端告警期望与 D1 相反

`design.md:89-92` 规定 Host 无效且没有非 loopback IPv4 回退时，所有 URL 为 `null`，并且服务端记录 WARNING。`contracts/services.fixtures.json:54-75` 的 `nullable-url` 正是“无非 loopback IPv4”，但 `expectedServerWarnings` 却是空数组。该 fixture 会驱动 S 的断言，因此 S 只能在“必须告警”和“期望无告警”之间二选一。

**可操作修订：**为 nullable case 填入冻结的 ASCII 告警字符串（例如 `no non-loopback IPv4 available; URLs are null`），并在 server delta 场景和 tasks 1.2 使用同一精确字符串；若设计实际不要求该告警，则删除 D1 的 MUST WARNING，不能只改 fixture。

### P1-3：D11 没有冻结本地豁免与 NO_REACHABLE_PATH 的相对优先级

当前总函数只明确“令牌解码/过期/地址规范化（步骤 1-3）优先于目录检查和本地豁免”，随后步骤 4 检查目录 fabric，步骤 5 才返回 `NO_REACHABLE_PATH`。因此至少存在两组未定义冲突：合法但空路径令牌 + 真损坏名册，以及合法但空路径令牌 + 缺身份/名册 IO。一个实现会先返回豁免变体，另一个会返回 `WRONG_FABRIC` 或 `NO_REACHABLE_PATH`。这违背“互斥穷尽”对每个输入只有一个结果的要求。

**可操作修订：**把本地数据面检查插入总函数的明确位置，并写出冲突场景。推荐顺序是：先解码、过期、地址规范化；再执行本地目录加载（缺身份/Corrupted/roster-io 立即豁免）；再检查 `DirFabricMismatch`；最后检查空路径和网络工作流。若要让 `NO_REACHABLE_PATH` 优先，也必须明确写出并在 matrix 增加冲突场景。

### P1-4：C0 矩阵没有覆盖已进入 delta/tasks 的配置边界，bootstrap 行也未总是写整体结果

`design.md:300`、example delta `spec.md:85-98` 和 tasks `2.2` 已写入：`DWEB_RELAY_URLS` 单独存在即隐式 custom、逗号空项过滤/去重/保序、`config set relay` 零参数报错和动态值转义；但 C0 `error-matrix.md:103-114` 只有 `DWEB_RELAY=custom` 缺 URL、非法值等行，没有这些规则。C0 又声明是 E/F 唯一依据，导致 E 需要跨 design/delta 取规则。

此外 matrix `:89`、`:92-94` 的 bootstrap 行描述了候选级硬错误或 warning，却没有统一写明最终退出码/是否整体失败；D2 另有“数组任一解析失败即整体失败”，但逐行 mock 的断言口径仍可分叉。

**可操作修订：**把四条配置边界和 config set 的语法/探测保存结果加入 C0 的配置矩阵；为每个 bootstrap 行增加 `final result`（成功、整体退出码 1、保存后非零等）列，并明确候选级结果聚合。example delta 保留用户可读 scenario，C0 负责机器可执行期望。

## 需求覆盖核对

| 需求或实测缺陷 | 结论 | 证据与剩余风险 |
| --- | --- | --- |
| relay 为空仍签发 invite | 基本闭合 | D3 安全门、显式 `advertise_addrs`、`allow_relayless` 和 `[bad-advertise-addr]` 已在 roster delta/3.1；冲突优先级仍见 P1-3。 |
| 一次性直连地址退出即死亡 | 已闭合 | 签发不再混入 `direct_addr_hints`；空路径 join 在拨号前返回 `NO_REACHABLE_PATH`。 |
| TTL 10 分钟过短 | 已闭合 | 默认 60m，值域 1s..30d，0/999ms/溢出拒绝，固定过去时间测试。 |
| chat 对 relay 失败静默 | 已闭合 | `home_relay_status()` 流、快照优先、首值不广播、跳变、配置序 `lastError`、shutdown abort+join 均已对齐。 |
| wrong-fabric 误报 corrupted | 基本闭合 | `DirFabricMismatch` 与真 `Corrupted` 分离，16 hex 标识冻结；与本地错误冲突仍需明确顺序。 |
| 纯英文横幅、vite 风格 IP | 已闭合 | 全网卡枚举、无地址占位、全输出 ASCII 和 UTF-8 字节 `\\xNN` 转义已有 delta/tasks 场景。 |
| gateway + services.json 单一入口 | 基本闭合 | Host 清单、IPv6、端口、可信 forwarded scheme、nullable/no-store 均有；nullable warning fixture 反例见 P1-2。 |
| config list/get/set 与免手输 env | 基本闭合 | 持久文件、优先级、权限、原子写、隐式 custom、空项去重和零参场景已有；C0 未完全承载见 P1-4。 |
| proxy auto/on/off、多 relay 原生择优 | 基本闭合 | D2/D7 已统一候选集合和代理覆盖，QUIC 不走 HTTP proxy；矩阵最终聚合结果仍需冻结。 |
| `--opt=value` 与 `~` 展开 | 已闭合 | args requirement 和 2.1/2.6 成对测试。 |

## Design 决策审查

### D1 gateway/services.json

Host 派生规则已经可执行：IPv6 括号剥离、拒绝 unspecified/userinfo/解析失败/端口越界、其余含 loopback 放行、回退首个非 loopback IPv4、无回退时 URL 为 null、实际服务端口、可信 forwarded scheme 和 no-store 均明确。服务条目未知名静默忽略、重复名首个加 WARNING 也已同步 server delta/fixture。缺口是 nullable fixture 没有反映 D1 的 WARNING（P1-2），且 server delta 没有为拒绝集合逐项写 BDD scenario，主要依赖 tasks 1.2 单测。

### D2 bootstrap

“规范化 -> 代理决策 -> 地址解析”无环；auto 对全部候选直连探测，混合场景统一 from-env 解析，空列表不请求，404/非 JSON 才 legacy fallback，401/5xx 在解析层硬错，legacy+gateway 逐项合并去重。这真实闭合了上一轮代理 P0。剩余是 matrix 行没有统一的整体结果列，且配置边界未进入 C0（P1-4）。

### D3 invite 安全门

relay 空且无持久直连地址拒签，逃生阀有带外责任措辞；显式地址构造期校验、拒绝 wildcard/端口 0、重复去重保序、loopback 允许且不混入 hints。该决策与 roster delta 一致。

### D4 `home_relay_status()`

直接消费状态流、任一 relay online、聚合跳变、首值只入快照、配置序 `lastError`、显式 abort+join 均合理，已消除上一轮首值事件冲突。仍建议冻结 `RelayOnline { url }` 在多 relay 同时连上时的选择规则；当前“首个连上”依赖 watcher 到达顺序，而 `lastError` 才有配置序确定性。这是低于 P1 的可重复性风险，不改变当前评分主阻塞。

### D5 `DirFabricMismatch`

命名、16 hex 展示、可操作文案和 issuer 侧既有 `WrongFabric -> Other -> TOKEN_INVALID` 均一致。需按 P1-3 冻结它与本地豁免/空路径的冲突顺序。

### D6 配置优先级与事务

flag > env > file > default、`DWEB_RELAY=disabled` 整体覆盖、custom 缺 URL 硬错、URLS 隐式 custom、空项去重保序、非法 JSON、语法错不写、探测失败仍保存并逐项 WARNING 都可实现。唯一问题是这些规则未完全复制到 C0 机器矩阵，见 P1-4。

### D7 代理所有权

`FabricConfig.httpProxy: None|FromEnv|Url` 明确映射 endpoint builder；auto 决策在 Fabric 构造前完成；example 使用显式 `undici` `ProxyAgent`；HTTP 环境顺序冻结；QUIC/直连/NAT 穿透不走 HTTP proxy；多 relay 全量交给 iroh 原生择优。r8 的 P0-1 代理去环已真实闭合。需在最终契约中注明 `Url` 形态仅 SDK 使用，CLI from-env 的实际 URL 解析失败如何映射构造错误（d.ts 有 `[bad-proxy-url]` 注记，matrix 未列为稳定码）。

### D8/D9/D10

D8 双形式参数、未知选项退出码和 `~` 展开已可测；D9 60m 默认和 1s..30d 边界已统一；D10 静态文案、动态值 UTF-8 字节小写十六进制转义和 ASCII 断言已进入 example/tasks。D10 仍应避免在 server 侧只测静态 banner，最好补一个动态非 ASCII reason/path 的输出断言。

### D11 join 诊断

8 码与三类本地豁免、令牌错误优先级、空路径秒败、2 秒 TCP transport-only 探针、代理/直连适用条件、deadline+2 秒上界、四类注入和 wire 0..255 边界均已写清。真正的剩余风险是 P0-1 的外层帧落位和 P1-3 的本地豁免相对顺序；两者都会影响“互斥穷尽”能否在实现中保持单一结果。

### D12 批次编排

S/E/F 的源码目录和唯一 owner 文件互斥，C0 先于并行批次；E 的 mock 与 ZCode 4.1 真实联测边界、随机端口纪律、undici lockfile 由 ZCode 统一更新均足够清楚。并行仍受 P0-1 影响：F 不知道 wire 外层契约，E 的 frame mock 不能与真实 F 对齐；P1-2/P1-4 还会让 S/E 对 fixtures 和配置矩阵产生不同完成判定。

## 五个 delta 与既有规格

| delta | 评价 |
| --- | --- |
| `server` | gateway、services.json、Host/IPv6/forwarded scheme/实际端口/disabled/null、未知静默和重复 warning 均有；拒绝集合写在 requirement 而非逐项 scenario，nullable warning 与 fixture 冲突。 |
| `example-app` | CLI、config 子命令、TTL、URLS 隐式 custom、空项过滤、零参错误、bootstrap 代理覆盖、ASCII 和 join stderr 均有；没有逐条覆盖 matrix 的 both-fail/no-proxy/401/5xx 聚合结果，依赖 C0/tasks。 |
| `fabric/roster` | invite 门、advertise 地址校验、wildcard/端口 0、重复去重、逃生阀、DirFabricMismatch/真损坏分界可测；与 D11 本地豁免顺序仍需补冲突 scenario。 |
| `fabric/session` | 首值快照、8 码、三类豁免、探针和帧边界文字齐全；RedeemErrorKind 与现有兑换外层 frame 的层级未冻结，故不能称为完全可实现。 |
| `sdk/node` | relayStatus 三态、事件 payload、on 取消订阅、第三参 invite、join timeout、错误前缀、非空 custom 元组齐全；`[bad-proxy-url]` 是非稳定附加码，需说明是否进入公共错误合同。 |

与既有规格对照：主 SDK 生命周期和包名勘误已落盘；server 独立 relay listener、roster root/PoP/单次消费、session 独立兑换 ALPN/5 秒通道和 32KiB 总量边界没有被明确否定。但新 change 必须在 session delta 中声明 RedeemErrorKind 是外层 frame 的 payload 还是替代协议，否则这不是单纯的 change 内部文字问题，而是与既有兑换 framing 的兼容边界不确定。

## Scenario 可测性与契约质量

- bootstrap 主组合可由 mock `httpGet` 构造，且代理覆盖方向无顺序依赖；应为每行增加最终成功/失败聚合和退出码，尤其是部分失败、代理全败、401/5xx。
- wire 的内层记录向量已经覆盖段短读、EOF 不完整帧、0/255、非 ASCII、未知 kind、额外完整帧和 Other 零长；但没有外层 header + payload 的 fixture，P0-1 使“真实协议测试”仍不唯一。
- D11 的 8 码和豁免 owner 行已逐项列出；缺少“合法空路径 + Corrupted/MissingIdentity/Roster IO”冲突 scenario，无法验证互斥顺序。
- D4 快照首值、跳变、lastError、shutdown 均可观察；多 relay 同时上线时 `RelayOnline.url` 仍受 watcher 顺序影响。
- server Host 拒绝清单和 example URLS/ASCII 场景已进入 requirement/tasks，但 C0 机器契约和 nullable warning 还未完全同步。

## P0/P1 清单与放行条件

### P0

1. 冻结 `RedeemErrorKind` 与既有兑换外层 frame 的层级、成功/错误响应边界、EOF/总量限制，并提供带外层的 C0 fixture；否则 F 与真实 join 仍可能采用互不兼容的 wire。

### P1

1. 删除 design D11 与 error-matrix 正文中的“超传”字样，消除重复 F 测试行。
2. 修正 `nullable-url.expectedServerWarnings`，并将 exact warning 同步 server delta/tasks。
3. 冻结 D11 本地豁免、DirFabricMismatch 与 NO_REACHABLE_PATH 的相对顺序，补冲突场景。
4. 将 URLS 隐式 custom、空项过滤/去重保序、config set 零参和 bootstrap 最终聚合结果加入 C0 机器矩阵。
5. 明确 SDK `[bad-proxy-url]` 是否为公共稳定错误码，并补 proxy URL 构造失败场景。

达到放行条件后，r8 的原始需求覆盖、D2/D7 代理设计、D4 `home_relay_status()` 观测语义和 S/E/F 目录所有权即可进入 Apply；当前仍不放行。

## 综合评分依据

| 维度 | 评价 |
| --- | --- |
| 需求覆盖 | 9.4/10：原始事故、TTL、chat/relay、wrong-fabric、CLI 参数、gateway/services、配置化和代理三态均有落点，边界大多已补。 |
| 技术决策一致性 | 7.8/10：D2/D7/D4/D11 主路径合理，但 wire 外层落位和豁免相对顺序会改变运行时结果。 |
| 可测性与契约 | 7.5/10：内层帧向量和候选矩阵丰富，C0 缺配置边界、fixture 告警反例、部分矩阵行缺最终聚合，且外层 frame 未冻结。 |
| 并行编排 | 8.2/10：owner/批次边界清晰，C0 先行和 E/F mock 边界合理；wire 与 fixture 缺口仍会阻塞 S/E/F 的一致验收。 |

综合为 **8.1/10**，相对第七轮 **-0.1**：r8 清除了上一轮的大部分直接矛盾，但在对照既有兑换承载后发现一个新的 P0 wire 层级缺口，并保留两个可直接导致实现/测试分叉的 P1 文档矛盾，因此尚未达到放行线。
