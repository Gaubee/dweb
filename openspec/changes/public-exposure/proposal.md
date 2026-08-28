# Proposal: public-exposure

## Why

自托管 server 部署在反代/隧道之后时（Cloudflare Tunnel、Caddy、nginx 等），
`services.json` 的 URL 派生必然产出错误地址（调研 docs/research-cf-tunnel.md F6）：
公网入口 443 无端口后缀，而清单恒拼本地监听端口；relay 与 gateway 公网主机名
可以互不相同，Host 头派生无法表达。缺少正确公告，gateway 单一配置入口
（`config set relay <gateway-url>` → services.json → relay URL）在公网部署下不可用，
客户端只能退回 legacy 裸 relay 模式。

架构决策（Owner，2026-08-29）：**底层保持厂商中立**（origin 永远是原生
HTTP/WS 进程 + 显式公网 URL 覆盖），**易用性适配叠加在中立之上**（本 change
同时交付 CF Tunnel 参考部署物；front-end 可替换为任意等价物）。

## What Changes

### 1. 公网 URL 覆盖（server，中立层）

- 新增 `DWEB_PUBLIC_GATEWAY_URL` / `DWEB_PUBLIC_RELAY_URL` 环境变量与
  `--public-gateway` / `--public-relay` flag（优先级 flag > env > 未设置）
- 覆盖项按条目独立生效：设置后该条目完全跳过 Host/scheme/回退派生；
  未设置的条目行为与现状逐字节一致
- 启动期 fail-fast 校验（非法值退出码 2，与 bind 同类失败）

### 2. fixtures 契约演进

- 本 change 的 `contracts/services.fixtures.json` 收录旧 4 例（原样冻结）
  + 新 4 例 public-override 用例；双消费者（dweb-server 单测、example
  客户端解析测试）include 路径改指本 change；归档目录不回写

### 3. CLI/包装层透传

- `@jixo/opendweb-server-binary` `startServer()` 新增
  `publicGatewayUrl` / `publicRelayUrl` 选项（仅显式定义时写 env）
- `opendweb server` 新增双 flag + env 回退 + 轻量校验；横幅新增 Public 节

### 4. 隧道部署参考物（L0，中立之上的 CF 适配）

- `docker/compose.yaml`：dweb + cloudflared sidecar（TUNNEL_TOKEN 模式），
  不发布任何宿主端口（纯隧道暴露）；README 部署章节补隧道拓扑
  （单域名路径分流 / 双主机名两种形态）

## Non-goals

- relay 协议重写或任何 worker-runtime 移植（L3/L4，见调研 §6.3）
- `opendweb server --tunnel` 子进程托管（L2，二期视使用反馈）
- QUIC 数据面（维持现状：无 TLS 配置即关闭）
- 归档 change 目录的任何回写
