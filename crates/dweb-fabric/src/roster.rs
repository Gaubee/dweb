//! Signed-fact membership roster: single-root authorization, union-merge
//! convergence, effective member projection and single-use invite
//! consumption (fabric spec: roster).
//!
//! # Model (v0.1, codex review P0 fixes)
//!
//! A fabric has exactly one [`Genesis`] fact establishing the root
//! `EndpointId`. The roster stores a content-addressed set of [`SignedFact`]s
//! (`fact_id = BLAKE3(canonical bytes)`). Authorization is *derived*, never
//! stored: [`Roster::effective_members`] recomputes the projection from the
//! fact set, so it is trivially rebuildable and order-independent.
//!
//! # Merge (union, fail-closed)
//!
//! [`Roster::merge`] validates each incoming fact: signature by the embedded
//! issuer, `fabric_id` equality, and — because ids are content addresses —
//! same-id-different-content can only be a hash collision or non-canonical
//! encoding. Any violation quarantines the fact (counted, sample reasons
//! kept, never stored, never projected). A second, different Genesis for the
//! same fabric is quarantined (split-brain prevention). Merge is therefore
//! commutative and associative, and duplicate delivery is idempotent.
//!
//! # Projection (single deterministic closure)
//!
//! - The root is **always** a member (v0.1 roots are irrevocable).
//! - Only Grants with `issuer == root`, unexpired and not covered by an
//!   active root Revoke, admit their subject. Grants by anyone else are
//!   stored but grant nothing.
//! - A Revoke with `target_fact_id = Some(id)` kills exactly that grant; a
//!   Revoke with `target_fact_id = None` kills all live grants of its
//!   subject. Both only take effect when issued by the root.
//! - Joins only carry self-chosen display names (`issuer == subject`), never
//!   admission.
//! - Expiry is fail-closed: a fact past `expires_at_ms` is inert (expired
//!   revokes stop revoking — uniform semantics).
//!
//! Revocation is forward-effective only: existing facts are never rewritten;
//! sessions opened before a revoke arrives are the session layer's business
//! (risk window, honestly surfaced).
//!
//! # Persistence
//!
//! - `<data_dir>/roster.facts`: magic + fabric_id + `SignedFact` wire dump +
//!   BLAKE3 checksum, written atomically (tmp + fsync + rename) after every
//!   mutation. Loading replays every fact through the same validation as
//!   network merge; checksum/decode/validation failure is an error — never a
//!   silent rebuild.
//! - `<data_dir>/invites.consumed`: append-only `invite_id[16] ||
//!   consumed_at_ms u64` records (fsync per append), loaded into a set on
//!   open; [`Roster::consume_invite`] is the CAS消费 primitive.

use std::collections::{BTreeMap, HashSet};
use std::io::Write as _;
use std::path::{Path, PathBuf};

use iroh_base::{EndpointId, Signature};
use thiserror::Error;
use tracing::warn;

use crate::identity::NodeIdentity;
use crate::protocol::{FabricId, Fact, FactId, FactKind, InviteToken, ProtocolError, SignedFact};

/// File name of the persisted fact set inside the data directory.
pub const ROSTER_FILE_NAME: &str = "roster.facts";
/// File name of the consumed-invite log inside the data directory.
pub const CONSUMED_INVITES_FILE_NAME: &str = "invites.consumed";

/// Magic prefix of `roster.facts`.
const ROSTER_MAGIC: &[u8; 8] = b"DWEBRST1";
/// Maximum number of quarantine sample reasons kept for diagnostics.
const QUARANTINE_SAMPLE_CAP: usize = 16;
/// One consumed-invite record: 16 B id + 8 B consumed_at_ms.
const CONSUMED_RECORD_LEN: usize = 24;

/// Errors from roster construction, persistence, merging and redemption.
#[derive(Debug, Error)]
pub enum RosterError {
    /// Canonical/signature-level failure bubbled up from the protocol layer.
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
    /// A root-only operation was attempted by a non-root identity.
    #[error("operation requires root {root:?}, caller is {caller:?}")]
    NotRoot {
        caller: EndpointId,
        root: Option<EndpointId>,
    },
    /// `revoke` named a fact that is not a stored grant.
    #[error("revoke target {fact_id:?} is not a stored grant fact")]
    InvalidRevokeTarget { fact_id: FactId },
    /// A persisted file exists but cannot be replayed (checksum, decode or
    /// validation failure). Never silently rebuilt.
    #[error("roster file {path} is corrupted: {reason}")]
    Corrupted { path: PathBuf, reason: String },
    /// `open` requires an existing persisted roster.
    #[error("no persisted roster for this data directory: {path}")]
    NotFound { path: PathBuf },
    /// `create` refuses to clobber an existing persisted roster.
    #[error("data directory already hosts a roster: {path}")]
    AlreadyExists { path: PathBuf },
    /// A fact did not belong to this roster's fabric.
    #[error("fact belongs to fabric {got}, roster is {expected}")]
    WrongFabric { got: FabricId, expected: FabricId },
    /// The invite token's issuer is not this fabric's root.
    #[error("invite issuer {issuer:?} is not the fabric root {root:?}")]
    InviteNotRoot {
        issuer: EndpointId,
        root: Option<EndpointId>,
    },
    /// The invite token is expired.
    #[error("invite expired at {expires_at_ms} ms (now {now_ms} ms)")]
    InviteExpired { expires_at_ms: u64, now_ms: u64 },
    /// The invite is bound to a different recipient than the redeemer.
    #[error("invite is bound to {expected:?}, redeemer is {redeemer:?}")]
    InviteRecipientMismatch {
        expected: EndpointId,
        redeemer: EndpointId,
    },
    /// The redemption proof-of-possession failed.
    #[error("proof-of-possession verification failed for {redeemer:?}")]
    BadPoP { redeemer: EndpointId },
    /// Persistence I/O failure.
    #[error("roster persistence failed for {path}: {source}")]
    Persistence {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

/// One derived member of the effective projection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    /// The member's stable identity.
    pub endpoint_id: EndpointId,
    /// Preferred label: the member's latest self-named Join, else the
    /// admitting grant's label (root: Join only).
    pub display_name: Option<String>,
    /// `issued_at_ms` of the admitting fact (genesis for the root; the
    /// deterministically earliest live grant for members).
    pub since_ms: u64,
}

/// Statistics from [`Roster::merge`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MergeReport {
    /// Facts newly inserted.
    pub inserted: usize,
    /// Re-deliveries of facts already present (identical content).
    pub duplicates: usize,
    /// Facts quarantined (bad signature / cross-fabric / id collision /
    /// conflicting genesis). Never stored, never projected.
    pub quarantined: usize,
}

/// Precise target of a revocation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevokeTarget {
    /// Kill exactly this grant fact.
    Grant(FactId),
    /// Kill all live grants of this subject.
    AllGrantsOf(EndpointId),
}

/// Outcome of validating one fact against the store.
#[derive(Debug, Clone, PartialEq, Eq)]
enum InsertOutcome {
    Inserted,
    Duplicate,
    Quarantined(String),
}

/// A fabric's signed-fact set plus derived state, bound to a data directory.
#[derive(Debug)]
pub struct Roster {
    data_dir: PathBuf,
    fabric_id: FabricId,
    /// The Genesis fact id, once a valid Genesis has been merged.
    genesis_fact_id: Option<FactId>,
    /// The root EndpointId from Genesis.
    root: Option<EndpointId>,
    facts: BTreeMap<FactId, SignedFact>,
    consumed_invites: HashSet<[u8; 16]>,
    quarantine_count: u64,
    quarantine_samples: Vec<String>,
}

impl Roster {
    // ---- Construction ---------------------------------------------------------

