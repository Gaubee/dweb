//! @dweb/client-sdk 绑定层：fabric kernel 的 Node API 投影。
//! 生命周期契约：所有异步方法在 shutdown 后返回错误；事件回调在 shutdown 后
//! 不再触发；重复 shutdown 幂等。

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as BASE64;
use dweb_fabric::secret::SecretSeed;
use dweb_fabric::{
    Fabric as RustFabric, FabricConfig as RustFabricConfig, FabricEvent, LinkStatus, RelayConfig,
    SecretInjection,
};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::sync::Arc;
use tokio::sync::Mutex;

/// relay 配置
#[napi(object)]
#[derive(Debug, Clone)]
pub struct RelayOptions {
    /// "disabled" | "custom" | "n0"（默认 "n0"）
    pub mode: Option<String>,
    /// mode = "custom" 时的 relay URL 列表（自托管 docker 或其它 iroh relay）
    pub urls: Option<Vec<String>>,
}

/// Fabric 构造配置
#[napi(object)]
#[derive(Debug, Clone)]
pub struct FabricOptions {
    /// 数据目录（名册持久化位置；secret 默认实现也指向此目录）
    pub data_dir: String,
    pub relay: Option<RelayOptions>,
    /// 写入邀请令牌的 issuer 直连地址（host:port）
    pub advertise_addrs: Option<Vec<String>>,
}

/// 成员信息
#[napi(object)]
pub struct Member {
    pub endpoint_id: String,
    pub display_name: Option<String>,
    pub since_ms: f64,
}

fn to_relay_config(relay: Option<RelayOptions>) -> RelayConfig {
    match relay {
        None => RelayConfig::N0Default,
        Some(r) => match r.mode.as_deref().unwrap_or("n0") {
            "disabled" => RelayConfig::Disabled,
            "custom" => RelayConfig::Custom(r.urls.unwrap_or_default()),
            _ => RelayConfig::N0Default,
        },
    }
}

/// 原子 take 配置构造：无 check-then-act 竞态；返回留存副本供失败归还。
fn take_options(
    opts: &FabricOptions,
    secret: Option<&SecretSeedHandle>,
) -> Result<(RustFabricConfig, Option<SecretSeed>)> {
    let base = || RustFabricConfig {
        data_dir: opts.data_dir.clone().into(),
        relay: to_relay_config(opts.relay.clone()),
        advertise_addrs: opts.advertise_addrs.clone().unwrap_or_default(),
        secret: SecretInjection::Default,
    };
    match secret {
        None => Ok((base(), None)),
        Some(handle) => {
            let seed = handle.take()?;
            let mut cfg = base();
            cfg.secret = SecretInjection::Seed(seed.clone());
            Ok((cfg, Some(seed)))
        }
    }
}

fn link_status_str(s: LinkStatus) -> &'static str {
    match s {
        LinkStatus::Direct => "direct",
        LinkStatus::Relay => "relay",
        LinkStatus::Unknown => "unknown",
    }
}

fn fabric_err(e: dweb_fabric::FabricError) -> Error {
    Error::new(Status::GenericFailure, format!("{e}"))
}

/// 受保护的身份种子句柄：内部持有 [`SecretSeed`]（zeroize-on-drop），
/// 被 Fabric 构造消费（take）后即失效。用于"导入 token / 产品托管解密后"
/// 向 Fabric 注入身份而不经手明文 JS 字符串。内部 Arc：句柄可 clone 进
/// 配置对象，take 语义全局共享（一次消费）。
#[napi]
pub struct SecretSeedHandle {
    seed: std::sync::Arc<std::sync::Mutex<Option<SecretSeed>>>,
}

impl Clone for SecretSeedHandle {
    fn clone(&self) -> Self {
        Self {
            seed: self.seed.clone(),
        }
    }
}

