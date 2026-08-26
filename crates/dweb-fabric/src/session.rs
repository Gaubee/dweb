//! 会话层：双 ALPN（常规 + 兑换）、两侧门控、帧编解码与资源上限、路径观测。
//! 规格：openspec/changes/fabric-mvp/specs/fabric/session/spec.md

use crate::identity::EndpointId;
use crate::protocol::{InviteToken, SignedFact, random_bytes, redeem_challenge_bytes};
use crate::roster::Roster;
use iroh::endpoint::{Connection, RecvStream, SendStream};
use iroh::{EndpointAddr, RelayUrl};
use std::sync::Arc;
use thiserror::Error;

pub const ALPN_REGULAR: &[u8] = b"/dweb/fabric/1";
pub const ALPN_REDEEM: &[u8] = b"/dweb/fabric-redeem/1";

/// 常规通道单帧上限（含头）
pub const MAX_FRAME: usize = 1024 * 1024;
/// 兑换通道单帧上限（含头）
pub const MAX_REDEEM_FRAME: usize = 32 * 1024;
/// 兑换通道整体时限
pub const REDEEM_DEADLINE: std::time::Duration = std::time::Duration::from_secs(5);
/// 单次名册同步的事实数上限（超限按协议错误处理）
pub const MAX_HELLO_FACTS: usize = 10_000;