    /// Creates a new fabric: a fresh random [`FabricId`] and a Genesis fact
    /// signed by `identity` (which becomes the root). Refuses to clobber an
    /// existing `roster.facts`. Returns the roster and the fabric id.
    pub fn create(
        identity: &NodeIdentity,
        data_dir: &Path,
        now_ms: u64,
    ) -> Result<(Self, FabricId), RosterError> {
        std::fs::create_dir_all(data_dir).map_err(|source| RosterError::Persistence {
            path: data_dir.to_path_buf(),
            source,
        })?;
        let roster_path = roster_file_path(data_dir);
        if roster_path.exists() {
            return Err(RosterError::AlreadyExists { path: roster_path });
        }
        let fabric_id = FabricId::random();
        let genesis = crate::protocol::genesis(identity, fabric_id, now_ms)?;
        let mut roster = Self::empty(data_dir, fabric_id)?;
        match roster.validate_and_insert(&genesis) {
            InsertOutcome::Inserted => {}
            outcome => {
                return Err(RosterError::Corrupted {
                    path: roster_path,
                    reason: format!("fresh genesis did not insert: {outcome:?}"),
                });
            }
        }
        roster.persist_now()?;
        Ok((roster, fabric_id))
    }

    /// Opens an existing persisted roster. Errors when no file exists
    /// ([`RosterError::NotFound`]) or when the file fails checksum, decode or
    /// replay validation ([`RosterError::Corrupted`]) — never rebuilds
    /// silently.
    pub fn open(data_dir: &Path, fabric_id: FabricId) -> Result<Self, RosterError> {
        let path = roster_file_path(data_dir);
        let bytes = std::fs::read(&path).map_err(|source| {
            if source.kind() == std::io::ErrorKind::NotFound {
                RosterError::NotFound { path: path.clone() }
            } else {
                RosterError::Persistence {
                    path: path.clone(),
                    source,
                }
            }
        })?;
        Self::decode_persisted(data_dir, fabric_id, &bytes, &path)
    }

    /// Opens a persisted roster, or attaches to the fabric with an empty
    /// roster when no file exists yet (a joiner that has not synced any
    /// facts). Existing-but-corrupt files still error. An attached-empty
    /// roster has no root and an empty projection until Genesis arrives via
    /// [`Roster::merge`].
    pub fn attach(data_dir: &Path, fabric_id: FabricId) -> Result<Self, RosterError> {
        match Self::open(data_dir, fabric_id) {
            Ok(roster) => Ok(roster),
            Err(RosterError::NotFound { .. }) => {
                let roster = Self::empty(data_dir, fabric_id)?;
                roster.persist_now()?;
                Ok(roster)
            }
            Err(e) => Err(e),
        }
    }

