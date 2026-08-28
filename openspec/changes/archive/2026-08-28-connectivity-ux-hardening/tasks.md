# Tasks: connectivity-ux-hardening

> 子代理约束（Owner 全局指令）：不得 `git commit/push`；不得操作共享资源（herdr、常驻 server、dev 进程）；报告中必须反馈遇到的困难与解决方式（反馈协议）。
>
> **测试边界**：子代理只跑定向测试（`cargo test -p <crate> --lib <filter>`、`node --test <file>`）；全量门禁（`cargo test/clippy --workspace -j2`、跨包 e2e）由 ZCode 在 herdr pane 受控执行，不属子代理完成条件。
>
> **e2e 纪律**：用例自起所需服务（spawn dweb-server 于随机空闲端口、结束 kill 并等待退出）；禁止复用常驻进程与固定端口；断言有界重试。
>
> **唯一 owner 文件**（子代理禁改，需求写进报告）：根 package.json、锁文件、README.md、各包 version、生成的 index.d.ts。

## 0. Batch C0 — 契约冻结（ZCode 亲写，先于子代理）

- [x] 0.1 `openspec/changes/connectivity-ux-hardening/contracts/client-sdk.d.ts.md`：Fabric 全 API 契约（invite 三参、relayStatus、事件判别联合（relay 事件必携快照 payload）、on() 返回取消订阅、kebab 错误前缀约定、joinTimeoutMs/httpProxy/advertiseAddrs）
- [x] 0.2 `contracts/services.fixtures.json`（纯 JSON 四组：canonical/disabled/nullable/unknown+dup，含客户端期望）+ `contracts/error-matrix.md`：8 码+豁免 3 码分类总函数 + RedeemErrorKind 完整帧格式 + bootstrap 探测决策表（代理覆盖语义）+ 每码测试 owner（E mock 与 ZCode 4.1 分列）
- [x] 0.3 主规格包名勘误（`@dweb/*` → `@jixo/opendweb-*`：sdk/node 与 example-app 两份主规格，ZCode 唯一 owner）+ sdk 主规格 `start()/stop()` 生命周期措辞与现实现（工厂构造 + `shutdown()`）的基线差异一并统一

## 1. Batch S — server gateway（子代理 S）

- [x] 1.1 `crates/dweb-server`：gateway 命名落地（`DWEB_GATEWAY_BIND` canonical + `DWEB_HTTP_BIND` 别名）；`GET /services.json`（scheme 跟随请求 + `X-Forwarded-Proto` 仅 `DWEB_TRUST_PROXY=1` 采信；Host 校验拒绝 0.0.0.0/注入形态、失败回退首个非 loopback IPv4；各条目实际监听端口；`Cache-Control: no-store`）与 `GET /` 纯 ASCII 摘要
- [x] 1.2 rust 单测：Host 派生/拒绝集合逐项（unspecified/userinfo/解析失败/端口越界，loopback 放行）/回退、disabled 条目、scheme 信任边界、字段快照稳定性（对 fixtures 四组断言含 expectedServerWarnings 与 nullable 精确串 `no non-loopback IPv4 available; URLs are null`）
- [x] 1.3 `packages/opendweb`：`--gateway`（+`--http` 别名）、全 ASCII 横幅（Local/Network IPv4 枚举、无可枚举时占位行、`NAME | PORT` 服务表）
- [x] 1.4 `packages/server-binary`：startServer 选项增 `gatewayBind`（别名兼容 `httpBind`）；透传新环境变量（DWEB_GATEWAY_BIND、DWEB_TRUST_PROXY）
- [x] 1.5 mjs 测试：横幅全 ASCII（码位 <128）、Network 枚举、`--gateway`/别名等价；e2e（随机端口）断言 /services.json 与 GET /
- [x] 1.6 `docker/` 文档与 env 说明同步（DWEB_GATEWAY_BIND、DWEB_TRUST_PROXY）

## 2. Batch E — example CLI（子代理 E）

