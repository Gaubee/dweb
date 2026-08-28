# connectivity-ux-hardening 实现复审报告（R3）

日期：2026-08-28  
复审对象：当前工作树的 `git diff` 与未跟踪文件  
基准：`openspec/changes/connectivity-ux-hardening/`（design D1-D12、C0 contracts、五个 delta、tasks）

## 结论

建议评分 **7.1/10**，相对 R2 的 6.4 分上升 0.7。核心 P0 已从上一轮的“异常路径可能悬挂”推进到可接受的关闭语义：issuer 的 silent/emitted 分流已经覆盖主要读写异常，join 的 8 码映射、wire fixture 和真实连接测试也形成了可复核证据。但当前仍不能放行：relay 探针的并发资源边界、issuer 17 行映射的机器绑定、公共 d.ts 契约、D10 动态输出，以及多 relay 事件 URL 投影仍存在实质问题。

本轮接受用户提供的门禁证据：workspace cargo test 11 组全绿、clippy `-D warnings` 全绿、SDK/example/opendweb/server-binary JS 测试全绿，包含真实 relay watcher 和新增 I/O 关闭测试。轻量复核中 `git diff --check`、三个 JS 文件 `node --check` 均通过；未重复运行重型 workspace 构建。

## 阻塞问题

### P1-1：relay probe 超时释放 semaphore，后台 blocking task 仍可累积

证据：`crates/dweb-fabric/src/fabric.rs:643-680`。

`default_relay_probe()` 在 async 函数中持有 `_permit`，然后启动 `spawn_blocking` 执行 DNS 和 `TcpStream::connect_timeout`。外层 `timeout()` 到期后，JoinHandle 被丢弃且 permit 立即释放；DNS 仍可能阻塞在线程池中。下一次探针可以再次拿到 permit 并创建新的 blocking task，连续慢 DNS 会堆积 Tokio blocking 线程。这与 D2/D11/D12 所要求的“在途即失败、不堆积阻塞池任务”不符，注释中的“残留阻塞任务自行结束”也没有可证明的资源上界。

建议把 permit move 进 `spawn_blocking` closure，使后台任务结束前始终占用唯一 permit；更好的方案是改用可取消的异步 DNS/TCP。增加“首个探针超时后立即发起第二个探针，第二个不启动或明确返回 busy”的测试与观测断言。

### P1-2：issuerMapping 仍不是 17 行到 Rust 分支的逐行机器投影

证据：`crates/dweb-fabric/src/session.rs:476-495`、`crates/dweb-fabric/tests/redeem_wire.rs:685-723`。

`redeem_verify_emit()` 对五个结构化变体之后使用 `_ => None`。测试虽然读取了 JSON、断言 17 行、ASCII、emit/kind/joinerResult 不变量和四个 kind 覆盖，但没有按 `variantId` 逐行验证 Rust 实际分支。因而“machine verified”只验证文档内部一致性，不能防止实现分支漂移，也不能让后续新增 `RosterError` 变体显式触发审查。

建议显式匹配当前 redeem 阶段应处理的变体，并对防御/非兑换变体保留显式分支；或者生成代码侧 projection，测试逐行把 17 个 `variantId` 绑定到构造器和返回结果。`_ => None` 不应继续承担契约兜底。

### P1-3：公共 d.ts 与 C0.1 的 httpProxy 类型不一致

证据：`packages/client-sdk/index.d.ts:105-124`、`openspec/changes/connectivity-ux-hardening/contracts/client-sdk.d.ts.md:80-105`。

C0.1 冻结了导出的 `HttpProxyOptions`，并要求 `FabricOptions.httpProxy?: HttpProxyOptions`。当前产物仍将联合类型内联在 `FabricOptions`，同时额外导出 `HttpProxyUrl`；`rg` 也确认 `index.d.ts` 没有 `export type HttpProxyOptions`。运行时行为大致正确，但消费者无法按权威契约导入该公共别名，重新生成后的 API 也存在漂移风险。

建议导出 `HttpProxyOptions`，让 `FabricOptions.httpProxy` 使用该别名；删除或明确标记 `HttpProxyUrl` 为内部生成类型。加入 `tsc --noEmit` 的最小消费者 fixture，覆盖判别联合、relay 元组、事件和 `relayStatus()`。

### P1-4：D10 动态输出仍有未转义路径

证据：`packages/example/src/cli.mjs:491,512`、`packages/opendweb/bin/opendweb.mjs:124-132`。

