//! Wire and canonical formats for membership facts, signatures and invite
//! tokens (fabric spec: "签名事实模型" / "邀请令牌签发与兑换").
//!
//! # Canonical byte layout of [`Fact`] (v1)
//!
//! All integers are big-endian. The layout is a fixed-position prefix
//! followed by optional length-prefixed fields in a fixed order, so encoding
//! is a pure function of the field values — no dictionary ordering or
//! writer-dependent ambiguity. This byte string (and only this byte string)
//! is what gets signed.
//!
//! ```text
//! offset  size  field
//! 0       9     magic           b"dweb-fact"
//! 9       1     layout version  0x01
//! 10      1     kind            1=Grant, 2=Join, 3=Revoke
//! 11      16    id              fact id (UUIDv7 bytes, as-is)
//! 27      32    issuer          EndpointId (raw Ed25519 public key)
//! 59      32    subject         EndpointId
//! 91      8     issued_at_ms    unix epoch milliseconds
//! 99      1     flags           bit0: display_name present
//!                               bit1: expires_at_ms present (all other bits 0)
//! 100     ..    if bit0: u16 name_len || name_len bytes of UTF-8
//! ..      ..    if bit1: u64 expires_at_ms
//! ```
//!
//! [`Fact::decode_canonical`] is strict: it rejects bad magic/version,
//! unknown kinds, reserved flag bits, truncation, length mismatch,
//! non-UTF-8 names and trailing bytes. A fact that decodes is therefore
//! always in canonical form, and re-encoding is byte-identical.
//!
//! # Wire encodings
//!
//! - [`SignedFact`]: `u32 BE fact_len || canonical fact bytes || 64B signature`.
//! - [`SignedFact::encode_all`]/[`SignedFact::decode_all`]: `u32 BE count`
//!   followed by that many `SignedFact` wire encodings (roster dumps).
//! - [`InviteToken`]: `dweb1.` + base64url-nopad of
//!   `canonical fact || 64B signature || rendezvous hint bytes`.

use std::fmt;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use thiserror::Error;

use crate::identity::EndpointId;

/// Magic + layout version prefix of canonical fact bytes.
const MAGIC: &[u8; 9] = b"dweb-fact";
const LAYOUT_VERSION: u8 = 0x01;
/// Length of everything before the optional fields (see module docs).
const FIXED_LEN: usize = 100;

const KIND_GRANT: u8 = 1;
const KIND_JOIN: u8 = 2;
const KIND_REVOKE: u8 = 3;

const FLAG_HAS_NAME: u8 = 0b01;
const FLAG_HAS_EXPIRY: u8 = 0b10;

/// Version prefix of invite token strings.
pub const TOKEN_PREFIX: &str = "dweb1.";

