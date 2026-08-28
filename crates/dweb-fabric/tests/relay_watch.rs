//! relay watcher 真实集成测试（R15 放行条件之一）：起真实 iroh relay server，
//! 断言 RelayOnline 事件与快照 online=true。锁变更仅 iroh 条目具体化 "axum" 一行。

use dweb_fabric::fabric::FabricEvent;
use dweb_fabric::{Fabric, FabricConfig, RelayConfig, SecretInjection};
use tempfile::TempDir;

#[tokio::test]
async fn live_relay_emits_relay_online_and_snapshot_true() {
    let (_relay_map, relay_url, _server) = iroh::test_utils::run_relay_server()
        .await
        .expect("spawn iroh relay test server");

    let dir = TempDir::new().unwrap();
    let cfg = FabricConfig {
        data_dir: dir.path().to_owned(),
        relay: RelayConfig::Custom(vec![relay_url.to_string()]),
        advertise_addrs: Vec::new(),
        secret: SecretInjection::Default,
        http_proxy: dweb_fabric::HttpProxyConfig::None,
        join_timeout_ms: 30_000,
        relay_ca_tls: Some(iroh_relay::tls::CaTlsConfig::insecure_skip_verify()),
        bind_addr: None,
    };
    let fabric = Fabric::create_root(cfg).await.expect("create root fabric");
    let mut events = fabric.subscribe();

    // 有界等待 watcher 聚合为 online（relay 可达；失败即超时，不挂死）
    let online = tokio::time::timeout(std::time::Duration::from_secs(20), async {
        loop {
            if fabric.relay_status().online == Some(true) {
                return true;
            }
            // 快照未翻转前继续等事件驱动（事件只承载跳变；快照是权威）
            match tokio::time::timeout(std::time::Duration::from_millis(200), events.recv()).await {
                Ok(Ok(FabricEvent::RelayOnline { .. })) => continue,
                Ok(Ok(_)) => continue,
                Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
                Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => return false,
                Err(_) => continue, // 单次 200ms 无事件，回到快照轮询
            }
        }
    })
    .await
    .expect("relay should come online within 20s");
    assert!(online, "snapshot must report online");

    let snapshot = fabric.relay_status();
    assert_eq!(snapshot.online, Some(true));
    assert!(snapshot.urls.contains(&relay_url.to_string()));

    fabric.shutdown().await.expect("shutdown");
}
