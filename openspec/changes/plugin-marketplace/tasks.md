# Tasks: plugin-marketplace

> 契约以 ≥2 真实消费者塑形后再冻结；共享文件（package.json/lockfile）由 ZCode 统一落盘。
> 注意：本 change 文档曾被并发会话清理（未跟踪文件无 git 记录）——**定稿后尽快提交**。

## 1. 自适应子命令 + marketplace（CLI 核心）

- [x] 1.1 `~/.opendweb/marketplace.json` 读写与默认值（`npm:@jixo/opendweb-ext-*, npm:opendweb-*`）
- [x] 1.2 `opendweb marketplace add/list/remove`（npm: 源语法校验，未知协议报错）
- [x] 1.3 自适应解析：非 builtin 首 token → 候选生成 → `import("$PKG/opendweb-plugin")`
      → safeParse → 派发；全部不可解析时报错 + 精确 plugin add 命令
- [x] 1.4 插件 CLI 面契约 zod schema（name/apiVersion=1/commands[args JSON Schema 子集]）+
      执行包装器（错误归一化、ASCII logger、退出码映射）；`opendweb <name> --help` 零执行生成
- [x] 1.5 `opendweb plugin add/remove/list`（包管理器探测安装 + name@version 锁定
      ~/.opendweb/plugins.json；安装/卸载经继承 stdio 的用户包管理器）
- [x] 1.6 单测：解析顺序、builtin 优先、清单不合规=硬错误、锁定与卸载、候选展开

## 2. 静态配置 + 插件文件 + 生命周期

- [x] 2.1 TOML/JSON 双格式发现与解析（smol-toml；toml > json，--config 覆盖），
      同一 zod schema 校验（configVersion/server/plugins 三形态）；静态报错不执行
- [x] 2.2 优先级 flag > env > config > default 接入 resolveServerArgs（第三参注入）；
      无插件时零 runtime 依赖（纯静态路径）
- [x] 2.3 插件统一对象契约 `{name, hooks}` + 双适配器：
      npm 包（进程内 import 包根导出直调）/ 本地文件（shebang 执行器 + `--opendweb-declare`
      声明 + `--opendweb-hook` 回调协议，stdin payload / stdout 结果）
- [x] 2.4 `@jixo/opendweb-config` helper 包：definePlugin（runtime 无关 ESM，
      检测 Deno/Bun/process）封装本地插件子进程协议（三种调用形态有测试）
- [x] 2.5 3+1 钩子挂点：preStart（覆写片段经同规校验合并，失败阻断）/ postReady
      （readiness 门后，失败 WARNING + bannerLines 扩展）/ preStop（尽力）；
      `opendweb setup` 聚合编排（任一失败非零 + 逐插件状态）
- [x] 2.6 单测：schema 双格式一致性、优先级矩阵、双适配器等价性（npm 与本地
      同钩子同权）、失败语义矩阵、setup 聚合退出码、shebang 解析（含 env -S）
- [x] 2.7 e2e（子进程级）：自适应派发/未安装指引/坏清单硬错误/help 零执行/
      marketplace 事务/setup 编排（成功与失败聚合）
- [x] 2.8 顺手恢复被 70e61ab 意外回退的三处 R3 修复（CLI canonical 端口
      `:00001→:1`、括号 IPv6 严格校验、stderr 不回放）+ 共享向量回归锚点测试

## 3. 首个消费者：@jixo/opendweb-ext-cf

- [x] 3.1 包骨架 + 双面孔导出（CLI 面命令清单 setup/verify/plan +
      config 面 {name, hooks}：setup / server.postReady / server.preStop）
- [x] 3.2 setup 向导：token 解码（base64 {a,t,s}）→ CF API 推 ingress
      （双主机名默认/单域名可选，PUT configurations）→ DNS 路由 best-effort
      （zone 查询 + CNAME，81057 幂等，失败给手工路径）→ 写 opendweb.config.toml
      （仅当文件不存在；已存在打印待合并片段保注释）→ 端到端自检（公网拉
      services.json 断言 relay URL）→ 打印客户端入口；`--dry-run` 零网络副作用
