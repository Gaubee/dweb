# connectivity-ux-hardening 第四轮评审

评审日期：2026-08-28

评审范围：`openspec/changes/connectivity-ux-hardening/` 的 `proposal.md`、`design.md`、`tasks.md`、五个 delta、C0 contracts，并对照 `openspec/specs/` 既有规格。此次只评审文档，未修改 change 或产品代码。`openspec validate connectivity-ux-hardening --strict` 已通过；该结果只证明 OpenSpec 结构合法，不证明运行时语义已经可实现或测试闭环。

## 结论与评分

**8.0/10（较第三轮 7.5 上升 0.5），仍不放行。**

r4 已实质推进两个原始 P0：D2/D7 形成了“原始输入规范化 -> 代理决策 -> 地址解析”的单向状态机；D11 形成了 join 网络工作流的 8 码、超时边界、redeem 结构化错误和本地数据错误豁免。D4 的 `home_relay_status()` 流消费、shutdown abort/join、D1 的 Host/IPv6/null 规则、D6 的完整优先级表以及 C0 的 owner 约束也明显比上一轮完整。

但两个 P0 仍未真实闭合：

1. bootstrap 的“全候选集合”决策与 example delta 的“首个 URL”文字直接矛盾；即使按 design 执行，混合“仅直连/仅代理”候选也会得到全局 `none`，随后用 `none` 解析代理专属候选，结果无法满足场景。
2. `RELAY_OFFLINE` 的 TCP 探针没有定义与实际 iroh 代理路径的关系，也没有定义多 relay/直连并存时的归因聚合。代理可达而直连探针失败时会误报 relay offline，生产行为与测试闭合条件不一致。

在这两个问题修正前，F/E 仍可能按不同解释实现，4.1 才暴露分歧，因此不能进入并行 Apply。

## P0 阻塞

### P0-1：bootstrap 集合判定没有形成单一可执行契约

证据：

- `design.md:115-122` 明确写“对 rawRelay 的全部候选”做直连探测，并以任一直连可达决定 `policy=none`；
- `contracts/error-matrix.md:68-78` 也把决策表标成“按候选集合判定，无顺序依赖”；
- `tasks.md:30-33` 同样要求逐项解析与集合决策；
- 但 `specs/example-app/spec.md:82` 仍写“对首个原始 URL 发起”并以该 URL 决定策略。

这不只是措辞残留。example 的场景 `specs/example-app/spec.md:94-97` 设定一个“仅直连可达”候选和一个“仅代理可达”候选，却要求最终策略为 `none`。按 design 的后续步骤，地址解析会用已决的 `none` 对全部 URL 请求，代理专属候选会失败；若把 proxy 重新用于它，又违反“已决策略统一用于每个 raw 项”的契约。当前没有一个实现能同时满足 design、C0 和该 scenario。

可操作修订：在 C0 里冻结以下二选一，并同步 design、example delta、tasks 和测试：

- **全局策略方案**：只要任一候选直连可达就选 `none`，则要求其余候选也必须能以 `none` 解析；“仅代理可达”混合场景应明确整体失败及错误，不得宣称成功或仅断言 policy；
- **代理覆盖方案**：只要有候选只能经代理到达就选 `from-env`（所有候选统一经代理），或冻结每候选独立 policy。若保持 SDK 单一 `httpProxy`，前者更容易实现。

无论采用哪种方案，需定义探测结果集合、最终解析输入集合、重复/失败聚合和顺序无关性，并给每种组合写可构造场景。

### P0-2：relay 探针与真实连接路径不一致，RELAY_OFFLINE 仍可误报

证据：`design.md:331-338`、`design.md:351-362` 与 `contracts/error-matrix.md:17-24` 规定对令牌 relay URL 做直接 2 秒 TCP connect，失败即 `RELAY_OFFLINE`；D7 (`design.md:282-295`) 又规定 `httpProxy=FromEnv` 映射到 iroh endpoint 的代理 builder。

当前探针没有说明是否经过该 HTTP proxy。若加入方只能通过代理访问 relay，iroh 的实际连接可能成功，而直连 TCP 探针失败，立即 connect 错误会被误报成 `RELAY_OFFLINE`。反向也成立：relay TCP 端口可连接但 HTTP/WS/relay 协议不可用，探针成功只会把问题归入 `DIAL_FAILED`，这必须是有意且明示的 transport-only 语义。

此外，令牌可同时含 relay 与多个 direct address。iroh 的立即错误未必能指出失败的是哪条路径；“对令牌 relay 候选探针失败即 RELAY_OFFLINE”会把 direct-only 失败或某一个 relay 失败错误归因到整体 relay。多 relay 也没有“任一探针成功/全部失败”的聚合规则。

