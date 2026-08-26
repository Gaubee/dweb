//! Canonical formats for membership facts, invite tokens and redemption
//! proof-of-possession material (fabric spec: roster / codex review §2-3).
//!
//! Everything that gets signed is encoded as **domain-separated canonical
//! bytes** with explicit lengths — never JSON, never map-order dependent.
//! Fact ids are content addresses: `BLAKE3(canonical bytes)`, so there are no
//! client-generated random ids and "same id ⇒ same content" holds by
//! construction. All signatures are Ed25519 via the iroh key types
//! (`iroh_base::SecretKey`/`Signature`), the same keys as the transport
//! endpoint — no second signature stack.
//!
//! # Canonical byte layout of [`Fact`] (v1)
//!
//! All integers are big-endian. Fixed-width fields come first, optional
//! fields afterwards in a fixed order, each announced by a tag byte, so
//! encoding is a pure function of the field values.
//!
//! ```text
//! offset  size  field
//! 0       13    domain          b"dweb/fact/v1\0"
//! 13      1     kind            1=Genesis 2=Grant 3=Join 4=Revoke
//! 14      32    fabric_id       raw
//! 46      32    issuer          EndpointId (raw Ed25519 public key)
//! 78      32    subject         EndpointId (raw)
//! 110     8     issued_at_ms    u64 BE, unix epoch milliseconds
//! 118     1     flags           bit0: display_name present
//!                                 bit1: expires_at_ms present
//!                                 bit2: target_fact_id present (Revoke)
//!                                 (all other bits must be 0)
//! 119     ..    if bit0: u16 BE name_len || name_len bytes UTF-8 (≤ 512 B)
//! ..      ..    if bit1: u64 BE expires_at_ms
//! ..      ..    if bit2: 32 B target_fact_id
//! ```
//!
//! `fact_id = BLAKE3(canonical bytes)` — the id is *not* part of the canonical
//! bytes (it is derived from them). [`Fact::decode_strict`] rejects bad
//! domain, unknown kinds, reserved flag bits, truncation, lying length
//! prefixes, non-UTF-8 names, oversized names and trailing bytes; such
//! failures surface as [`ProtocolError::Quarantine`].
//!
//! # Canonical byte layout of [`InviteV1`] (v1)
//!
//! ```text
//! offset  size  field
//! 0       15    domain          b"dweb/invite/v1\0"
//! 15      1     version         0x01
//! 16      32    fabric_id       raw
//! 48      16    invite_id       raw random
//! 64      32    issuer          EndpointId (raw)
//! 96      2+n   relay_url       u16 BE len || UTF-8 (≤ 2048 B)
//! ..      1     n_addrs         direct address count (0..=4)
//! ..      Σ     per addr: u8 len (≤ 64) || UTF-8 bytes
//! ..      8     expires_at_ms   u64 BE
//! ..      1     flags           bit0: recipient present
//! ..      32?   recipient       EndpointId (raw), if bit0
//! ..      1     max_uses        must be 1
//! ```
//!
//! The invite token string is `dweb1.` + base64url-nopad of
//! `InviteV1 canonical bytes || 64 B issuer signature`. Decoding verifies the
//! version header, all lengths and the signature.
//!
//! # Proof of possession (redeem PoP)
//!
//! The invitee B signs [`redeem_challenge_bytes`] over
//! `b"dweb/redeem-pop/v1\0" || fabric_id || invite_id || challenge[32]` with
//! B's iroh secret key; the issuer verifies with the claimed redeemer's
//! `EndpointId`. A stolen token without B's private key cannot answer the
//! challenge.

use std::fmt;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use iroh_base::{SecretKey, Signature};
use thiserror::Error;

use crate::identity::{EndpointId, NodeIdentity};

/// Domain-separation prefix of canonical fact bytes (trailing NUL included).
pub const FACT_DOMAIN: &[u8; 13] = b"dweb/fact/v1\0";
/// Domain-separation prefix of canonical invite bytes (trailing NUL included).
pub const INVITE_DOMAIN: &[u8; 15] = b"dweb/invite/v1\0";
/// Domain-separation prefix of redemption PoP material (trailing NUL included).
pub const POP_DOMAIN: &[u8; 19] = b"dweb/redeem-pop/v1\0";

/// Version byte inside InviteV1 canonical bytes.
pub const INVITE_VERSION: u8 = 0x01;

/// Version prefix of invite token strings.
pub const TOKEN_PREFIX: &str = "dweb1.";

/// Maximum size of a fact's display_name payload in bytes.
pub const MAX_NAME_BYTES: usize = 512;
/// Maximum size of an invite's relay URL in bytes.
pub const MAX_RELAY_URL_BYTES: usize = 2048;
/// Maximum number of direct addresses inside an invite.
pub const MAX_DIRECT_ADDRS: usize = 4;
/// Maximum size of a single direct address string in bytes.
pub const MAX_DIRECT_ADDR_BYTES: usize = 64;

/// Length of the fixed (pre-optional) part of the fact layout.
const FACT_FIXED_LEN: usize = FACT_DOMAIN.len() + 1 + 32 + 32 + 32 + 8 + 1; // 119
/// Length of the fixed (pre-optional) part of the invite layout.
const INVITE_FIXED_LEN: usize = INVITE_DOMAIN.len() + 1 + 32 + 16 + 32; // through `issuer` = 96
const INVITE_MIN_LEN: usize = INVITE_FIXED_LEN + 2 + 1 + 8 + 1 + 1; // + empty relay len, n_addrs, expiry, flags, max_uses

const KIND_GENESIS: u8 = 1;
const KIND_GRANT: u8 = 2;
const KIND_JOIN: u8 = 3;
const KIND_REVOKE: u8 = 4;

const FLAG_HAS_NAME: u8 = 0b001;
const FLAG_HAS_EXPIRY: u8 = 0b010;
const FLAG_HAS_TARGET: u8 = 0b100;

/// Errors from canonical encoding/decoding, signatures and tokens.
#[derive(Debug, Error)]
pub enum ProtocolError {
    /// A field cannot be represented in the canonical layout (local
    /// construction error — e.g. an oversized display_name or relay URL).
    #[error("canonical encoding error: {0}")]
    Encoding(String),
    /// The bytes are not a valid canonical structure, or a signature failed
    /// verification. Such input is untrusted: quarantine it, do not store.
    #[error("quarantine: {reason}")]
    Quarantine { reason: String },
    /// Debug JSON (de)serialization failed. JSON is *not* canonical.
    #[error("debug JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

fn quarantine(reason: impl Into<String>) -> ProtocolError {
    ProtocolError::Quarantine {
        reason: reason.into(),
    }
}

/// Content address of a [`Fact`]: the BLAKE3 hash of its canonical bytes.
pub type FactId = [u8; 32];

/// Identity of one fabric (network). 32 bytes per spec; produced by
/// `FabricId::random()` at creation time or `FabricId::from_name` for
/// deterministic derivation from a human-chosen name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct FabricId(pub [u8; 32]);

impl FabricId {
    /// Deterministically derives a fabric id from a name (BLAKE3 of the
    /// UTF-8 bytes). Same name ⇒ same fabric id on every device.
    pub fn from_name(name: &str) -> Self {
        Self(*blake3::hash(name.as_bytes()).as_bytes())
    }