example chat 将 relay URL 直接插入 `relay: online (...)` 和恢复消息；URL 来自配置/SDK 状态，理论上可含非 ASCII 或控制字节。server 横幅也直接插入 version、gateway/relay bind 和 IP。虽然正常输入通常是 ASCII，D10 要求的是所有用户面动态值均按 UTF-8 字节转义并保持一行一错误，当前实现仍允许控制字符破坏输出结构。

建议所有动态字段统一经过同一个 `asciiEscape()`；横幅使用已校验/转义后的 bind、version、IP，chat 对 `url` 和 `lastError` 同样处理。补充控制字符、非 ASCII URL、异常 bind 的断言。

### P1-5：D4 的 relay-online 实际选中 URL 在 SDK 层被丢弃

证据：`crates/dweb-fabric/src/fabric.rs:251-275,739-744`、`packages/client-sdk/src/fabric.rs:648-652`、`packages/example/src/cli.mjs:488-512`。

内核按配置序计算 `RelayOnline { url }` tie-break，但 SDK 用 `FabricEvent::RelayOnline { .. }` 忽略该 URL，只投递包含完整 URL 列表的快照。example 再取 `st.urls[0]`，在 relay-1 离线、relay-2 上线时会显示 relay-1，造成“在线 relay”诊断错误。C0 要求快照同构并不等于可以丢掉 D4 的选中项语义。

建议二选一：在 `RelayStatusJs`/事件 payload 增加明确的 `activeUrl` 并同步 C0/d.ts；或不再打印具体 URL，只打印状态，避免把配置首项冒充实际可达项。必须补多 relay tie-break 的 SDK/e2e 断言。

### P1-6：普通 `connect()` 仍没有同一 EndpointId 的 single-flight

证据：`crates/dweb-fabric/src/fabric.rs:1217-1255`。

并发调用 `connect(id)` 都可能在检查 `peers` 后释放锁并进入 `endpoint.connect()`；随后两个连接可互相覆盖 `peers` 条目并重复广播 `PeerConnected`。epoch 只避免旧 watcher 删除新条目，不能消除重复拨号或旧连接继续占用 NodeId 去重窗口。R3 对 register 失败清理和 recent-disconnect 容量的修复没有覆盖这个并发边界。

建议增加按 EndpointId 的 in-flight/single-flight 表，第二个调用等待第一个结果；或在插入前做原子占位。补双并发 connect、一个失败一个成功、断开后立即重拨的事件和连接数断言。

### P1-7：公共 `read_frame()` 的 32KiB 上限存在一字节边界错误

证据：`crates/dweb-fabric/src/session.rs:281-299`。

长度域表示 `type + payload`，实际整帧字节数是 `4 + len`；当前检查写成 `5 + len > limit`。因此恰好等于 `MAX_REDEEM_FRAME` 的合法帧会被拒绝（有效上限少 1B），且现有 fixture 只覆盖 255B 记录，未触及 32KiB 边界。

建议改为按 `4 + len > limit` 检查，并增加恰好 limit、limit+1 的真实读写测试；同时确认所有 `write_frame` 调用方在发送前执行同一上限校验。

## P0 关闭语义复核

上一轮 P0-1 的主要缺口已修复。`session.rs:511-624` 的 `InnerErr::Silent/Emitted` 分流现在覆盖：`accept_bi`、两处 `read_frame`、challenge/proof 写读异常、协议判定、verify/consume/grant/事实编码失败和 handler deadline；Silent 出口统一 `conn.close()`，emit=true 才写 `REDEEM_ERR` 后交由 accept loop 有界等待。`fabric.rs:1619-1635` 对成功和结构化拒绝均等待对端读取后再关连接，避免关闭帧先于 QUIC 流数据到达。

`io_failures_close_within_bound()` 已对无 bidi 流、首帧 EOF、截断头做真实连接时延断言，`expect_no_structured_frame()` 对主要 emit=false 行断言无帧且小于 2 秒。因此 P0 关闭路径可以判定为基本闭合。

仍有一个低一级缺口：`session.rs:598,606` 忽略 `send.finish()` 的返回值。若 finish 在连接仍存活时失败，当前不会显式转入 Silent close；通常这表示流已停止，故列为 P2 语义/测试风险，而非重新升级 P0。建议统一 `map_err` 到 Silent 并覆盖 finish 失败注入。

## D1-D12 与契约对照

