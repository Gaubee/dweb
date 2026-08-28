//! gateway 服务清单：`GET /services.json`（机器可读）与 `GET /`（全 ASCII 人类可读摘要）。
//! URL 派生规则（design D1 + public-exposure D3）：
//! - 公网覆盖（public_gateway_url / public_relay_url，启动期已校验）按条目完全跳过
//!   Host/scheme/回退派生——覆盖条目不产生 WARNING、不受 DWEB_TRUST_PROXY 影响；
//! - 未覆盖条目：scheme 跟随请求；`X-Forwarded-Proto` 仅当 `DWEB_TRUST_PROXY=1` 时采信，
//!   否则一律 http；
//! - Host 拒绝集合冻结为：unspecified 地址（0.0.0.0、::、空 host）、含 userinfo 形态、
//!   host:port 解析失败、端口 0 或 >65535；其余一律放行（含 loopback）；
//! - 校验失败或无 Host 头时回退本机首个非 loopback IPv4；无回退时 url=null 并 WARNING
//!   （精确串 `no non-loopback IPv4 available; URLs are null`），绝不产出 0.0.0.0 形态 URL；
//!   两个条目均被覆盖时连 Host 校验/回退探测都不执行（覆盖独立于回退）；
//! - 各服务条目使用实际监听端口；未知服务名静默忽略（前向兼容）；重复名取首个并 WARNING；
//!   relay 条目 scheme 校验 http(s)（派生与覆盖同规），否则按禁用处理并 WARNING。

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, header},
    response::{IntoResponse, Response},
    routing::get,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    sync::Arc,
};

/// 服务端标识（wire 冻结，fixture "server" 字段）
const SERVER_NAME: &str = "opendweb";
/// 回退地址探测远端：UDP connect 不发包，仅让路由选出出口 IPv4
#[cfg(not(unix))]
const FALLBACK_PROBE_ADDR: &str = "8.8.8.8:80";
/// 无可用回退地址时的服务端 WARNING（fixture nullable 案例精确串）
pub const NO_FALLBACK_WARNING: &str = "no non-loopback IPv4 available; URLs are null";

/// 已知服务名集合（前向兼容：未知名静默忽略）
const KNOWN_SERVICES: [&str; 2] = ["rendezvous", "relay"];

/// gateway 运行态快照：services.json 与 GET / 摘要的唯一数据源。
#[derive(Debug, Clone)]
pub struct ServiceInfo {
    /// gateway 实际监听端口
    pub gateway_port: u16,
    /// relay 实际监听端口；None = 禁用（条目 enabled:false / url:null）
    pub relay_port: Option<u16>,
    /// 是否采信 X-Forwarded-Proto（仅 DWEB_TRUST_PROXY=1 为 true）
    pub trust_proxy: bool,
    /// Host 校验失败时的回退地址（本机首个非 loopback IPv4；与横幅同一枚举语义）
    pub fallback_ipv4: Option<Ipv4Addr>,
    /// 公网 gateway 覆盖（启动期校验并归一化）；设置时 gateway/rendezvous 条目跳过派生
    pub public_gateway_url: Option<String>,
    /// 公网 relay 覆盖；设置且 relay 启用时 relay 条目跳过派生
    pub public_relay_url: Option<String>,
}

/// manifest 服务条目（wire 字段顺序冻结：name, enabled, url；url 为 string | null）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ServiceEntry {
    pub name: String,
    pub enabled: bool,
    pub url: Option<String>,
}

/// 服务清单（wire 字段顺序冻结：server, version, gateway, services）
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Manifest {
    pub server: String,
    pub version: String,
    pub gateway: Option<String>,
    pub services: Vec<ServiceEntry>,
}