    /// Generates a fresh random fabric id.
    pub fn random() -> Self {
        Self(random_bytes::<32>())
    }

    /// Raw bytes.
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl fmt::Display for FabricId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&hex_str(&self.0))
    }
}

/// OS entropy via iroh's key generation, squeezed through BLAKE3 so any
/// length ≤ 32 is available. (Avoids a direct rand/getrandom dependency.)
pub fn random_bytes<const N: usize>() -> [u8; N] {
    debug_assert!(N <= 32);
    let seed = SecretKey::generate().to_bytes();
    let hash = blake3::hash(&seed);
    let mut out = [0u8; N];
    let n = N.min(32);
    out[..n].copy_from_slice(&hash.as_bytes()[..n]);
    out
}

/// What a fact asserts about its subject.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum FactKind {
    /// The fabric's immutable trust root: issuer == subject == root.
    /// Exactly one per fabric; establishes the root EndpointId.
    Genesis = KIND_GENESIS,
    /// Membership grant (v0.1: only meaningful when issued by the root).
    Grant = KIND_GRANT,
    /// A member's self-description (display name). Not an admission edge.
    Join = KIND_JOIN,
    /// Revocation of a specific grant or of a subject's live grants.
    Revoke = KIND_REVOKE,
}

impl FactKind {
    /// Canonical discriminant used on the wire.
    pub const fn as_u8(self) -> u8 {
        self as u8
    }

    /// Parses the wire discriminant.
    pub const fn from_u8(v: u8) -> Option<Self> {
        match v {
            KIND_GENESIS => Some(Self::Genesis),
            KIND_GRANT => Some(Self::Grant),
            KIND_JOIN => Some(Self::Join),
            KIND_REVOKE => Some(Self::Revoke),
            _ => None,
        }
    }

    /// Stable name for the debug JSON projection.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Genesis => "genesis",
            Self::Grant => "grant",
            Self::Join => "join",
            Self::Revoke => "revoke",
        }
    }
}

impl fmt::Display for FactKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// An immutable membership fact. The id is *not* stored: it is the BLAKE3
/// content address of the canonical bytes ([`Fact::fact_id`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fact {
    /// What this fact asserts.
    pub kind: FactKind,
    /// The fabric this fact belongs to (cross-fabric facts are rejected).
    pub fabric_id: FabricId,
    /// Signer's identity (== iroh endpoint id of the signer).
    pub issuer: EndpointId,
    /// Who the fact is about.
    pub subject: EndpointId,
    /// Optional human-readable label (≤ 512 bytes UTF-8).
    pub display_name: Option<String>,
    /// Unix epoch milliseconds when the fact was issued.
    pub issued_at_ms: u64,
    /// Unix epoch milliseconds after which the fact is inert.
    /// Valid at `now` iff absent or `now < expires_at_ms` (fail-closed).
    pub expires_at_ms: Option<u64>,
    /// Revoke only: the targeted grant's fact id. `None` on a Revoke means
    /// "all live grants of `subject`".
    pub target_fact_id: Option<FactId>,
}

impl Fact {
    /// Whether this fact still has effect at `now_ms`.
    pub fn is_valid_at(&self, now_ms: u64) -> bool {
        self.expires_at_ms.is_none_or(|e| now_ms < e)
    }

    /// The content address of this fact: BLAKE3 over the canonical bytes.
    /// Deterministic — the same field values always yield the same id.
    ///
    /// For an *unrepresentable* fact (oversized display_name) the canonical
    /// encoding fails; such facts can never be signed, verified or stored,
    /// and all share a constant sentinel id.
    pub fn fact_id(&self) -> FactId {
        match self.canonical_bytes() {
            Ok(bytes) => *blake3::hash(&bytes).as_bytes(),
            Err(_) => *blake3::hash(b"dweb/fact-unrepresentable/v1\0").as_bytes(),
        }
    }

    /// Deterministic canonical byte serialization (see module docs). This
    /// byte string — and only this byte string — is what gets signed.
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, ProtocolError> {
        if let Some(name) = &self.display_name
            && name.len() > MAX_NAME_BYTES
        {
            return Err(ProtocolError::Encoding(format!(
                "display_name of {} bytes exceeds the {} byte limit",
                name.len(),
                MAX_NAME_BYTES
            )));
        }
        let name_len = self.display_name.as_ref().map_or(0, String::len);
        let mut buf = Vec::with_capacity(
            FACT_FIXED_LEN
                + if name_len > 0 { 2 + name_len } else { 0 }
                + self.expires_at_ms.map_or(0, |_| 8)
                + self.target_fact_id.map_or(0, |_| 32),
        );
        buf.extend_from_slice(FACT_DOMAIN);
        buf.push(self.kind.as_u8());
        buf.extend_from_slice(self.fabric_id.as_bytes());
        buf.extend_from_slice(self.issuer.as_bytes());
        buf.extend_from_slice(self.subject.as_bytes());
        buf.extend_from_slice(&self.issued_at_ms.to_be_bytes());
        let mut flags = 0u8;
        if self.display_name.is_some() {
            flags |= FLAG_HAS_NAME;
        }
        if self.expires_at_ms.is_some() {
            flags |= FLAG_HAS_EXPIRY;
        }
        if self.target_fact_id.is_some() {
            flags |= FLAG_HAS_TARGET;
        }
        buf.push(flags);
        if let Some(name) = &self.display_name {
            buf.extend_from_slice(&(name.len() as u16).to_be_bytes());
            buf.extend_from_slice(name.as_bytes());
        }
        if let Some(exp) = self.expires_at_ms {
            buf.extend_from_slice(&exp.to_be_bytes());
        }
        if let Some(target) = self.target_fact_id {
            buf.extend_from_slice(&target);
        }
        Ok(buf)
    }

    /// Strict parse: the input must be exactly one canonical fact (no
    /// trailing bytes). Any violation is a [`ProtocolError::Quarantine`].
    pub fn decode_strict(bytes: &[u8]) -> Result<Fact, ProtocolError> {
        let (fact, consumed) = parse_fact_prefix(bytes)?;
        if consumed != bytes.len() {
            return Err(quarantine(format!(
                "{} trailing byte(s) after canonical fact",
                bytes.len() - consumed
            )));
        }
        Ok(fact)
    }
}

