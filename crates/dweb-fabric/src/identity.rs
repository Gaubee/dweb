//! Cryptographic node identity for the dweb fabric (v1, iroh-key based).
//!
//! An identity is an Ed25519 keypair provided by iroh (`iroh_base::SecretKey`,
//! dalek-3 under the hood). The public half doubles as the stable node
//! identifier [`EndpointId`] (= `iroh_base::PublicKey`), fully decoupled from
//! any network address. **Signing and verification for facts, invites and
//! proofs-of-possession all go through the same iroh key types** — there is no
//! second, unbound Ed25519 stack in this crate (design D2 / codex review §1).
//!
//! # Display form (z-base-32)
//!
//! `PublicKey`'s own `Display`/`FromStr` in iroh-base 1.1.0 are **hex**, not
//! z-base-32 (see `iroh-base/src/key.rs`: `Display` writes `HEXLOWER`, the
//! `FromStr` doc says "Display produces the hex encoding"). The dweb display
//! form is therefore the explicit `to_z32()`/`from_z32()` methods, which match
//! the iroh CLI and ticket encodings — use [`endpoint_id_display`] and
//! [`endpoint_id_parse`] instead of `to_string`/`parse`.
//!
//! # Persistence (secret-store-abstraction)
//!
//! 私钥持久化经 [`crate::secret::SecretStore`] 抽象（信任模型中立）：默认
//! [`crate::secret::FileSecretStore`] 即历史上的 `<data_dir>/identity.key`
//! 行为（32B seed、0600、tmp+fsync+rename 原子写、损坏报含路径错误），
//! `load_or_create` 是它的便捷封装。产品可注入自定义 store（Keychain、
//! 加密托管等）或直接 `from_seed` 注入（零存储副作用）。

use std::fmt;
use std::path::{Path, PathBuf};

use iroh_base::{PublicKey, SecretKey};
use thiserror::Error;

/// File name of the persisted seed inside the data directory（再导出自 secret 模块）。
pub use crate::secret::KEY_FILE_NAME;

/// Length in bytes of an Ed25519 seed and of an [`EndpointId`].
pub const SEED_LEN: usize = 32;

/// Stable public identifier of a node: the iroh Ed25519 public key.
///
/// Same key material as the iroh endpoint id, so the TLS-authenticated peer
/// id of a connection is directly comparable to fact issuers and subjects.
pub type EndpointId = PublicKey;

/// Errors produced by identity loading, persistence and EndpointId parsing.
#[derive(Debug, Error)]
pub enum IdentityError {
    /// The key file exists but cannot be parsed as key material.
    #[error("identity key file {path} is corrupted: {reason}")]
    Corrupted { path: PathBuf, reason: String },
    /// Reading the key file failed (other than "not found").
    #[error("failed to read identity key file {path}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    /// Writing the key file failed.
    #[error("failed to write identity key file {path}: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    /// A string did not parse as an [`EndpointId`] (z-base-32 form).
    #[error("invalid EndpointId string: {reason}")]
    InvalidEndpointId { reason: String },
    /// SecretStore 的非文件类错误（Conflict/Unsupported/Custom）。
    #[error("secret store: {0}")]
    Store(crate::secret::SecretStoreError),
}

impl From<crate::secret::SecretStoreError> for IdentityError {
    /// 保留旧 `Corrupted/Read/Write` 顶层变体（零迁移的可观察等价契约）；
    /// 其余（Conflict/Unsupported/Custom）落入 Store 包装。
    fn from(e: crate::secret::SecretStoreError) -> Self {
        match e {
            crate::secret::SecretStoreError::Corrupted { path, reason } => {
                IdentityError::Corrupted { path, reason }
            }
            crate::secret::SecretStoreError::Read { path, source } => {
                IdentityError::Read { path, source }
            }
            crate::secret::SecretStoreError::Write { path, source } => {
                IdentityError::Write { path, source }
            }
            other => IdentityError::Store(other),
        }
    }
}

/// The display form of an [`EndpointId`]: z-base-32 (52 characters), the same
/// encoding the iroh CLI and tickets use. Deterministic across devices.
pub fn endpoint_id_display(id: &EndpointId) -> String {
    id.to_z32()
}