/// 本机首个非 loopback IPv4：UDP connect 让路由选择出口地址（不发包）。
/// 与 JS 横幅的 os.networkInterfaces() 枚举同一语义的 rust 侧近似（首地址）。
pub fn primary_non_loopback_ipv4() -> Option<Ipv4Addr> {
    // 本机接口枚举（与横幅 os.networkInterfaces() 同语义），不依赖默认路由/外网
    // （UDP-connect 试探在离线但有 LAN 网卡时返回 None——实现复审 P1-7）。
    #[cfg(unix)]
    {
        let ifas = nix::ifaddrs::getifaddrs().ok()?;
        for ifa in ifas {
            let Some(storage) = ifa.address else { continue };
            let Some(inet) = storage.as_sockaddr_in() else {
                continue;
            };
            let v4 = inet.ip();
            // 与横幅（networkInterfaces 非 loopback IPv4）同语义：不额外排除
            // link-local（169.254）——只有此类网卡时 gateway 仍有单一入口地址
            if !v4.is_loopback() {
                return Some(v4);
            }
        }
        None
    }
    #[cfg(not(unix))]
    {
        use std::net::UdpSocket;
        let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
        socket.connect(FALLBACK_PROBE_ADDR).ok()?;
        match socket.local_addr().ok()?.ip() {
            IpAddr::V4(v4) if !v4.is_loopback() => Some(v4),
            _ => None,
        }
    }
}

/// Host 头 -> URL 就绪 host 形态（IPv6 已带括号）。
/// 拒绝集合见模块注释；其余放行（含 loopback、域名）。
fn host_from_header(value: &str) -> Result<String, ()> {
    // P1-10：先按**原始**值逐字节校验（trim 会移除首尾空白/控制字节绕过
    // 拒绝集合），再做结构化解析
    if value.is_empty() {
        return Err(());
    }
    // 注入形态拒绝（D1 冻结集合 + P1-6）：URL 结构字符、控制字符、空白。
    // 非 ASCII（国际化域名）不在注入向量内、按"其余放行"处理——
    // JSON manifest 为 UTF-8 原样、纯文本摘要层转义（见 summary_text）。
    if value
        .bytes()
        .any(|b| b == b'@' || b == b'/' || b == b'?' || b == b'#' || b <= 0x20 || b == 0x7f)
    {
        return Err(());
    }
    if let Some(rest) = value.strip_prefix('[') {
        // [ipv6] 或 [ipv6]:port；unspecified（[::]）拒绝
        let (inner, tail) = rest.split_once(']').ok_or(())?;
        let ip: Ipv6Addr = inner.parse().map_err(|_| ())?;
        if ip.is_unspecified() {
            return Err(());
        }
        validate_bracket_tail(tail)?;
        return Ok(format!("[{ip}]"));
    }
    if let Some((host, port)) = value.rsplit_once(':') {
        // host:port 形态；host 自身再含 ':'（未加括号的 IPv6）视为解析失败
        if host.contains(':') || host.is_empty() {
            return Err(());
        }
        validate_port(port)?;
        return host_to_url_form(host);
    }
    host_to_url_form(value)
}

/// 括号形态尾部：空 或 ":port"（其余拒绝）
fn validate_bracket_tail(tail: &str) -> Result<(), ()> {
    if tail.is_empty() {
        return Ok(());
    }
    match tail.strip_prefix(':') {
        Some(port) => validate_port(port),
        None => Err(()),
    }
}

/// 端口校验：可解析为 u16（>65535 自然失败）且非 0
fn validate_port(port: &str) -> Result<(), ()> {
    let port: u16 = port.parse().map_err(|_| ())?;
    if port == 0 { Err(()) } else { Ok(()) }
}

/// host 主机部分 -> URL 形态；unspecified 拒绝，域名放行
fn host_to_url_form(host: &str) -> Result<String, ()> {
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => {
            if v4.is_unspecified() {
                Err(())
            } else {
                Ok(v4.to_string())
            }
        }
        Ok(IpAddr::V6(v6)) => {
            if v6.is_unspecified() {
                Err(())
            } else {
                Ok(format!("[{v6}]"))
            }
        }
        // 域名：拒绝集合之外一律放行
        Err(_) => {
            if host.is_empty() {
                Err(())
            } else {
                Ok(host.to_string())
            }
        }
    }
}

