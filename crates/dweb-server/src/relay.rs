//! iroh relay 服务端嵌入：为无法直连的 fabric 节点提供桥接。
//! 端口拓扑（design D1）：DWEB_GATEWAY_BIND（gateway：rendezvous+healthz+services.json）、
//! DWEB_RELAY_HTTP_BIND（relay 控制面/WS 桥接，明文本地可用）、
//! DWEB_RELAY_QUIC_BIND（relay 数据面，需要 TLS，v0.1 默认关闭）。
//! 启用与绑定由 main 统一解析（flag > env > default）后传入。

use anyhow::{Context, Result};
use iroh_relay::server::{RelayConfig as RelayServerConfig, Server, ServerConfig};
use std::net::SocketAddr;

/// 构造并启动 relay。返回 None 表示未启用。
///
/// - `http_bind`：relay HTTP 监听地址（默认 0.0.0.0:3340，由 main 解析）
/// - `quic_bind`：可选；QUIC 数据面需要 TLS 配置，未提供证书时跳过并告警
pub async fn start(
    enabled: bool,
    http_bind: SocketAddr,
    quic_bind: Option<SocketAddr>,
) -> Result<Option<Server>> {
    if !enabled {
        tracing::info!("relay disabled");
        return Ok(None);
    }

    let mut relay = RelayServerConfig::new(http_bind);
    relay.tls = None; // 生产由反代终结 TCP/WS；QUIC 需原生证书（见下）

    let mut config = ServerConfig::default();
    if let Some(quic_bind) = quic_bind {
        if relay.tls.is_none() {
            tracing::warn!(
                "DWEB_RELAY_QUIC_BIND is set but no TLS config is present; \
                 QUIC data plane not enabled (plaintext QUIC unavailable)"
            );
        } else {
            config.quic = Some(iroh_relay::server::QuicConfig::new(quic_bind));
        }
    }
    config.relay = Some(relay);

    let server = Server::spawn(config)
        .await
        .context("spawn iroh relay server")?;
    let url = server
        .http_addr()
        .map(|a| format!("http://{a}"))
        .unwrap_or_else(|| "<unknown>".into());
    tracing::info!("iroh relay listening on {url}");
    Ok(Some(server))
}
