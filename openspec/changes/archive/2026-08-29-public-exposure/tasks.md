# Tasks: public-exposure

> 中立层（1–4）先行，CF 适配（5）叠加其上；归档目录只读。

## 1. server 公网 URL 覆盖（中立层核心）

- [x] 1.1 main.rs：`--public-gateway` / `--public-relay` flag 解析 +
      `DWEB_PUBLIC_GATEWAY_URL` / `DWEB_PUBLIC_RELAY_URL` env 回退（flag > env > 未设置）
- [x] 1.2 main.rs：`validate_public_url`（http::Uri 白名单：scheme http(s)、
      host 非空、可选端口、path 仅空或 `/`、无 query/fragment/userinfo；
      fragment 因 http::Uri 静默吞掉而前置显式拒绝），非法值退出码 2；
      单测覆盖合法/非法形态
- [x] 1.3 services.rs：`ServiceInfo` 增 public_gateway_url / public_relay_url；
      build_manifest 按 D3 矩阵按条目覆盖（覆盖条目跳过 Host/scheme/回退，
      不产 WARNING；relay 禁用时忽略覆盖且无告警；仅当仍有条目需派生时才执行
      Host 校验/回退探测）
- [x] 1.4 services.rs：fixtures include 路径改指本 change contracts（8 例全过）

## 2. fixtures 契约迁移

- [x] 2.1 contracts/services.fixtures.json：旧 4 例原样 + 新 4 例 public-*
- [x] 2.2 example/test/relay-resolve.test.mjs fixtures 路径更新（客户端解析对新用例断言）

## 3. 包装层透传

- [x] 3.1 server-binary：startServer 增 publicGatewayUrl / publicRelayUrl（显式定义才写 env）
- [x] 3.2 opendweb CLI：flag/env/轻量校验（退出码 2）+ 横幅 Public 节 + help 文档
- [x] 3.3 opendweb / server-binary 单测更新

## 4. 验证（中立层）

- [x] 4.1 `cargo test -p dweb-server`（33/33；fmt clean）
- [x] 4.2 example relay-resolve 测试（25/25，含 4 个 public-* 新 fixture）
- [x] 4.3 e2e 冒烟：`opendweb server --public-gateway/--public-relay` →
      /services.json 与 GET / 公告覆盖值；非法值 CLI 层退出码 2、二进制层退出码 2
      （server-binary 7/7、opendweb 16/16；darwin 二进制已重打包）
- [x] 4.4 顺手修复（预存缺陷，非本 change 语义）：
      a) cli.test.mjs "--http is now unknown" 在 ESM 中误用 `require`（154baf3 引入，
         ReferenceError 掩盖断言）——改为直接调用顶部已导入的 resolveServerArgs；
      b) "--http alias starts identical gateway" e2e 测的是已被移除的行为，且
         `finally { await child.once("exit") }` 在子进程秒退时永久死锁（exit 事件
         早于监听器挂载）——重写为断言快速失败（退出码 2 + unknown option 消息），
         并引入 waitExit() 竞态安全辅助函数统一所有 e2e teardown；
      c) CLI validatePublicUrl host 字符集排除 `:`（否则 `ex.com:0` 端口段被贪婪吞掉）

## 5. CF Tunnel 部署参考物（中立之上的适配）

- [x] 5.1 docker/compose.yaml：dweb（无 published ports，仅 expose）+ cloudflared
      sidecar（TUNNEL_TOKEN）；`docker compose config` 语法验证通过
- [x] 5.2 README 部署章节：反代/隧道通用要点 + CF 单域名路径分流/双主机名拓扑 + env 表增补

## 6. Codex 复核闭环（R2，2026-08-29，gpt-5.6-terra xhigh）

首轮评分 5.5/10、3×P1 + 2×P2。修复（与并发会话的 R2/R3 修复叠加）：

- [x] 6.1 P1-1 端口校验绕过：`Uri::port_u16()` 对 `:65536`/尾随 `:`/非数字端口
      静默返回 None——改为从 authority 原文显式提取端口段并校验 1-65535；
      回归单测 `validate_public_url_rejects_degenerate_ports`
- [x] 6.2 P1-3 scheme 大小写分裂：http::Uri 将 scheme 归一为小写，原实现
      「校验通过（小写）vs services.rs starts_with 防御（原串大写）→ relay 禁用」
      ——`validate_public_url` 改为校验 + **canonical 重建**（scheme 小写、
      尾随 / 剥除、无默认端口伪造），公告值与校验值同源；CLI 侧
      `normalizePublicUrl` 同规（scheme 大小写不敏感、host 限 ASCII
      字母/数字/./-，拒绝空白与 unicode）
- [x] 6.3 P1-2 CLI 伪成功：readiness 门（banner 前置 healthz 就绪探测，
      30s 超时）+ 子进程退出码保留传播 + wrapper stderr 实时转发与尾部留存
      （`stderrTail()`）；端口冲突 e2e 验证（relay 口冲突 → 无横幅、
      stderr 转发、退出码 1）
- [x] 6.4 P2-1 fixtures 原样冻结：旧 4 例 note 还原为归档原文（仅追加
      public-* 用例）
- [ ] 6.5 P2-2 范围混入（README 英文化等 hardening-backlog 内容混入提交
      c5f93e2/cddf3b9）：**非本 change 工作区产物**（外部会话提交），
      拆分提交的裁决留给 Owner
- 验证：cargo 35/35（fmt clean）· server-binary 7/7 · opendweb 19/19 ·
  example 25/25；darwin 二进制已重打包
