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

// ---- 兑换拒绝的 wire discriminant（connectivity-ux-hardening D11） --------------
//
// 权威契约：openspec/changes/connectivity-ux-hardening/contracts/redeem-err.fixtures.json
//（外层帧 = 既有 write_frame/read_frame，type=REDEEM_ERR(0x14)；记录 = kind(1B)+len(1B,0..255)+payload；
//  段短读 = 协议违规关连接；多记录 reduction fail-closed；payload 呈现层仅可打印 ASCII）。

pub mod redeem_err {
    /// 记录 kind 值（wire discriminant）
    pub mod kind {
        pub const CONSUMED: u8 = 0x00;
        pub const NOT_ROOT: u8 = 0x01;
        pub const BAD_POP: u8 = 0x02;
        pub const OTHER: u8 = 0x03;
    }

    /// issuer 侧可结构化发送的拒绝种类（未知值仅存在于解码侧）。
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum RedeemErrorKind {
        /// invite_id 已被消费（0x00）。
        Consumed,
        /// 令牌签发者不是 fabric root（0x01）。
        NotRoot,
        /// 拥有权证明验证失败（0x02）。
        BadPoP,
        /// 其它结构化原因（0x03；载荷经归一化）。
        Other(String),
    }

    impl RedeemErrorKind {
        pub fn kind_byte(&self) -> u8 {
            match self {
                Self::Consumed => kind::CONSUMED,
                Self::NotRoot => kind::NOT_ROOT,
                Self::BadPoP => kind::BAD_POP,
                Self::Other(_) => kind::OTHER,
            }
        }

        /// 单条记录编码：`kind(1B) + len(1B) + payload`（len 恒 ≤ 255）。
        pub fn encode_record(&self) -> Vec<u8> {
            let payload = match self {
                Self::Other(reason) => normalize_payload(reason),
                _ => Vec::new(),
            };
            let mut out = Vec::with_capacity(2 + payload.len());
            out.push(self.kind_byte());
            out.push(payload.len() as u8);
            out.extend_from_slice(&payload);
            out
        }
    }

    /// 载荷归一化（契约 _normalization）：UTF-8 → 剥除非可打印 ASCII
    /// （<0x20 与 >0x7E，删除不替换）→ 截断至 255 字节。
    pub fn normalize_payload(reason: &str) -> Vec<u8> {
        reason
            .as_bytes()
            .iter()
            .copied()
            .filter(|b| (0x20..=0x7E).contains(b))
            .take(255)
            .collect()
    }

    /// 解码侧的一条记录（kind 可为未知值，payload 按 len 原样消费）。
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct RedeemRecord {
        pub kind: u8,
        pub payload: Vec<u8>,
    }

    impl RedeemRecord {
        /// 呈现层：仅保留可打印 ASCII（非 UTF-8 字节按 lossy 解码后剥除）。
        pub fn presented(&self) -> String {
            String::from_utf8_lossy(&self.payload)
                .chars()
                .filter(|c| c.is_ascii_graphic() || *c == ' ')
                .collect()
        }

        /// 归约视角的 kind：未知值降级为 Other("unknown-kind") 语义。
        pub fn is_consumed(&self) -> bool {
            self.kind == kind::CONSUMED
        }
    }

    /// 记录段短读（kind/len/payload 任一段不足，含外层 payload 末尾的不完整记录）。
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct RecordShortRead {
        pub at: usize,
    }

