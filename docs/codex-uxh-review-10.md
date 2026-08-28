# connectivity-ux-hardening 第十轮评审

评审日期：2026-08-28

评审范围：`openspec/changes/connectivity-ux-hardening/` 的 `proposal.md`、`design.md`、`tasks.md`、五个 delta、C0 contracts，并对照 `openspec/specs/` 既有规格和当前 `crates/dweb-fabric/src/session.rs`。本轮只评审文档，不修改 change 或产品代码。

验证：`openspec validate connectivity-ux-hardening --strict` 通过。该命令只能证明 OpenSpec 结构合法，不能证明 fixture 与实际 reader/writer 的字节语义一致，也不能证明 C0、delta、tasks 的测试入口唯一。

## 结论与评分

**8.0/10（相对第九轮 6.0，+2.0），不放行。**

r10 正确修复了第九轮最严重的 framing P0：外层重新采用当前 session 实现的 `u32 BE length(type+payload) + type + payload`，公共 reader/writer 和 `REDEEM_OK` 不需改变；七个 fixture 在去除可读性空格后，长度域和记录流均可按该算法解析。多记录 fail-closed reduction、兑换内层 5s timeout、冲突场景和三段式兑换勘误也已补齐。

但“全文唯一性”仍未完全达成。design D11 还重复整段 wire 规范；fixture 的 case 行与“连续 hex”声明不一致且没有 255 边界向量；issuer 端既有错误到 RedeemErrorKind 的发送映射没有冻结；n0、控制字符、事件 URL tie-break 和本地豁免的跨层测试入口仍有缺口。这些问题不会推翻 framing 修正，却会让 F/E 在真实错误路径和测试完成判定上继续出现分叉。

## P0 闭合判断

### 原 P0-1：外层 framing

**判断：已闭合。**

`contracts/redeem-err.fixture.hex:3-6`、`contracts/error-matrix.md:56-60`、`design.md:427` 和 `specs/fabric/session/spec.md:35` 现在都声明：

```text
u32_be(1 + payload_len) + type(1B) + payload
```

这与当前 `session.rs:70-104` 的 `write_frame/read_frame` 逐字节一致，且 `REDEEM_ERR` 仍是类型 `0x14`，`REDEEM_OK` 仍走公共帧。r10 不再要求 F 改写公共 framing，也不再存在“只给 REDEEM_ERR 换头”的双协议解释。

### 原 P0-2：fixture 与 join 诊断

**framing 部分已闭合；join 合同仍有 P1 级实现缺口。**

七个向量的外层长度在去掉 case 行中的空格后均正确：canonical 7B/len=3、other 15B/len=11、unknown 11B/len=7、two-records 17B/len=13、inner-truncated 9B/len=5、zero-len-other 7B/len=3、outer-header-truncated 3B（头部不足）。inner-truncated 是完整外层帧内的记录短读；outer-header-truncated 是公共 `read_frame` 的头部 EOF 短读，两个错误层次已分开。

多记录规则也已写入 fixture、matrix 和 session delta：恰一条 `Consumed` 才是 `TOKEN_CONSUMED`，恰一条其它已知 kind 是 `TOKEN_INVALID`，多条统一 `TOKEN_INVALID` 但完整消费；未知 kind 按长度消费并以 `Other("unknown-kind")` 参与判定。内层 5s timeout 已明确归 `DIAL_TIMEOUT`，`joinTimeoutMs < 5s` 时外层 deadline 优先。

剩余缺口见 P1-1/P1-2：fixture 没有 255 字节载荷向量，case 行还含空格；更重要的是，文档没有冻结 issuer 如何把现有 `RosterError` 分支编码为这些 kind，因此真实的二次兑换、BadPoP、WrongFabric 等仍可能只发旧文本或直接关闭连接。

## 阻塞问题

### P1-1：issuer 错误到 RedeemErrorKind 的生产映射未冻结

文档只冻结接收端记录的 reduction（`error-matrix.md:62-76`），没有冻结 issuer 发送表。当前实现仍在 `crates/dweb-fabric/src/session.rs:269-275,297-306` 直接把错误转为文本 `REDEEM_ERR`，而 `consume_invite` 返回 `false` 时甚至没有发送错误帧。至少下列分支需要唯一规定：

