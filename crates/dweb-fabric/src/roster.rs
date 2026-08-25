//! Signed-fact membership roster: union-merge convergence and the effective
//! member projection (fabric spec: roster).
//!
//! # Model
//!
//! The roster is a set of [`SignedFact`]s keyed by fact id. Membership is
//! *derived*, never stored directly: [`Roster::effective_members`] recomputes
//! the projection from the fact set at any time, so it is trivially
//! rebuildable.
//!
//! # Union-merge
//!
//! [`Roster::merge`] unions fact sets by id. Every incoming fact's signature
//! is verified against the issuer identity embedded in the fact itself
//! (this proves possession of the issuer's private key — *not* that the
//! issuer is trusted; trust is computed during projection). Invalid
//! signatures are rejected outright and counted. Same-id facts must be
//! byte-identical; a mismatch keeps the first-seen version, logs a warning
//! and is counted as a conflict (per spec this indicates an implementation
//! bug somewhere). Merge is therefore commutative and associative on
//! signature-valid, conflict-free inputs, and idempotent for duplicate
//! delivery in any order.
//!
//! # Effective projection & revocation semantics (v0.1)
//!
//! An *edge* is a Grant or Join fact `G` with issuer `I` admitting subject
//! `S`. Grant and Join are both admission edges; Join is normally issued by
//! the joiner about themselves (an acceptance record).
//!
//! - **Roots**: any endpoint with an unexpired self-Grant (`I == S`, kind
//!   Grant) is a root. v0.1 intentionally allows multiple roots — every
//!   node that bootstraps a network is one, and a merged network simply has
//!   several. Roots are the fixed points of the derivation and are *not*
//!   revocable by other roots in v0.1; a root leaves only by revoking
//!   itself (self-resignation). This keeps root computation non-circular
//!   and trust anchors symmetric.
//! - **Membership**: BFS from the roots over edges that are (a) unexpired
//!   at `now_ms` and (b) not covered by an active Revocation. An edge from
//!   `I` only counts while `I` is itself a member, so revoking (or
//!   expiring) an intermediate member collapses everything they granted.
//! - **Revocation matching**: an active (unexpired) Revoke fact `R` kills
//!   the edge admitting `S = R.subject` when
//!   `R.issuer == G.issuer` (the grantor retracts their own grant), or
//!   `R.issuer == G.subject` (self-resignation), or
//!   `R.issuer` is a root (roots may revoke any *non-root* member).
//! - **Expiry**: any fact past `expires_at_ms` is inert — Grants lapse
//!   naturally, and (uniformly) an expired Revoke stops revoking, which
//!   lets the member return. This uniformity is deliberate and tested.
//! - **Display names**: a member's latest active self-Join name (by
//!   `issued_at_ms`, tie-broken by fact id) wins over the name on the
//!   admitting grant: members get to name themselves.
//!
//! Revocation is forward-effective only: existing facts are never rewritten
//! or deleted; sessions opened before a revoke arrives are the session
//! layer's business.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use thiserror::Error;

use crate::identity::{EndpointId, NodeIdentity};
use crate::protocol::{
    Fact, FactKind, InviteError, InviteToken, ProtocolError, RendezvousHint, SignedFact,
};

/// Errors from roster-level operations (fact construction helpers and
/// invite redemption).
#[derive(Debug, Error)]
pub enum RosterError {
    /// Canonical/signature-level failure.
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
    /// Invite redemption validation failure.
    #[error(transparent)]
    Invite(#[from] InviteError),
    /// The token's grant names a different subject than the redeeming node.
    #[error("invite token is for subject {subject}, not joiner {joiner}")]
    InviteSubjectMismatch {
        subject: EndpointId,
        joiner: EndpointId,
    },
    /// A locally constructed fact failed to insert (should be impossible:
    /// fresh UUIDv7 ids, valid signatures).
    #[error("internal inconsistency while constructing facts: {0}")]
    Internal(String),
}

/// One derived member of the effective projection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    /// The member's stable identity.
    pub endpoint_id: EndpointId,
    /// Preferred label: latest self-Join name, else the admitting grant's
    /// label.
    pub display_name: Option<String>,
    /// Whether this member is a trust root (holds an unexpired self-Grant).
    pub is_root: bool,
    /// Who admitted this member (== `endpoint_id` for roots). When several
    /// live edges admit the same member, the one with the lowest fact id is
    /// reported.
    pub granted_by: EndpointId,
    /// `issued_at_ms` of the admitting fact.
    pub granted_at_ms: u64,
    /// `expires_at_ms` of the admitting fact.
    pub expires_at_ms: Option<u64>,
}

/// Outcome of merging a single fact.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeOutcome {
    /// New fact id: inserted.
    Inserted,
    /// Same id, identical bytes: no-op.
    Duplicate,
    /// Same id, different bytes: kept the first-seen version (conflict).
    ConflictKeptExisting,
    /// Signature verification failed: not stored.
    RejectedBadSignature,
}

