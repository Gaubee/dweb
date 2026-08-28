# connectivity-ux-hardening 实现复审报告

日期：2026-08-28

## 结论

当前实现不能放行。门禁证据显示主路径测试和 lint 全绿，但仍有一个兑换协议级 P0：issuer 对入口/PROOF 的 `accept_bi`、`read_frame`、challenge `write_frame` 短读或 I/O 错误使用 `?` 直接返回，没有执行契约要求的立即关闭。另有 SDK 声明产物与 C0 契约明显漂移，属于 P1 发布阻塞。建议先修复 P0 并补确定性回归，再处理 P1 后复审。

## P0 阻塞

### P0-1：issuer 协议短读没有立即关闭兑换连接

证据：`crates/dweb-fabric/src/session.rs:510-528`。`reject_silent` 会调用 `conn.close(...)`，但仅覆盖显式业务判定；以下错误路径绕过它：

- `conn.accept_bi().await?`；
- 首个 `read_frame(...).await?`；
- challenge `write_frame(...).await?`；
- PROOF `read_frame(...).await?`。

这直接违反 issuerMapping 的 emit=false 语义及 D11 的“协议段短读/协议违规直接关闭”。在 `crates/dweb-fabric/src/fabric.rs:1567-1573`，accept loop 随后仍等待 `conn.closed()`，最多等待整个 `REDEEM_DEADLINE`，因此截断帧可能让 joiner 得到 `DIAL_TIMEOUT` 或延迟的连接错误，而不是要求的立即 `DIAL_FAILED`。现有 `redeem_wire` 行测试主要断言“没有结构化帧”，没有断言连接在有界短时间内已关闭；因此提供的全量门禁不能证明此契约。

修复建议：把 entry/proof 的所有 `accept_bi/read_frame/write_frame` 错误统一映射到带 `conn.close` 的错误出口，或用统一的 handler finally/guard 保证任何非成功返回先关闭连接。增加真实连接测试：分别注入首帧 header EOF、payload EOF、challenge 写失败、PROOF header/payload EOF，断言 issuer close 在短于 redeem deadline 的固定窗口内发生，joiner 最终稳定归 `DIAL_FAILED`。

## P1 阻塞

### P1-1：提交的 SDK `index.d.ts` 仍是旧/冲突声明

证据：`packages/client-sdk/index.d.ts:49-64,82-129`。

- `relayStatus(): Promise<RelayStatusJs>` 引用了文件中不存在的 `RelayStatusJs`；
- `on` 仍声明为原生 error-first `(err, arg) => any` 并返回 `number`，而 `index.js:52-64` 已包装为事件对象回调并返回 `() => void`；
- `FabricOptions.httpProxy` 仍是 `string | HttpProxyUrl`，不是 C0 要求的 `'none' | 'from-env' | { url: string }`；
- 文件尾部只新增了一个 `RelayOptions`，未修正前述生成签名，造成契约与产物冲突。

`packages/client-sdk/scripts/fix-dts.mjs` 虽包含修正逻辑，但当前工作树的生成物没有应用该逻辑，且现有 JS 测试不会进行 TypeScript 声明检查。修复建议：重新生成并运行后处理脚本，确保 `FabricEventJs`、`RelayStatusJs`、`on/off`、`httpProxy`、判别联合 `RelayOptions` 各出现唯一声明；增加 `tsc --noEmit` fixture，防止二进制更新后再次回退。

### P1-2：issuerMapping 不是穷尽 match，未来 RosterError 会静默落入 emit=false

证据：`crates/dweb-fabric/src/session.rs:474-495` 的 `redeem_verify_emit` 对已知五个结构化分支后使用 `_ => None`。当前枚举值与 17 行契约能通过测试，但 wildcard 会吞掉新增 `RosterError`，无法让编译或契约测试提示映射缺口；`Protocol` 与 out-of-scope 变体也无法在实现层逐一对应 variantId。

修复建议：对当前 `RosterError` 的每个变体显式 match，明确 `Protocol`/非 redeem 变体的 `None`，并加一个契约校验表将每个 variantId 绑定到构造函数。未来新增枚举后让编译失败或测试失败，而不是静默关闭。

### P1-3：relay `lastError` 脱敏仍可能泄漏 URL 片段

证据：`crates/dweb-fabric/src/fabric.rs:279-308`。`sanitize_relay_error` 对未识别错误保留最多 48 个原始字符；`relay_url_host` 解析失败时回退到原始 URL 前 64 个字符。异常文本或非法 URL 可能包含 userinfo、路径或查询内容，违反 D4/SDK 契约“仅错误类别 + host，不含凭证段与完整路径”。

修复建议：未知错误统一为固定类别（例如 `connection error`），host 只能从已成功解析且已校验的 URL 获取；解析失败返回固定 `unknown-host`，绝不回退原始串。补充 userinfo、路径、query、控制字符和解析失败的断言。

### P1-4：connect 重拨失败路径与 recent_disconnects 缺少资源边界

证据：`crates/dweb-fabric/src/fabric.rs:1218-1241`、`:1265-1276`。`register_dialed(conn)` 返回普通错误时直接 `return res`，没有像 HELLO timeout 分支一样显式 `conn.close()`；同时 `recent_disconnects` 只插入不清理，长期运行会按不同 EndpointId 无界增长。

这不是当前 10/10 竞态复现的失败条件，但会留下半开/延迟回收连接，并使为绕过 iroh NodeId 去重而引入的状态长期累积。修复建议：所有 `register_dialed` 非成功结果先 close 并有界等待 `closed()`；在预沉降读取时删除已过期项，成功重拨或 disconnect 后按上限/TTL 清理。

## 非阻塞但应修复