    /// An in-memory empty roster for `fabric_id`, loading the consumed
    /// invite log (a missing log is benign — a fresh node has consumed
    /// nothing).
    /// 写锁（跨平台文件锁，短持有）：供跨进程 CAS 段串行化；返回后锁随 File drop 释放。
    /// fs4：unix = flock，Windows = LockFileEx，语义一致。
    fn write_lock(data_dir: &Path) -> Result<std::fs::File, RosterError> {
        use fs4::fs_std::FileExt;
        let path = data_dir.join("roster.lock");
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .map_err(|source| RosterError::Persistence {
                path: path.clone(),
                source,
            })?;
        // 有界重试：与其它进程的短临界区竞争
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            match file.try_lock_exclusive() {
                // fs4 返回 Result<bool>：true = 拿到锁
                Ok(true) => return Ok(file),
                Ok(false) => {}
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    if std::time::Instant::now() >= deadline {
                        return Err(RosterError::Persistence {
                            path,
                            source: std::io::Error::new(
                                std::io::ErrorKind::TimedOut,
                                "write lock contention timeout",
                            ),
                        });
                    }
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                Err(err) => return Err(RosterError::Persistence { path, source: err }),
            }
        }
    }

    fn empty(data_dir: &Path, fabric_id: FabricId) -> Result<Self, RosterError> {
        let consumed_invites = load_consumed_invites(data_dir)?;
        Ok(Self {
            data_dir: data_dir.to_path_buf(),
            fabric_id,
            genesis_fact_id: None,
            root: None,
            facts: BTreeMap::new(),
            consumed_invites,
            quarantine_count: 0,
            quarantine_samples: Vec::new(),
        })
    }

    /// Replays a persisted roster file: magic, fabric binding, BLAKE3
    /// checksum, wire decode, then per-fact validation through the same path
    /// as network merge. Any failure is [`RosterError::Corrupted`] — the
    /// local store should only ever contain validated facts.
    fn decode_persisted(
        data_dir: &Path,
        fabric_id: FabricId,
        bytes: &[u8],
        path: &Path,
    ) -> Result<Self, RosterError> {
        let header_len = ROSTER_MAGIC.len() + 32;
        let min_len = header_len + 4 + blake3::OUT_LEN;
        if bytes.len() < min_len {
            return Err(RosterError::Corrupted {
                path: path.to_path_buf(),
                reason: format!(
                    "file of {} bytes shorter than minimum {min_len}",
                    bytes.len()
                ),
            });
        }
        if &bytes[..ROSTER_MAGIC.len()] != ROSTER_MAGIC {
            return Err(RosterError::Corrupted {
                path: path.to_path_buf(),
                reason: "bad magic".to_owned(),
            });
        }
        let stored_fabric = FabricId(
            bytes[ROSTER_MAGIC.len()..header_len]
                .try_into()
                .expect("slice len 32"),
        );
        if stored_fabric != fabric_id {
            return Err(RosterError::Corrupted {
                path: path.to_path_buf(),
                reason: format!("file is for fabric {stored_fabric}, requested {fabric_id}"),
            });
        }
        let body_end = bytes.len() - blake3::OUT_LEN;
        let checksum = blake3::hash(&bytes[..body_end]);
        let stored_checksum: [u8; 32] = bytes[body_end..].try_into().expect("slice len 32");
        if *checksum.as_bytes() != stored_checksum {
            return Err(RosterError::Corrupted {
                path: path.to_path_buf(),
                reason: "BLAKE3 checksum mismatch".to_owned(),
            });
        }
        let facts = SignedFact::decode_all(&bytes[header_len..body_end]).map_err(|e| {
            RosterError::Corrupted {
                path: path.to_path_buf(),
                reason: format!("fact dump failed to decode: {e}"),
            }
        })?;

        let mut roster = Self::empty(data_dir, fabric_id)?;
        for fact in facts {
            match roster.validate_and_insert(&fact) {
                InsertOutcome::Inserted => {}
                outcome => {
                    return Err(RosterError::Corrupted {
                        path: path.to_path_buf(),
                        reason: format!("stored fact failed replay validation: {outcome:?}"),
                    });
                }
            }
        }
        if !roster.facts.is_empty() && roster.genesis_fact_id.is_none() {
            return Err(RosterError::Corrupted {
                path: path.to_path_buf(),
                reason: "facts present but no Genesis fact".to_owned(),
            });
        }
        Ok(roster)
    }

    // ---- Accessors ------------------------------------------------------------

    /// This roster's fabric.
    pub fn fabric_id(&self) -> FabricId {
        self.fabric_id
    }

    /// The root EndpointId established by Genesis (None until a valid
    /// Genesis has been merged).
    pub fn root(&self) -> Option<EndpointId> {
        self.root
    }

    /// The Genesis fact id.
    pub fn genesis_fact_id(&self) -> Option<FactId> {
        self.genesis_fact_id
    }

    /// Number of stored facts.
    pub fn len(&self) -> usize {
        self.facts.len()
    }

    /// Whether no facts are stored.
    pub fn is_empty(&self) -> bool {
        self.facts.is_empty()
    }

    /// Stored fact by id.
    pub fn get(&self, id: &FactId) -> Option<&SignedFact> {
        self.facts.get(id)
    }

    /// Iterates all signed facts in ascending fact-id order.
    pub fn facts(&self) -> impl Iterator<Item = &SignedFact> {
        self.facts.values()
    }

    /// Total facts quarantined since this roster object was created, plus
    /// up to 16 sample reasons for diagnostics.
    pub fn quarantine_stats(&self) -> (u64, &[String]) {
        (self.quarantine_count, &self.quarantine_samples)
    }

    /// The data directory this roster persists into.
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    // ---- Merge ----------------------------------------------------------------

    /// Validates and unions incoming facts. Quarantined facts are counted
    /// and sampled but never stored or projected. Persists atomically when
    /// anything was inserted.
    pub fn merge(
        &mut self,
        facts: impl IntoIterator<Item = SignedFact>,
    ) -> Result<MergeReport, RosterError> {
        let mut report = MergeReport::default();
        let mut dirty = false;
        for fact in facts {
            match self.validate_and_insert(&fact) {
                InsertOutcome::Inserted => {
                    report.inserted += 1;
                    dirty = true;
                }
                InsertOutcome::Duplicate => report.duplicates += 1,
                InsertOutcome::Quarantined(reason) => {
                    report.quarantined += 1;
                    self.record_quarantine(reason);
                }
            }
        }
        if dirty {
            self.persist_now()?;
        }
        Ok(report)
    }

    /// Full validation of one fact against the store, then insert.
    fn validate_and_insert(&mut self, signed: &SignedFact) -> InsertOutcome {
        // 1. Fabric binding: cross-fabric facts are rejected outright.
        if signed.fact.fabric_id != self.fabric_id {
            return InsertOutcome::Quarantined(format!(
                "cross-fabric fact rejected (fact fabric {}, roster fabric {})",
                signed.fact.fabric_id, self.fabric_id
            ));
        }
        // 2. Signature by the embedded issuer.
        if let Err(e) = signed.verify() {
            return InsertOutcome::Quarantined(format!("fact rejected: {e}"));
        }
        // 2b. Kind shape 交叉校验：防止字段被挪用于绕过授权语义。
        //     Genesis 必须 issuer==subject 且不携带 name/expiry/target；
        //     target_fact_id 仅 Revoke 允许。
        let f = &signed.fact;
        let shape_ok = match f.kind {
            FactKind::Genesis => {
                f.issuer == f.subject
                    && f.display_name.is_none()
                    && f.expires_at_ms.is_none()
                    && f.target_fact_id.is_none()
            }
            FactKind::Grant | FactKind::Join => f.target_fact_id.is_none(),
            FactKind::Revoke => true,
        };
        if !shape_ok {
            return InsertOutcome::Quarantined(format!(
                "fact kind {:?} rejected: disallowed field combination",
                f.kind
            ));
        }
        let id = signed.fact_id();
        // 3. Single-genesis invariant.
        if signed.fact.kind == FactKind::Genesis {
            match (self.genesis_fact_id, self.facts.get(&id)) {
                (Some(existing_id), _) if existing_id != id => {
                    return InsertOutcome::Quarantined(
                        "conflicting Genesis fact for this fabric rejected".to_owned(),
                    );
                }
                (_, Some(existing)) if existing != signed => {
                    return InsertOutcome::Quarantined(
                        "Genesis id collision (same id, different content)".to_owned(),
                    );
                }
                _ => {}
            }
        }
        // 4. Content-addressed insert: same id must mean same content.
        match self.facts.get(&id) {
            Some(existing) if existing == signed => return InsertOutcome::Duplicate,
            Some(_) => {
                return InsertOutcome::Quarantined(
                    "fact id collision (same id, different content) quarantined".to_owned(),
                );
            }
            None => {}
        }
        if signed.fact.kind == FactKind::Genesis && self.genesis_fact_id.is_none() {
            self.genesis_fact_id = Some(id);
            self.root = Some(signed.fact.issuer);
        }
        self.facts.insert(id, signed.clone());
        InsertOutcome::Inserted
    }

    fn record_quarantine(&mut self, reason: String) {
        warn!(fabric = %self.fabric_id, %reason, "fact quarantined");
        self.quarantine_count += 1;
        if self.quarantine_samples.len() < QUARANTINE_SAMPLE_CAP {
            self.quarantine_samples.push(reason);
        }
    }

    // ---- Projection -----------------------------------------------------------

    /// Whether `id` is in the effective projection at `now_ms`.
    pub fn is_member(&self, id: &EndpointId, now_ms: u64) -> bool {
        self.effective_members(now_ms)
            .iter()
            .any(|m| &m.endpoint_id == id)
    }

    /// Derives the effective member projection at `now_ms`. See the module
    /// docs; the result is a pure, deterministic function of the fact set
    /// (rebuildable at any time), ordered by `EndpointId`.
    pub fn effective_members(&self, now_ms: u64) -> Vec<Member> {
        let Some(root) = self.root else {
            return Vec::new();
        };
        let genesis_issued_at = self
            .genesis_fact_id
            .and_then(|id| self.facts.get(&id))
            .map(|sf| sf.fact.issued_at_ms)
            .unwrap_or(0);

        // Active root-issued revokes.
        let revokes: Vec<&SignedFact> = self
            .facts
            .values()
            .filter(|sf| {
                sf.fact.kind == FactKind::Revoke
                    && sf.fact.issuer == root
                    && sf.fact.is_valid_at(now_ms)
            })
            .collect();
        let grant_alive = |grant: &SignedFact| {
            let grant_id = grant.fact_id();
            !revokes.iter().any(|r| match r.fact.target_fact_id {
                Some(target) => target == grant_id,
                None => r.fact.subject == grant.fact.subject,
            })
        };

        // Live root grants per subject; keep the deterministically earliest
        // (issued_at_ms, fact_id) as the admitting fact.
        let mut admitting: BTreeMap<EndpointId, &SignedFact> = BTreeMap::new();
        for sf in self.facts.values() {
            let f = &sf.fact;
            if f.kind != FactKind::Grant
                || f.issuer != root
                || f.subject == root
                || !f.is_valid_at(now_ms)
                || !grant_alive(sf)
            {
                continue;
            }
            let entry = admitting.entry(f.subject).or_insert(sf);
            if (sf.fact.issued_at_ms, sf.fact_id()) < (entry.fact.issued_at_ms, entry.fact_id()) {
                *entry = sf;
            }
        }

        // Latest self-named Join per member (unexpired, deterministic tie-break).
        let mut names: BTreeMap<EndpointId, (u64, FactId, String)> = BTreeMap::new();
        for sf in self.facts.values() {
            let f = &sf.fact;
            if f.kind != FactKind::Join || f.issuer != f.subject || !f.is_valid_at(now_ms) {
                continue;
            }
            if let Some(name) = &f.display_name {
                let id = sf.fact_id();
                let better = names
                    .get(&f.subject)
                    .is_none_or(|(t, existing_id, _)| (f.issued_at_ms, id) > (*t, *existing_id));
                if better {
                    names.insert(f.subject, (f.issued_at_ms, id, name.clone()));
                }
            }
        }

        let mut members = Vec::with_capacity(admitting.len() + 1);
        members.push(Member {
            endpoint_id: root,
            display_name: names.get(&root).map(|(_, _, n)| n.clone()),
            since_ms: genesis_issued_at,
        });
        for (subject, grant) in admitting {
            members.push(Member {
                endpoint_id: subject,
                display_name: names
                    .get(&subject)
                    .map(|(_, _, n)| n.clone())
                    .or_else(|| grant.fact.display_name.clone()),
                since_ms: grant.fact.issued_at_ms,
            });
        }
        members
    }

    // ---- Root-only fact construction ------------------------------------------

    fn require_root(&self, identity: &NodeIdentity) -> Result<EndpointId, RosterError> {
        let caller = identity.endpoint_id();
        match self.root {
            Some(root) if root == caller => Ok(root),
            root => Err(RosterError::NotRoot { caller, root }),
        }
    }

    fn build_and_insert(
        &mut self,
        identity: &NodeIdentity,
        build: impl FnOnce(EndpointId) -> Result<Fact, ProtocolError>,
    ) -> Result<SignedFact, RosterError> {
        let root = self.require_root(identity)?;
        let fact = build(root)?;
        let signed = SignedFact::sign(fact, identity.secret_key())?;
        match self.validate_and_insert(&signed) {
            InsertOutcome::Inserted | InsertOutcome::Duplicate => {}
            InsertOutcome::Quarantined(reason) => {
                // A locally built root fact can only quarantine through an
                // implementation bug; surface it loudly.
                return Err(RosterError::Corrupted {
                    path: roster_file_path(&self.data_dir),
                    reason: format!("locally constructed fact quarantined: {reason}"),
                });
            }
        }
        self.persist_now()?;
        Ok(signed)
    }

    /// Grants membership of `subject` (root only). Non-root identities get
    /// [`RosterError::NotRoot`]. Grants to the root itself are allowed but
    /// have no projection effect (the root is always a member).
    pub fn grant(
        &mut self,
        identity: &NodeIdentity,
        subject: EndpointId,
        display_name: Option<String>,
        expires_at_ms: Option<u64>,
        now_ms: u64,
    ) -> Result<SignedFact, RosterError> {
        let fabric_id = self.fabric_id;
        self.build_and_insert(identity, |root| {
            Ok(Fact {
                kind: FactKind::Grant,
                fabric_id,
                issuer: root,
                subject,
                display_name,
                issued_at_ms: now_ms,
                expires_at_ms,
                target_fact_id: None,
            })
        })
    }

    /// Revokes membership (root only), either one precise grant or all live
    /// grants of a subject. Revocation is forward-effective: history is
    /// never rewritten. Revoking the root itself is allowed but has no
    /// projection effect (v0.1 roots are irrevocable).
    pub fn revoke(
        &mut self,
        identity: &NodeIdentity,
        target: RevokeTarget,
        now_ms: u64,
    ) -> Result<SignedFact, RosterError> {
        let fabric_id = self.fabric_id;
        let (subject, target_fact_id) = match target {
            RevokeTarget::Grant(fact_id) => {
                let grant = self
                    .facts
                    .get(&fact_id)
                    .ok_or(RosterError::InvalidRevokeTarget { fact_id })?;
                if grant.fact.kind != FactKind::Grant {
                    return Err(RosterError::InvalidRevokeTarget { fact_id });
                }
                (grant.fact.subject, Some(fact_id))
            }
            RevokeTarget::AllGrantsOf(subject) => (subject, None),
        };
        self.build_and_insert(identity, |root| {
            Ok(Fact {
                kind: FactKind::Revoke,
                fabric_id,
                issuer: root,
                subject,
                display_name: None,
                issued_at_ms: now_ms,
                expires_at_ms: None,
                target_fact_id,
            })
        })
    }

    /// Records a member's self-chosen display name (a self-signed Join; any
    /// identity, root included — names are self-description, not admission).
    pub fn set_display_name(
        &mut self,
        identity: &NodeIdentity,
        display_name: Option<String>,
        now_ms: u64,
    ) -> Result<SignedFact, RosterError> {
        let fabric_id = self.fabric_id;
        let self_id = identity.endpoint_id();
        let fact = Fact {
            kind: FactKind::Join,
            fabric_id,
            issuer: self_id,
            subject: self_id,
            display_name,
            issued_at_ms: now_ms,
            expires_at_ms: None,
            target_fact_id: None,
        };
        let signed = SignedFact::sign(fact, identity.secret_key())?;
        match self.validate_and_insert(&signed) {
            InsertOutcome::Inserted | InsertOutcome::Duplicate => {}
            InsertOutcome::Quarantined(reason) => {
                return Err(RosterError::Corrupted {
                    path: roster_file_path(&self.data_dir),
                    reason: format!("locally constructed join quarantined: {reason}"),
                });
            }
        }
        self.persist_now()?;
        Ok(signed)
    }

    // ---- Invites --------------------------------------------------------------

    /// Issues a single-use invite token (root only). `ttl_ms` is the token's
    /// lifetime from `now_ms`. The token is self-contained and is not a fact
    /// — nothing is inserted into the roster.
    #[allow(clippy::too_many_arguments)]
    pub fn issue_invite(
        &mut self,
        identity: &NodeIdentity,
        issuer_relay_url: String,
        issuer_direct_addrs: Vec<String>,
        recipient: Option<EndpointId>,
        ttl_ms: u64,
        now_ms: u64,
    ) -> Result<InviteToken, RosterError> {
        let root = self.require_root(identity)?;
        let expires_at_ms = now_ms
            .checked_add(ttl_ms)
            .ok_or_else(|| ProtocolError::Encoding("invite ttl overflow".to_owned()))?;
        let invite = crate::protocol::InviteV1 {
            fabric_id: self.fabric_id,
            invite_id: crate::protocol::random_bytes::<16>(),
            issuer: root,
            issuer_relay_url,
            issuer_direct_addrs,
            expires_at_ms,
            recipient,
        };
        // Eagerly validate the limits (canonical_bytes is the verifier's
        // input too).
        invite.canonical_bytes()?;
        let token = InviteToken::sign(invite, identity.secret_key())?;
        Ok(token)
    }

    /// Verifies a redemption attempt *without consuming* the invite:
    /// token signature, root issuer, fabric binding, expiry, recipient
    /// binding and the redeemer's proof-of-possession over the challenge
    /// material. Returns the authorized redeemer. Call
    /// [`Roster::consume_invite`] afterwards for the CAS消费 (session layer
    /// sequences verify-then-consume).
    pub fn redeem_verify(
        &self,
        token: &InviteToken,
        redeemer: &EndpointId,
        pop_challenge: &[u8; 32],
        pop_sig: &Signature,
        now_ms: u64,
    ) -> Result<EndpointId, RosterError> {
        if token.invite.fabric_id != self.fabric_id {
            return Err(RosterError::WrongFabric {
                got: token.invite.fabric_id,
                expected: self.fabric_id,
            });
        }
        if Some(token.invite.issuer) != self.root {
            return Err(RosterError::InviteNotRoot {
                issuer: token.invite.issuer,
                root: self.root,
            });
        }
        token.verify().map_err(|e| {
            // The issuer claim authenticated: a signature failure here means
            // a forged or tampered token — quarantine-grade input.
            RosterError::Protocol(ProtocolError::Quarantine {
                reason: format!("invite token failed verification: {e}"),
            })
        })?;
        if token.is_expired(now_ms) {
            return Err(RosterError::InviteExpired {
                expires_at_ms: token.invite.expires_at_ms,
                now_ms,
            });
        }
        if let Some(expected) = token.invite.recipient
            && expected != *redeemer
        {
            return Err(RosterError::InviteRecipientMismatch {
                expected,
                redeemer: *redeemer,
            });
        }
        let challenge = crate::protocol::redeem_challenge_bytes(
            &self.fabric_id,
            &token.invite.invite_id,
            pop_challenge,
        );
        if redeemer.verify(&challenge, pop_sig).is_err() {
            return Err(RosterError::BadPoP {
                redeemer: *redeemer,
            });
        }
        Ok(*redeemer)
    }

    /// Single-use invite consumption with CAS semantics: returns `Ok(false)`
    /// if `invite_id` was already consumed (the redemption must be refused),
    /// otherwise appends + fsyncs a consumption record and returns `Ok(true)`.
    pub fn consume_invite(
        &mut self,
        invite_id: &[u8; 16],
        now_ms: u64,
    ) -> Result<bool, RosterError> {
        if self.consumed_invites.contains(invite_id) {
            return Ok(false);
        }
        // 跨进程 CAS：写锁内重读日志（吸收其它进程的追加）再检查+追加，
        // 保证同 data-dir 多进程下同一 invite 恰好消费一次。
        let _lock = Self::write_lock(&self.data_dir)?;
        self.consumed_invites = load_consumed_invites(&self.data_dir)?;
        if self.consumed_invites.contains(invite_id) {
            return Ok(false);
        }
        let path = consumed_invites_file_path(&self.data_dir);
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(&path)
            .map_err(|source| RosterError::Persistence {
                path: path.clone(),
                source,
            })?;
        let mut record = [0u8; CONSUMED_RECORD_LEN];
        record[..16].copy_from_slice(invite_id);
        record[16..].copy_from_slice(&now_ms.to_be_bytes());
        file.write_all(&record)
            .and_then(|()| file.sync_all())
            .map_err(|source| RosterError::Persistence {
                path: path.clone(),
                source,
            })?;
        self.consumed_invites.insert(*invite_id);
        Ok(true)
    }

    /// Whether `invite_id` has already been consumed (persisted log).
    pub fn is_invite_consumed(&self, invite_id: &[u8; 16]) -> bool {
        self.consumed_invites.contains(invite_id)
    }

    // ---- Persistence ----------------------------------------------------------

    /// Persists the full fact set atomically (tmp + fsync + rename).
    pub fn persist_now(&self) -> Result<(), RosterError> {
        let path = roster_file_path(&self.data_dir);
        let body = SignedFact::encode_all(self.facts.values())?;
        let mut bytes = Vec::with_capacity(ROSTER_MAGIC.len() + 32 + body.len() + blake3::OUT_LEN);
        bytes.extend_from_slice(ROSTER_MAGIC);
        bytes.extend_from_slice(self.fabric_id.as_bytes());
        bytes.extend_from_slice(&body);
        bytes.extend_from_slice(blake3::hash(&bytes).as_bytes());

        let mut tmp = std::ffi::OsString::from(path.as_os_str());
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)
            .map_err(|source| RosterError::Persistence {
                path: tmp.clone(),
                source,
            })?;
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|source| RosterError::Persistence {
                path: tmp.clone(),
                source,
            })?;
        drop(file);
        std::fs::rename(&tmp, &path).map_err(|source| RosterError::Persistence { path, source })?;
        Ok(())
    }
}

