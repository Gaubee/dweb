# Design: plugin-marketplace

## D1 marketplace 语义：候选名 globs，不是注册表

```text
opendweb marketplace add "npm:@jixo/opendweb-ext-*, npm:opendweb-*"   # 默认值
opendweb marketplace list / remove
存储：~/.opendweb/marketplace.json（声明序即解析序）
源语法：仅 npm:（协议前缀留在语法位，不实现其它协议）
```

## D2 自适应子命令解析

```text
opendweb cf setup --token X
  └─ "cf" 非 builtin（server/help/marketplace/plugin/use/config/setup）
     └─ 按 marketplace 声明序生成候选：@jixo/opendweb-ext-cf → opendweb-cf
        └─ 逐个尝试 import("$PKG/opendweb-plugin")（Node 解析，本地已安装优先）
           └─ 首个 import 成功且 safeParse 通过者胜出
              └─ 校验失败 ≠ 跳过（同名包清单不合规属硬错误，避免静默漏配）
全部候选不可解析 → 自愈安装（Owner 第四轮决策：opendweb cf 即 get cf ?? add cf）
  取首个候选（声明序 = 官方 scoped 优先的安全梯度）经用户包管理器安装（输出可见，
  继承 stdio）→ 重试解析一次；仍失败 → 硬错误
DWEB_NO_AUTO_INSTALL=1 关闭自愈 → 显式安装语义（错误附 plugin add 指引；CI 逃生阀）
builtin 关键字恒优先；opendweb use <name> 为显式等价形（纯转发，无附加语义）
```

## D3 插件 CLI 面契约（子路径导出 `./opendweb-plugin`）

```ts
const PluginModule = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),  // 与自适应子命令名一致
  apiVersion: z.literal(1),                      // 契约破坏性变更走 2
  commands: z.array(z.object({
    name: z.string(),
    description: z.string(),                     // help 生成
    args: JsonObject,                            // JSON Schema 声明；
  })),                                           // CLI 统一解析/校验/help
  run: z.function(),                             // 行为部分只能类型约束
});
```

- **safeParse 是兼容门，不是安全门**：`import()` 即执行模块顶层代码；真正的
  安全边界在安装时信任（D7）
- 执行模型 v1 = in-process ESM（CLI 短生命周期）；CLI 包装器统一：错误归一化、
  ASCII 纪律 logger、退出码映射；`opendweb <name> --help` 零执行生成

## D4 分层配置：编排层纯数据，代码只在插件文件

```text
opendweb.config.toml              # 纯声明：server 段 + 有序插件清单（无任何代码）
opendweb.plugins/
  cf.ts                           # 代码层：shebang 声明 runtime；
  #!/usr/bin/env -S deno run      # definePlugin({name, hooks}) 封装协议
  frp.ts                          # 每插件一文件（文件即接线，含本地自定义插件）
npm 插件包                         # @jixo/opendweb-ext-* / opendweb-*
                                  # config 面 = 包根导出 {name, hooks}（options 经 ctx）
```

```toml
# opendweb.config.toml —— 与 Cargo.toml 同心智：数据不执行
configVersion = 1

[server]
gatewayBind = "0.0.0.0:8787"
publicGatewayUrl = "https://dweb.example.com"    # 与 flag 同名同规
# relayBind / relayEnabled / trustProxy / publicRelayUrl ...

plugins = ["cf"]                                  # 裸名简写 → marketplace 解析

[[plugins]]                                       # 表形式：带选项或本地文件
name = "frp"
[plugins.options]                                 # 选项是数据（非闭包）；
tokenEnv = "TUNNEL_TOKEN"                         # 秘密经 env 间接引用

[[plugins]]
file = "opendweb.plugins/backup.ts"               # 本地插件文件（相对 config 目录）
```

- 发现顺序：`./opendweb.config.toml` > `.json`；`--config <path>` 覆盖。
  两种格式**同一 zod schema**（解析后校验，杜绝格式间 schema 漂移）；
  TOML 解析依赖 smol-toml（Node 无内建）