/// Errors from canonical encoding/decoding, signatures and tokens.
#[derive(Debug, Error)]
pub enum ProtocolError {
    /// A field cannot be represented in the canonical layout.
    #[error("canonical encoding error: {0}")]
    Encoding(String),
    /// Bytes do not form a valid canonical structure.
    #[error("canonical decoding error: {0}")]
    Decoding(String),
    /// The issuer bytes inside a fact are not a valid Ed25519 public key.
    #[error("invalid issuer verifying key: {0}")]
    InvalidIssuerKey(#[source] ed25519_dalek::SignatureError),
    /// Signature verification failed.
    #[error("signature verification failed: {0}")]
    BadSignature(#[source] ed25519_dalek::SignatureError),
    /// Base64 (token) decoding failed.
    #[error("base64 decoding failed: {0}")]
    Base64(#[source] base64::DecodeError),
    /// Debug JSON (de)serialization failed. JSON is *not* canonical.
    #[error("debug JSON error: {0}")]
    Json(#[source] serde_json::Error),
}

/// What a fact asserts about its subject.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum FactKind {
    /// Membership grant: issuer admits subject into the network.
    Grant = KIND_GRANT,
    /// Join acknowledgment: the joiner (issuer == subject) publicly accepts
    /// membership (typically countersigning a Grant from an invite token).
    Join = KIND_JOIN,
    /// Revocation: issuer removes subject's membership (see `roster` docs
    /// for the matching rules).
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
            KIND_GRANT => Some(Self::Grant),
            KIND_JOIN => Some(Self::Join),
            KIND_REVOKE => Some(Self::Revoke),
            _ => None,
        }
    }

    /// Stable name for debug JSON.
    pub const fn as_str(self) -> &'static str {
        match self {
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

/// An immutable membership fact. See the module docs for the canonical byte
/// layout and the signing contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fact {
    /// Unique fact id (UUIDv7 bytes). Generated by [`Fact::new`].
    pub id: [u8; 16],
    /// What this fact asserts.
    pub kind: FactKind,
    /// Signer's identity (== signing public key bytes).
    pub issuer: EndpointId,
    /// Who the fact is about.
    pub subject: EndpointId,
    /// Optional human-readable label for the subject.
    pub display_name: Option<String>,
    /// Unix epoch milliseconds when the fact was issued.
    pub issued_at_ms: u64,
    /// Unix epoch milliseconds after which the fact is inert.
    /// A fact is valid at `now` iff `expires_at_ms` is absent or `now < expires_at_ms`.
    pub expires_at_ms: Option<u64>,
}

impl Fact {
    /// Builds a fact with a fresh UUIDv7 id. `issued_at_ms` is supplied by
    /// the caller (keeps this layer testable and clock-free).
    pub fn new(
        kind: FactKind,
        issuer: EndpointId,
        subject: EndpointId,
        display_name: Option<String>,
        issued_at_ms: u64,
        expires_at_ms: Option<u64>,
    ) -> Fact {
        Fact {
            id: *uuid::Uuid::now_v7().as_bytes(),
            kind,
            issuer,
            subject,
            display_name,
            issued_at_ms,
            expires_at_ms,
        }
    }

    /// Whether this fact still has effect at `now_ms`.
    ///
    /// Valid iff no expiry is set, or `now_ms < expires_at_ms` (a fact is
    /// expired at the exact instant of its expiry).
    pub fn is_valid_at(&self, now_ms: u64) -> bool {
        self.expires_at_ms.is_none_or(|e| now_ms < e)
    }

    /// Deterministic canonical byte serialization (see module docs).
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, ProtocolError> {
        let name_len = self.display_name.as_ref().map(|n| n.len()).unwrap_or(0);
        if name_len > u16::MAX as usize {
            return Err(ProtocolError::Encoding(format!(
                "display_name of {name_len} bytes exceeds the u16 length prefix"
            )));
        }
        let mut buf =
            Vec::with_capacity(FIXED_LEN + if name_len > 0 { 2 + name_len } else { 0 } + 8);
        buf.extend_from_slice(MAGIC);
        buf.push(LAYOUT_VERSION);
        buf.push(self.kind.as_u8());
        buf.extend_from_slice(&self.id);
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
        buf.push(flags);
        if let Some(name) = &self.display_name {
            buf.extend_from_slice(&(name.len() as u16).to_be_bytes());
            buf.extend_from_slice(name.as_bytes());
        }
        if let Some(exp) = self.expires_at_ms {
            buf.extend_from_slice(&exp.to_be_bytes());
        }
        Ok(buf)
    }

    /// Strict parse: the input must be exactly one canonical fact (no
    /// trailing bytes).
    pub fn decode_canonical(bytes: &[u8]) -> Result<Fact, ProtocolError> {
        let (fact, consumed) = Fact::parse_canonical_prefix(bytes)?;
        if consumed != bytes.len() {
            return Err(ProtocolError::Decoding(format!(
                "{} trailing byte(s) after canonical fact",
                bytes.len() - consumed
            )));
        }
        Ok(fact)
    }

    /// Parses a canonical fact from the front of `bytes`, returning the fact
    /// and the number of bytes consumed. Used by formats that embed the
    /// canonical bytes as a prefix (invite tokens).
    fn parse_canonical_prefix(bytes: &[u8]) -> Result<(Fact, usize), ProtocolError> {
        let trunc =
            |what: &str| ProtocolError::Decoding(format!("truncated canonical fact: {what}"));
        if bytes.len() < FIXED_LEN {
            return Err(trunc("shorter than the fixed 100-byte prefix"));
        }
        if &bytes[..MAGIC.len()] != MAGIC {
            return Err(ProtocolError::Decoding(format!(
                "bad magic {bytes:?} (expected {MAGIC:?})"
            )));
        }
        if bytes[9] != LAYOUT_VERSION {
            return Err(ProtocolError::Decoding(format!(
                "unsupported layout version 0x{:02x}",
                bytes[9]
            )));
        }
        let kind = FactKind::from_u8(bytes[10]).ok_or_else(|| {
            ProtocolError::Decoding(format!("unknown fact kind 0x{:02x}", bytes[10]))
        })?;
        let mut id = [0u8; 16];
        id.copy_from_slice(&bytes[11..27]);
        let issuer = EndpointId::from_bytes(bytes[27..59].try_into().expect("slice len 32"));
        let subject = EndpointId::from_bytes(bytes[59..91].try_into().expect("slice len 32"));
        let issued_at_ms = u64::from_be_bytes(bytes[91..99].try_into().expect("slice len 8"));
        let flags = bytes[99];
        if flags & !(FLAG_HAS_NAME | FLAG_HAS_EXPIRY) != 0 {
            return Err(ProtocolError::Decoding(format!(
                "reserved flag bits set: 0x{flags:02x}"
            )));
        }

        let mut off = FIXED_LEN;
        let display_name = if flags & FLAG_HAS_NAME != 0 {
            if bytes.len() < off + 2 {
                return Err(trunc("display_name length prefix"));
            }
            let name_len = u16::from_be_bytes([bytes[off], bytes[off + 1]]) as usize;
            off += 2;
            if bytes.len() < off + name_len {
                return Err(trunc("display_name bytes"));
            }
            let name = std::str::from_utf8(&bytes[off..off + name_len])
                .map_err(|_| ProtocolError::Decoding("display_name is not valid UTF-8".into()))?
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

        Ok((
            Fact {
                id,
                kind,
                issuer,
                subject,
                display_name,
                issued_at_ms,
                expires_at_ms,
            },
            off,
        ))
    }

    /// Signs the canonical bytes with `key`.
    ///
    /// `key` is expected to be the issuer's key (the signature proves
    /// possession of the private key matching `self.issuer`); the roster
    /// layer enforces how much trust that earns.
    pub fn sign(&self, key: &SigningKey) -> Result<[u8; 64], ProtocolError> {
        Ok(key.sign(&self.canonical_bytes()?).to_bytes())
    }

    /// Verifies `signature` over this fact's canonical bytes against
    /// `issuer_key`.
    pub fn verify(
        &self,
        signature: &[u8; 64],
        issuer_key: &VerifyingKey,
    ) -> Result<(), ProtocolError> {
        issuer_key
            .verify(&self.canonical_bytes()?, &Signature::from_bytes(signature))
            .map_err(ProtocolError::BadSignature)
    }

    /// Verifies `signature` using the issuer identity embedded in the fact
    /// itself. This proves only "signed by whoever controls the private key
    /// of `self.issuer`" (self-attested issuer); trust chains are computed
    /// by the roster projection, not here.
    pub fn verify_with_issuer_id(&self, signature: &[u8; 64]) -> Result<(), ProtocolError> {
        let issuer_key = VerifyingKey::from_bytes(self.issuer.as_bytes())
            .map_err(ProtocolError::InvalidIssuerKey)?;
        self.verify(signature, &issuer_key)
    }
}

/// A fact plus its Ed25519 signature (over the fact's canonical bytes, by
/// the fact's issuer).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedFact {
    /// The signed fact.
    pub fact: Fact,
    /// Ed25519 signature over `fact.canonical_bytes()`.
    pub signature: [u8; 64],
}

impl SignedFact {
    /// Signs `fact` with `key` (the issuer's key) and wraps the result.
    pub fn new(fact: Fact, key: &SigningKey) -> Result<Self, ProtocolError> {
        let signature = fact.sign(key)?;
        Ok(Self { fact, signature })
    }

    /// This signed fact's id (convenience alias).
    pub fn fact_id(&self) -> [u8; 16] {
        self.fact.id
    }

    /// Verifies the embedded signature against the embedded issuer id.
    pub fn verify_self(&self) -> Result<(), ProtocolError> {
        self.fact.verify_with_issuer_id(&self.signature)
    }

    /// Wire encoding: `u32 BE fact_len || canonical fact bytes || signature`.
    pub fn encode(&self) -> Result<Vec<u8>, ProtocolError> {
        let fact_bytes = self.fact.canonical_bytes()?;
        let mut out = Vec::with_capacity(4 + fact_bytes.len() + 64);
        out.extend_from_slice(&(fact_bytes.len() as u32).to_be_bytes());
        out.extend_from_slice(&fact_bytes);
        out.extend_from_slice(&self.signature);
        Ok(out)
    }

    /// Strict inverse of [`SignedFact::encode`].
    pub fn decode(bytes: &[u8]) -> Result<Self, ProtocolError> {
        if bytes.len() < 4 {
            return Err(ProtocolError::Decoding(
                "signed fact wire frame shorter than the u32 length prefix".into(),
            ));
        }
        let fact_len = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
        if bytes.len() < 4 + fact_len + 64 {
            return Err(ProtocolError::Decoding(format!(
                "signed fact wire frame truncated: need {} bytes, got {}",
                4 + fact_len + 64,
                bytes.len()
            )));
        }
        let fact = Fact::decode_canonical(&bytes[4..4 + fact_len])?;
        let mut signature = [0u8; 64];
        signature.copy_from_slice(&bytes[4 + fact_len..4 + fact_len + 64]);
        if bytes.len() != 4 + fact_len + 64 {
            return Err(ProtocolError::Decoding(format!(
                "{} trailing byte(s) after signed fact wire frame",
                bytes.len() - (4 + fact_len + 64)
            )));
        }
        Ok(Self { fact, signature })
    }

    /// Encodes many signed facts: `u32 BE count || frames`.
    pub fn encode_all<'a>(
        items: impl IntoIterator<Item = &'a SignedFact>,
    ) -> Result<Vec<u8>, ProtocolError> {
        let frames: Vec<Vec<u8>> = items
            .into_iter()
            .map(Self::encode)
            .collect::<Result<_, _>>()?;
        let mut out = Vec::with_capacity(4 + frames.iter().map(|f| f.len()).sum::<usize>());
        out.extend_from_slice(&(frames.len() as u32).to_be_bytes());
        for frame in frames {
            out.extend_from_slice(&frame);
        }
        Ok(out)
    }

    /// Strict inverse of [`SignedFact::encode_all`].
    pub fn decode_all(bytes: &[u8]) -> Result<Vec<SignedFact>, ProtocolError> {
        if bytes.len() < 4 {
            return Err(ProtocolError::Decoding(
                "fact list shorter than the u32 count prefix".into(),
            ));
        }
        let count = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
        let mut out = Vec::with_capacity(count);
        let mut off = 4usize;
        for i in 0..count {
            if bytes.len() < off + 4 {
                return Err(ProtocolError::Decoding(format!(
                    "fact list truncated at item {i}'s length prefix"
                )));
            }
            let frame_len =
                u32::from_be_bytes([bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]])
                    as usize;
            // Each item frame is: u32 fact_len || fact || 64B signature.
            let frame_end = off
                .checked_add(4 + frame_len + 64)
                .ok_or_else(|| ProtocolError::Decoding("fact list length overflow".into()))?;
            if bytes.len() < frame_end {
                return Err(ProtocolError::Decoding(format!(
                    "fact list truncated inside item {i}"
                )));
            }
            out.push(Self::decode(&bytes[off..frame_end])?);
            off = frame_end;
        }
        if off != bytes.len() {
            return Err(ProtocolError::Decoding(format!(
                "{} trailing byte(s) after fact list",
                bytes.len() - off
            )));
        }
        Ok(out)
    }

