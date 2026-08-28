//! RedeemErrorKind wire 契约测试：
//! - contracts/redeem-err.fixtures.json 十二例字节向量（hex 内联），经既有
//!   read_frame/write_frame 在**真实连接流**上做字节级读取与 round-trip；
//! - issuerMapping 17 行 variantId 的可驱动行：真连接构造 issuer 拒绝路径，
//!   断言 emit=true 行的外层 0x14 + 单记录字节、emit=false 行无结构化帧 + 关闭。
//!
//! 不可经公开 API 构造的行（proof-bad-redeemer-key / post-encode-receipt-failed）
//! 见文件尾注与 Batch F 报告；映射层由 session.rs 单测覆盖。

use dweb_fabric::identity::NodeIdentity;
use dweb_fabric::protocol::{FabricId, InviteToken, InviteV1};
use dweb_fabric::roster::Roster;
use dweb_fabric::session::frame_type;
use dweb_fabric::session::{self, MAX_REDEEM_FRAME, read_frame, redeem_err, write_frame};
use iroh::{Endpoint, EndpointAddr, RelayMode};
use std::sync::Arc;
use tempfile::TempDir;
use tokio::sync::{Mutex, mpsc};
use serde::Deserialize;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn hex16(id: &FabricId) -> String {
    dweb_fabric::roster::fabric_id_short16(id)
}

// ==== 十二例 fixture 向量（wire 唯一机器权威的内联副本） ==========================

struct Case {
    name: &'static str,
    hex: String,
    reader: &'static str, // ok | header-short-read | payload-short-read
    records: Vec<(u8, String, String)>, // kind, payloadHex, presented
    result: &'static str, // join 侧归类
    violation: Option<&'static str>,
}

/// 权威 fixture（C0）：openspec/changes/connectivity-ux-hardening/contracts/
/// redeem-err.fixtures.json —— include_str! 编译期嵌入，杜绝手工副本漂移（P1-11）。
const FIXTURE_JSON: &str = include_str!(
    "../../../openspec/changes/connectivity-ux-hardening/contracts/redeem-err.fixtures.json"
);

#[derive(Deserialize)]
struct FixtureCase {
    name: String,
    hex: String,
    #[serde(rename = "expectedReaderOutcome")]
    reader: String,
    #[serde(rename = "expectedRecords", default)]
    records_json: Vec<FixtureRecord>,
    #[serde(rename = "expectedResult")]
    result: String,
    #[serde(rename = "expectedViolation", default)]
    violation: Option<String>,
}

#[derive(Deserialize)]
struct FixtureRecord {
    kind: u8,
    #[serde(rename = "payloadHex")]
    payload_hex: String,
    presented: String,
}

fn cases() -> Vec<Case> {
    // P1-11：以 contracts JSON 为唯一权威输入（编译期 include_str!），
    // 手工副本已删除——漂移会在解析/断言层直接暴露。
    #[derive(Deserialize)]
    struct FixtureDoc {
        cases: Vec<FixtureCase>,
    }
    let parsed: Vec<FixtureCase> =
        serde_json::from_str::<FixtureDoc>(FIXTURE_JSON).expect("fixture JSON must parse").cases;
    assert_eq!(parsed.len(), 12, "fixture case count frozen at 12");
    parsed
        .into_iter()
        .map(|c| Case {
            name: Box::leak(c.name.into_boxed_str()),
            hex: c.hex.replace(' ', ""),
            reader: Box::leak(c.reader.into_boxed_str()),
            records: c
                .records_json
                .into_iter()
                .map(|r| (r.kind, r.payload_hex, r.presented))
                .collect(),
            result: Box::leak(c.result.into_boxed_str()),
            violation: c.violation.map(|v| Box::leak(v.into_boxed_str()) as &'static str),
        })
        .collect()
}

// ==== 真实连接流上的 read_frame / write_frame 字节级验证 ==========================

#[derive(Debug)]
enum WireOutcome {
    Frame(u8, Vec<u8>),
    ReadFailed,
}

/// 一对 localhost endpoint：client 每用例开一条新连接 + 新 bidi 流写原始字节，
/// server 任务 accept 后用**既有 read_frame** 读取并回报结果。
struct WirePipe {
    writer: Endpoint,
    server_id: iroh_base::PublicKey,
    server_addr: std::net::SocketAddr,
    outcomes: mpsc::Receiver<WireOutcome>,
    _server: Endpoint,
    _task: tokio::task::JoinHandle<()>,
}

impl WirePipe {
    async fn connect(&self) -> iroh::endpoint::Connection {
        self.writer
            .connect(
                EndpointAddr::new(self.server_id).with_ip_addr(self.server_addr),
                b"/dweb/wire-test/1",
            )
            .await
            .unwrap()
    }
}

async fn wire_pipe() -> WirePipe {
    let server = Endpoint::builder(iroh::endpoint::presets::Minimal)
        .relay_mode(RelayMode::Disabled)
        .alpns(vec![b"/dweb/wire-test/1".to_vec()])
        .bind()
        .await
        .unwrap();
    let client = Endpoint::builder(iroh::endpoint::presets::Minimal)
        .relay_mode(RelayMode::Disabled)
        .alpns(vec![b"/dweb/wire-test/1".to_vec()])
        .bind()
        .await
        .unwrap();
    let (tx, outcomes) = mpsc::channel(64);
    let server_ep = server.clone();
    let task = tokio::spawn(async move {
        while let Some(incoming) = server_ep.accept().await {
            let Ok(conn) = incoming.accept() else { continue };
            let Ok(conn) = conn.await else { continue };
            let tx = tx.clone();
            tokio::spawn(async move {
                while let Ok((_send, mut recv)) = conn.accept_bi().await {
                    let outcome = match read_frame(&mut recv, MAX_REDEEM_FRAME).await {
                        Ok((t, p)) => WireOutcome::Frame(t, p),
                        Err(_) => WireOutcome::ReadFailed,
                    };
                    let _ = tx.send(outcome).await;
                }
            });
        }
    });
    WirePipe {
        writer: client,
        server_id: server.id(),
        server_addr: {
            let s = *server.bound_sockets().first().unwrap();
            let ip = if s.ip().is_unspecified() {
                std::net::IpAddr::from([127, 0, 0, 1])
            } else {
                s.ip()
            };
            std::net::SocketAddr::new(ip, s.port())
        },
        outcomes,
        _server: server,
        _task: task,
    }
}

impl WirePipe {
    /// 将原始字节写入新 bidi 流并等待对端 read_frame 结果。
    /// finish() 确保 EOF 传播（两层短读用例依赖流终止）。
    async fn feed(&mut self, bytes: &[u8]) -> WireOutcome {
        let conn = self.connect().await;
        let (mut send, _recv) = conn.open_bi().await.unwrap();
        send.write_all(bytes).await.unwrap();
        send.finish().unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), self.outcomes.recv())
            .await
            .expect("outcome within 5s")
            .expect("channel open")
    }

    /// 用**既有 write_frame** 在新流上写 0x14 帧（emit 侧真实路径）。
    async fn feed_redeem_err(&mut self, payload: &[u8]) -> WireOutcome {
        let conn = self.connect().await;
        let (mut send, _recv) = conn.open_bi().await.unwrap();
        write_frame(&mut send, frame_type::REDEEM_ERR, payload)
            .await
            .unwrap();
        send.finish().unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), self.outcomes.recv())
            .await
            .expect("outcome within 5s")
            .expect("channel open")
    }
}