- [x] 3.3 postReady 自检钩子（含 bannerLines）+ preStop 清理 + `tunnel = true`
      共生 spawn cloudflared（SIGINT 优雅停 + SIGKILL 兜底）
- [x] 3.4 第二消费者：测试夹具 opendweb-echo（双面）+ 本地 local-echo——
      e2e 双消费者同场（一 config 内 cf npm 插件与本地插件经 `opendweb setup`
      编排，含失败聚合路径）
- [x] 3.5 e2e：cf plan/`--help` 零执行/setup `--dry-run`/双消费者成功与失败
      聚合（全部走真实 opendweb CLI 子进程与 @jixo 候选优先解析）；
      **真实隧道冒烟（用户账号 + TUNNEL_TOKEN + cloudflared）留作人工验收**，
      步骤即 `opendweb plugin add cf && opendweb cf setup --hostname <你的域名>`

## 4. 文档与验证

- [x] 4.1 README（EN+zh 双语）插件章节：plugin/marketplace 命令、TOML 编排
      示例、生命周期语义、插件开发指南（双面孔 + definePlugin 本地文件）、
      安全模型（安装即信任/兼容门非沙箱/无 scope 开放的 typosquat 提示）；
      Packages 表与仓库布局增补
- [x] 4.2 全量门禁：opendweb 56/56 · opendweb-config 4/4 · opendweb-ext-cf
      11/11 · server-binary 7/7 + tsc clean（测试文件按资源纪律串行）

## 5. 自愈安装（Owner 第四轮决策，2026-08-29：opendweb cf 即 get cf ?? add cf）

- [x] 5.1 PluginNotResolved 类型化（携带候选序列）；runAdaptive 捕获后取首个
      候选（声明序 = 官方 scoped 优先）自愈安装并重试解析一次；安装输出可见
      （继承 stdio + installed: name (pkg@version)）
- [x] 5.2 DWEB_NO_AUTO_INSTALL=1 逃生阀（显式安装语义 + 手动指引 + 零安装痕迹）
- [x] 5.3 `plugin get` 作为 add 同义命令
- [x] 5.4 e2e（fake-pm PATH shim，无网络）：自愈安装全链路（安装输出 + 锁定
      记录 + 派发成功）、NO_AUTO_INSTALL 语义、get 别名
- [x] 5.5 文档同步：design D2 / proposal / spec delta（两 Scenario 重写）/
      README EN+zh；opendweb 59/59

## 6. 复审闭环后续项（Codex R7 终审 8.3/10 可合并，2026-08-30 登记）

- [ ] 6.1 expectedPackageRoot 与注释承诺对齐：近层错名目录遮蔽外层合法
      副本时，受控转向已验证的外层 expectedRoot 走 fs 解析（近层错身份
      ≠ 包内入口 symlink 逃逸，后者仍硬拒）；补嵌套依赖树回归
- [ ] 6.2 并发停止回归断言增强：fake child 收到 SIGINT 后延迟退出，先
      单独断言第二个 preStop 仍 pending；另加真实 CLI 双信号集成回归，
      验证 server.stop() 仅在唯一 preStop 流程完成后触发

## 7. cf 插件 TS+tsdown 迁移后续项（Codex R2 终审 9/10 可合并，2026-08-30 登记）

- [ ] 7.1 stale-record 生命周期回归：确定性构造「active 记录指向已退出
      child」的状态（黑盒不可达——Node 的 SIGCHLD 回调同步设置 exitCode
      并派发 exit；需测试导出钩子或拆分生命周期模块后白盒注入），断言
      恰好一条 WARNING、旧 watchdog 摘除、随后允许新 spawn
- [ ] 7.2 pack:dry 升级为 clean-tar 消费者导入测试：解包 tarball 到
      临时目录后从包上下文 import 两个 exports 面，端到端证明零运行时
      依赖可解析
- [ ] 7.3 tsdown 构建性能：dts 生成主导串行构建耗时，调查并行/缓存
      方案（不阻塞正确性，仅影响 test/pack:dry 门禁成本）
