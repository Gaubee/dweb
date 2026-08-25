//! Cross-module integration: identity persistence -> fabric creation ->
//! invite issuance -> simulated online redemption (PoP + CAS consume) ->
//! root grant -> sync convergence -> revocation, plus restart replay.

use dweb_fabric::identity::{NodeIdentity, endpoint_id_display, endpoint_id_parse};
use dweb_fabric::protocol::{InviteToken, SignedFact, redeem_challenge_bytes};
use dweb_fabric::roster::{RevokeTarget, Roster};

/// Full v0.1 authorization lifecycle, the P0 acceptance path from the codex
/// review: `Genesis -> invite redeem -> root grant -> revoke`, with a thief
/// who holds the token but not the key, and a replayed redemption.
#[test]
fn fabric_lifecycle_genesis_invite_redeem_grant_revoke() {
    let now = 10_000u64;

    // Node A bootstraps a fresh fabric (root).
    let dir_a = tempfile::tempdir().unwrap();
    let alice = NodeIdentity::load_or_create(dir_a.path()).unwrap();
    let (mut ra, fabric_id) = Roster::create(&alice, dir_a.path(), now).unwrap();
    assert_eq!(ra.root(), Some(alice.endpoint_id()));
    assert!(ra.is_member(&alice.endpoint_id(), now));

    // A issues a single-use invite (out of band).
    let token = ra
        .issue_invite(
            &alice,
            "https://relay.example.com".into(),
            vec!["192.168.1.4:9000".into()],
            None, // recipient unknown at issue time
            60_000,
            now,
        )
        .unwrap();
    let token_str = token.encode().unwrap();
    assert!(token_str.starts_with("dweb1."));

    // Node B parses the token and prepares its PoP over the challenge.
    let dir_b = tempfile::tempdir().unwrap();
    let bob = NodeIdentity::load_or_create(dir_b.path()).unwrap();
    let parsed = InviteToken::decode(&token_str).unwrap();
    assert_eq!(parsed.invite.issuer, alice.endpoint_id());
    let challenge = [0x42u8; 32]; // stand-in for the redeem-channel challenge
    let pop_material = redeem_challenge_bytes(&fabric_id, &parsed.invite.invite_id, &challenge);
    let pop_sig = bob.secret_key().sign(&pop_material);

    // A verifies the redemption: token + expiry + PoP, then CAS-consumes.
    let authorized = ra
        .redeem_verify(&parsed, &bob.endpoint_id(), &challenge, &pop_sig, now + 1)
        .unwrap();
    assert_eq!(authorized, bob.endpoint_id());
    assert!(
        ra.consume_invite(&parsed.invite.invite_id, now + 2)
            .unwrap()
    );
    // Replayed redemption of the same invite_id is refused (single use).
    assert!(
        !ra.consume_invite(&parsed.invite.invite_id, now + 3)
            .unwrap()
    );

    // A issues the MemberGrant and syncs it (with the genesis) to B.
    ra.grant(&alice, bob.endpoint_id(), Some("bob".into()), None, now + 4)
        .unwrap();
    let mut rb = Roster::attach(dir_b.path(), fabric_id).unwrap();
    let report = rb.merge(ra.facts().cloned()).unwrap();
    assert_eq!(report.quarantined, 0);
    assert!(rb.is_member(&alice.endpoint_id(), now + 5));
    assert!(rb.is_member(&bob.endpoint_id(), now + 5));

    // B names themselves; the self-asserted name wins in the projection.
    rb.set_display_name(&bob, Some("Bob".into()), now + 6)
        .unwrap();
    let members = rb.effective_members(now + 7);
    let bob_member = members
        .iter()
        .find(|m| m.endpoint_id == bob.endpoint_id())
        .unwrap();
    assert_eq!(bob_member.display_name.as_deref(), Some("Bob"));

    // A thief holding only the token cannot redeem: no key, no PoP.
    let thief = NodeIdentity::from_seed([0xEF; 32]);
    let thief_sig = thief.secret_key().sign(&pop_material);
    assert!(
        ra.redeem_verify(&parsed, &bob.endpoint_id(), &challenge, &thief_sig, now + 8)
            .is_err()
    );
    // ...and a token bound to someone else refuses the wrong redeemer.
    let bound = ra
        .issue_invite(
            &alice,
            "https://relay.example.com".into(),
            vec![],
            Some(thief.endpoint_id()),
            60_000,
            now,
        )
        .unwrap();
    assert!(
        ra.redeem_verify(&bound, &bob.endpoint_id(), &challenge, &pop_sig, now + 9)
            .is_err()
    );

    // A revokes B (all live grants); the revocation travels with a sync.
    ra.revoke(
        &alice,
        RevokeTarget::AllGrantsOf(bob.endpoint_id()),
        now + 10,
    )
    .unwrap();
    let dir_c = tempfile::tempdir().unwrap();
    let mut rc = Roster::attach(dir_c.path(), fabric_id).unwrap();
    let report = rc.merge(ra.facts().cloned()).unwrap();
    assert_eq!(report.quarantined, 0);
    assert!(!rc.is_member(&bob.endpoint_id(), now + 11), "revoked");
    assert!(rc.is_member(&alice.endpoint_id(), now + 11), "root stays");

    // B converges to the same view after syncing.
    let report = rb.merge(ra.facts().cloned()).unwrap();
    assert_eq!(report.quarantined, 0);
    assert!(!rb.is_member(&bob.endpoint_id(), now + 11));
    let members_a = ra.effective_members(now + 11);
    let members_b = rb.effective_members(now + 11);
    assert_eq!(members_a, members_b, "A and B converge");
    assert_eq!(members_b.len(), 1);
}