#[derive(Debug, Error)]
pub enum SessionError {
    #[error("frame exceeds limit {limit}B")]
    FrameTooLarge { limit: usize },
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("protocol: {0}")]
    Protocol(#[from] crate::protocol::ProtocolError),
    #[error("roster: {0}")]
    Roster(#[from] crate::roster::RosterError),
    #[error("peer {0} is not a member")]
    NotMember(String),
    #[error("peer {0} not connected")]
    NotConnected(String),
    #[error("no addressing information for {0} (need relay or direct addr)")]
    NoAddressingInfo(String),
    #[error("redeem rejected: {0}")]
    RedeemRejected(String),
    #[error("connect: {0}")]
    Connect(String),
    #[error("identity: {0}")]
    Identity(#[from] crate::identity::IdentityError),
    #[error("connection: {0}")]
    Connection(#[from] iroh::endpoint::ConnectionError),
    #[error("stream closed")]
    StreamClosed,
}

/// 控制流帧类型
pub mod frame_type {
    pub const HELLO: u8 = 0x01;
    pub const MSG: u8 = 0x03;
    pub const REDEEM_INTENT: u8 = 0x10;
    pub const REDEEM_CHALLENGE: u8 = 0x11;
    pub const REDEEM_PROOF: u8 = 0x12;
    pub const REDEEM_OK: u8 = 0x13;
    pub const REDEEM_ERR: u8 = 0x14;
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 帧头：u32 BE 长度（type + payload）+ u8 类型
pub async fn write_frame(
    send: &mut SendStream,
    frame_type: u8,
    payload: &[u8],
) -> Result<(), SessionError> {
    let mut buf = Vec::with_capacity(5 + payload.len());
    buf.extend_from_slice(&((1 + payload.len()) as u32).to_be_bytes());
    buf.push(frame_type);
    buf.extend_from_slice(payload);
    send.write_all(&buf)
        .await
        .map_err(|e| SessionError::Io(std::io::Error::other(e.to_string())))?;
    Ok(())
}

/// 读一帧。`limit` 限制整帧（含头）大小；超限返回 FrameTooLarge，不预分配。
pub async fn read_frame(
    recv: &mut RecvStream,
    limit: usize,
) -> Result<(u8, Vec<u8>), SessionError> {
    let mut head = [0u8; 5];
    recv.read_exact(&mut head)
        .await
        .map_err(|e| SessionError::Io(std::io::Error::other(e.to_string())))?;
    // len 覆盖 type(1B) + payload；type 已随头消费，故 payload 长 len-1
    let len = u32::from_be_bytes(head[0..4].try_into().unwrap()) as usize;
    if len == 0 || 5 + len > limit {
        return Err(SessionError::FrameTooLarge { limit });
    }
    let mut payload = vec![0u8; len - 1];
    recv.read_exact(&mut payload)
        .await
        .map_err(|e| SessionError::Io(std::io::Error::other(e.to_string())))?;
    Ok((head[4], payload))
}

/// 当前承载路径类型（path_events 归纳）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkStatus {
    Direct,
    Relay,
    Unknown,
}

/// 监听一条连接的 path_events，把选中路径归纳为 LinkStatus 回写并在变化时发事件。
pub fn spawn_path_watcher(
    conn: Connection,
    tx: Arc<std::sync::Mutex<LinkStatus>>,
    events_tx: tokio::sync::broadcast::Sender<crate::FabricEvent>,
    endpoint_id: EndpointId,
) {
    use n0_future::StreamExt;
    let mut events = conn.path_events();
    tokio::spawn(async move {
        let mut last: Option<LinkStatus> = None;
        while let Some(ev) = events.next().await {
            if !matches!(&ev, iroh::endpoint::PathEvent::Selected { .. }) {
                continue;
            }
            let status = conn
                .paths()
                .iter()
                .find(|p| p.is_selected())
                .map(|p| match p.remote_addr() {
                    iroh_base::TransportAddr::Ip(_) => LinkStatus::Direct,
                    iroh_base::TransportAddr::Relay(_) => LinkStatus::Relay,
                    _ => LinkStatus::Unknown,
                })
                .unwrap_or(LinkStatus::Unknown);
            *tx.lock().unwrap() = status;
            if last != Some(status) {
                last = Some(status);
                let _ = events_tx.send(crate::FabricEvent::PathChanged {
                    endpoint_id: crate::identity::endpoint_id_display(&endpoint_id),
                    status,
                });
            }
        }
    });
}

/// 发起方控制流握手：开唯一控制 bidi 流并发送 HELLO（全量事实），读回对端 HELLO。
/// 返回 (对端事实, 控制流写半边)。
pub async fn dialer_hello(
    conn: &Connection,
    hello_dump: Vec<u8>,
) -> Result<(Vec<SignedFact>, SendStream), SessionError> {
    let (mut send, mut recv) = conn.open_bi().await?;
    let dump = hello_dump;
    write_frame(&mut send, frame_type::HELLO, &dump).await?;
    let (t, payload) = read_frame(&mut recv, MAX_FRAME).await?;
    if t != frame_type::HELLO {
        return Err(SessionError::RedeemRejected(format!(
            "expect HELLO, got {t:#x}"
        )));
    }
    let facts = SignedFact::decode_all(&payload)?;
    if facts.len() > MAX_HELLO_FACTS {
        return Err(SessionError::FrameTooLarge {
            limit: MAX_HELLO_FACTS,
        });
    }
    Ok((facts, send))
}

/// 接受方控制流处理：读 HELLO → merge → 回 HELLO。返回 (到达事实, 控制流写半边)。
pub async fn acceptor_hello(
    conn: &Connection,
    roster: &Arc<tokio::sync::Mutex<Roster>>,
) -> Result<(Vec<SignedFact>, SendStream), SessionError> {
    let (mut send, mut recv) = conn.accept_bi().await?;
    let (t, payload) = read_frame(&mut recv, MAX_FRAME).await?;
    if t != frame_type::HELLO {
        return Err(SessionError::RedeemRejected(format!(
            "expect HELLO, got {t:#x}"
        )));
    }
    let incoming = SignedFact::decode_all(&payload)?;
    if incoming.len() > MAX_HELLO_FACTS {
        return Err(SessionError::FrameTooLarge {
            limit: MAX_HELLO_FACTS,
        });
    }
    roster.lock().await.merge(incoming.iter().cloned())?;
    let dump = {
        let r = roster.lock().await;
        SignedFact::encode_all(r.facts())?
    };
    write_frame(&mut send, frame_type::HELLO, &dump).await?;
    Ok((incoming, send))
}

/// 兑换（B 侧）：连 issuer 的 redeem ALPN，challenge-response，返回回执事实列表。
pub async fn redeem_as_joiner(
    conn: &Connection,
    token: &InviteToken,
    secret: &iroh_base::SecretKey,
    redeemer: &EndpointId,
) -> Result<Vec<SignedFact>, SessionError> {
    tokio::time::timeout(REDEEM_DEADLINE, async {
        let (mut send, mut recv) = conn.open_bi().await?;
        let token_str = token.encode()?;
        write_frame(&mut send, frame_type::REDEEM_INTENT, token_str.as_bytes()).await?;

        let (t, challenge) = read_frame(&mut recv, MAX_REDEEM_FRAME).await?;
        if t != frame_type::REDEEM_CHALLENGE {
            return Err(SessionError::RedeemRejected("expect challenge".into()));
        }
        let challenge: [u8; 32] = challenge
            .as_slice()
            .try_into()
            .map_err(|_| SessionError::RedeemRejected("bad challenge length".into()))?;
        let pop =
            redeem_challenge_bytes(&token.invite.fabric_id, &token.invite.invite_id, &challenge);
        let sig = secret.sign(&pop);

        let mut proof = Vec::with_capacity(32 + 64);
        proof.extend_from_slice(redeemer.as_bytes());
        proof.extend_from_slice(&sig.to_bytes());
        write_frame(&mut send, frame_type::REDEEM_PROOF, &proof).await?;

        let (t, payload) = read_frame(&mut recv, MAX_REDEEM_FRAME).await?;
        match t {
            frame_type::REDEEM_OK => Ok(SignedFact::decode_all(&payload)?),
            frame_type::REDEEM_ERR => Err(SessionError::RedeemRejected(
                String::from_utf8_lossy(&payload).into_owned(),
            )),
            other => Err(SessionError::RedeemRejected(format!(
                "unexpected frame {other:#x}"
            ))),
        }
    })
    .await
    .map_err(|_| SessionError::RedeemRejected("redeem deadline exceeded".into()))?
}

/// 兑换（issuer 侧）：单 bidi 流 + 整体时限；成功即已签发 Grant 并回执全量 dump。
pub async fn handle_redeem_as_issuer(
    conn: &Connection,
    roster: &Arc<tokio::sync::Mutex<Roster>>,
    identity: &crate::identity::NodeIdentity,
) -> Result<(), SessionError> {
    // PoP 声明的 redeemer 必须等于 TLS 已认证的连接对端
    let expected_remote = conn.remote_id();
    tokio::time::timeout(REDEEM_DEADLINE, async {
        let (mut send, mut recv) = conn.accept_bi().await?;
        let (t, payload) = read_frame(&mut recv, MAX_REDEEM_FRAME).await?;
        if t != frame_type::REDEEM_INTENT {
            let _ = write_frame(
                &mut send,
                frame_type::REDEEM_ERR,
                b"first frame must be redeem intent",
            )
            .await;
            return Err(SessionError::RedeemRejected("bad first frame".into()));
        }
        let token_str = String::from_utf8_lossy(&payload).into_owned();
        let token = match InviteToken::decode(&token_str) {
            Ok(t) => t,
            Err(e) => {
                let _ =
                    write_frame(&mut send, frame_type::REDEEM_ERR, e.to_string().as_bytes()).await;
                return Err(SessionError::RedeemRejected(e.to_string()));
            }
        };

        let challenge = random_bytes::<32>();
        write_frame(&mut send, frame_type::REDEEM_CHALLENGE, &challenge).await?;

        let (t, payload) = read_frame(&mut recv, MAX_REDEEM_FRAME).await?;
        if t != frame_type::REDEEM_PROOF {
            return Err(SessionError::RedeemRejected("expect proof".into()));
        }
        if payload.len() != 32 + 64 {
            return Err(SessionError::RedeemRejected("bad proof length".into()));
        }
        let redeemer = EndpointId::from_bytes(payload[0..32].try_into().unwrap())
            .map_err(|_| SessionError::RedeemRejected("bad redeemer key".into()))?;
        let sig = iroh_base::Signature::from_bytes(payload[32..96].try_into().unwrap());
        if redeemer != expected_remote {
            return Err(SessionError::RedeemRejected(
                "redeemer key does not match TLS peer".into(),
            ));
        }

        let mut r = roster.lock().await;
        // 过期判断取当前时间，而非任务开始时的快照
        if let Err(e) = r.redeem_verify(&token, &redeemer, &challenge, &sig, now_ms()) {
            let _ = write_frame(&mut send, frame_type::REDEEM_ERR, e.to_string().as_bytes()).await;
            return Err(SessionError::RedeemRejected(e.to_string()));
        }
        if !r.consume_invite(&token.invite.invite_id, now_ms())? {
            return Err(SessionError::RedeemRejected(
                "invite already consumed".into(),
            ));
        }
        r.grant(identity, redeemer, None, None, now_ms())?;
        // grant 已入库，回执 = 全量事实 dump（joiner 首次获得名册）
        let receipt = SignedFact::encode_all(r.facts())?;
        write_frame(&mut send, frame_type::REDEEM_OK, &receipt).await?;
        // 半关闭发送侧，让回执在连接关闭前可靠送达
        let _ = send.finish();
        Ok(())
    })
    .await
    .map_err(|_| SessionError::RedeemRejected("redeem deadline exceeded".into()))?
}

/// 由邀请令牌构造对 issuer 的 EndpointAddr（relay + 直连地址）。
pub fn endpoint_addr_from_invite(token: &InviteToken) -> Result<EndpointAddr, SessionError> {
    let mut addr = EndpointAddr::new(token.invite.issuer);
    if let Ok(url) = token.invite.issuer_relay_url.parse::<RelayUrl>() {
        addr = addr.with_relay_url(url);
    }
    for a in &token.invite.issuer_direct_addrs {
        if let Ok(ip) = a.parse::<std::net::SocketAddr>() {
            addr = addr.with_ip_addr(ip);
        }
    }
    if addr.addrs.is_empty() {
        return Err(SessionError::NoAddressingInfo(
            crate::identity::endpoint_id_display(&token.invite.issuer),
        ));
    }
    Ok(addr)
}
