//! 最小复现（正确版）：成员拨 root 建立 A 侧 acceptor 会话，root 断开后立即反向重拨。
//! 同一 fabric（attach+join 建立成员关系）。
//! 实证：LAN 提示（本机发夹）与 iroh 路径状态竞争会造成重拨卡死；仅 loopback 提示稳定。

use dweb_fabric::fabric::JOIN_TIMEOUT_MS_MIN;
use dweb_fabric::{Fabric, FabricConfig, FabricEvent, HttpProxyConfig, RelayConfig, SecretInjection};
use tempfile::TempDir;

fn cfg(dir: &TempDir) -> FabricConfig {
    FabricConfig {
        data_dir: dir.path().to_owned(),
        relay: RelayConfig::Disabled,
        advertise_addrs: Vec::new(),
        secret: SecretInjection::Default,
        http_proxy: HttpProxyConfig::None,
        join_timeout_ms: 30_000,
        bind_addr: None,
        relay_ca_tls: None,
    }
}

fn cfg_fixed_port(dir: &TempDir, port: u16) -> FabricConfig {
    FabricConfig {
        advertise_addrs: vec![format!("127.0.0.1:{port}")],
        bind_addr: Some(format!("127.0.0.1:{port}")),
        join_timeout_ms: JOIN_TIMEOUT_MS_MIN.max(5_000),
        ..cfg(dir)
    }
}

fn reserve_loopback_port() -> u16 {
    std::net::UdpSocket::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

#[tokio::test]
async fn redial_after_disconnect_succeeds() {
    let dir_a = TempDir::new().unwrap();
    let dir_b = TempDir::new().unwrap();

    let port = reserve_loopback_port();
    let a = Fabric::create_root(cfg_fixed_port(&dir_a, port)).await.unwrap();
    let fabric_id = a.fabric_id_hex().await;
    let b = Fabric::attach(cfg(&dir_b), &fabric_id).await.unwrap();
    let token = a
        .invite(std::time::Duration::from_secs(300).as_millis() as u64, None)
        .await
        .unwrap();
    b.join(&token).await.unwrap();

    // 仅 loopback 提示：LAN 路径在本机发夹场景与 iroh 路径状态竞争（见文件头注释）
    for hint in b.direct_addr_hints_public().await.into_iter().filter(|h| h.starts_with("127.0.0.1:")) {
        a.add_known_addr(&b.endpoint_id(), hint).await.unwrap();
    }
    for hint in a.direct_addr_hints_public().await {
        b.add_known_addr(&a.endpoint_id(), hint).await.unwrap();
    }

    // 成员拨 root（A 为 acceptor）
    b.connect(&a.endpoint_id()).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    // root 断开后立即反向重拨
    a.disconnect(&b.endpoint_id()).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    a.connect(&b.endpoint_id()).await.unwrap();

    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
}

/// R5 P1-1：并发 connect 的 single-flight——两个并发调用只产生一次拨号，
/// 都成功返回且只广播一次 PeerConnected。
#[tokio::test]
async fn concurrent_connect_single_flight() {
    let dir_a = TempDir::new().unwrap();
    let dir_b = TempDir::new().unwrap();

    let port = reserve_loopback_port();
    let a = Fabric::create_root(cfg_fixed_port(&dir_a, port)).await.unwrap();
    let fabric_id = a.fabric_id_hex().await;
    let b = Fabric::attach(cfg(&dir_b), &fabric_id).await.unwrap();
    let token = a
        .invite(std::time::Duration::from_secs(300).as_millis() as u64, None)
        .await
        .unwrap();
    b.join(&token).await.unwrap();

    for hint in b
        .direct_addr_hints_public()
        .await
        .into_iter()
        .filter(|h| h.starts_with("127.0.0.1:"))
    {
        a.add_known_addr(&b.endpoint_id(), hint).await.unwrap();
    }
    for hint in a
        .direct_addr_hints_public()
        .await
        .into_iter()
        .filter(|h| h.starts_with("127.0.0.1:"))
    {
        b.add_known_addr(&a.endpoint_id(), hint).await.unwrap();
    }

    let mut ev_b = b.subscribe();
    let bid = b.endpoint_id();

    // 两个并发 connect 同一目标：single-flight 下只应有一次拨号
    let (r1, r2) = tokio::join!(a.connect(&bid), a.connect(&bid));
    r1.unwrap();
    r2.unwrap(); // 等待者经 watch 唤醒后幂等 Ok（或即时成功）

    // 恰好一次 PeerConnected
    let mut connected = 0;
    while let Ok(ev) = ev_b.try_recv() {
        if matches!(ev, FabricEvent::PeerConnected { .. }) {
            connected += 1;
        }
    }
    assert_eq!(connected, 1, "single flight: exactly one PeerConnected");

    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
}

/// R6 P1-2：connect 与 shutdown 并发不因反向锁序死锁（有界完成）。
#[tokio::test]
async fn connect_and_shutdown_no_deadlock() {
    let dir_a = TempDir::new().unwrap();
    let dir_b = TempDir::new().unwrap();
    let port = reserve_loopback_port();
    let a = Fabric::create_root(cfg_fixed_port(&dir_a, port)).await.unwrap();
    let fabric_id = a.fabric_id_hex().await;
    let b = Fabric::attach(cfg(&dir_b), &fabric_id).await.unwrap();
    let token = a
        .invite(std::time::Duration::from_secs(300).as_millis() as u64, None)
        .await
        .unwrap();
    b.join(&token).await.unwrap();
    for hint in b
        .direct_addr_hints_public()
        .await
        .into_iter()
        .filter(|h| h.starts_with("127.0.0.1:"))
    {
        a.add_known_addr(&b.endpoint_id(), hint).await.unwrap();
    }
    let bid = b.endpoint_id();
    // 并发：一个 connect 与一个 shutdown——若锁序反转会死锁，10s 上界断言
    let connected = a.connect(&bid);
    let shut = a.shutdown();
    let res = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let (c, s) = tokio::join!(connected, shut);
        let _ = c; // 可能 Ok 可能 Err（shutdown 竞态）
        s
    })
    .await;
    assert!(res.is_ok(), "connect+shutdown must complete within 10s (no lock-order deadlock)");
    let _ = b.shutdown().await;
}