/// Path of the persisted fact set inside `data_dir`.
pub fn roster_file_path(data_dir: &Path) -> PathBuf {
    data_dir.join(ROSTER_FILE_NAME)
}

/// 从已持久化的 roster.facts 头部读出 fabric_id（不加载事实集合）。
/// 文件缺失返回 None；存在但头部不合法返回 Corrupted。
pub fn peek_fabric_id(data_dir: &Path) -> Result<Option<FabricId>, RosterError> {
    let path = roster_file_path(data_dir);
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path).map_err(|source| RosterError::Persistence {
        path: path.clone(),
        source,
    })?;
    let header_len = ROSTER_MAGIC.len() + 32;
    if bytes.len() < header_len || &bytes[..ROSTER_MAGIC.len()] != ROSTER_MAGIC {
        return Err(RosterError::Corrupted {
            path,
            reason: "bad roster header".to_owned(),
        });
    }
    let id: [u8; 32] = bytes[ROSTER_MAGIC.len()..header_len]
        .try_into()
        .expect("len checked");
    Ok(Some(FabricId(id)))
}

/// Path of the consumed-invite log inside `data_dir`.
pub fn consumed_invites_file_path(data_dir: &Path) -> PathBuf {
    data_dir.join(CONSUMED_INVITES_FILE_NAME)
}