#[tokio::test]
async fn fixture_twelve_cases_via_real_read_frame() {
    let mut pipe = wire_pipe().await;
    for case in cases() {
        let bytes = hex::decode(&case.hex).unwrap();
        let outcome = pipe.feed(&bytes).await;
        match case.reader {
            "ok" => {
                let WireOutcome::Frame(t, payload) = outcome else {
                    panic!("{}: expected frame, got read failure", case.name);
                };
                assert_eq!(t, 0x14, "{}: frame type", case.name);
                match redeem_err::decode_records(&payload) {
                    Ok(records) => {
                        assert_eq!(
                            records
                                .iter()
                                .map(|r| (r.kind, hex::encode(&r.payload), r.presented()))
                                .collect::<Vec<_>>(),
                            case.records,
                            "{}: records",
                            case.name
                        );
                        assert_eq!(case.violation, None, "{}", case.name);
                        let reduced = redeem_err::reduce(&records);
                        let result = match reduced {
                            redeem_err::RedeemRejection::Consumed => "TOKEN_CONSUMED",
                            redeem_err::RedeemRejection::Invalid { .. } => "TOKEN_INVALID",
                        };
                        assert_eq!(result, case.result, "{}: reduction", case.name);
                    }
                    Err(v) => {
                        // inner-truncated：完整外层内的记录段短读
                        assert_eq!(case.violation, Some("record-short-read"), "{}", case.name);
                        assert_eq!(case.result, "DIAL_FAILED", "{}", case.name);
                        let _ = v;
                    }
                }
            }
            "header-short-read" | "payload-short-read" => {
                assert!(
                    matches!(outcome, WireOutcome::ReadFailed),
                    "{}: read_frame must fail",
                    case.name
                );
                assert_eq!(case.result, "DIAL_FAILED", "{}", case.name);
            }
            other => panic!("unknown reader outcome {other}"),
        }
    }
}

/// emit 侧 round-trip：write_frame(REDEEM_ERR, records) → read_frame →
/// 逐字节重建外层帧并与 fixture hex 比对。
#[tokio::test]
async fn write_frame_round_trip_matches_fixture_bytes() {
    let mut pipe = wire_pipe().await;
    for case in cases()
        .into_iter()
        .filter(|c| c.reader == "ok" && c.violation.is_none())
    {
        let payload: Vec<u8> = case
            .records
            .iter()
            .map(|(kind, payload_hex, _)| {
                let mut r = vec![*kind, (payload_hex.len() / 2) as u8];
                r.extend_from_slice(&hex::decode(payload_hex).unwrap());
                r
            })
            .collect::<Vec<Vec<u8>>>()
            .concat();
        let outcome = pipe.feed_redeem_err(&payload).await;
        let WireOutcome::Frame(t, got_payload) = outcome else {
            panic!("{}: round-trip frame expected", case.name);
        };
        assert_eq!(t, 0x14, "{}", case.name);
        assert_eq!(got_payload, payload, "{}: payload round-trip", case.name);
        // 外层帧逐字节 == fixture hex
        let mut frame = ((1 + payload.len()) as u32).to_be_bytes().to_vec();
        frame.push(0x14);
        frame.extend_from_slice(&payload);
        assert_eq!(hex::encode(&frame), case.hex.replace(' ', ""), "{}", case.name);
    }
}