可操作修订：

1. 明确探针是否使用与 iroh 相同的有效代理策略；若 HTTP proxy 不支持该 TCP 探针，明确 `RELAY_OFFLINE` 仅适用于“仅 relay、无 direct address、且 policy=none”的令牌，其余立即错误统一 `DIAL_FAILED`。
2. 冻结多候选规则：DNS 多地址是任一成功还是首个；IPv4/IPv6 顺序；scheme 缺省端口；DNS 是否计入 2 秒；探针是否只验证 TCP transport；多个 relay 的任一成功/全部失败聚合。
3. 明确探针与 join deadline 的关系。当前在 deadline 到期后再做最多 2 秒探针，可能使用户可见总耗时超过 `join_timeout_ms`；应并发探针、从 deadline 预算扣除，或把诊断探针明示为不计入且给出最大总时限。
4. 为 proxy-only、direct+relay、多个 relay 一成功一失败分别提供确定性 fixture；“关闭端口”只能证明一种 direct TCP 失败，不能证明生产中的代理归因。

## P1 阻塞与高风险遗漏

### P1-1：本地数据错误豁免尚未在 C0/SDK 公共面闭环

`contracts/error-matrix.md:7-15` 和 D11 (`design.md:323-325`) 定义 `[missing-identity]`、`[corrupted]`、`[roster-io]` 三类豁免；但 `contracts/client-sdk.d.ts.md:111-126` 的“冻结前缀集合”只列 invite 加 8 个 join 码，没有这些豁免前缀或其 `err.code` 派生规则。`specs/sdk/node/spec.md:7` 也只列 8 码，没有说明 SDK 对豁免错误的公共行为。

fabric/session delta 只有 `Corrupted` 场景 (`spec.md:62-65`)，没有 MissingIdentity 和 merge/persistence IO 场景；error matrix 也没有为三类豁免列 owner/构造方式。这样 E 可以按 `[roster-io]` 实现，F 也可以直接透出任意 Rust IO 文本，二者都“符合”当前文字。

建议把豁免前缀、是否设置 `err.code`、原生变体到 kebab 的映射、退出码和至少一个确定性构造分别写入 C0.1、session delta、error matrix 与 F/E 测试任务；并明确 malformed token 与 MissingIdentity 同时存在时的优先级。

### P1-2：RedeemErrorKind 的 wire framing 仍不足以安全互操作

`design.md:364` 与 `contracts/error-matrix.md:46-50` 冻结了单字节 discriminant 和 `Other <=256`，但没有冻结 frame 中载荷长度的编码、最大整帧长度、短读/长读行为，也没有说明未知 discriminant 如何知道应消费多少 payload。若未知类型仍带任意长度，接收端无法在不越界或错位的情况下“降级并不断连”；若先按外部长度分配，又缺少防 DoS 的明确上限。

建议冻结完整线格式，例如“1 byte kind + 1 byte payload length + payload <=256 bytes”，长度在分配前校验，未知 kind 仍按同一长度消费并映射 `Other(unknown-kind)`；同时增加截断、超长、非 ASCII、未知值和多帧后续可继续解析的场景。

### P1-3：探针的确定性测试不足以覆盖生产判据

关闭 `127.0.0.1` 端口是稳定的失败注入，但文档没有冻结域名解析失败、域名多地址、无显式端口、IPv6、连接超时与连接成功但 relay 协议错误的行为。`DIAL_TIMEOUT` 场景还写“relay 在线、issuer 离线”，但没有说明如何在不依赖墙钟和常驻进程的情况下构造“探针成功而 issuer 不响应”。应把这些条件拆成可注入的 probe adapter 或固定本地 fixture，并注明测试是否断言 transport 还是应用协议。

### P1-4：manifest 边界规则有设计文字但 delta 场景不完整

D1 (`design.md:65-71`) 已写 `enabled:true,url:null`、未知 service 名称、重复名称首个获胜、relay scheme 校验；example delta 只覆盖 `url:null` (`specs/example-app/spec.md:99-102`)，server delta 也没有未知/重复名称、非法 scheme 的场景。`services.fixture.json` 只代表 canonical 字符串 URL，不能单独证明 nullable/前向兼容行为。

建议在服务端/客户端归属明确后，为每条规则添加输入 JSON、警告文本、最终 relay 列表和退出行为；fixture 至少分 canonical、disabled、nullable、unknown/duplicate 四组，或明确 canonical fixture 不是全部合法输入。

### P1-5：逃生阀的产品文案仍有内部矛盾

