# Design: public-exposure

## D1 命名与优先级

- 环境变量：`DWEB_PUBLIC_GATEWAY_URL`、`DWEB_PUBLIC_RELAY_URL`；
  flag：`--public-gateway <url>`、`--public-relay <url>`
- 优先级 flag > env > 未设置（与 gateway/relay bind 同纪律）
- 两个覆盖项**按条目独立**：允许只覆盖其一，另一个继续走 Host 派生

## D2 URL 校验（启动 fail-fast，退出码 2）

合法形态 = `scheme://host[:port]`，约束：

- scheme ∈ {http, https}
- host 非空；IPv6 用括号形态；端口 1–65535（可省略）
- **拒绝 path**（仅允许空或 `/`）、query、fragment、userinfo
- 拒绝理由（冻结进注释与规格）：
  - relay：iroh 客户端 `set_path("/relay")` 会丢弃 URL 中的任何 path
    （iroh-relay client.rs `dial_url.set_path(RELAY_PATH)`），path 前缀部署
    必然产出错误地址——直接拒绝而非静默错配
  - gateway：rendezvous URL 由 `gateway_url + "/rendezvous"` 字符串拼接，
    path 前缀会破坏拼接语义；v1 不支持 path-mounted 部署

实现：`http::Uri` 解析 + 上述白名单检查（axum 已带 http crate）。

## D3 派生优先级矩阵

| PUBLIC_GATEWAY | PUBLIC_RELAY | gateway / rendezvous | relay |
| --- | --- | --- | --- |
| 未设置 | 未设置 | 现状：scheme(Host/trust) + host(Host/回退) + gateway_port | 现状：同 host + relay_port |
| 设置 | 未设置 | **覆盖**（Host 与回退逻辑跳过） | 现状派生 |
| 未设置 | 设置 | 现状派生 | **覆盖**（仅当 relay 启用） |
| 设置 | 设置 | **覆盖** | **覆盖** |

- 覆盖条目不产生任何 WARNING（Host 无效/无回退的告警只属于派生路径）；
  覆盖条目不受 `DWEB_TRUST_PROXY`/`X-Forwarded-Proto` 影响（值已含 scheme）
- relay 禁用（`--no-relay` / env）时 relay 条目维持 `enabled:false, url:null`，
  已设置的 PUBLIC_RELAY 被忽略且**不告警**（显式关闭是更强的用户意图）
- rendezvous URL = gateway 覆盖值 + `"/rendezvous"`（覆盖路径下同样字符串拼接）

## D4 fixtures 契约迁移

- 本 change `contracts/services.fixtures.json` = 旧 4 例（逐字节原样）+ 新 4 例：
  `public-urls`（双覆盖）、`public-gateway-only`、`public-relay-only`、
  `public-urls-no-fallback`（Host 拒绝 + 无回退 + 双覆盖 → 全 URL 可用、零 WARNING，
  证明覆盖独立于回退探测）
- 消费者路径更新：`crates/dweb-server/src/services.rs` 的 `include_str!` 与
  `packages/example/test/relay-resolve.test.mjs` 的相对路径
- 归档目录 `archive/2026-08-28-connectivity-ux-hardening/` 保持只读

## D5 CLI/包装层

- `startServer({ publicGatewayUrl?, publicRelayUrl? })`：仅当选项显式定义时写
  子进程 env（undefined = 继承父进程环境，与 trustProxy 的"缺省继承"语义一致，
  但不写 "0" 哨兵——URL 没有布尔语义）
- `opendweb server`：flag 解析、env 回退、D2 同款轻量校验（前置报错，退出码 2）、
  横幅 Public 节（设置时逐行列出，ASCII 纪律）、help 文档

## D6 部署物（CF 参考实现，front-end 契约中立）

- `docker/compose.yaml`：`dweb`（无 published ports）+ `cloudflared` sidecar
  （`TUNNEL_TOKEN`，remotely-managed，hostname 在面板配置）
- 单域名拓扑：`/relay*` 与 `/ping*` → `http://dweb:3340`，其余 → `http://dweb:8787`；
  双主机名拓扑：gw/relay 各一 hostname → 对应端口
- 容器内 `DWEB_PUBLIC_GATEWAY_URL` / `DWEB_PUBLIC_RELAY_URL` 填公网入口，
  `DWEB_TRUST_PROXY=1`（覆盖场景下实际不依赖，但保持派生条目的正确性）