/// Parses a canonical fact from the front of `bytes`, returning the fact and
/// the number of bytes consumed.
fn parse_fact_prefix(bytes: &[u8]) -> Result<(Fact, usize), ProtocolError> {
    let trunc = |what: &str| quarantine(format!("truncated canonical fact: {what}"));
    if bytes.len() < FACT_FIXED_LEN {
        return Err(trunc("shorter than the fixed 119-byte prefix"));
    }
    if &bytes[..FACT_DOMAIN.len()] != FACT_DOMAIN {
        return Err(quarantine(format!(
            "bad fact domain {bytes:?} (expected {FACT_DOMAIN:?})"
        )));
    }
    let kind = FactKind::from_u8(bytes[13])
        .ok_or_else(|| quarantine(format!("unknown fact kind 0x{:02x}", bytes[13])))?;
    let fabric_id = FabricId(bytes[14..46].try_into().expect("slice len 32"));
    let issuer = key_from_bytes(&bytes[46..78])?;
    let subject = key_from_bytes(&bytes[78..110])?;
    let issued_at_ms = u64::from_be_bytes(bytes[110..118].try_into().expect("slice len 8"));
    let flags = bytes[118];
    if flags & !(FLAG_HAS_NAME | FLAG_HAS_EXPIRY | FLAG_HAS_TARGET) != 0 {
        return Err(quarantine(format!("reserved flag bits set: 0x{flags:02x}")));
    }

    let mut off = FACT_FIXED_LEN;
    let display_name = if flags & FLAG_HAS_NAME != 0 {
        if bytes.len() < off + 2 {
            return Err(trunc("display_name length prefix"));
        }
        let name_len = u16::from_be_bytes([bytes[off], bytes[off + 1]]) as usize;
        off += 2;
        if name_len > MAX_NAME_BYTES {
            return Err(quarantine(format!(
                "display_name of {name_len} bytes exceeds the {MAX_NAME_BYTES} byte limit"
            )));
        }
        if bytes.len() < off + name_len {
            return Err(trunc("display_name bytes"));
        }
        let name = std::str::from_utf8(&bytes[off..off + name_len])
            .map_err(|_| quarantine("display_name is not valid UTF-8"))?
            .to_owned();
        off += name_len;
        Some(name)
    } else {
        None
    };
    let expires_at_ms = if flags & FLAG_HAS_EXPIRY != 0 {
        if bytes.len() < off + 8 {
            return Err(trunc("expires_at_ms"));
        }
        let exp = u64::from_be_bytes(bytes[off..off + 8].try_into().expect("slice len 8"));
        off += 8;
        Some(exp)
    } else {
        None
    };
    let target_fact_id = if flags & FLAG_HAS_TARGET != 0 {
        if bytes.len() < off + 32 {
            return Err(trunc("target_fact_id"));
        }
        let t = bytes[off..off + 32].try_into().expect("slice len 32");
        off += 32;
        Some(t)
    } else {
        None
    };

    Ok((
        Fact {
            kind,
            fabric_id,
            issuer,
            subject,
            display_name,
            issued_at_ms,
            expires_at_ms,
            target_fact_id,
        },
        off,
    ))
}

/// A fact plus its Ed25519 signature (by the fact's issuer, over the fact's
/// canonical bytes). The wire frame is self-delimiting:
/// `u32 BE fact_len || canonical fact bytes || 64 B signature`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedFact {
    /// The signed fact.
    pub fact: Fact,
    /// Signature over `fact.canonical_bytes()` by `fact.issuer`.
    pub signature: Signature,
}

impl SignedFact {
    /// Signs `fact` with `secret` (expected: the issuer's key) and wraps the
    /// result.
    pub fn sign(fact: Fact, secret: &SecretKey) -> Result<Self, ProtocolError> {
        let signature = secret.sign(&fact.canonical_bytes()?);
        Ok(Self { fact, signature })
    }

    /// The content address of the carried fact.
    pub fn fact_id(&self) -> FactId {
        self.fact.fact_id()
    }

    /// Verifies the embedded signature against the embedded issuer id. This
    /// proves possession of the issuer's private key — *not* that the issuer
    /// is trusted; trust is computed by the roster projection.
    pub fn verify(&self) -> Result<(), ProtocolError> {
        let bytes = self.fact.canonical_bytes()?;
        self.fact
            .issuer
            .verify(&bytes, &self.signature)
            .map_err(|_| quarantine("fact signature verification failed".to_owned()))
    }

    /// Wire encoding: `u32 BE fact_len || canonical fact bytes || signature`.
    pub fn encode(&self) -> Result<Vec<u8>, ProtocolError> {
        let fact_bytes = self.fact.canonical_bytes()?;
        let mut out = Vec::with_capacity(4 + fact_bytes.len() + Signature::LENGTH);
        out.extend_from_slice(&(fact_bytes.len() as u32).to_be_bytes());
        out.extend_from_slice(&fact_bytes);
        out.extend_from_slice(&self.signature.to_bytes());
        Ok(out)
    }

    /// Strict inverse of [`SignedFact::encode`].
    pub fn decode(bytes: &[u8]) -> Result<Self, ProtocolError> {
        let min = 4 + Signature::LENGTH;
        if bytes.len() < min {
            return Err(quarantine(format!(
                "signed fact wire frame of {} bytes shorter than the minimum {min}",
                bytes.len()
            )));
        }
        let fact_len = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
        let end = 4usize
            .checked_add(fact_len)
            .and_then(|v| v.checked_add(Signature::LENGTH))
            .ok_or_else(|| quarantine("signed fact length overflow"))?;
        if bytes.len() != end {
            return Err(quarantine(format!(
                "signed fact wire frame length mismatch: header says {end}, got {}",
                bytes.len()
            )));
        }
        let fact = Fact::decode_strict(&bytes[4..4 + fact_len])?;
        let signature =
            Signature::from_bytes(bytes[4 + fact_len..end].try_into().expect("slice len 64"));
        Ok(Self { fact, signature })
    }

