//! join 分类总函数的集成测试（D11 八码 + 豁免三态 + 探针语义）。
//! 全部确定性构造（固定过去时间 / 注入端口 / 自连接立即错误 / holding listener），
//! 无墙钟等待依赖；relayed 路径不依赖外部网络。

use dweb_fabric::fabric::{JOIN_TIMEOUT_MS_DEFAULT, JOIN_TIMEOUT_MS_MIN};
use dweb_fabric::protocol::InviteToken;
use dweb_fabric::roster::Roster;
use dweb_fabric::{
    Fabric, FabricConfig, FabricError, HttpProxyConfig, JoinErrorCode, RelayConfig, RelayTlsTrust,
    SecretInjection,
};
use iroh::RelayMode;
use std::sync::Arc;
use tempfile::TempDir;

/// 探针覆盖是进程级全局：本文件所有用测试串行，避免默认探针/覆盖互相污染。
static TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn cfg(dir: &TempDir) -> FabricConfig {
    FabricConfig {
        data_dir: dir.path().to_owned(),
        relay: RelayConfig::Disabled,
        advertise_addrs: Vec::new(),
        secret: SecretInjection::Default,
        http_proxy: HttpProxyConfig::None,
        join_timeout_ms: JOIN_TIMEOUT_MS_DEFAULT,
        relay_tls_trust: RelayTlsTrust::PlatformRoot,
        bind_addr: None,
    }
}