/// 请求 scheme：服务器只监听明文 HTTP，直接请求恒为 http；
/// `X-Forwarded-Proto` 仅在 trust_proxy（DWEB_TRUST_PROXY=1）时采信（取首段，http/https 之外忽略）。
fn request_scheme(info: &ServiceInfo, headers: &HeaderMap) -> String {
    if info.trust_proxy
        && let Some(raw) = headers
            .get("x-forwarded-proto")
            .and_then(|v| v.to_str().ok())
    {
        let proto = raw
            .split(',')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if proto == "http" || proto == "https" {
            return proto;
        }
    }
    "http".to_string()
}

/// 构造服务清单。返回 (manifest, 服务端 WARNING 列表)。
/// 公网覆盖（public-exposure D3）：按条目独立——覆盖条目跳过 Host/scheme/回退派生；
/// 仅当仍有条目需要派生时才执行 Host 校验与回退探测（覆盖独立于回退）。
pub fn build_manifest(
    info: &ServiceInfo,
    scheme: &str,
    host_header: Option<&str>,
) -> (Manifest, Vec<String>) {
    let mut warnings = Vec::new();

    // 是否仍需 Host 派生：gateway 未覆盖，或 relay 启用且未覆盖
    let relay_needs_derived = info.relay_port.is_some() && info.public_relay_url.is_none();
    let need_derived = info.public_gateway_url.is_none() || relay_needs_derived;

    // Host 派生；校验失败或缺失 -> 回退本机首个非 loopback IPv4 -> 无则全 null + WARNING
    let derived_base: Option<String> = if !need_derived {
        None
    } else {
        match host_header.map(host_from_header) {
            Some(Ok(host)) => Some(host),
            Some(Err(())) | None => match info.fallback_ipv4 {
                Some(ip) => Some(ip.to_string()),
                None => {
                    warnings.push(NO_FALLBACK_WARNING.to_string());
                    None
                }
            },
        }
    };

    // gateway / rendezvous：覆盖优先，rendezvous 为基址 + "/rendezvous" 字符串拼接
    let gateway = match &info.public_gateway_url {
        Some(url) => Some(url.clone()),
        None => derived_base
            .as_ref()
            .map(|h| format!("{scheme}://{h}:{}", info.gateway_port)),
    };
    let rendezvous_url = match &info.public_gateway_url {
        Some(url) => Some(format!("{url}/rendezvous")),
        None => derived_base
            .as_ref()
            .map(|h| format!("{scheme}://{h}:{}{}", info.gateway_port, "/rendezvous")),
    };

    let mut raw = vec![ServiceEntry {
        name: "rendezvous".into(),
        enabled: true,
        url: rendezvous_url,
    }];
    raw.push(match info.relay_port {
        None => ServiceEntry {
            name: "relay".into(),
            enabled: false,
            url: None,
        },
        Some(port) => {
            // 覆盖优先（启动期已校验；前缀断言只是防御性兜底，不信任 ServiceInfo 构造者）
            if let Some(url) = info.public_relay_url.as_ref() {
                if url.starts_with("http://") || url.starts_with("https://") {
                    ServiceEntry {
                        name: "relay".into(),
                        enabled: true,
                        url: Some(url.clone()),
                    }
                } else {
                    warnings.push(format!(
                        "relay url scheme must be http or https, got {url}; relay entry disabled"
                    ));
                    ServiceEntry {
                        name: "relay".into(),
                        enabled: false,
                        url: None,
                    }
                }
            } else if scheme != "http" && scheme != "https" {
                warnings.push(format!(
                    "relay url scheme must be http or https, got {scheme}; relay entry disabled"
                ));
                ServiceEntry {
                    name: "relay".into(),
                    enabled: false,
                    url: None,
                }
            } else {
                // 派生路径：enabled 恒 true，url 可为 null（无回退地址的冻结形态）
                ServiceEntry {
                    name: "relay".into(),
                    enabled: true,
                    url: derived_base
                        .as_ref()
                        .map(|h| format!("{scheme}://{h}:{port}")),
                }
            }
        }
    });

    let services = filter_known_dedup(raw, &mut warnings);
    (
        Manifest {
            server: SERVER_NAME.into(),
            version: env!("CARGO_PKG_VERSION").into(),
            gateway,
            services,
        },
        warnings,
    )
}