    /// Encodes many signed facts: `u32 BE count || frames`. Used for roster
    /// dumps (HELLO full-dump stand-in) and the persisted fact store.
    pub fn encode_all<'a>(
        items: impl IntoIterator<Item = &'a SignedFact>,
    ) -> Result<Vec<u8>, ProtocolError> {
        let frames: Vec<Vec<u8>> = items
            .into_iter()
            .map(Self::encode)
            .collect::<Result<_, _>>()?;
        let mut out = Vec::with_capacity(4 + frames.iter().map(Vec::len).sum::<usize>());
        out.extend_from_slice(&(frames.len() as u32).to_be_bytes());
        for frame in frames {
            out.extend_from_slice(&frame);
        }
        Ok(out)
    }

    /// Strict inverse of [`SignedFact::encode_all`].
    pub fn decode_all(bytes: &[u8]) -> Result<Vec<SignedFact>, ProtocolError> {
        if bytes.len() < 4 {
            return Err(quarantine(
                "fact list shorter than the u32 count prefix".to_owned(),
            ));
        }
        let count = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
        // Never pre-allocate by an attacker-controlled count.
        let mut out = Vec::new();
        let mut off = 4usize;
        for i in 0..count {
            if bytes.len() < off + 4 {
                return Err(quarantine(format!(
                    "fact list truncated at item {i}'s length prefix"
                )));
            }
            let frame_len =
                u32::from_be_bytes([bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]])
                    as usize;
            let frame_end = off
                .checked_add(4)
                .and_then(|v| v.checked_add(frame_len))
                .and_then(|v| v.checked_add(Signature::LENGTH))
                .ok_or_else(|| quarantine("fact list length overflow".to_owned()))?;
            if bytes.len() < frame_end {
                return Err(quarantine(format!("fact list truncated inside item {i}")));
            }
            out.push(Self::decode(&bytes[off..frame_end])?);
            off = frame_end;
        }
        if off != bytes.len() {
            return Err(quarantine(format!(
                "{} trailing byte(s) after fact list",
                bytes.len() - off
            )));
        }
        Ok(out)
    }

    /// Human-readable JSON projection for debugging and inspection.
    /// **Not** a canonical format.
    pub fn to_json_string(&self) -> Result<String, ProtocolError> {
        let v = serde_json::json!({
            "fact_id": hex_str(&self.fact_id()),
            "kind": self.fact.kind.as_str(),
            "fabric_id": self.fact.fabric_id.to_string(),
            "issuer": self.fact.issuer.to_z32(),
            "subject": self.fact.subject.to_z32(),
            "display_name": self.fact.display_name,
            "issued_at_ms": self.fact.issued_at_ms,
            "expires_at_ms": self.fact.expires_at_ms,
            "target_fact_id": self.fact.target_fact_id.map(|t| hex_str(&t)),
            "signature": hex_str(&self.signature.to_bytes()),
        });
        serde_json::to_string(&v).map_err(ProtocolError::Json)
    }
}

/// Builds the fabric's Genesis fact: kind=Genesis, issuer=subject=root,
/// signed by the root identity. This is the single trust root of the fabric.
pub fn genesis(
    identity: &NodeIdentity,
    fabric_id: FabricId,
    now_ms: u64,
) -> Result<SignedFact, ProtocolError> {
    let fact = Fact {
        kind: FactKind::Genesis,
        fabric_id,
        issuer: identity.endpoint_id(),
        subject: identity.endpoint_id(),
        display_name: None,
        issued_at_ms: now_ms,
        expires_at_ms: None,
        target_fact_id: None,
    };
    SignedFact::sign(fact, identity.secret_key())
}

/// The self-contained invite payload (see module docs for the layout).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InviteV1 {
    /// The fabric this invite admits into.
    pub fabric_id: FabricId,
    /// Random 16-byte one-time capability id (CAS-consumed at redemption).
    pub invite_id: [u8; 16],
    /// The inviter (v0.1: must be the fabric root).
    pub issuer: EndpointId,
    /// The issuer's relay URL (how to reach the issuer for redemption).
    pub issuer_relay_url: String,
    /// Optional direct addresses of the issuer (≤ 4, each ≤ 64 bytes).
    pub issuer_direct_addrs: Vec<String>,
    /// Unix epoch milliseconds after which the token is dead.
    pub expires_at_ms: u64,
    /// Optional pre-bound recipient (redeem PoP must come from exactly this
    /// EndpointId).
    pub recipient: Option<EndpointId>,
}

impl InviteV1 {
    /// Canonical bytes (domain-separated, explicit lengths; see module docs).
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, ProtocolError> {
        if self.issuer_relay_url.len() > MAX_RELAY_URL_BYTES {
            return Err(ProtocolError::Encoding(format!(
                "relay URL of {} bytes exceeds the {} byte limit",
                self.issuer_relay_url.len(),
                MAX_RELAY_URL_BYTES
            )));
        }
        if self.issuer_direct_addrs.len() > MAX_DIRECT_ADDRS {
            return Err(ProtocolError::Encoding(format!(
                "{} direct addrs exceeds the limit of {MAX_DIRECT_ADDRS}",
                self.issuer_direct_addrs.len()
            )));
        }
        for addr in &self.issuer_direct_addrs {
            if addr.len() > MAX_DIRECT_ADDR_BYTES {
                return Err(ProtocolError::Encoding(format!(
                    "direct addr of {} bytes exceeds the {MAX_DIRECT_ADDR_BYTES} byte limit",
                    addr.len()
                )));
            }
        }
        let mut buf = Vec::with_capacity(INVITE_MIN_LEN + self.issuer_relay_url.len());
        buf.extend_from_slice(INVITE_DOMAIN);
        buf.push(INVITE_VERSION);
        buf.extend_from_slice(self.fabric_id.as_bytes());
        buf.extend_from_slice(&self.invite_id);
        buf.extend_from_slice(self.issuer.as_bytes());
        buf.extend_from_slice(&(self.issuer_relay_url.len() as u16).to_be_bytes());
        buf.extend_from_slice(self.issuer_relay_url.as_bytes());
        buf.push(self.issuer_direct_addrs.len() as u8);
        for addr in &self.issuer_direct_addrs {
            buf.push(addr.len() as u8);
            buf.extend_from_slice(addr.as_bytes());
        }
        buf.extend_from_slice(&self.expires_at_ms.to_be_bytes());
        buf.push(if self.recipient.is_some() { 1 } else { 0 });
        if let Some(recipient) = self.recipient {
            buf.extend_from_slice(recipient.as_bytes());
        }
        buf.push(1); // max_uses, fixed at 1
        Ok(buf)
    }

