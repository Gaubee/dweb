//! dweb 自托管服务端：gateway（rendezvous + healthz + services.json）+ iroh relay 桥接。
//! gateway 命名（design D1）：`--gateway` / `DWEB_GATEWAY_BIND` 为 canonical，
//! 优先级 flag > env > default。
//! 公网 URL 覆盖（public-exposure D1/D2）：`--public-gateway` / `--public-relay`
//! 与 `DWEB_PUBLIC_GATEWAY_URL` / `DWEB_PUBLIC_RELAY_URL` 声明反代/隧道后的
//! 公网入口，services.json 按条目跳过 Host 派生（厂商中立的反代适配层）。

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
    public_gateway: Option<String>,
    public_relay: Option<String>,
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
        let value_opts = ["--gateway", "--relay", "--public-gateway", "--public-relay"];
        if value_opts.contains(&name.as_str()) {
            let value = match inline_value {
                Some(v) => v,
                None => it
                    .next()
                    .ok_or_else(|| format!("missing value for {name}"))?,
            };
            match name.as_str() {
                "--relay" => cli.relay = Some(value),
                "--gateway" => cli.gateway = Some(value),
                "--public-gateway" => cli.public_gateway = Some(value),
                _ => cli.public_relay = Some(value),
            }
            continue;
        }
        match name.as_str() {
            "--no-relay" => cli.relay_enabled = Some(false),
            other => return Err(format!("unknown option {other}")),
        }
    }
    Ok(cli)
}

const DEFAULT_GATEWAY_BIND: &str = "0.0.0.0:8787";

