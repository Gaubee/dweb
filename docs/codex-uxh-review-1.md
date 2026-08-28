# connectivity-ux-hardening 评审报告

评审范围为 `openspec/changes/connectivity-ux-hardening/` 的 proposal、design、tasks 和五个 delta，并与 `openspec/specs/` 主规格及当前接口实现交叉核对。未修改代码；`openspec validate connectivity-ux-hardening --strict` 通过，但这只证明文档结构合法，不代表契约可实现或验收完整。

## 结论与评分

综合评分：**4.0/10，阻塞，不建议进入 Apply**。

change 能识别主要事故链，也覆盖 gateway、配置、邀请安全门、错误语义和 relay 状态等主题；但核心代理策略在当前 iroh API 下不可由所述步骤实现，join 超时仍没有诊断契约，多个状态/URL/错误 API 未冻结，且 delta 场景不足以验收关键边界。文档“覆盖面较广”是加分项，契约冲突和不可执行性是主要扣分项。

## 阻塞问题

### P0

1. **D7 的实现前提不成立，代理策略无法按文档落地。** `design.md:193-202` 与 `specs/example-app/spec.md:54-66` 把 `process.env` 改写当作同时控制 HTTP 和 iroh relay 的机制，并要求在 SDK 加载前完成。当前 kernel 的 relay builder 不读取这些环境变量，而是通过 `RelayConnectionOptions.proxy_url` 显式注入（iroh 1.1）；`crates/dweb-fabric/src/fabric.rs:269-287` 也没有 proxy 字段。Node `fetch` 也不会因清除 `HTTP_PROXY` 自动获得一个可控的“直连/代理”选择器。必须先决定代理所有权：为 Fabric/SDK 增加显式 proxy URL/dispatcher 契约，或明确代理只属于 HTTP 控制面并删除“relay 连接走代理”的承诺；同时定义多 relay 的探测、排序、失败回退和 QUIC 数据面边界。

2. **原始 join 事故仍可表现为无界超时，核心“有诊断”要求没有进入规格。** `proposal.md:9-14` 明确指出死直连地址、空 relay 导致 join 超时零诊断；但 `design.md:90-98,133-159` 只增加发现和 relay 状态，`specs/fabric/session/spec.md:5-22` 没有 join deadline、错误分类、退出码或 stderr 契约。当前 `Fabric::join` 在 `crates/dweb-fabric/src/fabric.rs:425-452` 直接拨号，没有 change 规定的总时限和“issuer offline / no address / relay offline / wrong fabric”区分。必须增加有界 join 时限、可诊断错误结构/稳定 code、CLI 输出与可测失败矩阵，否则主事故未闭环。

### P1

1. **D4 选错观测量且与 iroh API 不符。** `design.md:137-141` 以 `endpoint.home_relay()` 的 `Some/None` 每 3 秒轮询判定在线；公开 API 是 `Endpoint::home_relay_status()`，返回每个 relay 的 `RelayStatus`，须用 `is_connected()`/`last_error()`。home relay 被选中不等于已连接。delta `specs/fabric/session/spec.md:5-22` 也未规定探测超时、多 relay 聚合（any/all）、错误 payload、首次状态和去重。改为状态 watcher 或明确轮询状态 watcher，并冻结 online/offline/unknown、URL 列表和取消生命周期。

2. **disabled relay 被错误地当作裸 relay URL。** `design.md:94-98`、`specs/example-app/spec.md:45-52` 规定 services.json 失败或 `enabled:false` 都回退“按裸 relay URL 使用”。输入若是 gateway，disabled 响应会使客户端把 gateway 端口当 iroh relay，既失败又隐藏真实原因。仅 404/非 JSON 的旧 3340 URL 可裸 URL 兼容；disabled 应返回 `RelayDisabled`/WARNING 并进入 disabled 模式。