/// 未知名静默忽略（前向兼容）；重复名取首个并输出一条 WARNING（精确串 `duplicate service name: <name>`）。
pub fn filter_known_dedup(raw: Vec<ServiceEntry>, warnings: &mut Vec<String>) -> Vec<ServiceEntry> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for entry in raw {
        if !KNOWN_SERVICES.contains(&entry.name.as_str()) {
            continue;
        }
        if seen.insert(entry.name.clone()) {
            out.push(entry);
        } else {
            warnings.push(format!("duplicate service name: {}", entry.name));
        }
    }
    out
}

/// 动态值 ASCII 转义（design D10）：非 ASCII 字节与控制字符（含换行）以小写十六进制 \xNN 输出
pub fn ascii_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.as_bytes() {
        if byte.is_ascii_graphic() || *byte == b' ' {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("\\x{byte:02x}"));
        }
    }
    out
}

/// GET / 纯文本摘要（全 ASCII；内容与清单一致）
fn summary_text(manifest: &Manifest) -> String {
    let esc = ascii_escape;
    let mut lines = Vec::new();
    lines.push(format!("opendweb server v{}", esc(&manifest.version)));
    match &manifest.gateway {
        Some(url) => lines.push(format!("gateway: {}", esc(url))),
        None => lines.push("gateway: (no url available)".into()),
    }
    lines.push(String::new());
    lines.push("NAME         ENABLED  URL".into());
    for svc in &manifest.services {
        let url = match &svc.url {
            Some(u) => esc(u),
            None => "(no url available)".to_string(),
        };
        lines.push(format!(
            "{:<12} {:<8} {}",
            esc(&svc.name),
            if svc.enabled { "yes" } else { "no" },
            url
        ));
    }
    lines.push(String::new());
    match &manifest.gateway {
        Some(url) => lines.push(format!("service manifest: {}/services.json", esc(url))),
        None => lines.push("service manifest: (no url available)".into()),
    }
    let mut text = lines.join("\n");
    text.push('\n');
    text
}

pub fn router(info: Arc<ServiceInfo>) -> Router {
    Router::new()
        .route("/", get(summary_handler))
        .route("/services.json", get(manifest_handler))
        .with_state(info)
}

fn log_warnings(warnings: &[String]) {
    for w in warnings {
        tracing::warn!("{w}");
    }
}

async fn manifest_handler(State(info): State<Arc<ServiceInfo>>, headers: HeaderMap) -> Response {
    let scheme = request_scheme(&info, &headers);
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok());
    let (manifest, warnings) = build_manifest(&info, &scheme, host);
    log_warnings(&warnings);
    let mut res = Json(manifest).into_response();
    res.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    res
}

