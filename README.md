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
- `packages/client-sdk` — `@dweb/client-sdk`（napi-rs，darwin-arm64）
- `packages/example` — `@dweb/example` 双进程组网 CLI 样板
- `packages/server-binary` — `@dweb/server-binary` 服务端 npm 包装（darwin-arm64）
- `docker/` — 镜像 `ghcr.io/gaubee/dweb`（rendezvous 8787 + relay 3340）

## 快速开始

```bash
# 1. 自托管 relay（docker；也可用 npm 包 @dweb/server-binary）
docker run -d -p 8787:8787 -p 3340:3340 ghcr.io/gaubee/dweb

# 2. 机器 A：初始化 fabric 并常驻聊天
DWEB_RELAY=custom DWEB_RELAY_URLS=http://<relay-host>:3340 \
  node packages/example/src/cli.mjs init --data ~/.dweb-a
DWEB_RELAY=custom DWEB_RELAY_URLS=http://<relay-host>:3340 \
  node packages/example/src/cli.mjs chat --data ~/.dweb-a

# 3. 机器 B：兑换邀请（issuer 须在线）并聊天
DWEB_RELAY=custom DWEB_RELAY_URLS=http://<relay-host>:3340 \
  node packages/example/src/cli.mjs join --data ~/.dweb-b <token>
DWEB_RELAY=custom DWEB_RELAY_URLS=http://<relay-host>:3340 \
  node packages/example/src/cli.mjs chat --data ~/.dweb-b
```

注意：`invite` 由常驻进程签发语义最稳（一次性进程的直连端口会随进程退出失效；
relay 模式不受影响）。本机代理（http_proxy 等）会劫持 relay WS 连接，必要时设置
`NO_PROXY`。

## SDK（Node，darwin-arm64）

```js
const { Fabric } = require("@dweb/client-sdk");
const a = await Fabric.createRoot({ dataDir: "/path/a", relay: { mode: "disabled" } });
const token = await a.invite(10 * 60_000, null);          // root 签发
const b = await Fabric.joinWithToken({ dataDir: "/path/b" }, token); // 在线兑换
b.on((e) => console.log(e.type, e.data?.toString()));     // 事件
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
pnpm --filter @dweb/client-sdk test     # node --test（SDK 生命周期）
pnpm --filter @dweb/example test        # node --test（双进程 relay E2E）
```

- 仓库位于网络磁盘：Rust 编译走本地 `CARGO_TARGET_DIR`（`.cargo/config.toml` 本机配置，
  CI/容器以 env 覆盖）。
- 原生二进制经内容寻址临时路径加载（规避 SMB 页缓存与 dyld 坏闭包）。
- 研发流程：OpenSpec 驱动，见 `openspec/changes/fabric-mvp`。