3. **services.json 的 Host/scheme 回退不安全且 HTTPS 不可用。** `design.md:43-57` 固定 `http://`，无 Host 时回退绑定地址；默认 `crates/dweb-server/src/main.rs:8-10` 为 `0.0.0.0:8787`，会生成不可达的 `http://0.0.0.0`。必须定义可信 Host 校验、端口覆盖、HTTP/HTTPS scheme（包括反代头的信任边界）和无 Host 的可达网卡回退/拒绝策略，并覆盖 IPv6/Host 注入场景。

4. **D3 未定义“持久 advertise_addrs”来源，且容易误放行临时地址。** `design.md:104-115` 以 `advertise_addrs` 非空为安全条件，但没有说明 Rust/SDK 构造入口、格式校验、持久性证明和空字符串处理。当前实现会在配置为空时生成 `direct_addr_hints()`（含临时绑定端口）。安全门必须只信显式、经校验的持久地址；需冻结字段 schema、API 输入和三分支测试，避免一次性端口被误判为可兑换路径。

5. **WrongFabric 语义与既有错误变体冲突。** delta `specs/fabric/roster/spec.md:48-60` 要求目录路径、stored/requested fabric；但现有 `RosterError::WrongFabric { got, expected }` 还用于 token/fact 跨 fabric（`crates/dweb-fabric/src/roster.rs:819-823`），而 `decode_persisted` 仍在 `:340-350` 返回 `Corrupted`。不能简单改字段而破坏另一语义；应新增目录归属专用变体，或给两类错误明确不同 code/shape，并让 `attach/join` 在读已有目录时先返回该变体。

6. **D1 文案示例违反自身 ASCII SHALL。** `specs/server/spec.md:35-47` 要求纯 ASCII；`design.md:62-75` 使用 `▲`、`➜`，`design.md:159` 使用 Unicode em dash。tasks 仅要求“无 CJK”（`tasks.md:11`），守不住 ASCII。统一为 ASCII，并测试所有输出码位 `< 128`，包括 WARNING、帮助和错误。

7. **配置优先级和 relay mode 推导不完备。** `design.md:175-191` 声称 flag > env > file > default，却没有列出 `--relay/--proxy/--ttl/--data` 的完整 flag schema；`DWEB_RELAY=disabled`、`DWEB_RELAY=n0`、`DWEB_RELAY_URLS` 与文件 relay 同时存在时的覆盖关系未定义。配置文件还未规定非法 JSON、宽权限既有文件、原子写、数组 relay URL、空值/unset 行为。应给出完整决策表和验证/错误契约。

8. **多 relay 自动择优没有数据模型。** `config.json` 的 `relay` 是单字符串（`design.md:179-185`），底层 `RelayConfig::Custom` 却是 URL 数组；D7 又要求“多链路自动择优”，但没有每 URL 的探测结果、排序指标、并列/恢复策略或输出形式。补充数组 schema 与可重复的选择算法，或缩小需求为单 relay。

9. **SDK 跨批契约不足以并行。** `design.md:231-239` 的 `on(cb)` 只是占位，没有事件联合类型、relay payload、取消订阅、错误 code、生命周期和 `InviteWithoutRelay` 传递规则；delta 又要求这些行为。`@dweb/client-sdk` 主规格与设计/实现中的 `@jixo/opendweb-client-sdk` 名称也不一致。应先冻结 d.ts、mock fixture、稳定错误 code 和包名。

10. **relay watcher 初始事件存在竞态，且没有停止规则。** `design.md:138` 规定 Fabric 构造时 spawn、首次探测立即广播；chat 在 `openFabric()` 返回后才注册回调（现有 `packages/example/src/cli.mjs:150-162`）。初始事件可能已经丢失，且 watcher 的 endpoint shutdown 取消/任务泄漏未规定。chat 应调用快照式 `relayStatus()`，事件只负责后续跳变，并定义关闭行为。

11. **TTL 修复虽覆盖“10 分钟过短”，但校验不完整。** proposal/design/example delta 将默认改为 60 分钟（`proposal.md:51`、`design.md:213-215`、`specs/example-app/spec.md:19-22`），方向上覆盖实测缺陷；但 `inviteTtlMs` 无类型、范围、时钟容差和非法配置行为，裸 `0` 的语义也未定。需明确最小/最大 TTL、后缀溢出和配置值与 `--ttl` 的覆盖规则。