| 既有 issuer 分支 | 当前/潜在行为 | 必须冻结的 wire 结果 |
| --- | --- | --- |
| `consume_invite == false` | 直接 `RedeemRejected`，不写帧 | `Consumed` |
| `BadPoP` | 旧文本错误帧 | `BadPoP` |
| `InviteNotRoot` | 旧文本错误帧 | `NotRoot` |
| `WrongFabric` | 文档已说经 `Other` | `Other`，并保留原因规则 |
| `InviteRecipientMismatch`/其它结构化拒绝 | 未说明 | `Other` 或明确的 fail-closed 结果 |
| persistence/IO/协议内部错误 | 发送错误帧还是关闭连接未说明 | 结构化错误或关闭后由 join 归 `DIAL_FAILED` |

没有生产映射，F 可以通过 fixture 单测却无法保证真实 join 产生 `TOKEN_CONSUMED/TOKEN_INVALID`；E 的错误码联测也无法证明它接收的是结构化协议而非旧文本。

**可操作修订：**在 C0 matrix 或 session delta 增加 issuer-side mapping table，规定每个 `RosterError` 是否发送一条 `REDEEM_ERR`、kind、payload 截断/ASCII 规则和发送后关闭语义；把二次兑换场景绑定到 `Consumed` 外层向量。

### P1-2：fixture 仍不能独立证明全部边界

`contracts/redeem-err.fixture.hex:12-16` 宣称每个 case 是“连续 hex”，实际 case 行写成 `0000000314 0000` 等带空格的分段值；只有第 43-49 行汇总才是连续 hex。若测试读取 assignment 行而不主动剥空格，结果不是单一字节向量。

此外七例中没有 `len=255` 的记录；`error-matrix.md:70-73` 和 `tasks.md:42` 却把 0/255 边界列为 fixture 基准覆盖。当前可以由测试额外生成 255 向量，但 C0 没有声明该向量的来源或期望结果。也没有“外层长度声明大于实际 payload”的完整 outer-payload EOF 向量；只有外层头不足和内层记录不足。

**可操作修订：**case assignment 只保留无空格连续 hex，或明确 C0 parser 必须忽略 ASCII whitespace；补一个 `Other` 255 字节 payload 向量和一个外层 payload 短读向量，并为七/九类 case 写 `expectedRecords`、`expectedResult`、`expectedViolation` 结构化期望。

### P1-3：design D11 仍有重复的规范 wire 段落

`design.md:427` 在同一段中重复了 `len=255`、段短读、额外记录、未知 kind、ASCII 呈现等整套规则：第一份规则在 `REDEEM_ERR` 描述后已经完整出现，第二份从“`len` 上限 255”再次开始。matrix 已做到唯一 F 覆盖行（`error-matrix.md:70-73`），但 design 仍不是单一规范来源，后续修订很容易只改其中一份。

**可操作修订：**拆出一个短的 wire grammar 小节，design 只引用它；删除重复副本，历史 r8/r9 注记继续保留在顶部的“非规范历史”区。

### P1-4：C0、delta、tasks 仍有跨层测试入口缺口

1. D4 新增的 `RelayOnline.url`“多 relay 同时上线时取配置序最小”（`design.md:250-254`）没有进入 `session delta` scenario 或 `tasks 3.5` 的明确断言；tasks 只写了聚合和 `lastError` 配置序。
2. D10 新增的 `<0x20`/`0x7F` 控制字符转义只在 `design.md:368`，example delta 仍只有非 ASCII 场景（`specs/example-app/spec.md:95-98`），tasks 2.2/2.6 也没有控制字符用例。
3. D6 的 n0 语义已在 example delta（`specs/example-app/spec.md:129-132`）写成官方 relay、固定 URL、bootstrap 不探测，但权威 d.ts（`contracts/client-sdk.d.ts.md:20-29,95-100`）没有冻结 n0 的 URL/`relayStatus().urls`，SDK delta 也没有 n0 场景。SDK 可以返回空数组或官方 URL 而仍“符合”当前类型。
4. 8 码边界之外的 `[missing-identity]`、`[corrupted]`、`[roster-io]` 在 design/session/matrix 有定义，但 example CLI delta 的 join requirement（`specs/example-app/spec.md:178-195`）只写 8 码，没有规定这些前缀如何从 CLI stderr 透出；tasks 2.5 也只明确 8 码 `error[join/<code>]`。

