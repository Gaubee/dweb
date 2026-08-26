# dual-platform-binaries

## Why

体验与分发需要 windows-x64 与 darwin-arm64 双平台二进制（Owner 指令）。当前仅 darwin-arm64；且 client-sdk 实测 14.5MB（tarball 6.1MB），需在双平台交付的同时做体积瘦身。

## What Changes

- 内核 Windows 兼容：`flock` 换跨平台文件锁（fs4）；`FileSecretStore::create` 的 hard_link/fsync_dir/权限按平台 cfg（Windows 无 unix 权限模型，降级为文档化边界）。
- 构建与 CI：GitHub Actions 增加 windows-x64 job（cargo test + napi build + server build + node 测试）；darwin-arm64 保持现有 job。
- npm 包结构：client-sdk / server-binary 主包直接携带双平台二进制（`dweb.darwin-arm64.node` + `dweb.win32-x64.node`；server 双 exe），loader/入口按 `process.platform` 选择；放开 `os/cpu` 限制。
- 体积瘦身：release profile 升级（fat LTO + codegen-units=1 + opt-level=z）并收窄 iroh feature 面；以实测数字记录进 design。

## Capabilities

### New Capabilities
- `packaging/multi-platform`: 双平台二进制的构建、包内布局与平台选择行为。

### Modified Capabilities
- `fabric/secret-store`: FileSecretStore 的平台差异语义（Windows 无 0600/hard-link 父目录 fsync 的降级边界）。

## Impact

- `crates/dweb-fabric`（roster 锁、secret store cfg）、`packages/client-sdk`、`packages/server-binary`、`packages/opendweb`、`.github/workflows`。
- 依赖新增 fs4（跨平台文件锁）；libc 直接依赖移除。
- 体积预期：瘦身 profile 后 client-sdk 明显小于 14.5MB，实测数字写入 README。