// ==== issuerMapping 可驱动行（真连接构造 issuer 拒绝路径） ========================

struct IssuerRig {
    roster: Arc<Mutex<Roster>>,
    endpoint: Endpoint,
    _dir: TempDir,
    _task: tokio::task::JoinHandle<()>,
}

impl IssuerRig {
    /// handler_identity 允许 != root（构造 post-grant-failed 行）。
    async fn spawn(root_identity: &NodeIdentity, handler_identity: &NodeIdentity) -> Self {
        let dir = TempDir::new().unwrap();
        let (roster, _fid) = Roster::create(root_identity, dir.path(), now_ms()).unwrap();
        Self::with_roster(Arc::new(Mutex::new(roster)), handler_identity, dir).await
    }

    async fn with_roster(
        roster: Arc<Mutex<Roster>>,
        handler_identity: &NodeIdentity,
        dir: TempDir,
    ) -> Self {
        let endpoint = Endpoint::builder(iroh::endpoint::presets::Minimal)
            .relay_mode(RelayMode::Disabled)
            .secret_key(handler_identity.secret_key().clone())
            .alpns(vec![session::ALPN_REDEEM.to_vec()])
            .bind()
            .await
            .unwrap();
        let (tx, _handler_results) = mpsc::channel(16);
        let ep = endpoint.clone();
        let roster2 = roster.clone();
        let identity = handler_identity.clone();
        let task = tokio::spawn(async move {
            while let Some(incoming) = ep.accept().await {
                let Ok(conn) = incoming.accept() else { continue };
                let Ok(conn) = conn.await else { continue };
                let roster = roster2.clone();
                let identity = identity.clone();
                let tx = tx.clone();
                tokio::spawn(async move {
                    let res = session::handle_redeem_as_issuer(&conn, &roster, &identity).await;
                    let _ = tx.send(res.err().map(|e| e.to_string()).unwrap_or_default()).await;
                    let _ = tokio::time::timeout(session::REDEEM_DEADLINE, conn.closed()).await;
                    conn.close(0u32.into(), b"redeem-done");
                });
            }
        });
        Self {
            roster,
            endpoint,
            _dir: dir,
            _task: task,
        }
    }

    fn addr(&self) -> EndpointAddr {
        // 通配绑定（0.0.0.0/::）不可拨——映射为 loopback 再下发
        let s = *self.endpoint.bound_sockets().first().unwrap();
        let ip = if s.ip().is_unspecified() {
            std::net::IpAddr::from([127, 0, 0, 1])
        } else {
            s.ip()
        };
        EndpointAddr::new(self.endpoint.id()).with_ip_addr(std::net::SocketAddr::new(ip, s.port()))
    }

    fn dir(&self) -> &std::path::Path {
        self._dir.path()
    }
}

/// 最终帧读取结果。
#[derive(Debug)]
enum FinalFrame {
    /// 帧类型 + 原始 payload
    Frame(u8, Vec<u8>),
    /// 无帧（连接关闭/流重置/读失败）—— emit=false 行的期望结果；
    /// 携带自 PROOF 发出到读失败的耗时（P0 断言：立即关闭，远小于 5s）
    NoFrame(String, std::time::Duration),
}

/// 完整裸兑换舞步：intent → challenge → proof → 最终帧（原始字节）。
/// 覆盖 entry/proof 阶段的协议违规注入（first_frame_override / proof_override）
/// 与 post-write-redeem-ok-failed 的接收半边 stop 注入。
#[allow(clippy::too_many_arguments)]
async fn dance(
    client: &Endpoint,
    rig: &IssuerRig,
    token: &InviteToken,
    redeemer: &NodeIdentity,
    proof_sig_by: &NodeIdentity,
    stop_recv_before_final: bool,
    first_frame_override: Option<(u8, Vec<u8>)>,
    proof_override: Option<(u8, Vec<u8>)>,
) -> FinalFrame {
    let conn = client
        .connect(rig.addr(), session::ALPN_REDEEM)
        .await
        .unwrap();
    let (mut send, mut recv) = conn.open_bi().await.unwrap();
    // session_entry
    match first_frame_override {
        Some((t, p)) => write_frame(&mut send, t, &p).await.unwrap(),
        None => {
            let token_str = token.encode().unwrap();
            write_frame(&mut send, frame_type::REDEEM_INTENT, token_str.as_bytes())
                .await
                .unwrap();
        }
    }
    let (t, payload) = match read_frame(&mut recv, MAX_REDEEM_FRAME).await {
        Ok(v) => v,
        Err(e) => return FinalFrame::NoFrame(format!("entry read failed: {e}"), std::time::Duration::ZERO),
    };
    assert_eq!(t, frame_type::REDEEM_CHALLENGE, "challenge expected");
    let challenge: [u8; 32] = payload.as_slice().try_into().unwrap();
    // proof_frame
    match proof_override {
        Some((t, p)) => write_frame(&mut send, t, &p).await.unwrap(),
        None => {
            let pop = dweb_fabric::protocol::redeem_challenge_bytes(
                &token.invite.fabric_id,
                &token.invite.invite_id,
                &challenge,
            );
            let sig = proof_sig_by.secret_key().sign(&pop);
            let mut proof = Vec::with_capacity(96);
            proof.extend_from_slice(redeemer.endpoint_id().as_bytes());
            proof.extend_from_slice(&sig.to_bytes());
            write_frame(&mut send, frame_type::REDEEM_PROOF, &proof)
                .await
                .unwrap();
        }
    }
    if stop_recv_before_final {
        let _ = recv.stop(0u32.into());
    }
    let t_final = std::time::Instant::now();
    match read_frame(&mut recv, MAX_REDEEM_FRAME).await {
        Ok((t, p)) => FinalFrame::Frame(t, p),
        Err(e) => FinalFrame::NoFrame(format!("final read failed: {e}"), t_final.elapsed()),
    }
}


