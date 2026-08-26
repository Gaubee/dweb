//! 私钥存储抽象与加密身份导出（secret-store-abstraction change）。
//!
//! # 信任模型中立（Owner 定位纠正，2026-08-26）
//!
//! dweb 追求**去中心**（无不可替代控制点、用户主权），不是去云。内核不规定
//! secret 的存放位置与信任模型——本地文件（[`FileSecretStore`]，默认）、系统安全
//! 存储、加密托管（产品账号存 [`export_secret`] 的密文，解密能力在用户口令）、
//! 产品代管（明文，产品自担），都是 [`SecretStore`] 的实现方。内核只要求：
//! 读写语义正确（原子 create-if-absent、完整性校验），注入/导出显式可审计。
//!
//! 同步 trait 的契约边界：实现**不得进行未界定的网络阻塞**（Tokio worker 上执
//! 行）；远端托管应在产品层解密为一次性 seed 后走 `Seed` 注入。
//!
//! # CAS 拓扑约束（部署知识，非 SDK 禁令）
//!
//! 单次兑换（invites.consumed）的正确性 = 一次 redeem 在**一个线性化决策点**
//! 完成 verify 后 consume。本地同目录 flock 是 v0.1 实现；产品把 redeem 路由到
//! 自有后端则天然单点。不成立的组合：多执行位置 + 最终一致存储。自定义
//! SecretStore 不会自动给 invites.consumed 提供 CAS。
//!
//! # 身份导出格式 v1（codex 设计评审后修订）
//!
//! ```text
//! "dwebkey1." + base64url_nopad(
//!     magic b"dweb/key/v1\0" | version u8(=1) | kdf_id u8(=1 Argon2id)
//!     | m_cost u32 BE | t_cost u32 BE | p_cost u32 BE
//!     | salt[16] | nonce[12] | AEAD(seed[32]) || tag[16]
//! )
//! ```
//!
//! - KDF：Argon2id（RFC 9106）。v1 固化 m=19456 KiB、t=2、p=1 —— 这是 OWASP
//!   密码存储下限（跨端兼容档），**不是** RFC 9106 首选档；产品层应另行基准与
//!   口令策略。导入**只接受精确已知参数**（防参数头部 DoS），参数升级走新版本号。
//! - AEAD：ChaCha20-Poly1305（RFC 8439），nonce 每次随机、同 key 不复用；
//!   AAD = `b"dweb/key/aad\0" || header || salt || nonce`（全部 metadata 显式认证）。
//! - 本 token 是**身份导出**（identity export）：只含 seed，不含 roster/facts/
//!   invites。完整 fabric 快照是另一个待立 change，不得混称"恢复 fabric"。
//! - 口令按 UTF-8 原样（无 Unicode 规范化）；空口令拒绝，上限 1024 字节。

use std::path::{Path, PathBuf};

use argon2::Algorithm::Argon2id;
use argon2::{Argon2, Params, ParamsBuilder};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use thiserror::Error;
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::identity::{NodeIdentity, SEED_LEN};

/// File name of the persisted seed inside the data directory.
pub const KEY_FILE_NAME: &str = "identity.key";

// ---- wire 常量（v1） --------------------------------------------------------
const MAGIC: &[u8] = b"dweb/key/v1\0";
const VERSION: u8 = 1;
const KDF_ARGON2ID: u8 = 1;
/// v1 唯一允许的参数组合（OWASP 下限档）。导入按精确值校验，防头部 DoS。
const V1_M_KIB: u32 = 19_456;
const V1_T: u32 = 2;
const V1_P: u32 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
/// magic(12) + ver(1) + kdf_id(1) + m(4) + t(4) + p(4)
const HEADER_LEN: usize = 26;
/// header + salt + nonce + seed + tag
const BLOB_LEN: usize = HEADER_LEN + SALT_LEN + NONCE_LEN + SEED_LEN + TAG_LEN;
/// `dwebkey1.` 前缀 + base64(102B) ≈ 141 字符；导入侧的输入长度硬上限。
const MAX_TOKEN_CHARS: usize = 256;
const MAX_PASSPHRASE_BYTES: usize = 1024;
const AAD_DOMAIN: &[u8] = b"dweb/key/aad\0";

