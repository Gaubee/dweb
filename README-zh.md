# dweb

[English](README.md)

应用级组网平台（dweb-cloud）：让多设备应用组成逻辑网络（类似游戏房间，不是系统级 VPN），支持受控邀请他人加入；P2P 直连优先，回退到可自托管的 Relay。

```text
身份层   Ed25519 EndpointId（稳定身份，与网络地址解耦；展示串 z-base-32）
名册层   Roster = 签名事实（Genesis/Grant/Join/Revoke）内容寻址(BLAKE3) + union-merge 收敛
         受控邀请 = issuer-online 单次兑换（challenge-response PoP + invite_id CAS 消费）
会话层   iroh 1.1：QUIC 直连 + NAT 穿透 + 自托管 relay 回退；双 ALPN(常规/redeem)；
         两侧门控（先门控后数据）；帧资源上限
同步层   不透明 envelope 双向收发（Automerge 适配器为后续独立 change）
```

## 仓库布局

- `crates/dweb-fabric` — 组网 kernel（Rust lib：identity/protocol/roster/session/fabric 门面）
- `crates/dweb-server` — 自托管服务端：iroh-relay + rendezvous（Rust bin）
- `packages/client-sdk` — `@jixo/opendweb-client-sdk`（napi-rs，darwin-arm64 / win32-x64）
- `packages/example` — `@jixo/opendweb-example` 双进程组网 CLI 样板
- `packages/server-binary` — `@jixo/opendweb-server-binary` 服务端 npm 包装（darwin-arm64 / win32-x64）
- `packages/opendweb` — `opendweb` CLI（server + marketplace/plugin/config 命令）
- `packages/opendweb-config` — `@jixo/opendweb-config` 本地插件 helper（definePlugin）
- `packages/opendweb-ext-cf` — `@jixo/opendweb-ext-cf` Cloudflare Tunnel 插件
- `docker/` — 镜像 `ghcr.io/gaubee/dweb`（rendezvous 8787 + relay 3340）

## 快速开始（体验 example）

```bash
# 1. 启动自托管 server（gateway + relay）—— 顶层 CLI
npx opendweb server
#   仓库内开发: pnpm --filter opendweb exec node bin/opendweb.mjs server
#   也可用 docker: docker run -p 8787:8787 -p 3340:3340 ghcr.io/gaubee/dweb
#   横幅会列出本机全部 Network 地址——任一地址即客户端唯一配置入口，
#   gateway 经 /services.json 自动发现 relay。

# 2. 每台客户端机器：一次性配置（持久化于 ~/.opendweb/config.json）
npx @jixo/opendweb-example config set relay http://192.168.2.13:8787
#   仓库内开发: node packages/example/src/cli.mjs config set relay http://192.168.2.13:8787
#   裸 0.1.0 relay URL（http://host:3340）同样可用（legacy 兼容模式）。
#   v0.2 起无需每个终端手动 export DWEB_RELAY——配置一次即全局生效。

# 3. 终端 A：初始化并常驻聊天
npx @jixo/opendweb-example init --data ~/.dweb-a
npx @jixo/opendweb-example invite --data ~/.dweb-a --ttl 30m   # 复制 token
npx @jixo/opendweb-example chat --data ~/.dweb-a

# 4. 终端 B（另一目录/设备）：兑换邀请并聊天
npx @jixo/opendweb-example join --data ~/.dweb-b <token>
npx @jixo/opendweb-example chat --data ~/.dweb-b
```

**Invites must be redeemed while the inviter is online**（issuer-online 单次兑换）：
签发者进程（如 `chat` 会话）必须在兑换期间保持运行；一次性 `invite` 进程签发的
令牌在 relay 模式下可用，但无 relay 令牌会被直接拒签（`--allow-relayless` 逃生阀除外）。

配置优先级 `flag > env > file > default`；`config list` 可查看各配置项的生效值与来源。
文件权限：目录 0700 / 文件 0600（Windows 尽力而为）。