fn cfg_with(dir: &TempDir, join_timeout_ms: u64) -> FabricConfig {
    FabricConfig {
        join_timeout_ms,
        ..cfg(dir)
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

/// 预留本地空闲端口（UDP 试探后释放）。
fn reserve_port() -> u16 {
    std::net::UdpSocket::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// 以指定身份+目录构造 root roster 并签发令牌（绕过 Fabric::invite 的 D3 门，
/// 测试关注 join 侧分类；issuer 可控以构造自连接/他连接场景）。
fn issue_token_as(
    identity: &dweb_fabric::identity::NodeIdentity,
    relay: &str,
    addrs: &[&str],
    ttl_ms: u64,
    now_ms: u64,
) -> (TempDir, FabricIdHex, String) {
    let dir = TempDir::new().unwrap();
    let (mut r, fid) = Roster::create(identity, dir.path(), now_ms).unwrap();
    issue_on_roster(&mut r, identity, relay, addrs, ttl_ms, now_ms, dir, fid)
}

#[allow(clippy::too_many_arguments)]
fn issue_on_roster(
    r: &mut Roster,
    identity: &dweb_fabric::identity::NodeIdentity,
    relay: &str,
    addrs: &[&str],
    ttl_ms: u64,
    now_ms: u64,
    dir: TempDir,
    fid: dweb_fabric::protocol::FabricId,
) -> (TempDir, FabricIdHex, String) {
    let token = r
        .issue_invite(
            identity,
            relay.to_owned(),
            addrs.iter().map(|s| s.to_string()).collect(),
            None,
            ttl_ms,
            now_ms,
        )
        .unwrap();
    let hex = hex::encode(fid.as_bytes());
    (dir, hex, token.encode().unwrap())
}

type FabricIdHex = String;

fn join_code(err: &FabricError) -> Option<JoinErrorCode> {
    match err {
        FabricError::Join { code, .. } => Some(*code),
        _ => None,
    }
}

/// 固定过去时间签发（expires_at_ms = ttl，远小于真实 now）。
fn expired_token(relay: &str, addrs: &[&str]) -> (TempDir, FabricIdHex, String) {
    let dir = TempDir::new().unwrap();
    let identity = dweb_fabric::identity::NodeIdentity::load_or_create(dir.path()).unwrap();
    let (mut r, fid) = Roster::create(&identity, dir.path(), 0).unwrap();
    issue_on_roster(&mut r, &identity, relay, addrs, 1_000, 0, dir, fid)
}

// ---- 6. NO_REACHABLE_PATH：拨号前零等待 ---------------------------------------

#[tokio::test]
async fn no_reachable_path_fails_before_dialing() {
    let _g = TEST_LOCK.lock().await;
    let dir_j = TempDir::new().unwrap();
    // 空 relay + 空直连令牌（经 roster 层签发，join 侧不关心签发门）
    let identity = dweb_fabric::identity::NodeIdentity::load_or_create(dir_j.path()).unwrap();
    let (_dir_t, fid_hex, token) = issue_token_as(&identity, "", &[], 60_000, now_ms());
    // join_timeout 取最小值 1000ms：若意外进入拨号将耗时 >= 1s
    let j = Fabric::attach(cfg_with(&dir_j, JOIN_TIMEOUT_MS_MIN), &fid_hex)
        .await
        .unwrap();
    let start = std::time::Instant::now();
    let err = j.join(&token).await.unwrap_err();
    let elapsed = start.elapsed();
    assert_eq!(
        join_code(&err),
        Some(JoinErrorCode::NoReachablePath),
        "{err:?}"
    );
    assert!(
        elapsed < std::time::Duration::from_millis(900),
        "must fail before dialing (zero wait), took {elapsed:?}"
    );
    assert!(
        err.to_string()
            .contains("no relay URL and no direct addresses")
    );
}

// ---- 2. TOKEN_EXPIRED：固定过去时间 ------------------------------------------

#[tokio::test]
async fn token_expired_fixed_past_time() {
    let _g = TEST_LOCK.lock().await;
    let (_dir_t, fid_hex, token) = expired_token("https://relay.example", &[]);
    let dir_j = TempDir::new().unwrap();
    let j = Fabric::attach(cfg(&dir_j), &fid_hex).await.unwrap();
    let err = j.join(&token).await.unwrap_err();
    assert_eq!(
        join_code(&err),
        Some(JoinErrorCode::TokenExpired),
        "{err:?}"
    );
}

// ---- 1/3. TOKEN_INVALID：解码坏 + 地址规范化坏 ---------------------------------

#[tokio::test]
async fn token_invalid_variants() {
    let _g = TEST_LOCK.lock().await;
    let dir_j = TempDir::new().unwrap();
    let identity = dweb_fabric::identity::NodeIdentity::load_or_create(dir_j.path()).unwrap();
    let (_d, fid_hex, good) =
        issue_token_as(&identity, "https://relay.example", &[], 60_000, now_ms());
    let j = Fabric::attach(cfg(&dir_j), &fid_hex).await.unwrap();
    // 篡改令牌串
    let mut tampered = good.clone();
    tampered.replace_range(8..12, "!!!!");
    let err = j.join(&tampered).await.unwrap_err();
    assert_eq!(
        join_code(&err),
        Some(JoinErrorCode::TokenInvalid),
        "{err:?}"
    );
    // 令牌 relay 非空但不可解析
    let (_d, _f, bad_relay) = issue_token_as(&identity, "http://[::bad", &[], 60_000, now_ms());
    let err = j.join(&bad_relay).await.unwrap_err();
    assert_eq!(
        join_code(&err),
        Some(JoinErrorCode::TokenInvalid),
        "{err:?}"
    );
    assert!(err.to_string().contains("relay URL"), "{err}");
    // 直连地址不可解析
    let (_d, _f, bad_addr) = issue_token_as(
        &identity,
        "https://relay.example",
        &["localhost:9"],
        60_000,
        now_ms(),
    );
    let err = j.join(&bad_addr).await.unwrap_err();
    assert_eq!(
        join_code(&err),
        Some(JoinErrorCode::TokenInvalid),
        "{err:?}"
    );
    assert!(err.to_string().contains("direct address"), "{err}");
}

// ---- 5. WRONG_FABRIC：目录 A + 令牌 B -----------------------------------------

#[tokio::test]
async fn wrong_fabric_dir_a_token_b() {
    let _g = TEST_LOCK.lock().await;
    // 目录 A：完整 fabric（root 可 open）
    let dir_a = TempDir::new().unwrap();
    let a = Fabric::create_root(cfg(&dir_a)).await.unwrap();
    // 令牌 B：另一 fabric 的合法令牌
    let dir_b = TempDir::new().unwrap();
    let identity_b = dweb_fabric::identity::NodeIdentity::load_or_create(dir_b.path()).unwrap();
    let (_dir_t, _fid_b, token_b) =
        issue_token_as(&identity_b, "https://relay.example", &[], 60_000, now_ms());
    let decoded = InviteToken::decode(&token_b).unwrap();

    // 内核路径：open 目录 A（roster fabric A）后 join 令牌 B → DirFabricMismatch
    let a2 = Fabric::open(cfg(&dir_a)).await.unwrap();
    let stored_hex = a2.fabric_id_hex().await;
    let err = a2.join(&token_b).await.unwrap_err();
    match &err {
        FabricError::Roster(dweb_fabric::roster::RosterError::DirFabricMismatch {
            path,
            stored,
            requested,
        }) => {
            assert_eq!(path, &dir_a.path().join("roster.facts"));
            assert_eq!(hex::encode(stored.as_bytes()), stored_hex);
            assert_eq!(*requested, decoded.invite.fabric_id);
        }
        other => panic!("expected DirFabricMismatch, got {other:?}"),
    }
    let msg = err.to_string();
    assert!(msg.contains("use a fresh --data directory"), "{msg}");
    // 16 hex 短标识（各 8 字节）
    assert_eq!(
        dweb_fabric::roster::fabric_id_short16(&decoded.invite.fabric_id).len(),
        16
    );
    assert!(msg.contains(&dweb_fabric::roster::fabric_id_short16(
        &decoded.invite.fabric_id
    )));

    // SDK joinWithToken 等价路径：attach（目录 A）+ 令牌 B 的 fabric → 构造期即拒
    let fid_b_hex = hex::encode(decoded.invite.fabric_id.as_bytes());
    let attach_err = match Fabric::attach(cfg(&dir_a), &fid_b_hex).await {
        Err(e) => e,
        Ok(_) => panic!("attach with foreign fabric must fail"),
    };
    assert!(
        matches!(
            &attach_err,
            FabricError::Roster(dweb_fabric::roster::RosterError::DirFabricMismatch { .. })
        ),
        "{attach_err:?}"
    );

    a.shutdown().await.unwrap();
    a2.shutdown().await.unwrap();
}

// ---- 7a. RELAY_OFFLINE：探针关闭端口秒拒 / DNS 失败 ------------------------------

/// 自连接令牌：issuer == joiner 自身 endpoint id → connect 立即错误
///（iroh 拒绝自连接，早于任何网络路径解析），驱动 7a 分类时点。
async fn self_connect_join(relay: &str, addrs: &[&str], join_timeout_ms: u64) -> FabricError {
    let dir_j = TempDir::new().unwrap();
    let identity = dweb_fabric::identity::NodeIdentity::load_or_create(dir_j.path()).unwrap();
    let (_dir_t, fid_hex, token) = issue_token_as(&identity, relay, addrs, 60_000, now_ms());
    let j = Fabric::attach(cfg_with(&dir_j, join_timeout_ms), &fid_hex)
        .await
        .unwrap();
    j.join(&token).await.unwrap_err()
}

#[tokio::test]
async fn relay_offline_probe_closed_port_instant_refusal() {
    let _g = TEST_LOCK.lock().await;
    let err = self_connect_join("http://127.0.0.1:9", &[], JOIN_TIMEOUT_MS_DEFAULT).await;
    assert_eq!(
        join_code(&err),
        Some(JoinErrorCode::RelayOffline),
        "{err:?}"
    );
    assert!(err.to_string().contains("unreachable"), "{err}");
}

#[tokio::test]
async fn relay_offline_probe_dns_failure() {
    let _g = TEST_LOCK.lock().await;
    // .invalid TLD（RFC 6761）：解析必然失败，计入 2s 探针预算
    let err = self_connect_join(
        "http://no-such-host-dweb.invalid:80",
        &[],
        JOIN_TIMEOUT_MS_DEFAULT,
    )
    .await;
    assert_eq!(
        join_code(&err),
        Some(JoinErrorCode::RelayOffline),
        "{err:?}"
    );
}

#[tokio::test]
async fn dial_failed_when_probe_succeeds_accept_and_close_listener() {
    let _g = TEST_LOCK.lock().await;
    // 接受即关 listener：探针（transport-only）成功、协议死 → DIAL_FAILED
    let port = reserve_port();
    let listener = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
    let server = std::thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(s) => drop(s), // 立即关闭
                Err(_) => break,
            }
        }
    });
    let err = self_connect_join(
        &format!("http://127.0.0.1:{port}"),
        &[],
        JOIN_TIMEOUT_MS_DEFAULT,
    )
    .await;
    assert_eq!(join_code(&err), Some(JoinErrorCode::DialFailed), "{err:?}");
    drop(server);
}