### P2-1：`relay_ca_tls` 公共配置面没有契约归属

`crates/dweb-fabric/src/fabric.rs:123-125` 将 `relay_ca_tls: Option<iroh_relay::tls::CaTlsConfig>` 放入公共 `FabricConfig`，但 C0 SDK/CLI/主规格没有相应公共 API。它对自签 relay 测试和 Rust 集成有实际价值，然而现在既像稳定 API 又没有版本/安全边界说明。建议明确标记为 Rust 测试/内部配置，或补充公共契约、生命周期和信任根安全说明；SDK 仍应保持不可误配。

### P2-2：server banner 动态 bind 值未统一走 ASCII 转义

`packages/opendweb/bin/opendweb.mjs:113-151` 直接拼接 `gatewayBind`、`relayBind` 和版本值。常规 IPv4/semver 是 ASCII，但 D10 要求所有用户面动态值都满足 `<128`；参数解析层未对 bind 字符串作 ASCII 限制。建议对 banner 动态字段统一调用 `asciiEscape`，并为异常/控制字符输入增加测试。

### P2-3：detached connect task 的生命周期需显式记录

`crates/dweb-fabric/src/fabric.rs:515-539` 为避免取消 iroh connect 留下同 NodeId 半开连接而把 connect 放到后台任务。该取舍与实测竞态证据一致，但 join deadline 后任务可能继续运行到 iroh 自身结束；应记录其最大生命周期/关闭策略，并在 endpoint shutdown 时确认这些任务不会继续持有资源。当前方案可接受，但文档和测试应把这项资源预算冻结下来。

## 契约与实现抽查

### D1 services.json / server

`crates/dweb-server/src/services.rs` 已实现 Host 拒绝集合、IPv6 括号、实际端口、nullable URL、`no-store`、未知服务静默忽略和重复名告警；服务 fixture 测试覆盖与主需求一致。需要继续关注跨平台 `primary_non_loopback_ipv4()`：Unix 枚举网卡，非 Unix 仍依赖 UDP 路由探测，和“网卡枚举”语义并不完全相同。

### D2/D7 bootstrap 与代理

`packages/example/src/proxy.mjs` 按全部候选做直连探测，代理覆盖时统一采用 `from-env`；`relay-resolve.mjs` 在代理决策后逐项解析，fallback 仅 404/200 非 JSON，n0/disabled 在探测前短路。与 D2 决策表相符，且 `httpGet` 使用 undici ProxyAgent。应保留 E 的逐行决策表测试作为回归基准。

### D6 配置优先级与 CLI

当前 example 已有配置文件、原子写、权限收紧、flag/env/file/default 合成、`--opt=value`、`~` 展开、relay 数组和零参/语法错误处理；这些路径与 C0 矩阵基本一致。实现复审仍应把 config set 的“保存但探测失败”逐项输出与 bootstrap 结果绑定检查。

### D3/D11 invite 与 8 码

invite 只使用显式 `advertise_addrs`，relay 为空且无直连地址时拒签，allow-relayless 为显式逃生阀；join 的令牌预检、目录归属、空路径和网络阶段顺序与矩阵一致。8 码边界及三种本地豁免已在 Rust/JS 映射中出现。P0-1 使兑换协议违规路径仍不能满足“立即关闭 + DIAL_FAILED”，因此这一闭环目前不成立。

### D4 watcher

`home_relay_status().stream()` 直接消费，任一 relay online，首值只进快照，状态跳变才广播，事件 URL 按配置序 tie-break，lastError 按配置序聚合，shutdown 显式 abort+join；实现与 D4 方向一致。应补充在 watcher 任务 abort 后没有后续事件的时序断言。

### RedeemErrorKind wire

`session.rs` 的公共 `read_frame/write_frame` 使用 `u32_be(1 + payload_len) + type + payload`，内层记录为 `kind + len(u8) + payload`，未知 kind 按长度消费，多记录 fail-closed。`redeem_wire` 使用权威 JSON fixture 并覆盖 round-trip、短读、0/255 边界、未知值和多记录。wire 解析本身与契约一致；阻塞点是 issuer handler 的短读关闭出口，而非记录 grammar。

## 测试覆盖与批次边界

- 提供的 cargo workspace、clippy、SDK/example/CLI/server-binary 门禁证据覆盖主要 S/E/F owner 行，真实 relay watcher、facade e2e 和 disconnect 竞态也有实测；没有重复启动重型命令的需要，本报告未重跑 workspace cargo。
- F 的 wire fixture 测试验证读写和 reduction，但没有把 issuer handler 的每个短读分支与“连接已关闭”的时间契约绑定起来；这是 P0 的测试缺口。
- E 的纯函数测试覆盖代理集合决策、空列表、无 env、nullable manifest 和 ASCII 转义；生成 d.ts 没有等价的类型门禁，导致 P1-1 漂移未被发现。
- S/E/F 的文件所有权在 tasks 中基本互斥，C0 明确由 ZCode 冻结契约；但 `index.d.ts` 作为唯一 owner 文件虽被锁定，实际生成物仍落后，说明整合阶段缺少“生成后产物必须重新校验”的跨批 API gate。

## 评分

**7.1 / 10**

依据：核心功能面（services gateway、代理状态机、invite 门、join 分类、wire grammar、watcher 和竞态回归）已达到可运行且有较强测试证据，较文档阶段更接近交付；但 P0 的协议连接关闭语义仍未闭合，且 P1 的公共 SDK 类型声明与运行时包装不一致。门禁全绿主要证明已覆盖路径可用，不能抵消这些未覆盖的错误路径和发布契约漂移。

## 放行判定

不放行。完成 P0-1、P1-1 至 P1-4 的实现与针对性测试后，再进行一次实现复审。