    /// Human-readable JSON projection for debugging and inspection.
    /// **Not** a canonical format — round-trips via [`Self::from_json_str`]
    /// verify the signature but do not preserve unknown fields.
    pub fn to_json_string(&self) -> Result<String, ProtocolError> {
        let v = serde_json::json!({
            "id": hex_str(&self.fact.id),
            "kind": self.fact.kind.as_str(),
            "issuer": self.fact.issuer.to_string(),
            "subject": self.fact.subject.to_string(),
            "display_name": self.fact.display_name,
            "issued_at_ms": self.fact.issued_at_ms,
            "expires_at_ms": self.fact.expires_at_ms,
            "signature": hex_str(&self.signature),
        });
        serde_json::to_string(&v).map_err(ProtocolError::Json)
    }

    /// Parses the debug JSON produced by [`Self::to_json_string`] and
    /// verifies the embedded signature (invalid signatures are rejected).
    pub fn from_json_str(s: &str) -> Result<Self, ProtocolError> {
        let v: serde_json::Value = serde_json::from_str(s).map_err(ProtocolError::Json)?;
        let field = |name: &str| -> Result<&serde_json::Value, ProtocolError> {
            v.get(name).ok_or_else(|| {
                ProtocolError::Decoding(format!("debug JSON is missing field {name:?}"))
            })
        };
        let mut id = [0u8; 16];
        hex_into(field("id")?.as_str().unwrap_or_default(), &mut id)?;
        let kind = match field("kind")?.as_str().unwrap_or_default() {
            "grant" => FactKind::Grant,
            "join" => FactKind::Join,
            "revoke" => FactKind::Revoke,
            other => {
                return Err(ProtocolError::Decoding(format!(
                    "unknown kind {other:?} in debug JSON"
                )));
            }
        };
        let issuer: EndpointId = field("issuer")?
            .as_str()
            .unwrap_or_default()
            .parse()
            .map_err(|e| ProtocolError::Decoding(format!("debug JSON issuer: {e}")))?;
        let subject: EndpointId = field("subject")?
            .as_str()
            .unwrap_or_default()
            .parse()
            .map_err(|e| ProtocolError::Decoding(format!("debug JSON subject: {e}")))?;
        let display_name = match field("display_name")? {
            serde_json::Value::Null => None,
            v => v.as_str().map(|s| s.to_owned()),
        };
        let issued_at_ms = field("issued_at_ms")?
            .as_u64()
            .ok_or_else(|| ProtocolError::Decoding("debug JSON issued_at_ms".into()))?;
        let expires_at_ms = match field("expires_at_ms")? {
            serde_json::Value::Null => None,
            v => Some(
                v.as_u64()
                    .ok_or_else(|| ProtocolError::Decoding("debug JSON expires_at_ms".into()))?,
            ),
        };
        let mut signature = [0u8; 64];
        hex_into(
            field("signature")?.as_str().unwrap_or_default(),
            &mut signature,
        )?;

        let fact = Fact {
            id,
            kind,
            issuer,
            subject,
            display_name,
            issued_at_ms,
            expires_at_ms,
        };
        let sf = Self { fact, signature };
        sf.verify_self()?;
        Ok(sf)
    }
}