- **D1 server/services**：实际 gateway/relay 端口、nullable URL、Host 原始字节校验、X-Forwarded-Proto 信任开关、no-store、unknown/duplicate service 语义和本机 IPv4 回退均已落地。JS 横幅和 Rust 回退地址的接口枚举顺序仍不同：`networkIPv4s()` 排序，`primary_non_loopback_ipv4()` 取 getifaddrs 首项；缺失 Host 的回退场景可能出现不同“首个”地址，建议统一选择函数或明确顺序契约。
- **D2/D7 bootstrap**：规范化 -> 代理决策 -> 地址解析无环；候选集合判定、混合可达时统一 from-env、n0/disabled 短路、代理环境顺序和窄 fallback 均已实现。注意 `resolveOneRelay()` 将合法 JSON 但非对象/数组也当作 legacy（`packages/example/src/relay-resolve.mjs:52-59`），而正文只允许 404 或 200 非 JSON fallback；应补“非法 JSON manifest”的硬错误语义，或把该行为写入契约。
- **D3 invite / advertise**：无 relay 且无显式地址拒签，allow-relayless 独立放行，运行时临时 hint 不混入 token，地址通配/端口 0/重复校验均已实现。
- **D4 watcher**：直接消费 `home_relay_status().stream()`，任一连接即 online，首值只写快照，跳变才发事件，lastError 按配置序聚合，shutdown abort+join 已实现。上面的 P1-5 是 SDK 丢失 tie-break URL 的跨层投影问题。
- **D5/D11 join**：令牌预检在身份句柄和名册加载前执行；DirFabricMismatch 与 issuer 侧 WrongFabric 分离；空路径秒败；结构化拒绝、非结构化失败、内层 5 秒和外层 deadline 的归类主要正确。`join_with_deadline()` 为避免 iroh 取消竞态而保留 detached connect task，见 P2 生命周期风险。
- **D6 配置**：flag > env > file > default、原子写、权限收紧、URLS 隐式 custom/空项过滤和 config set 离线保存均已实现。
- **D8-D10 CLI**：`--opt=value`、`~` 展开、TTL/join timeout 和 ASCII helper 已覆盖主要路径，但 P1-4 仍说明动态输出未全量收口。
- **D12 批次契约**：C0 JSON fixture 被 Rust `include_str!` 编译期读取，E/F 测试边界大体可并行；P1-2 说明“逐行机器绑定”仍是契约宣称而不是实际门禁。

## wire、reduction 与 issuer 事务

`session.rs` 的外层 framing 使用既有 `write_frame/read_frame`：`u32_be(1 + payload_len) + type + payload`；`REDEEM_ERR` 内为 `kind(1B)+len(1B)+payload`，短读归非结构化失败，未知 kind 按长度消费，多记录 reduction fail-closed。`redeem_wire` 通过 `include_str!` 读取 12 例 JSON，并在真实连接上覆盖 canonical、结构化拒绝、无帧出口、边界载荷和短读。

issuer 事务已把 verify/consume/grant/事实编码放在 roster 锁内，帧写 I/O 移到锁外；这解决了锁内网络 I/O 的死锁/吞吐风险。事务失败后的 silent close 方向正确，但 `finish()` 返回值与两个 defensive-only 分支仍应有更明确的错误注入边界。

## iroh 竞态对策评估

disconnect 排空、recent disconnect 预沉降、HELLO 5 秒有界等待、干净 close、2.5 秒退避单次重试，是针对本机实证的合理 workaround；比随意取消 `endpoint.connect()` 更符合 iroh 同 NodeId 去重行为。代价是失败场景可能增加约 7.5 秒延迟，且仍需要 P1-6 的 single-flight 来避免多个调用者同时制造相同竞态。join 侧 detached connect task（`fabric.rs:545-555`）避免了取消半开连接，但未保存 JoinHandle，Fabric shutdown 无法等待它，建议纳入受控任务集合或证明 endpoint close 后的资源上界。

## relay_ca_tls 公共 API

`FabricConfig.relay_ca_tls: Option<iroh_relay::tls::CaTlsConfig>` 能使自签测试 relay 在真实 watcher 测试中建立信任链，`None` 保持平台默认根，功能上合理。但它把上游 `iroh-relay` 类型直接暴露到 dweb-fabric 公共配置，且不在 D1-D12/C0 SDK 公共面中；下游还可直接选择 `insecure_skip_verify()`。若是正式自托管能力，应补 design/API 文档并冻结受限抽象；若只是测试注入，应 feature-gate 或改为内部/test-only 配置。当前列为 P2 contract/耦合风险。

