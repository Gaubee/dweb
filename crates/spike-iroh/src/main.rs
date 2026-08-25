//! spike-iroh：验证 iroh 1.1.0 真实 API 与行为（一次性 spike 代码，不追求生产质量）。
//!
//! 正交意图（原始需求 2026-08-26，主会话 iroh spike 任务）：
//! 1. 基础互连：Endpoint 构建/connect/accept/open_bi/accept_bi 收发消息（selftest / listen / connect）
//! 2. 发现机制：无发现时失败、手动注入 IP 直连、n0 DNS address lookup（selftest / connect / n0-selftest）
//! 3. 路径观测：Connection::paths() / path_events() 判定 direct vs relay（内嵌于各测试）
//! 4. 自建 relay：iroh-relay Server + RelayMode::Custom 仅经 relay 互连（relay / relay-selftest）
//! 5. SecretKey 持久化：to_bytes/from_bytes 恢复同 EndpointId（keygen / selftest 内嵌）
//! 6. 接受侧信息：remote_id()/alpn()/closed()（内嵌于各测试）
//! 7. 并发与生命周期：close()、多 peer 并发 connect + accept 循环（selftest / listen）
//!
//! 注意：iroh 1.1.0 相比 0.x 的重大改名——NodeId→EndpointId、discovery→address_lookup、
//! Endpoint::builder() 必须传 preset、Connection 自带（不再透传 quinn）。

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use iroh::endpoint::{Connection, presets};
use iroh::{
    Endpoint, EndpointAddr, EndpointId, RelayMode, RelayUrl, SecretKey, TransportAddr,
};
use n0_future::StreamExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const ALPN: &[u8] = b"spike/1";
const MSG_LIMIT: usize = 64 * 1024;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let mut args = std::env::args().skip(1);
    let Some(cmd) = args.next() else {
        eprintln!(
            "用法:\n\
             \x20 spike-iroh selftest                 同进程全流程（基础互连/路径/密钥/关闭/多peer/无发现失败）\n\
             \x20 spike-iroh listen [--relay URL] [--n0]   echo 服务，打印 EndpointId 与地址\n\
             \x20 spike-iroh connect <z32id> [--addr IP:PORT]... [--relay URL] [--n0] [--msg X]\n\
             \x20 spike-iroh relay [--port 3340]       自建 iroh-relay 服务端（http，无 TLS）\n\
             \x20 spike-iroh relay-selftest            同进程：自建 relay + 两端仅经 relay 互连\n\
             \x20 spike-iroh n0-selftest               同进程：两端 N0 preset，仅凭 EndpointId 互连（需外网）\n\
             \x20 spike-iroh keygen                    生成 SecretKey 并验证 32B 恢复同 EndpointId"
        );
        bail!("缺少子命令");
    };
    let rest: Vec<String> = args.collect();
    match cmd.as_str() {
        "selftest" => cmd_selftest().await,
        "listen" => cmd_listen(&rest).await,
        "connect" => cmd_connect(&rest).await,
        "relay" => cmd_relay(&rest).await,
        "relay-selftest" => cmd_relay_selftest().await,
        "n0-selftest" => cmd_n0_selftest().await,
        "keygen" => cmd_keygen().await,
        other => bail!("未知子命令: {other}"),
    }
}

// ---------- 参数解析（极简手写，避免引 clap） ----------

struct CommonArgs {
    addrs: Vec<SocketAddr>,
    relay: Option<RelayUrl>,
    n0: bool,
    msg: String,
    port: u16,
}

