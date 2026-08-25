//! Cross-module integration: identity persistence -> roster invite/redeem ->
//! union-merge sync between two "nodes".

use dweb_fabric::identity::{EndpointId, NodeIdentity};
use dweb_fabric::protocol::{InviteToken, SignedFact};
use dweb_fabric::roster::Roster;

fn idty(seed: u8) -> NodeIdentity {
    NodeIdentity::from_seed([seed; 32])
}

/// Two nodes discover each other entirely through facts and one token:
/// bootstrap, invite, sync, redeem, verify mutual membership, revoke,
/// re-sync, verify the revocation propagates.
#[test]
fn two_node_network_lifecycle() {
    let now = 10_000u64;
    let alice = idty(1);
    let bob = idty(2);

    // Node A bootstraps its own network (root).
    let mut ra = Roster::new();
    ra.self_grant(&alice, Some("alice".into()), now).unwrap();

    // A invites B out of band.
    let token_str = ra
        .invite(
            &alice,
            bob.endpoint_id(),
            Some("bob".into()),
            now,
            now + 3_600_000,
            Some("https://relay.example.com".into()),
        )
        .unwrap();

    // B redeems on a fresh node after syncing A's facts (HELLO dump stand-in).
    let mut rb = Roster::new();
    rb.merge(ra.facts().cloned());
    let token = InviteToken::decode(&token_str).unwrap();
    assert_eq!(token.rendezvous.inviter, alice.endpoint_id());
    rb.redeem_invite(&token, &bob, Some("Bob".into()), now + 1)
        .unwrap();

    // Both sides converge to the same projection.
    rb.merge_roster(&ra);
    ra.merge_roster(&rb);
    assert_eq!(ra, rb);
    let members = ra.effective_members(now + 2);
    assert_eq!(members.len(), 2);
    let m_bob = members
        .iter()
        .find(|m| m.endpoint_id == bob.endpoint_id())
        .unwrap();
    assert!(!m_bob.is_root);
    assert_eq!(m_bob.granted_by, alice.endpoint_id());
    assert_eq!(m_bob.display_name.as_deref(), Some("Bob"));

    // A revokes B; the revocation travels with a fact sync.
    ra.revoke(&alice, bob.endpoint_id(), now + 10).unwrap();
    let mut rc = Roster::new(); // a third node syncing from A
    rc.merge(ra.facts().cloned());
    rc.merge_roster(&rb);
    assert!(!rc.is_member(&bob.endpoint_id(), now + 11));
    assert!(rc.is_member(&alice.endpoint_id(), now + 11));
}

/// Identity persistence drives roster membership: the same data directory
/// must keep producing the same EndpointId across processes.
#[test]
fn identity_persistence_feeds_roster_membership() {
    let dir_a = tempfile::tempdir().unwrap();
    let dir_b = tempfile::tempdir().unwrap();

    let alice = NodeIdentity::load_or_create(dir_a.path()).unwrap();
    let mut ra = Roster::new();
    ra.self_grant(&alice, None, 1).unwrap();

    // "Migrate" the data dir: same key file elsewhere.
    std::fs::copy(
        NodeIdentity::key_path(dir_a.path()),
        NodeIdentity::key_path(dir_b.path()),
    )
    .unwrap();
    let alice2 = NodeIdentity::load_or_create(dir_b.path()).unwrap();
    assert_eq!(alice.endpoint_id(), alice2.endpoint_id());

    // Facts signed by the migrated identity verify and merge idempotently.
    let mut rb = Roster::new();
    let report = rb.merge(ra.facts().cloned());
    assert_eq!(report.inserted, 1);
    assert!(rb.is_member(&alice2.endpoint_id(), 2));
    let again = rb.merge(ra.facts().cloned());
    assert_eq!(again.duplicates, 1);
    assert_eq!(rb.len(), 1);
}

/// Roster dumps survive a signed-fact wire round-trip (HELLO full-dump
/// stand-in) without changing semantics.
#[test]
fn roster_sync_via_wire_dump() {
    let now = 5_000u64;
    let (a, b, c) = (idty(1), idty(2), idty(3));
    let mut ra = Roster::new();
    ra.self_grant(&a, None, now).unwrap();
    ra.grant(&a, b.endpoint_id(), Some("b".into()), now, None)
        .unwrap();
    ra.grant(&a, c.endpoint_id(), None, now, Some(now + 100))
        .unwrap();

    let wire = SignedFact::encode_all(ra.facts()).unwrap();
    let facts = SignedFact::decode_all(&wire).unwrap();
    let mut rb = Roster::new();
    let report = rb.merge(facts);
    assert_eq!(report.rejected, 0);
    assert_eq!(rb, ra);
    assert_eq!(rb.effective_members(now + 1), ra.effective_members(now + 1));
    // Expiry semantics survive the round-trip.
    assert_eq!(rb.effective_members(now + 1_000).len(), 2);
}

/// EndpointId strings survive the JSON-ish hex pipeline used by SDKs.
#[test]
fn endpoint_id_strings_roundtrip_through_roster_members() {
    let a = idty(7);
    let mut r = Roster::new();
    r.self_grant(&a, Some("host".into()), 1).unwrap();
    let member = &r.effective_members(2)[0];
    let parsed: EndpointId = member.endpoint_id.to_string().parse().unwrap();
    assert_eq!(parsed, a.endpoint_id());
    assert!(r.is_member(&parsed, 2));
}
