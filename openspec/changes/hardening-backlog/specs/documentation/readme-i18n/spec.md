# documentation/readme-i18n

## Purpose

README 主体英文（与 EXAMPLE.md 一致），中文版独立文件交叉链接。

## ADDED Requirements

### Requirement: 英文主 README

README.md SHALL 以英文为主体，快速开始段落对齐 v0.2 流程
（`config set relay` → `init` → `chat`，不出现手动 `export DWEB_RELAY`）。
SHALL 另提供 `README-zh.md` 中文版，两者头部交叉链接。

#### Scenario: npm 受众阅读

- **WHEN** 开发者从 npm 到达 GitHub 仓库
- **THEN** README.md 为英文，快速开始可直接复制执行