## 需求覆盖核对

| 需求/实测缺陷 | 覆盖判断 | 评语 |
|---|---|---|
| relay 空仍签 invite | 部分覆盖 | D3 有拒签门和逃生阀；但未冻结显式持久地址来源，且 SDK/error contract 不完整。 |
| 一次性直连地址随退出死亡 | 部分覆盖 | design 说明原因并拒签，但没有 join 端验证/诊断；`allow_relayless` 允许调用方重新制造不可达 token，警告与责任边界需更明确。 |
| join 超时零诊断 | **未覆盖完整** | 没有 deadline、失败分类、稳定错误码/退出码，是 P0。 |
| chat relay 失败静默 | 部分覆盖 | 有在线/离线文本和恢复事件；初始事件竞态、多 relay 状态和错误原因未定。 |
| wrong-fabric 误报 corrupted | 部分覆盖 | delta 提出专用错误；持久目录 decode 分支、既有 WrongFabric 复用和 SDK code 仍冲突。 |
| TTL 10 分钟过短 | 覆盖但不完整 | 默认 60m，后缀解析列出；边界、配置校验、验收时钟未定义。 |
| 纯英文横幅 | 部分覆盖 | 目标和场景有；设计样例含 Unicode，测试只排 CJK。 |
| vite 风格枚举本机 IP | 覆盖但不完整 | 非 loopback IPv4、去重排序写明；未定义无网卡、IPv6/绑定 wildcard 和实际端口。 |
| 单一 gateway + services.json | 部分覆盖 | D1 结构清楚；Host/scheme、disabled 解析和 relay 实际端口边界不足。 |
| example config list/get/set | 部分覆盖 | 命令存在；输出格式、错误/权限/原子写和 unset 场景不可测。 |
| proxy auto/on/off 多链路择优 | **不可执行** | 仅改 env 无法注入 iroh `proxy_url`；多 relay 选择算法缺失，是 P0。 |
| `--opt=value`、`~` 展开、未知选项 | 覆盖但场景不足 | design/tasks 有目标，delta 只测未知选项，未测等价解析、引号、绝对路径和 config 值。 |
| 免逐终端手输环境变量 | 部分覆盖 | config 文件覆盖 relay/data/proxy；CLI/环境优先级和 gateway 解析失败行为仍可能迫使手工 env。 |

## Design 决策审查

- **D1**：gateway 与 relay 分端口的理由合理，也符合 iroh relay 独立监听限制；但“按 Host 派生”必须防 Host 注入、无 Host 不可达回退和 HTTPS scheme 错误。`/services.json` 还应定义 Content-Type、缓存、实际监听端口为 0 时的行为和 schema 版本。
- **D3**：拒签原则正确，逃生阀也符合 pre-1.0 需要；风险在于把 runtime 自动发现地址当作“持久地址”，以及未说明 `allow_relayless` 是否必须同时要求显式 advertise 地址/确认。
- **D4**：3 秒轮询是过度设计且选错 API；已有公开状态 watcher，直接消费状态更简单、延迟更低并可携带 `last_error`。若保留轮询，必须写明它轮询什么、超时多久、如何停止。
- **D6**：独立于 data 目录的配置位置合理；优先级、schema、权限修复和多 URL 模型没有闭合，`relay` 单字符串与 Custom 数组矛盾。
- **D7**：把 HTTP 控制面与 QUIC 数据面分开是正确方向，但“剥代理即可控制两者”不成立；auto 的探测顺序、代理路径、SDK 初始化时机和 iroh 显式 `proxy_url` 注入必须重写。

## 五个 delta 的粒度与可测性