- 优先级：**flag > env > config file > default**
- **无插件时零 runtime 依赖**：`opendweb server` 只做静态解析，不 spawn 任何
  解释器、不执行任何代码；polyglot 复杂度只在声明了插件时才进入
- 代价（有意接受）：编排层失去组合期代码能力（条件逻辑/闭包）——这些属于
  插件文件；选项只能是数据，秘密用 `xxxEnv` 间接引用
- **单编排点原则**：编排权只属于配置文件；CLI 不做插件文件夹自动发现
  （避免配置与文件夹两个编排真相源）

## D4b 插件统一对象契约与两种执行适配器

npm 包与本地文件呈现**同一插件对象契约** `{ name, hooks }`（hooks 收
`(ctx)`；ctx.options 来自 TOML、ctx.server 为解析后配置、钩子特定字段如
postReady 的就绪地址），执行适配器不同：

| 声明形态 | 适配器 | 钩子执行 |
| --- | --- | --- |
| `name = "cf"`（marketplace → npm 包） | 进程内：CLI（Node）import 包根导出，直接调 hooks | 进程内调用 |
| `file = "opendweb.plugins/x.ts"` | 子进程：shebang runtime 执行；无参 → stdout 声明 `{name, hooks:[...]}`；`--opendweb-hook <name>` + stdin payload `{options, server, ...}` → 执行并 stdout 结果 JSON | 重执行回调协议 |

- 本地插件协议样板由 helper `definePlugin`（`@jixo/opendweb-config`，
  runtime 无关 ESM，检测 Deno/Bun/process）封装，作者只写 `{name, hooks}`
- 跨平台执行：解析 shebang 首行 → spawn 解释器 + 文件参数；无 shebang 按
  扩展名探测（.ts→bun|deno|node，.js/.mjs→node）
- npm 包 config 面无工厂调用（选项是数据经 ctx 传入，非闭包）——与本地
  文件契约完全同形

## D5 生命周期与可调用钩子（v1 恰 3+1）

| 钩子 | 挂点 | 失败语义 |
| --- | --- | --- |
| `server.preStart` | spawn Rust server 前（回调可返回 server 配置覆写片段） | 阻断启动 |
| `server.postReady` | readiness 门通过后（横幅前）：端到端验证/横幅扩展 | 降级 WARNING |
| `server.preStop` | SIGINT/SIGTERM 处理内、server.stop() 前 | 尽力执行 |
| `setup`（可调用） | `opendweb setup` 触发；按清单序执行全部声明 setup 的插件并聚合 | 任一失败 → 非零退出 |

`setup` 不是 server 生命周期，是命令式编排入口：与 `server.*` 走同一回调
协议（进程内直调或子进程重执行，按适配器而定），CLI 对其内容零感知。
单插件零 config 场景仍走自适应子命令（`opendweb cf setup`，CLI 面）。

## D6 配置 schema（v1，两格式共用）

```text
configVersion: 1
server: gatewayBind/relayBind/relayEnabled/trustProxy/
        publicGatewayUrl/publicRelayUrl（与 flag 同名同规）
plugins: 有序数组；元素 = "name" 简写 | {name, options} | {file, options?}
```

## D7 安全与信任模型

- 安装即信任：`plugin add` 展示精确 name@version 并锁定于
  `~/.opendweb/plugins.json`；本地插件文件同 vite.config 属用户自有代码同信任级
- 无 scope glob 默认开放（Owner 决策）——文档明示 typosquat 风险与核对建议，
  不加首跑拦截（保持社区零门槛）
- 配置文件是纯数据：解析失败是静态错误，不涉及执行；插件执行输出全部经
  CLI 的 ASCII 纪律包装器呈现

## D8 塑形纪律与首个消费者

- 契约以 ≥2 真实消费者塑形：`@jixo/opendweb-ext-cf`（完整向导）+
  一个最小第二消费者（`cloudflared-quick` 演示或 frp）
- cf 插件职责 = 调研第二层向导：token → CF API 推 ingress → 写配置/env →
  端到端自检（公网拉 /services.json 断言 relay URL）→ 打印客户端唯一入口