/// Connection hints for an invitee, carried inside the invite token.
///
/// v0.1 layout: `inviter EndpointId (32B)` followed, if a relay URL is
/// present, by `u16 len || UTF-8 bytes`. The optional part is recognized by
/// total length (the relay URL is the final field).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RendezvousHint {
    /// EndpointId of the inviting member (for direct connection attempts).
    pub inviter: EndpointId,
    /// Optional relay URL (e.g. `https://relay.example.com`). The port is
    /// negotiated by the iroh stack, not stored here.
    pub relay_url: Option<String>,
}

impl RendezvousHint {
    /// Encodes the hint.
    pub fn encode(&self) -> Result<Vec<u8>, ProtocolError> {
        let mut out =
            Vec::with_capacity(EndpointId::LEN + 2 + self.relay_url.as_deref().map_or(0, str::len));
        out.extend_from_slice(self.inviter.as_bytes());
        if let Some(relay) = &self.relay_url {
            if relay.len() > u16::MAX as usize {
                return Err(ProtocolError::Encoding(format!(
                    "relay URL of {} bytes exceeds the u16 length prefix",
                    relay.len()
                )));
            }
            out.extend_from_slice(&(relay.len() as u16).to_be_bytes());
            out.extend_from_slice(relay.as_bytes());
        }
        Ok(out)
    }

    /// Strict parse of the hint (exact length, valid UTF-8).
    pub fn decode(bytes: &[u8]) -> Result<Self, ProtocolError> {
        if bytes.len() < EndpointId::LEN {
            return Err(ProtocolError::Decoding(format!(
                "rendezvous hint of {} bytes is shorter than the 32-byte inviter id",
                bytes.len()
            )));
        }
        let inviter =
            EndpointId::from_bytes(bytes[..EndpointId::LEN].try_into().expect("slice len 32"));
        let rest = &bytes[EndpointId::LEN..];
        let relay_url = if rest.is_empty() {
            None
        } else {
            if rest.len() < 2 {
                return Err(ProtocolError::Decoding(
                    "rendezvous hint relay URL length prefix truncated".into(),
                ));
            }
            let len = u16::from_be_bytes([rest[0], rest[1]]) as usize;
            if rest.len() != 2 + len {
                return Err(ProtocolError::Decoding(format!(
                    "rendezvous hint relay URL length {} does not match remaining {} bytes",
                    len,
                    rest.len() - 2
                )));
            }
            Some(
                std::str::from_utf8(&rest[2..])
                    .map_err(|_| ProtocolError::Decoding("relay URL is not valid UTF-8".into()))?
                    .to_owned(),
            )
        };
        Ok(Self { inviter, relay_url })
    }
}