**可操作修订：**把 tie-break、控制字符、n0 的 SDK 结果和三类本地豁免各增加一个明确 owner/scenario；在 d.ts 写死 n0 的 URL 列表和禁用/在线值域；在 example delta 冻结本地变体不包装成 `join/<8-code>`。

### P1-5：deadline 边界的注释仍有一个未定义等值点

matrix `:49-50` 和 design `:420-422` 只写 `joinTimeoutMs < 5s` 时外层先到；`joinTimeoutMs == 5s` 时外层 timer 与 `REDEEM_DEADLINE` 同时到达，附注和连接关闭先后依赖 runtime 调度。最终错误码都可能是 `DIAL_TIMEOUT`，但错误 reason、是否追加 relay probe 和总耗时上界可能不同。

**可操作修订：**冻结等值边界（例如 `joinTimeoutMs <= 5s` 由外层拥有，或 inner timeout 优先），并在 matrix 与 session scenario 给出 reason/probe/close 的精确结果。

## 需求覆盖核对

| 需求或实测缺陷 | 结论 | 证据与剩余风险 |
| --- | --- | --- |
| relay 为空仍签发 invite | 覆盖 | D3、roster delta、tasks 3.1 有安全门、显式 advertise、wildcard/端口 0、allow-relayless；实际实现仍待 F 执行。 |
| 一次性直连地址退出即死亡 | 覆盖 | 禁止把 `direct_addr_hints` 混入签发，空路径在拨号前 `NO_REACHABLE_PATH`。 |
| TTL 10 分钟过短 | 覆盖 | 默认 60m，1s-30d，0/999ms/溢出拒绝，固定时间场景。 |
| chat 对 relay 失败静默 | 基本覆盖 | `home_relay_status()` 流、快照首值、跳变、配置序 `lastError`、URL tie-break、shutdown 均有；tie-break 测试入口欠明确。 |
| wrong-fabric 误报 corrupted | 覆盖 | `DirFabricMismatch`、16 hex、真损坏和坏令牌+错目录场景已分开。 |
| 纯英文横幅、vite 风格 IP | 覆盖 | 多网卡枚举、占位行、NAME/PORT 和动态 ASCII 规则均有。 |
| gateway + services.json 单一入口 | 覆盖 | Host/IPv6/forwarded scheme/实际端口/no-store/nullable，且顶层 gateway null 场景已加。 |
| config list/get/set 与免手输 env | 覆盖 | 持久配置、优先级、原子写、隐式 custom、空项去重、零参、语法错和离线保存均有；n0 的 SDK 结果需同步。 |
| proxy auto/on/off、多 relay 自动择优 | 覆盖 | D2 候选集合、代理覆盖、401/5xx 分层、全量下发 iroh 原生择优、QUIC 不经代理一致。 |
| `--opt=value` 与 `~` 展开 | 覆盖 | args 双形式、展开、未知选项退出码和成对测试明确。 |
| join 超时且零诊断 | 基本覆盖但未放行 | 8 码、探针、5s inner timeout 和 reduction 已有；issuer 生产映射、fixture 255/outer payload 边界及本地变体 CLI 透出仍缺。 |

## Design 决策审查

### D1 gateway/services.json

Host 拒绝集合、IPv6 括号剥离、loopback 放行、无效 Host 回退、无回退地址时 null、实际端口、可信 forwarded scheme、no-store、未知名静默和重复 warning 已形成可执行设计。顶层 gateway null 的消费语义已在 example delta 补上。server delta 仍主要以 requirement + 综合场景承载 Host 清单，tasks 1.2 承诺逐项断言，足够实施但不如 C0 fixture 机械化。

### D2 bootstrap

“规范化 -> 代理决策 -> 地址解析”无环；全部候选参与探测，混合可达时统一 from-env，404/200 非 JSON 才 legacy，401/5xx 在解析层硬错，数组逐项合并去重。n0 不探测的边界已写入 example，但没有进入 C0 bootstrap matrix；建议把它作为非 HTTP 候选行，避免 E 只按 D2 普通 URL 实现。

