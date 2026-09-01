# Tasks: cf-provider-rewrite

## 1. 实现清单

- [x] 1.1 auth.ts：OAuth Authorization Code + PKCE(S256) + loopback 回调
      （127.0.0.1:18971/callback）、refresh 轮换与 0600 凭据文件、
      CLOUDFLARE_API_TOKEN 兜底、getApiToken 归一入口
- [x] 1.2 cf-client.ts：CfGateway 窄接口 + createRestGateway（分页/错误归一/
      zone.account 推导）+ createSdkGateway（cloudflare@7.1.0 tree-shakable，
      resources=[Zones,DNS,ZeroTrust]）+ createGateway 工厂（默认 rest，
      CF_CLIENT=sdk 对拍）
- [x] 1.3 route-model.ts：planExposure/buildIngress/renderConfigToml
      （含 accountId/zoneId/tunnelId 锚点）/verifyExposure 自 wizard/cf-api
      迁移，行为保持
- [x] 1.4 provision.ts：desired-state 幂等（tunnel 命名 opendweb-* 复用/新建、
      GET-diff 后 PUT 全量、DNS exact 查询 + managed-by=opendweb 注记 +
      冲突必确认、config 存在则 merge 指引、verify 保持）
- [x] 1.5 connector.ts：spawn 状态机整体迁移（R2-R6 全部保证）+ bin 解析序
      （CLOUDFLARED_BIN > PATH > 缓存 > npm:cloudflared 按需安装）
- [x] 1.6 tui.ts 新流 + cli.ts（login/logout/setup/verify/plan/status）+
      index.ts hooks（setup 走发现式；postReady 保持 TUNNEL_TOKEN 语义）
- [x] 1.7 测试层重写：108 用例（cf 14 / cf-client 9 / auth 20 / provision 16 /
      connector 10 / tui 27 / e2e 13）；下游 opendweb 92/92 不受影响
- [x] 1.8 pack:dry 门禁扩展：零运行时依赖 + @clack/cloudflare/cloudflared
      import 零残留 + dist 体积上限；实测 706KB
- [x] 1.9 README 1.0（认证/权限/迁移说明/供应链注记）

## 2. 验证

- 验证：cf 108/108 · opendweb 92/92 · pack:dry 通过（runtime deps: none；
  无 bundle 残留；dist 706KB）· tsc --noEmit 干净（base 全严格选项）

## 3. 已知边界与后续项（登记）

- [x] 3.1 OAuth scope 覆盖度实测（2026-08-31 完成，全链路真实凭据）：
      Owner 创建私有 OAuth client（Authorization Code + Refresh Token
      grant、PKCE None、redirect URI http://127.0.0.1:18971/callback）。
      三项关键实测结论：(a) authorize 端点未登录即校验参数且错误经 303
      回调 query 返回——构成离线「白名单判定器」（302→login=scope 在
      client 白名单）；(b) 词汇表为**点分隔资源式**（官方 Create OAuth
      Client API 文档明言 "Colon-delimited scopes are not accepted"），
      wrangler 风格冒号串全拒；Tunnel 权限 scope id 为 **argotunnel**
      （连写，picker 显示名 "Argo Tunnel (Legacy)" 即 Cloudflare Tunnel
      本尊）；定稿 SCOPES = offline_access zone.read dns.read dns.write
      argotunnel.read argotunnel.write（六项整包过白名单探测）；(c) 写
      接口严格按登录请求的 scope 把关（缺 argotunnel.write 时 POST
      cfd_tunnel 403/10000；带上后 create/PUT configurations/GET token/
      DELETE 全 200），GET 类宽松（zones/DNS/tunnel list 均可读）。
      附带发现：GET /oauth/scopes 接受 OAuth access token（文档称需
      API token），全量 383 条可枚举。SCOPES 已定稿回填 auth.ts 并过
      两次真实登录验证（refresh token 落盘、rotation 正常）
- [ ] 3.2 内置 public client：Owner 创建 OAuth client（redirect URI
      http://127.0.0.1:18971/callback）+ tweb.xin TXT 域名验证（不可逆公开）
      后，把 client id 填入 CF_OAUTH.builtinClientId（私有 client id
      474ee62ae21f9cec9853f697e6754b33 已可用于 Owner 自测，发布内置
      须待 public 化）
- [ ] 3.3 loopback 回调端口固定 18971：OAuth client 注册时 redirect URI
      精确匹配（含端口）；端口被占时 login 报错并提示（已实现），多端口
      预注册方案待真实 client 实测后评估
- [ ] 3.4 CF_CLIENT=sdk 与 rest 的真实 API 对拍（需真实凭据的一次性冒烟）
- [ ] 3.5 cloudflared npm 无 checksum（README 已注记）；可选 CLOUDFLARED_BIN
      自供；后续评估官方 checksum 清单校验

## 4. 复审闭环（2026-08-31）

- [x] 4.1 Codex R1（gpt-5.6-terra xhigh，46min）：**3.5/10 Not release-ready**
      ——七项阻塞：SDK 聚合导入构造失败且引入 447KB chunk、PUT 全量替换丢
      originRequest 等非 ingress 字段、ownership 三缺口（new 撞名/锚点未消
      费/zone 非最长后缀）、OAuth access token 落盘 + 超时后 listener 泄漏、
      write-scope 降级缺失、install 路径不匹配 + stop 竞态、dry-run 落盘凭据
- [x] 4.2 R1 整改（b1cb51b，发布 1.0.1）：全部阻塞修复；cf 126/126（+18
      用例）、下游 92/92、pack:dry 递归扫描（静态+动态 import）368KB、
      tsc 干净
- [ ] 4.3 Codex R2 复验：**服务端故障中断**（模型 API 403 GROUP_DELETED，
      重连 100 次未果）——待服务恢复后重跑 R2（复核 R1 七项 CLOSED 状态与
      回归检查）；workspace 已回收
