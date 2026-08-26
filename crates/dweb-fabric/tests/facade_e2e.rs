//! Fabric 门面端到端：root 创建 → invite → joiner 兑换 → 双向连接 → 消息 → 撤销。
//! 全程仅 localhost 直连（relay 禁用），无任何外部设施。

use dweb_fabric::{Fabric, FabricConfig, FabricEvent, RelayConfig};
use std::time::Duration;
use tempfile::TempDir;

fn cfg(dir: &TempDir) -> FabricConfig {
    FabricConfig {
        data_dir: dir.path().to_owned(),
        relay: RelayConfig::Disabled,
        advertise_addrs: Vec::new(),
    }
}

async fn wait_event(
    rx: &mut tokio::sync::broadcast::Receiver<FabricEvent>,
    pred: impl Fn(&FabricEvent) -> bool,
    what: &str,
) -> FabricEvent {
    let deadline = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let ev = rx.recv().await.expect("event channel open");
            if pred(&ev) {
                return ev;
            }
        }
    })
    .await;
    match deadline {
        Ok(ev) => ev,
        Err(_) => panic!("timeout waiting for {what}"),
    }
}

#[tokio::test]
async fn full_lifecycle_invite_join_message_revoke() {
    let dir_a = TempDir::new().unwrap();
    let dir_b = TempDir::new().unwrap();

    let a = Fabric::create_root(cfg(&dir_a)).await.unwrap();
    let mut ev_a = a.subscribe();

    let fabric_id = a.fabric_id_hex().await;

    // B 以 attach 起步（空名册，等待 join 写入）
    let b = Fabric::attach(cfg(&dir_b), &fabric_id).await.unwrap();
    let mut ev_b = b.subscribe();

    // 邀请（5 分钟有效）
    let token = a
        .invite(Duration::from_secs(300).as_millis() as u64, None)
        .await
        .unwrap();

    // B 兑换：经 redeem ALPN 连 A（invite 含 127.0.0.1 直连提示）
    b.join(&token).await.expect("join redeems invite");
    let members_b = b.members().await;
    assert_eq!(
        members_b.len(),
        2,
        "B sees root + self after redeem: {:?}",
        members_b
    );
    assert!(members_b.iter().any(|m| m.endpoint_id == a.endpoint_id()));

    // A 侧名册更新（root 收到自身签发的 grant 后重放事件由 redeem handler 发出）
    let _ = wait_event(
        &mut ev_a,
        |e| matches!(e, FabricEvent::RosterUpdated),
        "A roster updated",
    )
    .await;
    assert_eq!(a.members().await.len(), 2);

    // 同一令牌二次兑换必须被拒（CAS）
    let again = b.join(&token).await;
    assert!(again.is_err(), "second redeem of same token must fail");

    // B 连接 A（常规 ALPN，双向 HELLO 同步）
    b.connect(&a.endpoint_id()).await.expect("B connects A");
    let _ = wait_event(
        &mut ev_b,
        |e| matches!(e, FabricEvent::PeerConnected { .. }),
        "B sees A connected",
    )
    .await;
    let _ = wait_event(
        &mut ev_a,
        |e| matches!(e, FabricEvent::PeerConnected { .. }),
        "A sees B connected",
    )
    .await;

    // 双向消息
    a.send(&b.endpoint_id(), b"ping from A".to_vec())
        .await
        .unwrap();
    let ev = wait_event(
        &mut ev_b,
        |e| matches!(e, FabricEvent::Message { .. }),
        "B receives message",
    )
    .await;
    match ev {
        FabricEvent::Message { from, data } => {
            assert_eq!(from, a.endpoint_id());
            assert_eq!(data, b"ping from A");
        }
        _ => unreachable!(),
    }
    b.send(&a.endpoint_id(), b"pong from B".to_vec())
        .await
        .unwrap();
    let ev = wait_event(
        &mut ev_a,
        |e| matches!(e, FabricEvent::Message { .. }),
        "A receives message",
    )
    .await;
    match ev {
        FabricEvent::Message { from, data } => {
            assert_eq!(from, b.endpoint_id());
            assert_eq!(data, b"pong from B");
        }
        _ => unreachable!(),
    }

    // A 撤销 B：投影收紧 + 会话断开
    a.revoke(&b.endpoint_id()).await.unwrap();
    let _ = wait_event(
        &mut ev_a,
        |e| matches!(e, FabricEvent::PeerDisconnected { .. }),
        "A sees B disconnected",
    )
    .await;
    let _ = wait_event(
        &mut ev_b,
        |e| matches!(e, FabricEvent::PeerDisconnected { .. }),
        "B sees own disconnect",
    )
    .await;
    assert_eq!(a.members().await.len(), 1, "B removed from A projection");

    // B 重连被门控拒绝（B 本地投影在 HELLO 同步后含 revoke 事实——由撤销前的同步传播；
    // 若 B 尚未收到 revoke，A 侧门控也会拒绝其连接）
    let blocked = b.connect(&a.endpoint_id()).await;
    assert!(blocked.is_err(), "revoked member must not reconnect");

    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
}

