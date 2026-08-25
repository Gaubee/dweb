//! dweb 自托管服务端：rendezvous 登记/解析（HTTP）+ iroh relay（按 spike 结论接入中）。

mod rendezvous;

use anyhow::{Context, Result};

/// HTTP（rendezvous + healthz）监听地址
fn http_bind() -> String {
    std::env::var("DWEB_HTTP_BIND").unwrap_or_else(|_| "0.0.0.0:8787".into())
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let bind = http_bind();
    let listener = tokio::net::TcpListener::bind(&bind)
        .await
        .with_context(|| format!("bind {bind}"))?;
    tracing::info!("dweb-server listening on http://{bind}");

    // TODO(fabric-mvp 4.2): 按 spike-iroh 结论嵌入 iroh-relay 服务端（DWEB_RELAY_ENABLED/DWEB_RELAY_BIND）
    axum::serve(listener, rendezvous::router()).await?;
    Ok(())
}
