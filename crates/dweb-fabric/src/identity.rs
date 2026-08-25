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
//! # Persistence contract (fabric/identity spec)
//!
//! - File: `<data_dir>/identity.key`, exactly 32 bytes (the Ed25519 seed via
//!   `SecretKey::to_bytes`), permissions `0600` on unix.
//! - Missing file: a fresh identity is generated and persisted atomically
//!   (tmp + fsync + rename).
//! - Existing file whose length is not exactly 32 bytes:
//!   [`IdentityError::Corrupted`] including the file path. We never silently
//!   regenerate an identity over a damaged key file: a fresh key would orphan
//!   the node's roster membership.
//! - Note: `SecretKey::from_bytes` accepts *any* 32 bytes (clamping happens
//!   on use), so only the length is checkable — same contract as the spike
//!   report (docs/spike-iroh.md §5).

use std::fmt;
use std::path::{Path, PathBuf};

use iroh_base::{PublicKey, SecretKey};
use thiserror::Error;

/// File name of the persisted seed inside the data directory.
pub const KEY_FILE_NAME: &str = "identity.key";

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

    /// Path of the key file inside `data_dir`.
    pub fn key_path(data_dir: &Path) -> PathBuf {
        data_dir.join(KEY_FILE_NAME)
    }

    /// Loads the identity from `data_dir`, or creates and persists a new one
    /// when no key file exists. See the module docs for the corruption
    /// contract.
    pub fn load_or_create(data_dir: &Path) -> Result<Self, IdentityError> {
        std::fs::create_dir_all(data_dir).map_err(|source| IdentityError::Write {
            path: data_dir.to_path_buf(),
            source,
        })?;
        let path = Self::key_path(data_dir);
        match std::fs::read(&path) {
            Ok(bytes) => {
                if bytes.len() != SEED_LEN {
                    return Err(IdentityError::Corrupted {
                        path,
                        reason: format!(
                            "expected {SEED_LEN} bytes of Ed25519 seed, found {}",
                            bytes.len()
                        ),
                    });
                }
                let seed: [u8; SEED_LEN] =
                    bytes.as_slice().try_into().expect("length checked above");
                Ok(Self::from_seed(seed))
            }
            // Missing file: generate fresh material and persist it.
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
                let identity = Self::generate();
                identity.write_seed_file(&path)?;
                Ok(identity)
            }
            Err(source) => Err(IdentityError::Read { path, source }),
        }
    }

    /// Persists the seed to `path` with `0600` permissions, atomically
    /// (write to `<path>.tmp`, fsync, rename over `path`).
    fn write_seed_file(&self, path: &Path) -> Result<(), IdentityError> {
        let mut tmp = std::ffi::OsString::from(path.as_os_str());
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);

        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)
            .map_err(|source| IdentityError::Write {
                path: tmp.clone(),
                source,
            })?;
        restrict_permissions(&tmp)?;
        std::io::Write::write_all(&mut file, &self.seed()).map_err(|source| {
            IdentityError::Write {
                path: tmp.clone(),
                source,
            }
        })?;
        file.sync_all().map_err(|source| IdentityError::Write {
            path: tmp.clone(),
            source,
        })?;
        drop(file);
        std::fs::rename(&tmp, path).map_err(|source| IdentityError::Write {
            path: path.to_path_buf(),
            source,
        })?;
        Ok(())
    }
}

impl fmt::Debug for NodeIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NodeIdentity")
            .field("endpoint_id", &endpoint_id_display(&self.endpoint_id()))
            .finish_non_exhaustive()
    }
}

/// Marks `path` as readable/writable by the current user only (unix).
#[cfg(unix)]
fn restrict_permissions(path: &Path) -> Result<(), IdentityError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(|source| {
        IdentityError::Write {
            path: path.to_path_buf(),
            source,
        }
    })
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) -> Result<(), IdentityError> {
    // Secret-file permissions are not representable on this platform.
    Ok(())
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
