# Proposal: hardening-backlog

## Why

v0.2.1 发布后遗留的 P2 质量债与工程杂项，在 Codex 实现复审（R9 放行报告
docs/codex-uxh-impl-review-9.md）中确认为非阻塞但应在合并前持续收口。
另有两个工程效率问题：Windows 二进制依赖手动本地构建（不可持续），
README 主体中文与 EXAMPLE.md 英文不一致（npm 受众混乱）。

## What Changes

### 1. Windows CI 交叉编译（packaging）

- release.yml（或独立 workflow）增加 mingw 交叉编译步骤：每次 tag 自动产出
  `dweb-server-x86_64-pc-windows.exe` + `dweb.win32-x64.node`，替代手动
  本地构建后 in-repo 提交的流程
- 本地验证过的命令链（集成期实证）：`.cargo/config.toml` 已配置
  x86_64-pc-windows-gnu linker；`~/libnode-win/` 的导入库可用

### 2. README 英文化（documentation）

- 主体改英文（与 EXAMPLE.md 一致），中文内容移 `README-zh.md` 交叉链接
- 快速开始段落对齐 v0.2 流程（config set relay → init → chat）

### 3. known_addrs 边界（fabric）

- 加 TTL / 容量上限（当前无界 HashMap）
- 冻结 learned 地址与 custom relay 候选的优先级语义
- 裁决（R2，2026-08-29）：实现取**纯容量 FIFO**（per-endpoint 1024 / 全局
  65536，插入序淘汰），**不实现 TTL**——容量已界定内存上界，TTL 引入时钟
  依赖与测试复杂度、收益低于成本；spec delta（known-addrs-boundary）与实现
  一致

### 4. detached connect task 生命周期（fabric）

- `join_with_deadline` 的 detached connect task 纳入 Fabric shutdown
  可等待集合

### 5. relay_ca_tls API 收口（fabric）

- 当前直接暴露 `iroh_relay::tls::CaTlsConfig`（含 `insecure_skip_verify`）
- 方案：提供 dweb 自有的受限枚举或 feature-gate 为 test-only

### 6. d.ts 契约清洁（sdk）

- `FabricOptions.httpProxy` 改为引用已导出的 `HttpProxyOptions` alias
- 删除或内部化 `HttpProxyUrl`
- 补 TypeScript 消费者编译门禁（`tsc --noEmit` fixture）

### 7. SDK off() 兼容收口（sdk）

- v0.2.1 已加 feature-detect no-op；本 change 移除旧二进制兼容承诺
  （文档声明 v0.2+ 仅支持新二进制），简化 index.js

### 8. activeUrl 提案（fabric + sdk）

- relay-online 事件与 relayStatus() 增加 `activeUrl` 字段（当前只有
  候选数，用户无法知道实际连上的是哪个 relay）
- 内核已有 tie-break 逻辑（配置序最小），暴露到 SDK 即可

### 9. 杂项

- `buildBanner` Local host/port/version 统一 `asciiEscape`
- Rust `primary_non_loopback_ipv4()` 与 JS `networkIPv4s()` 排序规则统一
- `fix-dts.mjs` 从字符串替换迁移到结构化生成（降低 NAPI 格式变化脆弱性）

## Impact

- **涉及代码**：`.github/workflows/`、`README.md`、`crates/dweb-fabric`、
  `packages/client-sdk`、`packages/opendweb`
- **破坏性变更声明（R2 修订）**：
  - Rust 公共 API：`FabricConfig.relay_ca_tls: Option<iroh_relay::tls::CaTlsConfig>`
    收窄为自有枚举 `relay_tls_trust: RelayTlsTrust`（默认 PlatformRoot）——
    下游 Rust 调用方需同步迁移（仓库政策：代码层不做向下兼容胶水；
    JS/npm 面无破坏）。`N0Default + CustomPem` 组合构造期拒绝
  - `RelayStatusSnapshot` 新增 `active_url` 字段（新增面，非破坏）
- **不做**：新功能（Automerge、移动端）——独立 change