    /// Strict parse of exactly one canonical invite.
    pub fn decode_strict(bytes: &[u8]) -> Result<Self, ProtocolError> {
        let trunc = |what: &str| quarantine(format!("truncated canonical invite: {what}"));
        if bytes.len() < INVITE_MIN_LEN {
            return Err(trunc("shorter than the fixed prefix"));
        }
        if &bytes[..INVITE_DOMAIN.len()] != INVITE_DOMAIN {
            return Err(quarantine(format!(
                "bad invite domain {bytes:?} (expected {INVITE_DOMAIN:?})"
            )));
        }
        if bytes[15] != INVITE_VERSION {
            return Err(quarantine(format!(
                "unsupported invite version 0x{:02x}",
                bytes[15]
            )));
        }
        let fabric_id = FabricId(bytes[16..48].try_into().expect("slice len 32"));
        let invite_id = bytes[48..64].try_into().expect("slice len 16");
        let issuer = key_from_bytes(&bytes[64..96])?;
        let mut off = INVITE_FIXED_LEN;
        if bytes.len() < off + 2 {
            return Err(trunc("relay URL length prefix"));
        }
        let relay_len = u16::from_be_bytes([bytes[off], bytes[off + 1]]) as usize;
        off += 2;
        if relay_len > MAX_RELAY_URL_BYTES {
            return Err(quarantine(format!(
                "relay URL of {relay_len} bytes exceeds the {MAX_RELAY_URL_BYTES} byte limit"
            )));
        }
        if bytes.len() < off + relay_len {
            return Err(trunc("relay URL bytes"));
        }
        let issuer_relay_url = std::str::from_utf8(&bytes[off..off + relay_len])
            .map_err(|_| quarantine("relay URL is not valid UTF-8"))?
            .to_owned();
        off += relay_len;
        if bytes.len() < off + 1 {
            return Err(trunc("direct addr count"));
        }
        let n_addrs = bytes[off] as usize;
        off += 1;
        if n_addrs > MAX_DIRECT_ADDRS {
            return Err(quarantine(format!(
                "{n_addrs} direct addrs exceeds the limit of {MAX_DIRECT_ADDRS}"
            )));
        }
        let mut issuer_direct_addrs = Vec::with_capacity(n_addrs);
        for _ in 0..n_addrs {
            if bytes.len() < off + 1 {
                return Err(trunc("direct addr length prefix"));
            }
            let addr_len = bytes[off] as usize;
            off += 1;
            if addr_len > MAX_DIRECT_ADDR_BYTES {
                return Err(quarantine(format!(
                    "direct addr of {addr_len} bytes exceeds the {MAX_DIRECT_ADDR_BYTES} byte limit"
                )));
            }
            if bytes.len() < off + addr_len {
                return Err(trunc("direct addr bytes"));
            }
            let addr = std::str::from_utf8(&bytes[off..off + addr_len])
                .map_err(|_| quarantine("direct addr is not valid UTF-8"))?
                .to_owned();
            off += addr_len;
            issuer_direct_addrs.push(addr);
        }
        if bytes.len() < off + 8 + 1 {
            return Err(trunc("expires_at_ms / flags"));
        }
        let expires_at_ms =
            u64::from_be_bytes(bytes[off..off + 8].try_into().expect("slice len 8"));
        off += 8;
        let flags = bytes[off];
        off += 1;
        if flags > 1 {
            return Err(quarantine(format!(
                "reserved invite flag bits: 0x{flags:02x}"
            )));
        }
        let recipient = if flags == 1 {
            if bytes.len() < off + 32 {
                return Err(trunc("recipient"));
            }
            let r = key_from_bytes(&bytes[off..off + 32])?;
            off += 32;
            Some(r)
        } else {
            None
        };
        if bytes.len() != off + 1 {
            return Err(quarantine(format!(
                "invite length mismatch: expected {} bytes, got {}",
                off + 1,
                bytes.len()
            )));
        }
        let max_uses = bytes[off];
        if max_uses != 1 {
            return Err(quarantine(format!(
                "invite max_uses must be 1, got {max_uses}"
            )));
        }
        Ok(Self {
            fabric_id,
            invite_id,
            issuer,
            issuer_relay_url,
            issuer_direct_addrs,
            expires_at_ms,
            recipient,
        })
    }

    /// Whether the invite is expired at `now_ms` (expired at the exact
    /// instant of its expiry).
    pub fn is_expired(&self, now_ms: u64) -> bool {
        now_ms >= self.expires_at_ms
    }
}

/// An [`InviteV1`] plus the issuer's signature, rendered as the
/// `dweb1.<base64url-nopad>` token string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InviteToken {
    /// The invite payload.
    pub invite: InviteV1,
    /// The issuer's signature over the invite's canonical bytes.
    pub signature: Signature,
}

impl InviteToken {
    /// Signs `invite` with `secret` (the issuer's key).
    pub fn sign(invite: InviteV1, secret: &SecretKey) -> Result<Self, ProtocolError> {
        let signature = secret.sign(&invite.canonical_bytes()?);
        Ok(Self { invite, signature })
    }

    /// Renders the token string: `dweb1.` + base64url-nopad of
    /// `InviteV1 canonical bytes || signature`.
    pub fn encode(&self) -> Result<String, ProtocolError> {
        let mut payload = self.invite.canonical_bytes()?;
        payload.extend_from_slice(&self.signature.to_bytes());
        Ok(format!(
            "{TOKEN_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(&payload)
        ))
    }

    /// Parses a token string and validates the version header, all lengths
    /// and the issuer signature (anything malformed is
    /// [`ProtocolError::Quarantine`]).
    pub fn decode(s: &str) -> Result<Self, ProtocolError> {
        let b64 = s
            .strip_prefix(TOKEN_PREFIX)
            .ok_or_else(|| quarantine(format!("token does not start with {TOKEN_PREFIX:?}")))?;
        let payload = URL_SAFE_NO_PAD
            .decode(b64)
            .map_err(|e| quarantine(format!("token base64 decoding failed: {e}")))?;
        if payload.len() < Signature::LENGTH {
            return Err(quarantine(
                "token payload shorter than a signature".to_owned(),
            ));
        }
        let split = payload.len() - Signature::LENGTH;
        let invite = InviteV1::decode_strict(&payload[..split])?;
        let signature = Signature::from_bytes(payload[split..].try_into().expect("slice len 64"));
        let token = Self { invite, signature };
        token
            .verify()
            .map_err(|_| quarantine("invite token signature verification failed".to_owned()))?;
        Ok(token)
    }

    /// Verifies the embedded signature against the embedded issuer id.
    pub fn verify(&self) -> Result<(), ProtocolError> {
        let bytes = self.invite.canonical_bytes()?;
        self.invite
            .issuer
            .verify(&bytes, &self.signature)
            .map_err(|_| quarantine("invite signature verification failed".to_owned()))
    }

    /// Whether the invite is expired at `now_ms`.
    pub fn is_expired(&self, now_ms: u64) -> bool {
        self.invite.is_expired(now_ms)
    }
}

/// The exact bytes the invitee must sign to prove possession of their
/// EndpointId's private key during redemption:
/// `b"dweb/redeem-pop/v1\0" || fabric_id || invite_id || challenge`.
pub fn redeem_challenge_bytes(
    fabric_id: &FabricId,
    invite_id: &[u8; 16],
    challenge: &[u8; 32],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(POP_DOMAIN.len() + 32 + 16 + 32);
    out.extend_from_slice(POP_DOMAIN);
    out.extend_from_slice(fabric_id.as_bytes());
    out.extend_from_slice(invite_id);
    out.extend_from_slice(challenge);
    out
}

/// Parses 32 raw bytes into an `EndpointId`, rejecting non-key bytes.
fn key_from_bytes(bytes: &[u8]) -> Result<EndpointId, ProtocolError> {
    EndpointId::from_bytes(
        bytes
            .try_into()
            .map_err(|_| quarantine("key field is not 32 bytes".to_owned()))?,
    )
    .map_err(|_| quarantine("key field is not a valid Ed25519 public key".to_owned()))
}