/// Parses the z-base-32 display form produced by [`endpoint_id_display`].
pub fn endpoint_id_parse(s: &str) -> Result<EndpointId, IdentityError> {
    PublicKey::from_z32(s).map_err(|e| IdentityError::InvalidEndpointId {
        reason: format!("{e} (got {s:?})"),
    })
}

/// A node's Ed25519 identity: the iroh secret key plus its derived
/// [`EndpointId`].
///
/// The secret key is zeroized on drop (iroh-base default). `Debug` never
/// prints the seed.
#[derive(Clone)]
pub struct NodeIdentity {
    secret: SecretKey,
}

impl NodeIdentity {
    /// Generates a fresh identity from OS entropy (`SecretKey::generate`).
    pub fn generate() -> Self {
        Self {
            secret: SecretKey::generate(),
        }
    }

    /// Restores an identity from a 32-byte seed. Any 32 bytes are a valid
    /// Ed25519 seed (clamping is applied internally on use).
    pub fn from_seed(seed: [u8; SEED_LEN]) -> Self {
        Self {
            secret: SecretKey::from_bytes(&seed),
        }
    }

    /// The derived stable identifier (== the iroh endpoint id).
    pub fn endpoint_id(&self) -> EndpointId {
        self.secret.public()
    }

    /// The iroh secret key, for signing facts, invites and PoPs elsewhere in
    /// the crate.
    pub fn secret_key(&self) -> &SecretKey {
        &self.secret
    }

    /// The secret seed. Handle with care: whoever holds it *is* this node.
    pub fn seed(&self) -> [u8; SEED_LEN] {
        self.secret.to_bytes()
    }

    /// Path of the key file inside `data_dir`（FileSecretStore 默认布局）。
    pub fn key_path(data_dir: &Path) -> PathBuf {
        data_dir.join(crate::secret::KEY_FILE_NAME)
    }

    /// 以 SecretStore 载入身份；无身份则生成并 create（并发下不分叉）。
    pub fn with_store(store: &dyn crate::secret::SecretStore) -> Result<Self, IdentityError> {
        crate::secret::ensure_with(store).map_err(IdentityError::from)
    }

    /// 直接以 32B seed 构造（注入路径：零存储副作用）。
    pub fn with_seed(seed: [u8; SEED_LEN]) -> Self {
        Self::from_seed(seed)
    }

    /// Loads the identity from `data_dir` (FileSecretStore 默认实现), or
    /// creates and persists a new one when no key file exists.
    pub fn load_or_create(data_dir: &Path) -> Result<Self, IdentityError> {
        Self::with_store(&crate::secret::FileSecretStore::new(data_dir))
    }
}