    impl std::fmt::Display for RecordShortRead {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "redeem error record short read at offset {}", self.at)
        }
    }
    impl std::error::Error for RecordShortRead {}

    /// 解码外层 REDEEM_ERR payload 内的全部记录。
    /// 额外完整字节按下一记录解析；任何段不足即协议违规。
    pub fn decode_records(payload: &[u8]) -> Result<Vec<RedeemRecord>, RecordShortRead> {
        let mut out = Vec::new();
        let mut off = 0usize;
        while off < payload.len() {
            if off + 2 > payload.len() {
                return Err(RecordShortRead { at: off });
            }
            let kind = payload[off];
            let len = payload[off + 1] as usize;
            if off + 2 + len > payload.len() {
                return Err(RecordShortRead { at: off });
            }
            out.push(RedeemRecord {
                kind,
                payload: payload[off + 2..off + 2 + len].to_vec(),
            });
            off += 2 + len;
        }
        Ok(out)
    }

    /// 多记录 reduction 后的结构化拒绝结果（join 侧归类输入）。
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum RedeemRejection {
        /// 恰一条 Consumed → TOKEN_CONSUMED。
        Consumed,
        /// 其它一切（恰一条已知 kind / 多条 fail-closed / 未知 kind 按
        /// Other("unknown-kind") 参与判定）→ TOKEN_INVALID。
        Invalid { reason: String },
    }

    impl std::fmt::Display for RedeemRejection {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                Self::Consumed => f.write_str("invite already consumed"),
                Self::Invalid { reason } => write!(f, "invite rejected: {reason}"),
            }
        }
    }

    impl std::error::Error for RedeemRejection {}

    /// fail-closed 归约。空 payload（零记录）按违规处理由调用方先行拒绝。
    pub fn reduce(records: &[RedeemRecord]) -> RedeemRejection {
        if records.len() == 1 {
            let r = &records[0];
            let rejection_reason = |fallback: &str| {
                let presented = r.presented();
                if presented.is_empty() {
                    fallback.to_owned()
                } else {
                    presented
                }
            };
            return match r.kind {
                kind::CONSUMED => RedeemRejection::Consumed,
                kind::NOT_ROOT => RedeemRejection::Invalid {
                    reason: rejection_reason("not root"),
                },
                kind::BAD_POP => RedeemRejection::Invalid {
                    reason: rejection_reason("bad proof-of-possession"),
                },
                kind::OTHER => RedeemRejection::Invalid {
                    reason: rejection_reason("other"),
                },
                unknown => RedeemRejection::Invalid {
                    reason: format!("unknown-kind {unknown:#04x}"),
                },
            };
        }
        // 多条：fail-closed，完整消费不位移。
        RedeemRejection::Invalid {
            reason: format!(
                "multiple redeem error records ({}) fail-closed",
                records.len()
            ),
        }
    }
}

