# dweb 两个 change 独立复审报告

日期：2026-08-29  
复审分支：`main`  
复审范围：已提交 `c5f93e2`、`cddf3b9`（public-exposure），以及当前工作树全部未提交改动（hardening-backlog）。  
依据：两个 change 的 proposal/tasks/specs/contracts 与 `openspec/specs/` 主规格。  
门禁：采纳编排者提供的 fmt、clippy、Rust/JS 测试、实机探针和 d.ts 幂等性证据；本轮未运行 `cargo build/test/clippy`。

## 结论

当前不放行，评分 **5.8/10**。功能主路径覆盖较完整，但仍有两个可在真实部署中触发的 P0：公网 URL 校验会接受凭证段；Fabric shutdown 与并发 join 存在登记竞态，关闭返回后可能残留 detached connect task。另有 known_addrs TTL 未实现、TLS 信任组合语义和多个公共契约不一致问题。

## 阻塞问题

### P0-1：公网 URL 校验未拒绝 userinfo

证据：`crates/dweb-server/src/main.rs:105-139`。实现把输入解析为 `http::Uri`，随后只检查 `uri.host()`、`uri.port_u16()`、path 和 query。`http::Uri::host()` 会从 `user:pass@example.com` 中返回 `example.com`，因此 `https://user:pass@example.com` 被接受并原样进入 `ServiceInfo`/`services.json`，违反 public-exposure 明确拒绝 userinfo 的要求，并会把凭证写入公告。端口溢出由 `http::Uri` 自身解析拒绝，不是本条缺陷。

修复建议：在解析前或对 authority 做结构化检查，明确拒绝 `@`（包括 percent-encoded userinfo 若产品也不允许）；为 Rust 二进制和 opendweb CLI 增加 userinfo 回归用例，并验证错误码为 2。保留 `65535/65536` 端口边界测试以锁定底层解析行为。

### P0-2：shutdown 与 detached connect 登记存在关闭后残留竞态

证据：`crates/dweb-fabric/src/fabric.rs:650-677,1608-1658`。`join_with_deadline` 先 `spawn`，再把句柄写入 `detached_connects`；`shutdown()` 先关闭 endpoint，再 drain 当前登记表并等待。没有 `shutting_down` 状态，也没有把“登记”和“开始 shutdown/drain”放在同一状态机内。可复现交错是：join 在 `spawn` 后被挂起，shutdown drain 空表并返回，join 随后才登记句柄。此句柄不再被本次 shutdown 等待，`detached_connect_pending()` 可在 shutdown 返回后非零，进程/运行时也可能继续持有连接任务。

修复建议：增加由同一 mutex/原子状态保护的 `shutdown_started`；登记时若已关闭则立即 abort 并 await，shutdown 侧在标记关闭后循环接管所有句柄，直到登记窗口封闭。当前超时分支 `abort_handle.abort()` 后也未再次 await（`1647-1655`），应在 abort 后 join，避免把“已请求取消”误报为“无残留”。补充并发 join/shutdown 调度回归测试，而不只测试顺序场景 `crates/dweb-fabric/tests/join_classification.rs:472-505`。

## P1 问题

### P1-1：known_addrs 只做 FIFO 容量，没有实现 proposal 要求的 TTL

证据：`openspec/changes/hardening-backlog/proposal.md:25-28` 明确要求“加 TTL / 容量上限”；实现 `crates/dweb-fabric/src/known_addrs.rs:25-80` 只有 per-endpoint/global FIFO，条目没有时间戳，过期地址会永久占用槽位直到容量淘汰。`tasks.md:20-23` 只勾选容量，未解释取消 TTL，形成 proposal/tasks 不一致。

修复建议：在条目中保存 learned 时间，读取/插入时按 TTL 清理，并给时间推进或注入时钟的测试；若产品决定只保容量，先修改 proposal 明确决策再关闭此项。