### D3 invite 安全门

relay 空且无显式 advertise 地址拒签，allow-relayless 责任外置，地址构造期校验拒绝 wildcard/端口 0、loopback 允许、不混入 hints，和 roster delta 一致。

### D4 `home_relay_status()`

直接消费 iroh 1.1 watcher、任一在线、聚合跳变、首值只入快照、配置序 `lastError`、配置序最小的事件 URL tie-break、abort+join 生命周期均合理。缺的是 tie-break 的可测 scenario 和 d.ts 对事件 URL 的稳定说明。

### D5 DirFabricMismatch

专用变体、16 hex、操作指引以及 issuer 侧 `WrongFabric -> Other -> TOKEN_INVALID` 语义一致；坏令牌+错目录场景已加入 session delta。

### D6 配置优先级

flag > env > file > default、disabled 整体覆盖、custom/URLS 隐式规则、n0、非法 JSON、语法错误不写、探测失败仍保存并逐项 warning 均可实现。n0 的公共 SDK 返回契约和 C0 矩阵还需补齐。

### D7 代理所有权

`HttpProxyConfig: None|FromEnv|Url`、Fabric 构造前决策、undici 显式依赖、环境变量顺序、QUIC 不经 HTTP proxy、多 relay 交给 iroh 原生择优都保持一致。仍建议冻结 proxy URL scheme 及 `proxy_from_env` 在 CGI 等特殊运行环境的差异，以免 Node 与 iroh 对“有效环境代理”的判定不一致。

### D8/D9/D10

D8 双形式参数、未知选项和 `~` 展开；D9 60m 默认、1s-30d 和溢出；D10 非 ASCII 与控制字符 UTF-8 小写 `\\xNN` 转义均有定义。D10 控制字符尚未进入 delta/tasks 的独立场景，属于测试契约缺口而非算法缺口。

### D11 join 诊断

令牌错误 -> 本地豁免 -> 目录归属 -> 空路径 -> 网络的顺序、2s transport-only 探针、deadline+2s、8 码、三类豁免、inner 5s timeout 和多记录 fail-closed 均已明确。真正剩余的是 issuer 发送映射、255/outer payload fixture、5s 等值边界和 example CLI 对豁免前缀的透传。

### D12 批次编排

S/E/F 源码目录、C0 先行、唯一 owner 文件、E mock 与 ZCode 4.1 联测边界仍互斥清楚。r10 的 C0 framing 已足以让 F 编写公共 reader/writer 之上的 payload parser；但 issuer mapping、n0 d.ts 和额外测试场景不在统一 C0 表中，F/E 仍需跨 design/delta 猜测完成条件。

## 五个 delta 与既有规格

| delta | 评价 |
| --- | --- |
| `server` | gateway/services、Host/IPv6/forwarded scheme、实际端口、disabled/null、未知静默和重复 warning 可测；无回退告警与顶层 null 语义有场景。 |
| `example-app` | CLI、配置、TTL、代理覆盖、n0、顶层 gateway null、ASCII 和 8 码场景齐全；未明确本地豁免 CLI 格式及控制字符测试。 |
| `fabric/roster` | invite 门、advertise 校验、wildcard/端口 0、逃生阀和 DirFabricMismatch/真损坏边界一致。 |
| `fabric/session` | framing、七例 fixture、reduction、inner timeout、探针、冲突优先级和 watcher 场景齐全；issuer-side kind 生产映射和 outer-payload EOF fixture 仍缺。 |
| `sdk/node` | relayStatus、事件 payload、取消订阅、invite 三参、join timeout、错误前缀和非空 custom 元组齐全；n0 URL/result 和 inner timeout reason 尚未进入 SDK 公共 scenario。 |

与既有主规格对照：`openspec/specs/fabric/session/spec.md:41-43` 已勘误为 `REDEEM_INTENT -> CHALLENGE -> PROOF` 三段式，仍保留 5s/32 KiB 通道约束；SDK 包名和生命周期勘误也已落盘。r10 没有再引入外层 framing 冲突，但主规格并未描述 RedeemErrorKind 的 issuer mapping，需由本 change 的 session delta 补足。