- [x] 2.1 `src/args.mjs`：双形式等价解析、布尔 flag、`~` 展开、未知选项报错（退出码 2）、`--ttl` 后缀解析与值域校验（1s–30d）
- [x] 2.2 `src/config.mjs`：`~/.opendweb/config.json` 读写（0700/0600、加载时收紧过宽权限并告警、tmp+rename 原子写）、`config list|get|set|unset`、优先级决策表合成（含 DWEB_RELAY=disabled 整体禁用、DWEB_RELAY_URLS 单独存在=隐式 custom、逗号空项过滤去重保序、config set relay 零参报错）、非法 JSON/未知键硬错误、relay 单值或数组 schema、动态值 \\xNN 转义（UTF-8 字节小写十六进制）
- [x] 2.3 `src/relay-resolve.mjs`：bootstrap 状态机实现（D2：规范化→代理决策→逐项地址解析；可达性=任何完整 HTTP 响应；仅 404/非 JSON 回退裸 relay；超时/5xx 硬错误；数组逐项去重）
- [x] 2.4 `src/proxy.mjs`：`httpGet(url, { policy })`（**显式 undici 依赖**——在 packages/example/package.json 提出版本，lockfile 由 ZCode 落）+ auto 探测决策表（见 contracts/error-matrix.md bootstrap 表：**按候选集合判定无顺序依赖**、空列表不发请求、proxy=on 无有效 env 报错、"仅代理实际尝试失败才输出 both-fail 文案"）；在 Fabric 构造前产出 `httpProxy` 策略
- [x] 2.5 `cli.mjs` 接线：config 驱动 baseOpts（含 httpProxy/joinTimeoutMs 透传、`--join-timeout`）、TTL 默认 60m、`--allow-relayless` 透传 + WARNING（带外路径措辞）、chat 快照 relay 状态 + 离线 WARNING + 恢复提示、join 失败 `error[join/<code>]` stderr 文案（8 码全表；本地豁免以 `error[<variant>]` 透出不包装 join/ 前缀）、全部用户面字符串全 ASCII 英文
- [x] 2.6 **E 自主测试边界**（不依赖 S/F 新产物；mock services.json 响应与 Fabric 构造）：args/config/proxy/relay-resolve 纯函数单测（决策表逐行、双形式成对断言、非法 JSON、数组 relay 变参写入、bootstrap 探测矩阵 mock httpGet、TTL 999ms 拒/1000ms 收、控制字符（含换行）动态值 \\xNN 转义断言一行一错误）；依赖真实 server/SDK 的 e2e（8 码真实路径）归 ZCode 4.1 整合期
- [x] 2.7 报告附 README example 段落建议文案（含"invite 需签发者在线"加粗提示、proxy 所有权说明）——ZCode 落盘

## 3. Batch F — fabric/SDK 安全语义（子代理 F）