#[napi]
impl SecretSeedHandle {
    /// 派生 EndpointId（z32 展示串；不暴露种子本体）。
    #[napi(getter)]
    pub fn endpoint_id(&self) -> Result<String> {
        let g = self.seed.lock().unwrap();
        match g.as_ref() {
            Some(s) => Ok(dweb_fabric::identity::endpoint_id_display(&s.endpoint_id())),
            None => Err(Error::new(
                Status::GenericFailure,
                "seed handle already consumed",
            )),
        }
    }

    /// 是否仍持有种子（未被消费）。
    #[napi(getter)]
    pub fn available(&self) -> bool {
        self.seed.lock().unwrap().is_some()
    }

    fn take(&self) -> Result<SecretSeed> {
        self.seed
            .lock()
            .unwrap()
            .take()
            .ok_or_else(|| Error::new(Status::GenericFailure, "seed handle already consumed"))
    }

    /// 构造失败时归还种子：句柄可重试（调用方不必重新导入 token）。
    fn put_back(&self, seed: SecretSeed) {
        let mut g = self.seed.lock().unwrap();
        // 只在仍未被他人填充时归还（后到者不覆盖）
        if g.is_none() {
            *g = Some(seed);
        }
    }
}

/// 导入 `dwebkey1.` 身份导出串：口令派生解密，返回受保护的种子句柄。
/// （不落盘；注入 Fabric 用工厂的 secret 参数。Argon2 在阻塞线程池执行。）
#[napi]
pub async fn import_secret(token: String, passphrase: String) -> Result<SecretSeedHandle> {
    let seed = tokio::task::spawn_blocking(move || {
        dweb_fabric::secret::import_secret(&token, &passphrase)
    })
    .await
    .map_err(|e| Error::new(Status::GenericFailure, format!("join: {e}")))?
    .map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))?;
    Ok(SecretSeedHandle {
        seed: Arc::new(std::sync::Mutex::new(Some(seed))),
    })
}

/// dweb fabric：应用级组网的 Node SDK 入口。
/// 工厂：Fabric.createRoot / Fabric.open / Fabric.attach；完成后调用 shutdown 释放资源。
#[napi]
pub struct Fabric {
    inner: RustFabric,
    event_callbacks: Arc<Mutex<Vec<ThreadsafeFunction<String>>>>,
    shutdown_done: Arc<std::sync::atomic::AtomicBool>,
}

#[napi]
impl Fabric {
    /// 创建新 fabric（本节点成为 root，可签发邀请与撤销）。
    #[napi(factory)]
    pub async fn create_root(
        opts: FabricOptions,
        secret: Option<&SecretSeedHandle>,
    ) -> Result<Fabric> {
        let (cfg, seed) = take_options(&opts, secret)?;
        Self::build_with_handle(RustFabric::create_root(cfg).await, secret, seed)
    }

    /// 打开已有 fabric（数据目录已含名册）。
    #[napi(factory)]
    pub async fn open(opts: FabricOptions, secret: Option<&SecretSeedHandle>) -> Result<Fabric> {
        let (cfg, seed) = take_options(&opts, secret)?;
        Self::build_with_handle(RustFabric::open(cfg).await, secret, seed)
    }

    /// 以加入者身份起步（空名册；随后调用 join 兑换邀请）。
    #[napi(factory)]
    pub async fn attach(
        opts: FabricOptions,
        fabric_id_hex: String,
        secret: Option<&SecretSeedHandle>,
    ) -> Result<Fabric> {
        let (cfg, seed) = take_options(&opts, secret)?;
        Self::build_with_handle(RustFabric::attach(cfg, &fabric_id_hex).await, secret, seed)
    }