## 测试覆盖与门禁判断

- F：12 fixture 的 compile-time JSON 输入、真实 `read_frame/write_frame` round-trip、reduction、结构化拒绝和主要 silent 行均有测试；新增 I/O close timing 覆盖了上一轮 P0 的关键缺口。但 entry decode-invalid、peer-mismatch 等个别行没有统一耗时断言，17 行 mapping 测试也没有逐行 projection。
- E：用户提供的 example 108 项、proxy/config/relay-resolve 回归覆盖了空列表、无环境代理、混合可达、n0/disabled、URLS 隐式 custom 和配置写入语义；缺少合法 JSON 错形 fallback 的明确契约测试。
- SDK：12 项 JS 测试覆盖 relayStatus、事件、invite 门、错误码和构造校验；d.ts 没有 `HttpProxyOptions` 别名，也没有 `deriveErrorCode` 声明，建议增加类型编译门禁。
- S/server：25 项 server 测试覆盖 Host 拒绝集合、nullable/unknown/duplicate service 和实际端口；跨平台网络接口顺序与横幅仍缺同源选择测试。

## P2 及开放问题

1. `packages/client-sdk/index.js:71-77` 运行时导出 `deriveErrorCode`，但 `index.d.ts` 没有声明；若它是公共 API，应补声明，否则应改为内部 helper。
2. `fabric.rs:545-555` 的 detached connect task 未纳入 shutdown 追踪，可能延迟 endpoint/网络资源释放。
3. `fabric.rs:1407-1420` 命中 `known_addrs` 后直接返回，完全覆盖本地 custom relay 列表；D6 只冻结了配置候选全量下发，未冻结 learned 地址与配置 relay 的合并优先级。
4. `fix-dts.mjs:8` 使用 URL `.pathname`，Windows drive path 可能得到 `/C:/...`；应使用 `fileURLToPath()`。
5. `send.finish()` 错误被忽略（见上文），建议统一 close 语义。
6. `fabric.rs:1113-1124` 在目录 fabric mismatch 检查前把令牌 issuer/地址写入 `known_addrs`；该表无 TTL/容量，连续提交不同 issuer 的合法格式令牌可造成无界内存增长。应在目录检查和成功网络流程后再学习地址，或增加容量/过期策略。
7. `packages/client-sdk/index.js:49-64` 的旧 SDK 兼容注释与实现不完全一致：包装器无条件读取 `Native.Fabric.prototype.off`，若 0.1 二进制没有 `off`，调用 `on()` 返回的取消函数会抛错。应 feature-detect `off`，或移除旧二进制兼容承诺。

## 修复顺序

1. 修复 probe permit/后台任务生命周期，并加入超时后重复探针测试。
2. 将 issuerMapping 17 行接入真正的 variant projection，移除 redeem 分支 wildcard 兜底。
3. 对齐 `HttpProxyOptions` d.ts，补 `deriveErrorCode` 类型声明或收回 runtime export，并加 TypeScript 编译门禁。
4. 修正 `read_frame()` 32KiB 边界并增加 limit/limit+1 测试。
5. 收口 example chat、server banner 和跨平台 fallback 的 ASCII/地址选择语义；修正 relay-online 选中 URL 的 SDK 投影。
6. 为普通 connect 增加 single-flight，并为 detached join task、`finish()` 失败和 known-address 优先级补生命周期/边界测试。

## 评分与放行判定

**7.1/10（相对 R2 6.4：+0.7）**。

加分项：P0 issuer silent/emitted 关闭路径已覆盖主要 I/O 和 deadline；真实连接时延测试有效；join 分类顺序、外层 framing、12 fixture、reduction、代理状态机、invite 门、watcher 快照和 seed/config 失败路径均有较强实现与测试证据；iroh 竞态 workaround 有本机实证。

扣分项：probe 资源边界仍可能失控；17 行 issuer 映射并未逐行机器绑定；公共 d.ts 与 C0.1 不一致；动态 ASCII 输出和 relay 事件 active URL 有用户面错误；普通 connect 仍有并发重复拨号；另有 detached task、上游 TLS 类型泄漏和多 relay 地址优先级未冻结。

**放行判定：不放行。** 至少完成 P1-1 至 P1-5；P1-6/P1-7 以及 finish/task 生命周期问题也应在合并前处理，之后再复审。
