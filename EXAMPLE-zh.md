# dweb Example 测试手册

[English version](EXAMPLE.md)

本手册描述如何用已发布的 npm 包做端到端验证。每次发布新版本后按此流程复测。
当前适用版本：**v0.2.0**（gateway 单一入口 + join 诊断 + invite 安全门）。

## 架构速览

```
+-------------------+     /services.json      +--------------------+
|  opendweb server  |<------------------------|  example 客户端     |
|  gateway :8787    |   自动发现 relay URL     |  (A / B / C ...)   |
|  relay   :3340    |                         +--------------------+
+-------------------+
    ^     ^     ^        A = root（签发邀请，须在线）
    |     |     |        B = 被邀请者（join 兑换）
  A <-> B <-> C ...      消息经 QUIC 直连（优先）或 relay 桥接
```

- **gateway**（8787）= 客户端唯一配置入口：`/healthz`、`/services.json`、rendezvous
- **relay**（3340）= iroh 桥接（无法直连时的回退路径）
- 客户端配置一次 relay 地址即可，relay URL 由 `/services.json` 自动发现

## 环境准备

```bash
# Node >= 20；三台机器（或三个隔离 HOME / 容器）分别代表 server、A、B
node --version
```

代理注意：客户端 `proxy=auto`（默认）会先直连探测——本机设了 `http_proxy` 时
局域网 relay 直连可达即自动绕过，无需手动 `NO_PROXY`。

---

## 第一部分：Server 启动与验证

### 1.1 启动

```bash
# 任一台机器（或本机）：
npx opendweb@0.2.0 server
```

预期输出（纯 ASCII、vite 风格枚举本机 IP）：

```
  * opendweb server v0.2.0
  > Local:   http://localhost:8787
  > Network: http://192.168.x.x:8787
             http://10.x.x.x:8787

  Use any Network address as the single config entry for clients.

    NAME         PORT   STATE
    gateway      8787   entry point
    rendezvous   8787   merged into gateway
    relay        3340   enabled

  Press Ctrl+C to stop
```

**验证点**：
- [ ] 横幅全 ASCII（无中文/Unicode 符号）
- [ ] Network 行枚举所有非 loopback IPv4
- [ ] `NAME | PORT` 服务表完整

### 1.2 健康检查

```bash
curl -s http://localhost:8787/healthz          # -> 200
curl -s http://localhost:8787/ | head -5       # -> 纯文本摘要（全 ASCII）
```

### 1.3 服务清单（关键：单一配置入口）

```bash
curl -s http://localhost:8787/services.json | python3 -m json.tool
```

预期（host/port 按请求方 IP 派生）：

```json
{
    "server": "opendweb",
    "version": "0.2.0",
    "gateway": "http://<你的IP>:8787",
    "services": [
        {"name": "rendezvous", "enabled": true, "url": "http://<你的IP>:8787/rendezvous"},
        {"name": "relay", "enabled": true, "url": "http://<你的IP>:3340"}
    ]
}
```

**验证点**：
- [ ] `relay.url` 端口是 3340（不是 8787——relay 独立监听）
- [ ] 用 LAN IP 访问时 URL 的 host 部分是同一 IP
- [ ] `--no-relay` 启动时 relay 条目为 `"enabled": false, "url": null`

### 1.4 CLI 选项

```bash
npx opendweb@0.2.0 server --gateway=0.0.0.0:9999   # --opt=value 形式
npx opendweb@0.2.0 server --no-relay               # 关闭 relay
DWEB_TRUST_PROXY=1 npx opendweb server             # 反代 TLS 时采信 X-Forwarded-Proto
```

---

## 第二部分：客户端 A（root，签发邀请）

### 2.1 一次性配置

```bash
# 每台客户端机器只需一次（持久化于 ~/.opendweb/config.json，0600）：
npx @jixo/opendweb-example@0.2.0 config set relay http://<server-IP>:8787
```

预期输出（当场解析 gateway + 探测）：

```
saved: http://192.168.x.x:8787 (gateway -> http://192.168.x.x:3340)
```

**验证点**：
- [ ] gateway 地址被解析为实际 relay URL（3340）
- [ ] 裸 relay URL（`http://<IP>:3340`）同样可用（0.1.0 legacy 兼容）