    /// 一步加入：从令牌解析 fabric_id，attach + 兑换 + 持久化名册。
    #[napi(factory)]
    pub async fn join_with_token(
        opts: FabricOptions,
        token: String,
        secret: Option<&SecretSeedHandle>,
    ) -> Result<Fabric> {
        // token 解码前置：格式错误在消费句柄之前返回
        let decoded = dweb_fabric::protocol::InviteToken::decode(&token)
            .map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))?;
        let fabric_id = hex::encode(decoded.invite.fabric_id.as_bytes());
        let (cfg, seed) = take_options(&opts, secret)?;
        match RustFabric::attach(cfg, &fabric_id).await {
            Ok(fabric) => match fabric.join(&token).await {
                Ok(()) => Self::build_with_handle(Ok(fabric), secret, seed),
                Err(e) => {
                    if let (Some(h), Some(s)) = (secret, seed) {
                        h.put_back(s);
                    }
                    Err(fabric_err(e))
                }
            },
            Err(e) => {
                if let (Some(h), Some(s)) = (secret, seed) {
                    h.put_back(s);
                }
                Err(fabric_err(e))
            }
        }
    }

    fn build(fabric: std::result::Result<RustFabric, dweb_fabric::FabricError>) -> Result<Fabric> {
        let inner = fabric.map_err(fabric_err)?;
        let fabric = Fabric {
            inner,
            event_callbacks: Arc::new(Mutex::new(Vec::new())),
            shutdown_done: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        };
        spawn_event_pump(&fabric);
        Ok(fabric)
    }

    /// build + 失败归还：句柄注入的种子在构造失败时放回句柄，调用方可重试。
    fn build_with_handle(
        fabric: std::result::Result<RustFabric, dweb_fabric::FabricError>,
        handle: Option<&SecretSeedHandle>,
        seed: Option<SecretSeed>,
    ) -> Result<Fabric> {
        match Self::build(fabric) {
            Ok(f) => Ok(f),
            Err(e) => {
                if let (Some(h), Some(s)) = (handle, seed) {
                    h.put_back(s);
                }
                Err(e)
            }
        }
    }

    /// 本节点 EndpointId（z-base-32，52 字符）
    #[napi(getter)]
    pub fn endpoint_id(&self) -> String {
        self.inner.endpoint_id()
    }

    /// fabric id（hex）
    #[napi]
    pub async fn fabric_id_hex(&self) -> String {
        self.inner.fabric_id_hex().await
    }

    /// 当前有效成员投影
    #[napi]
    pub async fn members(&self) -> Result<Vec<Member>> {
        let members = self.inner.members().await;
        Ok(members
            .into_iter()
            .map(|m| Member {
                endpoint_id: m.endpoint_id,
                display_name: m.display_name,
                since_ms: m.since_ms as f64,
            })
            .collect())
    }

    /// 查询 EndpointId 是否为有效成员
    #[napi]
    pub async fn is_member(&self, endpoint_id: String) -> Result<bool> {
        self.inner.is_member(&endpoint_id).await.map_err(fabric_err)
    }

    /// 签发邀请令牌（root-only）。返回 dweb1. 前缀的自包含字符串。
    #[napi]
    pub async fn invite(&self, ttl_ms: f64, recipient: Option<String>) -> Result<String> {
        self.inner
            .invite(ttl_ms.max(0.0) as u64, recipient.as_deref())
            .await
            .map_err(fabric_err)
    }

    /// 兑换邀请令牌加入 fabric（issuer-online 单次兑换）。
    #[napi]
    pub async fn join(&self, token: String) -> Result<()> {
        self.inner.join(&token).await.map_err(fabric_err)
    }

    /// 连接成员（常规通道；双向门控 + 名册同步）。幂等（活跃连接直接成功）。
    #[napi]
    pub async fn connect(&self, endpoint_id: String) -> Result<()> {
        self.inner.connect(&endpoint_id).await.map_err(fabric_err)
    }

    /// 断开与某成员的会话
    #[napi]
    pub async fn disconnect(&self, endpoint_id: String) -> Result<()> {
        self.inner
            .disconnect(&endpoint_id)
            .await
            .map_err(fabric_err)
    }

    /// 发送不透明二进制 envelope
    #[napi]
    pub async fn send(&self, endpoint_id: String, data: Buffer) -> Result<()> {
        self.inner
            .send(&endpoint_id, data.as_ref().to_vec())
            .await
            .map_err(fabric_err)
    }

    /// 撤销成员（root-only）；投影收紧并断开既有会话。
    #[napi]
    pub async fn revoke(&self, endpoint_id: String) -> Result<()> {
        self.inner.revoke(&endpoint_id).await.map_err(fabric_err)
    }

    /// 设置本节点显示名
    #[napi]
    pub async fn set_display_name(&self, name: String) -> Result<()> {
        self.inner.set_display_name(&name).await.map_err(fabric_err)
    }

    /// 查询与某成员的当前路径类型："direct" | "relay" | "unknown"
    #[napi]
    pub async fn link_status(&self, endpoint_id: String) -> Result<String> {
        let status = self
            .inner
            .link_status(&endpoint_id)
            .await
            .map_err(fabric_err)?;
        Ok(link_status_str(status).to_owned())
    }

    /// 显式导出身份（identity export，不含 roster）为 `dwebkey1.` 加密串。
    /// 交由产品自行安全保存（如账号系统加密托管——密文上云、口令在用户）。
    #[napi]
    pub async fn export_secret_passphrase(&self, passphrase: String) -> Result<String> {
        let identity = self.inner.identity().clone();
        tokio::task::spawn_blocking(move || {
            dweb_fabric::secret::export_secret(&identity, &passphrase)
        })
        .await
        .map_err(|e| Error::new(Status::GenericFailure, format!("join: {e}")))?
        .map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))
    }

    /// 注册事件回调（可多次调用，多个回调都会收到全部事件）。
    /// 事件对象见 FabricEventJs：{ type, endpointId?, from?, data?, status? }
    #[napi]
    pub fn on(&self, callback: ThreadsafeFunction<String>) {
        let callbacks = self.event_callbacks.clone();
        callbacks.blocking_lock().push(callback);
    }

    /// 优雅关闭：断开全部会话并释放网络资源。幂等。
    #[napi]
    pub async fn shutdown(&self) -> Result<()> {
        if self
            .shutdown_done
            .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            return Ok(());
        }
        self.inner.shutdown().await.map_err(fabric_err)
    }
}