// ---- 探针适用条件负测（直连地址 / 策略非 none） ----------------------------------

#[tokio::test]
async fn probe_not_applicable_with_direct_addr_is_dial_failed() {
    let _g = TEST_LOCK.lock().await;
    // 令牌含直连地址：即使 relay 探针会失败也不判 RELAY_OFFLINE
    let err = self_connect_join(
        "http://127.0.0.1:9",
        &["127.0.0.1:1"],
        JOIN_TIMEOUT_MS_DEFAULT,
    )
    .await;
    assert_eq!(join_code(&err), Some(JoinErrorCode::DialFailed), "{err:?}");
}

#[tokio::test]
async fn probe_not_applicable_with_proxy_is_dial_failed() {
    let _g = TEST_LOCK.lock().await;
    let dir_j = TempDir::new().unwrap();
    let identity = dweb_fabric::identity::NodeIdentity::load_or_create(dir_j.path()).unwrap();
    let (_dir_t, fid_hex, token) =
        issue_token_as(&identity, "http://127.0.0.1:9", &[], 60_000, now_ms());
    let j = Fabric::attach(
        FabricConfig {
            http_proxy: HttpProxyConfig::FromEnv,
            ..cfg_with(&dir_j, JOIN_TIMEOUT_MS_DEFAULT)
        },
        &fid_hex,
    )
    .await
    .unwrap();
    let err = j.join(&token).await.unwrap_err();
    assert_eq!(join_code(&err), Some(JoinErrorCode::DialFailed), "{err:?}");
}

// ---- 探针句柄注入（F 内部可替换探针函数） ---------------------------------------

#[tokio::test]
async fn probe_handle_is_replaceable() {
    let _g = TEST_LOCK.lock().await;
    type F = std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>>;
    let make = |ok: bool| {
        Arc::new(move |_url: String| -> F { Box::pin(async move { ok }) })
            as dweb_fabric::RelayProbeFn
    };
    // 注入“探针成功”：关闭端口也判 DIAL_FAILED（不判 RELAY_OFFLINE）
    dweb_fabric::set_relay_probe_for_tests(Some(make(true)));
    let err = self_connect_join("http://127.0.0.1:9", &[], JOIN_TIMEOUT_MS_DEFAULT).await;
    dweb_fabric::set_relay_probe_for_tests(None);
    assert_eq!(join_code(&err), Some(JoinErrorCode::DialFailed), "{err:?}");
    // 注入“探针失败”：可达 relay 也判 RELAY_OFFLINE
    let port = reserve_port();
    let listener = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
    let server = std::thread::spawn(move || {
        for stream in listener.incoming() {
            if stream.is_err() {
                break;
            }
        }
    });
    dweb_fabric::set_relay_probe_for_tests(Some(make(false)));
    let err = self_connect_join(
        &format!("http://127.0.0.1:{port}"),
        &[],
        JOIN_TIMEOUT_MS_DEFAULT,
    )
    .await;
    dweb_fabric::set_relay_probe_for_tests(None);
    assert_eq!(
        join_code(&err),
        Some(JoinErrorCode::RelayOffline),
        "{err:?}"
    );
    drop(server);
}