fn parse_common(rest: &[String]) -> Result<CommonArgs> {
    let mut out = CommonArgs {
        addrs: vec![],
        relay: None,
        n0: false,
        msg: "ping-from-spike".into(),
        port: 3340,
    };
    let mut it = rest.iter();
    while let Some(flag) = it.next() {
        match flag.as_str() {
            "--addr" => {
                let v = it.next().context("--addr 需要 IP:PORT")?;
                out.addrs.push(v.parse().with_context(|| format!("解析 {v}"))?);
            }
            "--relay" => {
                let v = it.next().context("--relay 需要 URL")?;
                out.relay = Some(v.parse().with_context(|| format!("解析 RelayUrl {v}"))?);
            }
            "--n0" => out.n0 = true,
            "--msg" => {
                out.msg = it.next().context("--msg 需要内容")?.clone();
            }
            "--port" => {
                out.port = it
                    .next()
                    .context("--port 需要数值")?
                    .parse()
                    .context("端口号")?;
            }
            other => bail!("未知参数 {other}"),
        }
    }
    Ok(out)
}

// ---------- Endpoint 构造 ----------

/// 按需构造 Endpoint。
/// - n0=true：presets::N0（n0 DNS pkarr 发布/解析 + n0 官方 relay + ring 加密）
/// - n0=false：presets::Minimal（仅 ring 加密；无 relay、无 address lookup——需显式配置）
/// - relay=Some：叠加 RelayMode::Custom（自建 relay）
/// - relay=None 且 !n0：RelayMode::Disabled
async fn build_endpoint(n0: bool, relay: Option<RelayUrl>, server_alpns: bool) -> Result<Endpoint> {
    let mut b = if n0 {
        Endpoint::builder(presets::N0)
    } else {
        Endpoint::builder(presets::Minimal)
    };
    if server_alpns {
        b = b.alpns(vec![ALPN.to_vec()]);
    }
    b = match relay {
        Some(url) => b.relay_mode(RelayMode::custom([url])),
        None if !n0 => b.relay_mode(RelayMode::Disabled),
        None => b, // N0 preset 已含默认 relay
    };
    let ep = b.bind().await.context("endpoint bind")?;
    Ok(ep)
}

// ---------- 打印辅助 ----------

fn print_endpoint_info(tag: &str, ep: &Endpoint) {
    let addr = ep.addr();
    println!("[{tag}] EndpointId(z32) = {}", ep.id().to_z32());
    println!("[{tag}] bound_sockets  = {:?}", ep.bound_sockets());
    for a in &addr.addrs {
        println!("[{tag}] addr entry     = {a}");
    }
    if addr.is_empty() {
        println!("[{tag}] (EndpointAddr 无任何网络地址)");
    }
}

/// 打印一条 connection 当前的路径快照（direct=Ip / relay=Relay）。
fn print_paths_snapshot(tag: &str, conn: &Connection) {
    let paths = conn.paths();
    if paths.is_empty() {
        println!("[{tag}] paths: <空>");
    }
    for p in paths.iter() {
        println!(
            "[{tag}] path id={:?} selected={} remote={} local={:?}",
            p.id(),
            p.is_selected(),
            p.remote_addr(),
            p.local_addr()
        );
    }
}

/// 后台消费 path_events()，打印事件直到流结束。返回可 abort 的句柄。
fn spawn_path_event_logger(tag: &'static str, conn: &Connection) -> tokio::task::JoinHandle<()> {
    let mut events = conn.path_events();
    tokio::spawn(async move {
        while let Some(ev) = events.next().await {
            match ev {
                iroh::endpoint::PathEvent::Opened { id, remote_addr, .. } => {
                    println!("[{tag}-event] Opened   id={id:?} remote={remote_addr}")
                }
                iroh::endpoint::PathEvent::Selected { id, remote_addr, .. } => {
                    println!("[{tag}-event] Selected id={id:?} remote={remote_addr}");
                }
                iroh::endpoint::PathEvent::Closed { id, remote_addr, .. } => {
                    println!("[{tag}-event] Closed   id={id:?} remote={remote_addr}");
                }
                iroh::endpoint::PathEvent::Lagged { missed, .. } => {
                    println!("[{tag}-event] Lagged    missed={missed}");
                }
                _ => println!("[{tag}-event] (未知事件变体)"),
            }
        }
        println!("[{tag}-event] 流结束（连接已关闭）");
    })
}

// ---------- 连接处理：echo 服务器端 ----------