pub const EXPORT_PREFIX: &str = "dwebkey1.";

/// 受保护的 32B 身份种子。`Debug` 恒为 `[REDACTED]`，drop 时清零。
/// （有 Drop 故不能 Copy；克隆即多一份受同样清零保护的材料。）
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
#[repr(transparent)]
pub struct SecretSeed([u8; SEED_LEN]);

impl SecretSeed {
    pub fn from_bytes(bytes: [u8; SEED_LEN]) -> Self {
        Self(bytes)
    }

    pub fn as_bytes(&self) -> &[u8; SEED_LEN] {
        &self.0
    }

    /// 派生 EndpointId（轻量视图，不持有签名能力）。
    pub fn endpoint_id(&self) -> crate::identity::EndpointId {
        NodeIdentity::from_seed(self.0).endpoint_id()
    }
}

impl std::fmt::Debug for SecretSeed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[REDACTED]")
    }
}

/// SecretStore 实现与导出/导入的错误。错误文本绝不包含 seed/passphrase。
#[derive(Debug, Error)]
pub enum SecretStoreError {
    #[error("secret store {path} corrupted: {reason}")]
    Corrupted { path: PathBuf, reason: String },
    #[error("failed to read secret store {path}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to write secret store {path}: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    /// `create` 时存储中已有身份（insert-if-absent 语义）。
    #[error("secret store {path} already has an identity")]
    Conflict { path: PathBuf },
    /// 平台无法满足安全契约（如非 Unix 的文件权限原子创建）。
    #[error("unsupported secret store operation: {0}")]
    Unsupported(String),
    /// 自定义实现的错误（网络 Keychain/托管后端等）。
    #[error("secret store error: {0}")]
    Custom(String),
}

/// 加密身份导出/导入错误。任何畸形输入都落到这里，绝不 panic；
/// 错误口令与篡改统一为不可区分的 [`SecretExportError::Auth`]。
#[derive(Debug, Error)]
pub enum SecretExportError {
    #[error("bad export format: {0}")]
    Format(String),
    #[error("unsupported export version {0}")]
    Version(u8),
    #[error("kdf failed: {0}")]
    Kdf(String),
    #[error("wrong passphrase or tampered ciphertext")]
    Auth,
    #[error(transparent)]
    Base64(#[from] base64::DecodeError),
}

/// 节点私钥的存储抽象：内核不规定实现（文件/Keychain/托管后端均合法）。
///
/// 契约（codex 设计评审）：
/// - `load`：`None` 表示后端确认不存在；权限/网络/损坏必须是错误，不得折叠成
///   `None` 或部分数据。
/// - `create`：**线性化 insert-if-absent**，已有身份返回
///   [`SecretStoreError::Conflict`]，绝不静默覆盖。原子性由实现保证。
/// - 同步实现不得做未界定的网络阻塞（见模块文档）。
pub trait SecretStore: Send + Sync + 'static {
    fn load(&self) -> Result<Option<SecretSeed>, SecretStoreError>;
    fn create(&self, seed: &SecretSeed) -> Result<(), SecretStoreError>;
}

/// 默认实现：`<dir>/identity.key`，32B seed，unix 0600；create 采用
/// 唯一 tmp + fsync + `link(2)`（存在即 Conflict 的原子 insert-if-absent）
/// + 父目录 fsync。fabric-mvp 既有布局零迁移。
pub struct FileSecretStore {
    path: PathBuf,
}

