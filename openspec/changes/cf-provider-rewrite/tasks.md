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

- [ ] 3.1 OAuth scope 覆盖度实测：wrangler workers-auth 的 scope 子集无
      cfd_tunnel 管理/写 scope（最接近的 connectivity:admin 是 Connectivity
      Directory 绑定）；Owner 在 dashboard 创建 OAuth client 时核对 scope
      选择器是否有 Tunnel/DNS 写。不覆盖则 login 能力面降级为发现/只读，
      provision 回落 API token（代码已按此容错）。CF_OAUTH.SCOPES 常量待
      实测补全 tunnel/dns 写 scope 字符串
- [ ] 3.2 内置 public client：Owner 创建 OAuth client（redirect URI
      http://127.0.0.1:18971/callback）+ tweb.xin TXT 域名验证（不可逆公开）
      后，把 client id 填入 CF_OAUTH.builtinClientId
- [ ] 3.3 loopback 回调端口固定 18971：OAuth client 注册时 redirect URI
      精确匹配（含端口）；端口被占时 login 报错并提示（已实现），多端口
      预注册方案待真实 client 实测后评估
- [ ] 3.4 CF_CLIENT=sdk 与 rest 的真实 API 对拍（需真实凭据的一次性冒烟）
- [ ] 3.5 cloudflared npm 无 checksum（README 已注记）；可选 CLOUDFLARED_BIN
      自供；后续评估官方 checksum 清单校验