`specs/example-app/spec.md:7` 写 `--allow-relayless` 的令牌“仅可凭显式直连地址兑换”，但 D3 (`design.md:187-191`)、roster delta (`spec.md:31-34`) 和 C0 d.ts (`contracts/client-sdk.d.ts.md:68-73`) 明确允许 `allowRelayless=true` 且 `advertiseAddrs` 为空，由调用方提供带外路径。场景 `specs/example-app/spec.md:44-47` 又采用了带外责任表述。

建议把 line 7 改成与 D3 完全相同的“token has no relay path; caller is responsible for an out-of-band reachable path”，不要暗示必须存在 `advertiseAddrs`。

### P1-6：错误矩阵测试 owner 与批次边界不一致

矩阵 `contracts/error-matrix.md:56-66` 将 WRONG_FABRIC、NO_REACHABLE_PATH、DIAL_TIMEOUT、TOKEN_CONSUMED、TOKEN_EXPIRED、TOKEN_INVALID 的 E owner 写成 e2e；但 D12/tasks (`design.md:386-410`, `tasks.md:33`, `tasks.md:48`) 明确依赖真实 server/SDK 的 e2e 属 ZCode 4.1，E 只交付 mock/纯函数测试。应把矩阵 E 列改成“E mock”与“ZCode 4.1 integration”两列，或把真实 e2e owner 直接标为 ZCode，避免子代理把非 owner 文件/二进制纳入完成条件。

### P1-7：D4 的“配置序确定性”缺少排序保证

D4 (`design.md:203`) 和 session delta 以 `home_relay_status()` 返回列表的顺序作为配置序，但文档没有证明 iroh watcher 永远保留配置顺序。若底层按连接状态或内部 hash 重排，`lastError` 会不确定。应在内核缓存中保存带配置 index 的候选，按 index 显式排序后再聚合，而不是依赖 watcher 返回顺序。

### P1-8：`config set relay` 的网络副作用与原子写入顺序未定义

example delta (`specs/example-app/spec.md:53`) 要求 `config set relay <url...>` 当场 bootstrap 探测并回显；D6 又要求 tmp+rename 原子写。没有规定探测失败时是否写入、写入后探测失败是否回滚、多个 URL 中一个失败是否保存整个列表，以及 `config set` 是否在离线环境下可用于预填配置。这会使 CLI 行为和自动化脚本不可预测。建议冻结“先校验/探测，失败不写；或先原子写再保留配置但返回非零”的一种语义，并为部分失败数组增加场景。

## 需求与实测缺陷覆盖核对

| 需求/缺陷 | 结论 | 证据与剩余风险 |
| --- | --- | --- |
| relay 为空仍照签 invite | 基本闭合 | D3/roster delta 以 relay 空且 `advertise_addrs` 空拒签，`direct_addr_hints` 不进入签发；escape hatch 独立存在。逃生阀文案仍需修正。 |
| 一次性进程直连地址随退出死亡 | 基本闭合 | 显式 advertise 地址与运行时 hint 分离；无路径 token 在拨号前 `NO_REACHABLE_PATH`。显式地址本身只做语法校验，未定义 0.0.0.0/loopback 是否拒绝。 |
| join 超时且零诊断 | 部分闭合，仍 P0 | deadline、8 码、CLI 前缀和非结构化 redeem 映射已具备；relay probe 代理/多路径归因与 wire framing 仍可能产生错误或不可实现诊断。 |
| chat 对 relay 失败静默 | 基本闭合 | D4 使用 `home_relay_status()`、快照优先、跳变事件、lastError 脱敏和显式 shutdown；列表顺序依赖仍需解决。 |
| wrong-fabric 误报 corrupted | 已闭合 | `DirFabricMismatch`、16 hex 标识、真损坏仍 `Corrupted` 已在 design/roster/session/tasks 对齐；proposal 也已统一。 |
| TTL 10 分钟过短 | 已闭合 | 默认改为 60 分钟，值域 1s-30d，999ms 拒绝/1000ms 接受，过期测试使用固定过去时间。 |
| CLI 纯英文横幅、IP 枚举 | 基本闭合 | D1/D10 与 server delta 覆盖 ASCII、全非 loopback IPv4、无地址占位和服务表；无可枚举地址的 URL/null 行为需与实现共享 fixture。 |
| gateway + services.json 单一配置入口 | 基本闭合 | 独立 relay 端口的约束、Host/IPv6/forwarded scheme/实际端口/no-store/null fallback 已写；unknown/duplicate/scheme 场景缺失。 |
| config list/get/set 与免手输 env | 基本闭合 | 持久文件、权限、优先级、disabled/custom/n0、数组 relay、joinTimeoutMs 均有文字；`config set` 探测失败的写入语义未冻结。 |
| proxy auto/on/off、多 relay 自动择优 | 部分闭合，仍 P0 | 显式 `httpProxy` 所有权和 iroh 原生全量 relay 下发已明确；bootstrap 首项残留和混合可达性的全局 policy 矛盾仍未解决。 |
| `--opt=value` 与 `~` 展开 | 已闭合 | args requirement、场景和 E 任务均要求双形式、展开和未知选项退出码 2。 |