impl FileSecretStore {
    pub fn new(dir: &Path) -> Self {
        Self {
            path: dir.join(KEY_FILE_NAME),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl SecretStore for FileSecretStore {
    fn load(&self) -> Result<Option<SecretSeed>, SecretStoreError> {
        match std::fs::read(&self.path) {
            Ok(bytes) => {
                if bytes.len() != SEED_LEN {
                    return Err(SecretStoreError::Corrupted {
                        path: self.path.clone(),
                        reason: format!(
                            "expected {SEED_LEN} bytes of Ed25519 seed, found {}",
                            bytes.len()
                        ),
                    });
                }
                let seed: [u8; SEED_LEN] =
                    bytes.as_slice().try_into().expect("length checked above");
                Ok(Some(SecretSeed::from_bytes(seed)))
            }
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(source) => Err(SecretStoreError::Read {
                path: self.path.clone(),
                source,
            }),
        }
    }

    fn create(&self, seed: &SecretSeed) -> Result<(), SecretStoreError> {
        #[cfg(unix)]
        {
            let dir = self.path.parent().unwrap_or(Path::new("."));
            std::fs::create_dir_all(dir).map_err(|source| SecretStoreError::Write {
                path: dir.to_path_buf(),
                source,
            })?;
            // 唯一临时名（pid + 原子计数器）+ create_new：同进程多线程也绝不互踩
            static TMP_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let tmp = dir.join(format!(
                "{}.{}.{}.tmp",
                KEY_FILE_NAME,
                std::process::id(),
                TMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&tmp)
                .map_err(|source| SecretStoreError::Write {
                    path: tmp.clone(),
                    source,
                })?;
            restrict_permissions(&tmp)?;
            std::io::Write::write_all(&mut file, seed.as_bytes()).map_err(|source| {
                SecretStoreError::Write {
                    path: tmp.clone(),
                    source,
                }
            })?;
            file.sync_all().map_err(|source| SecretStoreError::Write {
                path: tmp.clone(),
                source,
            })?;
            drop(file);
            // link(2)：目标已存在则 EEXIST => Conflict；成功即原子 insert-if-absent
            let linked = std::fs::hard_link(&tmp, &self.path);
            let _ = std::fs::remove_file(&tmp); // 清理临时文件（崩溃残留无害）
            match linked {
                Ok(()) => {
                    fsync_dir(dir)?;
                    Ok(())
                }
                Err(source) if source.kind() == std::io::ErrorKind::AlreadyExists => {
                    Err(SecretStoreError::Conflict {
                        path: self.path.clone(),
                    })
                }
                Err(source) => Err(SecretStoreError::Write {
                    path: self.path.clone(),
                    source,
                }),
            }
        }
        #[cfg(not(unix))]
        {
            let _ = seed;
            Err(SecretStoreError::Unsupported(
                "FileSecretStore::create requires unix atomic link semantics".into(),
            ))
        }
    }
}

/// 载入身份；无身份则生成新身份并 `create`。并发下恰好一方 create 成功，
/// 冲突方回读复用胜者的身份（身份不分叉）。
pub fn ensure_with(store: &dyn SecretStore) -> Result<NodeIdentity, SecretStoreError> {
    if let Some(seed) = store.load()? {
        return Ok(NodeIdentity::from_seed(*seed.as_bytes()));
    }
    let identity = NodeIdentity::generate();
    let seed = SecretSeed::from_bytes(identity.seed());
    match store.create(&seed) {
        Ok(()) => Ok(identity),
        Err(SecretStoreError::Conflict { .. }) => match store.load()? {
            Some(winner) => Ok(NodeIdentity::from_seed(*winner.as_bytes())),
            None => Err(SecretStoreError::Custom(
                "conflict on create but load found nothing".into(),
            )),
        },
        Err(e) => Err(e),
    }
}

/// 以口令导出**身份**为 `dwebkey1.` 自包含字符串（显式操作，不触碰任何存储）。
pub fn export_secret(
    identity: &NodeIdentity,
    passphrase: &str,
) -> Result<String, SecretExportError> {
    validate_passphrase(passphrase)?;
    let salt = crate::protocol::random_bytes::<SALT_LEN>();
    let mut key = derive_key(passphrase, &salt)?;
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&key));
    let nonce_bytes = crate::protocol::random_bytes::<NONCE_LEN>();
    let nonce = Nonce::from_slice(&nonce_bytes);

    let mut header = Vec::with_capacity(HEADER_LEN);
    header.extend_from_slice(MAGIC);
    header.push(VERSION);
    header.push(KDF_ARGON2ID);
    header.extend_from_slice(&V1_M_KIB.to_be_bytes());
    header.extend_from_slice(&V1_T.to_be_bytes());
    header.extend_from_slice(&V1_P.to_be_bytes());

    // AAD 覆盖全部 metadata（域常量 + header + salt + nonce）
    let mut aad = AAD_DOMAIN.to_vec();
    aad.extend_from_slice(&header);
    aad.extend_from_slice(&salt);
    aad.extend_from_slice(&nonce_bytes);

    let mut seed_bytes = identity.seed();
    let ciphertext = cipher
        .encrypt(
            nonce,
            Payload {
                msg: &seed_bytes,
                aad: &aad,
            },
        )
        .map_err(|_| SecretExportError::Kdf("aead encrypt failed".into()));
    seed_bytes.zeroize();
    key.zeroize();
    let ciphertext = ciphertext?;
    let mut blob = header;
    blob.extend_from_slice(&salt);
    blob.extend_from_slice(&nonce_bytes);
    blob.extend_from_slice(&ciphertext);
    debug_assert_eq!(blob.len(), BLOB_LEN);
    Ok(format!("{EXPORT_PREFIX}{}", URL_SAFE_NO_PAD.encode(blob)))
}

/// 导入 `dwebkey1.` 身份导出串，返回受保护的 [`SecretSeed`]（不落盘——落盘
/// 与否由调用方经 SecretStore 的 `create` 显式决定，绝不隐式覆盖既有身份）。
pub fn import_secret(s: &str, passphrase: &str) -> Result<SecretSeed, SecretExportError> {
    validate_passphrase(passphrase)?;
    if s.len() > MAX_TOKEN_CHARS {
        return Err(SecretExportError::Format(format!(
            "token longer than {MAX_TOKEN_CHARS} chars"
        )));
    }
    let rest = s
        .strip_prefix(EXPORT_PREFIX)
        .ok_or_else(|| SecretExportError::Format(format!("missing {EXPORT_PREFIX} prefix")))?;
    let blob = URL_SAFE_NO_PAD.decode(rest)?;
    if blob.len() != BLOB_LEN {
        return Err(SecretExportError::Format(format!(
            "blob length {} != expected {BLOB_LEN}",
            blob.len()
        )));
    }
    // 派生前完成全部结构性校验（定长已保证索引安全）
    if &blob[..MAGIC.len()] != MAGIC {
        return Err(SecretExportError::Format("bad magic".into()));
    }
    let version = blob[MAGIC.len()];
    if version != VERSION {
        return Err(SecretExportError::Version(version));
    }
    let kdf_id = blob[MAGIC.len() + 1];
    if kdf_id != KDF_ARGON2ID {
        return Err(SecretExportError::Format(format!(
            "unknown kdf id {kdf_id}"
        )));
    }
    let m = u32::from_be_bytes(blob[14..18].try_into().expect("len 4"));
    let t = u32::from_be_bytes(blob[18..22].try_into().expect("len 4"));
    let p = u32::from_be_bytes(blob[22..26].try_into().expect("len 4"));
    // v1 只接受精确已知参数：防不可信头部触发任意大的 Argon2 资源分配
    if (m, t, p) != (V1_M_KIB, V1_T, V1_P) {
        return Err(SecretExportError::Format(format!(
            "unsupported v1 kdf params m={m} t={t} p={p}"
        )));
    }

    let salt: [u8; SALT_LEN] = blob[HEADER_LEN..HEADER_LEN + SALT_LEN]
        .try_into()
        .expect("len 16");
    let nonce: [u8; NONCE_LEN] = blob[HEADER_LEN + SALT_LEN..HEADER_LEN + SALT_LEN + NONCE_LEN]
        .try_into()
        .expect("len 12");
    let ct_and_tag = &blob[HEADER_LEN + SALT_LEN + NONCE_LEN..];

    let mut key = derive_key(passphrase, &salt)?;
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&key));
    let mut aad = AAD_DOMAIN.to_vec();
    aad.extend_from_slice(&blob[..HEADER_LEN]);
    aad.extend_from_slice(&salt);
    aad.extend_from_slice(&nonce);
    let plaintext = cipher.decrypt(
        Nonce::from_slice(&nonce),
        Payload {
            msg: ct_and_tag,
            aad: &aad,
        },
    );
    key.zeroize();
    let mut plaintext = plaintext.map_err(|_| SecretExportError::Auth)?;
    let seed: [u8; SEED_LEN] = plaintext
        .as_slice()
        .try_into()
        .map_err(|_| SecretExportError::Format("plaintext length".into()))?;
    plaintext.zeroize();
    Ok(SecretSeed::from_bytes(seed))
}

