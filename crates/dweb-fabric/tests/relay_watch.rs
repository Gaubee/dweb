//! relay watcher 真实集成测试（R15 放行条件之一）：起真实 iroh relay server
//!（自签证书经 `RelayTlsTrust::CustomPem` 显式信任），断言 RelayOnline 事件、
//! 快照 online=true 且 active_url 指向该 relay（HB 8.1）。
//! HB 5.2：API 收口后 insecure_skip_verify 不可达——本测试用自定义 CA 的
//! 真实 TLS 验证路径替代（覆盖 CustomPem 分支，强于 skip-verify）。

use dweb_fabric::fabric::FabricEvent;
use dweb_fabric::{Fabric, FabricConfig, RelayConfig, RelayTlsTrust, SecretInjection};
use std::net::Ipv4Addr;
use tempfile::TempDir;

/// DER -> PEM（64 列换行；rustls-pki-types 1.15 仅有解码 API，编码在测试内手写）。
fn cert_der_to_pem(der: &[u8]) -> Vec<u8> {
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(der);
    let mut pem = String::from("-----BEGIN CERTIFICATE-----\n");
    for chunk in b64.as_bytes().chunks(64) {
        pem.push_str(std::str::from_utf8(chunk).unwrap());
        pem.push('\n');
    }
    pem.push_str("-----END CERTIFICATE-----\n");
    pem.into_bytes()
}

/// 以已知自签证书起真实 relay server，返回 (relay_url, 证书 PEM 字节, server
/// 保活句柄——测试期间必须持有，drop 即关停)。复刻 iroh test_utils::
/// run_relay_server 的装配，但保留证书供 CustomPem 信任。
async fn spawn_relay_with_known_cert() -> (String, Vec<u8>, iroh_relay::server::Server) {
    let (certs, server_config) = iroh_relay::server::testing::self_signed_tls_certs_and_config();
    let der = certs[0].as_ref().to_vec();
    let tls = iroh_relay::server::TlsConfig::new(
        (Ipv4Addr::LOCALHOST, 0),
        iroh_relay::server::CertConfig::Manual { server_config },
    );
    let mut relay = iroh_relay::server::RelayConfig::new((Ipv4Addr::LOCALHOST, 0));
    relay.tls = Some(tls);
    relay.key_cache_capacity = Some(1024);
    let mut config = iroh_relay::server::ServerConfig::default();
    config.relay = Some(relay);
    config.quic = None;
    let server = iroh_relay::server::Server::spawn(config)
        .await
        .expect("spawn iroh relay server");
    // 配置串以规范化形态（补 "/"）传入——内核快照 urls/active_url 原样回显
    // 配置串（R2 P1-4），断言可直接做字符串比较
    let url = format!("https://{}", server.https_addr().expect("https bound"))
        .parse::<iroh::RelayUrl>()
        .unwrap()
        .to_string();
    (url, cert_der_to_pem(&der), server)
}

#[tokio::test]
async fn live_relay_emits_relay_online_and_snapshot_true() {
    let (relay_url, cert_pem, _server) = spawn_relay_with_known_cert().await;

    let dir = TempDir::new().unwrap();
    let cfg = FabricConfig {
        data_dir: dir.path().to_owned(),
        relay: RelayConfig::Custom(vec![relay_url.to_string()]),
        advertise_addrs: Vec::new(),
        secret: SecretInjection::Default,
        http_proxy: dweb_fabric::HttpProxyConfig::None,
        join_timeout_ms: 30_000,
        relay_tls_trust: RelayTlsTrust::CustomPem(cert_pem),
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
    .unwrap_or_else(|_| {
        // 诊断：超时——打印快照（last_error 已脱敏为类别，"tls error" 即信任链问题）
        panic!("relay online timed out: {:?}", fabric.relay_status());
    });
    assert!(online, "snapshot must report online");

    let snapshot = fabric.relay_status();
    assert_eq!(snapshot.online, Some(true));
    assert!(snapshot.urls.contains(&relay_url.to_string()));
    // HB 8.1：active_url = 配置序最小已连接 relay（本测试单 relay 即其自身）
    assert_eq!(snapshot.active_url.as_deref(), Some(relay_url.as_str()));

    fabric.shutdown().await.expect("shutdown");
}
