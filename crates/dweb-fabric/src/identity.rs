//! Cryptographic node identity for the dweb fabric.
//!
//! An identity is an Ed25519 keypair. The public half doubles as the stable
//! node identifier ([`EndpointId`]), fully decoupled from any network address.
//! The 32-byte seed is persisted in a dedicated file inside the node's data
//! directory so that identity survives restarts and directory migration.
//!
//! # Persistence contract (fabric/identity spec)
//!
//! - File: `<data_dir>/identity.key`, exactly 32 bytes (the Ed25519 seed),
//!   permissions `0600` on unix.
//! - Missing file: a fresh identity is generated and persisted.
//! - Existing file with a length other than 32: [`IdentityError::Corrupted`]
//!   is returned (including the file path). We never silently regenerate an
//!   identity over a damaged key file, because that would orphan the node's
//!   roster membership.

use std::fmt;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use ed25519_dalek::{SigningKey, VerifyingKey};
use thiserror::Error;

/// File name of the persisted seed inside the data directory.
pub const KEY_FILE_NAME: &str = "identity.key";

/// Length in bytes of an Ed25519 seed and of an [`EndpointId`].
pub const SEED_LEN: usize = 32;

/// Errors produced by identity loading, persistence and [`EndpointId`] parsing.
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
    /// The OS entropy source failed while generating a new keypair.
    #[error("failed to gather entropy for a new identity: {source}")]
    Entropy {
        #[source]
        source: getrandom::Error,
    },
    /// A string did not parse as an [`EndpointId`].
    #[error("invalid EndpointId string: {reason}")]
    InvalidEndpointId { reason: String },
}

/// Stable public identifier of a node: the raw 32-byte Ed25519 verifying key.
///
/// The display form is exactly 64 lower-case hex characters, derived purely
/// from the key bytes, so the same public key always renders identically on
/// every device. [`FromStr`] is the inverse of [`fmt::Display`] (it accepts
/// upper-case hex on input as well).
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EndpointId([u8; EndpointId::LEN]);

impl EndpointId {
    /// Length of an EndpointId in bytes.
    pub const LEN: usize = SEED_LEN;

    /// Wraps raw key bytes.
    pub const fn from_bytes(bytes: [u8; Self::LEN]) -> Self {
        Self(bytes)
    }

    /// Raw key bytes.
    pub const fn as_bytes(&self) -> &[u8; Self::LEN] {
        &self.0
    }

    /// Raw key bytes, by value.
    pub const fn to_bytes(self) -> [u8; Self::LEN] {
        self.0
    }

    /// Identifier derived from a signing key's verifying (public) key.
    pub fn from_signing_key(key: &SigningKey) -> Self {
        Self(key.verifying_key().to_bytes())
    }

    fn hex_encode(bytes: &[u8; Self::LEN]) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut out = String::with_capacity(bytes.len() * 2);
        for b in bytes {
            out.push(HEX[(b >> 4) as usize] as char);
            out.push(HEX[(b & 0x0f) as usize] as char);
        }
        out
    }

    fn hex_decode(s: &str) -> Result<[u8; Self::LEN], IdentityError> {
        let err = |reason: String| IdentityError::InvalidEndpointId {
            reason: format!("{reason} (got {s:?})"),
        };
        if s.len() != Self::LEN * 2 {
            return Err(err(format!(
                "expected {} hex characters, found {}",
                Self::LEN * 2,
                s.len()
            )));
        }
        let mut out = [0u8; Self::LEN];
        for (i, chunk) in s.as_bytes().chunks(2).enumerate() {
            let hi = hex_nibble(chunk[0]).ok_or_else(|| err("non-hex character".into()))?;
            let lo = hex_nibble(chunk[1]).ok_or_else(|| err("non-hex character".into()))?;
            out[i] = (hi << 4) | lo;
        }
        Ok(out)
    }
}

fn hex_nibble(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

impl fmt::Display for EndpointId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&EndpointId::hex_encode(&self.0))
    }
}

