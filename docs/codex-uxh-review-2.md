# connectivity-ux-hardening 第二轮评审

评审范围：`openspec/changes/connectivity-ux-hardening/` 的 proposal、design、tasks、五个 delta 和 C0 contracts；同时与当前 `openspec/specs/`、iroh 1.1.0 公共 API、现有 kernel/SDK 接口交叉核对。仅评审文档，未修改 change 或产品代码。`openspec validate connectivity-ux-hardening --strict` 在本轮通过；它证明 OpenSpec 结构合法，不证明运行时契约已闭合。

## 结论

**6.5/10（较上一轮 4.0 提升 2.5），仍阻塞，不建议进入 Apply。**

修订实质解决了上一轮的两个设计方向错误：代理所有权已从环境变量副作用改为 `HttpProxyConfig` 到 iroh builder 的显式映射；join 也有了 30 秒默认 deadline、空路径秒败和可呈现的错误矩阵。D1/D3/D4/D5/D6/D9/D10 与 C0 的补强也显著提升了可实施性。

但 P0-1 仍有一个真实的启动顺序环，P0-2 的错误分类还不是全函数，二者均会让实施者无法按文档给出稳定行为。先修复这两项，再启动 S/E/F 并行批次。

## 阻塞问题

### P0-1：D2 与 D7 仍互相依赖，`auto` 无法决定首次 services discovery 该怎样请求

`design.md:103` 规定首次 `GET <url>/services.json` 遵循“D7 已决策略”；但 D7 的 auto 算法在 `design.md:252-260` 又把“D2 解析后的 relay/gateway URL 列表”作为输入。没有已决定的策略，就不能做 D2；没有 D2 的产物，又不能做 D7。`specs/example-app/spec.md:77,91-97` 重复了同一语义。此环会迫使实现随意选择“首次总是直连”或“首次继承环境”，两者会直接改变 auto 行为。

`design.md:265` 还把 `undici.ProxyAgent` 当作“Node 内置”可直接导入。当前 workspace 中 `require.resolve('undici')` 失败；Node 18 的 global `fetch` 使用 undici 实现并不等于应用可导入 `undici` 的 `ProxyAgent`。此外 iroh 1.1 的 `proxy_from_env()` 实际读取顺序是 `HTTP_PROXY`、`http_proxy`、`HTTPS_PROXY`、`https_proxy`，与 D7 “只读小写”的陈述不符。错误矩阵又声称 auto 已验证“直连和 proxy 都不可达”，但 D7 只探测直连，未进行 proxy 探测。

**必须修改为一个可执行 bootstrap 状态机：**

1. 先规范化用户输入的原始 URL 列表，明确每项是 gateway、legacy bare relay，还是允许逐项 discovery；不得先要求 D2 产物。
2. `auto` 对原始 gateway 候选先做直连的有界 services/health 请求；若直连 discovery 失败且存在有效环境代理，再以 proxy 做同一请求。以实际成功路径决定 `none` 或 `from-env`，之后才解析 manifest 并构造 Fabric。legacy relay 没有 `/healthz` 时的判定规则也必须单列，不能把 404 当作“直连不可达”。
3. 冻结 `HTTP_PROXY/http_proxy/HTTPS_PROXY/https_proxy` 的优先级、空值和非法 URL 行为；若保留 `ProxyAgent`，在 `packages/example/package.json` 增加显式依赖，并将 lockfile 更新交给唯一 owner。否则选择一个当前依赖集可用、支持显式 dispatcher 的 HTTP 客户端。
4. 以“direct success / proxy success / both fail / no proxy / legacy relay”建表测试；仅在 proxy 请求实际失败后才输出“both directly and via proxy”。

### P0-2：七个 join 错误码尚非全覆盖、可判定的分类函数

`design.md:287-309` 和 `contracts/error-matrix.md:19-26` 承诺每个 join 失败都归入七个稳定 code，但矩阵没有定义数个真实分支：