代理说明：`--proxy auto|on|off`（默认 auto，配置键 `proxy`）控制 HTTP 控制面（relay 连接）
是否走系统代理；env 读取顺序 `HTTP_PROXY > http_proxy > HTTPS_PROXY > https_proxy`，
与 iroh 一致。**QUIC 数据面（直连 + NAT 穿透）永不经 HTTP 代理**——auto 模式下局域网
relay 直连探测可达即自动绕过代理，旧版手动 `NO_PROXY` 的需求消失。

join 失败带稳定错误码（`error[join/<code>]`，如 `no-reachable-path` 秒败并指路、
`dial-timeout` 附注 issuer 可能离线）。

## 服务器部署（docker）

```bash
docker run -d -p 8787:8787 -p 3340:3340 ghcr.io/gaubee/dweb
# 客户端配置单一入口（gateway 自动发现 relay）：
#   config set relay http://<relay-host>:8787
```

不带 docker 时，`npx opendweb server` 运行同一二进制。server 选项：

```bash
npx opendweb server --gateway 0.0.0.0:9999  # 自定义端口（--opt=value 同样支持）
npx opendweb server --relay 0.0.0.0:3350    # 自定义 relay 端口
npx opendweb server --no-relay              # 关闭 relay
DWEB_TRUST_PROXY=1 npx opendweb server      # 反代 TLS 终结时采信 X-Forwarded-Proto
npx opendweb server --public-gateway https://dweb.example.com \
                    --public-relay   https://dweb.example.com   # 见下文公网公告
```

gateway（8787）承载 `/healthz`、`/services.json`、`/rendezvous/{id}` 与 `/` 纯文本摘要；
relay（3340）独立监听。验证 server：

```bash
curl http://localhost:8787/healthz        # -> 200
curl http://localhost:8787/services.json  # -> 机器可读服务清单
```

### 环境变量（server）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DWEB_GATEWAY_BIND` | `0.0.0.0:8787` | gateway 监听（healthz/rendezvous/services.json） |
| `DWEB_RELAY_HTTP_BIND` | `0.0.0.0:3340` | relay 监听 |
| `DWEB_RELAY_ENABLED` | `true` | `false`/`0`/`off` 关闭 relay |
| `DWEB_TRUST_PROXY` | 未设 | 反代 TLS 终结时设 `1` 才采信 `X-Forwarded-Proto` |
| `DWEB_PUBLIC_GATEWAY_URL` | 未设 | 反代/隧道后的公网 gateway 入口（如 `https://dweb.example.com`）；设置后 services.json/横幅按条目公告该值 |
| `DWEB_PUBLIC_RELAY_URL` | 未设 | 公网 relay 入口；与 gateway 覆盖相互独立（flag `--public-gateway`/`--public-relay` 同义） |

优先级 `flag > env > default`；非法公网 URL 启动即硬错误。

## 无公网 IP 部署：反向代理 / 隧道（厂商中立，以 Cloudflare Tunnel 为参考）

家用主机无公网 IP 时，任意「终结 TLS、回源 HTTP/WS」的 front-end 都可用
（Cloudflare Tunnel、ngrok、frp、Caddy on VPS……）。要点只有两条：

1. **公网入口公告**：设置 `DWEB_PUBLIC_GATEWAY_URL` / `DWEB_PUBLIC_RELAY_URL`
   （URL 形态 `http(s)://host[:port]`，不允许 path——iroh 客户端会丢弃 relay
   URL 的 path），gateway 与 relay 条目按需独立覆盖；
2. **回源保持 HTTP/WS**：服务端明文监听即可，TLS 由 front-end 终结
   （`DWEB_TRUST_PROXY=1` 时派生条目采信 `X-Forwarded-Proto`）。

Cloudflare Tunnel 参考（免费版即可；域名需托管在 CF）：

```bash
# Zero Trust 面板 -> Networks -> Tunnels 建隧道拿 TUNNEL_TOKEN，
# Public Hostname 按单域名路径分流：/relay*、/ping* -> http://dweb:3340，
# 其余 -> http://dweb:8787（iroh 客户端自行拼 /relay 路径，单域名即可工作）
cd docker && TUNNEL_TOKEN=... \
  DWEB_PUBLIC_GATEWAY_URL=https://dweb.example.com \
  DWEB_PUBLIC_RELAY_URL=https://dweb.example.com \
  docker compose up -d
# 不发布任何宿主端口（纯隧道暴露）；客户端（任意网络）：
#   config set relay https://dweb.example.com
```