/// joiner 侧兑换结果错误（Fabric::join 据此归类 D11 八码）。
#[derive(Debug, Error)]
pub enum RedeemError {
    /// issuer 的结构化拒绝（RedeemErrorKind reduction）。
    #[error("redeem rejected: {0:?}")]
    Rejected(#[source] redeem_err::RedeemRejection),
    /// 非结构化失败：连接中断/IO/坏帧/事实解码/错误帧段短读 → DIAL_FAILED。
    #[error("redeem channel failed: {0}")]
    Unstructured(String),
    /// 兑换通道内层 5s 超时（REDEEM_DEADLINE）→ DIAL_TIMEOUT（附注 redeem timeout）。
    #[error("redeem timeout")]
    Timeout,
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
    // 整帧字节数 = 4B 长度域 + len（type+payload）——恰好等于 limit 的帧合法
    if len == 0 || 4 + len > limit {
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
/// 独立会话入口没有 Fabric 生命周期门；Fabric 内部应使用
/// [`spawn_path_watcher_gated`]。
pub fn spawn_path_watcher(
    conn: Connection,
    tx: Arc<std::sync::Mutex<LinkStatus>>,
    events_tx: tokio::sync::broadcast::Sender<crate::FabricEvent>,
    endpoint_id: EndpointId,
) {
    // [R8-2] 保留独立 session API 的原有语义；Fabric 路径由 gated 入口共享主门。
    spawn_path_watcher_gated(
        conn,
        Arc::new(std::sync::Mutex::new(false)),
        std::sync::Arc::new(std::sync::Mutex::new(false)),
        tx,
        events_tx,
        endpoint_id,
    );
}

/// Fabric 生命周期内的 path watcher；事件发送与 shutdown 主门线性化。
pub fn spawn_path_watcher_gated(
    conn: Connection,
    lifecycle_gate: Arc<std::sync::Mutex<bool>>,
    shutdown_requested: Arc<std::sync::Mutex<bool>>,
    tx: Arc<std::sync::Mutex<LinkStatus>>,
    events_tx: tokio::sync::broadcast::Sender<crate::FabricEvent>,
    endpoint_id: EndpointId,
) -> tokio::task::JoinHandle<()> {
    // lifecycle_gate（R7）：与 shutdown 置位同锁——draining 后抑制 PathChanged
    use n0_future::StreamExt;
    let mut events = conn.path_events();
    tokio::spawn(async move {
        let mut last: Option<LinkStatus> = None;
        while let Some(ev) = events.next().await {
            // [R8-1] 主门后不再更新路径状态或尝试发事件。
            if *shutdown_requested.lock().unwrap() || *lifecycle_gate.lock().unwrap() {
                break;
            }
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
                crate::fabric::FabricInner::emit_gated_on(
                    &lifecycle_gate,
                    &shutdown_requested,
                    &events_tx,
                    crate::FabricEvent::PathChanged {
                        endpoint_id: crate::identity::endpoint_id_display(&endpoint_id),
                        status,
                    },
                );
            }
        }
    })
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
    // 注意：此处不 merge——差集踢除（远端 Revoke 断开既有会话）依赖调用方
    // 在 merge 前取投影快照，必须由 Fabric::merge_and_emit 统一执行。
    let dump = {
        let r = roster.lock().await;
        SignedFact::encode_all(r.facts())?
    };
    write_frame(&mut send, frame_type::HELLO, &dump).await?;
    Ok((incoming, send))
}

/// 任意错误 → 非结构化失败（DIAL_FAILED 附原因）。
fn unstructured<E: std::fmt::Display>(e: E) -> RedeemError {
    RedeemError::Unstructured(e.to_string())
}

/// 兑换（B 侧）：连 issuer 的 redeem ALPN，challenge-response，返回回执事实列表。
/// 失败归类（D11）输入：结构化拒绝 / 非结构化失败 / 内层 5s 超时。
pub async fn redeem_as_joiner(
    conn: &Connection,
    token: &InviteToken,
    secret: &iroh_base::SecretKey,
    redeemer: &EndpointId,
) -> Result<Vec<SignedFact>, RedeemError> {
    tokio::time::timeout(REDEEM_DEADLINE, async {
        let (mut send, mut recv) = conn.open_bi().await.map_err(unstructured)?;
        let token_str = token.encode().map_err(unstructured)?;
        write_frame(&mut send, frame_type::REDEEM_INTENT, token_str.as_bytes())
            .await
            .map_err(unstructured)?;

        let (t, challenge) = read_frame(&mut recv, MAX_REDEEM_FRAME)
            .await
            .map_err(unstructured)?;
        if t != frame_type::REDEEM_CHALLENGE {
            return Err(RedeemError::Unstructured(format!(
                "expect challenge, got frame {t:#x}"
            )));
        }
        let challenge: [u8; 32] = challenge
            .as_slice()
            .try_into()
            .map_err(|_| RedeemError::Unstructured("bad challenge length".into()))?;
        let pop =
            redeem_challenge_bytes(&token.invite.fabric_id, &token.invite.invite_id, &challenge);
        let sig = secret.sign(&pop);

        let mut proof = Vec::with_capacity(32 + 64);
        proof.extend_from_slice(redeemer.as_bytes());
        proof.extend_from_slice(&sig.to_bytes());
        write_frame(&mut send, frame_type::REDEEM_PROOF, &proof)
            .await
            .map_err(unstructured)?;

        let (t, payload) = read_frame(&mut recv, MAX_REDEEM_FRAME)
            .await
            .map_err(unstructured)?;
        match t {
            frame_type::REDEEM_OK => SignedFact::decode_all(&payload)
                .map_err(|e| RedeemError::Unstructured(format!("receipt fact decode failed: {e}"))),
            frame_type::REDEEM_ERR => {
                // 记录段短读（含外层 payload 末尾不完整记录）= 协议违规 → 非结构化
                let records = redeem_err::decode_records(&payload).map_err(|v| {
                    RedeemError::Unstructured(format!("redeem error frame violated wire: {v}"))
                })?;
                if records.is_empty() {
                    return Err(RedeemError::Unstructured(
                        "redeem error frame carries no record".into(),
                    ));
                }
                Err(RedeemError::Rejected(redeem_err::reduce(&records)))
            }
            other => Err(RedeemError::Unstructured(format!(
                "unexpected frame {other:#x}"
            ))),
        }
    })
    .await
    // 等值边界由外层 join deadline 拥有：joinTimeoutMs <= 5s 时外层先到，
    // 此处只有内层真正先到（joinTimeoutMs > 5s）才会产生 Timeout。
    .map_err(|_| RedeemError::Timeout)?
}

/// issuerMapping（contracts/redeem-err.fixtures.json，17 行）中 redeem_verify
/// 阶段五行 emit=true 的映射。返回 None 即 emit=false（无结构化帧直接关闭）。
pub fn redeem_verify_emit(e: &crate::roster::RosterError) -> Option<redeem_err::RedeemErrorKind> {
    use crate::roster::RosterError;
    use redeem_err::RedeemErrorKind;
    match e {
        // ---- redeem_verify 阶段的 5 个 emit=true 行 ----
        RosterError::WrongFabric { got, expected } => Some(RedeemErrorKind::Other(format!(
            "wrong fabric {} vs {}",
            crate::roster::fabric_id_short16(got),
            crate::roster::fabric_id_short16(expected)
        ))),
        RosterError::InviteNotRoot { .. } => Some(RedeemErrorKind::NotRoot),
        RosterError::InviteExpired { .. } => Some(RedeemErrorKind::Other("invite expired".into())),
        RosterError::InviteRecipientMismatch { .. } => {
            Some(RedeemErrorKind::Other("recipient mismatch".into()))
        }
        RosterError::BadPoP { .. } => Some(RedeemErrorKind::BadPoP),
        // ---- verify-protocol 行（emit=false）----
        RosterError::Protocol(_) => None,
        // ---- 下列变体不经兑换通道（_out_of_scope）或属 post-consume 阶段；
        // 显式枚举使新增 RosterError 变体在编译期强制此处裁决（R3 P1-2）。
        RosterError::NotRoot { .. }
        | RosterError::InvalidRevokeTarget { .. }
        | RosterError::Corrupted { .. }
        | RosterError::NotFound { .. }
        | RosterError::AlreadyExists { .. }
        | RosterError::Persistence { .. }
        | RosterError::DirFabricMismatch { .. } => None,
    }
}

/// 独立 issuer 会话入口：不属于 Fabric 生命周期时使用。Fabric accept loop 必须
/// 使用 [`handle_redeem_as_issuer_gated`] 以获得 [R8-1] 提交门保护。
pub async fn handle_redeem_as_issuer(
    conn: &Connection,
    roster: &Arc<tokio::sync::Mutex<Roster>>,
    identity: &crate::identity::NodeIdentity,
) -> Result<(), SessionError> {
    let commit = tokio::sync::Mutex::new(());
    let gate = Arc::new(std::sync::Mutex::new(false));
    let requested = std::sync::Mutex::new(false);
    handle_redeem_as_issuer_gated(conn, roster, identity, &commit, &requested, gate).await
}

/// 兑换（issuer 侧）：单 bidi 流 + 整体时限；成功即已签发 Grant 并回执全量 dump。
/// 拒绝语义按 issuerMapping：emit=true 行发单记录 REDEEM_ERR 后关闭；
/// emit=false 行（协议违规/入口解码/内部 IO/post-consume 失败）不发结构化帧直接关闭。
/// `roster_commit` 与 `lifecycle_gate` 由 Fabric 提供，用于 [R8-1] 将 grant
/// 提交和 shutdown 门切换线性化。
pub async fn handle_redeem_as_issuer_gated(
    conn: &Connection,
    roster: &Arc<tokio::sync::Mutex<Roster>>,
    identity: &crate::identity::NodeIdentity,
    roster_commit: &tokio::sync::Mutex<()>,
    shutdown_requested: &std::sync::Mutex<bool>,
    lifecycle_gate: Arc<std::sync::Mutex<bool>>,
) -> Result<(), SessionError> {
    /// 兑换失败的两类出口：
    /// - Silent：emit=false 行与一切 I/O/校验异常——无结构化帧，**立即关闭**
    ///   （issuerMapping close 语义；joiner 归 DIAL_FAILED）
    /// - Emitted：emit=true 行——拒绝记录已写完并 finish，连接交由 accept loop
    ///   有界等待对端读取后关闭
    enum InnerErr {
        Silent(String),
        Emitted(String),
    }
    let silent = |r: String| InnerErr::Silent(r);
    let expected_remote = conn.remote_id();
    // [R8-1] 入场快拒只是副作用削减；提交事务内仍必须再次检查，覆盖检查后
    // shutdown 的竞态。
    if *shutdown_requested.lock().unwrap() || *lifecycle_gate.lock().unwrap() {
        conn.close(1u32.into(), b"fabric-shutting-down");
        return Err(SessionError::RedeemRejected(
            "fabric is shutting down".into(),
        ));
    }
    let res = tokio::time::timeout(REDEEM_DEADLINE, async {
        // ---- session_entry：违规/坏令牌/IO 异常均无结构化帧（entry-* 行）----
        let (mut send, mut recv) = conn.accept_bi().await.map_err(|e| silent(format!("{e}")))?;
        let (t, payload) = read_frame(&mut recv, MAX_REDEEM_FRAME)
            .await
            .map_err(|e| silent(format!("{e}")))?;
        if t != frame_type::REDEEM_INTENT {
            return Err(silent("first frame must be redeem intent".into()));
        }
        let token_str = String::from_utf8_lossy(&payload).into_owned();
        let token = InviteToken::decode(&token_str).map_err(|e| silent(e.to_string()))?;

        let challenge = random_bytes::<32>();
        write_frame(&mut send, frame_type::REDEEM_CHALLENGE, &challenge)
            .await
            .map_err(|e| silent(format!("{e}")))?;

        // ---- proof_frame：帧类型/长度/键/对端不符均无结构化帧（proof-* 行）----
        let (t, payload) = read_frame(&mut recv, MAX_REDEEM_FRAME)
            .await
            .map_err(|e| silent(format!("{e}")))?;
        if t != frame_type::REDEEM_PROOF {
            return Err(silent("expect proof".into()));
        }
        if payload.len() != 32 + 64 {
            return Err(silent("bad proof length".into()));
        }
        let redeemer = EndpointId::from_bytes(payload[0..32].try_into().unwrap())
            .map_err(|e| silent(e.to_string()))?;
        let sig = iroh_base::Signature::from_bytes(payload[32..96].try_into().unwrap());
        if redeemer != expected_remote {
            return Err(silent("redeemer key does not match TLS peer".into()));
        }

        // ---- 状态事务（锁内零网络 I/O）：verify/consume/grant/编码 ----
        enum Flow {
            Emit(redeem_err::RedeemErrorKind, String),
            Receipt(Vec<u8>),
        }
        let flow = {
            // [R8-1] grant/consume 与 shutdown 门共享提交锁；门置位后拒绝，
            // 门置位前已获锁的事务先完整提交，故不存在门后名册写入。
            let _commit = roster_commit.lock().await;
            let requested = *shutdown_requested.lock().unwrap();
            let closed = *lifecycle_gate.lock().unwrap();
            if requested || closed {
                return Err(silent("fabric is shutting down".into()));
            }
            let mut r = roster.lock().await;
            // 过期判断取当前时间，而非任务开始时的快照
            if let Err(e) = r.redeem_verify(&token, &redeemer, &challenge, &sig, now_ms()) {
                match redeem_verify_emit(&e) {
                    Some(kind) => Flow::Emit(kind, e.to_string()),
                    // verify-protocol 防御分支：emit=false
                    None => return Err(silent(e.to_string())),
                }
            } else {
                match r.consume_invite(&token.invite.invite_id, now_ms()) {
                    Ok(true) => {
                        // post_consume：grant/编码失败显式冻结（emit=false）
                        if let Err(e) = r.grant(identity, redeemer, None, None, now_ms()) {
                            return Err(silent(format!("post-consume grant failed: {e}")));
                        }
                        match SignedFact::encode_all(r.facts()) {
                            Ok(buf) => Flow::Receipt(buf),
                            Err(e) => {
                                return Err(silent(format!(
                                    "post-consume receipt encode failed: {e}"
                                )));
                            }
                        }
                    }
                    Ok(false) => Flow::Emit(
                        redeem_err::RedeemErrorKind::Consumed,
                        "invite already consumed".into(),
                    ),
                    Err(e) => return Err(silent(e.to_string())),
                }
            }
        };
        // ---- 锁外 I/O ----
        match flow {
            Flow::Emit(kind, reason) => {
                write_frame(&mut send, frame_type::REDEEM_ERR, &kind.encode_record())
                    .await
                    .map_err(|e| silent(format!("{e}")))?;
                // R4 P1-3：finish 是发送流收尾 I/O——失败同样走 silent 立即关闭
                send.finish()
                    .map_err(|e| silent(format!("finish failed: {e}")))?;
                Err(InnerErr::Emitted(reason))
            }
            Flow::Receipt(receipt) => {
                write_frame(&mut send, frame_type::REDEEM_OK, &receipt)
                    .await
                    .map_err(|e| silent(format!("post-consume receipt write failed: {e}")))?;
                // 半关闭发送侧，让回执在连接关闭前可靠送达；失败立即关闭
                send.finish()
                    .map_err(|e| silent(format!("receipt finish failed: {e}")))?;
                Ok(())
            }
        }
    })
    .await;
    match res {
        // deadline：同样立即关闭
        Err(_) => {
            conn.close(1u32.into(), b"redeem-deadline");
            Err(SessionError::RedeemRejected(
                "redeem deadline exceeded".into(),
            ))
        }
        Ok(Ok(())) => Ok(()),
        Ok(Err(InnerErr::Silent(reason))) => {
            conn.close(1u32.into(), b"redeem-rejected");
            Err(SessionError::RedeemRejected(reason))
        }
        Ok(Err(InnerErr::Emitted(reason))) => Err(SessionError::RedeemRejected(reason)),
    }
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

#[cfg(test)]
mod redeem_err_tests {
    use super::redeem_err::*;

    fn rec(kind: u8, payload: &[u8]) -> RedeemRecord {
        RedeemRecord {
            kind,
            payload: payload.to_vec(),
        }
    }

    #[test]
    fn encode_record_matches_contract_layout() {
        // canonical：kind=0x00 空载荷 → [00 00]
        assert_eq!(
            RedeemErrorKind::Consumed.encode_record(),
            vec![0x00, 0x00],
            "must equal fixture 'canonical' payload 0000"
        );
        // other 带原因 → [03 len ..]
        let e = RedeemErrorKind::Other("not-root".into());
        assert_eq!(
            e.encode_record(),
            vec![0x03, 0x08, b'n', b'o', b't', 0x2d, b'r', b'o', b'o', b't']
        );
        // not-root / bad-pop：无载荷
        assert_eq!(RedeemErrorKind::NotRoot.encode_record(), vec![0x01, 0x00]);
        assert_eq!(RedeemErrorKind::BadPoP.encode_record(), vec![0x02, 0x00]);
    }

    #[test]
    fn normalize_strips_non_printable_and_truncates_255() {
        // 非 ASCII（UTF-8 中）剥除
        assert_eq!(normalize_payload("中"), Vec::<u8>::new());
        // 控制字符剥除、可打印保留
        assert_eq!(normalize_payload("a\x01b\x7fc d"), b"abc d".to_vec());
        // >255 截断
        let long = "x".repeat(300);
        assert_eq!(normalize_payload(&long).len(), 255);
        // 255 边界整保留
        let exact = "y".repeat(255);
        assert_eq!(normalize_payload(&exact).len(), 255);
    }

    #[test]
    fn decode_records_extra_bytes_are_next_record() {
        // two-records fixture payload：0000 03086e6f742d726f6f74
        let payload = [
            0x00u8, 0x00, 0x03, 0x08, b'n', b'o', b't', 0x2d, b'r', b'o', b'o', b't',
        ];
        let rs = decode_records(&payload).unwrap();
        assert_eq!(rs.len(), 2);
        assert!(rs[0].is_consumed());
        assert_eq!(rs[1].kind, 0x03);
        assert_eq!(rs[1].presented(), "not-root");
    }

    #[test]
    fn decode_records_segment_short_reads() {
        // inner-truncated fixture：声明 4B 只有 2B
        assert_eq!(
            decode_records(&[0x03, 0x04, 0x6e, 0x6f]),
            Err(RecordShortRead { at: 0 })
        );
        // 末尾孤立 kind 字节
        assert_eq!(
            decode_records(&[0x03, 0x00, 0x01]),
            Err(RecordShortRead { at: 2 })
        );
        // len 越过外层 payload 边界
        assert_eq!(
            decode_records(&[0x03, 0x0a, 0x01]),
            Err(RecordShortRead { at: 0 })
        );
    }

    #[test]
    fn zero_len_other_is_legal() {
        let rs = decode_records(&[0x03, 0x00]).unwrap();
        assert_eq!(rs, vec![rec(0x03, b"")]);
        assert_eq!(rs[0].presented(), "");
    }

    #[test]
    fn unknown_kind_consumed_by_len_and_reduces_to_other() {
        // unknown-kind fixture：7f 04 61626364
        let rs = decode_records(&[0x7f, 0x04, b'a', b'b', b'c', b'd']).unwrap();
        assert_eq!(rs.len(), 1);
        assert_eq!(rs[0].presented(), "abcd");
        assert_eq!(
            reduce(&rs),
            RedeemRejection::Invalid {
                reason: "unknown-kind 0x7f".into()
            }
        );
    }

    #[test]
    fn reduce_is_fail_closed() {
        // 恰一条 Consumed
        assert_eq!(reduce(&[rec(0x00, b"")]), RedeemRejection::Consumed);
        // 恰一条已知其它 kind
        assert_eq!(
            reduce(&[rec(0x01, b"")]),
            RedeemRejection::Invalid {
                reason: "not root".into()
            }
        );
        // 带载荷时呈现层优先
        assert_eq!(
            reduce(&[rec(0x01, b"not-root")]),
            RedeemRejection::Invalid {
                reason: "not-root".into()
            }
        );
        assert_eq!(
            reduce(&[rec(0x03, b"")]),
            RedeemRejection::Invalid {
                reason: "other".into()
            }
        );
        // 多条（含 Consumed）：fail-closed → Invalid
        assert!(matches!(
            reduce(&[rec(0x00, b""), rec(0x03, b"not-root")]),
            RedeemRejection::Invalid { .. }
        ));
    }

    #[test]
    fn presented_strips_non_ascii_bytes() {
        // non-ascii-payload fixture：e4b8ad → presented ""
        assert_eq!(rec(0x03, &[0xe4, 0xb8, 0xad]).presented(), "");
        assert_eq!(rec(0x03, b"plain").presented(), "plain");
    }

    // ---- issuerMapping rows（17 行 variantId 的映射层逐行断言） ---------------

    use crate::roster::RosterError;

    fn ids(seed: u8) -> (crate::protocol::FabricId, crate::protocol::FabricId) {
        let a = crate::protocol::FabricId([seed; 32]);
        let b = crate::protocol::FabricId([seed ^ 0xFF; 32]);
        (a, b)
    }

    fn id16(id: &crate::protocol::FabricId) -> String {
        crate::roster::fabric_id_short16(id)
    }

    #[test]
    fn issuer_mapping_verify_rows_emit() {
        // verify-wrong-fabric：kind=3，payload = "wrong fabric {got16} vs {expected16}"
        let (got, expected) = ids(1);
        let e = RosterError::WrongFabric { got, expected };
        match super::redeem_verify_emit(&e) {
            Some(RedeemErrorKind::Other(reason)) => {
                assert_eq!(
                    reason,
                    format!("wrong fabric {} vs {}", id16(&got), id16(&expected))
                );
            }
            other => panic!("wrong-fabric must emit Other, got {other:?}"),
        }
        // verify-invite-not-root：kind=1，无 payload
        assert_eq!(super::redeem_verify_emit(&e), super::redeem_verify_emit(&e)); // 稳定
        let not_root = RosterError::InviteNotRoot {
            issuer: iroh_base::SecretKey::from_bytes(&[2u8; 32]).public(),
            root: None,
        };
        assert_eq!(
            super::redeem_verify_emit(&not_root),
            Some(RedeemErrorKind::NotRoot)
        );
        // verify-invite-expired：kind=3 "invite expired"
        let expired = RosterError::InviteExpired {
            expires_at_ms: 1,
            now_ms: 2,
        };
        assert_eq!(
            super::redeem_verify_emit(&expired),
            Some(RedeemErrorKind::Other("invite expired".into()))
        );
        // verify-recipient-mismatch：kind=3 "recipient mismatch"
        let mismatch = RosterError::InviteRecipientMismatch {
            expected: iroh_base::SecretKey::from_bytes(&[3u8; 32]).public(),
            redeemer: iroh_base::SecretKey::from_bytes(&[4u8; 32]).public(),
        };
        assert_eq!(
            super::redeem_verify_emit(&mismatch),
            Some(RedeemErrorKind::Other("recipient mismatch".into()))
        );
        // verify-bad-pop：kind=2
        let bad_pop = RosterError::BadPoP {
            redeemer: iroh_base::SecretKey::from_bytes(&[5u8; 32]).public(),
        };
        assert_eq!(
            super::redeem_verify_emit(&bad_pop),
            Some(RedeemErrorKind::BadPoP)
        );
    }

    #[test]
    fn issuer_mapping_verify_protocol_row_is_emit_false() {
        // verify-protocol（token.verify() 内部 Protocol）：无结构化帧
        let e = RosterError::Protocol(crate::protocol::ProtocolError::Quarantine {
            reason: "invite token failed verification".into(),
        });
        assert_eq!(super::redeem_verify_emit(&e), None);
    }

    #[test]
    fn issuer_mapping_out_of_scope_variants_are_emit_false() {
        // _out_of_scope：NotRoot（名册 root 缺失形态）/Corrupted/NotFound/
        // AlreadyExists/DirFabricMismatch/Persistence/InvalidRevokeTarget 不发帧
        let cases = vec![
            RosterError::NotRoot {
                caller: iroh_base::SecretKey::from_bytes(&[6u8; 32]).public(),
                root: None,
            },
            RosterError::Corrupted {
                path: "x".into(),
                reason: "r".into(),
            },
            RosterError::NotFound { path: "x".into() },
            RosterError::AlreadyExists { path: "x".into() },
            RosterError::Persistence {
                path: "x".into(),
                source: std::io::Error::other("io"),
            },
            RosterError::InvalidRevokeTarget { fact_id: [0u8; 32] },
        ];
        for e in cases {
            assert_eq!(super::redeem_verify_emit(&e), None, "{e}");
        }
        let (a, b) = ids(9);
        assert_eq!(
            super::redeem_verify_emit(&RosterError::DirFabricMismatch {
                path: "x".into(),
                stored: a,
                requested: b,
            }),
            None,
            "DirFabricMismatch must never be sent on the redeem channel"
        );
    }
}