- `endpoint.connect()` 在 deadline 之前立即返回连接、DNS 或协议错误时，矩阵既不满足 `RELAY_OFFLINE` 的“无直连地址且本地 relay 全离线”条件，也没有到达 `DIAL_TIMEOUT`。原始错误会泄漏，或实现只能错误地把立即失败伪装成 timeout。
- `home_relay_status()` 描述的是**加入方配置的 home relays**；令牌中的 `issuer_relay_url` 可以不是其 home relay，甚至加入方配置可为 disabled。因此它不能单独判断令牌拨号路径“relay offline”。必须规定观察 token relay 候选的方式，或缩窄 `RELAY_OFFLINE` 的适用条件。
- 当前会话层把兑换拒绝包装为 `RedeemRejected(String)`；`TOKEN_CONSUMED` 不能可靠地从自由文本判定。应冻结兑换错误的 wire discriminant/结构化 `RedeemErrorKind::Consumed`，再映射到前缀。
- “非空但格式非法”的 token relay/direct address 既不满足空路径条件，也没有指定归入 `TOKEN_INVALID` 还是其它 code。错误码集合需要覆盖该输入，且要规定优先级。

错误码的验收也未随之闭合。`design.md:309` 要求每码至少一个 e2e 或单测，然而 `contracts/error-matrix.md:45-48` 的 F 最低集遗漏 `TOKEN_INVALID` 和 `RELAY_OFFLINE`，E 只要求“抽样”；五个 delta 中 session 仅有 `NO_REACHABLE_PATH`、`DIAL_TIMEOUT`、`RELAY_OFFLINE` 三个新场景，SDK 仅断言 `NO_REACHABLE_PATH`。

**必须先冻结总分类和验收矩阵：**以 `decode -> expiry -> existing-dir fabric -> token address normalization -> connect/redeem under one total deadline` 写出互斥、穷尽的优先级表。为“立即 dial failure”决定新增 `DIAL_FAILED`，或明确它如何进入现有七码（并调整名称/建议文本）；不要依赖错误字符串。deadline 必须包住 connect 与 redeem 的整个 join 工作流，并在超时取消/关闭已有连接。随后在 session + SDK + example delta 和 tasks 中为七码逐一列出可重复构造的场景、预期 SDK kebab 前缀、CLI `SCREAMING_SNAKE` stderr 与退出码。

## P1：进入 Apply 前应一并修正

1. **D4 的 shutdown 规则与 iroh API 相反。** `design.md:154-159` 说 endpoint 关闭后 `home_relay_status().stream()` 会结束；iroh 1.1 文档明确 watcher 只在最后一个 `Endpoint` clone drop 时断开，`Endpoint::close()` 不会使 watcher 断开，必须与 `Endpoint::closed()` 组合。因此任务中的“shutdown 取消”没有可执行机制。明确 `tokio::select!`/abort-and-join 的 owner，并测试 shutdown 后无任务、无事件。还须冻结多 relay 单一 `lastError` 的选择规则，以及 Rust `RelayOnline { url }` 与 SDK “事件 payload 为完整快照”的投影形状；当前 d.ts 的可选 `relay?: RelayStatusJs` 不能保证 relay 事件一定携带 payload。

2. **D2 的回退规则和数组语义在三处不一致。** design/example delta（`design.md:107`、`specs/example-app/spec.md:77`）仍写“非 200、非 JSON、超时”全部回退裸 relay；tasks `2.3` 则是“仅 404/非 JSON”。这会把 401/500/超时的 gateway 误作 relay，重新吞掉配置诊断。按修订意图统一为仅 404 或非 JSON 的 legacy fallback，并为超时、5xx、认证失败规定可操作错误。数组只解析第一项、其余直接交给 iroh（`design.md:105,211`）；第二项若也是 gateway 会被错误下发为 relay。限制数组项类型，或逐项解析并去重。`config set relay <url>` 也没有写出如何写入数组，导致“两个 URL 的数组”场景不可执行。

3. **D11 的可配置 timeout 没有完整产品入口。** d.ts 有 `joinTimeoutMs`（`contracts/client-sdk.d.ts.md:92-93`），但 SDK delta requirement、D6 已知 config 键、优先级表、CLI flags 与 tasks E 都没有相应入口。要么明确“仅 SDK 可配”，要么加入 `joinTimeoutMs`/`--join-timeout`、其 env/file/flag 优先级和值域场景。错误前缀也应统一写为 `[<kebab-code>]`；D11 的 `[<code>]` 表述与 d.ts/matrix 的 kebab 前缀容易被实现为大写下划线。