/// accept 一条连接后的处理循环：accept_bi -> 读 -> 回写 -> finish；期间观测路径与对端信息。
async fn handle_echo_conn(conn: Connection) -> Result<()> {
    let remote = conn.remote_id();
    println!(
        "[server] accepted: remote_id={} alpn={}",
        remote.to_z32(),
        String::from_utf8_lossy(conn.alpn())
    );
    let ev_logger = spawn_path_event_logger("server", &conn);
    let closed = std::pin::pin!(conn.closed());
    let mut closed = closed;
    loop {
        tokio::select! {
            biased;
            err = &mut closed => {
                // closed() 返回 ConnectionError（连接以错误终止；正常 close 也是其中一种 variant）
                println!("[server] 连接关闭感知: closed() = {err:#}");
                break;
            }
            bi = conn.accept_bi() => {
                let (mut send, mut recv) = bi.context("accept_bi")?;
                let msg = recv.read_to_end(MSG_LIMIT).await.context("read_to_end")?;
                println!("[server] 收到 {} 字节: {:?}", msg.len(), String::from_utf8_lossy(&msg));
                send.write_all(&msg).await.context("write_all")?;
                send.finish().context("finish")?;
                print_paths_snapshot("server", &conn);
            }
        }
    }
    ev_logger.await.ok();
    Ok(())
}

/// accept 循环（listen 模式用）。返回 accept() 返回 None 的原因日志。
async fn accept_loop(ep: Endpoint) -> Result<()> {
    loop {
        let incoming = tokio::select! {
            inc = ep.accept() => match inc {
                Some(inc) => inc,
                None => {
                    println!("[server] accept() 返回 None（endpoint 已 close）——退出循环");
                    break;
                }
            },
            _ = tokio::signal::ctrl_c() => {
                println!("[server] Ctrl-C，调用 endpoint.close()");
                ep.close().await;
                break;
            }
        };
        // incoming.accept() 同步返回 Result<Accepting>，再 await 得 Connection
        let accepting = match incoming.accept() {
            Ok(a) => a,
            Err(err) => {
                println!("[server] incoming.accept() 失败（常见于噪声包）: {err:#}");
                continue;
            }
        };
        match accepting.await {
            Ok(conn) => {
                tokio::spawn(handle_echo_conn(conn));
            }
            Err(err) => println!("[server] 握手失败: {err:#}"),
        }
    }
    Ok(())
}

// ---------- 子命令：keygen（验证项5：SecretKey 持久化） ----------

async fn cmd_keygen() -> Result<()> {
    let sk = SecretKey::generate();
    let bytes = sk.to_bytes(); // [u8; 32] seed
    let restored = SecretKey::from_bytes(&bytes); // 无 Result，直接恢复
    let id1 = sk.public();
    let id2 = restored.public();
    println!("secret_key(hex)   = {}", hex(&bytes));
    println!("endpoint_id(z32)  = {}", id1.to_z32());
    println!("恢复后 id 一致    = {}", id1 == id2);
    // from_z32 反向解析
    let parsed = EndpointId::from_z32(&id1.to_z32()).context("from_z32")?;
    println!("from_z32 解析一致 = {}", parsed == id1);
    anyhow::ensure!(id1 == id2 && parsed == id1, "密钥恢复失败");
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------- 子命令：relay（验证项4：自建 relay 服务端） ----------

async fn cmd_relay(rest: &[String]) -> Result<()> {
    let args = parse_common(rest)?;
    let bind = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), args.port);
    // iroh-relay 1.1.0 服务端：ServerConfig{relay,quic,metrics_addr}（#[non_exhaustive]，default 后逐字段赋值）
    let mut relay_config = iroh_relay::server::RelayConfig::new(bind);
    relay_config.tls = None; // 无 TLS：客户端用 http:// URL（内部映射 ws://）
    let mut config = iroh_relay::server::ServerConfig::default();
    config.relay = Some(relay_config);
    let server = iroh_relay::server::Server::spawn(config)
        .await
        .context("relay Server::spawn")?;
    let http_addr = server.http_addr().context("http_addr")?;
    // 1.1.0 无 http_url()（只有 https_url），无 TLS 时手工拼 http:// url
    let url: RelayUrl = format!("http://{http_addr}").parse().context("relay url")?;
    println!("relay http_addr = {http_addr}");
    println!("relay url       = {url}");
    println!("健康检查: curl http://{http_addr}/healthz");

    // 内部做一次 GET /healthz 验证（不引 HTTP 客户端依赖，手写 HTTP/1.1）
    let mut stream = tokio::net::TcpStream::connect(http_addr).await.context("连接 relay")?;
    stream
        .write_all(format!("GET /healthz HTTP/1.1\r\nHost: {http_addr}\r\nConnection: close\r\n\r\n").as_bytes())
        .await?;
    let mut body = String::new();
    stream.read_to_string(&mut body).await.ok();
    let status_line = body.lines().next().unwrap_or("");
    let payload = body.split("\r\n\r\n").nth(1).unwrap_or("");
    println!("GET /healthz -> {status_line} body={payload}");
    anyhow::ensure!(status_line.contains("200"), "healthz 非 200: {status_line}");

    println!("relay 运行中，Ctrl-C 退出");
    tokio::signal::ctrl_c().await?;
    server.shutdown().await.context("relay shutdown")?;
    println!("relay 已退出");
    Ok(())
}