async fn summary_handler(State(info): State<Arc<ServiceInfo>>, headers: HeaderMap) -> Response {
    let scheme = request_scheme(&info, &headers);
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok());
    let (manifest, warnings) = build_manifest(&info, &scheme, host);
    log_warnings(&warnings);
    (
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        summary_text(&manifest),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    /// 权威 fixture（C0 冻结 + public-exposure 增补）：字段快照断言的数据源
    const FIXTURES: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../openspec/changes/public-exposure/contracts/services.fixtures.json"
    ));

    #[derive(Debug, Deserialize)]
    struct FixtureCase {
        name: String,
        manifest: serde_json::Value,
        #[serde(rename = "expectedServerWarnings", default)]
        expected_server_warnings: Option<Vec<String>>,
    }

    #[derive(Debug, Deserialize)]
    struct Fixtures {
        cases: Vec<FixtureCase>,
    }

    fn fixtures() -> Fixtures {
        serde_json::from_str(FIXTURES).expect("fixtures parse")
    }

    fn info_full() -> ServiceInfo {
        ServiceInfo {
            gateway_port: 8787,
            relay_port: Some(3340),
            trust_proxy: false,
            fallback_ipv4: Some("192.168.2.13".parse().unwrap()),
            public_gateway_url: None,
            public_relay_url: None,
        }
    }

    fn info_no_relay() -> ServiceInfo {
        ServiceInfo {
            relay_port: None,
            ..info_full()
        }
    }

    fn info_no_fallback() -> ServiceInfo {
        ServiceInfo {
            fallback_ipv4: None,
            ..info_full()
        }
    }

    fn manifest_json(m: &Manifest) -> serde_json::Value {
        serde_json::to_value(m).unwrap()
    }

    /// 字段快照断言：version 为占位值（各包版本归 owner），其余字段名/结构/URL 完全一致
    fn assert_matches_fixture(m: &Manifest, case: &FixtureCase) {
        let mut actual = manifest_json(m);
        actual["version"] = case.manifest["version"].clone();
        assert_eq!(actual, case.manifest, "case {}", case.name);
    }

    #[test]
    fn host_header_accepted_forms() {
        for (header, expect) in [
            ("192.168.2.13:8787", "192.168.2.13"),
            ("192.168.2.13", "192.168.2.13"),
            ("example.com:8787", "example.com"),
            ("example.com", "example.com"),
            // loopback 放行（本机调试合法）
            ("127.0.0.1:8787", "127.0.0.1"),
            ("localhost:8787", "localhost"),
            ("[::1]:8787", "[::1]"),
            // 括号 IPv6 剥离 + URL 括号形态
            ("[fd00::1]:8787", "[fd00::1]"),
            ("255.255.255.255:80", "255.255.255.255"),
        ] {
            assert_eq!(host_from_header(header).unwrap(), expect, "header {header}");
        }
    }

    #[test]
    fn host_header_rejected_forms() {
        for header in [
            // 空 host
            "",
            "   ",
            // unspecified（冻结集合：0.0.0.0、::；"0" 等非点分四段形态按域名放行）
            "0.0.0.0",
            "0.0.0.0:8787",
            "[::]",
            "[::]:8787",
            // userinfo
            "user:pass@host:8787",
            "user@host",
            // host:port 解析失败
            "host:abc",
            "host:",
            ":8080",
            "fd00::1:8787", // 未加括号的 IPv6
            "a:b:c:80",
            "[1.2.3.4]:80", // 括号内非 IPv6
            "[fd00::1]x",
            "[fd00::1",
            // 端口 0 / 越界（>65535 解析自然失败）
            "host:0",
            "host:65536",
            "host:99999",
            "[fd00::1]:0",
            "[fd00::1]:99999",
        ] {
            assert!(
                host_from_header(header).is_err(),
                "header {header:?} should be rejected"
            );
        }
    }

    #[test]
    fn manifest_canonical_shape() {
        let (m, w) = build_manifest(&info_full(), "http", Some("192.168.2.13:8787"));
        assert_eq!(w, Vec::<String>::new());
        assert_eq!(m.gateway.as_deref(), Some("http://192.168.2.13:8787"));
        assert_eq!(
            m.services,
            vec![
                ServiceEntry {
                    name: "rendezvous".into(),
                    enabled: true,
                    url: Some("http://192.168.2.13:8787/rendezvous".into()),
                },
                ServiceEntry {
                    name: "relay".into(),
                    enabled: true,
                    url: Some("http://192.168.2.13:3340".into()),
                },
            ]
        );
        // 各条目实际监听端口：relay 不复用 Host 端口
        assert!(m.services[1].url.as_deref().unwrap().ends_with(":3340"));
    }

    #[test]
    fn host_rejection_falls_back_to_first_non_loopback_ipv4() {
        let info = ServiceInfo {
            fallback_ipv4: Some("10.0.0.7".parse().unwrap()),
            ..info_no_fallback()
        };
        let (m, w) = build_manifest(&info, "http", Some("0.0.0.0:8787"));
        assert_eq!(w, Vec::<String>::new());
        assert_eq!(m.gateway.as_deref(), Some("http://10.0.0.7:8787"));
        assert_eq!(
            m.services[0].url.as_deref(),
            Some("http://10.0.0.7:8787/rendezvous")
        );
        assert_eq!(m.services[1].url.as_deref(), Some("http://10.0.0.7:3340"));
    }

    #[test]
    fn no_host_header_uses_fallback() {
        // HTTP/1.0 无 Host 头：同样走回退
        let (m, w) = build_manifest(&info_full(), "http", None);
        assert_eq!(w, Vec::<String>::new());
        assert_eq!(m.gateway.as_deref(), Some("http://192.168.2.13:8787"));
    }

    #[test]
    fn no_fallback_yields_null_urls_with_exact_warning() {
        let (m, w) = build_manifest(&info_no_fallback(), "http", Some("0.0.0.0:8787"));
        assert!(m.gateway.is_none());
        assert!(m.services.iter().all(|s| s.url.is_none()));
        // enabled 照实
        assert!(m.services.iter().all(|s| s.enabled));
        assert_eq!(w, vec![NO_FALLBACK_WARNING.to_string()]);
        assert_eq!(
            w,
            vec!["no non-loopback IPv4 available; URLs are null".to_string()]
        );
    }

    #[test]
    fn relay_disabled_entry() {
        let (m, w) = build_manifest(&info_no_relay(), "http", Some("192.168.2.13:8787"));
        let relay = &m.services[1];
        assert_eq!(relay.name, "relay");
        assert!(!relay.enabled);
        assert!(relay.url.is_none());
        assert_eq!(w, Vec::<String>::new());
    }

    #[test]
    fn forwarded_proto_trust_boundary() {
        // 未采信：scheme 恒为 http
        let (m, _) = build_manifest(&info_full(), "http", Some("192.168.2.13:8787"));
        assert!(m.gateway.as_deref().unwrap().starts_with("http://"));

        // scheme 注入 https（采信路径）
        let (m2, _) = build_manifest(&info_full(), "https", Some("192.168.2.13:8787"));
        assert!(m2.gateway.as_deref().unwrap().starts_with("https://"));
    }

    #[tokio::test]
    async fn forwarded_proto_header_only_trusted_via_flag() {
        let trusted = router(Arc::new(ServiceInfo {
            trust_proxy: true,
            ..info_full()
        }));
        let res = trusted
            .oneshot(
                Request::get("/services.json")
                    .header("host", "192.168.2.13:8787")
                    .header("x-forwarded-proto", "https")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["gateway"], "https://192.168.2.13:8787");

        // 同一头，未设置 DWEB_TRUST_PROXY=1（trust_proxy=false）时不采信
        let untrusted = router(Arc::new(info_full()));
        let res = untrusted
            .oneshot(
                Request::get("/services.json")
                    .header("host", "192.168.2.13:8787")
                    .header("x-forwarded-proto", "https")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["gateway"], "http://192.168.2.13:8787");
    }

    #[tokio::test]
    async fn services_json_headers_and_ipv6_host() {
        let res = router(Arc::new(info_full()))
            .oneshot(
                Request::get("/services.json")
                    .header("host", "[fd00::1]:8787")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), axum::http::StatusCode::OK);
        assert_eq!(
            res.headers().get("content-type").unwrap(),
            "application/json"
        );
        assert_eq!(res.headers().get("cache-control").unwrap(), "no-store");
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["gateway"], "http://[fd00::1]:8787");
        assert_eq!(v["services"][0]["url"], "http://[fd00::1]:8787/rendezvous");
        assert_eq!(v["services"][1]["url"], "http://[fd00::1]:3340");
    }

    #[tokio::test]
    async fn root_summary_is_ascii_text_plain() {
        let res = router(Arc::new(info_full()))
            .oneshot(
                Request::get("/")
                    .header("host", "192.168.2.13:8787")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), axum::http::StatusCode::OK);
        assert!(
            res.headers()
                .get("content-type")
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("text/plain")
        );
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let text = std::str::from_utf8(&body).unwrap();
        assert!(text.bytes().all(|b| b < 128), "summary must be ASCII");
        assert!(text.contains("opendweb server"));
        assert!(text.contains("gateway: http://192.168.2.13:8787"));
        assert!(text.contains("http://192.168.2.13:3340"));
        assert!(text.contains("http://192.168.2.13:8787/services.json"));
    }

    #[test]
    fn relay_non_http_scheme_disables_entry_with_warning() {
        let (m, w) = build_manifest(&info_full(), "ftp", Some("192.168.2.13:8787"));
        let relay = &m.services[1];
        assert!(!relay.enabled);
        assert!(relay.url.is_none());
        assert!(
            w.iter()
                .any(|x| x.starts_with("relay url scheme must be http or https"))
        );
    }

    #[test]
    fn unknown_service_silent_duplicate_first_wins() {
        let raw = vec![
            ServiceEntry {
                name: "relay".into(),
                enabled: true,
                url: Some("http://192.168.2.13:3340".into()),
            },
            ServiceEntry {
                name: "relay".into(),
                enabled: true,
                url: Some("http://192.168.2.13:9999".into()),
            },
            ServiceEntry {
                name: "future-service".into(),
                enabled: true,
                url: Some("http://192.168.2.13:9998".into()),
            },
        ];
        let mut warnings = Vec::new();
        let filtered = filter_known_dedup(raw, &mut warnings);
        // 重复名取首个
        assert_eq!(
            filtered,
            vec![ServiceEntry {
                name: "relay".into(),
                enabled: true,
                url: Some("http://192.168.2.13:3340".into()),
            }]
        );
        // 恰一条 WARNING，未知名静默
        assert_eq!(warnings, vec!["duplicate service name: relay".to_string()]);
    }

    #[test]
    fn fixtures_all_cases_snapshot() {
        let fx = fixtures();
        let find = |name: &str| fx.cases.iter().find(|c| c.name == name).unwrap();

        // canonical：全启用形态
        let (m, w) = build_manifest(&info_full(), "http", Some("192.168.2.13:8787"));
        assert_eq!(w, Vec::<String>::new());
        assert_matches_fixture(&m, find("canonical"));

        // relay-disabled：--no-relay
        let (m, w) = build_manifest(&info_no_relay(), "http", Some("192.168.2.13:8787"));
        assert_eq!(w, Vec::<String>::new());
        assert_matches_fixture(&m, find("relay-disabled"));

        // nullable-url：Host 拒绝 + 无回退 -> 全 null + 精确 WARNING
        let case = find("nullable-url");
        let (m, w) = build_manifest(&info_no_fallback(), "http", Some("0.0.0.0:8787"));
        assert_matches_fixture(&m, case);
        assert_eq!(
            w,
            case.expected_server_warnings
                .clone()
                .expect("nullable case has server warnings")
        );

        // unknown-and-duplicate：以 fixture services 为构造输入，过滤后仅首个 relay，
        // WARNING 恰好一条且与 expectedServerWarnings 一致
        let case = find("unknown-and-duplicate");
        let raw: Vec<ServiceEntry> =
            serde_json::from_value(case.manifest["services"].clone()).unwrap();
        let mut warnings = Vec::new();
        let filtered = filter_known_dedup(raw, &mut warnings);
        assert_eq!(
            filtered,
            vec![ServiceEntry {
                name: "relay".into(),
                enabled: true,
                url: Some("http://192.168.2.13:3340".into()),
            }]
        );
        assert_eq!(
            warnings,
            case.expected_server_warnings
                .clone()
                .expect("dup case has server warnings")
        );

        // public-urls：双覆盖，Host 派生完全跳过
        let (m, w) = build_manifest(
            &ServiceInfo {
                public_gateway_url: Some("https://gw.example.com".into()),
                public_relay_url: Some("https://relay.example.com".into()),
                ..info_full()
            },
            "http",
            Some("192.168.2.13:8787"),
        );
        assert_eq!(w, Vec::<String>::new());
        assert_matches_fixture(&m, find("public-urls"));

        // public-gateway-only：仅 gateway 覆盖，relay 继续本地派生
        let (m, w) = build_manifest(
            &ServiceInfo {
                public_gateway_url: Some("https://dweb.example.com".into()),
                ..info_full()
            },
            "http",
            Some("192.168.2.13:8787"),
        );
        assert_eq!(w, Vec::<String>::new());
        assert_matches_fixture(&m, find("public-gateway-only"));

        // public-relay-only：仅 relay 覆盖，gateway/rendezvous 继续本地派生
        let (m, w) = build_manifest(
            &ServiceInfo {
                public_relay_url: Some("https://relay.dweb.example.com".into()),
                ..info_full()
            },
            "http",
            Some("192.168.2.13:8787"),
        );
        assert_eq!(w, Vec::<String>::new());
        assert_matches_fixture(&m, find("public-relay-only"));

        // public-urls-no-fallback：Host 拒绝 + 无回退 + 双覆盖 -> 零 WARNING、URL 全可用
        let (m, w) = build_manifest(
            &ServiceInfo {
                public_gateway_url: Some("https://gw.example.com".into()),
                public_relay_url: Some("https://relay.example.com".into()),
                ..info_no_fallback()
            },
            "http",
            Some("0.0.0.0:8787"),
        );
        assert_eq!(w, Vec::<String>::new());
        assert_matches_fixture(&m, find("public-urls-no-fallback"));
    }

    #[test]
    fn public_relay_override_ignored_when_relay_disabled() {
        // relay 禁用是更强的用户意图：覆盖被忽略且无告警（D3）
        let info = ServiceInfo {
            public_relay_url: Some("https://relay.example.com".into()),
            ..info_no_relay()
        };
        let (m, w) = build_manifest(&info, "http", Some("192.168.2.13:8787"));
        let relay = &m.services[1];
        assert!(!relay.enabled);
        assert!(relay.url.is_none());
        assert_eq!(w, Vec::<String>::new());
    }

    #[test]
    fn public_relay_override_defensive_scheme_guard() {
        // 绕过启动校验直接构造的非法 scheme（防御性兜底）：按禁用处理 + WARNING
        let info = ServiceInfo {
            public_relay_url: Some("ftp://relay.example.com".into()),
            ..info_full()
        };
        let (m, w) = build_manifest(&info, "http", Some("192.168.2.13:8787"));
        let relay = &m.services[1];
        assert!(!relay.enabled);
        assert!(relay.url.is_none());
        assert!(
            w.iter()
                .any(|x| x.starts_with("relay url scheme must be http or https"))
        );
    }

    #[test]
    fn public_gateway_override_with_derived_relay_needs_host() {
        // gateway 覆盖 + relay 派生：Host 校验仍执行（relay 依赖它），且互不污染
        let info = ServiceInfo {
            public_gateway_url: Some("https://dweb.example.com".into()),
            ..info_no_fallback()
        };
        let (m, w) = build_manifest(&info, "http", Some("0.0.0.0:8787"));
        assert_eq!(m.gateway.as_deref(), Some("https://dweb.example.com"));
        // relay 派生失败：无回退 -> WARNING + url null（enabled 照实）
        assert_eq!(m.services[1].enabled, true);
        assert_eq!(m.services[1].url, None);
        assert_eq!(w, vec![NO_FALLBACK_WARNING.to_string()]);
    }

    #[test]
    fn fallback_probe_returns_non_loopback_v4_when_available() {
        if let Some(ip) = primary_non_loopback_ipv4() {
            assert!(!ip.is_loopback());
        }
    }

    #[test]
    fn ascii_escape_dynamic_values() {
        assert_eq!(ascii_escape("ab"), "ab");
        assert_eq!(ascii_escape("a b"), "a b");
        assert_eq!(ascii_escape("a\nb"), "a\\x0ab");
        assert_eq!(ascii_escape("\x7f"), "\\x7f");
        // UTF-8 字节小写十六进制
        assert_eq!(ascii_escape("\u{4e2d}"), "\\xe4\\xb8\\xad");
    }

    #[test]
    fn summary_escapes_non_ascii_host() {
        // 非 ASCII host 放行（不在拒绝集合），但摘要输出必须转义为纯 ASCII
        let (m, _) = build_manifest(&info_full(), "http", Some("h\u{4e2d}st:8787"));
        let text = summary_text(&m);
        assert!(text.bytes().all(|b| b < 128), "summary must be ASCII");
        assert!(text.contains("gateway: http://h\\xe4\\xb8\\xadst:8787"));
    }
}