### P1-2：CustomPem 与 N0Default 组合会静默破坏官方 relay

证据：`crates/dweb-fabric/src/fabric.rs:33-55,1035-1038`。`CustomPem` 映射为 `CaTlsConfig::custom_roots`，明确只信任自定义根；当 `RelayConfig::N0Default` 同时使用该配置时，官方 `relay.iroh.network` 的证书不再使用内置根，Fabric 可能直接离线。规范只定义了自托管 relay 的 CustomPem，没有定义该组合的安全/功能语义，当前也没有组合回归测试。

修复建议：在 `FabricConfig::validate` 对 `N0Default + CustomPem` 明确拒绝并说明原因，或设计“自定义根 + 平台根”的显式模式；分别覆盖 N0 默认根和自签 relay 的测试，避免用户得到静默断联。

### P1-3：Rust 公共 API 发生未声明的破坏性字段替换

证据：当前 `FabricConfig` 使用 `relay_tls_trust`（`crates/dweb-fabric/src/fabric.rs:158-176`），此前公开字段是 `relay_ca_tls: Option<iroh_relay::tls::CaTlsConfig>`；而 proposal 的 Impact（`openspec/changes/hardening-backlog/proposal.md:63-68`）声明“无破坏性变更”。下游 Rust 调用方按旧字段将直接编译失败。

修复建议：如果这是有意的 v1 breaking change，在 proposal/版本策略中明确并更新迁移说明；如果必须保持兼容，应提供明确的迁移层或新版本 API，而不是让“无破坏性”声明与代码冲突。

### P1-4：activeUrl/relay URL 规范化与主规格、现有消费者不一致

证据：`crates/dweb-fabric/src/fabric.rs:988-1007` 把所有 custom/N0 URL 转成 `RelayUrl::to_string()`，例如 `https://relay.iroh.network` 变为带尾斜杠的 `https://relay.iroh.network/`，并同时改变 `RelayStatusSnapshot.urls` 与 `active_url` 的外部值。主规格 `openspec/specs/sdk/node/spec.md:80-83` 仍冻结无尾斜杠的 N0 值，`packages/example/src/config.mjs:13` 和 README 示例也保留无尾斜杠；proposal 还声称无破坏性变更。该变化会破坏字符串比较、快照断言和展示一致性，且不只是新增 activeUrl。

修复建议：保持对外配置字符串兼容，只在聚合匹配处使用规范化键；或先更新主规格、C0 契约、example 常量和迁移说明，再把尾斜杠作为明确的新契约，并增加 custom/N0 的 exact-output 测试。

### P1-5：fix-dts 仍以字符串截断实现，无法满足“降低 NAPI 格式脆弱性”的目标

证据：`packages/client-sdk/scripts/fix-dts.mjs:211-225` 在命中 `TAIL_MARK` 后直接 `s.slice(0, tailStart) + RELAY_OPTIONS_UNION`，会无条件丢弃尾部所有 NAPI 声明；`126-205` 也依赖 marker、精确空格和单次字符串替换。只要 NAPI 在该 marker 后新增合法 export，脚本会静默删除而不触发不变量失败。现有幂等性/8 项 oracle 只能证明当前 fixture，不证明生成形状漂移时不丢声明。

修复建议：使用 TypeScript AST 或至少按声明边界解析并保留未改写 suffix；为“marker 后仍有额外 export”“空白/注释变化”“重复生成块”加入 fixture，断言所有非目标声明字节或语义保留。

## 非阻塞改进建议