/// 事件泵：把 broadcast 接收循环桥接到已注册的 TSFN 回调。
fn spawn_event_pump(fabric: &Fabric) {
    let mut rx = fabric.inner.subscribe();
    let callbacks = fabric.event_callbacks.clone();
    let shutdown = fabric.shutdown_done.clone();
    tokio::spawn(async move {
        loop {
            let ev = match rx.recv().await {
                Ok(ev) => ev,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    continue; // 消费滞后：跳过丢失批次，继续投递后续事件
                }
                Err(_) => break, // sender dropped（fabric 释放）
            };
            if shutdown.load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }
            let payload = match &ev {
                FabricEvent::PeerConnected { endpoint_id } => {
                    let mut o = serde_json::Map::new();
                    o.insert("type".into(), "peer-connected".into());
                    o.insert("endpointId".into(), endpoint_id.as_str().into());
                    serde_json::Value::Object(o)
                }
                FabricEvent::PeerDisconnected { endpoint_id } => {
                    let mut o = serde_json::Map::new();
                    o.insert("type".into(), "peer-disconnected".into());
                    o.insert("endpointId".into(), endpoint_id.as_str().into());
                    serde_json::Value::Object(o)
                }
                FabricEvent::RosterUpdated => serde_json::json!({ "type": "roster-updated" }),
                FabricEvent::Message { from, data } => serde_json::json!({
                    "type": "message",
                    "from": from,
                    "dataBase64": BASE64.encode(data),
                }),
                FabricEvent::PathChanged {
                    endpoint_id,
                    status,
                } => serde_json::json!({
                    "type": "path-changed",
                    "endpointId": endpoint_id,
                    "status": link_status_str(*status),
                }),
            };
            let Ok(payload) = serde_json::to_string(&payload) else {
                continue;
            };
            for cb in callbacks.lock().await.iter() {
                cb.call(Ok(payload.clone()), ThreadsafeFunctionCallMode::NonBlocking);
            }
        }
    });
}

/// SDK 原生层版本
#[napi]
pub fn native_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