直连打洞不经过隧道（iroh QUIC peer↔peer）；隧道只承载 rendezvous/services.json
短请求与打洞失败时的 relay 回退流量（WS，iroh 15s ping 保活穿透 CF 100s 空闲超时）。
调研与风险（大陆延迟实测、ToS 边界）见 `docs/research-cf-tunnel.md`。

## 插件

供应商与工作流集成均为插件——CLI 内核在结构上保持厂商中立。任意非 builtin
首 token 都走自适应派发：`opendweb <name> ...` 按 marketplace 候选 globs
（默认 `npm:@jixo/opendweb-ext-*`、`npm:opendweb-*`）解析到已安装包的
`./opendweb-plugin` 导出。插件缺失时**自愈安装**（get ?? add）：取首个候选
（声明序，官方 scoped 优先于无 scope 社区名），经你项目的包管理器安装并打印
锁定的 name@version。设 `DWEB_NO_AUTO_INSTALL=1` 可要求显式 `opendweb
plugin add|get`。

```bash
opendweb plugin add cf          # 安装进当前项目（探测包管理器），锁定 name@version
opendweb cf setup               # 交互引导（终端）：逐项询问 token/hostname/mode，
                                # 预览计划后 apply / dry-run / abort 三选一
opendweb cf setup --hostname dweb.example.com   # 非交互：API 推 ingress、路由 DNS、
                                                # 写 opendweb.config.toml、端到端自检
opendweb cf plan --hostname dweb.example.com    # 零副作用预览（setup 亦有 --dry-run）
opendweb marketplace add "npm:@your-org/opendweb-ext-*"   # 追加候选 globs（仅 npm:）
```

### 静态配置 + 生命周期（`opendweb.config.toml`）

编排层是纯数据（TOML 优先、JSON 兼容——同一 schema），代码只存在于插件文件。
优先级 **flag > env > config > default**；未声明插件时 `opendweb server`
不 spawn 任何解释器。

```toml
configVersion = 1

[server]
publicGatewayUrl = "https://dweb.example.com"
publicRelayUrl = "https://relay.dweb.example.com"

[[plugins]]
name = "cf"                      # npm 插件（marketplace 解析）；选项是数据
[plugins.options]
tokenEnv = "TUNNEL_TOKEN"        # 秘密经 env 间接引用，绝不内联
# tunnel = true                  # 可选：server 生命周期内共生 spawn cloudflared

[[plugins]]
file = "opendweb.plugins/backup.ts"   # 本地插件文件——shebang 决定 runtime
```

生命周期钩子（v1：`server.preStart`——配置覆写需过同规校验，失败阻断；
`server.postReady`——端到端验证，失败降级 WARNING，可扩展横幅；
`server.preStop`——清理），另有 `opendweb setup`：按声明序执行全部插件的
setup 钩子并聚合，任一失败非零退出。

### 编写插件

两张面孔，均为普通 ESM：**CLI 面**（`exports["./opendweb-plugin"]`——经 zod
校验的命令清单：name、apiVersion 1、带 JSON Schema 参数声明的 commands；
CLI 统一解析参数、零执行渲染 `--help`、归一化错误与退出码）与 **config 面**
（包根导出 `{name, hooks}`——选项以数据经 `ctx.options` 传入）。本地插件
文件无需发包：

```js
#!/usr/bin/env -S deno run
// opendweb.plugins/notify.ts
import { definePlugin } from "npm:@jixo/opendweb-config";
export default definePlugin({
  name: "notify",
  hooks: {
    async "server.postReady"(ctx) { /* ctx.options、ctx.server、ctx.publicGatewayUrl */ },
  },
});
```

安全模型：安装即信任——`plugin add` 展示并锁定精确 name@version；契约校验
是兼容门不是沙箱（import 即执行模块顶层代码，与一切 config-as-code 工具
相同）。无 scope 的 `opendweb-*` glob 默认开放，社区可自发插件；安装陌生
插件前请核对包的所有权。