/// gateway 监听地址解析（纯函数）：--gateway flag > DWEB_GATEWAY_BIND > 默认
fn resolve_gateway_bind(flag: Option<&str>, env_canonical: Option<&str>) -> String {
    flag.or(env_canonical)
        .unwrap_or(DEFAULT_GATEWAY_BIND)
        .to_string()
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

/// 公网 URL 白名单校验（public-exposure D2）：`http(s)://host[:port]`，
/// path 仅允许空或 `/`，拒绝 query/fragment/userinfo。拒绝 path 的根因：
/// iroh 客户端 `set_path("/relay")` 会丢弃 relay URL 中的任何 path；
/// gateway 的 rendezvous 条目靠字符串拼接，path 前缀同样破坏语义。
fn validate_public_url(value: &str) -> Result<(), String> {
    // http::Uri 解析会静默丢弃 fragment——必须先于解析显式拒绝
    if value.contains('#') {
        return Err(format!(
            "invalid public url {value}: fragment is not allowed"
        ));
    }
    let uri: axum::http::Uri = value
        .parse()
        .map_err(|_| format!("invalid public url {value}: cannot parse as absolute URL"))?;
    let scheme = uri.scheme_str().unwrap_or_default();
    if scheme != "http" && scheme != "https" {
        return Err(format!(
            "invalid public url {value}: scheme must be http or https, got {scheme:?}"
        ));
    }
    let host = uri.host().unwrap_or_default();
    if host.is_empty() {
        return Err(format!("invalid public url {value}: missing host"));
    }
    if let Some(port) = uri.port_u16() {
        if port == 0 {
            return Err(format!("invalid public url {value}: port must be 1-65535"));
        }
    }
    let path = uri.path();
    if path != "/" && !path.is_empty() {
        return Err(format!(
            "invalid public url {value}: path prefix is not supported (expected scheme://host[:port])"
        ));
    }
    if uri.query().is_some() {
        return Err(format!("invalid public url {value}: query is not allowed"));
    }
    Ok(())
}

/// 解析公网覆盖（flag > env > 未设置）；尾随单个 `/` 归一化剥除。
/// 非法值硬错误（与 bind 同类失败，退出码 2）。
fn resolve_public_urls(
    cli: &Cli,
    get_env: impl Fn(&str) -> Option<String>,
) -> Result<(Option<String>, Option<String>), String> {
    let resolve_one =
        |flag: Option<&str>, env_key: &str, label: &str| -> Result<Option<String>, String> {
            let raw = match flag.map(str::to_owned).or_else(|| get_env(env_key)) {
                Some(v) => v,
                None => return Ok(None),
            };
            validate_public_url(&raw).map_err(|e| format!("{e} ({label})"))?;
            let normalized = raw.strip_suffix('/').unwrap_or(&raw).to_owned();
            Ok(Some(normalized))
        };
    let gateway = resolve_one(
        cli.public_gateway.as_deref(),
        "DWEB_PUBLIC_GATEWAY_URL",
        "DWEB_PUBLIC_GATEWAY_URL / --public-gateway",
    )?;
    let relay = resolve_one(
        cli.public_relay.as_deref(),
        "DWEB_PUBLIC_RELAY_URL",
        "DWEB_PUBLIC_RELAY_URL / --public-relay",
    )?;
    Ok((gateway, relay))
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

    let (public_gateway_url, public_relay_url) =
        match resolve_public_urls(&cli, |k| std::env::var(k).ok()) {
            Ok(v) => v,
            Err(msg) => {
                eprintln!("error: {msg}");
                std::process::exit(2);
            }
        };
    if let Some(url) = &public_gateway_url {
        tracing::info!("public gateway url override: {url}");
    }
    if let Some(url) = &public_relay_url {
        tracing::info!("public relay url override: {url}");
    }

    let info = std::sync::Arc::new(services::ServiceInfo {
        gateway_port: local.port(),
        relay_port: relay.as_ref().and_then(|s| s.http_addr()).map(|a| a.port()),
        trust_proxy: std::env::var("DWEB_TRUST_PROXY").ok().as_deref() == Some("1"),
        fallback_ipv4: services::primary_non_loopback_ipv4(),
        public_gateway_url,
        public_relay_url,
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
            [
                "--gateway",
                "0.0.0.0:9999",
                "--relay",
                "0.0.0.0:3350",
                "--no-relay",
                "--public-gateway",
                "https://gw.example.com",
                "--public-relay",
                "https://relay.example.com",
            ]
            .into_iter()
            .map(String::from),
        )
        .unwrap();
        assert_eq!(cli.gateway.as_deref(), Some("0.0.0.0:9999"));
        assert_eq!(cli.relay.as_deref(), Some("0.0.0.0:3350"));
        assert_eq!(cli.relay_enabled, Some(false));
        assert_eq!(
            cli.public_gateway.as_deref(),
            Some("https://gw.example.com")
        );
        assert_eq!(
            cli.public_relay.as_deref(),
            Some("https://relay.example.com")
        );
    }

    #[test]
    fn cli_public_url_inline_form_equals_split_form() {
        let a = parse_cli(
            ["--public-gateway", "https://a.example.com"]
                .into_iter()
                .map(String::from),
        )
        .unwrap();
        let b = parse_cli(
            ["--public-gateway=https://a.example.com"]
                .into_iter()
                .map(String::from),
        )
        .unwrap();
        assert_eq!(a.public_gateway, b.public_gateway);
    }

    #[test]
    fn cli_public_url_missing_value_rejected() {
        assert!(parse_cli(["--public-gateway".into()].into_iter()).is_err());
        assert!(parse_cli(["--public-relay".into()].into_iter()).is_err());
    }

    #[test]
    fn validate_public_url_accepts_minimal_forms() {
        for ok in [
            "https://gw.example.com",
            "https://gw.example.com/",
            "http://192.168.1.9:8787",
            "http://[fd00::1]:9000",
            "https://relay.example.com:443",
        ] {
            validate_public_url(ok).unwrap_or_else(|e| panic!("{ok}: {e}"));
        }
    }

    #[test]
    fn validate_public_url_rejects_structured_forms() {
        // path 前缀：iroh set_path("/relay") 会丢弃 path，必然错配
        assert!(validate_public_url("https://ex.com/dweb").is_err());
        // query / fragment / 非 http(s) / 空 host / 端口 0
        assert!(validate_public_url("https://ex.com/?a=b").is_err());
        assert!(validate_public_url("https://ex.com/#frag").is_err());
        assert!(validate_public_url("ftp://ex.com").is_err());
        assert!(validate_public_url("https://").is_err());
        assert!(validate_public_url("http://ex.com:0").is_err());
        assert!(validate_public_url("not a url").is_err());
    }

    #[test]
    fn resolve_public_urls_priority_and_normalization() {
        let cli = Cli {
            public_gateway: Some("https://flag-gw.example.com".into()),
            public_relay: None,
            ..Cli::default()
        };

        // flag gateway > env gateway；env relay 合法则生效
        let env1: std::collections::HashMap<String, String> = [
            ("DWEB_PUBLIC_GATEWAY_URL", "https://env-gw.example.com/"),
            ("DWEB_PUBLIC_RELAY_URL", "https://env-relay.example.com"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let (gw, relay) = resolve_public_urls(&cli, |k| env1.get(k).cloned()).unwrap();
        assert_eq!(gw.as_deref(), Some("https://flag-gw.example.com"));
        assert_eq!(relay.as_deref(), Some("https://env-relay.example.com"));

        // env relay 非法 → 硬错误（即使 gateway 侧全部合法）
        let env2: std::collections::HashMap<String, String> = [("DWEB_PUBLIC_RELAY_URL", "bogus")]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        assert!(resolve_public_urls(&Cli::default(), |k| env2.get(k).cloned()).is_err());

        // 纯 env 路径 + 尾随 "/" 归一化剥除
        let env3: std::collections::HashMap<String, String> =
            [("DWEB_PUBLIC_GATEWAY_URL", "https://env-gw.example.com/")]
                .into_iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();
        let (gw, relay) = resolve_public_urls(&Cli::default(), |k| env3.get(k).cloned()).unwrap();
        assert_eq!(gw.as_deref(), Some("https://env-gw.example.com"));
        assert_eq!(relay, None);
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
