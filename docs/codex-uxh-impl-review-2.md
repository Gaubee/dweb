# connectivity-ux-hardening 实现复审报告（R2）

日期：2026-08-28  
复审对象：当前工作树的 `git diff` 与未跟踪测试/契约文件  ���n+基准：`openspec/changes/connectivity-ux-hardening/`（D1-D12、C0 contracts、tasks）

## 结论

当前实现比上一轮明显前进，但仍不能放行。建议评分 **6.4/10**，相对用户给定的上一轮 **5.8/10，+0.6**。

用户提供的 workspace cargo、clippy、SDK/example/CLI/server-binary 全量门禁证据可接受；本轮没有重复运行重型 workspace 测试。额外执行的 `git diff --check` 无输出，但 `node --check packages/client-sdk/scripts/fix-dts.mjs` 失败，报告中的 SDK 类型结论因此是可复现的构建阻塞，而不是静态推测。

核心 wire grammar、12 个 fixture、bootstrap 的集合判定、invite 门、D11 的主要网络分类和 watcher 聚合方向基本正确。剩余问题集中在：兑换协议异常路径没有统一关连接、发布的 d.ts 与运行时不一致、若干失败路径有状态/任务泄漏，以及多 relay/快照与规范仍有实质偏差。

## 阻塞问题

### P0-1：issuer 并非所有 emit=false/协议异常出口都立即关闭

证据：`crates/dweb-fabric/src/session.rs:510-528`、`crates/dweb-fabric/src/fabric.rs:1560-1573`。

`reject_silent()` 确实在调用处同步执行 `conn.close(1, "redeem-rejected")`，并覆盖了显式的错误判定（错误首帧、坏 token、坏 PROOF 长度/对端等）。但以下异常仍由 `?` 直接返回，未经过关闭 helper：

- `conn.accept_bi().await?`；
- 首帧 `read_frame(...).await?`（包括 EOF/头部或 payload 短读）；
- challenge `write_frame(...).await?`；
- PROOF `read_frame(...).await?`（包括 EOF/短读）。

handler 返回后 accept loop 仍会在 `timeout(REDEEM_DEADLINE, conn.closed())` 上等待，异常连接可能延迟到 5 秒甚至更久才被关闭。这样不能保证 issuerMapping 的“无结构化帧 + 立即关闭”语义，也不能保证 joiner 最终稳定归 `DIAL_FAILED`；特别是只建立 redeem ALPN、不开 bidi 流或发送截断首帧的对端可触发该路径。

现有 `redeem_wire` 的 `expect_no_structured_frame()` 只对若干已显式注入的分支计时；`row_entry_decode_invalid()` 没有耗时断言，首帧/PROOF 的 EOF 和 `accept_bi` 错误也没有通过真实 issuer handler 验证关闭时限。因此 17 行测试全绿不能证明 P0 已闭合。

建议：将 handler 的所有非成功返回统一包在“失败即 close”的 guard/finally 中；对 `accept_bi/read_frame/write_frame` 的 I/O/短读都映射到该出口。emit=true 的路径才允许写帧并等待对端读取。新增真实连接测试覆盖首帧 header/payload EOF、无 bidi 流、challenge/PROOF 读写失败，并同时断言 issuer 在固定短窗口内关闭、joiner 得到 `DIAL_FAILED`。

### P1-1：提交的 SDK d.ts 仍与运行时包装和 C0 契约冲突

证据：`packages/client-sdk/index.d.ts:52,62,93`、`packages/client-sdk/index.js:49-91`、`packages/client-sdk/scripts/fix-dts.mjs:68`。

- `relayStatus(): Promise<RelayStatusJs>` 引用了文件中不存在的 `RelayStatusJs`；
- `FabricEventJs` 未声明；
- `on()` 仍声明 error-first 字符串回调并返回 `number`，而运行时已经返回 `() => void` 并传递事件对象；
- `httpProxy` 仍是 `string | HttpProxyUrl`，没有 C0 要求的 `'none' | 'from-env' | { url: string }`；
- 生成脚本第 68 行的正则将结束分隔符写成了未转义的 `/`，`node --check` 报 `SyntaxError: Invalid regular expression flags`，因此生成链本身不可执行。