## Design 决策审查

### D1：gateway/services.json

独立 gateway 与 iroh relay listener 的边界合理，避免不可组合的单端口协议嗅探。Host 的 IPv6 剥离、拒绝 `0.0.0.0`/注入、可信 `X-Forwarded-Proto`、实际监听端口、`no-store` 和无回退地址返回 null 均是可落地的安全收紧。

主要缺口是“不可路由值”的集合未冻结，且 nullable/未知/重复/非法 scheme 只有 design 文字没有完整 scenario。`enabled:true,url:null` 视同禁用后，服务端的 enabled 事实与客户端有效性之间要明确日志和最终配置结果。建议使用同一结构化 fixture 驱动 S 与 E，而不是只比较 canonical fixture。

### D2：bootstrap 无环状态机

规范化 -> 代理决策 -> 地址解析的依赖方向正确；空列表不请求、任何完整 HTTP response 只证明 transport 可达、404/200 非 JSON 才 legacy、401/5xx 在解析阶段硬错误，这些分层比上一轮清晰。阻塞点不是环，而是集合策略的内部矛盾（P0-1）以及代理探测后全局 policy 与混合候选的关系。

### D3：invite 拒签与逃生阀

拒签条件、构造期 `ip:port` 校验、永不混入运行时临时 hint、默认拒签和显式 escape hatch 已闭合原始事故。仍建议明确是否拒绝 wildcard/loopback 地址；否则“显式地址即有持久路径”的安全假设只能由调用者自证。产品文案必须修正为带外责任，不得要求 `advertiseAddrs`。

### D4：home_relay_status()

直接消费 watcher、任一 relay online、跳变才发事件、快照先于事件、禁用不监测、shutdown abort+join，解决了先前把 `Endpoint::close()` 当作 watcher 终止信号的隐患。lastError 的配置序依赖未被实现契约证明；应显式保存 index。另需把“watcher 首个值是否广播”与“订阅之后才保证跳变”在 SDK 测试中固定，避免首次 online 被重复呈现。

### D5：DirFabricMismatch

专用变体避让 redeem 侧 `WrongFabric`，16 hex 短标识和真损坏保留规则已在 delta、design、proposal、tasks 对齐。该决策与既有 roster 的跨 fabric 事实隔离相容。

### D6：配置优先级

flag > env > file > default、`DWEB_RELAY=disabled` 整体覆盖、custom 缺 URLS 硬错误、非法 JSON/键/值硬错误、数组 relay 和 Windows 权限说明都已冻结。仍缺 `config set relay` 的探测/写入事务语义（P1-8），以及是否允许 URL 数组部分可达后保存的明确答案。

### D7：proxy auto/on/off

`None|FromEnv|Url` 的 FabricConfig 所有权、构造前决定、undici 显式依赖、env 顺序和 QUIC 不经 HTTP proxy 均已正确写出；多 relay 交给 iroh 原生全量择优也避免了自研选路。D7 本身没有解决 D2 的候选集合冲突，且 relay probe 未映射到同一有效路径（P0-2）。

## 五个 delta 的粒度、可测性与主规格冲突

| delta | 评价 |
| --- | --- |
| `server` | requirement 粒度适中，Host/IPv6/forwarded scheme/实际端口/disabled/null/ASCII 均有场景；未知/重复 service、非法 relay scheme 和 enabled-null 客户端解释仍需补测。与既有 server 的“relay 独立 listener、gateway/rendezvous HTTP API”不冲突。 |
| `example-app` | CLI/config/TTL/bootstrap/proxy/join/chat 均有用户可观察场景；但 line 82 的首项文字与 design/C0 冲突，混合可达场景的最终成功语义不成立。`allow-relayless` requirement 与 scenario 文案相互矛盾。 |
| `fabric/roster` | invite 门、advertise 来源、escape hatch、DirFabricMismatch 与 Corrupted 分界均可测；缺 0.0.0.0/loopback policy（若要拒绝）及错误前缀/退出呈现。与既有 roster 的 root、PoP、单次兑换和真损坏语义相容。 |
| `fabric/session` | watcher 生命周期和 D11 的主要网络分支有场景，非结构化 redeem 也被列出；8 码以外的 MissingIdentity/roster IO 豁免仅写总则，缺逐类场景，探针 proxy/multi-relay 构造不足。与既有 5s redeem channel 上限相容：外层 join deadline 应是更宽或更窄的总预算。 |
| `sdk/node` | d.ts 对 invite 第三参、字面量 mode、httpProxy、joinTimeout、relayStatus、事件 payload 和 unsubscribe 的覆盖较完整；只覆盖空路径/timeout 的错误场景，缺 8 码和豁免前缀的公共契约。 |

