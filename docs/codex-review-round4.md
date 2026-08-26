# fabric-mvp 四轮快速复核

- 复核提交：`f49b7777291bf6bac5e3083c2cd54b2b7c11014b`（当前 HEAD）
- 上轮评分：6.7/10
- 本轮评分：**7.2/10**（+0.5）

## 核验结果

### 1. 远程 Revoke acceptor 路径：已修复

`session.rs:177-201` 的 `acceptor_hello` 现在只解码事实并返回，不再提前 merge；`fabric.rs:506-540` 统一在 `merge_and_emit` 中做 merge 前后有效成员差集、摘除并关闭失效会话。新增 `remote_revoke_kicks_session_via_acceptor_path` 覆盖 A 撤销 B、A 重新拨号 C、C 作为 acceptor 收到含 Revoke 的 HELLO 后关闭 B 会话并广播 `PeerDisconnected`。该测试实际通过。

### 2. invite 解析 panic：已修复

`protocol.rs:675-721` 在 relay 长度、直连地址计数、地址长度前缀读取前均检查剩余字节；后续固定字段也有长度检查。`malformed_invite_never_panics_only_quarantine` 对固定头逐字节截断并用 `catch_unwind` 断言只返回错误、不 panic，实际通过。当前解析边界未再发现可触发的单字节越界。

### 3. client SDK 类型与显式地址 API：已修复/成立

`index.d.ts:44` 已改为 `on((event: FabricEventJs) => void)`，Rust facade 新增 `add_known_addr` 与 `direct_addr_hints_public`，远端撤销 E2E 使用它们完成无 relay 地址交换。

但类型导出仍未真正闭合：当前 `index.d.ts` 没有 `export interface FabricEventJs` 声明，只有 JSDoc 文本引用；`fix-dts.mjs` 用 `s.includes("FabricEventJs")` 判断是否已注入，正被该注释误判。`pnpm -r typecheck` 未覆盖外部 consumer，因此不能证明公共声明可用。应改为检测 `export interface FabricEventJs`，并加入独立 `tsc --noEmit` consumer fixture。

### 4. server-binary：源码白名单已改，但干净发布仍未闭合

`package.json:27-33` 已把 `bin/dweb-server-aarch64-apple-darwin` 加入 `files`。当前工作树先运行 `scripts/pack.mjs` 后，`npm pack --dry-run` 可看到 6 个文件并包含二进制。

但该二进制仍被根 `.gitignore:11` 忽略，未进入 `f49b777`；CI/test 的 `pack.mjs` 会先在本机生成它，造成假绿。用 `git archive HEAD` 还原干净提交后执行 `npm pack --dry-run --ignore-scripts`，实际只有 5 个文件，没有原生二进制。因此从干净 checkout 直接发布的 npm 包仍不可启动。

**阻塞修复建议：** 在发布前可靠生成并纳入 tarball：增加 `prepack`/发布工作流步骤（并让 CI 在干净 checkout 中执行），或将构建产物作为明确的 release artifact 注入；随后在干净解包目录运行 `startServer()` 和 CLI healthz。不能依赖被 `.gitignore` 忽略的本地残留文件。

## 验证证据

- `cargo test --workspace`：60 个 Rust 测试全绿（fabric 48、integration 4、facade 4、server 4）。
- `pnpm -r typecheck`：通过。
- `pnpm --dir packages/client-sdk test`：3/3 通过。
- `pnpm --dir packages/server-binary test`：1/1 通过，但该脚本会先生成被忽略的二进制；不能替代干净 tarball 验证。
- 当前工作树 `npm pack --dry-run`：6 文件，含二进制；干净 `git archive HEAD`：5 文件，不含二进制。

## 未处置边界与放行判断

帧读取 deadline/流配额、rendezvous nonce、QUIC/UDP relay 数据面、Docker digest/SBOM/provenance、`issued_at_ms` 时钟偏移、`known_addrs` 持久化仍未实现。它们可作为“仅受控成员/可信网络/开发版”的明确 v0.1 边界，但不应宣称公网抗 DoS、完整 UDP relay 或生产供应链保证。Genesis 在空 attach 名册上的“先到先得”信任锚问题也仍需文档化或引入外部根锚。

本轮远程撤销与 invite 解析两项协议/生命周期缺陷已闭合，故从 6.7 上调至 **7.2/10**；server-binary 的干净发布缺陷和 SDK `FabricEventJs` 缺失仍是交付阻塞。修复这两项后，可在上述已知边界内放行 fabric-mvp v0.1；公网/生产发布仍需完成帧资源限制、nonce 与供应链强化。