### 2.2 初始化 + 常驻聊天

```bash
npx @jixo/opendweb-example@0.2.0 init --data ~/.dweb-a
npx @jixo/opendweb-example@0.2.0 chat --data ~/.dweb-a
```

预期输出：

```
chat ready as <52字符z32-id> (~/.dweb-a)
relay: online (1 candidate)
```

**验证点**：
- [ ] `relay: online`（不再静默——relay 不可达时有醒目 WARNING）
- [ ] 无需手动 `export DWEB_RELAY=...`（config 文件已持久化）

### 2.3 签发邀请

```bash
# 另开终端（chat 保持运行——invite 需签发者在线）：
npx @jixo/opendweb-example@0.2.0 invite --data ~/.dweb-a --ttl 30m
```

输出 `dweb1.` 前缀的令牌（默认 60 分钟有效）。

**invite 安全门验证**（无 relay 时拒签）：

```bash
# 临时清空 relay 配置：
DWEB_RELAY=disabled npx @jixo/opendweb-example@0.2.0 invite --data ~/.dweb-a
# -> error[invite/INVITE_WITHOUT_RELAY]: no relay configured; set one via
#    'config set relay <url>' or pass --allow-relayless ...

# 逃生阀（令牌仅可凭显式直连地址兑换）：
DWEB_RELAY=disabled npx @jixo/opendweb-example@0.2.0 invite --allow-relayless --data ~/.dweb-a
# -> WARNING: token has no relay path; the caller is responsible for an
#    out-of-band reachable path
```

---

## 第三部分：客户端 B（加入方，兑换邀请）

### 3.1 配置 + 兑换

```bash
npx @jixo/opendweb-example@0.2.0 config set relay http://<server-IP>:8787
npx @jixo/opendweb-example@0.2.0 join --data ~/.dweb-b <粘贴令牌>
```

预期输出：

```
joined fabric <hex-id>
  endpoint-id : <52字符z32-id>
  members     : 2
```

**验证点**：
- [ ] 兑换成功时 A 的 chat 终端能看到 B 加入
- [ ] **A 必须在线**（issuer-online 语义——A 的 chat 进程关闭时 join 超时）

### 3.2 双向消息

```bash
npx @jixo/opendweb-example@0.2.0 chat --data ~/.dweb-b
```

A/B 互发消息（`members` 命令查看成员，直接输入文字发送）。

**验证点**：
- [ ] 消息即时送达（直连路径）或经 relay（NAT 阻隔时）
- [ ] 撤销测试（A 侧）：`revoke <B的id>` → B 的连接断开（B 再 connect A
      报 io error: connection lost）；注意 revoke 生效于门控（连接拒绝），
      本地名册投影需等下次同步刷新

### 3.3 join 错误码（8 码诊断）

| 场景 | 命令 | 预期 stderr |
| --- | --- | --- |
| 无路径令牌 | `join` 空 relay 令牌 | `error[join/NO_REACHABLE_PATH]: the token carries no relay URL...`（join 本身秒败；含 npm 启动约 5s 总耗时） |
| 签发者离线 | A 关闭后 B join | `error[join/DIAL_TIMEOUT]: issuer did not respond within 30s (relay online: issuer likely offline...)` |
| 目录不匹配 | `join --data <已属于其它fabric的目录>` | `error[join/WRONG_FABRIC]: data dir ... belongs to fabric <a> but the token is for fabric <b>; use a fresh --data directory` |
| 过期令牌 | `--ttl 1s` 等待后 | `error[join/TOKEN_EXPIRED]: the invite token has expired...` |
| 二次兑换 | 同令牌再 join | `error[join/TOKEN_CONSUMED]: this invite token was already used...` |
| 令牌损坏 | 篡改令牌串 | `error[join/TOKEN_INVALID]: the invite token is malformed...` |

---

## 第四部分：配置管理

```bash
npx @jixo/opendweb-example@0.2.0 config list
```

预期输出（含来源标注）：

```
relay  = http://192.168.x.x:8787  (file)
proxy  = auto                       (default)
data   = ~/.dweb-example            (default)
inviteTtlMs = 3600000               (default)
joinTimeoutMs = 30000               (default)
```

