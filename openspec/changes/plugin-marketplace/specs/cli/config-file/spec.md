# cli/config-file

## ADDED Requirements

### Requirement: 静态配置文件（编排层零代码）

CLI SHALL 自动发现 `./opendweb.config.toml`（优先）或 `./opendweb.config.json`
（`--config <path>` 覆盖）。配置文件 MUST 为纯数据（解析后经同一 zod schema
校验：`configVersion`、`server` 段、有序 `plugins` 清单），MUST NOT 包含或触发
任何代码执行。`server` 段字段与同名 flag 语义一致；生效优先级 MUST 为
flag > env > config file > default。插件清单元素 MUST 支持三种形态：裸名字符串
（经 marketplace 解析为 npm 包）、`{name, options}`、`{file, options?}`（本地
插件文件，路径相对配置文件目录）。选项值为纯数据；敏感值 SHOULD 经 `xxxEnv`
环境变量名间接引用。

#### Scenario: 静态解析零执行

- **WHEN** 配置仅含 server 段且 `opendweb server` 启动
- **THEN** CLI 仅静态解析配置，不 spawn 任何解释器或执行任何代码

#### Scenario: 双格式同 schema

- **WHEN** 同一配置分别以 TOML 与 JSON 提供
- **THEN** 解析产物与校验结果一致（同一 zod schema，无格式间漂移）

#### Scenario: 配置参与优先级

- **WHEN** config 文件、环境变量与 flag 同时给出同一配置项
- **THEN** 生效优先级为 flag > env > config file > default

#### Scenario: 无效配置静态报错

- **WHEN** 配置解析失败或未通过 schema 校验
- **THEN** 非零退出并输出静态校验错误（不涉及任何执行）

### Requirement: 本地插件文件（多 runtime，shebang 声明）

本地插件文件 MUST 以首行 shebang 声明执行 runtime（deno/bun/node 等）；CLI
MUST NOT 内嵌 js/ts 解释逻辑，仅解析 shebang 并以对应解释器执行文件（无
shebang 时按扩展名探测）。子进程协议：无参执行 → stdout 输出声明
`{name, hooks: [...]}`；以 `--opendweb-hook <name>` 执行 → stdin 读 payload
（JSON：options/server/钩子特定上下文）、stdout 输出结果 JSON。协议样板由
helper 包 `@jixo/opendweb-config` 的 `definePlugin` 封装，作者只声明
`{name, hooks}` 对象。本地文件即插件：无需 npm 发布。

#### Scenario: shebang 声明 runtime

- **WHEN** 本地插件文件首行为 `#!/usr/bin/env -S deno run`
- **THEN** CLI 以 deno 执行该文件完成声明与钩子回调，自身不解释文件内容

#### Scenario: 插件文件即本地自定义插件

- **WHEN** `opendweb.plugins/backup.ts` 未经 npm 发布、仅声明 `{name, hooks}`
- **THEN** 该本地插件与 npm 插件同权参与生命周期与 setup 编排

### Requirement: 生命周期钩子（3+1，统一适配器接口）

CLI SHALL 在 server 命令暴露三个生命周期钩子：`server.preStart`（spawn 前，
回调可返回 server 配置覆写片段，失败阻断启动）、`server.postReady`（healthz
就绪后、横幅前，失败降级 WARNING）、`server.preStop`（优雅停止前，尽力执行）。
npm 插件与本地插件 MUST 呈现同一插件对象契约 `{name, hooks}`（hooks 收
ctx：options 来自配置、server 为解析后配置）；执行适配器：npm 包 = CLI 进程内
import 直调，本地文件 = 子进程回调协议——对编排器不可见。

#### Scenario: preStart 覆写生效

- **WHEN** 插件的 preStart 钩子返回 `{"server":{"publicGatewayUrl":"..."}}`
- **THEN** server 以覆写值启动，services.json 公告该值

#### Scenario: postReady 验证失败不阻断

- **WHEN** postReady 钩子的端到端验证失败
- **THEN** server 继续运行并输出 WARNING（含失败详情与插件名）

#### Scenario: preStop 清理

- **WHEN** SIGINT 触发优雅停止
- **THEN** preStop 钩子先于 server 进程终止执行

#### Scenario: npm 与本地插件同权

- **WHEN** 配置同时声明 npm 插件（name）与本地插件（file）且声明同一钩子
- **THEN** 两者按清单序同权执行，互不感知差异

### Requirement: setup 编排命令

CLI SHALL 提供 `opendweb setup`：按配置清单序执行全部声明了 `setup` 钩子的
插件并聚合结果；任一失败 MUST 使 CLI 非零退出并逐插件报告状态。CLI MUST NOT
感知 setup 的具体内容。单插件零 config 场景仍由自适应子命令（如
`opendweb cf setup`）承载。

#### Scenario: 多插件 setup 聚合

- **WHEN** 配置声明 cf 与 frp 且均声明 setup 钩子，`opendweb setup` 执行
- **THEN** 两插件 setup 按序执行，全部成功退出码 0；任一失败退出码非零且输出逐插件状态
