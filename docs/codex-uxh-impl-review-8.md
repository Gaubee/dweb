# connectivity-ux-hardening 实现复审报告（R8）

日期：2026-08-28  
复审对象：当前工作树 `git diff` 与未跟踪文件；本轮只复审实现。  
基准：R7 报告 `docs/codex-uxh-impl-review-7.md`（8.4/10），对照 change 的 D1-D12、C0 contracts、delta 与 tasks。

## 结论

评分 **8.3/10**，相对 R7 **-0.1**。manifest 对合法 JSON 对象的 `services` 缺失/错型已改为硬错误，空数组与无 relay 条目仍保持 disabled；FlightGuard 的 generation 配对、代次比较和 try-lock 异步重试也已实现，R7 指出的“旧 owner 误删新航班”和静默清理失败风险在正常 owner 路径上已消除。但 waiter 引用泄漏仍是 P1，且 schema 硬错误没有被 `config set relay` 的逐项探测路径转换为契约要求的 WARNING。

当前仍**不放行**。waiter 分支为避免未入驻 guard 清理而执行 `core::mem::forget(g)`，但 `FlightGuard` 持有 `Arc<FabricInner>`；每个并发 waiter 都永久泄漏一份 FabricInner 强引用。该资源生命周期问题使 R7 P1-1 尚未闭合，且违反 session 生命周期要求。另一个联动阻塞是 `probeRelayUrls` 对新 hard-error 分支未做逐项归一，导致 `config set relay` 不满足“仍写入并输出 `saved but unreachable` WARNING”的 D2 事务契约。修复方式应是仅在确认 owner 后创建 guard，或使用可安全 disarm 的 guard 后正常 drop；不能 forget。

门禁证据按用户提供结果接受：workspace cargo test 11 组全绿、clippy `-D warnings` 0 错；本轮轻量复核实际通过 SDK/example/opendweb/server-binary **12/111/12/5**，`node --check` 与 `git diff --check` 通过。完整 cargo/clippy 未在本轮重复启动（当前 swap 水位过高）。

## 阻塞问题

### P1-1：waiter `mem::forget(FlightGuard)` 泄漏 FabricInner，生命周期仍未闭合

证据：`crates/dweb-fabric/src/fabric.rs:426-465,1287-1311`。

`FlightGuard` 的 `inner` 字段是 `Arc<FabricInner>`（`:432-436`）。`connect()` 在创建 channel 和 guard 后取得 `connect_inflight` 锁；命中已有航班时，代码在 `:1301-1304` 对 guard 执行 `core::mem::forget`。此时本代 generation 尚未插入 map，直接正常 Drop 会因 `entry.0 == generation` 不成立而成为 no-op；forget 没有必要，却使 Arc 永远不归还。每一个并发 waiter 都累积一个强引用，长期运行会无界保留 FabricInner/Endpoint 及其状态，并使最后一个 Endpoint clone 无法按预期释放。

generation 校验与 Drop 中的异步重试清理本身是正确的：旧 owner 只删除同代 entry，try-lock 竞争最终等待 mutex；manifest 分支也已按预期硬错。但上述泄漏仍属于 D4 session 生命周期阻塞，不能判定 P1-1 完成。

### P1-2：manifest schema 校验已闭合

证据：`packages/example/src/relay-resolve.mjs:69-83`；`packages/example/test/relay-resolve.test.mjs:313-337`；D1/D2 `openspec/changes/connectivity-ux-hardening/design.md:133-153,217-234`。

`200` 且合法 JSON 对象时，缺失或非数组 `services` 现在抛出 `invalid services manifest`；`services: []` 与无 relay 条目仍返回 disabled。新增 `{}`、`services:null`、`services:[]` 三个测试均通过，404/200 非 JSON 的唯一 legacy fallback 语义未回退。

