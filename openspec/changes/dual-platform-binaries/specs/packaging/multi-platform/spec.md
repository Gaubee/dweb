# packaging/multi-platform

## Purpose

定义双平台（darwin-arm64 / windows-x64）二进制的构建、包内布局与运行时平台选择行为。

## ADDED Requirements

### Requirement: 平台产物与包内布局

项目 SHALL 为 darwin-arm64 与 windows-x64 各产出原生二进制：client-sdk 的 `.node` 模块（`dweb.darwin-arm64.node` / `dweb.win32-x64.node`）与 server 可执行文件。npm 包 SHALL 同时携带两平台产物于包内（不依赖安装期下载），并以 `process.platform`-`process.arch` 在加载/启动时选择。

#### Scenario: darwin-arm64 加载

- **WHEN** 在 darwin-arm64 Node 中 require client-sdk
- **THEN** 加载 `dweb.darwin-arm64.node`，全部 SDK 测试通过

#### Scenario: windows-x64 加载

- **WHEN** 在 windows-x64 Node 中 require client-sdk
- **THEN** 加载 `dweb.win32-x64.node`，SDK 生命周期测试通过

### Requirement: CI 双平台门禁

CI SHALL 在各自平台 runner 上构建并测试：windows-x64 job 执行 cargo test（workspace）与 node 测试套件；darwin-arm64 job 维持既有门禁。任一平台红灯即阻塞合并。

#### Scenario: Windows 门禁

- **WHEN** 向 main 推送提交
- **THEN** windows-x64 job 构建 .node 与 server.exe 并运行测试，结果可观测

### Requirement: 不支持平台的明确错误

在既非 darwin-arm64 亦非 windows-x64 的平台加载时，MUST 抛出列出受支持平台的明确错误，而非模糊的动态链接失败。

#### Scenario: linux 加载

- **WHEN** 在 linux-x64 require client-sdk
- **THEN** 错误信息包含支持平台清单