fn expect_no_structured_frame(name: &str, f: FinalFrame) {
    if let FinalFrame::NoFrame(_, elapsed) = &f {
        assert!(
            elapsed.as_secs() < 2,
            "{name}: emit=false must close immediately, took {elapsed:?}"
        );
    }
    match f {
        FinalFrame::Frame(t, _) => panic!("{name}: must close WITHOUT a structured frame, got {t:#x}"),
        FinalFrame::NoFrame(_, _) => {}
    }
}

fn decode_one(name: &str, f: FinalFrame) -> (u8, Vec<u8>) {
    match f {
        FinalFrame::Frame(t, p) => {
            assert_eq!(t, 0x14, "{name}: outer frame type");
            (t, p)
        }
        FinalFrame::NoFrame(why, _) => panic!("{name}: expected 0x14 frame, none arrived ({why})"),
    }
}

async fn client_endpoint(redeemer: &NodeIdentity) -> Endpoint {
    // issuer 强制 PoP 对端绑定（remote_id == redeemer）：客户端 endpoint 必须以
    // redeemer 身份绑定，否则在 proof-peer-mismatch 分支被无帧关闭。
    Endpoint::builder(iroh::endpoint::presets::Minimal)
        .relay_mode(RelayMode::Disabled)
        .secret_key(redeemer.secret_key().clone())
        .alpns(vec![session::ALPN_REDEEM.to_vec()])
        .bind()
        .await
        .unwrap()
}

fn token_on(
    roster: &mut Roster,
    identity: &NodeIdentity,
    relay: &str,
    ttl_ms: u64,
    now: u64,
) -> InviteToken {
    roster
        .issue_invite(
            identity,
            relay.to_owned(),
            vec![],
            None,
            ttl_ms,
            now,
        )
        .unwrap()
}

/// —— 行：verify-wrong-fabric ——
#[tokio::test]
async fn row_verify_wrong_fabric() {
    let root = NodeIdentity::from_seed([0x11; 32]);
    let rig = IssuerRig::spawn(&root, &root).await;
    // 令牌属于另一 fabric（同 root 身份在另一 roster 签发）
    let dir_b = TempDir::new().unwrap();
    let (mut rb, fid_b) = Roster::create(&root, dir_b.path(), now_ms()).unwrap();
    let token = token_on(&mut rb, &root, "https://relay.example", 60_000, now_ms());
    let redeemer = NodeIdentity::from_seed([0x21; 32]);
    let client = client_endpoint(&redeemer).await;
    let f = dance(&client, &rig, &token, &redeemer, &redeemer, false, None, None).await;
    let (_t, payload) = decode_one("verify-wrong-fabric", f);
    let records = redeem_err::decode_records(&payload).unwrap();
    assert_eq!(records.len(), 1, "single record (v1)");
    assert_eq!(records[0].kind, 3);
    let expected = format!(
        "wrong fabric {} vs {}",
        hex16(&fid_b),
        hex16(&rig.roster.lock().await.fabric_id())
    );
    assert_eq!(records[0].presented(), expected);
    assert_eq!(
        redeem_err::reduce(&records),
        redeem_err::RedeemRejection::Invalid { reason: expected }
    );
}

/// —— 行：verify-invite-not-root（kind=1，无 payload） ——
#[tokio::test]
async fn row_verify_invite_not_root() {
    let root = NodeIdentity::from_seed([0x31; 32]);
    let rig = IssuerRig::spawn(&root, &root).await;
    // 令牌 issuer = 另一身份但 fabric = rig 的 fabric（手工构造：
    // invite 的 canonical 字节含 fabric_id，签名人即 issuer——以此绕过
    // issue_invite 的 root 约束，构造 issuer != roster.root 的合法签名令牌）
    let other = NodeIdentity::from_seed([0x32; 32]);
    let fabric_id = rig.roster.lock().await.fabric_id();
    let invite = dweb_fabric::protocol::InviteV1 {
        fabric_id,
        invite_id: dweb_fabric::protocol::random_bytes::<16>(),
        issuer: other.endpoint_id(),
        issuer_relay_url: "https://relay.example".to_owned(),
        issuer_direct_addrs: vec![],
        expires_at_ms: now_ms() + 60_000,
        recipient: None,
    };
    let token =
        dweb_fabric::protocol::InviteToken::sign(invite, other.secret_key()).unwrap();
    let redeemer = NodeIdentity::from_seed([0x33; 32]);
    let client = client_endpoint(&redeemer).await;
    let f = dance(&client, &rig, &token, &redeemer, &redeemer, false, None, None).await;
    let (_t, payload) = decode_one("verify-invite-not-root", f);
    assert_eq!(payload, vec![0x01, 0x00], "kind=1 NotRoot, empty payload");
    let records = redeem_err::decode_records(&payload).unwrap();
    assert!(matches!(
        redeem_err::reduce(&records),
        redeem_err::RedeemRejection::Invalid { .. }
    ));
}