/// Expired tokens are refused at redemption; the invitee gains nothing.
#[test]
fn expired_token_redemption_is_refused() {
    let now = 10_000u64;
    let dir = tempfile::tempdir().unwrap();
    let root = NodeIdentity::load_or_create(dir.path()).unwrap();
    let (mut r, fabric_id) = Roster::create(&root, dir.path(), now).unwrap();

    let token = r
        .issue_invite(&root, "https://relay".into(), vec![], None, 1_000, now)
        .unwrap();
    let joiner = NodeIdentity::from_seed([7u8; 32]);
    let challenge = [1u8; 32];
    let material = redeem_challenge_bytes(&fabric_id, &token.invite.invite_id, &challenge);
    let sig = joiner.secret_key().sign(&material);

    let err = r
        .redeem_verify(&token, &joiner.endpoint_id(), &challenge, &sig, now + 1_000)
        .unwrap_err();
    assert!(
        err.to_string().contains("expired"),
        "expected expiry error, got {err}"
    );
    // And the CAS consumption is never reached for failed verifications.
    assert!(!r.is_invite_consumed(&token.invite.invite_id));
    assert!(!r.is_member(&joiner.endpoint_id(), now + 1_000));
}

/// Persistence end-to-end: identities and rosters survive restarts, and
/// migrated data directories keep working membership.
#[test]
fn identity_and_roster_survive_restart_and_wire_dump() {
    let now = 1_000u64;
    let dir_a = tempfile::tempdir().unwrap();
    let alice = NodeIdentity::load_or_create(dir_a.path()).unwrap();
    let (mut ra, fabric_id) = Roster::create(&alice, dir_a.path(), now).unwrap();
    let bob = NodeIdentity::from_seed([2u8; 32]);
    ra.grant(&alice, bob.endpoint_id(), None, None, now + 1)
        .unwrap();

    // Restart A: same identity file, same roster file, same projection.
    let alice2 = NodeIdentity::load_or_create(dir_a.path()).unwrap();
    assert_eq!(alice.endpoint_id(), alice2.endpoint_id());
    let ra2 = Roster::open(dir_a.path(), fabric_id).unwrap();
    assert_eq!(
        ra2.effective_members(now + 2),
        ra.effective_members(now + 2)
    );
    assert!(ra2.is_member(&bob.endpoint_id(), now + 2));

    // Migrate the whole data dir to "another machine".
    let dir_migrated = tempfile::tempdir().unwrap();
    for name in ["identity.key", "roster.facts"] {
        std::fs::copy(dir_a.path().join(name), dir_migrated.path().join(name)).unwrap();
    }
    let alice3 = NodeIdentity::load_or_create(dir_migrated.path()).unwrap();
    let ra3 = Roster::open(dir_migrated.path(), fabric_id).unwrap();
    assert_eq!(alice3.endpoint_id(), alice.endpoint_id());
    assert!(ra3.is_member(&alice3.endpoint_id(), now + 3));
    assert!(ra3.is_member(&bob.endpoint_id(), now + 3));
    // The migrated root can still issue grants.
    let mut ra3 = ra3;
    let carol = NodeIdentity::from_seed([3u8; 32]).endpoint_id();
    ra3.grant(&alice3, carol, None, None, now + 4).unwrap();
    assert!(ra3.is_member(&carol, now + 5));

    // HELLO full-dump stand-in: wire dump round-trips without changing
    // semantics.
    let wire = SignedFact::encode_all(ra.facts()).unwrap();
    let decoded = SignedFact::decode_all(&wire).unwrap();
    let dir_c = tempfile::tempdir().unwrap();
    let mut rc = Roster::attach(dir_c.path(), fabric_id).unwrap();
    let report = rc.merge(decoded).unwrap();
    assert_eq!(report.quarantined, 0);
    assert_eq!(rc.effective_members(now + 6), ra.effective_members(now + 6));
}

/// EndpointId display strings (z-base-32) round-trip through the roster
/// pipeline: the string form of a projected member re-parses to the same id
/// and keeps gating membership.
#[test]
fn endpoint_id_z32_strings_roundtrip_through_members() {
    let dir = tempfile::tempdir().unwrap();
    let root = NodeIdentity::load_or_create(dir.path()).unwrap();
    let (r, _fid) = Roster::create(&root, dir.path(), 1).unwrap();
    let member = &r.effective_members(2)[0];

    let display = endpoint_id_display(&member.endpoint_id);
    assert_eq!(display.len(), 52);
    let parsed = endpoint_id_parse(&display).unwrap();
    assert_eq!(parsed, member.endpoint_id);
    assert!(r.is_member(&parsed, 2));
    assert!(endpoint_id_parse(&display[..51]).is_err());
}