// ---------- 子命令：relay-selftest（验证项4：仅经自建 relay 互连） ----------

async fn cmd_relay_selftest() -> Result<()> {
    // 1. 自建 relay（同进程）
    let bind = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0);
    let mut relay_config = iroh_relay::server::RelayConfig::new(bind);
    relay_config.tls = None;
    let mut config = iroh_relay::server::ServerConfig::default();
    config.relay = Some(relay_config);
    let relay_server = iroh_relay::server::Server::spawn(config)
        .await
        .context("relay Server::spawn")?;
    let relay_url: RelayUrl = format!("http://{}", relay_server.http_addr().unwrap())
        .parse()
        .context("relay url")?;
    println!("[relay-selftest] 自建 relay url = {relay_url}");

    // 2. 两端都只用该 relay（Minimal + RelayMode::custom，无 address lookup、无 n0）
    let server_ep = build_endpoint(false, Some(relay_url.clone()), true).await?;
    let client_ep = build_endpoint(false, Some(relay_url.clone()), false).await?;
    print_endpoint_info("server", &server_ep);

    // 等 server 端连上 home relay，EndpointAddr 里才有 relay url
    server_ep.online().await;
    println!("[relay-selftest] server online，addr.addrs = {:?}", server_ep.addr().addrs);

    let server_task = tokio::spawn(accept_loop(server_ep.clone()));

    // 3. 客户端只给 EndpointId + RelayUrl，不给任何 IP——只能走 relay
    let target = EndpointAddr::new(server_ep.id()).with_relay_url(relay_url.clone());
    let t0 = std::time::Instant::now();
    let conn = tokio::time::timeout(Duration::from_secs(30), client_ep.connect(target, ALPN))
        .await
        .context("connect 超时")?
        .context("connect")?;
    println!("[relay-selftest] connect 成功，耗时 {:?}", t0.elapsed());
    println!("[relay-selftest] 对端 remote_id = {}", conn.remote_id().to_z32());

    let ev_logger = spawn_path_event_logger("client", &conn);
    let (mut send, mut recv) = conn.open_bi().await.context("open_bi")?;
    send.write_all(b"relay-only-ping").await?;
    send.finish()?;
    let reply = recv.read_to_end(MSG_LIMIT).await.context("read_to_end")?;
    println!("[relay-selftest] echo 回复: {:?}", String::from_utf8_lossy(&reply));

    // 观察 3 秒路径演化（relay 上建立后，若直连可行会迁移到 direct）
    for i in 0..3 {
        tokio::time::sleep(Duration::from_secs(1)).await;
        println!("[relay-selftest] t={}s 路径快照:", i + 1);
        print_paths_snapshot("client", &conn);
    }
    ev_logger.abort();

    conn.close(0u32.into(), b"done");
    client_ep.close().await;
    server_ep.close().await;
    relay_server.shutdown().await.ok();
    server_task.abort();
    Ok(())
}