- [x] 3.1 `crates/dweb-fabric`：`FabricError::InviteWithoutRelay` + `invite_with(InviteOptions)`；`FabricConfig.advertise_addrs` 构造期校验（非空可解析 ip:port、拒绝通配 0.0.0.0/:: 与端口 0、重复去重保序、loopback 允许，非法以 [bad-advertise-addr] 前缀报错）；签发路径永不混入 direct_addr_hints
- [x] 3.2 `roster.rs`：`RosterError::DirFabricMismatch { path, stored, requested }`（16 hex 短标识、可操作文案），decode_persisted 不匹配分支迁移；既有 `WrongFabric`（redeem_verify）不动
- [x] 3.3 `fabric.rs`：`FabricEvent::RelayOnline/Offline`——消费 `home_relay_status().stream()`，任一连接即 online、跳变触发、快照缓存先于广播、shutdown 取消；`FabricConfig.http_proxy: HttpProxyConfig{None,FromEnv,Url}` 映射 endpoint builder；`FabricConfig.join_timeout_ms`（默认 30s，值域 1s–10min）
- [x] 3.4 join 错误分类总函数（D11 有序判定，kebab 前缀 `[<kebab-code>]`）：NO_REACHABLE_PATH 拨号前秒败、地址规范化入 TOKEN_INVALID、**有界 2s TCP relay 探针**驱动 RELAY_OFFLINE/DIAL_FAILED/DIAL_TIMEOUT 附注（不解析 iroh ConnectError 内部）、redeem 非结构化失败归 DIAL_FAILED、兑换通道内层 5s 超时归 DIAL_TIMEOUT（附注 redeem timeout）、**本地数据面错误豁免透出**（missing-identity/corrupted/roster-io）、`RedeemErrorKind` wire 编码（记录嵌于既有 REDEEM_ERR(0x14) 外层帧 payload 内，kind+len(1B, 0..255)+payload，未知值降级不断连，外层 payload 内额外完整记录按下一记录；REDEEM_OK 沿用既有格式）；**删除旧文本 REDEEM_ERR 发送路径与 consume Ok(false) 静默返回**，按 issuerMapping rows（17 行 variantId）实现：emit=true 行发外层 0x14+单记录后关闭，emit=false 行不发结构化帧直接关闭（joiner DIAL_FAILED）；协议帧编解码文件归 F
- [x] 3.5 rust 测试（覆盖 error-matrix F owner 列全部行，逐项列举）：invite 门三分支 + advertise_addrs 校验（含通配拒绝/loopback 接受分支）；DirFabricMismatch（目录 A + 令牌 B）；watcher 聚合/跳变/快照/配置序 lastError/事件 URL tie-break（多 relay 同周期上线断言配置序最小）/shutdown 无残留/首值不重复广播；join 8 码各至少一测（含零拨号断言、redeem 非结构化中断）；豁免三态（missing-identity/corrupted/roster-io 注入）；RedeemErrorKind 帧测试（以 contracts/redeem-err.fixtures.json **十二例**结构化向量为基准（逐例断言 expectedReaderOutcome/expectedRecords/expectedResult/expectedViolation 四字段 + 消费 issuerMapping 全部行），且**必须用既有 read_frame/write_frame 做字节级 round-trip 与负例验证**：外层头/payload 两层短读、0/255 边界载荷、非 ASCII 载荷（呈现层剥除）、已知 kind 0x00-0x03 全覆盖、未知 kind、payload 内额外完整记录按新记录、Other 零长、多记录 reduction、REDEEM_OK 不受影响）；**探针四类确定性注入**（关闭端口秒拒、不存在域名 DNS 失败、接受即关 listener→DIAL_FAILED、在线 relay+无 issuer+短 deadline→DIAL_TIMEOUT 附注——用 F 内部可替换探针句柄与 fake clock/阻塞句柄构造，不依赖墙钟）；探针适用条件负测（令牌含直连地址或策略非 none 时不判 RELAY_OFFLINE）；集成：好 relay → RelayOnline、disabled → 无事件且 status.online=null
- [x] 3.6 `packages/client-sdk`：按 C0 契约实现 `invite` 三参、`relayStatus()`（含 lastError 脱敏）、事件透传、错误码前缀 `[<code>]`；API 变更报告（供 ZCode 落盘 d.ts）
- [x] 3.7 SDK mjs 测试：第三参透传、relayStatus 三态、事件透传、错误码前缀

## 4. 整合与门禁（ZCode）

- [x] 4.1 跨批对齐：E×F×S 联测（invite 三参、8 码真实路径 e2e、services.json 实测、relayStatus/事件）；README 落盘（S/E 建议 + 包名勘误）；d.ts 校对落盘；lockfile 更新（含 undici）
- [x] 4.2 herdr 受控全量门禁：cargo test/clippy（-j2、--test-threads=2）、三包 js 测试、example e2e
- [x] 4.3 Codex 复审闭环，修复至放行

## 5. 收尾（ZCode）

- [x] 5.1 版本号 0.1.0 → 0.2.0（四包 + Cargo，仅准备，不发版）
- [ ] 5.2 herdr 资源回收、`openspec archive`、git commit + push
