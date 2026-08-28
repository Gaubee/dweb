//! dweb 自托管服务端：gateway（rendezvous + healthz + services.json）+ iroh relay 桥接。
//! gateway 命名（design D1）：`--gateway` / `DWEB_GATEWAY_BIND` 为 canonical，
//! 优先级 flag > env > default。

mod relay;
mod rendezvous;
mod services;

use anyhow::{Context, Result};
use std::net::SocketAddr;

/// CLI 覆盖项（flag > env > default）
#[derive(Default)]
struct Cli {
    gateway: Option<String>,
    relay: Option<String>,
    relay_enabled: Option<bool>,
}

fn parse_cli(args: impl Iterator<Item = String>) -> Result<Cli, String> {
    let mut cli = Cli::default();
    let mut it = args;
    while let Some(arg) = it.next() {
        // `--opt value` 与 `--opt=value` 双形式等价（D8 语义同样适用于二进制入口）
        let (name, inline_value) = match arg.split_once('=') {
            Some((n, v)) => (n.to_owned(), Some(v.to_owned())),
            None => (arg.clone(), None),
        };
        match name.as_str() {
            "--gateway" | "--relay" => {
                let value = match inline_value {
                    Some(v) => v,
                    None => it.next().ok_or_else(|| format!("missing value for {name}"))?,
                };
                if name == "--relay" {
                    cli.relay = Some(value);
                } else {
                    cli.gateway = Some(value);
                }
            }
            "--no-relay" => cli.relay_enabled = Some(false),
            other => return Err(format!("unknown option {other}")),
        }
    }
    Ok(cli)
}

const DEFAULT_GATEWAY_BIND: &str = "0.0.0.0:8787";

/// gateway 监听地址解析（纯函数）：--gateway flag > DWEB_GATEWAY_BIND > 默认
fn resolve_gateway_bind(flag: Option<&str>, env_canonical: Option<&str>) -> String {
    flag.or(env_canonical).unwrap_or(DEFAULT_GATEWAY_BIND).to_string()
}

fn gateway_bind(cli: &Cli) -> String {
    resolve_gateway_bind(
        cli.gateway.as_deref(),
        std::env::var("DWEB_GATEWAY_BIND").ok().as_deref(),
    )
}

fn relay_bind(cli: &Cli) -> Result<SocketAddr, String> {
    // 显式给出的 bind 解析失败必须硬错误退出——静默回退默认端口会把
    // 拼写错误变成意外开放 0.0.0.0:3340（实现复审 P1-5）。
    let raw = cli
        .relay
        .clone()
        .or_else(|| std::env::var("DWEB_RELAY_HTTP_BIND").ok());
    match raw {
        Some(raw) => raw
            .parse()
            .map_err(|e| format!("invalid relay bind {raw}: {e}")),
        None => Ok(SocketAddr::from(([0, 0, 0, 0], 3340))),
    }
}

fn relay_enabled(cli: &Cli) -> bool {
    cli.relay_enabled.unwrap_or_else(|| {
        std::env::var("DWEB_RELAY_ENABLED")
            .map(|v| !matches!(v.as_str(), "false" | "0" | "off"))
            .unwrap_or(true)
    })
}

fn env_addr(key: &str) -> Option<SocketAddr> {
    std::env::var(key).ok()?.parse().ok()
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let cli = match parse_cli(std::env::args().skip(1)) {
        Ok(cli) => cli,
        Err(msg) => {
            eprintln!("error: {msg}");
            std::process::exit(2);
        }
    };

    let relay_bind_addr = match relay_bind(&cli) {
        Ok(a) => a,
        Err(msg) => {
            eprintln!("error: {msg}");
            std::process::exit(2);
        }
    };
    let relay = relay::start(
        relay_enabled(&cli),
        relay_bind_addr,
        env_addr("DWEB_RELAY_QUIC_BIND"),
    )
    .await?;

    let bind = gateway_bind(&cli);
    let bind_addr: SocketAddr = bind
        .parse()
        .with_context(|| format!("invalid gateway bind address {bind}"))?;
    let listener = tokio::net::TcpListener::bind(bind_addr)
        .await
        .with_context(|| format!("gateway bind {bind}"))?;
    let local = listener.local_addr()?;
    tracing::info!("dweb-server gateway listening on http://{local}");

    let info = std::sync::Arc::new(services::ServiceInfo {
        gateway_port: local.port(),
        relay_port: relay.as_ref().and_then(|s| s.http_addr()).map(|a| a.port()),
        trust_proxy: std::env::var("DWEB_TRUST_PROXY").ok().as_deref() == Some("1"),
        fallback_ipv4: services::primary_non_loopback_ipv4(),
    });

    let app = rendezvous::router().merge(services::router(info));
    let http = axum::serve(listener, app);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_flags_parsed() {
        let cli = parse_cli(
            ["--gateway", "0.0.0.0:9999", "--relay", "0.0.0.0:3350", "--no-relay"]
                .into_iter()
                .map(String::from),
        )
        .unwrap();
        assert_eq!(cli.gateway.as_deref(), Some("0.0.0.0:9999"));
        assert_eq!(cli.relay.as_deref(), Some("0.0.0.0:3350"));
        assert_eq!(cli.relay_enabled, Some(false));
    }

    #[test]
    fn cli_http_alias_equals_gateway() {
        let a = parse_cli(["--gateway", "0.0.0.0:9000"].into_iter().map(String::from)).unwrap();
        let b = parse_cli(["--gateway=0.0.0.0:9000"].into_iter().map(String::from)).unwrap();
        assert_eq!(a.gateway, b.gateway);
    }

    #[test]
    fn cli_unknown_option_rejected() {
        assert!(parse_cli(["--foo".into()].into_iter()).is_err());
        assert!(parse_cli(["--gateway".into()].into_iter()).is_err()); // 缺值
    }

    #[test]
    fn gateway_bind_priority_flag_env_default() {
        // flag > env > default
        assert_eq!(resolve_gateway_bind(Some("A"), Some("G")), "A");
        assert_eq!(resolve_gateway_bind(None, Some("G")), "G");
        assert_eq!(resolve_gateway_bind(None, None), DEFAULT_GATEWAY_BIND);
    }
}