这会同时破坏 TypeScript 消费者和下一次 NAPI 重新生成后的确定性修正。当前 JS 测试不包含 `tsc --noEmit` 或脚本语法门禁，故全绿不能覆盖该发布契约。

建议先修正正则并让脚本从干净 NAPI 输出可重复生成唯一声明，再加入最小 TypeScript fixture（覆盖 `RelayStatusJs`、事件判别联合、`on` 取消订阅、httpProxy 和非空 relay 元组）及 `node --check`/生成后 diff 门禁。

### P1-2：SecretSeedHandle 在配置解析失败时仍会被永久消费

证据：`packages/client-sdk/src/fabric.rs:187-211`。

`take_options()` 在有 seed 句柄时先执行 `handle.take()`，再执行 `base()`。若 `to_relay_config`、`to_http_proxy_config` 或 `to_join_timeout_ms` 失败，函数直接返回，已取出的 seed 没有 `put_back`；调用者无法重试同一句柄。`build_with_handle()` 只能覆盖 Rust Fabric 已经开始构造之后的失败，覆盖不到这里。

建议先解析/校验所有选项，再 take；或让 `take_options()` 在每个错误返回前归还 seed，并增加“非法配置后 `available` 仍为 true、修正配置后可重试”的测试。

### P1-3：构造期校验仍晚于持久化副作用，且 Rust RelayConfig 校验不完整

证据：`crates/dweb-fabric/src/fabric.rs:757-767,789-806,817-842`。

`create_root()`/`attach()` 先解析身份并创建/持久化 roster，之后才在 `start()` 调 `config.validate()`。非法 advertise 地址、join timeout、代理 URL 或自定义 relay URL 会留下 identity/roster 文件，下一次重试还可能首先得到 `AlreadyExists`，而不是原始配置错误。`FabricConfig::validate()` 也没有拒绝 `RelayConfig::Custom(vec![])` 或预先校验 custom URL；URL 解析失败只在 `start()` 中发生，且没有专用稳定配置码。

建议把配置完整校验（包括 relay 非空、每个 URL 语法）移到任何身份/名册创建之前；失败路径不写目录。SDK 的判别联合不能替代 Rust 公共 API 的运行时校验。

### P1-4：可达 relay 的初始快照可能错误报告 offline

证据：`crates/dweb-fabric/src/fabric.rs:863-884`。

启动时调用 `endpoint.online()` 的结果被丢弃；随后 `RelayStatusSnapshot.online` 对所有非 disabled 模式硬编码为 `Some(false)`。watcher 后续收到流值后才会改为 true，因此 `Fabric::create_root()` 成功后立即调用 `relayStatus()` 可能看到 offline，尽管 relay 已经可达。现有 `relay_watch` 测试等待快照变 true，未覆盖“构造完成后首读”的契约。

建议把 `endpoint.online()` 的结果或 watcher 的首个状态在暴露 Fabric 前写入快照，并保持首值不广播；增加立即首读和首事件为空的测试。

### P1-5：lastError 脱敏存在凭证/路径泄漏回退

证据：`crates/dweb-fabric/src/fabric.rs:279-308`。

`sanitize_relay_error()` 对未识别错误保留清洗后的前 48 字符；`relay_url_host()` 解析失败时保留原始 URL 前 64 字符。异常文本或 URL 包含 userinfo、完整路径、query 时，会违反 D4/C0 “仅错误类别 + host，不含凭证段与完整路径”的契约。当前单测只覆盖已识别的 timeout/refused/DNS/TLS 文本。

