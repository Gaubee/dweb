# packaging/windows-ci

## Purpose

tag push（`v*`）时自动产出 Windows x64 二进制，消除手动本地构建的运维负担。

## ADDED Requirements

### Requirement: CI 交叉编译

release workflow SHALL 包含 mingw 交叉编译 job，在 tag push 时自动构建
`dweb-server-x86_64-pc-windows.exe` 与 `dweb.win32-x64.node`，并作为
release artifacts 上传。构建环境 MUST 可复现（不依赖开发者本机的
`~/libnode-win` 缓存）。

#### Scenario: tag push 产出 Windows 产物

- **WHEN** 推送 `v*` tag
- **THEN** CI 产出 exe 和 dll 并附到 GitHub Release

#### Scenario: 无本地缓存构建

- **WHEN** CI 环境从零开始（无 ~/libnode-win）
- **THEN** 构建流程自行准备导入库并成功编译