impl fmt::Debug for EndpointId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "EndpointId({})", EndpointId::hex_encode(&self.0))
    }
}

impl FromStr for EndpointId {
    type Err = IdentityError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(Self(EndpointId::hex_decode(s)?))
    }
}

impl From<[u8; SEED_LEN]> for EndpointId {
    fn from(bytes: [u8; SEED_LEN]) -> Self {
        Self::from_bytes(bytes)
    }
}

/// A node's Ed25519 identity: secret signing key plus derived
/// [`EndpointId`].
///
/// The signing key is zeroized on drop (ed25519-dalek default feature).
/// `Debug` deliberately never prints the seed.
#[derive(Clone)]
pub struct NodeIdentity {
    signing: SigningKey,
}

impl NodeIdentity {
    /// Generates a fresh identity from OS entropy.
    pub fn generate() -> Result<Self, IdentityError> {
        let mut seed = [0u8; SEED_LEN];
        getrandom::fill(&mut seed).map_err(|source| IdentityError::Entropy { source })?;
        Ok(Self::from_seed(seed))
    }

    /// Restores an identity from a 32-byte seed. Any 32 bytes are a valid
    /// Ed25519 seed (clamping is applied internally on use).
    pub fn from_seed(seed: [u8; SEED_LEN]) -> Self {
        Self {
            signing: SigningKey::from_bytes(&seed),
        }
    }

    /// The derived stable identifier (== Ed25519 verifying key).
    pub fn endpoint_id(&self) -> EndpointId {
        EndpointId::from_signing_key(&self.signing)
    }

    /// The Ed25519 verifying key.
    pub fn verifying_key(&self) -> VerifyingKey {
        self.signing.verifying_key()
    }

    /// The Ed25519 signing key, for signing facts elsewhere in the crate.
    pub fn signing_key(&self) -> &SigningKey {
        &self.signing
    }

    /// The secret seed. Handle with care: whoever holds it *is* this node.
    pub fn seed(&self) -> [u8; SEED_LEN] {
        self.signing.to_bytes()
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
                let mut seed = [0u8; SEED_LEN];
                seed.copy_from_slice(&bytes);
                Ok(Self::from_seed(seed))
            }
            // Missing file: generate fresh material and persist it.
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
                let identity = Self::generate()?;
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
        file.write_all(&self.seed())
            .map_err(|source| IdentityError::Write {
                path: tmp.clone(),
                source,
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
            .field("endpoint_id", &self.endpoint_id())
            .finish_non_exhaustive()
    }
}

// `file.write_all` above needs `io::Write` in scope.
use std::io::Write as _;

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
    fn display_is_deterministic_and_roundtrips() {
        let a = NodeIdentity::from_seed([7u8; 32]);
        let b = NodeIdentity::from_seed([7u8; 32]);
        let id_a = a.endpoint_id();
        let id_b = b.endpoint_id();
        // Same public key -> same string, regardless of instance.
        assert_eq!(id_a.to_string(), id_b.to_string());
        assert_eq!(id_a.to_string().len(), 64);
        // Lower-case hex only.
        assert!(
            id_a.to_string()
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        );

        // Round-trip.
        let parsed: EndpointId = id_a.to_string().parse().unwrap();
        assert_eq!(parsed, id_a);
        // Upper-case input accepted too.
        let upper: EndpointId = id_a.to_string().to_uppercase().parse().unwrap();
        assert_eq!(upper, id_a);
    }

    #[test]
    fn endpoint_id_parse_rejects_garbage() {
        for bad in ["", "zz", &"a".repeat(63), &"a".repeat(65), &"x".repeat(64)] {
            let res: Result<EndpointId, _> = bad.parse();
            assert!(res.is_err(), "expected parse failure for {bad:?}");
        }
        // 64 valid hex chars parse fine.
        let ok: EndpointId = "0".repeat(64).parse().unwrap();
        assert_eq!(ok.as_bytes(), &[0u8; 32]);
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
        assert!(dbg.contains(&id.endpoint_id().to_string()));
    }
}