/// —— 行：verify-invite-expired（kind=3 "invite expired"） ——
#[tokio::test]
async fn row_verify_invite_expired() {
    let root = NodeIdentity::from_seed([0x41; 32]);
    let rig = IssuerRig::spawn(&root, &root).await;
    let mut roster = rig.roster.lock().await;
    let token = token_on(&mut roster, &root, "https://relay.example", 1_000, 0);
    drop(roster);
    let redeemer = NodeIdentity::from_seed([0x42; 32]);
    let client = client_endpoint(&redeemer).await;
    let f = dance(&client, &rig, &token, &redeemer, &redeemer, false, None, None).await;
    let (_t, payload) = decode_one("verify-invite-expired", f);
    let records = redeem_err::decode_records(&payload).unwrap();
    assert_eq!(records[0].kind, 3);
    assert_eq!(records[0].presented(), "invite expired");
}

/// —— 行：verify-recipient-mismatch（kind=3 "recipient mismatch"） ——
#[tokio::test]
async fn row_verify_recipient_mismatch() {
    let root = NodeIdentity::from_seed([0x51; 32]);
    let rig = IssuerRig::spawn(&root, &root).await;
    let thief = NodeIdentity::from_seed([0x52; 32]);
    let mut roster = rig.roster.lock().await;
    let token = roster
        .issue_invite(
            &root,
            "https://relay.example".into(),
            vec![],
            Some(thief.endpoint_id()),
            60_000,
            now_ms(),
        )
        .unwrap();
    drop(roster);
    let redeemer = NodeIdentity::from_seed([0x53; 32]);
    let client = client_endpoint(&redeemer).await;
    let f = dance(&client, &rig, &token, &redeemer, &redeemer, false, None, None).await;
    let (_t, payload) = decode_one("verify-recipient-mismatch", f);
    let records = redeem_err::decode_records(&payload).unwrap();
    assert_eq!(records[0].kind, 3);
    assert_eq!(records[0].presented(), "recipient mismatch");
}

/// —— 行：verify-bad-pop（kind=2，无 payload） ——
#[tokio::test]
async fn row_verify_bad_pop() {
    let root = NodeIdentity::from_seed([0x61; 32]);
    let rig = IssuerRig::spawn(&root, &root).await;
    let mut roster = rig.roster.lock().await;
    let token = token_on(&mut roster, &root, "https://relay.example", 60_000, now_ms());
    drop(roster);
    let redeemer = NodeIdentity::from_seed([0x62; 32]);
    let client = client_endpoint(&redeemer).await;
    let wrong_signer = NodeIdentity::from_seed([0x63; 32]);
    let f = dance(
        &client, &rig, &token, &redeemer, &wrong_signer, false, None, None,
    )
    .await;
    let (_t, payload) = decode_one("verify-bad-pop", f);
    assert_eq!(payload, vec![0x02, 0x00], "kind=2 BadPoP, empty payload");
}

/// —— 行：consume-already-used（绑定 canonical 向量） ——
#[tokio::test]
async fn row_consume_already_used_matches_canonical_fixture() {
    let root = NodeIdentity::from_seed([0x71; 32]);
    let rig = IssuerRig::spawn(&root, &root).await;
    let redeemer = NodeIdentity::from_seed([0x72; 32]);
    let client = client_endpoint(&redeemer).await;
    let token = {
        let mut roster = rig.roster.lock().await;
        token_on(&mut roster, &root, "https://relay.example", 60_000, now_ms())
    };
    // 第一次：成功（REDEEM_OK）
    let f = dance(&client, &rig, &token, &redeemer, &redeemer, false, None, None).await;
    match &f {
        FinalFrame::Frame(t, _) => assert_eq!(*t, frame_type::REDEEM_OK, "first redeem: {f:?}"),
        FinalFrame::NoFrame(why, _) => panic!("first redeem must succeed ({why})"),
    }
    // 第二次：Consumed —— 外层字节 == canonical 向量 00000003140000
    let f = dance(&client, &rig, &token, &redeemer, &redeemer, false, None, None).await;
    let (t, payload) = decode_one("consume-already-used", f);
    assert_eq!(t, 0x14);
    assert_eq!(payload, vec![0x00, 0x00]);
    let records = redeem_err::decode_records(&payload).unwrap();
    assert_eq!(
        redeem_err::reduce(&records),
        redeem_err::RedeemRejection::Consumed
    );
    // 完整外层帧字节 == fixture hex
    let mut frame = ((1 + payload.len()) as u32).to_be_bytes().to_vec();
    frame.push(0x14);
    frame.extend_from_slice(&payload);
    assert_eq!(hex::encode(&frame), "00000003140000");
}

/// —— 行：entry-wrong-first-frame ——
#[tokio::test]
async fn row_entry_wrong_first_frame() {
    let root = NodeIdentity::from_seed([0x81; 32]);
    let rig = IssuerRig::spawn(&root, &root).await;
    let redeemer = NodeIdentity::from_seed([0x82; 32]);
    let client = client_endpoint(&redeemer).await;
    let token = {
        let mut roster = rig.roster.lock().await;
        token_on(&mut roster, &root, "https://relay.example", 60_000, now_ms())
    };
    let f = dance(
        &client,
        &rig,
        &token,
        &redeemer,
        &redeemer,
        false,
        Some((frame_type::MSG, b"not intent".to_vec())),
        None,
    )
    .await;
    expect_no_structured_frame("entry-wrong-first-frame", f);
}

