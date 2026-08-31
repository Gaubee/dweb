# Proposal: cf-provider-rewrite

## Why

`@jixo/opendweb-ext-cf` 0.2.x 经真实用户走查暴露出凭据模型的根本缺陷：

1. **双 token 交互**（TUNNEL_TOKEN 连接器 token + CF_API_TOKEN 管理 token）——
   用户需要先在 Cloudflare 网页手动创建两样东西，教程冗长且两次 401/卡壳实测事故
   都源于此（connector token 无 REST 权限；管理 token 又缺 account 上下文）。
2. **手写 REST 客户端**：zones 查询用 `account.id` 过滤参数（多账户/权限受限时
   失效——Owner 实测指出的 CLOUDFLARE_ACCOUNT_ID 配合问题）、无分页、无类型。
3. **cloudflared 需要用户预装**，与「零安装体验」的产品目标不符。

Owner 决策（2026-08-31）：完全重写为 **SDK 驱动的发现式暴露**，参考 GPT 技术顾问
文档的方向（npm:cloudflare 控制面 + npm:cloudflared 数据面），其中错误信息
（如假设的 API 方法名）已逐一以官方文档/源码校正。

## What Changes

### 1. 双方案认证（auth.ts）

- **方案 A（首选）`cf login` 浏览器登录**：OAuth Authorization Code + PKCE(S256)
  + `http://127.0.0.1:<port>/callback` loopback 回调（官方 2026-06 起
  self-managed OAuth clients 支持；第三方仅 Auth Code，公共客户端 PKCE 必需）。
  refresh token（offline_access）存 `~/.opendweb/cf-auth.json`（0600），
  access token 内存使用、过期静默 refresh。client id：内置 Owner public client
  （待 Owner 创建并验证 tweb.xin TXT，不可逆）或 `CF_OAUTH_CLIENT_ID` 覆盖
  （用户自建 private client）。
  - **显式风险关卡**：wrangler workers-auth 的 scope 子集无 cfd_tunnel 管理/写
    scope（最接近的 connectivity:admin 是 Connectivity Directory 绑定）；
    平台全量 scope（~2000）是否有覆盖需 Owner 在 dashboard 建 client 时实测。
    不覆盖则 login 降级为发现/只读，tunnel 写操作回落 API token。
- **方案 B（兜底）API token**：`CLOUDFLARE_API_TOKEN`（+可选
  `CLOUDFLARE_ACCOUNT_ID` 加速）。**account id 缺陷修复**：`GET /zones` 的
  zone 对象自带 `account:{id,name}`（Zone Read 权限即可），选 zone 即推导；
  废弃 `zones?account.id=` 过滤查询。最小权限：Account: Cloudflare Tunnel Edit
  + Zone: DNS Edit + Zone: Zone Read。

### 2. SDK 控制面（cf-client.ts）

cloudflare SDK 7.x **tree-shakable** `createClient`（全量包 62MB 不可用），
仅挂 zones/dns/zeroTrust.tunnels 资源：listZones（含 account 推导）、
listTunnels/createTunnel/getTunnelToken、getConfiguration/putConfiguration、
findDnsRecord(exact)/upsertDnsRecord。clientFactory 注入供测试。

### 3. 幂等编排（provision.ts）

desired-state：ensureTunnel（命名 `opendweb-<hostname 标签>`；config TOML
options 存 accountId/zoneId/tunnelId 供复跑复用；否则列 existing 供选择/新建）
→ ensureConfiguration（GET-diff；相等 no-op；PUT 全量替换，恒以
http_status:404 catch-all 收尾）→ ensureDns（exact name 查询；
无记录→CNAME 带 comment "managed-by=opendweb"；指向本 tunnel→no-op；
指向他处→展示冲突并需用户确认，绝不静默覆盖）→ 写 config（存在则 merge
fragment，行为保留）→ verifyExposure（services.json 端到端，原样保留）。

### 4. Connector 数据面（connector.ts）

spawn 生命周期状态机（grace 窗口/per-child watchdog/stop 事务/竞态保证，
7 个生命周期测试随迁）原样迁移；spawn 目标参数化：PATH 上的 cloudflared 优先
（兼容），否则 npm:cloudflared `install()` 到 `~/.opendweb/cloudflared/<ver>/`
（CLOUDFLARED_BIN 覆盖；安装失败降级手动指引）。

### 5. 交互与命令面

- TUI 新流：登录方式 select（已登录默认直用）→ zone select → hostname（对
  所选 zone 精确算证书深度建议）→ tunnel select（create new + existing 列表）
  → mode → plan note → apply/dry/abort。token 输入的「单口累积捕获 +
  头尾摘要 + confirm」交互保留用于 API token 通道。
- CLI：新增 `login`/`logout`；setup/verify/plan/status 不变；status 增加
  tunnel/DNS 状态行。
- hooks 契约零改动；postReady 的 tunnel=true 保持 TUNNEL_TOKEN 运行期凭据
  （setup 末尾引导获取）；setup 钩子走新流。

### 6. Breaking 与版本

1.0.0（major）：移除旧双 token 向导交互与 CF_API_TOKEN 语义（README 迁移说明）。
依赖全部 devDeps bundle（cloudflare/cloudflared/@clack）；pack:dry 门禁扩展：
三包 import 零残留 + 产物体积上限。供应链风险登记：npm:cloudflared 无 checksum
（来源官方 GitHub releases；CLOUDFLARED_BIN 自供逃生阀）。

## Impact

- packages/opendweb-ext-cf：src 全量重构（prompts.ts 原样保留），tests 随层重写
- packages/opendweb：零改动（契约不变；下游 92 测试不受影响）
- docs/README：认证、权限、迁移说明更新