建议未知错误统一映射为固定类别（如 `connection error`），host 只能来自已成功解析且已校验的 URL；解析失败使用固定 `unknown-host`，不要回退原始字符串。补充 userinfo、path/query、非 ASCII 和解析失败样例。

### P1-6：普通成员拨号的 custom relay 只使用首个 URL

证据：`crates/dweb-fabric/src/fabric.rs:1352-1380`。

当没有 `known_addrs` 时，`endpoint_addr_for()` 对 `RelayConfig::Custom(urls)` 只取 `urls.first()`。这与 D6/D7“全量下发，多个 relay 由 iroh 原生择优/故障切换”不一致；首个 relay 故障时，已有配置的其他 relay 不会进入该次 EndpointAddr。invite 本身的字段是单 relay，不能成为本地多 relay 配置被截断的理由。

建议将完整候选集合传入 iroh 的 EndpointAddr/拨号 API，或明确使用 endpoint 已配置的原生 relay 集合而不重建单 relay 地址，并增加首项不可达、次项可达的真实测试。

### P1-7：连接竞态修复留下失败清理和状态边界问题

证据：`crates/dweb-fabric/src/fabric.rs:1175-1244,1265-1277`。

- `register_dialed()` 返回错误时落在 `Ok(res) => return res`，没有像 HELLO timeout 一样显式 `conn.close()` 和有界等待；失败连接可能继续占用同 NodeId 的去重窗口。
- `recent_disconnects` 只插入不删除，按不同 EndpointId 无限增长；长期连接 churn 可造成无界内存占用。
- 两个并发 `connect()` 都可能在检查 peers 后开始拨号，随后互相覆盖 `peers` 条目。当前 `epoch` 只防旧 watcher 误删，不能避免重复连接和重复 `PeerConnected` 事件。

建议为每个 EndpointId 增加 single-flight/in-flight map；所有注册失败统一 close+等待；recent disconnect 记录按 TTL/容量清理，并在成功重拨后删除。

### P1-8：SDK 事件泵没有保存/终止 JoinHandle

证据：`packages/client-sdk/src/fabric.rs:579-655`。

`spawn_event_pump()` 丢弃了 `tokio::JoinHandle`。`shutdown()` 只设置 `shutdown_done` 标志并关闭 Rust endpoint；事件泵仍可能永久阻塞在 `rx.recv().await`，因为 Fabric 内部 sender 仍被持有。没有后续事件时它不会醒来检查标志，任务和回调 Arc 都可能长期存活，违反 SDK “shutdown 后无残留/无回调”的生命周期要求。

建议保存 pump handle，在 shutdown 中显式 abort+join，或向 pump 提供 cancellation channel；同时在关闭路径清空 callbacks 并测试“无新事件、任务已退出、回调可释放”。

### P1-9：relay TCP 探针的 2 秒超时不能取消阻塞任务

证据：`crates/dweb-fabric/src/fabric.rs:627-658`。

`spawn_blocking()` 内部执行 DNS (`ToSocketAddrs`) 和 `TcpStream::connect_timeout`，外层 `timeout` 到期只停止等待，不会停止阻塞线程。DNS 卡住时，探针任务会继续占用 Tokio blocking pool；连续 join 失败可堆积后台工作，实际资源边界不再等同于设计中的有界探针。

建议使用可取消的异步 DNS/连接并把整个操作置于同一 deadline；若必须阻塞，维护可观测的任务句柄并限制并发/在 endpoint shutdown 时回收。

### P1-10：Host 拒绝和回退地址实现仍与 D1 精确语义不一致

证据：`crates/dweb-server/src/services.rs:68-111`。

`host_from_header()` 先执行 `trim()`，所以首尾空格/控制字节会被移除后接受，绕过冻结的拒绝集合。Unix `primary_non_loopback_ipv4()` 又排除了 link-local 和 broadcast，而 D1/横幅只冻结“首个非 loopback IPv4”；在只有 link-local 网卡时，banner 可能有 Network 地址而 services.json 却回退为 null，破坏单一入口的一致性。