对 `openspec/specs/` 的核对：server、session、roster、example 的既有核心语义没有被 r4 的 gateway、invite 门、relay watcher 或错误边界反向破坏；包名勘误已列为 C0.3 owner。另有一个基线遗留需在 C0.3 明确：主 `openspec/specs/sdk/node/spec.md` 仍描述 `start()/stop()`，而 C0 d.ts/现有 change 面使用 `shutdown()`；这不是 r4 新增语义，但当前不能声称 SDK 文档完全无冲突，至少应在主规格或 C0 记录兼容/迁移决定。

## 批次 S/E/F 与跨批契约

### 已具备的并行条件

- C0 先于 S/E/F，集中冻结 d.ts、services fixture、error matrix 和事件 payload。
- S 只拥有 server/opendweb/server-binary/docker；E 只拥有 `packages/example/**`；F 只拥有 fabric 与 client-sdk，源码目录互斥。
- 根 package、lockfile、README、版本、生成 d.ts、两份主规格由 ZCode 唯一 owner，避免并行覆盖。
- E 的纯函数/mock 测试与依赖真实 S/F 的 4.1 联测已拆开；随机端口、自起服务、定向测试和 herdr 全量门禁纪律清楚。

### 仍不足的契约

1. C0 的 bootstrap 表与 example delta 首项文字冲突，不能作为 E 的唯一输入。
2. probe 的输入/输出只在自然语言中存在，F 没有可注入的 transport adapter 或 per-candidate 结果类型，E 的 mock 无法证明真实归因一致。
3. d.ts 没有豁免错误前缀，F 的 native 错误到 SDK/CLI 的边界不完整。
4. error matrix 的 E owner 列与 D12 的真实 e2e owner 不一致；应在 C0 冻结前修正。
5. `config.mjs`、`proxy.mjs`、`relay-resolve.mjs` 虽属于同一 E 批次，但它们之间的 `httpGet` policy 输入、探测结果集合和最终 relay list 没有独立的模块级类型/fixture 契约，P0-1 修订时应一并冻结。

## 可操作的放行条件

1. 统一 design/C0/example/tasks 的候选集合策略，解决混合“仅直连/仅代理”输入的最终解析语义，并逐行补 mock 场景。
2. 为 relay probe 冻结有效代理路径、direct/relay 混合和多候选聚合，定义 DNS/IPv6/端口/计时边界，并提供不依赖墙钟的可注入测试。
3. 把 MissingIdentity、Corrupted、roster-io 的 SDK/CLI 前缀、owner、场景和 wire/原生边界补入 C0/delta/tasks。
4. 冻结 RedeemErrorKind 完整 frame length/unknown payload 行为；补截断、超长、非 ASCII和多帧继续解析测试。
5. 修正 `allow-relayless` 文案、error-matrix owner、D4 配置序排序、`config set` 写入事务语义，并在 C0.3 处理主 SDK 的 `start/stop` 与 `shutdown` 基线冲突。

完成上述修改并重新运行 strict validate 后，再进入 S/E/F 并行 Apply；当前结论仍为不放行。

## 综合评分依据

| 维度 | 评价 |
| --- | --- |
| 需求覆盖 | 8.5/10：原始事故、TTL、ASCII/gateway、配置入口、错误诊断和 relay 观测均有明确落点。 |
| 技术决策一致性 | 7.5/10：D2/D7 方向正确，但候选集合与 probe 路径仍存在会改变行为的矛盾。 |
| 可测性与契约 | 7.5/10：C0、wire discriminant、测试 owner 明显增强，但 framing、豁免和真实 e2e owner 未完全冻结。 |
| 并行编排 | 8.5/10：目录/文件 owner 和测试边界清晰，跨批输入仍受上述契约缺口影响。 |

综合为 **8.0/10**，相对第三轮 **+0.5**；主要加分来自 P0-1 的无环状态机、P0-2 的边界/错误矩阵推进和 D4/D6/D12 的工程化收紧，扣分集中在两个仍会导致不同实现结果的 P0。
