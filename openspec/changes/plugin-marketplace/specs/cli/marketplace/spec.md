# cli/marketplace

## ADDED Requirements

### Requirement: marketplace 候选配置

CLI SHALL 提供 `opendweb marketplace add|list|remove` 维护候选包名 globs，
持久化于用户配置目录；默认值 SHALL 为 `npm:@jixo/opendweb-ext-*, npm:opendweb-*`
（无 scope 命名空间默认开放）。源语法仅支持 `npm:` 协议前缀；未知协议 MUST
以非零退出码报错。声明顺序即后续解析顺序。

#### Scenario: 默认候选集开箱可用

- **WHEN** 全新安装后执行 `opendweb marketplace list`
- **THEN** 输出默认两项 globs（scoped 官方前缀在前、无 scope 在后）

#### Scenario: 未知源协议拒绝

- **WHEN** `opendweb marketplace add "github:foo/bar-*"`
- **THEN** 非零退出并提示仅支持 npm: 源

### Requirement: 自适应子命令解析

对非 builtin 的首个子命令 token，CLI SHALL 按 marketplace 声明序将 globs 中
的 `*` 替换为该 token 生成候选包名，依次尝试加载其 `opendweb-plugin` 子路径
导出；`opendweb use <name> ...` SHALL 为显式等价形，不携带额外语义。首个
import 成功且契约校验通过的候选胜出；**import 成功但清单校验失败 MUST 视为
硬错误**（不得静默跳到下一候选）。全部候选不可解析时 MUST 自愈安装：取首个
候选（声明序即安全梯度——官方 scoped 优先）经用户项目的包管理器安装（过程与
name@version 对用户可见），随后重试解析一次；重试仍失败 MUST 硬错误。设置
`DWEB_NO_AUTO_INSTALL=1` 时 MUST 跳过自愈并报错打印精确的
`opendweb plugin add <name>` 手动指引。builtin 子命令关键字恒优先于自适应解析。

#### Scenario: 零配置调用已安装插件

- **WHEN** `@jixo/opendweb-ext-cf` 已安装且 `opendweb cf status` 执行
- **THEN** 候选按声明序解析到该包并派发 status 命令

#### Scenario: 未安装插件自愈安装（get ?? add）

- **WHEN** 无任何候选可解析 `opendweb echo hello` 且未设置 DWEB_NO_AUTO_INSTALL
- **THEN** CLI 以首个候选（声明序）经用户包管理器安装，输出 installed: name (pkg@version) 与锁定记录，随后重试解析并正常派发

#### Scenario: 自愈关闭时保留手动指引

- **WHEN** `DWEB_NO_AUTO_INSTALL=1` 且无任何候选可解析 `opendweb frp setup`
- **THEN** 非零退出，错误信息包含 `opendweb plugin add frp`，且不产生任何安装痕迹

#### Scenario: 清单不合规为硬错误

- **WHEN** 候选包 `opendweb-plugin` 导出未通过契约 safeParse
- **THEN** 非零退出并输出校验错误详情，不尝试后续候选

### Requirement: 插件 CLI 面契约

插件包 SHALL 通过 `exports["./opendweb-plugin"]` 暴露命令清单模块，其导出
MUST 通过 CLI 的 zod 契约校验：`name`（`[a-z][a-z0-9-]*`，与子命令名一致）、
`apiVersion`（v1 恒 1）、`commands[]`（name/description/args——args 为 JSON
Schema 声明）。CLI SHALL 依据 args 声明统一完成参数解析、校验与 help 生成
（`opendweb <name> --help` 不得执行插件业务代码）。插件执行 SHALL 经统一
包装器：错误归一化、全 ASCII 输出纪律、退出码映射。契约校验是兼容门而非
安全边界——模块顶层代码在 import 时即已执行，信任决策发生在安装时。

#### Scenario: help 零执行生成

- **WHEN** `opendweb cf --help`
- **THEN** 输出基于命令声明的用法说明，未调用任何 run 函数

#### Scenario: 契约版本不匹配

- **WHEN** 插件声明 `apiVersion: 2` 而 CLI 支持至 1
- **THEN** 硬错误并提示版本不兼容

### Requirement: 插件安装管理

CLI SHALL 提供 `opendweb plugin add|get|list|remove`（get 为 add 的同义命令）：
add/get 展示精确 name@version
并锁定于用户配置目录；list 展示已安装与锁定版本；remove 卸除锁定记录。

#### Scenario: 安装锁定

- **WHEN** `opendweb plugin add cf`
- **THEN** 输出实际安装的包名与版本并写入锁定记录