// ---- 7c/7d. DIAL_TIMEOUT 附注 ---------------------------------------------------

/// 挂起式 TCP listener（接受并保持连接，不实现任何协议）。
struct HoldListener {
    _keep: Vec<std::net::TcpStream>,
    port: u16,
}

impl HoldListener {
    fn spawn() -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let mut keep = Vec::new();
            for stream in listener.incoming() {
                match stream {
                    // 持有连接不关闭（探针 TCP 可达、协议死）
                    Ok(s) => keep.push(s),
                    Err(_) => break,
                }
            }
        });
        Self {
            _keep: Vec::new(),
            port,
        }
    }
}

/// joiner 拨号一个不存在于 relay 的 issuer（经挂起 listener 的 relay 路径）。
async fn join_missing_issuer(relay_url: &str, join_timeout_ms: u64) -> FabricError {
    let dir_j = TempDir::new().unwrap();
    let issuer = dweb_fabric::identity::NodeIdentity::from_seed([0xAB; 32]);
    let (_dir_t, fid_hex, token) = issue_token_as(&issuer, relay_url, &[], 60_000, now_ms());
    let j = Fabric::attach(cfg_with(&dir_j, join_timeout_ms), &fid_hex)
        .await
        .unwrap();
    j.join(&token).await.unwrap_err()
}

#[tokio::test]
async fn dial_timeout_with_issuer_likely_offline_note() {
    let _g = TEST_LOCK.lock().await;
    let hold = HoldListener::spawn();
    // 短 deadline：issuer 不存在（QUIC 握手无响应）；探针成功（TCP 可达）→ 附注
    let err = join_missing_issuer(&format!("http://127.0.0.1:{}", hold.port), 2_000).await;
    assert_eq!(join_code(&err), Some(JoinErrorCode::DialTimeout), "{err:?}");
    assert!(
        err.to_string().contains("issuer likely offline"),
        "probe-success note expected: {err}"
    );
}

#[tokio::test]
async fn dial_timeout_without_probe_success_note() {
    let _g = TEST_LOCK.lock().await;
    // deadline 到期 + 探针失败（关闭端口）→ 附注为 join deadline，不提 issuer likely offline
    let err = join_missing_issuer("http://127.0.0.1:9", 2_000).await;
    assert_eq!(join_code(&err), Some(JoinErrorCode::DialTimeout), "{err:?}");
    let msg = err.to_string();
    assert!(msg.contains("join deadline exceeded"), "{msg}");
    assert!(!msg.contains("issuer likely offline"), "{msg}");
}

// ---- HB 4.1：detached connect 任务纳入 shutdown 可等待集合 ------------------------

#[tokio::test]
async fn shutdown_joins_detached_connect_tasks() {
    let _g = TEST_LOCK.lock().await;
    // 挂起 relay 路径 + 最短 deadline：join 归类 DIAL_TIMEOUT，connect 任务按
    // P1-10 语义不取消、在登记表中悬挂
    let hold = HoldListener::spawn();
    let dir_j = TempDir::new().unwrap();
    let issuer = dweb_fabric::identity::NodeIdentity::from_seed([0xEE; 32]);
    let (_dir_t, fid_hex, token) = issue_token_as(
        &issuer,
        &format!("http://127.0.0.1:{}", hold.port),
        &[],
        60_000,
        now_ms(),
    );
    let j = Fabric::attach(cfg_with(&dir_j, JOIN_TIMEOUT_MS_MIN), &fid_hex)
        .await
        .unwrap();
    let err = j.join(&token).await.unwrap_err();
    assert_eq!(join_code(&err), Some(JoinErrorCode::DialTimeout), "{err:?}");
    assert!(
        j.detached_connect_pending() >= 1,
        "connect task must be registered and still pending"
    );
    // shutdown 有界收尾（endpoint 关闭后自然结束，或 5s 上限 abort）
    tokio::time::timeout(std::time::Duration::from_secs(15), j.shutdown())
        .await
        .expect("shutdown must be bounded")
        .unwrap();
    assert_eq!(
        j.detached_connect_pending(),
        0,
        "no detached connect residue after shutdown"
    );
}

