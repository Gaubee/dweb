# connectivity-ux-hardening 实现复审报告（R9）

日期：2026-08-28  
复审对象：当前工作树 `git diff` 与未跟踪文件；本轮只复审实现。  
基准：R8 报告 `docs/codex-uxh-impl-review-8.md`（8.3/10），对照 change 的 D1-D12、C0 contracts、delta 与 tasks。

## 结论

评分 **9.0/10**，相对 R8 **+0.7**。R8 的两项 P1 均已闭合：FlightGuard 只在 owner 将 flight entry 写入 map 后延迟创建，waiter 不再持有 guard；manifest schema 错误在启动解析中保持硬错误，并在 `config set relay` 的逐项 probe 中归一成 `saved but unreachable` WARNING。generation 校验、锁竞争异步清理和既有 shutdown drain 仍保持有效。

当前**放行**。没有新的 P0/P1 阻塞。门禁证据按用户提供结果接受：cargo workspace 11 组全绿，clippy `-D warnings` 0 错，example JS **112/112**；本轮定向 `node --test packages/example/test/relay-resolve.test.mjs` 实跑 **25/25**。

## P1 复核

### P1-1：FlightGuard 延迟创建与 generation 清理已闭合

证据：`crates/dweb-fabric/src/fabric.rs:426-465,1287-1344`。

- `guard_opt` 初始为 `None`；等待 `connect_inflight` 锁期间被取消不会留下 entry，也不会持有 `Arc<FabricInner>`。
- 命中已有 entry 的 waiter 分支只订阅 watch 并等待，完全不创建 guard，R8 的 `mem::forget` 泄漏已删除。
- owner 在 `inflight.insert(id, ...)` 后、释放临界区前同步构造 `FlightGuard`；从此后的 peers 复查、拨号及返回路径都有 RAII 清理覆盖。
- Drop 以 `(EndpointId, generation)` 精确匹配后删除并广播；`try_lock` 失败会 spawn 等待 mutex 的清理任务，不再静默丢失清理。旧 owner 不能删除新 generation 的航班。
- shutdown drain 会唤醒并清空现有航班；owner 随后 Drop 时 generation 不匹配或 entry 已不存在，不会误删后续航班。

当前仍缺少专门强制 owner abort、try-lock 竞争和旧 owner/新 owner 交错的回归测试；这是测试债，不改变本轮代码控制流的放行判断。

### P1-2：manifest schema 与 probe 事务适配已闭合

证据：`packages/example/src/relay-resolve.mjs:36-89,178-216`；`packages/example/src/cli.mjs:298-310`；`packages/example/test/relay-resolve.test.mjs:313-350`；D2 `openspec/changes/connectivity-ux-hardening/design.md:217-235`。

- `resolveOneRelay` 对合法 JSON 对象缺失或非数组 `services` 抛出 `invalid services manifest`；`services: []` 与无 relay 条目继续返回 disabled，404/200 非 JSON 的唯一 legacy fallback 未回退。
- `probeRelayUrls` 对每个 URL 独立 `try/catch`，schema 异常转为 `unreachable` outcome；循环继续处理其它 URL，输出 `saved but unreachable: <url> (invalid manifest: ...)`，并将 `allOk` 置为 false。
- CLI 在 probe 前已完成配置写入，probe 失败只设置非零退出码，符合离线预填和逐项报告事务契约。
- 新增 `{}`、`services:null`、`services:[]` 及 malformed probe 测试，定向测试 25/25 通过。

边界质量项：catch 文案直接读取 `err.message`；生产 `resolveOneRelay` 的 schema 分支抛出 `Error`，`httpGet` 也会将传输异常归一为 outcome，因此不构成当前 P1。若未来允许注入任意非 Error 抛值，应改用 `err instanceof Error ? err.message : String(err)`。

## R8 P2 清单复核

以下项目仍存在，但均未升格为放行阻塞：

1. `join_with_deadline` 将 `endpoint.connect` 放入 detached task（`fabric.rs:589-603`），超时后未纳入 Fabric shutdown。
2. `known_addrs` 仍无 TTL/容量，且命中 learned 地址会跳过 custom relay 候选（`fabric.rs:477,1534-1545`），优先级未冻结。
3. `relay_ca_tls` 仍直接暴露 `iroh_relay::tls::CaTlsConfig`（`fabric.rs:125,933`），公共安全边界未收口。
4. d.ts 的 `FabricOptions.httpProxy` 仍内联联合类型，同时保留 `HttpProxyUrl`（`packages/client-sdk/index.d.ts:122-130`）。
5. `buildBanner` 的 Local host/port/version 未统一 `asciiEscape`（`packages/opendweb/bin/opendweb.mjs:124-125`）。
6. SDK 直接保存并调用 `Native.Fabric.prototype.off`，对旧二进制无 feature-detect（`packages/client-sdk/index.js:49-63`）。
7. Rust 与 JS 的首个非 loopback IPv4 选择顺序规则仍可能不同。
8. `fix-dts.mjs` 仍依赖 marker 与字符串替换；当前产物可检查，但生成形状变化时较脆。

另有低优先级标准债：`relay-resolve.mjs:80` 的 JSDoc 使用 `@type {any}`，以及 `guard_opt` 初值的 `#[allow(unused_assignments)]`。二者均未形成运行时或契约阻塞。

## 复核证据与限制

本轮 `git status/log` 在仓库锁与磁盘响应竞争期间多次无输出；因此以目标源码、规范行号和定向 Node 测试完成交叉核对，未重复启动重型 cargo 构建。完整 cargo/clippy 门禁采用用户提供的当前工作树实跑证据。

## 放行判定

**放行。** 两项 R8 P1 已闭合；剩余仅 P2 质量债与并发取消专测缺口，无独立阻塞。