建议先按原始 Header 值逐字节校验，拒绝后才进行结构化解析；将 server 与 banner 的候选过滤规则抽成同一规范（或同时明确排除项并更新 D1），并增加首尾空白、link-local 场景测试。

### P1-11：issuerMapping 没有真正由权威 JSON 驱动，且两行仅靠注释豁免

证据：`crates/dweb-fabric/src/session.rs:474-495`、`crates/dweb-fabric/tests/redeem_wire.rs:291-888`、`contracts/redeem-err.fixtures.json`。

`redeem_verify_emit()` 对五个结构化变体后使用 `_ => None`，没有把 17 个 `variantId` 与实现分支建立机器级绑定。测试手工覆盖了主要结构化行、Protocol 和 out-of-scope，但没有读取 `issuerMapping.rows` 逐行核对；`proof-bad-redeemer-key` 与 `post-encode-receipt-failed` 只有 defensive-only 说明，没有对应 fixture-driven 断言。未来新增或改变 `RosterError` 时，wildcard 仍会静默变成无帧关闭。

建议测试编译期/运行期加载 JSON rows，按 variantId 校验 emit/kind/joinerResult；对不可构造分支至少保留显式代码分支和映射单测。能在 Rust 枚举扩展时让审查或测试失败，不能依赖 `_ => None` 隐式兜底。

## 已核对且方向正确的部分

### D1 / server gateway

`services.rs` 已采用实际 gateway/relay 端口，提供 nullable URL、`no-store`、IPv6 括号处理、重复名首个保留和未知名静默忽略；`main.rs` 已支持 `--gateway`/`--http`、`--opt=value` 和 relay bind 解析硬错误。上述 P1-10 是严格边界/跨平台一致性问题，不否定 gateway 主结构。

### D2 / D7 bootstrap 与代理

`packages/example/src/proxy.mjs` 对全部候选做集合式直连探测，代理覆盖时统一以 `from-env` 解析；`relay-resolve.mjs` 在代理决策后逐项解析，fallback 仅 404 或 200 非 JSON，n0/disabled 在探测前短路。可达性（任意完整 HTTP 响应）与解析层 401/5xx 硬错误的分层与决策表一致。用户提供的 example 回归测试覆盖了空列表、无 env、混合可达和 n0/disabled 不探测。

### D3 / D11 invite 与 8 码

invite 只使用显式 `advertise_addrs`，无 relay/无直连地址时拒签，allow-relayless 为显式逃生阀；`precheck_join_token()` 在 SDK joinWithToken 消费身份前执行，目录 mismatch 使用独立变体，空路径在拨号前失败。join 的结构化拒绝、非结构化失败、探针归因和 join/redeem deadline 主要映射正确；但 P0-1 使 issuer 协议违规路径仍不能保证稳定的 `DIAL_FAILED`。

### RedeemErrorKind wire

`session.rs:265-300` 的公共读写器与契约一致：外层 `u32_be(1 + payload_len) + type + payload`，记录是 `kind(1B)+len(1B)+payload`；`decode_records()` 按外层 payload 边界逐条消费，未知 kind 保持位移，多记录 reduction fail-closed。`redeem_wire` 用 `include_str!` 读取 12 例 JSON，覆盖读写 round-trip、短读、0/255 边界、未知值、非 ASCII、额外完整记录和 reduction。该部分是本轮最可靠的闭合面，但没有覆盖 P0 所指的 issuer 异常关闭时序。

### D4 watcher 与生命周期

watcher 使用 `home_relay_status().stream()`，聚合任一 relay online，首值不广播，事件 URL 按配置序 tie-break，lastError 按配置序聚合；Rust Fabric shutdown 已显式 abort+join watcher。P1-4、P1-5 和 SDK 事件泵问题说明“核心 watcher 已关闭”不等于“所有可见生命周期均已关闭”。