impl fmt::Debug for NodeIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NodeIdentity")
            .field("endpoint_id", &endpoint_id_display(&self.endpoint_id()))
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn z32_display_is_deterministic_and_roundtrips() {
        let a = NodeIdentity::from_seed([7u8; 32]);
        let b = NodeIdentity::from_seed([7u8; 32]);
        // Same public key -> same display string, regardless of instance.
        let sa = endpoint_id_display(&a.endpoint_id());
        let sb = endpoint_id_display(&b.endpoint_id());
        assert_eq!(sa, sb);
        // z-base-32 of 32 bytes is 52 characters.
        assert_eq!(sa.len(), 52);
        assert!(
            sa.chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        );

        // Round-trip.
        let parsed = endpoint_id_parse(&sa).unwrap();
        assert_eq!(parsed, a.endpoint_id());

        // Distinct keys -> distinct strings.
        let other = endpoint_id_display(&NodeIdentity::from_seed([8u8; 32]).endpoint_id());
        assert_ne!(sa, other);
    }

    #[test]
    fn endpoint_id_parse_rejects_garbage() {
        for bad in ["", "zz", &"a".repeat(51), &"a".repeat(53), "not-a-z32-id!!"] {
            assert!(
                endpoint_id_parse(bad).is_err(),
                "expected parse failure for {bad:?}"
            );
        }
    }

    #[test]
    fn display_is_hex_in_iroh_but_z32_is_ours() {
        // Guard the documented iroh-base fact: PublicKey's Display is hex
        // (64 chars), NOT z32. Our display helpers must use z32.
        let id = NodeIdentity::from_seed([7u8; 32]).endpoint_id();
        assert_eq!(id.to_string().len(), 64, "iroh Display is hex");
        assert_ne!(id.to_string(), endpoint_id_display(&id));
        assert_eq!(endpoint_id_display(&id), id.to_z32());
    }

    #[test]
    fn first_init_generates_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let id1 = NodeIdentity::load_or_create(dir.path()).unwrap();
        let key_file = NodeIdentity::key_path(dir.path());
        assert!(key_file.exists());
        assert_eq!(std::fs::read(&key_file).unwrap().len(), SEED_LEN);

        // Restart on the same directory yields the exact same identity.
        let id2 = NodeIdentity::load_or_create(dir.path()).unwrap();
        assert_eq!(id1.endpoint_id(), id2.endpoint_id());
        assert_eq!(id1.seed(), id2.seed());
    }

    #[test]
    fn seed_roundtrip_through_secret_key_bytes() {
        // to_bytes -> from_bytes -> public() restores the same id (spike §5).
        let id = NodeIdentity::from_seed([3u8; 32]);
        let restored = NodeIdentity::from_seed(id.seed());
        assert_eq!(id.endpoint_id(), restored.endpoint_id());
    }

    #[test]
    fn distinct_data_dirs_yield_distinct_identities() {
        let dir_a = tempfile::tempdir().unwrap();
        let dir_b = tempfile::tempdir().unwrap();
        let a = NodeIdentity::load_or_create(dir_a.path()).unwrap();
        let b = NodeIdentity::load_or_create(dir_b.path()).unwrap();
        assert_ne!(a.endpoint_id(), b.endpoint_id());
    }

    #[test]
    fn corrupted_key_file_errors_with_path() {
        let dir = tempfile::tempdir().unwrap();
        let key_file = NodeIdentity::key_path(dir.path());
        std::fs::write(&key_file, b"garbage-not-32-bytes").unwrap();

        let err = NodeIdentity::load_or_create(dir.path()).unwrap_err();
        match &err {
            IdentityError::Corrupted { path, reason } => {
                assert_eq!(path, &key_file);
                assert!(
                    reason.contains("32"),
                    "reason should mention length: {reason}"
                );
            }
            other => panic!("expected Corrupted, got {other:?}"),
        }
        // Error message contains the path (spec: 明确错误，指示密钥文件路径).
        assert!(err.to_string().contains(key_file.to_str().unwrap()));
        // No new identity was produced and the file is untouched.
        assert_eq!(std::fs::read(&key_file).unwrap(), b"garbage-not-32-bytes");
    }

    #[test]
    fn corrupted_empty_key_file_errors() {
        let dir = tempfile::tempdir().unwrap();
        let key_file = NodeIdentity::key_path(dir.path());
        std::fs::write(&key_file, b"").unwrap();
        assert!(matches!(
            NodeIdentity::load_or_create(dir.path()),
            Err(IdentityError::Corrupted { .. })
        ));
    }

    #[test]
    fn data_dir_migration_keeps_identity() {
        let dir_a = tempfile::tempdir().unwrap();
        let id_a = NodeIdentity::load_or_create(dir_a.path()).unwrap();
        // "Copy the whole data dir to another machine."
        let dir_b = tempfile::tempdir().unwrap();
        std::fs::copy(
            NodeIdentity::key_path(dir_a.path()),
            NodeIdentity::key_path(dir_b.path()),
        )
        .unwrap();
        let id_b = NodeIdentity::load_or_create(dir_b.path()).unwrap();
        assert_eq!(id_a.endpoint_id(), id_b.endpoint_id());
    }

    #[cfg(unix)]
    #[test]
    fn key_file_permissions_are_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        NodeIdentity::load_or_create(dir.path()).unwrap();
        let mode = std::fs::metadata(NodeIdentity::key_path(dir.path()))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn debug_never_prints_seed() {
        let id = NodeIdentity::from_seed([9u8; 32]);
        let dbg = format!("{id:?}");
        assert!(!dbg.contains("seed"));
        assert!(dbg.contains(&endpoint_id_display(&id.endpoint_id())));
    }
}
