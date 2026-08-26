# secret-store-abstraction 设计评审任务书

你是 dweb 项目（/Volumes/dweb，Rust+TS monorepo，OpenSpec 驱动）的设计评审。对新 change "secret-store-abstraction" 做设计展开讨论与评审。

## 背景（Owner 定位纠正）

dweb 追求**去中心**（无不可替代控制点、用户主权），**不是去云**。产品可能：账号系统加密托管用户设备 key（Bitwarden 模式，丢了可恢复）、Keychain 存储、甚至产品代管。内核不得预设信任模型。此前实现把 identity/roster/invites 绑死在 dataDir 文件路径上。

## 必读信源（按序）

1. `openspec/changes/secret-store-abstraction/{proposal.md,design.md,tasks.md,specs/}`（本 change 全部工件）
2. `crates/dweb-fabric/src/identity.rs`（现有文件行为：0600/原子写/损坏报错）
3. `crates/dweb-fabric/src/fabric.rs` 的 `FabricConfig`（dataDir 现状）
4. `docs/codex-review-round4.md`（当前质量基线 7.2/10）

## 设计初稿（欢迎推翻）

- `SecretStore` 同步 trait（exists/load/store），对象安全；`FileSecretStore` 默认实现收敛现行为（零迁移）
- `with_seed` 注入：零存储副作用
- secret-export：`dwebkey1.` + base64url(magic|ver|argon2id 参数|salt|nonce|ChaCha20-Poly1305(seed))，Argon2id m=19456KiB t=2 p=1，参数入头、AAD 域分离、版本化
- `FabricConfig.secret: Default(dataDir)|Seed|Store`；roster 目录与 secret 解耦
- out of scope：云端 FactStore、可插拔 InviteLog、JS store 回调、Automerge Adapter
- CAS 拓扑约束（单次兑换需线性化决策点）写入文档为部署知识

## 请输出

1. 对初稿的逐项批判：trait 形状（同步 vs async？对象安全？错误类型设计？）；export 格式（KDF/AEAD 选型论证、参数固化 vs 协商、是否需要 key rotation / 多接收方？）；FabricConfig 注入形状（枚举 vs 平铺字段？）；SDK 面（明文 hex seed 过 JS 的暴露面是否需要缓冲？）
2. 你认为缺失的设计点（例：export 是否应包含 fabric_id 供校验？seed 注入时 roster 与 identity 不一致的语义？FileSecretStore 权限语义在非 unix 平台？）
3. 与 open2fa 既有 Encrypted Export 决策的同构/冲突检查（open2fa 仓库不在本目录，按你对其设计意图的理解陈述，标注不确定处）
4. 你修订后的完整设计（可直接抄进 design.md 的级别）
5. 评分（0-10）与阻塞项

## 要求

- 结论基于你核实的一手信源（crates.io / docs.rs / RFC 9106 / OWASP Argon2 参数建议），不确定的明确标注
- 完整报告写入 `/Volumes/dweb/docs/codex-secretstore-design.md`（中文）
- 最后回复一句"报告已写入 + 评分"