// ---------- 子命令：n0-selftest（验证项2：n0 DNS address lookup 发现） ----------

async fn cmd_n0_selftest() -> Result<()> {
    // 两端都 N0 preset：server 侧自动发布 pkarr/DNS，client 侧自动解析
    let server_ep = build_endpoint(true, None, true).await?;
    let client_ep = build_endpoint(true, None, false).await?;
    println!("[n0] server id = {}", server_ep.id().to_z32());

    // 等待 home relay 连接 + 给 pkarr 发布留时间
    server_ep.online().await;
    println!("[n0] server online，等待 6s 让 pkarr 发布生效...");
    tokio::time::sleep(Duration::from_secs(6)).await;
    println!("[n0] server addr.addrs = {:?}", server_ep.addr().addrs);

    let server_task = tokio::spawn(accept_loop(server_ep.clone()));

    // 仅凭 EndpointId 连接（EndpointAddr::new(id)，空 addrs -> 触发 address lookup）
    let target = EndpointAddr::new(server_ep.id());
    let t0 = std::time::Instant::now();
    let conn = match tokio::time::timeout(Duration::from_secs(40), client_ep.connect(target, ALPN)).await {
        Ok(Ok(conn)) => conn,
        Ok(Err(err)) => {
            println!("[n0] 仅凭 EndpointId connect 失败（外网不可达或未发布成功）: {err:#}");
            server_ep.close().await;
            client_ep.close().await;
            server_task.abort();
            return Ok(());
        }
        Err(_) => bail!("[n0] connect 40s 超时"),
    };
    println!("[n0] 仅凭 EndpointId connect 成功，耗时 {:?}", t0.elapsed());
    let (mut send, mut recv) = conn.open_bi().await?;
    send.write_all(b"n0-discovery-ping").await?;
    send.finish()?;
    let reply = recv.read_to_end(MSG_LIMIT).await?;
    println!("[n0] echo 回复: {:?}", String::from_utf8_lossy(&reply));
    print_paths_snapshot("n0-client", &conn);

    conn.close(0u32.into(), b"done");
    client_ep.close().await;
    server_ep.close().await;
    server_task.abort();
    Ok(())
}

// ---------- 子命令：listen / connect（跨进程验证） ----------

async fn cmd_listen(rest: &[String]) -> Result<()> {
    let args = parse_common(rest)?;
    let ep = build_endpoint(args.n0, args.relay.clone(), true).await?;
    print_endpoint_info("listen", &ep);
    if let Some(relay) = &args.relay {
        println!("[listen] 使用自建 relay = {relay}");
    }
    if args.n0 {
        ep.online().await;
        println!("[listen] n0 online，addrs = {:?}", ep.addr().addrs);
    }
    // 从 bound_sockets 推导 127.0.0.1 直连候选地址
    if let Some(sock) = ep.bound_sockets().first() {
        println!(
            "[listen] 本机直连候选: --addr 127.0.0.1:{}",
            sock.port()
        );
    }
    accept_loop(ep).await
}