但该修复在 `config set relay` 探测路径仍未闭合（P1-2b）。`probeRelayUrls()` 的 JSDoc 与 D2 事务契约要求逐项返回结果、不抛异常（`packages/example/src/relay-resolve.mjs:174-206`），实现却直接 `Promise.all(urls.map(resolveOneRelay))`；任一 `200 {}` 或 `services:null` 会直接 reject。CLI 已先写入配置，但不会输出 `saved but unreachable: <url> (...)` WARNING，而是落入通用错误处理（`packages/example/src/cli.mjs:302-309,598-611`）。D2 明确要求 bootstrap 解析失败仍保存、非零退出并逐项报告（`design.md:235`）。启动 bootstrap 继续硬失败是正确的；应在 probe 层把 schema 异常按每个 URL 转成失败 outcome，避免吞掉事务报告。

## Single-flight 与取消复核

- owner 在航班插入临界区内分配 generation 并插入带 generation 的 `FlightEntry`；正常成功、失败、取消 Drop 都会尝试清理并唤醒等待者。
- generation 比较阻止旧 owner 在 shutdown 后或新 owner 入驻后删除新航班。
- waiter 订阅共享 sender，owner 结束后复查 peers；等待者取消不会清理 owner 航班。
- 当前没有直接的 owner abort/try-lock 竞争/旧 owner 新 owner 代次测试；这些测试仍应补上，但代码审阅已确认主要竞态保护存在。唯一已确认的残余 P1 是 waiter 的 Arc 泄漏。

## R7 P2 清单复核

以下八项仍可保留为 P2 质量债，不单独阻塞放行：

1. `join_with_deadline` 将 `endpoint.connect` 放入 detached task（`fabric.rs:589-600`），未纳入 Fabric shutdown；超时后继续运行至 iroh 自然结束。
2. `known_addrs` 仍为无 TTL/容量的 `HashMap<EndpointId, Vec<String>>`（`fabric.rs:477,1166-1177`）；命中 learned 地址会提前返回并跳过 custom relay 候选（`:1532-1544`），优先级未冻结。
3. `FabricConfig.relay_ca_tls` 仍直接暴露 `iroh_relay::tls::CaTlsConfig`（`:123-125`），包含 insecure skip-verify 能力，公共 API 边界与安全文档未收口。
4. `FabricOptions.httpProxy` 仍内联联合类型（`packages/client-sdk/index.d.ts:122`），同时保留 `HttpProxyUrl`（`:127-130`）；顶部 `HttpProxyOptions` alias 尚未成为唯一公共声明。
5. `buildBanner` 的 Local host/port/version 未统一 `asciiEscape`（`packages/opendweb/bin/opendweb.mjs:124-125`）；Network 行已转义。
6. `index.js` 直接保存并调用 `Native.Fabric.prototype.off`（`:49-63`），对旧二进制没有 feature-detect。
7. Rust `primary_non_loopback_ipv4()` 按接口迭代取首项，而 JS `networkIPv4s()` 去重后排序；首个地址顺序规则仍可能不同。
8. `fix-dts.mjs` 依赖 marker 与字符串替换（`:35-112`），当前产物唯一且可检查，但生成形状变化时较脆。

另有两个非阻塞质量项：`resolveOneRelay` JSDoc 仍写“Never throws”，与 malformed manifest 的硬错误语义矛盾；`services.find` 的 JSDoc 使用 `@type {any}`，不符合全局强类型偏好。

## 放行判定

**不放行。** `resolveOneRelay` 的 schema 分支本身成立，但 `config set relay` 的 probe 适配遗漏使 malformed manifest 不能按 D2 事务契约逐项报告；同时 waiter `mem::forget` 确定性泄漏 `Arc<FabricInner>`，使 session 生命周期与 shutdown 资源释放契约仍未闭合。修正 guard 所有权/取消方式、probe 异常归一并补 owner cancellation 与 try-lock 竞争测试后，再进入放行复审。R7 八项 P2 维持非阻塞判断。

## 评分依据

加分项：manifest malformed 分支已硬错误且新增三测通过；generation-safe flight state、异步清理重试与现有锁序修复保持一致；四包 JS 门禁实际全绿。

扣分项：waiter 分支 `mem::forget` 造成每个并发调用永久泄漏 `Arc<FabricInner>`，直接保留一个 P1 生命周期阻塞；probeRelayUrls 未适配新 hard-error，违反 config set relay 逐项 WARNING 契约；并发测试仍未直接证明取消/try-lock 竞争下的释放。
