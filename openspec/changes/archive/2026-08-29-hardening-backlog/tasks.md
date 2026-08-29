# Tasks: hardening-backlog

> 子代理约束同前：不 commit/push、不动共享资源、只跑定向测试。

## 1. Windows CI 交叉编译

- [x] 1.1 release.yml（或 build-windows.yml）加 mingw 交叉编译 job：
      `cargo build --release --target x86_64-pc-windows-gnu -p dweb-server`
      + `-p dweb-client-sdk`（需 `LIBNODE_PATH=$HOME/libnode-win`——CI 中
      从源码重建或缓存导入库）
- [x] 1.2 产物上传到 release artifacts 并在 publish 前替换 in-repo 旧文件
- [x] 1.3 验证 tag push 后 CI 产出的 exe/dll 与本地 mingw 构建等价

## 2. README 英文化

- [x] 2.1 README.md 主体英文重写（快速开始对齐 v0.2 config 流程）
- [x] 2.2 中文内容移 README-zh.md，头部交叉链接
- [x] 2.3 移除过时的 DWEB_RELAY 手动 export 说明

## 3. known_addrs 边界

- [x] 3.1 容量上限（如 1024 entries）+ 淘汰策略
- [x] 3.2 冻结 learned 与 custom relay 优先级语义进 spec

## 4. detached connect task

- [x] 4.1 join_with_deadline 的 connect task 纳入 shutdown 可等待集合

## 5. relay_ca_tls API

- [x] 5.1 设计受限抽象（如 `RelayTlsTrust::PlatformRoot | CustomPem(Vec<u8>)`）
      或 feature-gate `test-relay-tls`
- [x] 5.2 更新 relay_watch 集成测试适配新 API

## 6. d.ts 契约

- [x] 6.1 FabricOptions.httpProxy 引用 HttpProxyOptions alias
- [x] 6.2 删除 HttpProxyUrl 或标记 internal
- [x] 6.3 补 `tsc --noEmit` 消费者 fixture（test/types.test.ts）

## 7. SDK off() 兼容

- [x] 7.1 文档声明 v0.2+ 仅支持新二进制；index.js 简化（可去掉 no-op 分支
      保留 feature-detect 但去掉注释中的"旧二进制兼容"承诺）

## 8. activeUrl

- [x] 8.1 内核 RelayStatusSnapshot 增加 active_url: Option<String>
      （tie-break 已有：配置序最小已连接 relay）
- [x] 8.2 SDK relayStatus()/relay-* 事件 payload 增加 activeUrl
- [x] 8.3 example chat 显示 `relay: online (<activeUrl>)` 替代候选数
- [x] 8.4 C0 契约与 d.ts 同步

## 9. 杂项

- [x] 9.1 buildBanner Local 动态值 asciiEscape
- [x] 9.2 Rust/JS IPv4 排序统一（或 D1 明确二者可不同）
- [x] 9.3 fix-dts.mjs 结构化生成（AST 或模板）

## 10. 门禁

- [x] 10.1 全量 cargo test/clippy + JS 四包 + e2e
- [x] 10.2 Codex 复审