- `crates/dweb-server/src/main.rs:194-218` 在启动 relay、绑定 gateway 后才校验公网 URL；非法值不是严格的最早 fail-fast，端口冲突时还会遮蔽 URL 错误。将解析校验移到所有 bind/spawn 之前。
- `crates/dweb-fabric/src/known_addrs.rs:13-19,37-46` 注释宣称读写摊销 O(1)，但 `set` 用 `Vec::contains` 去重（最坏 O(n²)），`push` 也为 O(n)。应修正文档或使用 HashSet/有序索引。
- 新文件 `known_addrs.rs` 与重构后的 `fix-dts.mjs` 顶部未记录全局规范要求的原始需求输入和时间戳；`fabric.rs` 同时承载 known_addrs、shutdown、TLS、activeUrl 等多个正交意图，维护边界偏宽。
- README SDK 示例 `README.md:162-180` 的 `relayStatus()` 注释仍缺 `activeUrl`；`packages/server-binary/bin/dweb-server.mjs:15-18` 的不支持平台文案仍写 v0.1。补一次事实抽查，避免英文/中文/运行时契约漂移。
- release workflow `build-windows` 能构建、上传并在 publish 前替换两个文件，命名链已与 package `files` 对齐；但 `release.yml:96-101` 只检查文件存在，没有 `npm pack --dry-run`、PE/Node addon 可加载或最小启动 smoke，task 1.3 的“等价验证”仍是人工信任。
- `relay-online` 事件 payload 的完整性依赖 SDK 事件泵在快照写入后读取；建议补充 `online === true` 必有非空 `activeUrl`、多 relay 配置序 tie-break 和初始快照竞态测试。现有 `relayStatusLine` 的 null/空串防御分支是合理的。

## 九项任务实现质量

| 任务 | 评价 |
| --- | --- |
| 1. Windows CI 交叉编译 | **部分完成**：mingw、libnode 导入库、artifact 上传和 publish 前替换链齐全，exe 文件名修复正确；缺少产物等价性/可加载验证，workflow_dispatch 也会额外构建。 |
| 2. README 英文化 | **基本完成**：README.md 英文、README-zh.md 和互链、快速开始流程齐全；activeUrl 与 v0.1 文案仍有事实残留。 |
| 3. known_addrs 边界 | **部分完成**：order/map 键集由单 mutex 保护，per-endpoint/global FIFO 和 learned+custom 合并已实现；TTL 缺失，且复杂度注释不实。 |
| 4. detached connect 生命周期 | **部分完成**：句柄已登记并纳入 shutdown 等待；并发登记窗口和 abort 后未 join 仍可残留。 |
| 5. RelayTlsTrust | **基本完成但有条件风险**：公共 API 不再暴露上游类型，PEM fail-fast 且 Debug 脱敏；CustomPem+N0 语义未封口。 |
| 6. d.ts 契约 | **基本完成**：HttpProxyOptions alias、HttpProxyUrl 删除、strict fixture 和 oracle 均有；生成器仍可能在 NAPI 漂移时丢声明。 |
| 7. off() 收口 | **完成**：保留防御性 feature-detect，已移除“旧二进制兼容承诺”，on/off 运行时路径一致。 |
| 8. activeUrl 全链路 | **基本完成但契约有风险**：fabric→napi→index.js→事件→example 链路齐全，tie-break 有测试；尾斜杠改变旧 urls 契约，初始 `online/activeUrl` 组合也缺硬断言。 |
| 9. 杂项 | **基本完成**：banner 动态值 ASCII 转义、IPv4 数值序、server-binary tarball 漏 exe 已处理；fix-dts 结构化目标未真正达到。 |

## 评分依据

- 加分：public-exposure 的 flag/env 优先级、按条目覆盖、Docker compose 隧道参考物和 server-binary 文件名链路均能在代码与 fixtures 中对应；hardening 的主要 SDK、事件、TLS 受限类型和测试覆盖已落地；用户提供的全部门禁证据为绿。
- 扣分：P0-1 是可直接产出错误/带凭证公告的输入校验漏洞；P0-2 破坏 shutdown 的任务收敛保证。P1 还存在明确 proposal 未完成（TTL）、安全组合未定义、公共 API 破坏性声明冲突和 d.ts 数据丢失路径。

综合评分：**5.8/10**。存在 P0，**不放行**。
