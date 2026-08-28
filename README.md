# dweb

应用级组网平台（dweb-cloud）：让多设备应用组成逻辑网络（类似游戏房间，不是系统级 VPN），支持受控邀请他人加入；P2P 直连优先，回退到可自托管的 Relay。

```text
身份层   Ed25519 EndpointId（稳定身份，与网络地址解耦；展示串 z-base-32）
名册层   Roster = 签名事实（Genesis/Grant/Join/Revoke）内容寻址(BLAKE3) + union-merge 收敛
         受控邀请 = issuer-online 单次兑换（challenge-response PoP + invite_id CAS 消费）
会话层   iroh 1.1：QUIC 直连 + NAT 穿透 + 自托管 relay 回退；双 ALPN(常规/redeem)；
         两侧门控（先门控后数据）；帧资源上限
同步层   不透明 envelope 双向收发（v0.2 接入 Automerge 适配器）
```

## 仓库布局

- `crates/dweb-fabric` — 组网 kernel（Rust lib：identity/protocol/roster/session/fabric 门面）
- `crates/dweb-server` — 自托管服务端：iroh-relay + rendezvous（Rust bin）
- `packages/client-sdk` — `@jixo/opendweb-client-sdk`（napi-rs，darwin-arm64）
- `packages/example` — `@jixo/opendweb-example` 双进程组网 CLI 样板
- `packages/server-binary` — `@jixo/opendweb-server-binary` 服务端 npm 包装（darwin-arm64）
- `docker/` — 镜像 `ghcr.io/gaubee/dweb`（rendezvous 8787 + relay 3340）

## 快速开始（体验 example）

```bash
# 1. 启动自托管 server（gateway + relay）—— 顶层 CLI
pnpm --filter opendweb exec node bin/opendweb.mjs server
#   或发布后: npx opendweb server
#   也可用 docker: docker run -p 8787:8787 -p 3340:3340 ghcr.io/gaubee/dweb
#   横幅会列出本机全部 Network 地址——任一地址即客户端唯一配置入口，
#   gateway 经 /services.json 自动发现 relay。

# 2. 每台客户端机器：一次性配置（持久化于 ~/.opendweb/config.json）
node packages/example/src/cli.mjs config set relay http://192.168.2.13:8787
#   裸 0.1.0 relay URL（http://host:3340）同样可用（legacy 兼容模式）。

# 3. 终端 A：初始化并常驻聊天
node packages/example/src/cli.mjs init --data ~/.dweb-a
node packages/example/src/cli.mjs invite --data ~/.dweb-a --ttl 30m   # 复制 token
node packages/example/src/cli.mjs chat --data ~/.dweb-a

# 4. 终端 B（另一目录/设备）：兑换邀请并聊天
node packages/example/src/cli.mjs join --data ~/.dweb-b <token>
node packages/example/src/cli.mjs chat --data ~/.dweb-b
```

**Invites must be redeemed while the inviter is online**（issuer-online 单次兑换）：
签发者进程（如 `chat` 会话）必须在兑换期间保持运行；一次性 `invite` 进程签发的
令牌在 relay 模式下可用，但无 relay 令牌会被直接拒签（`--allow-relayless` 逃生阀除外）。

代理说明：`--proxy auto|on|off`（默认 auto，配置键 `proxy`）控制 HTTP 控制面（relay 连接）
是否走系统代理；env 读取顺序 `HTTP_PROXY > http_proxy > HTTPS_PROXY > https_proxy`，
与 iroh 一致。**QUIC 数据面（直连 + NAT 穿透）永不经 HTTP 代理**——auto 模式下局域网
relay 直连探测可达即自动绕过代理，旧版手动 `NO_PROXY` 的需求消失。

join 失败带稳定错误码（`error[join/<code>]`，如 `no-reachable-path` 秒败并指路、
`dial-timeout` 附注 issuer 可能离线）；`config list` 可查看各配置项的生效值与来源
（flag > env > file > default）。

## 服务器部署（docker）

```bash
docker run -d -p 8787:8787 -p 3340:3340 ghcr.io/gaubee/dweb
# 客户端配置单一入口（gateway 自动发现 relay）：
#   config set relay http://<relay-host>:8787
```

### 环境变量（server）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DWEB_GATEWAY_BIND` | `0.0.0.0:8787` | gateway 监听（healthz/rendezvous/services.json） |
| `DWEB_HTTP_BIND` | （别名） | 0.1.0 兼容别名，与上同效 |
| `DWEB_RELAY_HTTP_BIND` | `0.0.0.0:3340` | relay 监听 |
| `DWEB_RELAY_ENABLED` | `true` | `false`/`0`/`off` 关闭 relay |
| `DWEB_TRUST_PROXY` | 未设 | 反代 TLS 终结时设 `1` 才采信 `X-Forwarded-Proto` |

## SDK（Node，darwin-arm64）

```js
const { Fabric } = require("@jixo/opendweb-client-sdk");
const a = await Fabric.createRoot({ dataDir: "/path/a", relay: { mode: "disabled" } });
const token = await a.invite(60 * 60_000, null);          // root 签发（v0.2 默认 60m）
const b = await Fabric.joinWithToken({ dataDir: "/path/b" }, token); // 在线兑换
const off = b.on((e) => console.log(e.type, e.data?.toString())); // 事件（off() 取消订阅）
console.log(await b.relayStatus());                       // { mode, urls, online, lastError }
await b.connect(a.endpointId);
await a.send(b.endpointId, Buffer.from("ping"));
await a.revoke(b.endpointId);                              // 撤销
```

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

## 开发

```bash
cargo test --workspace        # Rust（fabric 50 测试）
pnpm --filter @jixo/opendweb-client-sdk test     # node --test（SDK 生命周期）
pnpm --filter @jixo/opendweb-example test        # node --test（双进程 relay E2E）
```

- 仓库位于网络磁盘：Rust 编译走本地 `CARGO_TARGET_DIR`（`.cargo/config.toml` 本机配置，
  CI/容器以 env 覆盖）。
- 原生二进制经内容寻址临时路径加载（规避 SMB 页缓存与 dyld 坏闭包）。
- 研发流程：OpenSpec 驱动（当前 change：`openspec/changes/connectivity-ux-hardening`）。