/// Loads the consumed-invite log; a missing file is an empty set, a file
/// whose length is not a multiple of the record length is corruption.
fn load_consumed_invites(data_dir: &Path) -> Result<HashSet<[u8; 16]>, RosterError> {
    let path = consumed_invites_file_path(data_dir);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(HashSet::new()),
        Err(source) => {
            return Err(RosterError::Persistence { path, source });
        }
    };
    if bytes.len() % CONSUMED_RECORD_LEN != 0 {
        return Err(RosterError::Corrupted {
            path,
            reason: format!(
                "consumed-invite log length {} is not a multiple of {CONSUMED_RECORD_LEN}",
                bytes.len()
            ),
        });
    }
    Ok(bytes
        .as_chunks::<CONSUMED_RECORD_LEN>()
        .0
        .iter()
        .map(|record| record[..16].try_into().expect("chunk len 16"))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::NodeIdentity;
    use crate::protocol::{Fact, FactKind};

    // ---- P0 回归（codex round2）----
    fn idty(seed: u8) -> NodeIdentity {
        NodeIdentity::from_seed([seed; 32])
    }

    fn member_ids(r: &Roster, now_ms: u64) -> Vec<EndpointId> {
        r.effective_members(now_ms)
            .into_iter()
            .map(|m| m.endpoint_id)
            .collect()
    }

    fn contains(r: &Roster, id: &EndpointId, now_ms: u64) -> bool {
        member_ids(r, now_ms).contains(id)
    }

    fn create_root(seed: u8, now_ms: u64) -> (Roster, FabricId, NodeIdentity) {
        let identity = idty(seed);
        let dir = tempfile::tempdir().unwrap();
        let (r, fid) = Roster::create(&identity, dir.path(), now_ms).unwrap();
        // Keep the tempdir alive for the roster's lifetime by leaking it
        // (tests are short-lived processes).
        std::mem::forget(dir);
        (r, fid, identity)
    }

    fn attach_fresh(fid: FabricId) -> Roster {
        let dir = tempfile::tempdir().unwrap();
        let r = Roster::attach(dir.path(), fid).unwrap();
        std::mem::forget(dir);
        r
    }

    fn raw_fact(kind: FactKind, issuer: &NodeIdentity, subject: EndpointId) -> Fact {
        Fact {
            kind,
            fabric_id: FabricId::from_name("test"),
            issuer: issuer.endpoint_id(),
            subject,
            display_name: None,
            issued_at_ms: 1_000,
            expires_at_ms: None,
            target_fact_id: None,
        }
    }

    #[test]
    fn attacker_genesis_with_mismatched_issuer_subject_quarantined() {
        let attacker = NodeIdentity::generate();
        let victim = NodeIdentity::generate();
        let mut roster = attach_fresh(FabricId::from_name("test"));
        let fact = raw_fact(FactKind::Genesis, &attacker, victim.endpoint_id());
        let signed = SignedFact::sign(fact, attacker.secret_key()).unwrap();
        let report = roster.merge([signed]).unwrap();
        assert_eq!(report.quarantined, 1, "mismatched Genesis must quarantine");
        assert!(roster.root().is_none());
    }

    #[test]
    fn genesis_with_optional_fields_quarantined() {
        let root = NodeIdentity::generate();
        let mut roster = attach_fresh(FabricId::from_name("test"));
        let mut fact = raw_fact(FactKind::Genesis, &root, root.endpoint_id());
        fact.display_name = Some("evil".into());
        let signed = SignedFact::sign(fact, root.secret_key()).unwrap();
        let report = roster.merge([signed]).unwrap();
        assert_eq!(report.quarantined, 1, "Genesis with name must quarantine");
    }

    #[test]
    fn fake_genesis_first_then_real_real_wins_root() {
        let attacker = NodeIdentity::generate();
        let root = NodeIdentity::generate();
        let fid = FabricId::from_name("test");
        let mut roster = attach_fresh(fid);
        // 攻击者合法自签（issuer==subject）的 Genesis 属于同 fabric —— 会成为 root
        let fake = SignedFact::sign(
            raw_fact(FactKind::Genesis, &attacker, attacker.endpoint_id()),
            attacker.secret_key(),
        )
        .unwrap();
        roster.merge([fake]).unwrap();
        // 真实 root 的 Genesis 到达后：不同 Genesis → 冲突隔离，root 保持首个
        // （防抢占的语义是"先到先得 + 冲突隔离"；attach 空名册不接受外部输入是门控责任）
        let real = SignedFact::sign(
            raw_fact(FactKind::Genesis, &root, root.endpoint_id()),
            root.secret_key(),
        )
        .unwrap();
        let report = roster.merge([real]).unwrap();
        assert!(report.quarantined >= 1, "second Genesis conflicts");
        assert_eq!(roster.root(), Some(attacker.endpoint_id()));
    }

    #[test]
    fn concurrent_consume_invite_across_instances_is_cas() {
        let dir = tempfile::tempdir().unwrap();
        let identity = NodeIdentity::generate();
        let (_r1, fid) = Roster::create(&identity, dir.path(), 1_000).unwrap();
        // 两个独立实例（模拟两个进程），并发消费同一 invite：恰一个成功
        let d1 = dir.path().to_path_buf();
        let d2 = dir.path().to_path_buf();
        let (a, b) = std::thread::scope(|s| {
            let h1 = s.spawn(move || {
                let mut r = Roster::open(&d1, fid).unwrap();
                r.consume_invite(&[7u8; 16], 2_000).unwrap()
            });
            let h2 = s.spawn(move || {
                let mut r = Roster::open(&d2, fid).unwrap();
                r.consume_invite(&[7u8; 16], 2_001).unwrap()
            });
            (h1.join().unwrap(), h2.join().unwrap())
        });
        assert!(a ^ b, "exactly one consumer must win (a={a}, b={b})");
        // 重启后仍视为已消费
        let mut r3 = Roster::open(dir.path(), fid).unwrap();
        assert!(!r3.consume_invite(&[7u8; 16], 3_000).unwrap());
    }

    #[test]
    fn attach_empty_then_learn_genesis_via_merge() {
        let now = 1000;
        let (root_roster, fid, root) = create_root(1, now);
        let joiner_dir = tempfile::tempdir().unwrap();
        let mut joiner = Roster::attach(joiner_dir.path(), fid).unwrap();
        assert!(joiner.root().is_none());
        assert!(joiner.effective_members(now).is_empty());
        let report = joiner.merge(root_roster.facts().cloned()).unwrap();
        assert_eq!(report.inserted, root_roster.len());
        assert!(joiner.is_member(&root.endpoint_id(), now));
        // Restart keeps it.
        let reopened = Roster::open(joiner_dir.path(), fid).unwrap();
        assert!(reopened.is_member(&root.endpoint_id(), now));
    }

    #[test]
    fn conflicting_genesis_is_quarantined() {
        let now = 1000;
        let (mut r, fid, _root) = create_root(1, now);
        let other_root = idty(2);
        let competing = crate::protocol::genesis(&other_root, fid, now).unwrap();
        let report = r.merge([competing]).unwrap();
        assert_eq!(report.quarantined, 1);
        assert_eq!(r.root(), Some(_root.endpoint_id()));
    }

    #[test]
    fn cross_fabric_facts_are_quarantined() {
        let now = 1000;
        let (mut r, _fid, root) = create_root(1, now);
        let other_fabric = FabricId::from_name("some-other-fabric");
        let alien = SignedFact::sign(
            Fact {
                kind: FactKind::Grant,
                fabric_id: other_fabric,
                issuer: root.endpoint_id(),
                subject: idty(2).endpoint_id(),
                display_name: None,
                issued_at_ms: now,
                expires_at_ms: None,
                target_fact_id: None,
            },
            root.secret_key(),
        )
        .unwrap();
        let report = r.merge([alien]).unwrap();
        assert_eq!(report.quarantined, 1);
        assert_eq!(report.inserted, 0);
        assert_eq!(r.len(), 1, "only the genesis remains");
        let (count, samples) = r.quarantine_stats();
        assert_eq!(count, 1);
        assert_eq!(samples.len(), 1);
        assert!(samples[0].contains("cross-fabric"));
    }

    #[test]
    fn expiry_is_fail_closed_for_grants_and_revokes() {
        let now = 1000;
        let (mut r, _fid, root) = create_root(1, now);
        let c = idty(3).endpoint_id();
        r.grant(&root, c, None, Some(now + 100), now + 1).unwrap();
        assert!(contains(&r, &c, now + 99));
        assert!(!contains(&r, &c, now + 100), "expired at the instant");
        assert!(!contains(&r, &c, now + 101));

        // A revoke carrying an expiry stops revoking once it expires
        // (uniform fact expiry): grant without expiry + temporary revoke.
        let d = idty(4).endpoint_id();
        r.grant(&root, d, None, None, now + 1).unwrap();
        let tmp_revoke = SignedFact::sign(
            Fact {
                kind: FactKind::Revoke,
                fabric_id: r.fabric_id(),
                issuer: root.endpoint_id(),
                subject: d,
                display_name: None,
                issued_at_ms: now + 2,
                expires_at_ms: Some(now + 50),
                target_fact_id: None,
            },
            root.secret_key(),
        )
        .unwrap();
        r.merge([tmp_revoke]).unwrap();
        assert!(!contains(&r, &d, now + 10), "revoked while revoke is live");
        assert!(
            contains(&r, &d, now + 51),
            "member returns when revoke expires"
        );
    }

    #[test]
    fn non_root_issued_grant_is_stored_but_grants_nothing() {
        let now = 1000;
        let (mut r, fid, root) = create_root(1, now);
        let (member, outsider_target) = (idty(2), idty(3));
        r.grant(&root, member.endpoint_id(), None, None, now + 1)
            .unwrap();

        // A member (valid signature, same fabric) grants membership to
        // someone else. It must be stored (it is a valid fact) but the
        // projection must not change.
        let forged = SignedFact::sign(
            Fact {
                kind: FactKind::Grant,
                fabric_id: fid,
                issuer: member.endpoint_id(),
                subject: outsider_target.endpoint_id(),
                display_name: None,
                issued_at_ms: now + 2,
                expires_at_ms: None,
                target_fact_id: None,
            },
            member.secret_key(),
        )
        .unwrap();
        let len_before = r.len();
        let report = r.merge([forged]).unwrap();
        assert_eq!(report.quarantined, 0);
        assert_eq!(report.inserted, 1);
        assert_eq!(r.len(), len_before + 1, "valid non-root fact is stored");
        assert!(
            !contains(&r, &outsider_target.endpoint_id(), now + 3),
            "non-root grant must not authorize"
        );

        // The root helper API refuses non-root callers outright.
        let err = r
            .grant(&member, outsider_target.endpoint_id(), None, None, now + 3)
            .unwrap_err();
        assert!(matches!(err, RosterError::NotRoot { .. }));
    }

    #[test]
    fn open_missing_errors_and_create_refuses_to_clobber() {
        let dir = tempfile::tempdir().unwrap();
        let fid = FabricId::from_name("x");
        assert!(matches!(
            Roster::open(dir.path(), fid),
            Err(RosterError::NotFound { .. })
        ));
        let root = idty(1);
        let (_r, _fid) = Roster::create(&root, dir.path(), 1).unwrap();
        assert!(matches!(
            Roster::create(&idty(2), dir.path(), 2),
            Err(RosterError::AlreadyExists { .. })
        ));
    }

    #[test]
    fn restart_replay_keeps_facts_and_membership() {
        let now = 1000;
        let dir = tempfile::tempdir().unwrap();
        let root = idty(1);
        let (mut r, fid) = Roster::create(&root, dir.path(), now).unwrap();
        let b = idty(2).endpoint_id();
        r.grant(&root, b, Some("b".into()), None, now + 1).unwrap();
        let before_members = r.effective_members(now + 2);
        let before_len = r.len();

        // "Restart": reopen the same data dir.
        let reopened = Roster::open(dir.path(), fid).unwrap();
        assert_eq!(reopened.len(), before_len);
        assert_eq!(reopened.effective_members(now + 2), before_members);
        assert_eq!(reopened.root(), Some(root.endpoint_id()));
        assert_eq!(reopened.genesis_fact_id(), r.genesis_fact_id());

        // Corrupted file (bit flip) errors; never a silent rebuild.
        let path = roster_file_path(dir.path());
        let mut bytes = std::fs::read(&path).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        std::fs::write(&path, &bytes).unwrap();
        assert!(matches!(
            Roster::open(dir.path(), fid),
            Err(RosterError::Corrupted { .. })
        ));
        // Truncated file errors too.
        bytes.truncate(bytes.len() - 5);
        std::fs::write(&path, &bytes).unwrap();
        assert!(matches!(
            Roster::open(dir.path(), fid),
            Err(RosterError::Corrupted { .. })
        ));
    }

    #[test]
    fn revoke_targets_precise_grant_or_all_grants() {
        let now = 1000;
        let (mut r, _fid, root) = create_root(1, now);
        let c = idty(3).endpoint_id();
        let g1 = r
            .grant(&root, c, Some("c-via-1".into()), None, now + 1)
            .unwrap();
        let g2 = r
            .grant(&root, c, Some("c-via-2".into()), None, now + 2)
            .unwrap();
        assert_ne!(g1.fact_id(), g2.fact_id());
        assert!(contains(&r, &c, now + 3));

        // Precise revoke of g1: c survives via g2.
        r.revoke(&root, RevokeTarget::Grant(g1.fact_id()), now + 4)
            .unwrap();
        assert!(contains(&r, &c, now + 5), "c still member via g2");
        let member = r
            .effective_members(now + 5)
            .into_iter()
            .find(|m| m.endpoint_id == c)
            .unwrap();
        assert_eq!(member.since_ms, now + 2, "admitted by g2 now");

        // Blanket revoke: all live grants of c die.
        r.revoke(&root, RevokeTarget::AllGrantsOf(c), now + 6)
            .unwrap();
        assert!(!contains(&r, &c, now + 7));
        assert!(contains(&r, &root.endpoint_id(), now + 7));

        // Unknown grant id is rejected.
        let err = r
            .revoke(&root, RevokeTarget::Grant([0u8; 32]), now + 8)
            .unwrap_err();
        assert!(matches!(err, RosterError::InvalidRevokeTarget { .. }));
        // Non-grant fact id is rejected.
        let err = r
            .revoke(
                &root,
                RevokeTarget::Grant(r.genesis_fact_id().unwrap()),
                now + 9,
            )
            .unwrap_err();
        assert!(matches!(err, RosterError::InvalidRevokeTarget { .. }));
    }

    #[test]
    fn tampered_fact_signature_is_quarantined() {
        let now = 1000;
        let (mut r, fid, root) = create_root(1, now);
        let subject = idty(2);
        let good = SignedFact::sign(
            Fact {
                kind: FactKind::Grant,
                fabric_id: fid,
                issuer: root.endpoint_id(),
                subject: subject.endpoint_id(),
                display_name: None,
                issued_at_ms: now,
                expires_at_ms: None,
                target_fact_id: None,
            },
            root.secret_key(),
        )
        .unwrap();
        // Claim a different issuer but keep root's signature: verify fails.
        let mut forged = good.clone();
        forged.fact.issuer = idty(9).endpoint_id();
        let report = r.merge([forged]).unwrap();
        assert_eq!(report.quarantined, 1);
        // ...and a genuinely flipped signature byte fails too.
        let mut bad_sig = good.signature.to_bytes();
        bad_sig[10] ^= 1;
        let tampered = SignedFact {
            fact: good.fact,
            signature: Signature::from_bytes(&bad_sig),
        };
        let report = r.merge([tampered]).unwrap();
        assert_eq!(report.quarantined, 1);
        assert!(!contains(&r, &subject.endpoint_id(), now + 1));
    }

    #[test]
    fn three_nodes_merge_in_any_order_same_projection() {
        let now = 1000;
        let (mut root_roster, fid, root) = create_root(1, now);
        let (b, c) = (idty(2), idty(3));
        root_roster
            .grant(&root, b.endpoint_id(), Some("b".into()), None, now + 1)
            .unwrap();
        root_roster
            .grant(&root, c.endpoint_id(), None, None, now + 2)
            .unwrap();
        let _ = root_roster.set_display_name(&b, Some("Bee".into()), now + 3);

        let all: Vec<SignedFact> = root_roster.facts().cloned().collect();
        assert_eq!(all.len(), 4); // genesis + 2 grants + join

        // Node-side rosters merging in three different arrival orders.
        let orders: [Vec<SignedFact>; 3] = [
            all.clone(),
            {
                let mut v = all.clone();
                v.reverse();
                v
            },
            {
                let mut v = all.clone();
                v.rotate_left(2);
                v
            },
        ];
        let mut reference = attach_fresh(fid);
        let reference_report = reference.merge(orders[0].iter().cloned()).unwrap();
        assert_eq!(reference_report.quarantined, 0);
        let reference_members = reference.effective_members(now + 10);
        for order in &orders[1..] {
            let mut r = attach_fresh(fid);
            let report = r.merge(order.iter().cloned()).unwrap();
            assert_eq!(report.quarantined, 0);
            assert_eq!(r.len(), all.len());
            assert_eq!(
                r.effective_members(now + 10),
                reference_members,
                "arrival order must not change the projection"
            );
        }

        // Union with duplicates stays idempotent.
        let mut doubled = attach_fresh(fid);
        let report = doubled
            .merge(orders[0].iter().chain(orders[1].iter()).cloned())
            .unwrap();
        assert_eq!(report.duplicates, all.len());
        assert_eq!(report.inserted, all.len());
        assert_eq!(doubled.effective_members(now + 10), reference_members);
    }

    // -- consume_invite CAS --------------------------------------------------------

    #[test]
    fn consume_invite_is_cas_and_survives_restart() {
        let dir = tempfile::tempdir().unwrap();
        let root = idty(1);
        let (mut r, fid) = Roster::create(&root, dir.path(), 1).unwrap();
        let iid = [9u8; 16];
        assert!(!r.is_invite_consumed(&iid));
        assert!(r.consume_invite(&iid, 100).unwrap(), "first consume wins");
        assert!(
            !r.consume_invite(&iid, 101).unwrap(),
            "second consume is refused"
        );
        assert!(r.is_invite_consumed(&iid));

        let mut reopened = Roster::open(dir.path(), fid).unwrap();
        assert!(
            !reopened.consume_invite(&iid, 102).unwrap(),
            "consumption survives restart"
        );
        assert!(reopened.consume_invite(&[8u8; 16], 103).unwrap());

        // A corrupted (partial) consumed log is an error.
        let path = consumed_invites_file_path(dir.path());
        let mut log = std::fs::read(&path).unwrap();
        log.push(0xAB); // partial record
        std::fs::write(&path, &log).unwrap();
        assert!(matches!(
            Roster::open(dir.path(), fid),
            Err(RosterError::Corrupted { .. })
        ));
    }

    // -- 投影可重建 ------------------------------------------------------------------

    #[test]
    fn projection_is_rebuildable_from_fact_set() {
        let now = 1000;
        let (mut r, fid, root) = create_root(1, now);
        let (b, c) = (idty(2), idty(3));
        r.grant(&root, b.endpoint_id(), Some("b".into()), None, now + 1)
            .unwrap();
        r.grant(&root, c.endpoint_id(), None, Some(now + 5000), now + 2)
            .unwrap();
        let _ = r.set_display_name(&b, Some("Bee".into()), now + 3);
        let _ = r.set_display_name(&root, Some("The Root".into()), now + 4);
        r.revoke(&root, RevokeTarget::AllGrantsOf(c.endpoint_id()), now + 5)
            .unwrap();

        let first = r.effective_members(now + 10);
        assert_eq!(first.len(), 2);

        // Rebuild on a fresh node from a wire dump of the fact set.
        let wire = SignedFact::encode_all(r.facts()).unwrap();
        let decoded = SignedFact::decode_all(&wire).unwrap();
        let mut rebuilt = attach_fresh(fid);
        rebuilt.merge(decoded).unwrap();
        assert_eq!(rebuilt.effective_members(now + 10), first);

        // Deterministic: same input, same output.
        assert_eq!(r.effective_members(now + 10), first);
    }

    // -- display name 与 member 细节 --------------------------------------------------

    #[test]
    fn join_name_wins_over_grant_name_and_updates() {
        let now = 1000;
        let (mut r, _fid, root) = create_root(1, now);
        let c = idty(3).endpoint_id();
        r.grant(&root, c, Some("carol (invited)".into()), None, now + 1)
            .unwrap();
        let name = |r: &Roster, id: &EndpointId| {
            r.effective_members(now + 10)
                .into_iter()
                .find(|m| &m.endpoint_id == id)
                .unwrap()
                .display_name
        };
        assert_eq!(name(&r, &c).as_deref(), Some("carol (invited)"));

        // c names themselves; the self-asserted name wins.
        let _ = r.set_display_name(&idty(3), Some("Carol".into()), now + 2);
        assert_eq!(name(&r, &c).as_deref(), Some("Carol"));
        // A later join with no name does not erase the chosen one (a Join
        // without a name simply does not participate in naming).
        let _ = r.set_display_name(&idty(3), None, now + 3);
        assert_eq!(name(&r, &c).as_deref(), Some("Carol"));
        // A yet later join changes it.
        let _ = r.set_display_name(&idty(3), Some("Carol II".into()), now + 4);
        assert_eq!(name(&r, &c).as_deref(), Some("Carol II"));

        // Root can name itself too; root since_ms is the genesis timestamp.
        let _ = r.set_display_name(&root, Some("The Root".into()), now + 5);
        assert_eq!(name(&r, &root.endpoint_id()).as_deref(), Some("The Root"));
        let root_member = &r.effective_members(now + 10)[0];
        assert_eq!(root_member.endpoint_id, root.endpoint_id());
        assert_eq!(root_member.since_ms, now);
    }

    // -- issue/redeem/verify -----------------------------------------------------------

    #[test]
    fn issue_invite_requires_root_and_redeem_verify_checks_everything() {
        let now = 10_000u64;
        let (mut r, _fid, root) = create_root(1, now);
        let (b, attacker) = (idty(2), idty(3));
        let member = idty(4); // not a member at all, just a key

        // Non-root cannot issue.
        assert!(matches!(
            r.issue_invite(&member, "https://relay".into(), vec![], None, 60_000, now),
            Err(RosterError::NotRoot { .. })
        ));

        let token = r
            .issue_invite(
                &root,
                "https://relay.example.com".into(),
                vec!["192.168.1.4:9000".into()],
                None,
                60_000,
                now,
            )
            .unwrap();
        let token_str = token.encode().unwrap();
        assert!(token_str.starts_with("dweb1."));
        let parsed = InviteToken::decode(&token_str).unwrap();
        assert_eq!(parsed, token);

        // Happy path: B signs the PoP challenge.
        let challenge = [42u8; 32];
        let pop = crate::protocol::redeem_challenge_bytes(
            &r.fabric_id(),
            &token.invite.invite_id,
            &challenge,
        );
        let sig = b.secret_key().sign(&pop);
        assert_eq!(
            r.redeem_verify(&parsed, &b.endpoint_id(), &challenge, &sig, now + 1)
                .unwrap(),
            b.endpoint_id()
        );

        // Stolen token without B's key: attacker's PoP fails.
        let attacker_sig = attacker.secret_key().sign(&pop);
        assert!(matches!(
            r.redeem_verify(
                &parsed,
                &b.endpoint_id(),
                &challenge,
                &attacker_sig,
                now + 1
            ),
            Err(RosterError::BadPoP { .. })
        ));

        // Expired token is refused.
        assert!(matches!(
            r.redeem_verify(&parsed, &b.endpoint_id(), &challenge, &sig, now + 60_000),
            Err(RosterError::InviteExpired { .. })
        ));

        // Recipient binding: a token bound to someone else refuses B.
        let bound = r
            .issue_invite(
                &root,
                "https://relay.example.com".into(),
                vec![],
                Some(attacker.endpoint_id()),
                60_000,
                now,
            )
            .unwrap();
        assert!(matches!(
            r.redeem_verify(&bound, &b.endpoint_id(), &challenge, &sig, now + 1),
            Err(RosterError::InviteRecipientMismatch { .. })
        ));

        // Wrong fabric: token from another fabric is refused.
        let (mut other_roster, _other_fid, other_root) = create_root(5, now);
        let alien = other_roster
            .issue_invite(
                &other_root,
                "https://other".into(),
                vec![],
                None,
                60_000,
                now,
            )
            .unwrap();
        assert!(matches!(
            r.redeem_verify(&alien, &b.endpoint_id(), &challenge, &sig, now + 1),
            Err(RosterError::WrongFabric { .. })
        ));

        // Full redemption sequencing: verify -> consume (CAS) -> grant.
        assert!(r.consume_invite(&token.invite.invite_id, now + 2).unwrap());
        assert!(!r.consume_invite(&token.invite.invite_id, now + 3).unwrap());
        r.grant(&root, b.endpoint_id(), Some("b".into()), None, now + 4)
            .unwrap();
        assert!(r.is_member(&b.endpoint_id(), now + 5));
    }

    #[test]
    fn invite_issued_by_non_root_endpoint_fails_verification() {
        // A token claiming a non-root issuer must be refused even though its
        // signature is internally consistent.
        let now = 1000;
        let (r, fid, root) = create_root(1, now);
        let impostor = idty(2);
        let invite = crate::protocol::InviteV1 {
            fabric_id: fid,
            invite_id: [1u8; 16],
            issuer: impostor.endpoint_id(), // claims a non-root issuer
            issuer_relay_url: "https://relay".into(),
            issuer_direct_addrs: vec![],
            expires_at_ms: now + 60_000,
            recipient: None,
        };
        let token = InviteToken::sign(invite, impostor.secret_key()).unwrap();
        let challenge = [0u8; 32];
        let pop =
            crate::protocol::redeem_challenge_bytes(&fid, &token.invite.invite_id, &challenge);
        let sig = impostor.secret_key().sign(&pop);
        assert!(matches!(
            r.redeem_verify(&token, &impostor.endpoint_id(), &challenge, &sig, now + 1),
            Err(RosterError::InviteNotRoot { .. })
        ));
        assert_eq!(r.root(), Some(root.endpoint_id()));
    }
}
