# Tasks: plugin-marketplace

> 契约以 ≥2 真实消费者塑形后再冻结；共享文件（package.json/lockfile）由 ZCode 统一落盘。
> 注意：本 change 文档曾被并发会话清理（未跟踪文件无 git 记录）——**定稿后尽快提交**。

## 1. 自适应子命令 + marketplace（CLI 核心）

- [ ] 1.1 `~/.opendweb/marketplace.json` 读写与默认值（`npm:@jixo/opendweb-ext-*, npm:opendweb-*`）
- [ ] 1.2 `opendweb marketplace add/list/remove`（npm: 源语法校验，未知协议报错）
- [ ] 1.3 自适应解析：非 builtin 首 token → 候选生成 → `import("$PKG/opendweb-plugin")`
      → safeParse → 派发；全部不可解析时报错 + 精确 plugin add 命令
- [ ] 1.4 插件 CLI 面契约 zod schema（name/apiVersion=1/commands[args JSON Schema]）+
      执行包装器（错误归一化、ASCII logger、退出码映射）；`opendweb <name> --help` 零执行生成
- [ ] 1.5 `opendweb plugin add/remove/list`（name@version 锁定于 ~/.opendweb/plugins.json）
- [ ] 1.6 单测：解析顺序、builtin 优先、清单不合规=硬错误、锁定与卸载

## 2. 静态配置 + 插件文件 + 生命周期

- [ ] 2.1 TOML/JSON 双格式发现与解析（smol-toml；toml > json，--config 覆盖），
      同一 zod schema 校验（configVersion/server/plugins 三形态）；静态报错不执行
- [ ] 2.2 优先级 flag > env > config > default 接入 resolveServerArgs 链；
      无插件时零 runtime 依赖（纯静态路径）
- [ ] 2.3 插件统一对象契约 `{name, hooks}` + 双适配器：
      npm 包（进程内 import 直调）/ 本地文件（shebang 执行器 + 无参声明 +
      `--opendweb-hook` 回调协议，stdin payload / stdout 结果）
- [ ] 2.4 `@jixo/opendweb-config` helper 包：definePlugin（runtime 无关 ESM，
      检测 Deno/Bun/process）封装本地插件子进程协议
- [ ] 2.5 3+1 钩子挂点：preStart（覆写片段，失败阻断）/ postReady（readiness
      门后，失败 WARNING）/ preStop（尽力）；`opendweb setup` 聚合编排
- [ ] 2.6 单测：schema 双格式一致性、优先级矩阵、双适配器等价性（npm 与本地
      同钩子同权）、失败语义矩阵、setup 聚合退出码

## 3. 首个消费者：@jixo/opendweb-ext-cf

- [ ] 3.1 包骨架 + 双面孔导出（CLI 面命令清单 + config 面 {name, hooks}）
- [ ] 3.2 setup 向导：token 输入 → CF API 推 ingress（双主机名默认/单域名可选）→
      写配置/env → 端到端自检（公网拉 services.json 断言）→ 打印客户端入口
- [ ] 3.3 postReady 验证钩子 + preStop 清理 + `--tunnel` 共生 spawn
- [ ] 3.4 第二消费者（cloudflared-quick 演示或 frp 最小实现）——契约反哺校验
- [ ] 3.5 e2e：quick tunnel 真链路冒烟 + cf 插件 dry-run 模式（无真实账号路径）+
      本地自定义插件文件（definePlugin）全生命周期路径

## 4. 文档与验证

- [ ] 4.1 README 插件章节：marketplace/plugin/config 三命令 + 插件开发指南
      （双面孔契约、发布命名 opendweb-ext-* / opendweb-*、TOML 编排示例、
      typosquat 核对建议）
- [ ] 4.2 全量门禁：cargo / pnpm -r test / typecheck / compose 冒烟不回归