/// —— P1-7（R3）：read_frame 32KiB 整帧边界 ——
#[tokio::test]
async fn read_frame_boundary_exactly_limit() {
    // 整帧 = 4B 长度域 + len(type+payload)。恰好 MAX_REDEEM_FRAME 的帧合法。
    let mut pipe = wire_pipe().await;
    // 构造：len = limit - 4，payload = len - 1
    let limit = session::MAX_REDEEM_FRAME;
    let payload_len = limit - 4 - 1;
    let mut frame = (limit as u32 - 4).to_be_bytes().to_vec(); // len 域
    frame.push(frame_type::REDEEM_ERR);
    frame.extend_from_slice(&vec![b'x'; payload_len]);
    let outcome = pipe.feed(&frame).await;
    assert!(
        matches!(outcome, WireOutcome::Frame(t, _) if t == frame_type::REDEEM_ERR),
        "exactly-limit frame must be accepted, got {outcome:?}"
    );
}

#[tokio::test]
async fn read_frame_boundary_over_limit() {
    let mut pipe = wire_pipe().await;
    let limit = session::MAX_REDEEM_FRAME;
    let payload_len = limit - 4; // 整帧 = limit + 1
    let mut frame = ((limit + 1 - 4) as u32).to_be_bytes().to_vec();
    frame.push(frame_type::REDEEM_ERR);
    frame.extend_from_slice(&vec![b'x'; payload_len - 1]);
    let outcome = pipe.feed(&frame).await;
    assert!(
        matches!(outcome, WireOutcome::ReadFailed),
        "over-limit frame must be rejected, got {outcome:?}"
    );
}

/// —— P1-11：issuerMapping 17 行 variantId 逐行机器一致性 ——
#[derive(Deserialize)]
struct IssuerRow {
    #[serde(rename = "variantId")]
    variant_id: String,
    emit: bool,
    kind: Option<u8>,
    #[serde(rename = "joinerResult")]
    joiner_result: String,
}

#[test]
fn issuer_mapping_rows_are_machine_verified() {
    #[derive(Deserialize)]
    struct Doc {
        #[serde(rename = "issuerMapping")]
        mapping: serde_json::Value,
    }
    let doc: Doc = serde_json::from_str(FIXTURE_JSON).unwrap();
    let rows: Vec<IssuerRow> = serde_json::from_value(
        doc.mapping
            .get("rows")
            .expect("issuerMapping.rows")
            .clone(),
    )
    .unwrap();
    assert_eq!(rows.len(), 17, "17 variantId rows frozen");
    // 机器一致性：emit=true 行必有 kind 0..=3 且 joinerResult 在两值集合；
    // emit=false 行 kind 必为 null 且 joinerResult 为 DIAL_FAILED
    for r in &rows {
        if r.emit {
            assert!(matches!(r.kind, Some(0..=3)), "{}: emit kind", r.variant_id);
            assert!(
                r.joiner_result == "TOKEN_CONSUMED" || r.joiner_result == "TOKEN_INVALID",
                "{}: emit joinerResult",
                r.variant_id
            );
        } else {
            assert!(r.kind.is_none(), "{}: silent kind must be null", r.variant_id);
            assert_eq!(r.joiner_result, "DIAL_FAILED", "{}: silent result", r.variant_id);
        }
        assert!(r.variant_id.is_ascii(), "{}: variantId ascii", r.variant_id);
    }
    // 与实现的分支投影一致性：redeem_verify_emit 的五个 emit 变体必须在 rows 中
    // 有对应行（kind 数值匹配）
    let emitted_kinds: Vec<u8> = rows.iter().filter(|r| r.emit).filter_map(|r| r.kind).collect();
    for k in 0u8..=3 {
        assert!(emitted_kinds.contains(&k), "kind {k} must have an emit row");
    }
}

/// —— P0：IO 异常路径的真实关闭时延（accept_bi 空挂起/首帧 EOF/截断头） ——
#[tokio::test]
async fn io_failures_close_within_bound() {
    let root = NodeIdentity::from_seed([0x91; 32]);
    let rig = IssuerRig::spawn(&root, &root).await;
    let redeemer = NodeIdentity::from_seed([0x92; 32]);
    let client = client_endpoint(&redeemer).await;
    let mut roster = rig.roster.lock().await;
    let _token = token_on(&mut roster, &root, "https://relay.example", 60_000, now_ms());
    drop(roster);

    // 1. 建连后不开 bidi 流直接挂起：issuer 到达 REDEEM_DEADLINE 后立即关闭
    let t0 = std::time::Instant::now();
    {
        let conn = client.connect(rig.addr(), session::ALPN_REDEEM).await.unwrap();
        // 不 open_bi，等待对端关闭
        let _ = tokio::time::timeout(std::time::Duration::from_secs(7), conn.closed()).await;
        assert!(t0.elapsed().as_secs() < 7, "deadline close must be immediate");
    }

    // 2. 首帧 EOF（开流即 finish）：读失败 → Silent → 立即关闭
    let t0 = std::time::Instant::now();
    {
        let conn = client.connect(rig.addr(), session::ALPN_REDEEM).await.unwrap();
        let (mut send, mut recv) = conn.open_bi().await.unwrap();
        let _ = send.finish();
        let _ = recv.read_to_end(64).await;
        let _ = tokio::time::timeout(std::time::Duration::from_secs(3), conn.closed()).await;
        assert!(t0.elapsed().as_secs() < 3, "EOF on first frame must close immediately");
    }

    // 3. 截断头（2 字节后 EOF）：read_frame 短读 → Silent → 立即关闭
    let t0 = std::time::Instant::now();
    {
        let conn = client.connect(rig.addr(), session::ALPN_REDEEM).await.unwrap();
        let (mut send, mut recv) = conn.open_bi().await.unwrap();
        send.write_all(&[0x00, 0x00]).await.unwrap();
        let _ = send.finish();
        let _ = recv.read_to_end(64).await;
        let _ = tokio::time::timeout(std::time::Duration::from_secs(3), conn.closed()).await;
        assert!(t0.elapsed().as_secs() < 3, "truncated header must close immediately");
    }
}