### iroh 同 NodeId 竞态对策

disconnect 排空、recent disconnect 预沉降、HELLO 超时干净关闭和单次重试，结合用户提供的本机 10/10 复现，作为局部 workaround 是合理且有证据的；它比给 `endpoint.connect()` 任意套取消 timeout 更符合 iroh 的去重行为。代价是最坏额外约 5 秒 HELLO + 2.5 秒退避延迟，并引入 P1-7 的 map/并发边界。应保留该策略，但把 single-flight、TTL/容量和失败 close 纳入实现契约。

### relay_ca_tls 公共 API

`FabricConfig.relay_ca_tls: Option<iroh_relay::tls::CaTlsConfig>` 能让自签测试 relay 真实联测成功，默认 `None` 仍使用平台根，功能上是合理的测试/自托管能力。它目前未暴露给 JS/CLI，避免了普通用户误配；但将 iroh-relay 具体类型放进 dweb-fabric 公共 Rust API 会耦合上游版本，且允许下游显式使用 `insecure_skip_verify()`。建议 feature-gate 测试用信任配置，或提供 dweb 自有的受限信任枚举/文档，明确不把跳过校验作为生产建议。

## 测试与批次覆盖

- 用户提供的 cargo/clippy 和 JS 门禁说明主路径可运行，包含真实 relay watcher、facade e2e 和断线重拨回归；这些证据对 D1/D2/D3/D4 的正常路径有价值。
- F 的 fixture round-trip/reduction 覆盖充分，但 tasks 3.5 要求的“所有 emit=false 行真实关闭”没有覆盖 `accept_bi/read_frame/write_frame` 的异常路径，故 P0 仍成立。
- issuerMapping 的 17 行虽然有大量手工行测试，测试没有把权威 JSON rows 作为断言源；两个 defensive-only 行不应只靠注释免测。
- E 的 proxy/config/relay-resolve 回归覆盖较完整，但 SDK d.ts 没有 TypeScript 编译门禁；`fix-dts.mjs` 语法错误就是整合门漏检的直接结果。
- tasks 中 S/E/F 文件所有权总体仍互斥，C0 由 ZCode 亲写；当前主要问题是跨批公共产物 `index.d.ts` 没有“生成、脚本语法、类型编译”三段式 gate。

## 修复顺序

1. 修复 issuer 所有非成功出口的立即 close，并补真实连接/短读/最终 `DIAL_FAILED` 时序测试（P0）。
2. 修复 d.ts 生成脚本与提交产物，增加 `node --check` + `tsc --noEmit` fixture（P1-1）。
3. 先校验配置再持久化、修复 seed 归还、RelayConfig URL/空列表校验（P1-2/P1-3）。
4. 修复快照首值、lastError 脱敏、多 relay 全量拨号，以及 connect/pump/probe 的任务和状态边界（P1-4 至 P1-9）。
5. 统一 Host/fallback 语义并将 issuerMapping JSON 接入逐行测试（P1-10/P1-11）。

## 评分依据与放行判定

**6.4/10（相对 5.8：+0.6）**。

加分项：外层 framing 与 `session.rs` 实现一致；12 例 fixture 和 reduction 有真实读写验证；bootstrap 代理覆盖语义、invite 安全门、8 码主要顺序、server manifest 和 watcher 聚合已有较强测试证据；iroh 竞态 workaround 有实测依据。

扣分项：兑换异常路径仍有协议级 P0；公共 d.ts 当前不可直接消费且修正脚本无法解析；seed、配置持久化、任务句柄和 relay 列表存在失败/资源边界；lastError 与 Host/fallback 有契约或安全偏差；issuerMapping 尚未真正机器驱动。

**放行判定：不放行。** 至少完成 P0-1 和 P1-1 后再复审；其余 P1 应在合并前处理，避免把测试全绿误当成公共 API 与异常生命周期已经闭合。