/// Statistics from [`Roster::merge`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MergeReport {
    /// Facts newly inserted.
    pub inserted: usize,
    /// Re-deliveries of facts already present (identical bytes).
    pub duplicates: usize,
    /// Same-id facts with different bytes; first-seen kept.
    pub conflicts: usize,
    /// Facts rejected for invalid signatures.
    pub rejected: usize,
    /// Ids of the rejected facts.
    pub rejected_ids: Vec<[u8; 16]>,
}

/// A set of signed membership facts plus derived projections.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Roster {
    facts: BTreeMap<[u8; 16], SignedFact>,
}

impl Roster {
    /// Empty roster.
    pub fn new() -> Self {
        Self::default()
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
    pub fn get(&self, id: &[u8; 16]) -> Option<&SignedFact> {
        self.facts.get(id)
    }

    /// Iterates all facts in ascending fact-id order.
    pub fn iter(&self) -> impl Iterator<Item = (&[u8; 16], &SignedFact)> {
        self.facts.iter()
    }

    /// Iterates all signed facts in ascending fact-id order.
    pub fn facts(&self) -> impl Iterator<Item = &SignedFact> {
        self.facts.values()
    }

    /// Merges one fact; see the module docs for the semantics.
    pub fn merge_one(&mut self, fact: SignedFact) -> MergeOutcome {
        if fact.verify_self().is_err() {
            tracing::warn!(fact_id = ?fact.fact.id, "rejecting fact with invalid signature");
            return MergeOutcome::RejectedBadSignature;
        }
        match self.facts.get(&fact.fact.id) {
            Some(existing) => {
                if existing == &fact {
                    MergeOutcome::Duplicate
                } else {
                    tracing::warn!(
                        fact_id = ?fact.fact.id,
                        "same fact id with different bytes; keeping first-seen copy"
                    );
                    MergeOutcome::ConflictKeptExisting
                }
            }
            None => {
                self.facts.insert(fact.fact.id, fact);
                MergeOutcome::Inserted
            }
        }
    }

    /// Unions `other` into `self` fact by fact. Invalid signatures are
    /// rejected (not stored); same-id conflicts keep the first-seen bytes.
    pub fn merge(&mut self, other: impl IntoIterator<Item = SignedFact>) -> MergeReport {
        let mut report = MergeReport::default();
        for fact in other {
            let id = fact.fact.id;
            match self.merge_one(fact) {
                MergeOutcome::Inserted => report.inserted += 1,
                MergeOutcome::Duplicate => report.duplicates += 1,
                MergeOutcome::ConflictKeptExisting => report.conflicts += 1,
                MergeOutcome::RejectedBadSignature => {
                    report.rejected += 1;
                    report.rejected_ids.push(id);
                }
            }
        }
        report
    }

    /// Merges all facts of `other` into `self`.
    pub fn merge_roster(&mut self, other: &Roster) -> MergeReport {
        self.merge(other.facts().cloned())
    }

    /// Whether `id` is in the effective projection at `now_ms`.
    pub fn is_member(&self, id: &EndpointId, now_ms: u64) -> bool {
        self.effective_members(now_ms)
            .iter()
            .any(|m| &m.endpoint_id == id)
    }

    /// Derives the effective member projection at `now_ms`. See the module
    /// docs for roots, revocation matching and expiry semantics. The result
    /// is ordered by `EndpointId` and is a pure function of the stored fact
    /// set (rebuildable at any time).
    pub fn effective_members(&self, now_ms: u64) -> Vec<Member> {
        // Active edges and revocations at `now_ms` (facts in id order).
        let mut edges: Vec<&SignedFact> = Vec::new();
        let mut revokes: Vec<&SignedFact> = Vec::new();
        for sf in self.facts.values() {
            if !sf.fact.is_valid_at(now_ms) {
                continue;
            }
            match sf.fact.kind {
                FactKind::Grant | FactKind::Join => edges.push(sf),
                FactKind::Revoke => revokes.push(sf),
            }
        }

        // Roots: unexpired self-Grants, minus self-resigned ones. Roots are
        // not removable by anyone else in v0.1 (see module docs).
        let roots: BTreeSet<EndpointId> = edges
            .iter()
            .filter(|g| g.fact.kind == FactKind::Grant && g.fact.issuer == g.fact.subject)
            .map(|g| g.fact.subject)
            .filter(|e| {
                !revokes
                    .iter()
                    .any(|r| r.fact.issuer == *e && r.fact.subject == *e)
            })
            .collect();

        // Whether an admission edge is covered by an active revocation.
        // The root-power clause (`R.issuer` is a root) is deliberately not
        // applicable to self-edges: roots cannot revoke other roots.
        let edge_alive = |g: &SignedFact| {
            let is_self_edge = g.fact.issuer == g.fact.subject;
            !revokes.iter().any(|r| {
                r.fact.subject == g.fact.subject
                    && (r.fact.issuer == g.fact.issuer
                        || r.fact.issuer == g.fact.subject
                        || (!is_self_edge && roots.contains(&r.fact.issuer)))
            })
        };

        // BFS from the roots over alive edges; an edge only counts while
        // its issuer is itself reachable (chain integrity).
        let mut members: BTreeSet<EndpointId> = BTreeSet::new();
        let mut queue: VecDeque<EndpointId> = VecDeque::new();
        for root in &roots {
            if members.insert(*root) {
                queue.push_back(*root);
            }
        }
        while let Some(current) = queue.pop_front() {
            for g in edges
                .iter()
                .filter(|g| g.fact.issuer == current && g.fact.subject != g.fact.issuer)
            {
                if !edge_alive(g) {
                    continue;
                }
                if members.insert(g.fact.subject) {
                    queue.push_back(g.fact.subject);
                }
            }
        }

        // Materialize members. `edges` is in fact-id order, so "first match"
        // picks the deterministically lowest admitting fact id.
        let mut out = Vec::with_capacity(members.len());
        for endpoint in &members {
            let is_root = roots.contains(endpoint);
            let admitting = if is_root {
                edges
                    .iter()
                    .find(|g| {
                        g.fact.kind == FactKind::Grant
                            && g.fact.issuer == *endpoint
                            && g.fact.subject == *endpoint
                            && edge_alive(g)
                    })
                    .expect("root must have a live self-grant")
            } else {
                edges
                    .iter()
                    .find(|g| {
                        g.fact.subject == *endpoint
                            && g.fact.issuer != g.fact.subject
                            && edge_alive(g)
                            && members.contains(&g.fact.issuer)
                    })
                    .expect("member must have a live admitting edge from a member")
            };

            // Name: latest live self-Join beats the admitting grant's label.
            let display_name = edges
                .iter()
                .filter(|j| {
                    j.fact.kind == FactKind::Join
                        && j.fact.issuer == *endpoint
                        && j.fact.subject == *endpoint
                        && j.fact.display_name.is_some()
                        && edge_alive(j)
                })
                .max_by_key(|j| (j.fact.issued_at_ms, j.fact.id))
                .and_then(|j| j.fact.display_name.clone())
                .or_else(|| admitting.fact.display_name.clone());

            out.push(Member {
                endpoint_id: *endpoint,
                display_name,
                is_root,
                granted_by: admitting.fact.issuer,
                granted_at_ms: admitting.fact.issued_at_ms,
                expires_at_ms: admitting.fact.expires_at_ms,
            });
        }
        out
    }

    // ---- Construction helpers -------------------------------------------------
    //
    // All helpers build a fact, sign it with the given identity, insert it
    // into the roster and return the stored fact. `now_ms` is supplied by
    // the caller; fact ids are fresh UUIDv7 values.

    fn insert_local(&mut self, fact: SignedFact) -> Result<SignedFact, RosterError> {
        match self.merge_one(fact.clone()) {
            MergeOutcome::Inserted => Ok(fact),
            MergeOutcome::Duplicate => {
                // Already stored byte-identically (e.g. the invite's grant
                // arrived via roster sync before redemption); return the
                // stored copy so callers see one canonical instance.
                Ok(self
                    .facts
                    .get(&fact.fact.id)
                    .cloned()
                    .expect("duplicate outcome implies the fact is stored"))
            }
            outcome => Err(RosterError::Internal(format!(
                "locally constructed fact was not inserted: {outcome:?}"
            ))),
        }
    }

    /// Creates the network's trust root for `identity` (self-Grant). Every
    /// node that bootstraps or co-founds a network calls this exactly once.
    pub fn self_grant(
        &mut self,
        identity: &NodeIdentity,
        display_name: Option<String>,
        now_ms: u64,
    ) -> Result<SignedFact, RosterError> {
        self.grant(identity, identity.endpoint_id(), display_name, now_ms, None)
    }

    /// Grants membership of `subject`. Granting yourself creates a root (see
    /// [`Roster::self_grant`]).
    pub fn grant(
        &mut self,
        issuer: &NodeIdentity,
        subject: EndpointId,
        display_name: Option<String>,
        now_ms: u64,
        expires_at_ms: Option<u64>,
    ) -> Result<SignedFact, RosterError> {
        let fact = Fact::new(
            FactKind::Grant,
            issuer.endpoint_id(),
            subject,
            display_name,
            now_ms,
            expires_at_ms,
        );
        let signed = SignedFact::new(fact, issuer.signing_key())?;
        self.insert_local(signed)
    }

    /// Records the joiner's acceptance of membership (self-Join). Carries
    /// the joiner's chosen display name, which wins in the projection.
    pub fn join_fact(
        &mut self,
        joiner: &NodeIdentity,
        display_name: Option<String>,
        now_ms: u64,
    ) -> Result<SignedFact, RosterError> {
        let fact = Fact::new(
            FactKind::Join,
            joiner.endpoint_id(),
            joiner.endpoint_id(),
            display_name,
            now_ms,
            None,
        );
        let signed = SignedFact::new(fact, joiner.signing_key())?;
        self.insert_local(signed)
    }

    /// Revokes `subject`'s membership (see the module docs for who may
    /// revoke whom). The Revoke fact itself carries no expiry — revocation
    /// is permanent; construct a `Fact` directly for an expiring revoke.
    pub fn revoke(
        &mut self,
        revoker: &NodeIdentity,
        subject: EndpointId,
        now_ms: u64,
    ) -> Result<SignedFact, RosterError> {
        let fact = Fact::new(
            FactKind::Revoke,
            revoker.endpoint_id(),
            subject,
            None,
            now_ms,
            None,
        );
        let signed = SignedFact::new(fact, revoker.signing_key())?;
        self.insert_local(signed)
    }

    /// Issues an invite token: stores the Grant fact locally and returns the
    /// self-contained `dweb1.` token string for the invitee.
    ///
    /// Invites must carry an expiry (spec: 邀请令牌包含带过期时间的 Grant).
    pub fn invite(
        &mut self,
        issuer: &NodeIdentity,
        subject: EndpointId,
        display_name: Option<String>,
        now_ms: u64,
        expires_at_ms: u64,
        relay_url: Option<String>,
    ) -> Result<String, RosterError> {
        let fact = Fact::new(
            FactKind::Grant,
            issuer.endpoint_id(),
            subject,
            display_name,
            now_ms,
            Some(expires_at_ms),
        );
        let signed = SignedFact::new(fact.clone(), issuer.signing_key())?;
        self.insert_local(signed)?;
        let token = InviteToken::new(
            fact,
            issuer.signing_key(),
            RendezvousHint {
                inviter: issuer.endpoint_id(),
                relay_url,
            },
        )?;
        Ok(token.encode()?)
    }

    /// Redeems an invite token on behalf of `joiner`: validates the token
    /// (signature, Grant-ness, expiry, subject match), stores the Grant and
    /// records `joiner`'s self-Join with their chosen display name.
    /// Returns `(grant_fact, join_fact)`.
    pub fn redeem_invite(
        &mut self,
        token: &InviteToken,
        joiner: &NodeIdentity,
        joiner_display_name: Option<String>,
        now_ms: u64,
    ) -> Result<(SignedFact, SignedFact), RosterError> {
        token.validate_for_redeem(now_ms)?;
        let joiner_id = joiner.endpoint_id();
        if token.fact.subject != joiner_id {
            return Err(RosterError::InviteSubjectMismatch {
                subject: token.fact.subject,
                joiner: joiner_id,
            });
        }
        // Signature already validated by validate_for_redeem; store as-is.
        let grant = SignedFact {
            fact: token.fact.clone(),
            signature: token.signature,
        };
        let grant = self.insert_local(grant)?;
        let join = self.join_fact(joiner, joiner_display_name, now_ms)?;
        Ok((grant, join))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn idty(seed: u8) -> NodeIdentity {
        NodeIdentity::from_seed([seed; 32])
    }

    fn bootstrap(r: &mut Roster, identity: &NodeIdentity, now_ms: u64) -> SignedFact {
        r.self_grant(identity, Some("root".into()), now_ms).unwrap()
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

    #[test]
    fn bootstrap_makes_identity_a_root() {
        let a = idty(1);
        let mut r = Roster::new();
        bootstrap(&mut r, &a, 1);
        assert_eq!(r.len(), 1);
        let members = r.effective_members(10);
        assert_eq!(members.len(), 1);
        assert_eq!(members[0].endpoint_id, a.endpoint_id());
        assert!(members[0].is_root);
        assert_eq!(members[0].granted_by, a.endpoint_id());
        assert_eq!(members[0].display_name.as_deref(), Some("root"));
    }

    #[test]
    fn merge_union_is_commutative_and_associative() {
        let (a, b, c, d, e) = (idty(1), idty(2), idty(3), idty(4), idty(5));
        let now = 1000;
        // Three disjoint fact sets.
        let s1 = {
            let mut r = Roster::new();
            bootstrap(&mut r, &a, now);
            r.grant(&a, c.endpoint_id(), Some("c".into()), now, None)
                .unwrap();
            r.facts().cloned().collect::<Vec<_>>()
        };
        let s2 = {
            let mut r = Roster::new();
            bootstrap(&mut r, &b, now);
            r.facts().cloned().collect::<Vec<_>>()
        };
        let s3 = {
            let mut r = Roster::new();
            r.grant(&b, d.endpoint_id(), None, now, None).unwrap();
            r.grant(&b, e.endpoint_id(), None, now, None).unwrap();
            r.facts().cloned().collect::<Vec<_>>()
        };

        // Commutativity: (s1 ++ s2) == (s2 ++ s1).
        let mut r12 = Roster::new();
        r12.merge(s1.iter().cloned().chain(s2.iter().cloned()));
        let mut r21 = Roster::new();
        r21.merge(s2.iter().cloned().chain(s1.iter().cloned()));
        assert_eq!(r12, r21);

        // Associativity: ((s1+s2)+s3) == (s1+(s2+s3)).
        let mut left = r12.clone();
        left.merge(s3.iter().cloned());
        let mut right = Roster::new();
        let mut inner = Roster::new();
        inner.merge(s2.iter().cloned().chain(s3.iter().cloned()));
        right.merge(s1.iter().cloned());
        right.merge_roster(&inner);
        assert_eq!(left, right);

        // All facts present; projections agree everywhere.
        assert_eq!(left.len(), s1.len() + s2.len() + s3.len());
        let members = left.effective_members(now + 1);
        for id in [
            a.endpoint_id(),
            b.endpoint_id(),
            c.endpoint_id(),
            d.endpoint_id(),
            e.endpoint_id(),
        ] {
            assert!(members.iter().any(|m| m.endpoint_id == id), "missing {id}");
        }
    }

    #[test]
    fn merge_is_order_insensitive_across_permutations() {
        let (a, b, c) = (idty(1), idty(2), idty(3));
        let now = 1000;
        let mut source = Roster::new();
        bootstrap(&mut source, &a, now);
        source.grant(&a, b.endpoint_id(), None, now, None).unwrap();
        source.join_fact(&b, Some("b".into()), now).unwrap();
        source.revoke(&a, b.endpoint_id(), now).unwrap();
        bootstrap(&mut source, &b, now); // multi-root
        source.grant(&b, c.endpoint_id(), None, now, None).unwrap();
        let complete: Vec<SignedFact> = source.facts().cloned().collect();
        assert_eq!(complete.len(), 6);

        // Several fixed permutations (no proptest needed for v0.1 scope).
        let perms: Vec<Vec<SignedFact>> = vec![
            complete.clone(),
            {
                let mut v = complete.clone();
                v.reverse();
                v
            },
            {
                let mut v = complete.clone();
                let last = v.len() - 1;
                v.swap(0, last);
                v.rotate_left(2);
                v
            },
        ];
        let reference = {
            let mut r = Roster::new();
            r.merge(perms[0].iter().cloned());
            r
        };
        for perm in &perms[1..] {
            let mut r = Roster::new();
            let report = r.merge(perm.iter().cloned());
            assert_eq!(report.rejected, 0);
            assert_eq!(r, reference, "permutation changed the result");
        }
    }

    #[test]
    fn duplicate_delivery_is_idempotent() {
        let (a, b) = (idty(1), idty(2));
        let mut r = Roster::new();
        bootstrap(&mut r, &a, 1);
        let grant = r.grant(&a, b.endpoint_id(), None, 2, None).unwrap();

        let before = r.clone();
        let report = r.merge(vec![grant.clone(), grant]);
        assert_eq!(report.duplicates, 2);
        assert_eq!(report.inserted, 0);
        assert_eq!(r, before, "duplicate delivery must be a no-op");
    }

    #[test]
    fn same_id_conflict_keeps_first_and_warns() {
        let a = idty(1);
        let mut f = Fact::new(
            FactKind::Grant,
            a.endpoint_id(),
            idty(2).endpoint_id(),
            Some("original".into()),
            10,
            None,
        );
        let first = SignedFact::new(f.clone(), a.signing_key()).unwrap();
        f.display_name = Some("tampered".into());
        let second = SignedFact::new(f, a.signing_key()).unwrap();
        assert_ne!(first, second);

        let mut r = Roster::new();
        let report = r.merge(vec![first.clone(), second]);
        assert_eq!(report.conflicts, 1);
        assert_eq!(report.inserted, 1);
        assert_eq!(r.get(&first.fact.id), Some(&first), "first-seen must win");
    }

    #[test]
    fn invalid_signature_is_rejected() {
        let (a, impersonated, victim) = (idty(1), idty(2), idty(3));
        // A fact claiming `impersonated` as issuer but signed by `a`.
        let fact = Fact::new(
            FactKind::Grant,
            impersonated.endpoint_id(),
            victim.endpoint_id(),
            None,
            1,
            None,
        );
        let forged = SignedFact::new(fact, a.signing_key()).unwrap();

        let mut r = Roster::new();
        let mut with_root = Roster::new();
        bootstrap(&mut with_root, &impersonated, 1);
        let report = r.merge(vec![forged.clone()]);
        assert_eq!(report.rejected, 1);
        assert_eq!(report.rejected_ids, vec![forged.fact.id]);
        assert_eq!(r.len(), 0, "forged fact must not be stored");

        // Also rejected when mixed into a live roster.
        let report = with_root.merge(vec![forged]);
        assert_eq!(report.rejected, 1);
        assert_eq!(with_root.len(), 1);
    }

    #[test]
    fn grantor_revoke_removes_member_and_keeps_history() {
        let (a, c) = (idty(1), idty(3));
        let mut r = Roster::new();
        bootstrap(&mut r, &a, 1);
        r.grant(&a, c.endpoint_id(), None, 2, None).unwrap();
        let len_before = r.len();
        assert!(contains(&r, &c.endpoint_id(), 10));

        r.revoke(&a, c.endpoint_id(), 20).unwrap();
        assert!(!contains(&r, &c.endpoint_id(), 21), "revocation must apply");
        assert_eq!(
            r.len(),
            len_before + 1,
            "revocation appends a fact, never rewrites history"
        );
        // The grantor stays.
        assert!(contains(&r, &a.endpoint_id(), 21));
    }

    #[test]
    fn roots_can_revoke_others_invites() {
        let (a, b, d) = (idty(1), idty(2), idty(4));
        let mut r = Roster::new();
        bootstrap(&mut r, &a, 1);
        bootstrap(&mut r, &b, 1); // second root
        r.grant(&b, d.endpoint_id(), None, 2, None).unwrap();
        assert!(contains(&r, &d.endpoint_id(), 10));

        // Root a revokes b's invitee even though a is not the grantor.
        r.revoke(&a, d.endpoint_id(), 20).unwrap();
        assert!(!contains(&r, &d.endpoint_id(), 21));
        // ...but cannot revoke the other root itself (v0.1: roots are only
        // removable by self-resignation).
        r.revoke(&a, b.endpoint_id(), 22).unwrap();
        assert!(
            contains(&r, &b.endpoint_id(), 23),
            "roots are irrevocable by other roots"
        );
    }

    #[test]
    fn non_authorized_member_cannot_revoke_others() {
        let (a, b, d) = (idty(1), idty(2), idty(4));
        let mut r = Roster::new();
        bootstrap(&mut r, &a, 1);
        r.grant(&a, b.endpoint_id(), None, 2, None).unwrap();
        r.grant(&a, d.endpoint_id(), None, 3, None).unwrap();
        assert!(contains(&r, &d.endpoint_id(), 10));

        // b is a plain member: not the grantor, not a root, not d.
        r.revoke(&b, d.endpoint_id(), 20).unwrap();
        assert!(
            contains(&r, &d.endpoint_id(), 21),
            "revocation by a non-grantor non-root must have no effect"
        );
        // Self-resignation, however, always works.
        r.revoke(&d, d.endpoint_id(), 22).unwrap();
        assert!(!contains(&r, &d.endpoint_id(), 23));
    }

    #[test]
    fn redundant_grants_member_survives_partial_revoke() {
        let (a, m, c) = (idty(1), idty(2), idty(3));
        let mut r = Roster::new();
        bootstrap(&mut r, &a, 1);
        r.grant(&a, m.endpoint_id(), None, 2, None).unwrap();
        // c is admitted twice: by the root a and by the plain member m.
        r.grant(&a, c.endpoint_id(), None, 3, None).unwrap();
        r.grant(&m, c.endpoint_id(), None, 4, None).unwrap();

        // A revoke by the non-root grantor m kills only m's own edge...
        r.revoke(&m, c.endpoint_id(), 10).unwrap();
        assert!(
            contains(&r, &c.endpoint_id(), 11),
            "still member via the root's grant"
        );
        // ...while a revoke by a root (a) kills every edge admitting c.
        r.revoke(&a, c.endpoint_id(), 12).unwrap();
        assert!(
            !contains(&r, &c.endpoint_id(), 13),
            "root revoke covers all grants"
        );
    }

    #[test]
    fn revoking_intermediate_collapses_their_grants() {
        let (a, m, leaf) = (idty(1), idty(2), idty(3));
        let mut r = Roster::new();
        bootstrap(&mut r, &a, 1);
        r.grant(&a, m.endpoint_id(), None, 2, None).unwrap();
        r.grant(&m, leaf.endpoint_id(), None, 3, None).unwrap();
        assert!(contains(&r, &leaf.endpoint_id(), 10));

        r.revoke(&a, m.endpoint_id(), 20).unwrap();
        assert!(!contains(&r, &m.endpoint_id(), 21));
        assert!(
            !contains(&r, &leaf.endpoint_id(), 21),
            "leaf must fall: its grantor is no longer a member"
        );
    }

    #[test]
    fn expired_grant_lapses_without_revocation() {
        let (a, c) = (idty(1), idty(3));
        let mut r = Roster::new();
        bootstrap(&mut r, &a, 1);
        r.grant(&a, c.endpoint_id(), None, 10, Some(1000)).unwrap();

        assert!(contains(&r, &c.endpoint_id(), 999));
        assert!(
            !contains(&r, &c.endpoint_id(), 1000),
            "expired at the instant"
        );
        assert!(!contains(&r, &c.endpoint_id(), 1001));
        // Facts stay stored.
        assert_eq!(r.len(), 2);
    }

    #[test]
    fn expired_revoke_stops_revoking() {
        let (a, c) = (idty(1), idty(3));
        let mut r = Roster::new();
        bootstrap(&mut r, &a, 1);
        r.grant(&a, c.endpoint_id(), None, 10, None).unwrap();
        // A *temporary* revocation (Revoke fact carrying an expiry).
        let tmp_revoke = SignedFact::new(
            Fact::new(
                FactKind::Revoke,
                a.endpoint_id(),
                c.endpoint_id(),
                None,
                20,
                Some(100),
            ),
            a.signing_key(),
        )
        .unwrap();
        r.merge(vec![tmp_revoke]);

        assert!(
            !contains(&r, &c.endpoint_id(), 50),
            "revoked while the revoke is live"
        );
        assert!(
            contains(&r, &c.endpoint_id(), 150),
            "member returns once the revoke itself expires (uniform fact expiry)"
        );
    }

    #[test]
    fn root_self_resignation_collapses_subtree_but_not_other_roots() {
        let (a, b, c) = (idty(1), idty(2), idty(3));
        let mut r = Roster::new();
        bootstrap(&mut r, &a, 1);
        bootstrap(&mut r, &b, 1);
        r.grant(&a, c.endpoint_id(), None, 2, None).unwrap();

        r.revoke(&a, a.endpoint_id(), 10).unwrap();
        let members = member_ids(&r, 20);
        assert!(!members.contains(&a.endpoint_id()), "root self-resigned");
        assert!(!members.contains(&c.endpoint_id()), "a's subtree collapsed");
        assert!(
            members.contains(&b.endpoint_id()),
            "unrelated root unaffected"
        );
    }

    #[test]
    fn join_fact_name_wins_over_grant_name() {
        let (a, c) = (idty(1), idty(3));
        let mut r = Roster::new();
        bootstrap(&mut r, &a, 1);
        r.grant(
            &a,
            c.endpoint_id(),
            Some("carol (invited by a)".into()),
            2,
            None,
        )
        .unwrap();
        let members = r.effective_members(10);
        assert_eq!(
            members
                .iter()
                .find(|m| m.endpoint_id == c.endpoint_id())
                .unwrap()
                .display_name,
            Some("carol (invited by a)".into())
        );

        // c joins and picks their own name.
        r.join_fact(&c, Some("Carol".into()), 5).unwrap();
        let members = r.effective_members(10);
        assert_eq!(
            members
                .iter()
                .find(|m| m.endpoint_id == c.endpoint_id())
                .unwrap()
                .display_name,
            Some("Carol".into())
        );

        // A later join with no name does not erase the chosen one.
        r.join_fact(&c, None, 6).unwrap();
        let members = r.effective_members(10);
        assert_eq!(
            members
                .iter()
                .find(|m| m.endpoint_id == c.endpoint_id())
                .unwrap()
                .display_name,
            Some("Carol".into())
        );
        // A yet later join changes it.
        r.join_fact(&c, Some("Carol II".into()), 7).unwrap();
        let members = r.effective_members(10);
        assert_eq!(
            members
                .iter()
                .find(|m| m.endpoint_id == c.endpoint_id())
                .unwrap()
                .display_name,
            Some("Carol II".into())
        );
    }

    #[test]
    fn projection_is_rebuildable() {
        let (a, b, c) = (idty(1), idty(2), idty(3));
        let mut r = Roster::new();
        bootstrap(&mut r, &a, 1);
        bootstrap(&mut r, &b, 1);
        r.grant(&a, c.endpoint_id(), Some("c".into()), 2, None)
            .unwrap();
        r.join_fact(&c, Some("C".into()), 3).unwrap();
        r.revoke(&b, b.endpoint_id(), 4).unwrap(); // b resigns

        let first = r.effective_members(100);
        let second = r.effective_members(100);
        assert_eq!(first, second, "projection must be deterministic");

        // Rebuild from the raw fact set (e.g. after persistence round-trip).
        let mut rebuilt = Roster::new();
        let report = rebuilt.merge(r.facts().cloned());
        assert_eq!(report.rejected + report.conflicts, 0);
        assert_eq!(rebuilt.effective_members(100), first);
    }

    #[test]
    fn roster_survives_wire_roundtrip() {
        let (a, c) = (idty(1), idty(3));
        let mut r = Roster::new();
        bootstrap(&mut r, &a, 1);
        r.grant(&a, c.endpoint_id(), None, 2, None).unwrap();

        let wire = SignedFact::encode_all(r.facts()).unwrap();
        let decoded = SignedFact::decode_all(&wire).unwrap();
        let mut r2 = Roster::new();
        r2.merge(decoded);
        assert_eq!(r, r2);
        assert_eq!(member_ids(&r, 10), member_ids(&r2, 10));
    }

    #[test]
    fn invite_and_redeem_full_flow() {
        let inviter = idty(1);
        let invitee = idty(2);
        let now = 1_000u64;
        let mut ra = Roster::new();
        bootstrap(&mut ra, &inviter, now);

        let token_str = ra
            .invite(
                &inviter,
                invitee.endpoint_id(),
                Some("dave".into()),
                now,
                now + 60_000,
                Some("https://relay.example.com".into()),
            )
            .unwrap();
        assert!(token_str.starts_with("dweb1."));
        // The inviter's roster already contains the grant.
        assert_eq!(ra.len(), 2);
        assert!(contains(&ra, &invitee.endpoint_id(), now + 1));

        // The invitee parses the token out of band and redeems it on their
        // own (initially empty) roster after learning the root fact (in the
        // real flow this arrives via roster sync).
        let token = InviteToken::decode(&token_str).unwrap();
        let mut rd = Roster::new();
        rd.merge(
            ra.facts()
                .filter(|sf| sf.fact.kind == FactKind::Grant && sf.fact.issuer == sf.fact.subject)
                .cloned(),
        );
        let (grant, join) = rd
            .redeem_invite(&token, &invitee, Some("Dave".into()), now + 100)
            .unwrap();
        assert_eq!(grant.fact.kind, FactKind::Grant);
        assert_eq!(join.fact.kind, FactKind::Join);
        assert_eq!(join.fact.issuer, invitee.endpoint_id());

        let members = rd.effective_members(now + 101);
        assert!(
            members
                .iter()
                .any(|m| m.endpoint_id == inviter.endpoint_id() && m.is_root)
        );
        let dave = members
            .iter()
            .find(|m| m.endpoint_id == invitee.endpoint_id())
            .unwrap();
        assert_eq!(dave.display_name.as_deref(), Some("Dave"));

        // Syncing the invitee's roster back keeps both sides consistent.
        let report = ra.merge_roster(&rd);
        assert_eq!(report.rejected, 0);
        assert_eq!(member_ids(&ra, now + 101), member_ids(&rd, now + 101));
    }

    #[test]
    fn expired_token_redeem_is_rejected() {
        let inviter = idty(1);
        let invitee = idty(2);
        let now = 1_000u64;
        let mut ra = Roster::new();
        bootstrap(&mut ra, &inviter, now);
        let token_str = ra
            .invite(&inviter, invitee.endpoint_id(), None, now, now + 100, None)
            .unwrap();

        let token = InviteToken::decode(&token_str).unwrap();
        let mut rd = Roster::new();
        rd.merge(ra.facts().cloned());
        let err = rd
            .redeem_invite(&token, &invitee, None, now + 100)
            .unwrap_err();
        assert!(
            matches!(err, RosterError::Invite(InviteError::Expired { .. })),
            "got {err:?}"
        );
        // No join fact was recorded and membership was not granted.
        assert!(!contains(&rd, &invitee.endpoint_id(), now + 100));
        assert_eq!(rd.len(), ra.len());
    }

    #[test]
    fn token_for_another_subject_is_rejected() {
        let inviter = idty(1);
        let invitee = idty(2);
        let stranger = idty(3);
        let now = 1_000u64;
        let mut ra = Roster::new();
        bootstrap(&mut ra, &inviter, now);
        let token_str = ra
            .invite(&inviter, invitee.endpoint_id(), None, now, now + 100, None)
            .unwrap();

        let token = InviteToken::decode(&token_str).unwrap();
        let mut rd = Roster::new();
        rd.merge(ra.facts().cloned());
        let err = rd
            .redeem_invite(&token, &stranger, None, now + 1)
            .unwrap_err();
        assert!(
            matches!(err, RosterError::InviteSubjectMismatch { .. }),
            "got {err:?}"
        );
        assert!(!contains(&rd, &stranger.endpoint_id(), now + 1));
    }

    #[test]
    fn is_member_reports_projection_state() {
        let (a, c) = (idty(1), idty(3));
        let mut r = Roster::new();
        bootstrap(&mut r, &a, 1);
        r.grant(&a, c.endpoint_id(), None, 2, Some(100)).unwrap();
        assert!(r.is_member(&a.endpoint_id(), 50));
        assert!(r.is_member(&c.endpoint_id(), 50));
        assert!(!r.is_member(&c.endpoint_id(), 150));
        assert!(!r.is_member(&idty(9).endpoint_id(), 50));
    }
}