## Scenario 可测性与契约质量

- **wire**：现有七例可验证公共 outer reader、内层记录边界、未知 kind、多记录 reduction 和两个层次的短读；应补 255 payload 与 outer payload EOF，并移除 assignment 行空格歧义。
- **reduction**：`Consumed + Other` 的最终 `TOKEN_INVALID` 已有 session scenario 和 fixture，未知 kind 的消费不位移也有；issuer 侧如何产生该输入仍没有场景。
- **timeout**：5s inner timeout 有 scenario；`joinTimeoutMs < 5s` 有注记，等值边界和探针附注差异需要冻结。
- **bootstrap**：候选集合代理覆盖、空列表、legacy/gateway、401/5xx、最终整体退出码均可由 mock 构造；n0 应加入同一 C0 行集合。
- **D4/ASCII**：快照首值、跳变、lastError、shutdown 和动态 ASCII 有；事件 URL tie-break、控制字符 escape 没有独立断言。
- **本地豁免**：session/matrix 有三态和冲突顺序，example CLI requirement/tasks 没有规定 stderr 是否为 `error[variant]` 而非 `error[join/variant]`。

## 批次并行审查

S 负责 server/opendweb/server-binary/docker，E 负责 `packages/example`，F 负责 fabric/client-sdk，C0 和根/生成/lockfile/README 由 ZCode 唯一维护，物理目录没有重叠。C0 framing 修正后，F 不需要修改公共 reader/writer，E 也可以独立 mock bootstrap。

并行前仍需解决三项契约依赖：

1. F 必须从 C0 得到 issuer-side error mapping，否则真实 `REDEEM_ERR` 产生方式不唯一；
2. E/F 对 n0、255/outer-payload negative、控制字符和本地豁免的完成条件目前要跨文件拼接；
3. `tasks 3.5` 没有明确断言 D4 的配置序最小 URL tie-break，完成报告可能漏测。

所以批次边界“目录互斥”已成立，但 C0 还需一次小范围补充后才达到完全可并行验收。

## 可操作的放行条件

1. 在 C0/session delta 增加 issuer `RosterError -> RedeemErrorKind` 映射、发送/关闭规则，并让二次兑换场景使用 `Consumed` 外层向量。
2. 将 fixture case 行改为真正无空格连续 hex，补 255 字节 payload 和 outer payload EOF 负例；为每个向量写结构化 decoded/reduction/violation 期望。
3. 删除 `design.md:427` 的重复 wire 规则，只保留一个规范 grammar；全局搜索确认旧语义词仅存在顶部非规范历史注记。
4. 把 D4 URL tie-break、D10 控制字符、n0 d.ts 返回值和三类本地豁免 CLI 透出分别写入对应 delta、C0/tasks owner 行。
5. 冻结 `joinTimeoutMs == 5s` 的拥有者和 reason/probe/close 结果。
6. 重新运行 strict validate，并由 F 用既有 `read_frame/write_frame` 对所有完整向量做 round-trip、外层/内层负例和 issuer-to-join 映射验证，再进入 4.1。

## 综合评分依据

| 维度 | 评价 |
| --- | --- |
| 需求覆盖 | 9.4/10：原始事故、TTL、chat/relay、wrong-fabric、CLI、gateway/services、配置、代理和 join 诊断均有落点；残余集中在少量公共契约场景。 |
| 技术决策一致性 | 8.0/10：外层 framing、reduction、5s timeout、D2/D3/D4/D6/D7 主路径已合理；issuer mapping 和等值 deadline 仍有边界未冻结。 |
| 可测性与契约 | 7.2/10：七例 wire fixture 已可解析且覆盖主要结构，但缺 255/outer-payload 负例、case 空格规范、issuer 生产向量及少数跨层场景。 |
| 并行编排 | 8.2/10：S/E/F owner 与 C0 前置清晰；C0/delta/tasks 仍需同步 n0、控制字符、豁免和 tie-break 测试入口。 |

综合为 **8.0/10**，相对第九轮 **+2.0**。r10 已消除原 framing P0，接近放行，但剩余 P1 会影响真实兑换错误码和并行验收的唯一性，当前仍不放行。