fn validate_passphrase(passphrase: &str) -> Result<(), SecretExportError> {
    if passphrase.is_empty() {
        return Err(SecretExportError::Format("empty passphrase".into()));
    }
    if passphrase.len() > MAX_PASSPHRASE_BYTES {
        return Err(SecretExportError::Format(format!(
            "passphrase longer than {MAX_PASSPHRASE_BYTES} bytes"
        )));
    }
    Ok(())
}

fn derive_key(passphrase: &str, salt: &[u8; SALT_LEN]) -> Result<[u8; 32], SecretExportError> {
    let params: Params = ParamsBuilder::new()
        .m_cost(V1_M_KIB)
        .t_cost(V1_T)
        .p_cost(V1_P)
        .build()
        .map_err(|e| SecretExportError::Kdf(format!("bad params: {e}")))?;
    let argon = Argon2::new(Argon2id, argon2::Version::V0x13, params);
    let mut out = [0u8; 32];
    argon
        .hash_password_into(passphrase.as_bytes(), salt, &mut out)
        .map_err(|e| SecretExportError::Kdf(format!("argon2: {e}")))?;
    Ok(out)
}

#[cfg(unix)]
fn fsync_dir(dir: &Path) -> Result<(), SecretStoreError> {
    let f = std::fs::File::open(dir).map_err(|source| SecretStoreError::Write {
        path: dir.to_path_buf(),
        source,
    })?;
    f.sync_all().map_err(|source| SecretStoreError::Write {
        path: dir.to_path_buf(),
        source,
    })
}