```bash
config get relay                          # 单查
config set proxy off                      # 三态：auto|on|off
config set relay http://a:8787 http://b:8787   # 多 relay（iroh 原生择优）
config unset proxy                        # 恢复默认
```

**事务语义**：
- 语法校验失败（非 URL）→ 不写入、退出码 1
- 探测不可达 → **仍写入** + WARNING `saved but unreachable: ...` + 退出码 1
  （离线预填是合法场景）

**优先级**：`flag > env > file > default`（`DWEB_RELAY=disabled` 覆盖文件值）。

---

## 第五部分：跨机部署拓扑

三台机器（或本机 + 两台远程）：

```
机器 S（server）          机器 A（root）           机器 B（joiner）
────────────────         ────────────────         ────────────────
npx opendweb server       config set relay         config set relay
   ↓                      http://S:8787            http://S:8787
横幅显示 Network IP        init + chat              join <token>
                          invite --ttl 30m         chat
```

全部走 npm 已发布包，无需克隆仓库。

---

## 故障排查速查

| 症状 | 原因 | 处置 |
| --- | --- | --- |
| `invite` 报 INVITE_WITHOUT_RELAY | 未配置 relay | `config set relay http://<IP>:8787` |
| `join` 超时 DIAL_TIMEOUT | 签发者（A）不在线 | A 开 `chat` 后重试 |
| `join` 秒败 NO_REACHABLE_PATH | 令牌签发时无 relay | 让 A 配好 relay 后重新 invite |
| chat 显示 `relay offline` WARNING | relay 服务不可达 | 检查 server 进程 / 网络 / 防火墙 |
| `error: gateway ... unreachable (http 502)` | gateway 返回 5xx | 检查 server 日志 |
| `error: gateway ... returned JSON but not a services manifest` | 响应不是合法清单 | 确认地址指向 opendweb server（不是别的 HTTP 服务） |
| B 连接 A 失败重试多次 | iroh 同 NodeId 去重窗口 | v0.2 已内置 3s 沉降 + 重试；持续失败查 relay 可达性 |

---

## 快速回归清单（发布后逐项勾选）

- [ ] `npx opendweb@<ver> server` 启动，横幅 ASCII + IP 枚举
- [ ] `curl /healthz` → 200
- [ ] `curl /services.json` → relay URL 端口 3340
- [ ] `config set relay http://<IP>:8787` → 解析为 relay URL
- [ ] `init` + `chat` → `relay: online`
- [ ] `invite` → `dweb1.` 令牌
- [ ] 无 relay 时 `invite` → `error[invite/INVITE_WITHOUT_RELAY]`
- [ ] 另一机器/目录 `join <token>` → `joined fabric`
- [ ] 双向 chat 消息送达
- [ ] `revoke` → 对端 disconnected
- [ ] 同令牌二次 join → `error[join/TOKEN_CONSUMED]`
- [ ] A 离线后 B join → `error[join/DIAL_TIMEOUT]`（30s 内）
- [ ] 空 relay 令牌 join → `error[join/NO_REACHABLE_PATH]`（秒败）
- [ ] `config list` 显示来源标注
- [ ] `config set relay <语法错误>` → 不写入 + exit 1

---

## v0.1.0 → v0.2.0 变更摘要

| 领域 | v0.1.0 | v0.2.0 |
| --- | --- | --- |
| 配置入口 | 手动 `export DWEB_RELAY=...` 每终端 | `config set relay` 一次持久化 |
| relay 发现 | 手动指定 3340 端口 | gateway `/services.json` 自动发现 |
| invite 安全 | 无 relay 照签（死令牌） | 拒签 + `--allow-relayless` 逃生阀 |
| join 诊断 | 30s 无限超时零信息 | 8 码分类（秒败/超时归因/目录指引） |
| TTL 默认 | 10 分钟 | 60 分钟（`--ttl 30m` 可调） |
| 代理 | 手动 `NO_PROXY` | `proxy auto` 探测自动绕过 |
| relay 状态 | 静默（"ready" 是假的） | chat 外显 online/offline + lastError |
| wrong-fabric | 误报 "corrupted" | 独立错误 + 换目录指引 |
| CLI 参数 | 仅 `--opt value` | `--opt=value` / `~` 展开 / 未知选项报错 |

版本发布流程：tag `v*` → GitHub Actions release.yml → OIDC trusted publishing → npm。