async fn cmd_connect(rest: &[String]) -> Result<()> {
    let mut it = rest.iter();
    let Some(id_str) = it.next() else {
        bail!("用法: connect <z32id> [--addr IP:PORT]... [--relay URL] [--n0] [--msg X]");
    };
    let rest_tail: Vec<String> = it.cloned().collect();
    let args = parse_common(&rest_tail)?;

    let id = EndpointId::from_z32(id_str).with_context(|| format!("解析 EndpointId {id_str}"))?;
    let ep = build_endpoint(args.n0, args.relay.clone(), false).await?;
    print_endpoint_info("connect", &ep);

    // 手动构造 EndpointAddr（1.1.0 无 add_node_addr：地址直接进 connect 的 EndpointAddr）
    let mut target = EndpointAddr::new(id);
    for a in &args.addrs {
        target = target.with_ip_addr(*a);
    }
    if let Some(relay) = &args.relay {
        target = target.with_relay_url(relay.clone());
    }
    println!("[connect] target = id {} addrs {:?}", id.to_z32(), target.addrs);

    let t0 = std::time::Instant::now();
    let conn = tokio::time::timeout(Duration::from_secs(30), ep.connect(target, ALPN))
        .await
        .context("connect 超时（30s）")?
        .context("connect")?;
    println!("[connect] 成功，耗时 {:?}", t0.elapsed());
    println!("[connect] remote_id = {}", conn.remote_id().to_z32());

    let ev_logger = spawn_path_event_logger("client", &conn);
    let (mut send, mut recv) = conn.open_bi().await.context("open_bi")?;
    send.write_all(args.msg.as_bytes()).await?;
    send.finish()?;
    let reply = recv.read_to_end(MSG_LIMIT).await.context("read_to_end")?;
    println!("[connect] echo 回复: {:?}", String::from_utf8_lossy(&reply));

    tokio::time::sleep(Duration::from_secs(2)).await;
    print_paths_snapshot("client", &conn);
    ev_logger.abort();

    conn.close(0u32.into(), b"done");
    ep.close().await;
    Ok(())
}

// ---------- 子命令：selftest（验证项 1/2/3/5/6/7 全流程，同进程） ----------