#[tokio::test]
async fn non_member_connect_is_gated() {
    let dir_a = TempDir::new().unwrap();
    let dir_c = TempDir::new().unwrap();

    let a = Fabric::create_root(cfg(&dir_a)).await.unwrap();
    let c = Fabric::create_root(cfg(&dir_c)).await.unwrap();

    let err = c.connect(&a.endpoint_id()).await.unwrap_err();
    assert!(
        matches!(
            err,
            dweb_fabric::FabricError::Session(dweb_fabric::SessionError::NotMember(_))
        ),
        "expected NotMember, got {err:?}"
    );

    a.shutdown().await.unwrap();
    c.shutdown().await.unwrap();
}

#[tokio::test]
async fn root_restart_keeps_membership_and_identity() {
    let dir = TempDir::new().unwrap();
    let a1 = Fabric::create_root(cfg(&dir)).await.unwrap();
    let id1 = a1.endpoint_id();
    let fid1 = a1.fabric_id_hex().await;
    a1.shutdown().await.unwrap();

    let a2 = Fabric::open(cfg(&dir)).await.unwrap();
    assert_eq!(a2.endpoint_id(), id1);
    assert_eq!(a2.fabric_id_hex().await, fid1);
    assert_eq!(a2.members().await.len(), 1);
    a2.shutdown().await.unwrap();
}

#[tokio::test]
async fn remote_revoke_kicks_session_via_acceptor_path() {
    let dir_a = TempDir::new().unwrap();
    let dir_b = TempDir::new().unwrap();
    let dir_c = TempDir::new().unwrap();

    let a = Fabric::create_root(cfg(&dir_a)).await.unwrap();
    let fid = a.fabric_id_hex().await;

    let b = Fabric::attach(cfg(&dir_b), &fid).await.unwrap();
    let c = Fabric::attach(cfg(&dir_c), &fid).await.unwrap();
    let mut ev_c = c.subscribe();

    // A 邀请 B 与 C
    b.join(&a.invite(300_000, None).await.unwrap())
        .await
        .unwrap();
    c.join(&a.invite(300_000, None).await.unwrap())
        .await
        .unwrap();

    // B/C 各自再与 A 同步，互相知晓对方的 Grant
    b.connect(&a.endpoint_id()).await.unwrap();
    c.connect(&a.endpoint_id()).await.unwrap();

    // relay 禁用场景：显式交换地址提示
    for hint in c.direct_addr_hints_public().await {
        b.add_known_addr(&c.endpoint_id(), hint.clone())
            .await
            .unwrap();
        a.add_known_addr(&c.endpoint_id(), hint).await.unwrap();
    }
    for hint in b.direct_addr_hints_public().await {
        c.add_known_addr(&b.endpoint_id(), hint.clone())
            .await
            .unwrap();
        a.add_known_addr(&b.endpoint_id(), hint).await.unwrap();
    }

    // C 与 B 建立既有会话（B 主动拨号，C 为 acceptor）
    b.connect(&c.endpoint_id()).await.unwrap();
    let _ = wait_event(
        &mut ev_c,
        |e| matches!(e, FabricEvent::PeerConnected { .. }),
        "C sees B",
    )
    .await;

    // A 撤销 B
    a.revoke(&b.endpoint_id()).await.unwrap();

    // A 主动拨号 C：C 作为 acceptor 在 HELLO 中收到含 revoke(B) 的事实集，
    // 必须在 merge 后差集踢除并断开与 B 的既有会话（codex round3 场景）。
    // 先断开既有 A-C 连接，避免 connect 幂等短路不发 HELLO。
    a.disconnect(&c.endpoint_id()).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    a.connect(&c.endpoint_id()).await.unwrap();

    // C 侧观察到 B 下线（acceptor 路径差集踢除）
    let _ = wait_event(
        &mut ev_c,
        |e| matches!(e, FabricEvent::PeerDisconnected { .. }),
        "C kicks B",
    )
    .await;

    // B 不再是 C 的有效成员
    assert!(!c.is_member(&b.endpoint_id()).await.unwrap());

    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
    c.shutdown().await.unwrap();
}