/// A self-contained invite: a signed Grant fact plus a rendezvous hint,
/// rendered as `dweb1.<base64url-nopad(...)>'.
///
/// The payload is `canonical(fact) || signature(64B) || rendezvous_hint`.
/// Decoding validates the version prefix and the exact total structure;
/// semantic checks (is a Grant, carries an expiry, not past expiry) live in
/// [`InviteToken::validate_for_redeem`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InviteToken {
    /// The carried fact (should be a Grant with an expiry for redemption).
    pub fact: Fact,
    /// Ed25519 signature over `fact.canonical_bytes()` by `fact.issuer`.
    pub signature: [u8; 64],
    /// How to reach the inviter / network.
    pub rendezvous: RendezvousHint,
}

impl InviteToken {
    /// Signs `fact` with `key` and attaches `rendezvous`.
    pub fn new(
        fact: Fact,
        key: &SigningKey,
        rendezvous: RendezvousHint,
    ) -> Result<Self, ProtocolError> {
        let signature = fact.sign(key)?;
        Ok(Self {
            fact,
            signature,
            rendezvous,
        })
    }

    /// Renders the token string (`dweb1.` + base64url without padding).
    pub fn encode(&self) -> Result<String, ProtocolError> {
        let mut payload = self.fact.canonical_bytes()?;
        payload.extend_from_slice(&self.signature);
        payload.extend_from_slice(&self.rendezvous.encode()?);
        Ok(format!("{TOKEN_PREFIX}{}", URL_SAFE_NO_PAD.encode(payload)))
    }

    /// Parses and structurally validates a token string.
    pub fn decode(s: &str) -> Result<Self, ProtocolError> {
        let b64 = s.strip_prefix(TOKEN_PREFIX).ok_or_else(|| {
            ProtocolError::Decoding(format!("token does not start with {TOKEN_PREFIX:?}"))
        })?;
        let payload = URL_SAFE_NO_PAD.decode(b64).map_err(ProtocolError::Base64)?;
        let (fact, fact_len) = Fact::parse_canonical_prefix(&payload)?;
        let sig_start = fact_len;
        if payload.len() < sig_start + 64 {
            return Err(ProtocolError::Decoding(
                "token payload truncated inside the 64-byte signature".into(),
            ));
        }
        let mut signature = [0u8; 64];
        signature.copy_from_slice(&payload[sig_start..sig_start + 64]);
        let rendezvous = RendezvousHint::decode(&payload[sig_start + 64..])?;
        Ok(Self {
            fact,
            signature,
            rendezvous,
        })
    }

    /// Verifies the embedded signature against the embedded issuer id.
    pub fn verify(&self) -> Result<(), ProtocolError> {
        self.fact.verify_with_issuer_id(&self.signature)
    }

    /// Whether the carried fact's expiry has passed at `now_ms`. Tokens whose
    /// fact carries no expiry never structurally expire; redemption still
    /// requires an expiry ([`Self::validate_for_redeem`]).
    pub fn is_expired(&self, now_ms: u64) -> bool {
        self.fact.expires_at_ms.is_some_and(|e| now_ms >= e)
    }

    /// Full redemption-time validation: valid signature, fact is a Grant,
    /// fact carries an expiry, and the expiry has not passed.
    pub fn validate_for_redeem(&self, now_ms: u64) -> Result<(), InviteError> {
        self.verify().map_err(InviteError::Protocol)?;
        if self.fact.kind != FactKind::Grant {
            return Err(InviteError::NotAGrant {
                kind: self.fact.kind.as_u8(),
            });
        }
        let Some(expires_at_ms) = self.fact.expires_at_ms else {
            return Err(InviteError::NoExpiry);
        };
        if now_ms >= expires_at_ms {
            return Err(InviteError::Expired {
                expired_at_ms: expires_at_ms,
                now_ms,
            });
        }
        Ok(())
    }
}