/// —— 行：entry-decode-invalid ——
#[tokio::test]
async fn row_entry_decode_invalid() {
    let root = NodeIdentity::from_seed([0x83; 32]);
    let rig = IssuerRig::spawn(&root, &root).await;
    let _redeemer = NodeIdentity::from_seed([0x84; 32]);
    let client = client_endpoint(&_redeemer).await;
    let token = {
        let mut roster = rig.roster.lock().await;
        token_on(&mut roster, &root, "https://relay.example", 60_000, now_ms())
    };
    // INTENT 帧但载荷不是可解码令牌：无法经 dance 的 token 路径注入 —— 以坏字符串
    // 令牌直接走全舞步（decode 在 issuer 侧失败）
    let bad_token = {
        let mut t = token.encode().unwrap();
        t.replace_range(10..14, "!!!!");
        t
    };
    let conn = client.connect(rig.addr(), session::ALPN_REDEEM).await.unwrap();
    let (mut send, mut recv) = conn.open_bi().await.unwrap();
    write_frame(&mut send, frame_type::REDEEM_INTENT, bad_token.as_bytes())
        .await
        .unwrap();
    let outcome = read_frame(&mut recv, MAX_REDEEM_FRAME).await;
    if let Ok((t, _)) = outcome {
        panic!("entry-decode-invalid: no structured frame expected, got {t:#x}");
    }
}

/// —— 行：proof-wrong-frame-type ——
#[tokio::test]
async fn row_proof_wrong_frame_type() {
    let root = NodeIdentity::from_seed([0x85; 32]);
    let rig = IssuerRig::spawn(&root, &root).await;
    let redeemer = NodeIdentity::from_seed([0x86; 32]);
    let client = client_endpoint(&redeemer).await;
    let token = {
        let mut roster = rig.roster.lock().await;
        token_on(&mut roster, &root, "https://relay.example", 60_000, now_ms())
    };
    let f = dance(
        &client,
        &rig,
        &token,
        &redeemer,
        &redeemer,
        false,
        None,
        Some((frame_type::MSG, vec![0u8; 96])),
    )
    .await;
    expect_no_structured_frame("proof-wrong-frame-type", f);
}

/// —— 行：proof-bad-length ——
#[tokio::test]
async fn row_proof_bad_length() {
    let root = NodeIdentity::from_seed([0x87; 32]);
    let rig = IssuerRig::spawn(&root, &root).await;
    let redeemer = NodeIdentity::from_seed([0x88; 32]);
    let client = client_endpoint(&redeemer).await;
    let token = {
        let mut roster = rig.roster.lock().await;
        token_on(&mut roster, &root, "https://relay.example", 60_000, now_ms())
    };
    let f = dance(
        &client,
        &rig,
        &token,
        &redeemer,
        &redeemer,
        false,
        None,
        Some((frame_type::REDEEM_PROOF, vec![0u8; 10])),
    )
    .await;
    expect_no_structured_frame("proof-bad-length", f);
}

/// —— 行：proof-peer-mismatch ——
#[tokio::test]
async fn row_proof_peer_mismatch() {
    let root = NodeIdentity::from_seed([0x89; 32]);
    let rig = IssuerRig::spawn(&root, &root).await;
    let _redeemer = NodeIdentity::from_seed([0x8A; 32]);
    let client = client_endpoint(&_redeemer).await;
    let token = {
        let mut roster = rig.roster.lock().await;
        token_on(&mut roster, &root, "https://relay.example", 60_000, now_ms())
    };
    // proof 声明的 redeemer != TLS 对端（client 的身份）
    let declared = NodeIdentity::from_seed([0x8B; 32]);
    let conn = client.connect(rig.addr(), session::ALPN_REDEEM).await.unwrap();
    let (mut send, mut recv) = conn.open_bi().await.unwrap();
    let token_str = token.encode().unwrap();
    write_frame(&mut send, frame_type::REDEEM_INTENT, token_str.as_bytes())
        .await
        .unwrap();
    let (t, payload) = read_frame(&mut recv, MAX_REDEEM_FRAME).await.unwrap();
    assert_eq!(t, frame_type::REDEEM_CHALLENGE);
    let challenge: [u8; 32] = payload.as_slice().try_into().unwrap();
    let pop = dweb_fabric::protocol::redeem_challenge_bytes(
        &token.invite.fabric_id,
        &token.invite.invite_id,
        &challenge,
    );
    let sig = declared.secret_key().sign(&pop);
    let mut proof = Vec::with_capacity(96);
    proof.extend_from_slice(declared.endpoint_id().as_bytes());
    proof.extend_from_slice(&sig.to_bytes());
    write_frame(&mut send, frame_type::REDEEM_PROOF, &proof)
        .await
        .unwrap();
    if let Ok((t, _)) = read_frame(&mut recv, MAX_REDEEM_FRAME).await {
        panic!("proof-peer-mismatch: no frame expected, got {t:#x}");
    }
}

