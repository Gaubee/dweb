# sdk/dts-contract-hygiene Specification

## Purpose
index.d.ts 的 FabricOptions.httpProxy 内联联合类型（未引用已导出的
HttpProxyOptions alias），且保留多余的 HttpProxyUrl 导出——TypeScript
消费者无法按权威契约导入公共别名。

## Requirements

### Requirement: alias 引用与唯一声明

FabricOptions.httpProxy SHALL 引用 `HttpProxyOptions` alias（不再内联）。
`HttpProxyUrl` SHALL 删除或标记 internal（加 JSDoc @internal）。
SHALL 增加 TypeScript 消费者编译门禁（最小 fixture + `tsc --noEmit`）。

#### Scenario: 消费者导入别名

- **WHEN** TypeScript 项目 `import { HttpProxyOptions } from "@jixo/opendweb-client-sdk"`
- **THEN** 类型正确导出且 FabricOptions.httpProxy 引用同一类型

#### Scenario: 编译门禁

- **WHEN** CI 运行 SDK 包测试
- **THEN** tsc --noEmit 对消费者 fixture 编译通过
