//! iroh relay 服务端嵌入：为无法直连的 fabric 节点提供桥接。
//! 端口拓扑（design D6）：DWEB_HTTP_BIND（rendezvous+healthz）、
//! DWEB_RELAY_HTTP_BIND（relay 控制面/WS 桥接，明文本地可用）、
//! DWEB_RELAY_QUIC_BIND（relay 数据面，需要 TLS，v0.1 默认关闭）。

use anyhow::{Context, Result};
use iroh_relay::server::{RelayConfig as RelayServerConfig, Server, ServerConfig};
use std::net::SocketAddr;

fn env_addr(key: &str) -> Option<SocketAddr> {
    std::env::var(key).ok()?.parse().ok()
}

/// 从环境变量构造并启动 relay。返回 None 表示未启用。
///
/// - `DWEB_RELAY_ENABLED`：默认 true，设为 "false"/"0" 关闭
/// - `DWEB_RELAY_HTTP_BIND`：默认 0.0.0.0:3340
/// - `DWEB_RELAY_QUIC_BIND`：可选；QUIC 数据面需要 TLS 配置，v0.1 未提供证书时跳过并告警
pub async fn start_from_env() -> Result<Option<Server>> {
    let enabled = std::env::var("DWEB_RELAY_ENABLED")
        .map(|v| !matches!(v.as_str(), "false" | "0" | "off"))
        .unwrap_or(true);
    if !enabled {
        tracing::info!("relay disabled by DWEB_RELAY_ENABLED");
        return Ok(None);
    }

    let http_bind =
        env_addr("DWEB_RELAY_HTTP_BIND").unwrap_or_else(|| SocketAddr::from(([0, 0, 0, 0], 3340)));
    let mut relay = RelayServerConfig::new(http_bind);
    relay.tls = None; // 生产由反代终结 TCP/WS；QUIC 需原生证书（见下）

    let mut config = ServerConfig::default();
    if let Some(quic_bind) = env_addr("DWEB_RELAY_QUIC_BIND") {
        if relay.tls.is_none() {
            tracing::warn!(
                "DWEB_RELAY_QUIC_BIND 设置但无 TLS 配置，QUIC 数据面未启用（明文 QUIC 不可用）"
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