async fn cmd_selftest() -> Result<()> {
    println!("=== [1] SecretKey 持久化（验证项5） ===");
    let sk = SecretKey::generate();
    let bytes = sk.to_bytes();
    let restored = SecretKey::from_bytes(&bytes);
    assert_eq!(sk.public(), restored.public(), "32B seed 必须恢复同 EndpointId");
    println!("OK: to_bytes/from_bytes 恢复同 id = {}", sk.public().to_z32());

    println!("=== [2] 基础互连：同进程两 Endpoint（验证项1） ===");
    // server：持久化密钥恢复 + Minimal（无 relay、无发现）+ alpns
    let server_ep = Endpoint::builder(presets::Minimal)
        .secret_key(restored) // 用恢复的密钥构建，验证 Builder::secret_key
        .alpns(vec![ALPN.to_vec()])
        .relay_mode(RelayMode::Disabled)
        .bind()
        .await?;
    assert_eq!(server_ep.id(), sk.public(), "Builder::secret_key 决定 EndpointId");
    // client：无需 alpns（仅发起侧）
    let client_ep = Endpoint::builder(presets::Minimal)
        .relay_mode(RelayMode::Disabled)
        .bind()
        .await?;
    print_endpoint_info("server", &server_ep);
    print_endpoint_info("client", &client_ep);
    let server_task = tokio::spawn(accept_loop(server_ep.clone()));

    // 手动注入直连地址（发现机制的"手动"路径）：127.0.0.1 + bound port
    let port = server_ep.bound_sockets()[0].port();
    let target = EndpointAddr::new(server_ep.id()).with_ip_addr(SocketAddr::new(
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        port,
    ));
    let t0 = std::time::Instant::now();
    let conn = client_ep.connect(target, ALPN).await.context("connect")?;
    println!("OK: connect 耗时 {:?}", t0.elapsed());

    // 验证项6：接受侧拿对端身份
    println!("=== [3] 接受侧信息 remote_id/alpn（验证项6） ===");
    println!("client 视角 remote_id = {}", conn.remote_id().to_z32());
    println!("client 视角 alpn      = {}", String::from_utf8_lossy(conn.alpn()));

    // open_bi / accept_bi 回声
    let ev_logger = spawn_path_event_logger("client", &conn);
    let (mut send, mut recv) = conn.open_bi().await.context("open_bi")?;
    send.write_all(b"hello-iroh").await?;
    send.finish()?;
    let reply = recv.read_to_end(MSG_LIMIT).await.context("read_to_end")?;
    assert_eq!(reply, b"hello-iroh");
    println!("OK: open_bi -> write_all -> finish -> read_to_end 回声 = {:?}", String::from_utf8_lossy(&reply));

    println!("=== [4] 路径观测（验证项3） ===");
    tokio::time::sleep(Duration::from_secs(1)).await;
    print_paths_snapshot("client", &conn);

    println!("=== [5] closed() 关闭感知（验证项6） ===");
    // server 侧在 handle_echo_conn 内 select 了 closed()；这里主动关连接，观察其打印
    conn.close(0u32.into(), b"selftest-done");
    tokio::time::sleep(Duration::from_millis(500)).await;
    println!("OK: 已调用 Connection::close，server 侧 closed() 应已打印");
    ev_logger.abort();

    println!("=== [6] 多 peer 并发（验证项7） ===");
    let mut peers = vec![];
    for _ in 0..3 {
        let ep = Endpoint::builder(presets::Minimal)
            .relay_mode(RelayMode::Disabled)
            .bind()
            .await?;
        peers.push(ep);
    }
    let handles: Vec<_> = peers
        .iter()
        .enumerate()
        .map(|(i, ep)| {
            let ep = ep.clone();
            let target = EndpointAddr::new(server_ep.id())
                .with_ip_addr(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port));
            let msg = format!("peer-{i}");
            tokio::spawn(async move {
                let conn = tokio::time::timeout(Duration::from_secs(20), ep.connect(target, ALPN))
                    .await
                    .context("connect 超时")??;
                let (mut send, mut recv) = conn.open_bi().await?;
                send.write_all(msg.as_bytes()).await?;
                send.finish()?;
                let reply = recv.read_to_end(MSG_LIMIT).await?;
                assert_eq!(reply, msg.as_bytes());
                Ok::<_, anyhow::Error>(conn.remote_id().to_z32())
            })
        })
        .collect();
    for (i, h) in handles.into_iter().enumerate() {
        let id = h.await.context("join err")?.context(format!("peer-{i} 失败"))?;
        println!("OK: peer-{i} 并发回声成功，对端 {id}");
    }
    for ep in &peers {
        ep.close().await;
    }

    println!("=== [7] 无任何发现时 connect 行为（验证项2） ===");
    let ghost = SecretKey::generate().public(); // 从未发布过任何地址
    let t0 = std::time::Instant::now();
    let r = tokio::time::timeout(
        Duration::from_secs(35),
        client_ep.connect(EndpointAddr::new(ghost), ALPN),
    )
    .await;
    match r {
        Err(_) => println!("结论: 空地址 connect 在 35s 内未返回（被外层 timeout 截断），耗时 {:?}", t0.elapsed()),
        Ok(Err(err)) => println!("结论: 空地址 connect 按预期失败，耗时 {:?}，错误: {err:#}", t0.elapsed()),
        Ok(Ok(_)) => println!("异常: 竟然连上了（不可能，除非有全局发现）"),
    }

    println!("=== [8] Endpoint 生命周期 close()（验证项7） ===");
    server_ep.close().await;
    println!("server_ep.is_closed() = {}", server_ep.is_closed());
    // close 后 accept() 返回 None、connect 报错
    match tokio::time::timeout(Duration::from_secs(5), server_ep.accept()).await {
        Ok(None) => println!("OK: close 后 accept() -> None"),
        Ok(Some(_)) => bail!("close 后 accept() 仍返回连接"),
        Err(_) => bail!("close 后 accept() 未返回 None"),
    }
    let r = client_ep
        .connect(EndpointAddr::new(server_ep.id()), ALPN)
        .await;
    match r {
        Err(err) => println!("OK: 对已 close 的 endpoint connect 报错: {err:#}"),
        Ok(_) => bail!("close 后 connect 竟然成功"),
    }
    server_task.abort();
    println!("=== selftest 全部通过 ===");
    Ok(())
}

// （曾用逐个 await 的简易 join；多 peer 并发已改为 tokio::spawn 真并发。）

// TransportAddr 已在 iroh 根导出；此 use 仅为证明其可用性（selftest 未直接用）。
#[allow(dead_code)]
fn _transport_addr_reachable(t: &TransportAddr) -> bool {
    t.is_relay() || t.is_ip() || t.is_custom()
}