/// Marks `path` as readable/writable by the current user only (unix)。
/// 非 Unix 平台无同等文件权限契约，`create` 整体返回 Unsupported（fail-closed）。
#[cfg(unix)]
fn restrict_permissions(path: &Path) -> Result<(), SecretStoreError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(|source| {
        SecretStoreError::Write {
            path: path.to_path_buf(),
            source,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// 内存 SecretStore：验证"内核全程经抽象、零文件副作用 + create 冲突语义"。
    #[derive(Default)]
    struct MemoryStore {
        inner: Mutex<Option<SecretSeed>>,
    }

    impl SecretStore for MemoryStore {
        fn load(&self) -> Result<Option<SecretSeed>, SecretStoreError> {
            Ok(self.inner.lock().unwrap().clone())
        }
        fn create(&self, seed: &SecretSeed) -> Result<(), SecretStoreError> {
            let mut g = self.inner.lock().unwrap();
            if g.is_some() {
                return Err(SecretStoreError::Conflict {
                    path: PathBuf::from("memory"),
                });
            }
            *g = Some(seed.clone());
            Ok(())
        }
    }

    #[test]
    fn memory_store_ensure_creates_once_and_conflicts() {
        let store = MemoryStore::default();
        let a = ensure_with(&store).unwrap();
        assert!(matches!(
            store.create(&SecretSeed::from_bytes([1u8; 32])),
            Err(SecretStoreError::Conflict { .. })
        ));
        let b = ensure_with(&store).unwrap();
        assert_eq!(a.endpoint_id(), b.endpoint_id());
    }

    #[test]
    fn concurrent_file_create_exactly_one_wins() {
        let dir = tempfile::tempdir().unwrap();
        let s1 = FileSecretStore::new(dir.path());
        let s2 = FileSecretStore::new(dir.path());
        let (r1, r2) = std::thread::scope(|s| {
            let h1 = s.spawn(|| s1.create(&SecretSeed::from_bytes([2u8; 32])));
            let h2 = s.spawn(|| s2.create(&SecretSeed::from_bytes([3u8; 32])));
            (h1.join().unwrap(), h2.join().unwrap())
        });
        assert!(r1.is_ok() || r2.is_ok());
        // 失败方必须是 Conflict（原子 insert-if-absent），且恰一胜
        let (wins, conflicts): (usize, usize) = [&r1, &r2]
            .iter()
            .map(|r| match r {
                Ok(()) => (1, 0),
                Err(SecretStoreError::Conflict { .. }) => (0, 1),
                Err(e) => panic!("unexpected non-conflict error: {e:?}"),
            })
            .fold((0, 0), |a, b| (a.0 + b.0, a.1 + b.1));
        assert_eq!((wins, conflicts), (1, 1), "exactly one win, one conflict");
        // 胜者 seed 与最终落盘内容完全一致（身份不分叉）
        let winner = FileSecretStore::new(dir.path()).load().unwrap().unwrap();
        let expected = if r1.is_ok() { [2u8; 32] } else { [3u8; 32] };
        assert_eq!(winner.as_bytes(), &expected);
    }

    #[test]
    fn file_store_zero_migration_from_legacy_layout() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(KEY_FILE_NAME), [7u8; SEED_LEN]).unwrap();
        let store = FileSecretStore::new(dir.path());
        let id = ensure_with(&store).unwrap();
        assert_eq!(id.seed(), [7u8; SEED_LEN]);
    }

    #[test]
    fn file_store_corrupted_reports_path() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(KEY_FILE_NAME), b"short").unwrap();
        let store = FileSecretStore::new(dir.path());
        let err = store.load().unwrap_err();
        assert!(err.to_string().contains(KEY_FILE_NAME));
        assert!(matches!(err, SecretStoreError::Corrupted { .. }));
    }

    #[cfg(unix)]
    #[test]
    fn file_store_permissions_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let store = FileSecretStore::new(dir.path());
        store
            .create(&SecretSeed::from_bytes([1u8; SEED_LEN]))
            .unwrap();
        let mode = std::fs::metadata(store.path())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn export_import_roundtrip_restores_identity() {
        let id = NodeIdentity::from_seed([5u8; SEED_LEN]);
        let token = export_secret(&id, "correct horse").unwrap();
        assert!(token.starts_with(EXPORT_PREFIX));
        let seed = import_secret(&token, "correct horse").unwrap();
        assert_eq!(seed.endpoint_id(), id.endpoint_id());
    }

    #[test]
    fn wrong_passphrase_is_auth_failure() {
        let id = NodeIdentity::generate();
        let token = export_secret(&id, "aaa").unwrap();
        assert!(matches!(
            import_secret(&token, "bbb"),
            Err(SecretExportError::Auth)
        ));
    }

    /// 头部区（0..HEADER_LEN）篡改：在 Argon2 派生**之前**被结构性校验拒绝——
    /// 逐字节遍历是纯格式检查，无 KDF 成本（防参数 DoS 的关键性质）。
    #[test]
    fn header_tamper_rejected_before_kdf() {
        let id = NodeIdentity::generate();
        let token = export_secret(&id, "pp").unwrap();
        let blob = URL_SAFE_NO_PAD
            .decode(token.strip_prefix(EXPORT_PREFIX).unwrap())
            .unwrap();
        for i in 0..HEADER_LEN {
            let mut t = blob.clone();
            t[i] ^= 0x01;
            let s = format!("{EXPORT_PREFIX}{}", URL_SAFE_NO_PAD.encode(&t));
            let r = import_secret(&s, "pp");
            assert!(r.is_err(), "header tamper {i} must be rejected");
            assert!(
                matches!(
                    r,
                    Err(SecretExportError::Format(_)) | Err(SecretExportError::Version(_))
                ),
                "header tamper {i} should fail structurally, got {r:?}"
            );
        }
    }

    /// 密文区篡改：抽样位置（每处一次 Argon2，总量有界——不逐字节全跑 KDF）。
    #[test]
    fn ciphertext_tamper_sampled_auth_failures() {
        let id = NodeIdentity::generate();
        let token = export_secret(&id, "pp").unwrap();
        let blob = URL_SAFE_NO_PAD
            .decode(token.strip_prefix(EXPORT_PREFIX).unwrap())
            .unwrap();
        let samples = [
            HEADER_LEN,                        // salt 首
            HEADER_LEN + SALT_LEN,             // nonce 首
            HEADER_LEN + SALT_LEN + NONCE_LEN, // ct 首
            BLOB_LEN - 1,                      // tag 尾
            BLOB_LEN / 2,                      // 中部
        ];
        for &i in &samples {
            let mut t = blob.clone();
            t[i] ^= 0x01;
            let s = format!("{EXPORT_PREFIX}{}", URL_SAFE_NO_PAD.encode(&t));
            let r = std::panic::catch_unwind(|| import_secret(&s, "pp"));
            assert!(r.is_ok(), "no panic at tamper {i}");
            assert!(
                matches!(r.unwrap(), Err(SecretExportError::Auth)),
                "tamper {i}"
            );
        }
    }

    /// 畸形参数（结构合法但非 v1 精确值）：必须在派生前以 Format 拒绝，
    /// 绝不进入 Argon2（防大参数资源分配）。
    #[test]
    fn malicious_kdf_params_rejected_before_derivation() {
        let id = NodeIdentity::generate();
        let token = export_secret(&id, "pp").unwrap();
        let mut blob = URL_SAFE_NO_PAD
            .decode(token.strip_prefix(EXPORT_PREFIX).unwrap())
            .unwrap();
        blob[14..18].copy_from_slice(&0x7FFF_FFFFu32.to_be_bytes());
        let s = format!("{EXPORT_PREFIX}{}", URL_SAFE_NO_PAD.encode(&blob));
        assert!(matches!(
            import_secret(&s, "pp"),
            Err(SecretExportError::Format(_))
        ));
    }

    #[test]
    fn truncated_blob_never_panics() {
        let id = NodeIdentity::generate();
        let token = export_secret(&id, "pp").unwrap();
        let blob = URL_SAFE_NO_PAD
            .decode(token.strip_prefix(EXPORT_PREFIX).unwrap())
            .unwrap();
        for cut in 0..blob.len() {
            let s = format!("{EXPORT_PREFIX}{}", URL_SAFE_NO_PAD.encode(&blob[..cut]));
            let r = std::panic::catch_unwind(|| import_secret(&s, "pp"));
            assert!(r.is_ok(), "panic at cut {cut}");
            assert!(r.unwrap().is_err(), "cut {cut} must be rejected");
        }
    }

    #[test]
    fn passphrase_and_token_limits() {
        let id = NodeIdentity::generate();
        assert!(matches!(
            export_secret(&id, ""),
            Err(SecretExportError::Format(_))
        ));
        assert!(matches!(
            import_secret("dwebkey1.x", ""),
            Err(SecretExportError::Format(_))
        ));
        let long = "x".repeat(MAX_PASSPHRASE_BYTES + 1);
        assert!(matches!(
            export_secret(&id, &long),
            Err(SecretExportError::Format(_))
        ));
        let huge = format!("{EXPORT_PREFIX}{}", "A".repeat(MAX_TOKEN_CHARS));
        assert!(matches!(
            import_secret(&huge, "pp"),
            Err(SecretExportError::Format(_))
        ));
    }

    #[test]
    fn garbage_prefixes_rejected() {
        for bad in [
            "",
            "dwebkey2.xyz",
            "dwebkey1.",
            "dwebkey1.!!!!",
            "plain-text",
        ] {
            assert!(import_secret(bad, "pp").is_err(), "must reject {bad:?}");
        }
    }

    #[test]
    fn secret_seed_debug_redacted() {
        let seed = SecretSeed::from_bytes([9u8; 32]);
        assert_eq!(format!("{seed:?}"), "[REDACTED]");
    }
}