/// Redemption-time failures for an [`InviteToken`].
#[derive(Debug, Error)]
pub enum InviteError {
    /// Structural or signature failure.
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
    /// The token's fact is not a membership Grant.
    #[error("invite token fact is not a Grant (kind byte {kind})")]
    NotAGrant { kind: u8 },
    /// Grants inside invite tokens must carry an expiry.
    #[error("invite token grant carries no expiry")]
    NoExpiry,
    /// The expiry has passed.
    #[error("invite token expired at {expired_at_ms} ms (now {now_ms} ms)")]
    Expired { expired_at_ms: u64, now_ms: u64 },
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

fn hex_into(s: &str, out: &mut [u8]) -> Result<(), ProtocolError> {
    let expect = out.len() * 2;
    if s.len() != expect {
        return Err(ProtocolError::Decoding(format!(
            "expected {expect} hex characters, got {}",
            s.len()
        )));
    }
    for (idx, byte) in out.iter_mut().enumerate() {
        let hi = (s.as_bytes()[idx * 2] as char)
            .to_digit(16)
            .ok_or_else(|| {
                ProtocolError::Decoding("non-hex character in debug JSON field".into())
            })?;
        let lo = (s.as_bytes()[idx * 2 + 1] as char)
            .to_digit(16)
            .ok_or_else(|| {
                ProtocolError::Decoding("non-hex character in debug JSON field".into())
            })?;
        *byte = ((hi << 4) | lo) as u8;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::NodeIdentity;

    fn issuer_identity() -> NodeIdentity {
        NodeIdentity::from_seed([1u8; 32])
    }

    fn sample_fact(display_name: Option<String>, expires_at_ms: Option<u64>) -> Fact {
        let issuer = issuer_identity();
        let subject = NodeIdentity::from_seed([2u8; 32]);
        Fact {
            id: [
                0x01, 0x89, 0x77, 0xaa, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x2a,
            ],
            kind: FactKind::Grant,
            issuer: issuer.endpoint_id(),
            subject: subject.endpoint_id(),
            display_name,
            issued_at_ms: 1_700_000_000_123,
            expires_at_ms,
        }
    }

    #[test]
    fn canonical_bytes_are_deterministic_across_construction_paths() {
        // Path 1: literal struct with a &str-derived name.
        let f1 = sample_fact(Some("卡罗尔".to_owned()), Some(999));
        // Path 2: same field values, different String allocation + Option path.
        let f2 = {
            let mut f = f1.clone();
            f.display_name = Some(format!("卡{}", "罗尔"));
            f.expires_at_ms = Some(900 + 99);
            f
        };
        // Path 3: decode(encode(f1)) then re-encode.
        let f3 = Fact::decode_canonical(&f1.canonical_bytes().unwrap()).unwrap();

        let b1 = f1.canonical_bytes().unwrap();
        assert_eq!(b1, f2.canonical_bytes().unwrap());
        assert_eq!(b1, f3.canonical_bytes().unwrap());
    }

    #[test]
    fn canonical_layout_offsets_match_documentation() {
        let f = sample_fact(Some("ab".to_owned()), None);
        let b = f.canonical_bytes().unwrap();
        assert_eq!(&b[0..9], b"dweb-fact");
        assert_eq!(b[9], 0x01);
        assert_eq!(b[10], KIND_GRANT);
        assert_eq!(&b[11..27], &f.id[..]);
        assert_eq!(&b[27..59], f.issuer.as_bytes());
        assert_eq!(&b[59..91], f.subject.as_bytes());
        assert_eq!(
            u64::from_be_bytes(b[91..99].try_into().unwrap()),
            f.issued_at_ms
        );
        assert_eq!(b[99], FLAG_HAS_NAME);
        assert_eq!(u16::from_be_bytes(b[100..102].try_into().unwrap()), 2);
        assert_eq!(&b[102..104], b"ab");
        assert_eq!(b.len(), 104);

        // No optionals at all.
        let bare = sample_fact(None, None).canonical_bytes().unwrap();
        assert_eq!(bare.len(), FIXED_LEN);
        assert_eq!(bare[99], 0);
        // Only expiry.
        let exp_only = sample_fact(None, Some(7)).canonical_bytes().unwrap();
        assert_eq!(exp_only.len(), FIXED_LEN + 8);
        assert_eq!(exp_only[99], FLAG_HAS_EXPIRY);
    }

    #[test]
    fn canonical_roundtrip_all_option_combinations() {
        for name in [None, Some("名字".to_owned()), Some(String::new())] {
            for exp in [None, Some(u64::MAX), Some(0)] {
                let f = sample_fact(name.clone(), exp);
                let b = f.canonical_bytes().unwrap();
                let back = Fact::decode_canonical(&b).unwrap();
                assert_eq!(back, f, "roundtrip failed for {f:?}");
            }
        }
    }

    #[test]
    fn decode_rejects_non_canonical_and_corrupt_bytes() {
        let good = sample_fact(Some("name".to_owned()), Some(5))
            .canonical_bytes()
            .unwrap();

        // Truncation at every length below the fixed prefix and inside
        // optional fields.
        for len in 0..good.len() {
            assert!(
                Fact::decode_canonical(&good[..len]).is_err(),
                "decoding {len} bytes should fail"
            );
        }

        // Trailing garbage.
        let mut trailing = good.clone();
        trailing.push(0);
        assert!(Fact::decode_canonical(&trailing).is_err());

        // Bad magic / version / kind / flags.
        for (pos, bad) in [
            (0, b"XWEB-FACT".as_slice()[..9].to_vec()),
            (9, vec![0x02]),
            (10, vec![0x00]),
            (10, vec![0x04]),
            (10, vec![0xff]),
            (99, vec![0b100]),
            (99, vec![0xff]),
        ] {
            let mut m = good.clone();
            m[pos..pos + bad.len()].copy_from_slice(&bad);
            assert!(Fact::decode_canonical(&m).is_err(), "pos {pos} bad {bad:?}");
        }

        // Name length lying about the actual content length.
        let mut liar = good.clone();
        liar[100] = 0xff; // claims 0xff00 + x bytes of name
        liar[101] = 0xff;
        assert!(Fact::decode_canonical(&liar).is_err());

        // Non-UTF-8 name bytes.
        let mut bad_utf8 = good.clone();
        let name_start = 102;
        bad_utf8[name_start] = 0xff;
        bad_utf8[name_start + 1] = 0xfe;
        assert!(Fact::decode_canonical(&bad_utf8).is_err());
    }

    #[test]
    fn oversized_name_is_rejected_at_encode() {
        let mut f = sample_fact(None, None);
        f.display_name = Some("x".repeat(u16::MAX as usize + 1));
        assert!(matches!(
            f.canonical_bytes(),
            Err(ProtocolError::Encoding(_))
        ));
    }

    #[test]
    fn sign_and_verify_roundtrip() {
        let issuer = issuer_identity();
        let f = sample_fact(None, None);
        let sig = f.sign(issuer.signing_key()).unwrap();
        f.verify(&sig, &issuer.verifying_key()).unwrap();
        f.verify_with_issuer_id(&sig).unwrap();

        // Any other key fails.
        let other = NodeIdentity::from_seed([3u8; 32]);
        assert!(f.verify(&sig, &other.verifying_key()).is_err());
    }

    #[test]
    fn tampered_fact_or_signature_fails_verification() {
        let issuer = issuer_identity();
        let f = sample_fact(Some("n".to_owned()), Some(10));
        let sig = f.sign(issuer.signing_key()).unwrap();

        // Tamper with each field of the fact.
        {
            let mut t = f.clone();
            t.id[0] ^= 1;
            assert!(t.verify_with_issuer_id(&sig).is_err());
        }
        {
            let mut t = f.clone();
            t.kind = FactKind::Revoke;
            assert!(t.verify_with_issuer_id(&sig).is_err());
        }
        {
            let mut t = f.clone();
            t.issuer = NodeIdentity::from_seed([4u8; 32]).endpoint_id();
            // Now the "issuer" is someone else; the signature cannot match.
            assert!(t.verify_with_issuer_id(&sig).is_err());
        }
        {
            let mut t = f.clone();
            t.subject = NodeIdentity::from_seed([5u8; 32]).endpoint_id();
            assert!(t.verify_with_issuer_id(&sig).is_err());
        }
        {
            let mut t = f.clone();
            t.display_name = Some("evil".to_owned());
            assert!(t.verify_with_issuer_id(&sig).is_err());
        }
        {
            let mut t = f.clone();
            t.issued_at_ms += 1;
            assert!(t.verify_with_issuer_id(&sig).is_err());
        }
        {
            let mut t = f.clone();
            t.expires_at_ms = Some(11);
            assert!(t.verify_with_issuer_id(&sig).is_err());
        }
        // Tampered signature.
        let mut bad_sig = sig;
        bad_sig[0] ^= 1;
        assert!(f.verify_with_issuer_id(&bad_sig).is_err());
    }

    #[test]
    fn signed_fact_wire_roundtrip_and_strictness() {
        let issuer = issuer_identity();
        let f = sample_fact(Some("w".to_owned()), None);
        let sf = SignedFact::new(f, issuer.signing_key()).unwrap();
        let wire = sf.encode().unwrap();
        let back = SignedFact::decode(&wire).unwrap();
        assert_eq!(back, sf);
        assert!(back.verify_self().is_ok());

        // Truncated / trailing.
        assert!(SignedFact::decode(&wire[..wire.len() - 1]).is_err());
        let mut trailing = wire.clone();
        trailing.push(0);
        assert!(SignedFact::decode(&trailing).is_err());
        // Lying length prefix.
        let mut liar = wire.clone();
        liar[0] = 0xff;
        assert!(SignedFact::decode(&liar).is_err());
    }

    #[test]
    fn signed_fact_list_roundtrip() {
        let issuer = issuer_identity();
        let facts: Vec<SignedFact> = (0..5)
            .map(|i| {
                let mut f = sample_fact(Some(format!("m{i}")), Some(i));
                f.issued_at_ms = i;
                SignedFact::new(f, issuer.signing_key()).unwrap()
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
        let mut liar = bytes.clone();
        liar[3] += 10;
        assert!(SignedFact::decode_all(&liar).is_err());
    }

    #[test]
    fn debug_json_roundtrip() {
        let issuer = issuer_identity();
        let f = sample_fact(Some("名字".to_owned()), Some(42));
        let sf = SignedFact::new(f, issuer.signing_key()).unwrap();
        let json = sf.to_json_string().unwrap();
        let back = SignedFact::from_json_str(&json).unwrap();
        assert_eq!(back, sf);

        // Tampering with the JSON breaks signature verification.
        let tampered = json.replace(
            "\"issued_at_ms\":1700000000123",
            "\"issued_at_ms\":1700000000999",
        );
        assert!(SignedFact::from_json_str(&tampered).is_err());
    }

    #[test]
    fn rendezvous_hint_roundtrip_and_strictness() {
        let inviter = issuer_identity().endpoint_id();
        // Without relay.
        let h = RendezvousHint {
            inviter,
            relay_url: None,
        };
        let b = h.encode().unwrap();
        assert_eq!(b.len(), 32);
        assert_eq!(RendezvousHint::decode(&b).unwrap(), h);
        // With relay.
        let h = RendezvousHint {
            inviter,
            relay_url: Some("https://relay.example.com".to_owned()),
        };
        let b = h.encode().unwrap();
        assert_eq!(RendezvousHint::decode(&b).unwrap(), h);

        // Too short / trailing / lying len / bad utf8.
        assert!(RendezvousHint::decode(&b[..31]).is_err());
        let mut trailing = b.clone();
        trailing.push(0);
        assert!(RendezvousHint::decode(&trailing).is_err());
        let mut liar = b.clone();
        liar[32] = 0xff;
        liar[33] = 0xff;
        assert!(RendezvousHint::decode(&liar).is_err());
        let mut bad_utf8 = b.clone();
        let relay_len = u16::from_be_bytes([bad_utf8[32], bad_utf8[33]]) as usize;
        for byte in &mut bad_utf8[34..34 + relay_len] {
            *byte = 0xff;
        }
        assert!(RendezvousHint::decode(&bad_utf8).is_err());
    }

    #[test]
    fn invite_token_roundtrip() {
        let issuer = issuer_identity();
        let subject = NodeIdentity::from_seed([2u8; 32]);
        let f = Fact::new(
            FactKind::Grant,
            issuer.endpoint_id(),
            subject.endpoint_id(),
            Some("朋友".to_owned()),
            1000,
            Some(60_000),
        );
        let token = InviteToken::new(
            f.clone(),
            issuer.signing_key(),
            RendezvousHint {
                inviter: issuer.endpoint_id(),
                relay_url: Some("https://relay.example.com".to_owned()),
            },
        )
        .unwrap();

        let s = token.encode().unwrap();
        assert!(s.starts_with("dweb1."));
        assert!(
            !s.contains('+') && !s.contains('/') && !s.contains('='),
            "base64url-nopad only"
        );
        let back = InviteToken::decode(&s).unwrap();
        assert_eq!(back, token);
        assert!(back.verify().is_ok());
        assert_eq!(back.fact, f);
    }

    #[test]
    fn invite_token_decode_rejects_malformed_strings() {
        let issuer = issuer_identity();
        let f = Fact::new(
            FactKind::Grant,
            issuer.endpoint_id(),
            issuer.endpoint_id(),
            None,
            1,
            Some(2),
        );
        let token = InviteToken::new(
            f,
            issuer.signing_key(),
            RendezvousHint {
                inviter: issuer.endpoint_id(),
                relay_url: None,
            },
        )
        .unwrap();
        let good = token.encode().unwrap();

        // Wrong / missing prefix.
        assert!(InviteToken::decode(&good[1..]).is_err());
        assert!(InviteToken::decode(&good.replace("dweb1.", "dweb2.")).is_err());
        // Non-base64 characters.
        assert!(InviteToken::decode(&format!("{TOKEN_PREFIX}!!!!")).is_err());
        // Truncation of the base64 body.
        assert!(InviteToken::decode(&good[..good.len() - 8]).is_err());
        // Structural corruption: flip a byte in the fixed header (magic).
        let raw = URL_SAFE_NO_PAD
            .decode(good.strip_prefix(TOKEN_PREFIX).unwrap())
            .unwrap();
        let mut evil = raw.clone();
        evil[0] = b'X';
        assert!(
            InviteToken::decode(&format!("{TOKEN_PREFIX}{}", URL_SAFE_NO_PAD.encode(evil)))
                .is_err()
        );
        // Tampered signature still decodes but fails verification.
        let mut evil = raw;
        let fact_len = evil.len() - 64 - 32;
        evil[fact_len] ^= 1;
        let tampered =
            InviteToken::decode(&format!("{TOKEN_PREFIX}{}", URL_SAFE_NO_PAD.encode(evil)))
                .expect("structure still valid");
        assert!(tampered.verify().is_err());
    }

    #[test]
    fn invite_token_expiry_semantics() {
        let issuer = issuer_identity();
        let f = Fact::new(
            FactKind::Grant,
            issuer.endpoint_id(),
            issuer.endpoint_id(),
            None,
            1,
            Some(1000),
        );
        let token = InviteToken::new(
            f,
            issuer.signing_key(),
            RendezvousHint {
                inviter: issuer.endpoint_id(),
                relay_url: None,
            },
        )
        .unwrap();
        assert!(!token.is_expired(999));
        assert!(token.is_expired(1000), "expired at the exact instant");
        assert!(token.is_expired(1001));

        // No-expiry tokens never structurally expire...
        let f = Fact::new(
            FactKind::Grant,
            issuer.endpoint_id(),
            issuer.endpoint_id(),
            None,
            1,
            None,
        );
        let token = InviteToken::new(
            f,
            issuer.signing_key(),
            RendezvousHint {
                inviter: issuer.endpoint_id(),
                relay_url: None,
            },
        )
        .unwrap();
        assert!(!token.is_expired(u64::MAX));
        // ...but cannot be redeemed.
        assert!(matches!(
            token.validate_for_redeem(0),
            Err(InviteError::NoExpiry)
        ));
    }

    #[test]
    fn validate_for_redeem_checks_kind_signature_and_expiry() {
        let issuer = issuer_identity();
        let mk = |kind| {
            let f = Fact::new(
                kind,
                issuer.endpoint_id(),
                issuer.endpoint_id(),
                None,
                10,
                Some(100),
            );
            InviteToken::new(
                f,
                issuer.signing_key(),
                RendezvousHint {
                    inviter: issuer.endpoint_id(),
                    relay_url: None,
                },
            )
            .unwrap()
        };

        assert!(mk(FactKind::Grant).validate_for_redeem(50).is_ok());
        assert!(matches!(
            mk(FactKind::Join).validate_for_redeem(50),
            Err(InviteError::NotAGrant { .. })
        ));
        assert!(matches!(
            mk(FactKind::Grant).validate_for_redeem(100),
            Err(InviteError::Expired { .. })
        ));

        // Bad signature.
        let mut t = mk(FactKind::Grant);
        t.signature[0] ^= 1;
        assert!(matches!(
            t.validate_for_redeem(50),
            Err(InviteError::Protocol(_))
        ));
    }
}