fn hex_str(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod round3_regress {
    use super::*;

    fn mk_invite_bytes(tail_len: usize) -> Vec<u8> {
        // 域前缀 + 版本 + fabric/invite/issuer 定长段，尾部截到 tail_len
        let mut v = Vec::new();
        v.extend_from_slice(b"dweb/invite/v1\0");
        v.push(1);
        v.extend_from_slice(&[3u8; 32]);
        v.extend_from_slice(&[4u8; 16]);
        v.extend_from_slice(&[5u8; 32]);
        v.truncate(16 + 1 + tail_len.min(v.len() - 17));
        v
    }

    #[test]
    fn malformed_invite_never_panics_only_quarantine() {
        // 在固定头之后逐字节截断：任何前缀都必须 Err，绝不 panic
        let base = mk_invite_bytes(usize::MAX);
        for cut in 0..base.len() {
            let sliced = &base[..cut];
            let r = std::panic::catch_unwind(|| InviteV1::decode_strict(sliced));
            assert!(r.is_ok(), "panic at cut={cut}");
            assert!(r.unwrap().is_err(), "must error at cut={cut}");
        }
        // relay 长度前缀边界：截到刚好缺 2 字节
        let mut b = base.clone();
        b.truncate(INVITE_FIXED_LEN);
        assert!(InviteV1::decode_strict(&b).is_err());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::endpoint_id_display;

    fn idty(seed: u8) -> NodeIdentity {
        NodeIdentity::from_seed([seed; 32])
    }

    fn sample_fact(display_name: Option<String>, expires_at_ms: Option<u64>) -> Fact {
        let issuer = idty(1);
        let subject = idty(2);
        Fact {
            kind: FactKind::Grant,
            fabric_id: FabricId::from_name("test-fabric"),
            issuer: issuer.endpoint_id(),
            subject: subject.endpoint_id(),
            display_name,
            issued_at_ms: 1_700_000_000_123,
            expires_at_ms,
            target_fact_id: None,
        }
    }

    #[test]
    fn canonical_bytes_are_deterministic_across_construction_paths() {
        // Path 1: literal struct with a &str-derived name.
        let f1 = sample_fact(Some("卡罗尔".to_owned()), Some(999));
        // Path 2: same field values, different String allocation.
        let f2 = {
            let mut f = f1.clone();
            f.display_name = Some(format!("卡{}", "罗尔"));
            f.expires_at_ms = Some(900 + 99);
            f
        };
        // Path 3: decode(encode(f1)) then re-encode.
        let f3 = Fact::decode_strict(&f1.canonical_bytes().unwrap()).unwrap();

        let b1 = f1.canonical_bytes().unwrap();
        assert_eq!(b1, f2.canonical_bytes().unwrap());
        assert_eq!(b1, f3.canonical_bytes().unwrap());
    }

    #[test]
    fn canonical_layout_offsets_match_documentation() {
        let f = sample_fact(Some("ab".to_owned()), None);
        let b = f.canonical_bytes().unwrap();
        assert_eq!(&b[0..13], b"dweb/fact/v1\0");
        assert_eq!(b[13], KIND_GRANT);
        assert_eq!(&b[14..46], f.fabric_id.as_bytes());
        assert_eq!(&b[46..78], f.issuer.as_bytes());
        assert_eq!(&b[78..110], f.subject.as_bytes());
        assert_eq!(
            u64::from_be_bytes(b[110..118].try_into().unwrap()),
            f.issued_at_ms
        );
        assert_eq!(b[118], FLAG_HAS_NAME);
        assert_eq!(u16::from_be_bytes(b[119..121].try_into().unwrap()), 2);
        assert_eq!(&b[121..123], b"ab");
        assert_eq!(b.len(), FACT_FIXED_LEN + 2 + 2);

        // No optionals at all.
        let bare = sample_fact(None, None).canonical_bytes().unwrap();
        assert_eq!(bare.len(), FACT_FIXED_LEN);
        assert_eq!(bare[118], 0);
        // Only expiry.
        let exp_only = sample_fact(None, Some(7)).canonical_bytes().unwrap();
        assert_eq!(exp_only.len(), FACT_FIXED_LEN + 8);
        assert_eq!(exp_only[118], FLAG_HAS_EXPIRY);
        // Only target (Revoke shape).
        let mut target_only = sample_fact(None, None);
        target_only.kind = FactKind::Revoke;
        target_only.target_fact_id = Some([9u8; 32]);
        let t = target_only.canonical_bytes().unwrap();
        assert_eq!(t.len(), FACT_FIXED_LEN + 32);
        assert_eq!(t[118], FLAG_HAS_TARGET);
        assert_eq!(&t[FACT_FIXED_LEN..FACT_FIXED_LEN + 32], &[9u8; 32]);
    }

    #[test]
    fn fact_id_is_content_addressed_and_idempotent() {
        let f = sample_fact(Some("n".to_owned()), None);
        let g = sample_fact(Some("n".to_owned()), None);
        // Same content -> same id, any number of times (idempotent).
        assert_eq!(f.fact_id(), g.fact_id());
        assert_eq!(f.fact_id(), f.fact_id());
        // Any field change -> different id.
        for mutated in [
            Fact {
                issued_at_ms: f.issued_at_ms + 1,
                ..f.clone()
            },
            Fact {
                display_name: Some("m".to_owned()),
                ..f.clone()
            },
            Fact {
                kind: FactKind::Join,
                ..f.clone()
            },
            Fact {
                fabric_id: FabricId::from_name("other"),
                ..f.clone()
            },
        ] {
            assert_ne!(f.fact_id(), mutated.fact_id());
        }
        // Id equals BLAKE3 of the canonical bytes.
        assert_eq!(
            f.fact_id(),
            *blake3::hash(&f.canonical_bytes().unwrap()).as_bytes()
        );
    }

    #[test]
    fn canonical_roundtrip_all_option_combinations() {
        for name in [None, Some("名字".to_owned()), Some(String::new())] {
            for exp in [None, Some(u64::MAX), Some(0)] {
                for target in [None, Some([5u8; 32]), Some([0u8; 32])] {
                    let f = Fact {
                        display_name: name.clone(),
                        expires_at_ms: exp,
                        target_fact_id: target,
                        ..sample_fact(None, None)
                    };
                    let b = f.canonical_bytes().unwrap();
                    let back = Fact::decode_strict(&b).unwrap();
                    assert_eq!(back, f, "roundtrip failed for {f:?}");
                }
            }
        }
    }

    #[test]
    fn decode_rejects_non_canonical_and_corrupt_bytes() {
        let good = sample_fact(Some("name".to_owned()), Some(5))
            .canonical_bytes()
            .unwrap();

        // Truncation at every length.
        for len in 0..good.len() {
            assert!(
                Fact::decode_strict(&good[..len]).is_err(),
                "decoding {len} bytes should fail"
            );
        }

        // Trailing garbage.
        let mut trailing = good.clone();
        trailing.push(0);
        assert!(Fact::decode_strict(&trailing).is_err());

        // Bad domain / kind / flags.
        for (pos, bad) in [
            (0, b"XWEB/FACT/V1".to_vec()),
            (13, vec![0x00]),
            (13, vec![0x05]),
            (13, vec![0xff]),
            (118, vec![0b1000_0000]),
            (118, vec![0xff]),
        ] {
            let mut m = good.clone();
            m[pos..pos + bad.len()].copy_from_slice(&bad);
            let err = Fact::decode_strict(&m).unwrap_err();
            assert!(
                matches!(err, ProtocolError::Quarantine { .. }),
                "pos {pos} bad {bad:?} gave {err:?}"
            );
        }

        // Name length lying about the actual content length.
        let mut liar = good.clone();
        liar[119] = 0xff;
        liar[120] = 0xff;
        assert!(Fact::decode_strict(&liar).is_err());

        // Non-UTF-8 name bytes.
        let mut bad_utf8 = good.clone();
        bad_utf8[121] = 0xff;
        bad_utf8[122] = 0xfe;
        assert!(Fact::decode_strict(&bad_utf8).is_err());
    }

    #[test]
    fn oversized_name_is_rejected() {
        let mut f = sample_fact(None, None);
        f.display_name = Some("x".repeat(MAX_NAME_BYTES + 1));
        assert!(matches!(
            f.canonical_bytes(),
            Err(ProtocolError::Encoding(_))
        ));
        // The decode side also enforces the cap.
        let mut ok = sample_fact(Some("y".repeat(MAX_NAME_BYTES)), None)
            .canonical_bytes()
            .unwrap();
        // Rewrite the length prefix to claim MAX+1 with truncated body.
        let n = MAX_NAME_BYTES + 1;
        ok[119..121].copy_from_slice(&(n as u16).to_be_bytes());
        ok.truncate(119 + 2 + MAX_NAME_BYTES);
        assert!(matches!(
            Fact::decode_strict(&ok),
            Err(ProtocolError::Quarantine { .. })
        ));
    }

    #[test]
    fn sign_and_verify_roundtrip() {
        let issuer = idty(1);
        let f = sample_fact(None, None);
        let sf = SignedFact::sign(f.clone(), issuer.secret_key()).unwrap();
        sf.verify().unwrap();

        // Any other key fails.
        let other = idty(3);
        let mut forged = sf.clone();
        forged.signature = other.secret_key().sign(&f.canonical_bytes().unwrap());
        assert!(forged.verify().is_err());
    }

    #[test]
    fn tampered_fact_or_signature_fails_verification() {
        let issuer = idty(1);
        let base = sample_fact(Some("n".to_owned()), Some(10));
        let sf = SignedFact::sign(base.clone(), issuer.secret_key()).unwrap();

        // Tamper with each field of the fact: the signature must stop matching.
        for mutated in [
            Fact {
                kind: FactKind::Revoke,
                ..base.clone()
            },
            Fact {
                fabric_id: FabricId::from_name("evil"),
                ..base.clone()
            },
            Fact {
                issuer: idty(4).endpoint_id(),
                ..base.clone()
            },
            Fact {
                subject: idty(5).endpoint_id(),
                ..base.clone()
            },
            Fact {
                display_name: Some("evil".to_owned()),
                ..base.clone()
            },
            Fact {
                issued_at_ms: base.issued_at_ms + 1,
                ..base.clone()
            },
            Fact {
                expires_at_ms: Some(11),
                ..base.clone()
            },
            Fact {
                target_fact_id: Some([1u8; 32]),
                ..base.clone()
            },
        ] {
            let t = SignedFact {
                fact: mutated,
                signature: sf.signature,
            };
            let err = t.verify().unwrap_err();
            assert!(
                matches!(err, ProtocolError::Quarantine { .. }),
                "tampered fact must quarantine, got {err:?}"
            );
        }

        // Tampered signature bytes.
        let mut bad_sig = sf.signature.to_bytes();
        bad_sig[0] ^= 1;
        let t = SignedFact {
            fact: base,
            signature: Signature::from_bytes(&bad_sig),
        };
        assert!(t.verify().is_err());
    }

    #[test]
    fn signed_fact_wire_roundtrip_and_strictness() {
        let issuer = idty(1);
        let f = sample_fact(Some("w".to_owned()), None);
        let sf = SignedFact::sign(f, issuer.secret_key()).unwrap();
        let wire = sf.encode().unwrap();
        let back = SignedFact::decode(&wire).unwrap();
        assert_eq!(back, sf);
        assert!(back.verify().is_ok());

        // Truncated / trailing.
        assert!(SignedFact::decode(&wire[..wire.len() - 1]).is_err());
        let mut trailing = wire.clone();
        trailing.push(0);
        assert!(SignedFact::decode(&trailing).is_err());
        // Lying length prefix (overshoot and undershoot).
        let mut liar = wire.clone();
        liar[3] += 10;
        assert!(SignedFact::decode(&liar).is_err());
        let mut liar2 = wire;
        liar2[3] -= 1;
        assert!(SignedFact::decode(&liar2).is_err());
    }

    #[test]
    fn signed_fact_list_roundtrip() {
        let issuer = idty(1);
        let facts: Vec<SignedFact> = (0..5)
            .map(|i| {
                let f = Fact {
                    display_name: Some(format!("m{i}")),
                    issued_at_ms: i,
                    expires_at_ms: Some(i),
                    ..sample_fact(None, None)
                };
                SignedFact::sign(f, issuer.secret_key()).unwrap()
            })
            .collect();
        let bytes = SignedFact::encode_all(&facts).unwrap();
        let back = SignedFact::decode_all(&bytes).unwrap();
        assert_eq!(back, facts);
        // Trailing garbage rejected.
        let mut bad = bytes.clone();
        bad.push(1);
        assert!(SignedFact::decode_all(&bad).is_err());
        // Count lying.
        let mut liar = bytes;
        liar[3] += 10;
        assert!(SignedFact::decode_all(&liar).is_err());
    }

    #[test]
    fn genesis_helper_builds_self_signed_root_fact() {
        let root = idty(1);
        let fid = FabricId::from_name("genesis-test");
        let g = genesis(&root, fid, 42).unwrap();
        assert_eq!(g.fact.kind, FactKind::Genesis);
        assert_eq!(g.fact.issuer, root.endpoint_id());
        assert_eq!(g.fact.subject, root.endpoint_id());
        assert_eq!(g.fact.fabric_id, fid);
        assert_eq!(g.fact.issued_at_ms, 42);
        assert!(g.fact.expires_at_ms.is_none());
        g.verify().unwrap();
    }

    #[test]
    fn fabric_id_derivation() {
        assert_eq!(FabricId::from_name("home"), FabricId::from_name("home"));
        assert_ne!(FabricId::from_name("home"), FabricId::from_name("away"));
        assert_ne!(FabricId::random(), FabricId::random());
    }

    fn sample_invite(recipient: Option<EndpointId>) -> InviteV1 {
        InviteV1 {
            fabric_id: FabricId::from_name("invite-test"),
            invite_id: [7u8; 16],
            issuer: idty(1).endpoint_id(),
            issuer_relay_url: "https://relay.example.com".to_owned(),
            issuer_direct_addrs: vec!["192.168.1.4:1234".to_owned()],
            expires_at_ms: 60_000,
            recipient,
        }
    }

    #[test]
    fn invite_token_roundtrip() {
        let issuer = idty(1);
        let invite = sample_invite(Some(idty(2).endpoint_id()));
        let token = InviteToken::sign(invite.clone(), issuer.secret_key()).unwrap();

        let s = token.encode().unwrap();
        assert!(s.starts_with("dweb1."));
        assert!(
            !s.contains('+') && !s.contains('/') && !s.contains('='),
            "base64url-nopad only"
        );
        let back = InviteToken::decode(&s).unwrap();
        assert_eq!(back, token);
        assert!(back.verify().is_ok());
        assert_eq!(back.invite, invite);
        assert!(!back.is_expired(59_999));
        assert!(back.is_expired(60_000), "expired at the exact instant");
    }

    #[test]
    fn invite_decode_rejects_malformed_strings_and_bad_signatures() {
        let issuer = idty(1);
        let token = InviteToken::sign(sample_invite(None), issuer.secret_key()).unwrap();
        let good = token.encode().unwrap();

        // Wrong / missing prefix, non-base64, truncation.
        assert!(InviteToken::decode(&good[1..]).is_err());
        assert!(InviteToken::decode(&good.replace("dweb1.", "dweb2.")).is_err());
        assert!(InviteToken::decode(&format!("{TOKEN_PREFIX}!!!!")).is_err());
        assert!(InviteToken::decode(&good[..good.len() - 8]).is_err());

        let raw = URL_SAFE_NO_PAD
            .decode(good.strip_prefix(TOKEN_PREFIX).unwrap())
            .unwrap();
        // Structural corruption: flip a byte inside the domain header.
        let mut evil = raw.clone();
        evil[0] = b'X';
        assert!(
            InviteToken::decode(&format!("{TOKEN_PREFIX}{}", URL_SAFE_NO_PAD.encode(evil)))
                .is_err()
        );
        // Tampered payload byte: structure still parses, signature must fail.
        let mut evil = raw;
        let body_len = evil.len() - Signature::LENGTH;
        evil[body_len - 1] ^= 1;
        assert!(
            InviteToken::decode(&format!("{TOKEN_PREFIX}{}", URL_SAFE_NO_PAD.encode(evil)))
                .is_err(),
            "tampered invite must fail signature check at decode"
        );
        // A second valid key signing over the same bytes must not verify
        // against the embedded issuer.
        let mut other_signed = token.clone();
        other_signed.signature = idty(9)
            .secret_key()
            .sign(&token.invite.canonical_bytes().unwrap());
        assert!(other_signed.verify().is_err());
    }

    #[test]
    fn invite_limits_are_enforced() {
        // Too many direct addrs.
        let mut inv = sample_invite(None);
        inv.issuer_direct_addrs = (0..=MAX_DIRECT_ADDRS)
            .map(|i| format!("10.0.0.1:{i}"))
            .collect();
        assert!(matches!(
            inv.canonical_bytes(),
            Err(ProtocolError::Encoding(_))
        ));
        // One addr too long.
        let mut inv = sample_invite(None);
        inv.issuer_direct_addrs = vec!["x".repeat(MAX_DIRECT_ADDR_BYTES + 1)];
        assert!(matches!(
            inv.canonical_bytes(),
            Err(ProtocolError::Encoding(_))
        ));
        // Relay URL too long.
        let mut inv = sample_invite(None);
        inv.issuer_relay_url = "x".repeat(MAX_RELAY_URL_BYTES + 1);
        assert!(matches!(
            inv.canonical_bytes(),
            Err(ProtocolError::Encoding(_))
        ));
        // max_uses tampering on the wire is rejected by decode.
        let issuer = idty(1);
        let token = InviteToken::sign(sample_invite(None), issuer.secret_key()).unwrap();
        let raw = URL_SAFE_NO_PAD
            .decode(token.encode().unwrap().strip_prefix(TOKEN_PREFIX).unwrap())
            .unwrap();
        let mut evil = raw;
        let last = evil.len() - Signature::LENGTH - 1; // max_uses byte
        evil[last] = 2;
        assert!(
            InviteToken::decode(&format!("{TOKEN_PREFIX}{}", URL_SAFE_NO_PAD.encode(evil)))
                .is_err()
        );
    }

    #[test]
    fn pop_challenge_material_is_domain_separated() {
        let fid = FabricId::from_name("pop-test");
        let iid = [3u8; 16];
        let challenge = [4u8; 32];
        let bytes = redeem_challenge_bytes(&fid, &iid, &challenge);
        assert_eq!(&bytes[..POP_DOMAIN.len()], POP_DOMAIN);
        let after_domain = POP_DOMAIN.len();
        assert_eq!(
            &bytes[after_domain..after_domain + 32],
            fid.as_bytes(),
            "fabric_id follows the domain"
        );
        assert_eq!(
            &bytes[after_domain + 32..after_domain + 48],
            iid,
            "invite_id follows the fabric_id"
        );
        assert_eq!(
            &bytes[after_domain + 48..],
            challenge,
            "challenge is the tail"
        );
        assert_eq!(bytes.len(), POP_DOMAIN.len() + 32 + 16 + 32);
        // Different fabric or invite or challenge -> different bytes.
        assert_ne!(
            bytes,
            redeem_challenge_bytes(&FabricId::from_name("other"), &iid, &challenge)
        );
        assert_ne!(bytes, redeem_challenge_bytes(&fid, &[0u8; 16], &challenge));
        assert_ne!(bytes, redeem_challenge_bytes(&fid, &iid, &[0u8; 32]));

        // B signs the material; anyone with B's public key verifies.
        let b = idty(2);
        let sig = b.secret_key().sign(&bytes);
        b.endpoint_id().verify(&bytes, &sig).unwrap();
        assert!(idty(3).endpoint_id().verify(&bytes, &sig).is_err());
    }

    #[test]
    fn debug_json_projection_mentions_content_address() {
        let issuer = idty(1);
        let sf = SignedFact::sign(
            sample_fact(Some("名字".to_owned()), Some(42)),
            issuer.secret_key(),
        )
        .unwrap();
        let json = sf.to_json_string().unwrap();
        assert!(json.contains(&hex_str(&sf.fact_id())));
        assert!(json.contains(&endpoint_id_display(&sf.fact.issuer)));
    }
}