#[tokio::test]
async fn concurrent_shutdown_calls_share_completion() {
    let _g = TEST_LOCK.lock().await;
    // R3 P1-1：并发 shutdown 共享完成门——晚到调用必须等首次 drain 完成后
    // 返回，不得在 drain 进行中就提前 Ok（残留任务/后续事件违例）。
    let hold = HoldListener::spawn();
    let dir_j = TempDir::new().unwrap();
    let issuer = dweb_fabric::identity::NodeIdentity::from_seed([0xE1; 32]);
    let (_dir_t, fid_hex, token) = issue_token_as(
        &issuer,
        &format!("http://127.0.0.1:{}", hold.port),
        &[],
        60_000,
        now_ms(),
    );
    let j = Fabric::attach(cfg_with(&dir_j, JOIN_TIMEOUT_MS_MIN), &fid_hex)
        .await
        .unwrap();
    // 制造一个悬挂的 detached connect（归类超时后任务仍在登记表）
    let _ = j.join(&token).await;
    assert!(j.detached_connect_pending() >= 1);
    // 并发关闭：两路都应等待 drain 完成后才返回
    let (r1, r2) = tokio::time::timeout(std::time::Duration::from_secs(20), async {
        tokio::join!(j.shutdown(), j.shutdown())
    })
    .await
    .expect("concurrent shutdown must be bounded");
    r1.unwrap();
    r2.unwrap();
    assert_eq!(
        j.detached_connect_pending(),
        0,
        "both callers must observe completed drain"
    );
}

#[tokio::test]
async fn sequential_and_cancelled_shutdown_stay_bounded() {
    let _g = TEST_LOCK.lock().await;
    // R4 P1-1 回归三连：
    // 1) 顺序二调：首调完成时无订阅者——send_replace 落值，第二次即见 true
    //    （R3 报告的确定性死锁：watch::send 无订阅者丢弃值）
    // 2) 首调用 Future 取消（drop）：drain 由后台任务继续，后续调用必放行
    // 3) shutdown 后 connect 拒绝（R4 P1-2：无新航班越过完成门）
    let dir = TempDir::new().unwrap();
    let issuer = dweb_fabric::identity::NodeIdentity::from_seed([0xE2; 32]);
    let (_dir_t, fid_hex, _token) =
        issue_token_as(&issuer, "http://127.0.0.1:9", &[], 60_000, now_ms());
    let j = Fabric::attach(cfg_with(&dir, 30_000), &fid_hex)
        .await
        .unwrap();
    // 1) 顺序二调有界
    tokio::time::timeout(std::time::Duration::from_secs(15), j.shutdown())
        .await
        .expect("first shutdown must be bounded")
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), j.shutdown())
        .await
        .expect("sequential second shutdown must see stored completion")
        .unwrap();
    // 3) shutdown 后 connect 快速失败（入口拒绝）
    let err = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        j.connect(&issuer.endpoint_id().to_string()),
    )
    .await
    .expect("connect after shutdown must be bounded");
    assert!(
        err.is_err(),
        "connect must be rejected while shutting down: {err:?}"
    );

    // 2) 取消路径（独立 fabric）
    let dir2 = TempDir::new().unwrap();
    let j2 = Fabric::attach(cfg_with(&dir2, 30_000), &fid_hex)
        .await
        .unwrap();
    let j2c = j2.clone();
    let owner = tokio::spawn(async move { j2c.shutdown().await });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    owner.abort(); // 取消首调用（drain 后台任务不受影响）
    tokio::time::timeout(std::time::Duration::from_secs(15), j2.shutdown())
        .await
        .expect("post-cancellation shutdown must complete via background drain")
        .unwrap();
}

#[tokio::test]
async fn shutdown_collects_stalled_accept_child_before_completion() {
    let _g = TEST_LOCK.lock().await;
    // [R8-2] 真实 accept child 卡在 redeem 入口（不打开 bidi 流）；关闭必须
    // 先结束外层 accept loop，再 abort/join 该 child，完成门不可越过残留任务。
    let port = reserve_port();
    let dir = TempDir::new().unwrap();
    let fabric = Fabric::create_root(FabricConfig {
        advertise_addrs: vec![format!("127.0.0.1:{port}")],
        bind_addr: Some(format!("127.0.0.1:{port}")),
        ..cfg(&dir)
    })
    .await
    .unwrap();
    let token = fabric.invite(60_000, None).await.unwrap();
    let decoded = InviteToken::decode(&token).unwrap();
    let addr = dweb_fabric::session::endpoint_addr_from_invite(&decoded).unwrap();
    let raw = iroh::Endpoint::builder(iroh::endpoint::presets::Minimal)
        .relay_mode(RelayMode::Disabled)
        .alpns(vec![dweb_fabric::session::ALPN_REDEEM.to_vec()])
        .bind()
        .await
        .unwrap();
    let _conn = raw
        .connect(addr, dweb_fabric::session::ALPN_REDEEM)
        .await
        .unwrap();
    // 让 accept loop 完成 incoming -> child 的登记；child 随后停在 accept_bi。
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    tokio::time::timeout(std::time::Duration::from_secs(15), fabric.shutdown())
        .await
        .expect("stalled accept child must not hold completion gate")
        .unwrap();
    raw.close().await;
}