## SDK（Node，darwin-arm64 / win32-x64）

```js
const { Fabric } = require("@jixo/opendweb-client-sdk");

const relay = { mode: "custom", urls: ["http://192.168.2.13:3340"] }; // /services.json 里的 relay URL

// 机器 A：创建 fabric（本节点成为 root）并签发邀请
const a = await Fabric.createRoot({ dataDir: "/path/a", relay });
const token = await a.invite(60 * 60_000, null); // dweb1. 前缀令牌，默认 60 分钟
const off = a.on((e) => console.log(e.type, e.data?.toString("utf8"))); // 事件（off() 取消订阅）
console.log(await a.relayStatus()); // { mode, urls, online, lastError, activeUrl }

// 机器 B：兑换令牌（签发者须在线）并收发消息
const b = await Fabric.joinWithToken({ dataDir: "/path/b", relay }, token);
await b.connect(a.endpointId);
await a.send(b.endpointId, Buffer.from("ping"));
await a.revoke(b.endpointId); // 撤销（root-only）

await a.shutdown();
await b.shutdown();
```

事件类型：`peer-connected` / `peer-disconnected`（`endpointId`）、`roster-updated`、
`message`（`from`、`data: Buffer`）、`path-changed`（`endpointId`、
`status: "direct" | "relay" | "unknown"`）、`relay-online` / `relay-offline`
（完整 `RelayStatus` payload）。初始状态一律先查 `relayStatus()`，事件只承载后续跳变。

`FabricOptions`：`dataDir`（必填）、
`relay?: { mode: "n0" } | { mode: "disabled" } | { mode: "custom", urls: [...] }`、
`httpProxy?: "none" | "from-env" | { url }`（默认 `"none"`；QUIC 数据面永不经代理）、
`advertiseAddrs?: string[]`、`joinTimeoutMs?: number`（默认 30000，值域 1s..10m）。

## 身份存储与恢复（信任模型中立）

内核不规定 secret 的存放位置——这是产品的信任模型决策：

```text
纯本地（默认）            加密托管                      产品代管
identity.key 文件          账号系统存 exportSecret 的     服务方持有明文 key
（FileSecretStore）        密文，口令派生在用户           （产品自担，内核中立）
```

```js
const token = await fabric.exportSecretPassphrase("用户口令"); // dwebkey1... 密文
const handle = await importSecret(token, "用户口令");           // opaque 句柄
const fabric2 = await Fabric.createRoot({ dataDir }, handle);   // 注入恢复同身份
```

- 导出是 **identity export**（只含身份种子，不含 roster——名册经网络同步重建）
- 句柄一次性：构造失败自动归还可重试；明文 seed 不经手 JS 字符串
- 自定义存储（Keychain/托管后端）：Rust 侧实现 `SecretStore` trait（`load`/`create`
  线性化 insert-if-absent），经 `SecretInjection::Store` 注入

## 文档与测试

- [EXAMPLE.md](EXAMPLE.md) — 发布回归手册（英文）
- [EXAMPLE-zh.md](EXAMPLE-zh.md) — 发布回归手册（中文）
- `docs/research-cf-tunnel.md` — Cloudflare Tunnel 实地调研

## 开发

```bash
cargo test --workspace        # Rust（fabric kernel + server）
pnpm --filter @jixo/opendweb-client-sdk test     # node --test（SDK 生命周期）
pnpm --filter @jixo/opendweb-example test        # node --test（双进程 relay E2E）
```

- 仓库位于网络磁盘：Rust 编译走本地 `CARGO_TARGET_DIR`（`.cargo/config.toml` 本机配置，
  CI/容器以 env 覆盖）。
- 原生二进制经内容寻址临时路径加载（规避 SMB 页缓存与 dyld 坏闭包）。
- 研发流程：OpenSpec 驱动（见 `openspec/changes/`）。

## 许可证

MIT OR Apache-2.0。仓库：<https://github.com/Gaubee/dweb>。