- **server**（`specs/server/spec.md:5-47`）：把 health、命名/别名、services schema、Host 派生、`/` 摘要、banner 放在少量 requirement 中；场景缺默认 8787/`--gateway`、`GET /`、字段稳定性、无 Host、HTTPS、relay 实际端口。
- **example-app**（`specs/example-app/spec.md:5-80`）：CLI 全集、解析器、TTL、逃生阀、英文文案塞进一个 modified requirement；场景没有 `--opt=value`、`~`、allow-relayless 警告、TTL 后缀、config unset/非法文件、proxy on/失败分支、relay disabled、chat 恢复和 join 超时诊断。应拆分 requirement 或补场景。
- **fabric/session**（`specs/fabric/session/spec.md:5-27`）：只写“周期性”和“首次探测”，没有 3 秒、超时、状态判定、聚合、去重、取消和诊断错误；现有主规格的“无地址快速失败”也没有被新 delta 加强为 join 可观察失败。
- **fabric/roster**（`specs/fabric/roster/spec.md:5-60`）：拒签三分支可测，但 `advertise_addrs` 没有配置入口/持久性定义；WrongFabric 场景无法精确构造“已有 A 目录 + B token”，且短标识长度只在 design 中出现，未在 spec 冻结。
- **sdk/node**（`specs/sdk/node/spec.md:5-41`）：覆盖 API 名称，但事件 payload、错误 code、unsubscribe、初始快照、offline/unknown 和第三参透传缺少可执行断言；包名与 design 不一致。

与主规格没有发现“目标相反”的直接冲突，但有三处契约冲突必须先解决：主 roster 已有 `WrongFabric { got, expected }` 的跨事实语义；主 SDK 包名为 `@dweb/client-sdk` 而 change 使用 `@jixo/opendweb-client-sdk`；主 server 允许 HTTP(S)，change schema 却硬编码 HTTP。主 session 已要求“仅 EndpointId 无地址时快速失败”，change 没有把该行为扩展到 join 诊断。

## tasks.md 批次与并行性

S/E/F 的主要源码 glob（`tasks.md:5-31`）表面互斥，但不能直接并行验收：

- README 由 S/E 提建议、ZCode 统一落盘，根 `package.json`、锁文件、生成的 d.ts、版本号、Docker/发布元数据也没有明确 owner；因此“文件集互不重叠”不成立。
- E 的 `2.5/2.6` 直接依赖 F 的第三参、relayStatus、事件和错误语义；S 的 services schema 又是 E 的 relay-resolve 输入。仅在 `4.1` 事后对齐会造成双方各自绿色但整合失败。
- 跨批契约只有占位 `on(cb)`，没有 fixture、版本、错误 code、事件 payload、取消订阅和 services.json schema。应新增“契约冻结”批次：先提交 client-sdk d.ts/mock、server JSON fixture 和错误矩阵，再启动 E/F；指定 README、根元数据、生成文件和 lockfile 的唯一 owner。
- `tasks.md:3` 禁止常驻 server，但 S/E 的 e2e 又要求服务实例；需规定隔离 fixture、随机端口、子进程清理和不得复用常驻进程的执行方式。
- 全量 `cargo test --workspace`/clippy 的资源纪律已写出，但应把“仅由 ZCode 在受控环境执行”与子代理的定向测试边界写成依赖，而不是把全量门禁看作批次完成条件。

## 可操作修改顺序

1. 先冻结代理所有权与多 relay 模型；把 P0 的 env-only 设计改成可实现的 SDK/Fabric API，补探测矩阵。
2. 增加 join deadline、稳定错误 code/退出码和 relay-disabled/服务发现失败诊断，补 CLI stderr 场景。
3. 重写 D4 为 `home_relay_status()` 语义，定义 any/all、unknown、last_error、初始快照和 shutdown。
4. 修订 services.json 的 scheme/Host/无 Host/disabled 契约，统一 ASCII 样例与全 ASCII 测试。
5. 拆分或补齐五个 delta 的 scenario，特别是 config 权限、TTL 边界、参数两种形式、wrong-fabric 构造和 SDK 事件/错误 payload。
6. 增加契约冻结任务和文件 owner，之后再进入 S/E/F 并行实现。

