//! Fabric 门面：SDK 与绑定层直接消费的公共 API。
//! 生命周期、邀请/兑换、连接管理、事件广播与关闭语义的编排层。

use crate::identity::{EndpointId, NodeIdentity, endpoint_id_display, endpoint_id_parse};
use crate::roster::{RevokeTarget, Roster};
use crate::session::{self, ALPN_REDEEM, ALPN_REGULAR, LinkStatus, SessionError};
use iroh::endpoint::{self, Connection};
use iroh::{Endpoint, EndpointAddr, RelayMode};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::{Mutex, broadcast};

/// relay 配置：禁用 / 自托管(或自定义) URL 列表 / n0 官方默认
#[derive(Debug, Clone)]
pub enum RelayConfig {
    Disabled,
    Custom(Vec<String>),
    N0Default,
}

/// 身份注入方式（信任模型中立）：
/// - `Default`：运行时以最终 `data_dir` 解析 FileSecretStore（不复制路径）
/// - `Seed`：纯注入，绝不读写任何存储
/// - `Store`：产品自定义实现（Keychain/托管后端等）
#[derive(Clone)]
pub enum SecretInjection {
    Default,
    Seed(crate::secret::SecretSeed),
    Store(Arc<dyn crate::secret::SecretStore>),
}

impl std::fmt::Debug for SecretInjection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Default => f.write_str("SecretInjection::Default"),
            // 脱敏：绝不把 seed 打进日志
            Self::Seed(_) => f.write_str("SecretInjection::Seed([REDACTED])"),
            Self::Store(_) => f.write_str("SecretInjection::Store(<custom>)"),
        }
    }
}

#[derive(Clone)]
pub struct FabricConfig {
    pub data_dir: PathBuf,
    pub relay: RelayConfig,
    /// 写入邀请令牌的 issuer 直连地址（host:port），如 ["192.168.1.10:53210"]
    pub advertise_addrs: Vec<String>,
    /// 身份来源；默认经 FileSecretStore 指向 `data_dir`
    pub secret: SecretInjection,
}

impl std::fmt::Debug for FabricConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FabricConfig")
            .field("data_dir", &self.data_dir)
            .field("relay", &self.relay)
            .field("advertise_addrs", &self.advertise_addrs)
            .field("secret", &self.secret) // SecretInjection 的 Debug 已脱敏
            .finish()
    }
}

impl FabricConfig {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
            relay: RelayConfig::N0Default,
            advertise_addrs: Vec::new(),
            secret: SecretInjection::Default,
        }
    }
}

#[derive(Debug, Clone)]
pub enum FabricEvent {
    PeerConnected {
        endpoint_id: String,
    },
    PeerDisconnected {
        endpoint_id: String,
    },
    RosterUpdated,
    Message {
        from: String,
        data: Vec<u8>,
    },
    PathChanged {
        endpoint_id: String,
        status: LinkStatus,
    },
}