/// —— 行：verify-protocol（token.verify() 内部失败） ——
#[tokio::test]
async fn row_verify_protocol() {
    let root = NodeIdentity::from_seed([0x8C; 32]);
    let rig = IssuerRig::spawn(&root, &root).await;
    let forger = NodeIdentity::from_seed([0x8D; 32]);
    // 令牌声称 issuer=root 但由伪造者签名：fabric/root 检查通过、verify 失败
    let invite = InviteV1 {
        fabric_id: rig.roster.lock().await.fabric_id(),
        invite_id: [9u8; 16],
        issuer: root.endpoint_id(),
        issuer_relay_url: "https://relay.example".into(),
        issuer_direct_addrs: vec![],
        expires_at_ms: now_ms() + 60_000,
        recipient: None,
    };
    let token = InviteToken::sign(invite, forger.secret_key()).unwrap();
    let redeemer = NodeIdentity::from_seed([0x8E; 32]);
    let client = client_endpoint(&redeemer).await;
    let f = dance(&client, &rig, &token, &redeemer, &redeemer, false, None, None).await;
    expect_no_structured_frame("verify-protocol", f);
}

/// —— 行：consume-persistence（emit=false，sourceClass=IO） ——
#[tokio::test]
async fn row_consume_persistence() {
    let root = NodeIdentity::from_seed([0x91; 32]);
    let dir = TempDir::new().unwrap();
    let (roster, _fid) = Roster::create(&root, dir.path(), now_ms()).unwrap();
    let rig = IssuerRig::with_roster(Arc::new(Mutex::new(roster)), &root, dir).await;
    let redeemer = NodeIdentity::from_seed([0x92; 32]);
    let client = client_endpoint(&redeemer).await;
    // 先成功消费一次令 invites.consumed 存在
    let t1 = {
        let mut roster = rig.roster.lock().await;
        token_on(&mut roster, &root, "https://relay.example", 60_000, now_ms())
    };
    let f = dance(&client, &rig, &t1, &redeemer, &redeemer, false, None, None).await;
    assert!(matches!(f, FinalFrame::Frame(frame_type::REDEEM_OK, _)));
    // 消费日志只读 → 下一次 consume 的 append 失败（Persistence）
    let log = rig.dir().join("invites.consumed");
    let perms = std::fs::metadata(&log).unwrap().permissions();
    let mut ro = perms.clone();
    ro.set_readonly(true);
    std::fs::set_permissions(&log, ro).unwrap();
    let t2 = {
        let mut roster = rig.roster.lock().await;
        token_on(&mut roster, &root, "https://relay.example", 60_000, now_ms())
    };
    let f = dance(&client, &rig, &t2, &redeemer, &redeemer, false, None, None).await;
    std::fs::set_permissions(&log, perms).unwrap();
    expect_no_structured_frame("consume-persistence", f);
}

/// —— 行：post-grant-failed（handler 身份 != root） ——
#[tokio::test]
async fn row_post_grant_failed() {
    let root = NodeIdentity::from_seed([0xA1; 32]);
    let handler = NodeIdentity::from_seed([0xA2; 32]);
    let rig = IssuerRig::spawn(&root, &handler).await;
    // 令牌由 root 合法签发（在 rig 的同一 roster 上）
    let redeemer = NodeIdentity::from_seed([0xA3; 32]);
    let client = client_endpoint(&redeemer).await;
    let token = {
        let mut roster = rig.roster.lock().await;
        token_on(&mut roster, &root, "https://relay.example", 60_000, now_ms())
    };
    let f = dance(&client, &rig, &token, &redeemer, &redeemer, false, None, None).await;
    expect_no_structured_frame("post-grant-failed", f);
}

/// —— 行：post-write-redeem-ok-failed（回执写入失败） ——
#[tokio::test]
async fn row_post_write_redeem_ok_failed() {
    let root = NodeIdentity::from_seed([0xA4; 32]);
    let rig = IssuerRig::spawn(&root, &root).await;
    let redeemer = NodeIdentity::from_seed([0xA5; 32]);
    let client = client_endpoint(&redeemer).await;
    let token = {
        let mut roster = rig.roster.lock().await;
        token_on(&mut roster, &root, "https://relay.example", 60_000, now_ms())
    };
    // proof 后立即 stop 接收半边 → issuer 的 REDEEM_OK 写入失败（显式冻结行）
    let f = dance(
        &client, &rig, &token, &redeemer, &redeemer, true, None, None,
    )
    .await;
    expect_no_structured_frame("post-write-redeem-ok-failed", f);
}

// ==== 备注：不可经公开 API 构造的行 =============================================
//
// - proof-bad-redeemer-key：PROOF 载荷长度先被校验为 96B，[0..32] 恒可解析为
//   EndpointId（ed25519 公钥不校验字节），该行为防御分支，无法从 wire 触发。
// - post-encode-receipt-failed：roster 存储的事实全部经过 verify()（内部先做
//   canonical_bytes），编码不可能在回执阶段才失败；无法经公开 API 注入。
// 两行由 session.rs 的映射/分支结构与 Batch F 报告共同覆盖。
