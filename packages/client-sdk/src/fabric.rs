//! @dweb/client-sdk 绑定层：fabric kernel 的 Node API 投影。
//! 生命周期契约：所有异步方法在 shutdown 后返回错误；事件回调在 shutdown 后
//! 不再触发；重复 shutdown 幂等。

use dweb_fabric::{
    Fabric as RustFabric, FabricConfig as RustFabricConfig, FabricEvent, LinkStatus, RelayConfig,
};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::sync::Arc;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as BASE64;
use base64::Engine as _;
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
    /// 数据目录（身份密钥与名册持久化位置）
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

fn to_options(opts: FabricOptions) -> RustFabricConfig {
    RustFabricConfig {
        data_dir: opts.data_dir.into(),
        relay: to_relay_config(opts.relay),
        advertise_addrs: opts.advertise_addrs.unwrap_or_default(),
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
    pub async fn create_root(opts: FabricOptions) -> Result<Fabric> {
        Self::build(RustFabric::create_root(to_options(opts)).await)
    }

    /// 打开已有 fabric（数据目录已含名册）。
    #[napi(factory)]
    pub async fn open(opts: FabricOptions) -> Result<Fabric> {
        Self::build(RustFabric::open(to_options(opts)).await)
    }

    /// 以加入者身份起步（空名册；随后调用 join 兑换邀请）。
    #[napi(factory)]
    pub async fn attach(opts: FabricOptions, fabric_id_hex: String) -> Result<Fabric> {
        Self::build(RustFabric::attach(to_options(opts), &fabric_id_hex).await)
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
        self.inner.disconnect(&endpoint_id).await.map_err(fabric_err)
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
                FabricEvent::PathChanged { endpoint_id, status } => serde_json::json!({
                    "type": "path-changed",
                    "endpointId": endpoint_id,
                    "status": link_status_str(*status),
                }),
            };
            let Ok(payload) = serde_json::to_string(&payload) else { continue };
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