4. **TTL 文档自相矛盾。** `design.md:278` 将 `500ms` 列为可接受示例，下一行及 example delta 规定下限为 `1000ms`。删除 `500ms`，并增加“999ms 拒绝、1000ms 接受、整数/溢出”场景。

5. **错误与目录术语仍有遗留冲突。** `proposal.md:62` 仍称 `Corrupted` 分支改为 `WrongFabric`，而 design、roster delta、matrix 已冻结新变体 `DirFabricMismatch`。此外 `WRONG_FABRIC` code 目前只定义为目录不匹配；既有 `redeem_verify` 的 token/fact `WrongFabric` 将如何映射未写。改正 proposal，并在分类表中明确两种 Rust 变体的稳定 code 和优先级。

6. **C0 contracts 的类型/fixture 仍需收紧。** `RelayStatusJs.mode: string` 和 `RelayOptions.mode?: string`（`contracts/client-sdk.d.ts.md:25-33,99-102`）放弃了 delta 所称的联合类型；改为字面量 union。`services.fixture.json` 含 `$comment`，但 server delta 的“字段名与结构完全一致”场景没有说明它是 fixture 元数据还是 wire 字段，实施者无法同时满足。将注释移出 JSON 或明确测试比较时忽略它，并冻结 required/nullable 字段。

7. **D1/D6 的少量边界尚无验收。** Host 无效且机器没有非 loopback IPv4 时 services.json 的行为未定义；Host 的 IPv6/port 形式也未列场景。`DWEB_RELAY=custom` 但 `DWEB_RELAY_URLS` 缺失/为空、非法 `DWEB_RELAY`/`DWEB_PROXY` 值，以及 Windows 上 0700/0600 的等价行为均没有定义。它们不推翻当前方向，但应在实现前写成输入错误或明确默认值。

## 需求覆盖核对

| 需求或实测缺陷 | 本轮判断 | 依据与残余 |
| --- | --- | --- |
| relay 为空仍签 invite | 基本覆盖 | D3 已冻结显式 `advertise_addrs`、构造期校验和拒签三分支。`allow_relayless` 仍可绕过，CLI WARNING 不应声称 token 含“显式直连地址”，而应说明调用方需提供带外可达路径。 |
| 一次性直连地址随退出死亡 | 基本覆盖 | 签发不再混入 `direct_addr_hints()`，无路径 token 有前置诊断；但整体 join 分类仍是 P0-2。 |
| join 只有超时且零诊断 | 部分覆盖，仍 P0 | 30s、NO_REACHABLE_PATH 和 CLI 格式已写入；分类总函数、兑换已消费与全部场景缺失。 |
| chat 对 relay 失败静默 | 部分覆盖 | watcher、快照优先、WARNING 已补；watcher 的关闭、初始空状态与 `lastError` 聚合未闭合。 |
| wrong-fabric 误报 corrupted | 基本覆盖 | roster delta 的 `DirFabricMismatch`、16 hex 和真损坏分流清楚；proposal 术语与稳定映射须修正。 |
| TTL 10 分钟过短 | 部分覆盖 | 默认 60m、1s-30d、溢出处理已写；`500ms` 示例矛盾。 |
| 纯英文横幅、vite 风格 IP、gateway/service table | 大体覆盖 | ASCII 样例与 `<128` 测试已修复，IP/实际端口/disabled 条目都有场景；补 Host 无可用 IPv4 边界即可。 |
| 单一配置入口与持久 config | 部分覆盖 | gateway discovery、config CRUD、权限、原子写和优先级表均已进入 requirements；数组写入和 env 非法值还不可验收。 |
| proxy auto/on/off、多 relay 原生择优 | 部分覆盖，仍 P0 | 取消自研路由、显式 `httpProxy`、QUIC 边界正确；bootstrap 环与 proxy HTTP 客户端依赖仍阻塞。 |
| `--opt=value`、`~`、未知选项 | 覆盖 | requirement、场景和纯函数任务对齐。 |
| 免逐终端手输 env | 部分覆盖 | config 覆盖 relay/proxy/data/TTL；join timeout 和数组输入接口尚未闭合。 |

