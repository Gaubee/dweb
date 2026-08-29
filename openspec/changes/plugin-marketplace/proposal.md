# Proposal: plugin-marketplace

## Why

public-exposure 交付了厂商中立的公网公告层；「易用性适配」（CF Tunnel 向导等）
不应长成 CLI 内置代码——否则每个 front-end 供应商都成为核心的一次专项适配。
Owner 决策（2026-08-29，三轮收敛）：以**自适应子命令 + npm marketplace +
静态配置编排 + 生命周期钩子**的插件架构承接所有供应商/场景适配，CLI 结构上
只保留中立核心 + 插件槽位。

## What Changes

### 1. 自适应子命令与 marketplace（CLI）

- `opendweb marketplace add "npm:@jixo/opendweb-ext-*, npm:opendweb-*"`（**默认值**，
  Owner 决策：无 scope 命名空间默认开放，社区可自有插件）
- `opendweb <name> ...` / `opendweb use <name> ...`：非 builtin 首 token 按 marketplace
  声明序解析候选包（`*` → `<name>`），`import("$PKG/opendweb-plugin")` 后以
  zod `safeParse` 校验插件清单再派发；builtin 关键字恒优先
- `opendweb plugin add|get/remove/list`：显式安装与版本锁定；
  **自适应调用自愈安装**（Owner 第四轮决策：`opendweb cf` 即 `get cf ?? add cf`，
  取首个候选 = 官方 scoped 优先；`DWEB_NO_AUTO_INSTALL=1` 关闭）
- 源语法仅 `npm:`（Owner 决策：不考虑 `github:`/`https://`）

### 2. 静态配置编排（TOML 为主，JSON 兼容）

- 上层配置 `opendweb.config.toml`（> `.json`，同一 zod schema 校验）为**纯数据**：
  server 段 + 有序插件清单；编排层零代码执行
- 插件清单两种形态：裸名（marketplace 解析为 npm 包）与本地文件
  （`file = "opendweb.plugins/x.ts"`）
- **无插件时零 runtime 依赖**：`opendweb server` 仅静态解析
- 优先级 **flag > env > config file > default**；秘密经 `xxxEnv` 间接引用

### 3. 插件文件与生命周期（多 runtime 只在代码层）

- npm 插件包两张面孔：CLI 面（`./opendweb-plugin` 子路径 = 命令清单，自适应
  子命令用）+ config 面（包根导出 `{name, hooks}`，options 经 ctx 传入）
- 本地插件文件：shebang 声明 runtime（deno/bun/node 社区生态，CLI 零 js/ts
  耦合），helper `definePlugin` 封装声明/回调子进程协议；文件即插件（本地
  自定义插件无需发包）
- 生命周期 v1 恰 3+1：`server.preStart`（覆写配置，失败阻断）、
  `server.postReady`（验证，失败降级 WARNING）、`server.preStop`（清理）、
  `setup`（`opendweb setup` 编排入口，聚合退出码）

## Non-goals

- 编排层任何代码能力（条件逻辑属于插件文件；选项只能是数据）
- 插件包自动注册钩子（钩子由插件对象自带；编排只决定「谁在场、什么顺序」）
- `github:` / `https:` 源、子进程 RPC 插件隔离
- Rust server 侧任何插件化（内核保持中立）

## Decisions（Owner，2026-08-29，三轮）

1. 无 scope `opendweb-*` glob 默认开放（接受 typosquat 面，换取社区零门槛）
2. `use` 仅为插件调用转发，不耦合能力；组合能力归静态配置编排层
3. 源语法仅 `npm:`；CLI 不耦合 js/ts 解释——shebang 声明 runtime，且仅存在于
   插件文件（多 runtime 是代码层属性，不是配置层属性）
4. 上层配置用静态数据格式：**TOML 为主、JSON 兼容**（与 Cargo.toml /
   package.json 同心智：数据不执行）
