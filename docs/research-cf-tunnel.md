# CF（Cloudflare）网络穿透整合调研

- **调研日期**：2026-08-29
- **原始需求**：链路已打通，下一阶段提升易用性；希望通过 Cloudflare 实现网络穿透，满足个人使用（家用主机无公网 IP，设备在任意网络可接入自托管 dweb server）。
- **结论先行**：CF 的正确落点是 **Cloudflare Tunnel（cloudflared）给现有 self-hosted server 加公网入口**，不是重写任何服务端组件。分三层整合：L0 部署物（compose sidecar，零代码）、L1 services.json 反代正确公告（小量代码，需 OpenSpec change）、L2 CLI 一键隧道（可选二期）。**推荐先做 L0+L1**。

---

## 1. 事实核验（代码 + 信源）

### 1.1 dweb server 是纯 HTTP/WS 形态 → 天然适配 CF Tunnel

| # | 事实 | 出处 |
| --- | --- | --- |
| F1 | relay 用官方 `iroh-relay` 1.1.0；`relay.tls = None`（生产由反代终结），QUIC 数据面因无 TLS 配置**恒为关闭**——服务端只有 HTTP/WS 面 | `crates/dweb-server/src/relay.rs:26-38` |
| F2 | iroh 客户端连 relay = 对 `{relay_url}/relay` 发 WebSocket 升级；https URL → wss + 平台根证书验证（CF Universal SSL 证书是公共可信的，直接通过） | iroh-relay 1.1.0 `client.rs:268`（`dial_url.set_path(RELAY_PATH)`）、`client/conn.rs` |
| F3 | **relay 服务端每 ~15s（+抖动）向客户端发 Ping 帧，客户端回 Pong**——应用层双向流量，打穿 CF 免费/Pro 版 100s WebSocket 空闲超时 | iroh-relay 1.1.0 `protos/relay.rs:36`（`PING_INTERVAL=15s`）、`server/client.rs:371-407`；[CF 100s 超时](https://community.cloudflare.com/t/cloudflare-websocket-timeout/5865)、[websocket.org 指南](https://websocket.org/guides/infrastructure/cloudflare/) |
| F4 | dweb 客户端 bootstrap：`relay` 配置项 → 拉 `{url}/services.json` → 取 relay 条目 URL；**404/非 JSON 回退 legacy 模式 = 把配置 URL 直接当 relay 用**（iroh-relay 对未知路径返回 404） | `packages/example/src/relay-resolve.mjs:51-64`；iroh-relay `http.rs:13`（仅 `/relay`、`/ping`） |
| F5 | gateway 的 `/rendezvous` 登记/解析**当前没有任何客户端调用**——gateway 今天的实际职责 = services.json（relay 发现）+ healthz。legacy 模式（直接配 relay URL）目前**零功能损失** | 全仓 grep：example/client-sdk/fabric 无 `/rendezvous` 调用 |
| F6 | services.json URL 拼接恒为 `{scheme}://{Host主机名}:{本地监听端口}`，且 relay 主机名完全派生自 gateway 的 Host 头——**反代/隧道场景下必然产出错误 URL**（公网 443 无端口后缀；relay 独立域名无法得知） | `crates/dweb-server/src/services.rs:220-256` |
| F7 | `DWEB_TRUST_PROXY=1` 已支持采信 `X-Forwarded-Proto`（为反代 TLS 终结预留），但只影响 scheme，不影响 F6 的端口/主机名问题 | `services.rs:186-198`、Dockerfile 注释 |

### 1.2 Cloudflare 侧现状（2026-08 核验）

| # | 事实 | 信源 |
| --- | --- | --- |
| C1 | **Named Tunnel 免费**，需 CF 账号 + 域名托管在 CF（免费版即可）；`TUNNEL_TOKEN` 远程管理模式下公网主机名在 Zero Trust 面板配置，本地零配置文件；docker sidecar 是官方支持形态 | [Cloudflare Tunnel 文档](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)、[sidecar 实践](https://blog.samrhea.com/posts/2019/sidecar-cloudflared/)、[OneUptime 指南](https://oneuptime.com/blog/post/2026-03-20-portainer-cloudflared-stack/view) |
| C2 | WebSocket 全套餐支持；免费/Pro 空闲超时 100s 硬限制（Enterprise 才可调）——被 F3 的 15s ping 化解 | [CF 社区](https://community.cloudflare.com/t/cloudflare-websocket-timeout/5865) |
| C3 | ToS Section 2.8（非 HTML 内容限制）已于 2023-05 移除并收窄为 CDN 专属条款；**Tunnel 流量不受 CDN 条款管辖**，个人 chat/sync 低流量完全合规 | [Cloudflare 官方博客](https://blog.cloudflare.com/updated-tos/)、[社区讨论](https://www.reddit.com/r/selfhosted/comments/13j4pft/goodbye_section_28_and_hello_to_cloudflares_new/) |
| C4 | 免费版单请求上传 100MB 上限——对 dweb 无影响（rendezvous/manifest 为短 JSON；relay 走 WS 消息，iroh 帧上限 1MB） | [Tunnel 实践文章](https://medium.com/@paperkite_hq/cloudflare-tunnels-zero-trust-access-to-your-self-hosted-services-7ce3dc67a5a5)、iroh-relay `MAX_FRAME_SIZE=1MB` |
| C5 | Quick Tunnel（`trycloudflare.com`）：免账号免域名，但 URL 每次重启变化、无 SLA、200 并发在途请求上限、WS 表现不稳定——只适合演示/试用，不适合 dweb 常态入口 | [Quick Tunnels 文档](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) |
| C6 | cloudflared 到边缘维持 4 条出站连接（QUIC 7844，被干扰时回退 TCP 443/http2）——家用主机只需**出站**网络，无需任何入站端口 | Cloudflare Tunnel 文档（同 C1） |

### 1.3 中国大陆网络（风险评估，未实测）

免费版 CF 在境内无 PoP（中国网络属企业版能力），自域名 named tunnel 通常可达但延迟可能 200-300ms 级；`trycloudflare.com` 域名在境内稳定性差。缓解因素：**iroh 直连打洞不经过 CF**（同 LAN / 多数 NAT 下成功直连时 CF 零负载），relay 回退仅在打洞失败时使用；个人 chat/sync 流量对此延迟不敏感。**上线前需实测打卡（见 §5）**。

---

## 2. 推荐架构

```text
任意网络的设备                       Cloudflare 边缘                家用主机（无公网 IP / 无开端口）
┌──────────────────┐   WSS/HTTPS  ┌────────────────────┐  出站隧道×4  ┌──────────────────────────┐
│ opendweb 客户端   │ ──────────▶ │ gw.dweb.example.com   │ ──────────▶ │ cloudflared              │
│ chat / join /    │  (443, TLS)  │ relay.dweb.example.  │ (QUIC→H2回退)│   ├→ 127.0.0.1:8787 gateway│
│ SDK Fabric       │              │    （同一条隧道）      │             │   └→ 127.0.0.1:3340 relay │
└──────────────────┘              └────────────────────┘             └──────────────────────────┘

通道职责分流：
  rendezvous / services.json    HTTPS   短请求      ← 经 CF
  relay 数据面（回退路径）        WSS     15s ping   ← 经 CF
  直连数据面（常态优先）          QUIC    iroh 打洞   ← 不经 CF，peer↔peer
```

单域名变体（个人用更省事，一个主机名一条证书）：`dweb.example.com` 按路径分流——
`/relay*` 与 `/ping*` → `127.0.0.1:3340`，其余 → `127.0.0.1:8787`（iroh 客户端自己拼 `/relay` 路径，gateway 路径 `/rendezvous`、`/services.json`、`/healthz` 与之无冲突）。

客户端唯一配置入口不变：`config set relay https://gw.dweb.example.com`（gateway → services.json → relay URL）。

---

## 3. 分层整合方案

### L0 — 部署物（零代码，可立即做）

`docker/compose.yaml`：`ghcr.io/gaubee/dweb` + `cloudflare/cloudflared` sidecar（`TUNNEL_TOKEN` 注入，public hostname 在面板配）。裸机替代：launchd/systemd 分别拉起 `opendweb server` 与 `cloudflared tunnel run`。

得益于 F4+F5，**今天就能跑通**：客户端 `config set relay https://relay.dweb.example.com` → 404 → legacy 模式直连 relay。（gateway 的 services.json 公告 URL 是错的，见 F6，所以 gateway-first 流程暂不可用。）

### L1 — services.json 反代正确公告（小量代码，**必须走 OpenSpec change**，wire fixtures 演进）

新增环境变量（+ 对应 flag，沿用 flag > env > default 纪律）：

```text
DWEB_PUBLIC_GATEWAY_URL   完整 URL，如 https://gw.dweb.example.com
DWEB_PUBLIC_RELAY_URL     完整 URL，如 https://relay.dweb.example.com
```

- 设置后**完全覆盖** Host 头派生路径（gateway 与 relay 各自独立），未设置时行为不变（向后兼容本地直用）；
- URL 校验复用现有 scheme 白名单（http/https）与 host 拒绝集合；
- 单域名路径分流拓扑下两者填同一个 URL 即可；
- 同步更新 `services.fixtures.json`（新增 public-override 用例）+ `opendweb server` 横幅追加公网地址行；
- 涉及文件：`crates/dweb-server/src/services.rs`、`main.rs`、`packages/opendweb/bin/opendweb.mjs`。

这是对**任意反代**（CF/Caddy/nginx）通用的修复，不是 CF 专属补丁——与既有 `DWEB_TRUST_PROXY` 的设计动机一致。

### L2 — CLI 一键隧道（可选，二期再决策）

- `opendweb server --tunnel quick`：探测 PATH 里的 `cloudflared`，起 quick tunnel 并在横幅打印 trycloudflare URL（适合演示；C5 限制需在输出中警示）；
- `TUNNEL_TOKEN` 存在时横幅显示 named tunnel 状态；
- 争议点：cloudflared 二进制分发（optionalDependency 或文档指引安装）、子进程生命周期管理——建议等 L0/L1 落地、真实使用后再决定是否值得。

---

## 4. 替代方案（为何不选）

| 方案 | 判定 | 理由 |
| --- | --- | --- |
| CF Worker 重写 gateway/relay | ❌ v1 不做 | 已锁定前提（技术调研 2026-08-26）：Worker 仅 WSS + 出站 TCP。iroh relay 协议服务端需在 Worker/DO 重写并追协议版本，工程与维护成本不成比例；relay 本体无法上 Worker |
| CF WARP / Zero Trust 私网路由 | ❌ | 每台设备装 WARP 客户端才能访问私网 IP；与「应用级组网、受控邀请」理念冲突（受邀者不会为了加入装 WARP） |
| frp / 自建 VPS 中转 | ❌（本需求下） | 需要一台有公网 IP 的 VPS；CF Tunnel 免费且家用主机零入站端口。已有 VPS 的话直接跑 docker 镜像更简单，不需要 CF |
| Tailscale Funnel | ❌（本需求下） | 设备需入 tailnet 才有完整体验；Funnel 端口/协议受限。点名 CF 场景下无优势 |

---

## 5. 风险与待实测项

| # | 项 | 状态 |
| --- | --- | --- |
| R1 | 100s WS 空闲超时 | ✅ 已由 iroh 15s ping 化解（F3+C2），代码级核验 |
| R2 | ToS 合规 | ✅ 个人 chat/sync 低流量无风险（C3）；**边界**：未来 blobs 大文件中转不要走 CF relay 路径 |
| R3 | 中国大陆延迟/可达性 | ⚠️ 需实测：named tunnel 自域名 RTT、WS 稳定性、掉线重连表现；直连打洞成功率应不受影响（地址经 relay 信令自报，非 CF 观测） |
| R4 | E2E 验收 | ⏳ 计划：起 server + cloudflared quick tunnel（验证期用）→ 双进程 `join`+`chat` 全走公网域名 → 确认 relay 经 CF 中转消息、直连打洞后脱离 CF |
| R5 | gateway/relay 公告 URL 修复 | ⏳ L1（OpenSpec change） |

---

## 6. 通用性与「垄断」讨论（2026-08-29，与 Owner 的架构对齐）

### 6.1 供应商分类学：三层方案覆盖「纯流量」类，不覆盖 worker 类

```text
                    供应商提供什么计算？
                    ┌ 无计算（纯流量入口）────────────┬ 受限计算（worker runtime）─────────┐
                    │ CF Tunnel / ngrok / frp /       │ CF Workers+DO / Deno Deploy /      │
                    │ tailscale funnel / SSH -R /     │ Fastly Compute / Vercel Edge       │
                    │ VPS+Caddy（云 docker 场景标配） │                                     │
                    ├─────────────────────────────────┼─────────────────────────────────────┤
  L0/L1/L2 覆盖？   │ ✅ 全覆盖；L1 是通用性支点       │ ❌ 不覆盖——这不是「穿透」，          │
                    │ （origin 保持原生 HTTP+URL覆盖），│ 是服务端移植（潜在的 L3 层）         │
                    │ 换供应商 = 换 L0/L2 胶水         │                                     │
```

- L1（`DWEB_PUBLIC_*_URL`）保持厂商中立：它是「任意反代」的通用修复，云 docker + Caddy/TLS 场景同样必需（F6 与 CF 无关）。
- worker 类平台的组件可行性：gateway（rendezvous/services.json）可移植但每家需独立 adapter（无可移植标准，WinterCG 未覆盖有状态 WS 路由）；relay 需长连 WS + 跨请求状态 + 服务端推送——Fastly Compute 仅 passthrough 且 WS 试用需联系销售（2024-12 起政策），Vercel/Netlify 不支持 WS server，仅 CF DO 产品化、Deno Deploy 可用 KV `.watch()` 硬做；且任何一家都意味着重写 iroh relay 协议服务端并永久追版本。

### 6.2 垄断判定：机制不垄断，「免费打包」独此一家

- 机制层零垄断：反向隧道是老技术（`ssh -R` 原型），开源实现齐全（frp/rathole/bore），ngrok 商业成熟；dweb 服务端纯 HTTP/WS，无任何 CF 协议依赖。
- 零价格整套（anycast 边缘 + 免费 TLS + 稳定自定义域名 + 隧道 + WS + 不计流量）目前独此一家——商业策略导流 Zero Trust，非技术护城河。真正的独有原语是 Durable Objects（有状态边缘 WS 协调）。
- 个人使用不需要全球边缘：一台 VPS + frp + Caddy 功能等价且大陆延迟更优——CF 边缘壁垒对我们是无关变量，故 L0 锁定风险低。

### 6.3 锁定深度分层（Owner 认可专项适配，分界画在 L2/L3 之间）

```text
L0  Tunnel 流量入口           浅（无状态胶水）      换一个 compose 文件        ✅ 做，CF 专项
L2  CLI 深度集成 cloudflared   中（UX 代码）         重写 spawn/探测/横幅       ✅ 做，CF 专项
L3  gateway 移植 Workers       深（runtime adapter） 每家重写 adapter           ⏸ 可选赌注（零主机故事）
L4  relay 协议重写上 DO        极深（绑死 DO 语义    放弃 iroh 上游、协议分叉   ❌ 不做
                                +脱离官方实现）
```

结论：CF 不垄断技术，只垄断「免费打包」；可移植性锚在 origin 原生 HTTP + L1，专项适配留给最浅的胶水层——它送多少拿多少，它变脸换一个文件就走。

---

## 7. 建议的推进顺序

1. **OpenSpec change**：`cf-tunnel-exposure`（或并入更名的 `reverse-proxy-public-urls`）——L1 的 public URL 覆盖 + fixtures 演进；
2. **L0 部署物**：`docker/compose.yaml`（dweb + cloudflared sidecar）+ README 部署章节（named tunnel 步骤、单/双域名两种拓扑）；
3. **实测打卡**（R3/R4）：用户自有域名建 named tunnel，双端公网接入验收；
4. L2 视真实使用反馈再决策。