## 五个 delta 与主规格

- **server delta**：gateway 名称、别名、actual port、可信 forwarded scheme、Host fallback、disabled relay、ASCII banner 均已有清晰场景，是五者中最完整的一份。补充 Host IPv6/port 与“无可回退地址”即可。
- **fabric/roster delta**：拒签、持久地址和 `DirFabricMismatch` 的场景粒度足够，且与主 roster 的 issuer-online 和既有 `WrongFabric` 语义相容。修正 proposal 术语，并明确 escape-hatch 的真实警告即可。
- **fabric/session delta**：正确地把 D4 改为 watcher、把 D11 写成 requirement，但只有三类 join scenario，且没写关闭机制和 token relay 与 home relay 的关系；这是 P0-2/P1 的主要落点。
- **sdk/node delta**：新增 on() unsubscribe、snapshot-first 和 relay events 是必要补充；但 `joinTimeoutMs` 与完整前缀/错误场景只在 C0 contract，没有进入 delta requirement。改为可辨析 event union 后再冻结。
- **example-app delta**：功能覆盖面充分，但 gateway fallback、proxy bootstrap、数组输入和七码 e2e 尚不一致。不要让一个“解析失败”同时承担 legacy compatibility 与所有网关故障。

与主规格没有发现新的目标相反要求：session 的“无地址快速失败”被 D11 加强，server 的独立 relay 端口与 gateway 清单相容，roster 的单次在线兑换未改变。当前 `openspec/specs/sdk/node/spec.md` 已有未提交的包名勘误；评审按工作树事实处理，不把它当作本 change 已完成的产物。C0.3 仅列 sdk/node 两处，但 `openspec/specs/example-app/spec.md:4` 仍有旧 `@dweb/client-sdk`，需把勘误目标列全并指定 ZCode 为该主规格文件的唯一 owner。

## 批次与并行性

相较第一轮，批次设计已明显改善：C0 给出了 d.ts、services fixture 和错误矩阵；S/E/F 的源码目录互斥；根元数据、README、版本和生成 d.ts 有唯一 owner；随机端口、自起服务、定向测试和最终整合门禁也写清了。

仍不足以无条件并行：

- C0 必须在两项 P0 修订后重新冻结，否则 E/F 会各自实现不同的 bootstrap 和错误映射。
- E 可并行完成 args/config/mock HTTP 单测，但其真实 gateway e2e 依赖 S，invite/join/relayStatus e2e 依赖 F；`tasks.md:32-33` 应拆为“E 自主 mock 测试”与“ZCode 4.1 跨批 e2e”，不能把后者当 E 子代理完成条件。
- C0.3 修改 `openspec/specs/sdk/node/spec.md`，但 D12 的文件所有权表只列 contracts；将该主规格和 `openspec/specs/example-app/spec.md` 显式列为 ZCode owner，避免实施时无人负责或与其他改动冲突。
- 显式 `undici` 依赖会涉及 E 的 package manifest 与 ZCode 的 lockfile，任务应写明 E 提出版本/变更，ZCode 落 lockfile；否则“唯一 owner”规则会阻断实际构建。
- 将 error-matrix 的“F/E 最低覆盖”改为七码逐项 owner 和测试文件。当前“抽样”与 D11 的“每码至少一个”不兼容。

## 建议的修订顺序

1. 先重写 D2/D7 为无环的 bootstrap 状态机，确定 HTTP 客户端依赖和 proxy 环境语义。
2. 将 D11/error-matrix 变成互斥且穷尽的 join 分类表，冻结兑换错误 discriminant、deadline 范围和全部七码测试。
3. 修正 watcher shutdown、snapshot/payload/lastError 聚合与 d.ts discriminated union。
4. 统一 D2 fallback、relay 数组写入接口、join timeout 配置入口、TTL 500ms、`DirFabricMismatch` 和 package-name 勘误范围。
5. 重新生成 C0 contracts 后再开启 S/E/F；E 的跨批 e2e 留给 4.1 整合期。
