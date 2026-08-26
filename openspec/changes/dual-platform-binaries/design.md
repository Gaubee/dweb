# design — dual-platform-binaries

## D1：Windows 兼容（代码层）

- `roster.rs write_lock`：`libc::flock(LOCK_EX|LOCK_NB)` → `fs4::FileExt::try_lock_exclusive()`（Windows 走 LockFileEx，unix 走 flock；语义一致：有界重试 + 超时报错）。libc 直接依赖移除。
- `secret.rs FileSecretStore::create`：
  - `std::fs::hard_link` 本身跨平台（Windows CreateHardLink，目标存在报 AlreadyExists）——放开给全平台；
  - `restrict_permissions`：unix 0600；Windows 无同等文件权限模型 → 文档化降级（宿主/目录 ACL 负责），不再返回 Unsupported；
  - `fsync_dir`：unix 保留；Windows 上目录句柄 sync 不可移植 → no-op（NTFS 元数据日志由 OS 保证 rename 持久化的实际风险窗口可接受，标注边界）。
- CI 之前以 `cargo check --target x86_64-pc-windows-msvc`（本地无需 linker）静态验证 cfg 正确性。

## D2：瘦身（先实测再定档）

当前 client-sdk `.node` = 14.5MB（`__text` 10.3MB 真实代码，strip 已生效）。措施按序尝试，逐项记录实测：

1. `[profile.release]` 升级：`lto = "fat"`, `codegen-units = 1`, `opt-level = "z"`（`panic` 保持 unwind——napi 依赖 catch_unwind 语义）。
2. iroh feature 面收窄（按 1.1.0 实际 feature 清单裁剪未用项，保留 presets::N0 所需）。
3. 若仍 >10MB：接受并在 README 如实标注（功能完整优先于体积）。

server 同 profile 收益同步记录。

## D3：包结构（双平台直载，无安装期下载）

```text
packages/client-sdk/
├─ index.js                # 按 platform-arch 选 require 目标（私有 tmp 拷贝策略不变）
├─ index.d.ts
├─ dweb.darwin-arm64.node
└─ dweb.win32-x64.node
packages/server-binary/
├─ index.js / bin/*.mjs    # 按 platform-arch 选 exe
└─ bin/dweb-server-{aarch64-apple-darwin, x86_64-pc-windows-msvc.exe}[.exe]
```

- `os`/`cpu` 字段放开（双产物在包内）；不支持平台 → 明确错误（列支持清单）。
- napi CLI 的 `--no-js` 产物命名保持 `dweb.<target-triple>.node`，由 CI windows job 产出 `dweb.win32-x64.node`（napi 的 npm 命名），本地 darwin 产出 arm64。
- files 白名单同步扩为双产物。

## D4：CI

- `ci.yml` 增加 `windows-test` job（windows-latest）：rustup stable → cargo test --workspace → napi build --target x86_64-pc-windows-msvc → pnpm test（client-sdk/opendweb/example/server-binary）→ 产物上传 artifact（.node + server.exe）。
- 既有 macos-14 `node-build` 保持；rust-test(linux) 增加 `--target x86_64-pc-windows-msvc` 的 cargo check（cfg 静态验证，无需 MSVC linker）。