#[derive(Debug, Error)]
pub enum FabricError {
    #[error("session: {0}")]
    Session(#[from] SessionError),
    #[error("identity: {0}")]
    Identity(#[from] crate::identity::IdentityError),
    #[error("protocol: {0}")]
    Protocol(#[from] crate::protocol::ProtocolError),
    #[error("connection: {0}")]
    Connection(#[from] iroh::endpoint::ConnectionError),
    #[error("stream closed")]
    StreamClosed,
    #[error("roster: {0}")]
    Roster(#[from] crate::roster::RosterError),
    #[error("iroh: {0}")]
    Iroh(#[from] iroh::endpoint::BindError),
    #[error("connect: {0}")]
    Connect(#[from] iroh::endpoint::ConnectError),
    #[error("invalid endpoint id: {0}")]
    BadEndpointId(String),
    #[error("already shutdown")]
    Shutdown,
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error(
        "data dir {0} has no identity; open() does not create one (use create_root/attach/join)"
    )]
    MissingIdentity(String),
    #[error("identity {0} does not match the roster (not root and not an effective member)")]
    IdentityRosterMismatch(String),
    #[error("secret export/import: {0}")]
    SecretExport(#[from] crate::secret::SecretExportError),
}

struct PeerEntry {
    conn: Connection,
    link: Arc<std::sync::Mutex<LinkStatus>>,
    #[allow(dead_code)] // 控制流保留给后续增量 FACT 帧；v0.1 HELLO 后暂不使用
    ctrl_send: Arc<Mutex<endpoint::SendStream>>,
    /// 连接是否已关闭（watcher 异步置位；幂等快捷路径据此判断存活）
    closed: Arc<std::sync::atomic::AtomicBool>,
    /// 连接代次：旧连接的 watcher 只允许删除同代次条目
    epoch: u64,
}

pub struct FabricInner {
    identity: NodeIdentity,
    roster: Arc<Mutex<Roster>>,
    endpoint: Endpoint,
    peers: Arc<Mutex<HashMap<EndpointId, PeerEntry>>>,
    events: broadcast::Sender<FabricEvent>,
    relay: RelayConfig,
    advertise_addrs: Vec<String>,
    /// 从邀请令牌/连接学到的对端可达信息（relay URL 或 ip:port）
    known_addrs: Mutex<HashMap<EndpointId, Vec<String>>>,
    /// peer 连接代次计数器（防旧 watcher 误删新连接）
    peer_epoch: std::sync::atomic::AtomicU64,
}

#[derive(Clone)]
pub struct Fabric {
    inner: Arc<FabricInner>,
}

/// store 路径的身份解析：load 命中即用；缺失时按 allow_create 决定
/// create（create_root/attach）或 MissingIdentity（open——绝不静默生成）。
fn resolve_from_store(
    store: &dyn crate::secret::SecretStore,
    data_dir: &std::path::Path,
    allow_create: bool,
) -> Result<NodeIdentity, FabricError> {
    match store.load() {
        Ok(Some(seed)) => Ok(NodeIdentity::from_seed(*seed.as_bytes())),
        Ok(None) if allow_create => NodeIdentity::with_store(store).map_err(FabricError::Identity),
        Ok(None) => Err(FabricError::MissingIdentity(data_dir.display().to_string())),
        Err(e) => Err(FabricError::Identity(e.into())),
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl Fabric {
    /// 按 SecretInjection 解析身份。
    /// - `Default`/`Store`：`ensure_with`（load，缺失则 create；并发不分叉）
    /// - `Seed`：纯注入，零存储副作用
    fn resolve_identity(
        config: &FabricConfig,
        allow_create: bool,
    ) -> Result<NodeIdentity, FabricError> {
        match &config.secret {
            SecretInjection::Seed(seed) => Ok(NodeIdentity::from_seed(*seed.as_bytes())),
            SecretInjection::Store(store) => {
                resolve_from_store(store.as_ref(), &config.data_dir, allow_create)
            }
            SecretInjection::Default => {
                let store = crate::secret::FileSecretStore::new(&config.data_dir);
                resolve_from_store(&store, &config.data_dir, allow_create)
            }
        }
    }

    /// 创建新 fabric（本节点成为 root）。既有 roster 报错（Roster::create 拒绝覆写）。
    pub async fn create_root(config: FabricConfig) -> Result<Self, FabricError> {
        let identity = Self::resolve_identity(&config, true)?;
        let (roster, _fid) = Roster::create(&identity, &config.data_dir, now_ms())?;
        Self::start(identity, roster, config).await
    }

    /// 打开已有 fabric。**缺失身份是错误**（不静默生成新身份——那会制造一个
    /// 无成员关系的孤儿身份）；身份必须是 root 或有效成员（seed-roster 一致性）。
    pub async fn open(config: FabricConfig) -> Result<Self, FabricError> {
        let identity = Self::resolve_identity(&config, false)?;
        let fid = crate::roster::peek_fabric_id(&config.data_dir)?.ok_or(
            crate::roster::RosterError::NotFound {
                path: crate::roster::roster_file_path(&config.data_dir),
            },
        )?;
        let roster = Roster::open(&config.data_dir, fid)?;
        let id = identity.endpoint_id();
        if !roster.is_member(&id, now_ms()) {
            return Err(FabricError::IdentityRosterMismatch(endpoint_id_display(
                &id,
            )));
        }
        Self::start(identity, roster, config).await
    }

    /// 以加入者身份起步（空名册，等待 join 写入事实）；允许创建新身份。
    /// 名册非空时（曾经 join 过）同样校验身份一致性。
    pub async fn attach(config: FabricConfig, fabric_id_hex: &str) -> Result<Self, FabricError> {
        let identity = Self::resolve_identity(&config, true)?;
        // fabric_id 以 hex 传递；z32 不适合 32B 演示（避免双编码），此处 hex 是内部参数而非展示串
        let mut buf = [0u8; 32];
        hex::decode_to_slice(fabric_id_hex, &mut buf)
            .map_err(|_| FabricError::BadEndpointId(fabric_id_hex.to_owned()))?;
        let roster = Roster::attach(&config.data_dir, crate::protocol::FabricId(buf))?;
        if !roster.is_empty() {
            let id = identity.endpoint_id();
            if !roster.is_member(&id, now_ms()) {
                return Err(FabricError::IdentityRosterMismatch(endpoint_id_display(
                    &id,
                )));
            }
        }
        Self::start(identity, roster, config).await
    }

    /// 显式导出身份（identity export，不含 roster）为 `dwebkey1.` 加密串。
    pub fn export_secret(&self, passphrase: &str) -> Result<String, FabricError> {
        Ok(crate::secret::export_secret(
            &self.inner.identity,
            passphrase,
        )?)
    }

    async fn start(
        identity: NodeIdentity,
        roster: Roster,
        config: FabricConfig,
    ) -> Result<Self, FabricError> {
        let mut builder = match &config.relay {
            RelayConfig::Disabled => {
                Endpoint::builder(iroh::endpoint::presets::Minimal).relay_mode(RelayMode::Disabled)
            }
            RelayConfig::Custom(urls) => {
                let parsed: Result<Vec<_>, _> =
                    urls.iter().map(|u| u.parse::<iroh::RelayUrl>()).collect();
                let parsed = parsed.map_err(|e: iroh::RelayUrlParseError| {
                    FabricError::Session(SessionError::Connect(e.to_string()))
                })?;
                Endpoint::builder(iroh::endpoint::presets::Minimal)
                    .relay_mode(RelayMode::custom(parsed))
            }
            RelayConfig::N0Default => Endpoint::builder(iroh::endpoint::presets::N0),
        };
        builder = builder
            .secret_key(identity.secret_key().clone())
            .alpns(vec![ALPN_REGULAR.to_vec(), ALPN_REDEEM.to_vec()]);
        let endpoint = builder.bind().await?;
        if !matches!(config.relay, RelayConfig::Disabled) {
            // 等 home relay 就绪，地址/回退才可用；不无限等待
            let _ =
                tokio::time::timeout(std::time::Duration::from_secs(10), endpoint.online()).await;
        }

        let (events, _) = broadcast::channel(256);
        let inner = Arc::new(FabricInner {
            identity,
            roster: Arc::new(Mutex::new(roster)),
            endpoint,
            peers: Arc::new(Mutex::new(HashMap::new())),
            events,
            relay: config.relay.clone(),
            advertise_addrs: config.advertise_addrs.clone(),
            known_addrs: Mutex::new(HashMap::new()),
            peer_epoch: std::sync::atomic::AtomicU64::new(0),
        });
        spawn_accept_loop(&inner);
        Ok(Fabric { inner })
    }

    // ---- 查询 ----

    pub fn endpoint_id(&self) -> String {
        endpoint_id_display(&self.inner.identity.endpoint_id())
    }

    pub async fn fabric_id_hex(&self) -> String {
        hex::encode(self.inner.roster.lock().await.fabric_id().as_bytes())
    }

    pub async fn members(&self) -> Vec<MemberInfo> {
        let roster = self.inner.roster.lock().await;
        roster
            .effective_members(now_ms())
            .into_iter()
            .map(|m| MemberInfo {
                endpoint_id: endpoint_id_display(&m.endpoint_id),
                display_name: m.display_name,
                since_ms: m.since_ms,
            })
            .collect()
    }

    pub async fn is_member(&self, id: &str) -> Result<bool, FabricError> {
        let id = endpoint_id_parse(id).map_err(|_| FabricError::BadEndpointId(id.into()))?;
        Ok(self.inner.roster.lock().await.is_member(&id, now_ms()))
    }

    pub fn subscribe(&self) -> broadcast::Receiver<FabricEvent> {
        self.inner.events.subscribe()
    }

    pub async fn link_status(&self, id: &str) -> Result<LinkStatus, FabricError> {
        let id = endpoint_id_parse(id).map_err(|_| FabricError::BadEndpointId(id.into()))?;
        let peers = self.inner.peers.lock().await;
        peers
            .get(&id)
            .map(|p| *p.link.lock().unwrap())
            .ok_or(FabricError::Session(SessionError::NotConnected(
                id.to_string(),
            )))
    }

    // ---- root 操作 ----

    /// 签发邀请令牌（root-only）。
    pub async fn invite(
        &self,
        ttl_ms: u64,
        recipient: Option<&str>,
    ) -> Result<String, FabricError> {
        let recipient = match recipient {
            Some(s) => {
                Some(endpoint_id_parse(s).map_err(|_| FabricError::BadEndpointId(s.into()))?)
            }
            None => None,
        };
        let relay_url = match &self.inner.relay {
            RelayConfig::Disabled => String::new(),
            RelayConfig::Custom(urls) => urls.first().cloned().unwrap_or_default(),
            RelayConfig::N0Default => "https://relay.iroh.network".to_owned(),
        };
        let addrs = if self.inner.advertise_addrs.is_empty() {
            self.direct_addr_hints()
        } else {
            self.inner.advertise_addrs.clone()
        };
        let token = self.inner.roster.lock().await.issue_invite(
            &self.inner.identity,
            relay_url,
            addrs,
            recipient,
            ttl_ms,
            now_ms(),
        )?;
        Ok(token.encode()?)
    }

    /// 撤销成员（root-only），并断开与其的既有会话。
    pub async fn revoke(&self, id: &str) -> Result<(), FabricError> {
        let id = endpoint_id_parse(id).map_err(|_| FabricError::BadEndpointId(id.into()))?;
        {
            let mut roster = self.inner.roster.lock().await;
            roster.revoke(
                &self.inner.identity,
                RevokeTarget::AllGrantsOf(id),
                now_ms(),
            )?;
        }
        if let Some(entry) = self.inner.peers.lock().await.remove(&id) {
            entry.conn.close(1u32.into(), b"revoked");
        }
        let _ = self.inner.events.send(FabricEvent::RosterUpdated);
        Ok(())
    }

    /// 设置本节点显示名（任意成员自签 Join）。
    pub async fn set_display_name(&self, name: &str) -> Result<(), FabricError> {
        self.inner.roster.lock().await.set_display_name(
            &self.inner.identity,
            Some(name.to_owned()),
            now_ms(),
        )?;
        let _ = self.inner.events.send(FabricEvent::RosterUpdated);
        Ok(())
    }

    // ---- 加入与连接 ----

    /// 兑换邀请令牌（joiner 侧）。成功后本节点是成员且持有完整名册。
    pub async fn join(&self, token_str: &str) -> Result<(), FabricError> {
        let token = crate::protocol::InviteToken::decode(token_str)?;
        let addr = session::endpoint_addr_from_invite(&token)?;
        // 学习 issuer 可达信息，供后续常规连接使用
        {
            let mut learned: Vec<String> = Vec::new();
            if !token.invite.issuer_relay_url.is_empty() {
                learned.push(token.invite.issuer_relay_url.clone());
            }
            learned.extend(token.invite.issuer_direct_addrs.iter().cloned());
            self.inner
                .known_addrs
                .lock()
                .await
                .insert(token.invite.issuer, learned);
        }
        let conn = self.inner.endpoint.connect(addr, ALPN_REDEEM).await?;
        let facts = session::redeem_as_joiner(
            &conn,
            &token,
            self.inner.identity.secret_key(),
            &self.inner.identity.endpoint_id(),
        )
        .await?;
        conn.close(0u32.into(), b"redeem-done");
        self.inner.roster.lock().await.merge(facts)?;
        let _ = self.inner.events.send(FabricEvent::RosterUpdated);
        Ok(())
    }

    /// 连接成员（常规 ALPN，双向门控 + 名册同步）。
    pub async fn connect(&self, id: &str) -> Result<(), FabricError> {
        let id = endpoint_id_parse(id).map_err(|_| FabricError::BadEndpointId(id.into()))?;
        {
            let roster = self.inner.roster.lock().await;
            if !roster.is_member(&id, now_ms()) {
                return Err(FabricError::Session(SessionError::NotMember(
                    endpoint_id_display(&id),
                )));
            }
            {
                let mut peers = self.inner.peers.lock().await;
                match peers.get(&id) {
                    Some(entry) if !entry.closed.load(std::sync::atomic::Ordering::SeqCst) => {
                        return Ok(()); // 已有活跃连接，幂等
                    }
                    Some(_) => {
                        peers.remove(&id); // 残留已死条目，清理后重拨
                    }
                    None => {}
                }
            }
        }
        let addr = self.endpoint_addr_for(&id).await?;
        let conn = self.inner.endpoint.connect(addr, ALPN_REGULAR).await?;
        self.register_dialed(conn).await?;
        Ok(())
    }

    /// 显式登记对端可达地址（relay URL 或 ip:port），供后续 connect 使用。
    pub async fn add_known_addr(&self, id: &str, addr: String) -> Result<(), FabricError> {
        let id = endpoint_id_parse(id).map_err(|_| FabricError::BadEndpointId(id.into()))?;
        self.inner
            .known_addrs
            .lock()
            .await
            .entry(id)
            .or_default()
            .push(addr);
        Ok(())
    }

    /// 对端当前可达地址提示（网卡地址 + 回环端口）。
    pub async fn direct_addr_hints_public(&self) -> Vec<String> {
        self.direct_addr_hints()
    }

    pub async fn disconnect(&self, id: &str) -> Result<(), FabricError> {
        let id = endpoint_id_parse(id).map_err(|_| FabricError::BadEndpointId(id.into()))?;
        if let Some(entry) = self.inner.peers.lock().await.remove(&id) {
            entry.conn.close(0u32.into(), b"bye");
        }
        Ok(())
    }

    /// 发送不透明 envelope（MSG 流：每消息一条 bidi 流，单帧）。
    pub async fn send(&self, id: &str, data: Vec<u8>) -> Result<(), FabricError> {
        let id = endpoint_id_parse(id).map_err(|_| FabricError::BadEndpointId(id.into()))?;
        if data.len() + 5 > session::MAX_FRAME {
            return Err(FabricError::Session(SessionError::FrameTooLarge {
                limit: session::MAX_FRAME,
            }));
        }
        let peers = self.inner.peers.lock().await;
        let entry = peers
            .get(&id)
            .ok_or(FabricError::Session(SessionError::NotConnected(
                endpoint_id_display(&id),
            )))?;
        let (mut send, _recv) = entry.conn.open_bi().await?;
        session::write_frame(&mut send, session::frame_type::MSG, &data).await?;
        send.finish().map_err(|_| FabricError::StreamClosed)?;
        Ok(())
    }

    /// 优雅关闭：断开全部会话并关闭 endpoint；释放 data-dir 排他锁（幂等）。
    pub async fn shutdown(&self) -> Result<(), FabricError> {
        let peers = self.inner.peers.lock().await;
        for entry in peers.values() {
            entry.conn.close(0u32.into(), b"shutdown");
        }
        drop(peers);
        self.inner.endpoint.close().await;
        Ok(())
    }

    // ---- 内部 ----

    /// 邀请内的直连地址提示：endpoint.addr() 的网卡地址 + 127.0.0.1 回环提示（同机场景）。
    fn direct_addr_hints(&self) -> Vec<String> {
        let mut hints: Vec<String> = self
            .inner
            .endpoint
            .addr()
            .addrs
            .iter()
            .filter_map(|a| match a {
                iroh_base::TransportAddr::Ip(sa) => Some(sa.to_string()),
                _ => None,
            })
            .collect();
        if let Some(port) = self
            .inner
            .endpoint
            .bound_sockets()
            .first()
            .map(|sa| sa.port())
        {
            let loopback = format!("127.0.0.1:{port}");
            if !hints.contains(&loopback) {
                hints.push(loopback);
            }
        }
        hints
    }

    /// 为拨号构造 EndpointAddr：无外显提示时退回 home relay。
    async fn endpoint_addr_for(&self, id: &EndpointId) -> Result<EndpointAddr, FabricError> {
        let mut addr = EndpointAddr::new(*id);
        let mut any = false;
        if let Some(learned) = self.inner.known_addrs.lock().await.get(id) {
            for hint in learned {
                if let Ok(url) = hint.parse::<iroh::RelayUrl>() {
                    addr = addr.with_relay_url(url);
                    any = true;
                } else if let Ok(ip) = hint.parse::<std::net::SocketAddr>() {
                    addr = addr.with_ip_addr(ip);
                    any = true;
                }
            }
            if any {
                return Ok(addr);
            }
        }
        if let RelayConfig::Custom(urls) = &self.inner.relay
            && let Some(u) = urls.first()
            && let Ok(url) = u.parse::<iroh::RelayUrl>()
        {
            addr = addr.with_relay_url(url);
            any = true;
        } else if matches!(self.inner.relay, RelayConfig::N0Default)
            && let Ok(url) = "https://relay.iroh.network".parse::<iroh::RelayUrl>()
        {
            addr = addr.with_relay_url(url);
            any = true;
        }
        if !any && addr.addrs.is_empty() {
            return Err(FabricError::Session(SessionError::NoAddressingInfo(
                endpoint_id_display(id),
            )));
        }
        Ok(addr)
    }

    async fn register_dialed(&self, conn: Connection) -> Result<(), FabricError> {
        let remote = conn.remote_id();
        let dump = {
            let roster = self.inner.roster.lock().await;
            crate::protocol::SignedFact::encode_all(roster.facts())?
        };
        let (facts, ctrl_send) = session::dialer_hello(&conn, dump).await?;
        self.merge_and_emit(facts).await?;
        self.insert_peer(remote, conn, ctrl_send).await;
        Ok(())
    }

    async fn merge_and_emit(
        &self,
        facts: Vec<crate::protocol::SignedFact>,
    ) -> Result<(), FabricError> {
        let removed: Vec<EndpointId> = {
            let mut roster = self.inner.roster.lock().await;
            let before: Vec<EndpointId> = roster
                .effective_members(now_ms())
                .into_iter()
                .map(|m| m.endpoint_id)
                .collect();
            let report = roster.merge(facts)?;
            let after: Vec<EndpointId> = roster
                .effective_members(now_ms())
                .into_iter()
                .map(|m| m.endpoint_id)
                .collect();
            if report.inserted > 0 {
                let _ = self.inner.events.send(FabricEvent::RosterUpdated);
            }
            before
                .into_iter()
                .filter(|id| !after.contains(id))
                .collect()
        };
        // 远端同步到的 Revoke：摘除并断开失效成员的既有会话（撤销前向生效）
        if !removed.is_empty() {
            let mut peers = self.inner.peers.lock().await;
            for id in removed {
                if let Some(entry) = peers.remove(&id) {
                    entry.conn.close(1u32.into(), b"revoked via sync");
                }
            }
        }
        Ok(())
    }

    async fn insert_peer(
        &self,
        remote: EndpointId,
        conn: Connection,
        ctrl_send: endpoint::SendStream,
    ) {
        let link = Arc::new(std::sync::Mutex::new(LinkStatus::Unknown));
        session::spawn_path_watcher(
            conn.clone(),
            link.clone(),
            self.inner.events.clone(),
            remote,
        );
        let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let epoch = self
            .inner
            .peer_epoch
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let entry = PeerEntry {
            conn: conn.clone(),
            link,
            ctrl_send: Arc::new(Mutex::new(ctrl_send)),
            closed: closed.clone(),
            epoch,
        };
        self.inner.peers.lock().await.insert(remote, entry);
        let _ = self.inner.events.send(FabricEvent::PeerConnected {
            endpoint_id: endpoint_id_display(&remote),
        });
        let inner = Arc::downgrade(&self.inner);
        let id_disp = endpoint_id_display(&remote);
        tokio::spawn(async move {
            conn.closed().await;
            closed.store(true, std::sync::atomic::Ordering::SeqCst);
            if let Some(inner) = inner.upgrade() {
                let mut peers = inner.peers.lock().await;
                match peers.get(&remote) {
                    // 同代次：摘除并广播下线
                    Some(e) if e.epoch == epoch => {
                        peers.remove(&remote);
                        drop(peers);
                        let _ = inner.events.send(FabricEvent::PeerDisconnected {
                            endpoint_id: id_disp,
                        });
                    }
                    // 更新代次的连接已接管：静默退出
                    Some(_) => {}
                    // 条目已被主动移除（revoke/disconnect）：仍广播下线
                    None => {
                        drop(peers);
                        let _ = inner.events.send(FabricEvent::PeerDisconnected {
                            endpoint_id: id_disp,
                        });
                    }
                }
            }
        });
        // MSG 流接受循环
        let inner2 = Arc::downgrade(&self.inner);
        let remote2 = remote;
        tokio::spawn(async move {
            loop {
                let conn = match inner2.upgrade() {
                    Some(i) => match i.peers.lock().await.get(&remote2) {
                        Some(e) => e.conn.clone(),
                        None => break,
                    },
                    None => break,
                };
                match conn.accept_bi().await {
                    Ok((_send, mut recv)) => {
                        if let Ok((t, payload)) =
                            session::read_frame(&mut recv, session::MAX_FRAME).await
                            && t == session::frame_type::MSG
                            && let Some(i) = inner2.upgrade()
                        {
                            let _ = i.events.send(FabricEvent::Message {
                                from: endpoint_id_display(&remote2),
                                data: payload,
                            });
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }
}

#[derive(Debug, Clone)]
pub struct MemberInfo {
    pub endpoint_id: String,
    pub display_name: Option<String>,
    pub since_ms: u64,
}

/// 接受循环：按 ALPN 分派；regular 做成员门控；redeem 仅 root 受理。
fn spawn_accept_loop(inner: &Arc<FabricInner>) {
    let inner = Arc::clone(inner);
    tokio::spawn(async move {
        loop {
            let Some(incoming) = inner.endpoint.accept().await else {
                break;
            };
            let conn = match incoming.accept() {
                Ok(a) => match a.await {
                    Ok(c) => c,
                    Err(_) => continue,
                },
                Err(_) => continue,
            };
            let inner2 = Arc::clone(&inner);
            tokio::spawn(async move {
                let alpn = conn.alpn().to_vec();
                let remote = conn.remote_id();
                if alpn == ALPN_REDEEM {
                    // 仅 root 受理兑换
                    let is_root = {
                        let roster = inner2.roster.lock().await;
                        matches!(roster.root(), Some(r) if r == inner2.identity.endpoint_id())
                    };
                    if is_root {
                        let res = session::handle_redeem_as_issuer(
                            &conn,
                            &inner2.roster,
                            &inner2.identity,
                        )
                        .await;
                        if res.is_ok() {
                            // 等对端读取回执并关闭，再关连接，避免回执被连接关闭丢弃
                            let _ =
                                tokio::time::timeout(session::REDEEM_DEADLINE, conn.closed()).await;
                        }
                        let _ = inner2.events.send(FabricEvent::RosterUpdated);
                    }
                    conn.close(0u32.into(), b"redeem-done");
                } else if alpn == ALPN_REGULAR {
                    let ok = { inner2.roster.lock().await.is_member(&remote, now_ms()) };
                    if !ok {
                        conn.close(1u32.into(), b"not a member");
                        return;
                    }
                    match session::acceptor_hello(&conn, &inner2.roster).await {
                        Ok((facts, ctrl_send)) => {
                            let fabric = Fabric {
                                inner: Arc::clone(&inner2),
                            };
                            fabric.merge_and_emit(facts).await.ok();
                            fabric.insert_peer(remote, conn, ctrl_send).await;
                        }
                        Err(_) => {
                            conn.close(1u32.into(), b"hello failed");
                        }
                    }
                } else {
                    conn.close(1u32.into(), b"unknown alpn");
                }
            });
        }
    });
}