#[tokio::test]
async fn inflight_connect_owner_cannot_cross_shutdown_completion() {
    let _g = TEST_LOCK.lock().await;
    // R5 P1-1 确定性 fixture：真实 join 建立成员关系后杀死对端、注入持流
    // relay 候选——connect owner 挂在拨号上；随后验证——
    // 1) owner 登记确定性可观察（connect_inflight_len 轮询）
    // 2) 首调用 shutdown 的调用方 Future 被取消（drain 确实进行中：空表
    //    等待卡在挂起拨号上）——drain 后台任务继续
    // 3) 完成门放行后：connect 有界失败、无 PeerConnected 事件
    let hold = HoldListener::spawn();
    let port_a = reserve_port();
    let dir_a = TempDir::new().unwrap();
    let dir_b = TempDir::new().unwrap();
    let a = Fabric::create_root(FabricConfig {
        advertise_addrs: vec![format!("127.0.0.1:{port_a}")],
        bind_addr: Some(format!("127.0.0.1:{port_a}")),
        join_timeout_ms: JOIN_TIMEOUT_MS_MIN.max(5_000),
        ..cfg(&dir_a)
    })
    .await
    .unwrap();
    let fabric_id = a.fabric_id_hex().await;
    let token = a.invite(300_000, None).await.unwrap();
    let b = Fabric::attach(cfg_with(&dir_b, JOIN_TIMEOUT_MS_MIN), &fabric_id)
        .await
        .unwrap();
    b.join(&token).await.expect("join establishes membership");
    let a_id = a.endpoint_id();
    a.shutdown().await.unwrap(); // 对端死亡：直连候选快速失败
    drop(a);
    let mut events = b.subscribe();
    b.add_known_addr(&a_id, format!("http://127.0.0.1:{}", hold.port))
        .await
        .unwrap();
    let b2 = b.clone();
    let a_id_dial = a_id.clone();
    let connect_task = tokio::spawn(async move { b2.connect(&a_id_dial).await });
    // 1) 确定性等待 owner 登记
    let dl = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while b.connect_inflight_len() == 0 && std::time::Instant::now() < dl {
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    if b.connect_inflight_len() == 0 {
        let diag = if connect_task.is_finished() {
            format!(
                "connect already finished (fast-fail): {:?}",
                connect_task.await
            )
        } else {
            "connect still pending but no flight registered".to_string()
        };
        panic!("owner flight must be registered — {diag}");
    }
    // 2) 首调用取消（drain 进行中：空表等待卡在挂起拨号）
    let b3 = b.clone();
    let owner = tokio::spawn(async move { b3.shutdown().await });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    owner.abort();
    // 后续调用必须经后台 drain 的完成通知放行（有界）
    tokio::time::timeout(std::time::Duration::from_secs(20), b.shutdown())
        .await
        .expect("shutdown must complete via background drain despite cancelled owner call")
        .unwrap();
    // 3) 完成后：航班表真实清空（R6：owner 条目保留至其退出——收敛可观测）
    assert_eq!(
        b.connect_inflight_len(),
        0,
        "owner flight must be cleaned up by guard after completion"
    );
    // 完成后：connect 有界失败；无 PeerConnected
    let r = tokio::time::timeout(std::time::Duration::from_secs(15), connect_task)
        .await
        .expect("in-flight connect must terminate after shutdown completion")
        .unwrap();
    assert!(r.is_err(), "connect must fail on shut-down fabric: {r:?}");
    while let Ok(ev) = events.try_recv() {
        assert!(
            !matches!(ev, dweb_fabric::FabricEvent::PeerConnected { .. }),
            "no peer-connected after shutdown completion: {ev:?}"
        );
    }
}

#[tokio::test]
async fn join_after_shutdown_fails_fast_without_registration() {
    let _g = TEST_LOCK.lock().await;
    // R2 P0-2 回归：shutdown 置位后到达的 join（登记侧看见 shutting_down）
    // 必须本地 abort + await 收割 connect wrapper——不进登记表、无残留、
    // 有界返回（消灭"spawn 后、登记前"窗口的关闭后残留）。
    let hold = HoldListener::spawn();
    let dir_j = TempDir::new().unwrap();
    let issuer = dweb_fabric::identity::NodeIdentity::from_seed([0xEF; 32]);
    let (_dir_t, fid_hex, token) = issue_token_as(
        &issuer,
        &format!("http://127.0.0.1:{}", hold.port),
        &[],
        60_000,
        now_ms(),
    );
    let j = Fabric::attach(cfg_with(&dir_j, JOIN_TIMEOUT_MS_MIN), &fid_hex)
        .await
        .unwrap();
    j.shutdown().await.unwrap();
    // shutdown 之后的 join：无论 connect 结果如何，不得在登记表留下任务
    let result = tokio::time::timeout(std::time::Duration::from_secs(15), j.join(&token)).await;
    assert!(result.is_ok(), "join after shutdown must be bounded");
    // 归类为超时族（endpoint 已关，任何失败形态均可，但不得挂死）
    assert!(result.unwrap().is_err(), "join after shutdown must fail");
    assert_eq!(
        j.detached_connect_pending(),
        0,
        "registration after shutdown must abort locally, never register"
    );
}

// ---- redeem 通道超时 / 中断（raw issuer endpoint） -------------------------------

/// 裸 issuer endpoint：以令牌签发者身份接受 ALPN_REDEEM 连接后按 mode 行为。
enum RawIssuerMode {
    /// 读 intent 后挂起（challenge 永不到达）→ 内层 5s 超时路径。
    HangAfterIntent,
    /// 读 intent 并回 challenge 后关闭连接 → 非结构化失败 → DIAL_FAILED。
    CloseAfterIntent,
}

struct RawIssuerHandle {
    _endpoint: iroh::Endpoint,
    port: u16,
    _task: tokio::task::JoinHandle<()>,
}

async fn raw_issuer_spawn_async(
    identity: &dweb_fabric::identity::NodeIdentity,
    mode: RawIssuerMode,
) -> RawIssuerHandle {
    let endpoint = iroh::Endpoint::builder(iroh::endpoint::presets::Minimal)
        .relay_mode(RelayMode::Disabled)
        .secret_key(identity.secret_key().clone())
        .alpns(vec![dweb_fabric::session::ALPN_REDEEM.to_vec()])
        .bind()
        .await
        .unwrap();
    let port = endpoint.bound_sockets().first().unwrap().port();
    let task = tokio::spawn(raw_issuer_accept_loop(endpoint.clone(), mode));
    RawIssuerHandle {
        _endpoint: endpoint,
        port,
        _task: task,
    }
}

async fn raw_issuer_accept_loop(endpoint: iroh::Endpoint, mode: RawIssuerMode) {
    use dweb_fabric::session::frame_type;
    use dweb_fabric::session::{MAX_REDEEM_FRAME, read_frame, write_frame};
    while let Some(incoming) = endpoint.accept().await {
        let Ok(conn) = incoming.accept() else {
            continue;
        };
        let Ok(conn) = conn.await else { continue };
        match mode {
            RawIssuerMode::HangAfterIntent => {
                tokio::spawn(async move {
                    let Ok((_send, mut recv)) = conn.accept_bi().await else {
                        return;
                    };
                    // 读 intent 后永不回应（内层 5s 超时构造）
                    let _ = read_frame(&mut recv, MAX_REDEEM_FRAME).await;
                    std::future::pending::<()>().await;
                });
            }
            RawIssuerMode::CloseAfterIntent => {
                tokio::spawn(async move {
                    let Ok((mut send, mut recv)) = conn.accept_bi().await else {
                        return;
                    };
                    let _ = read_frame(&mut recv, MAX_REDEEM_FRAME).await;
                    let _ = write_frame(&mut send, frame_type::REDEEM_CHALLENGE, &[0u8; 32]).await;
                    conn.close(0u32.into(), b"boom");
                });
            }
        }
    }
}

async fn raw_issuer_join(mode: RawIssuerMode, join_timeout_ms: u64) -> FabricError {
    // 令牌签发者 = 裸 issuer 的身份（TLS 认证通过，redeem 阶段可被驱动）
    let issuer = dweb_fabric::identity::NodeIdentity::from_seed([0xCC; 32]);
    let handle = raw_issuer_spawn_async(&issuer, mode).await;
    let dir_j = TempDir::new().unwrap();
    let (_dir_t, fid_hex, token) = issue_token_as(
        &issuer,
        "",
        &[&format!("127.0.0.1:{}", handle.port)],
        60_000,
        now_ms(),
    );
    let j = Fabric::attach(cfg_with(&dir_j, join_timeout_ms), &fid_hex)
        .await
        .unwrap();
    j.join(&token).await.unwrap_err()
}

#[tokio::test]
async fn dial_timeout_redeem_timeout_note_inner_5s() {
    let _g = TEST_LOCK.lock().await;
    // joinTimeoutMs(8s) > 5s：内层先到 → 附注 redeem timeout
    let err = raw_issuer_join(RawIssuerMode::HangAfterIntent, 8_000).await;
    assert_eq!(join_code(&err), Some(JoinErrorCode::DialTimeout), "{err:?}");
    assert!(
        err.to_string().contains("redeem timeout"),
        "inner-deadline note expected: {err}"
    );
}

#[tokio::test]
async fn join_deadline_owns_result_when_lte_5s() {
    let _g = TEST_LOCK.lock().await;
    // joinTimeoutMs(2s) <= 5s：外层拥有唯一结果（附注 join timeout，不追加 redeem 附注）
    let err = raw_issuer_join(RawIssuerMode::HangAfterIntent, 2_000).await;
    assert_eq!(join_code(&err), Some(JoinErrorCode::DialTimeout), "{err:?}");
    let msg = err.to_string();
    assert!(msg.contains("join deadline exceeded"), "{msg}");
    assert!(!msg.contains("redeem timeout"), "{msg}");
}

#[tokio::test]
async fn redeem_unstructured_interrupt_is_dial_failed() {
    let _g = TEST_LOCK.lock().await;
    // 连接中断（challenge 后连接被 issuer 关闭）→ 非结构化失败 → DIAL_FAILED
    let err = raw_issuer_join(RawIssuerMode::CloseAfterIntent, JOIN_TIMEOUT_MS_DEFAULT).await;
    assert_eq!(join_code(&err), Some(JoinErrorCode::DialFailed), "{err:?}");
    assert!(err.to_string().contains("redeem channel failed"), "{err}");
}

// ---- TOKEN_CONSUMED（固定端口全链路二次兑换） ------------------------------------

#[tokio::test]
async fn token_consumed_second_redeem() {
    let _g = TEST_LOCK.lock().await;
    let dir_a = TempDir::new().unwrap();
    let dir_b = TempDir::new().unwrap();
    let port = reserve_port();
    let a = Fabric::create_root(FabricConfig {
        advertise_addrs: vec![format!("127.0.0.1:{port}")],
        bind_addr: Some(format!("127.0.0.1:{port}")),
        ..cfg(&dir_a)
    })
    .await
    .unwrap();
    let fid = a.fabric_id_hex().await;
    let b = Fabric::attach(cfg(&dir_b), &fid).await.unwrap();
    let token = a.invite(60_000, None).await.unwrap();
    b.join(&token).await.expect("first redeem succeeds");
    let err = b.join(&token).await.unwrap_err();
    assert_eq!(
        join_code(&err),
        Some(JoinErrorCode::TokenConsumed),
        "{err:?}"
    );
    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
}

// ---- 豁免三态（missing-identity / corrupted / roster-io） -------------------------

#[tokio::test]
async fn exempt_missing_identity() {
    let _g = TEST_LOCK.lock().await;
    let dir = TempDir::new().unwrap();
    let err = match Fabric::open(cfg(&dir)).await {
        Err(e) => e,
        Ok(_) => panic!("open on empty dir must fail"),
    };
    assert!(matches!(err, FabricError::MissingIdentity(_)), "{err:?}");
}

#[tokio::test]
async fn exempt_corrupted_roster() {
    let _g = TEST_LOCK.lock().await;
    let dir = TempDir::new().unwrap();
    let a = Fabric::create_root(cfg(&dir)).await.unwrap();
    a.shutdown().await.unwrap();
    // 篡改 roster.facts 主体（校验和失败 = 真损坏，非目录归属问题）
    let path = dir.path().join("roster.facts");
    let mut bytes = std::fs::read(&path).unwrap();
    let n = bytes.len();
    bytes[n - 40] ^= 0xFF;
    std::fs::write(&path, &bytes).unwrap();
    let err = match Fabric::open(cfg(&dir)).await {
        Err(e) => e,
        Ok(_) => panic!("open on corrupted roster must fail"),
    };
    assert!(
        matches!(
            err,
            FabricError::Roster(dweb_fabric::roster::RosterError::Corrupted { .. })
        ),
        "{err:?}"
    );
}

#[tokio::test]
async fn exempt_roster_io_on_join_persist() {
    let _g = TEST_LOCK.lock().await;
    let dir_a = TempDir::new().unwrap();
    let dir_b = TempDir::new().unwrap();
    let port = reserve_port();
    let a = Fabric::create_root(FabricConfig {
        advertise_addrs: vec![format!("127.0.0.1:{port}")],
        bind_addr: Some(format!("127.0.0.1:{port}")),
        ..cfg(&dir_a)
    })
    .await
    .unwrap();
    let fid = a.fabric_id_hex().await;
    let b = Fabric::attach(cfg(&dir_b), &fid).await.unwrap();
    // join 成功路径的写盘失败注入：目录只读 → merge 的 tmp+rename 失败
    let perms = std::fs::metadata(dir_b.path()).unwrap().permissions();
    let mut ro = perms.clone();
    ro.set_readonly(true);
    std::fs::set_permissions(dir_b.path(), ro).unwrap();
    let token = a.invite(60_000, None).await.unwrap();
    let err = b.join(&token).await.unwrap_err();
    std::fs::set_permissions(dir_b.path(), perms).unwrap();
    assert!(
        matches!(
            err,
            FabricError::Roster(dweb_fabric::roster::RosterError::Persistence { .. })
        ),
        "roster-io exemption must pass through, got {err:?}"
    );
    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
}

// ---- watcher：disabled 无事件 online=null；shutdown 无残留 -----------------------

#[tokio::test]
async fn relay_disabled_no_events_and_online_null() {
    let _g = TEST_LOCK.lock().await;
    let dir = TempDir::new().unwrap();
    let a = Fabric::create_root(cfg(&dir)).await.unwrap();
    let mut rx = a.subscribe();
    let status = a.relay_status();
    assert_eq!(status.mode, "disabled");
    assert_eq!(status.urls, Vec::<String>::new());
    assert_eq!(status.online, None, "disabled => null, not false");
    assert!(status.last_error.is_none());
    assert!(
        a.relay_watcher_exited(),
        "no watcher task for disabled mode"
    );
    a.shutdown().await.unwrap();
    assert!(rx.try_recv().is_err(), "no relay events ever");
}

#[tokio::test]
async fn relay_watcher_shutdown_has_no_residue() {
    let _g = TEST_LOCK.lock().await;
    let dir = TempDir::new().unwrap();
    // 自定义 relay 指向关闭端口：watcher 运行但聚合保持 offline（首值不广播）
    let a = Fabric::create_root(FabricConfig {
        relay: RelayConfig::Custom(vec!["http://127.0.0.1:9".into()]),
        ..cfg(&dir)
    })
    .await
    .unwrap();
    let mut rx = a.subscribe();
    assert!(!a.relay_watcher_exited(), "watcher task is running");
    a.shutdown().await.unwrap();
    // shutdown 显式 abort + join：任务已退出，无后续事件
    assert!(a.relay_watcher_exited(), "watcher task must be joined");
    assert!(rx.try_recv().is_err());
}
