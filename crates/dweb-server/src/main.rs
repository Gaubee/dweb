//! dweb 自托管服务端：rendezvous 登记/解析（HTTP）+ iroh relay 桥接。

mod relay;
mod rendezvous;

use anyhow::Result;

/// HTTP（rendezvous + healthz）监听地址
fn http_bind() -> String {
    std::env::var("DWEB_HTTP_BIND").unwrap_or_else(|_| "0.0.0.0:8787".into())
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let relay = relay::start_from_env().await?;

    let bind = http_bind();
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!("dweb-server rendezvous listening on http://{bind}");

    let http = axum::serve(listener, rendezvous::router());
    tokio::select! {
        res = http => res?,
        _ = tokio::signal::ctrl_c() => {
            tracing::info!("shutting down");
            if let Some(server) = relay {
                server.shutdown().await?;
            }
        }
    }
    Ok(())
}
