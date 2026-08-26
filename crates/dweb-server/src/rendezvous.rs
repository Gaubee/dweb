//! rendezvous 登记/解析：节点用 EndpointId 私钥签名登记可达地址（带 TTL），
//! 其它节点按 EndpointId 查询仍在有效期内的登记项。
//! 规格：openspec/changes/fabric-mvp/specs/server/spec.md

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::Verifier;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use thiserror::Error;

/// 签名时间戳允许窗口（毫秒），防重放
const TIMESTAMP_WINDOW_MS: u64 = 120_000;
/// TTL 上限（秒）
const MAX_TTL_SECS: u64 = 3600;

#[derive(Debug, Error)]
pub enum RendezvousError {
    #[error("invalid endpoint id: expected 64-char hex")]
    InvalidEndpointId,
    #[error("invalid signature")]
    InvalidSignature,
    #[error("timestamp out of window")]
    StaleTimestamp,
    #[error("ttl exceeds maximum {MAX_TTL_SECS}s")]
    TtlTooLarge,
    #[error("endpoint id mismatch between path and body")]
    IdMismatch,
    #[error("invalid address entry")]
    InvalidAddr,
}

impl RendezvousError {
    fn status(&self) -> StatusCode {
        match self {
            Self::InvalidEndpointId | Self::IdMismatch | Self::InvalidAddr => {
                StatusCode::BAD_REQUEST
            }
            Self::InvalidSignature | Self::StaleTimestamp => StatusCode::UNAUTHORIZED,
            Self::TtlTooLarge => StatusCode::BAD_REQUEST,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnnounceRequest {
    pub endpoint_id: String,
    pub addrs: Vec<String>,
    pub ttl_secs: u64,
    pub timestamp_ms: u64,
    /// Ed25519 签名，base64url-nopad
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolveResponse {
    pub endpoint_id: String,
    pub addrs: Vec<String>,
    pub expires_at_ms: u64,
}

#[derive(Debug, Clone)]
struct Entry {
    addrs: Vec<String>,
    expires_at_ms: u64,
}

#[derive(Default)]
pub struct Registry {
    entries: Mutex<HashMap<[u8; 32], Entry>>,
}

pub type SharedRegistry = Arc<Registry>;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn decode_endpoint_id(s: &str) -> Result<[u8; 32], RendezvousError> {
    let bytes = hex::decode(s).map_err(|_| RendezvousError::InvalidEndpointId)?;
    bytes
        .try_into()
        .map_err(|_| RendezvousError::InvalidEndpointId)
}

/// 规范签名载荷：
/// "dweb-rendezvous-announce-v1\0" || endpoint_id(32B) || timestamp_ms(u64 LE)
/// || addr_count(u16 LE) || per-addr(u16 LE len || utf8) || ttl_secs(u32 LE)
pub fn announce_canonical_bytes(
    endpoint_id: &[u8; 32],
    timestamp_ms: u64,
    addrs: &[String],
    ttl_secs: u32,
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(64 + addrs.iter().map(|a| a.len() + 2).sum::<usize>());
    buf.extend_from_slice(b"dweb-rendezvous-announce-v1\0");
    buf.extend_from_slice(endpoint_id);
    buf.extend_from_slice(&timestamp_ms.to_le_bytes());
    buf.extend_from_slice(&(addrs.len() as u16).to_le_bytes());
    for addr in addrs {
        buf.extend_from_slice(&(addr.len() as u16).to_le_bytes());
        buf.extend_from_slice(addr.as_bytes());
    }
    buf.extend_from_slice(&ttl_secs.to_le_bytes());
    buf
}

pub fn router() -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/rendezvous/{id}", post(announce).get(resolve))
        .with_state(Arc::new(Registry::default()))
}

async fn healthz() -> StatusCode {
    StatusCode::OK
}

async fn announce(
    State(registry): State<SharedRegistry>,
    Path(id): Path<String>,
    Json(req): Json<AnnounceRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    handle_announce(&registry, &id, req).map_err(|e| (e.status(), e.to_string()))
}

fn handle_announce(
    registry: &Registry,
    path_id: &str,
    req: AnnounceRequest,
) -> Result<StatusCode, RendezvousError> {
    if req.endpoint_id != path_id {
        return Err(RendezvousError::IdMismatch);
    }
    let id_bytes = decode_endpoint_id(&req.endpoint_id)?;
    if req.addrs.is_empty() || req.addrs.iter().any(|a| a.is_empty() || a.len() > 512) {
        return Err(RendezvousError::InvalidAddr);
    }
    if req.ttl_secs == 0 || req.ttl_secs > MAX_TTL_SECS {
        return Err(RendezvousError::TtlTooLarge);
    }
    let now = now_ms();
    if req.timestamp_ms.abs_diff(now) > TIMESTAMP_WINDOW_MS {
        return Err(RendezvousError::StaleTimestamp);
    }
    let canonical =
        announce_canonical_bytes(&id_bytes, req.timestamp_ms, &req.addrs, req.ttl_secs as u32);
    let sig_bytes: [u8; 64] = URL_SAFE_NO_PAD
        .decode(&req.signature)
        .map_err(|_| RendezvousError::InvalidSignature)?
        .try_into()
        .map_err(|_| RendezvousError::InvalidSignature)?;
    let verifying = ed25519_dalek::VerifyingKey::from_bytes(&id_bytes)
        .map_err(|_| RendezvousError::InvalidEndpointId)?;
    verifying
        .verify(
            &canonical,
            &ed25519_dalek::Signature::from_bytes(&sig_bytes),
        )
        .map_err(|_| RendezvousError::InvalidSignature)?;

    let expires_at_ms = now + req.ttl_secs * 1000;
    registry.entries.lock().unwrap().insert(
        id_bytes,
        Entry {
            addrs: req.addrs,
            expires_at_ms,
        },
    );
    Ok(StatusCode::NO_CONTENT)
}

async fn resolve(
    State(registry): State<SharedRegistry>,
    Path(id): Path<String>,
) -> Result<Json<ResolveResponse>, (StatusCode, String)> {
    let id_bytes = decode_endpoint_id(&id).map_err(|e| (e.status(), e.to_string()))?;
    let now = now_ms();
    let entries = registry.entries.lock().unwrap();
    match entries.get(&id_bytes) {
        Some(entry) if entry.expires_at_ms > now => Ok(Json(ResolveResponse {
            endpoint_id: id,
            addrs: entry.addrs.clone(),
            expires_at_ms: entry.expires_at_ms,
        })),
        _ => Err((StatusCode::NOT_FOUND, "no active registration".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use ed25519_dalek::{Signer, SigningKey};
    use tower::ServiceExt;

    fn signed_request(key: &SigningKey, addrs: Vec<&str>, ttl: u64, ts: u64) -> AnnounceRequest {
        let id_bytes = key.verifying_key().to_bytes();
        let addrs: Vec<String> = addrs.into_iter().map(String::from).collect();
        let canonical = announce_canonical_bytes(&id_bytes, ts, &addrs, ttl as u32);
        let sig = key.sign(&canonical);
        AnnounceRequest {
            endpoint_id: hex::encode(id_bytes),
            addrs,
            ttl_secs: ttl,
            timestamp_ms: ts,
            signature: URL_SAFE_NO_PAD.encode(sig.to_bytes()),
        }
    }

    #[tokio::test]
    async fn announce_then_resolve() {
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let app = router();
        let req = signed_request(&key, vec!["127.0.0.1:9000"], 60, now_ms());
        let id = req.endpoint_id.clone();

        let res = app
            .clone()
            .oneshot(
                Request::post(format!("/rendezvous/{id}"))
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&req).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);

        let res = app
            .oneshot(
                Request::get(format!("/rendezvous/{id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let resolved: ResolveResponse = serde_json::from_slice(&body).unwrap();
        assert_eq!(resolved.addrs, vec!["127.0.0.1:9000".to_string()]);
    }

    #[tokio::test]
    async fn invalid_signature_rejected() {
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let other = SigningKey::from_bytes(&[8u8; 32]);
        let mut req = signed_request(&key, vec!["127.0.0.1:9000"], 60, now_ms());
        // 用另一个 key 重签：对 id_bytes(属于 key) 的 canonical 签名必然验证失败
        let id_bytes = key.verifying_key().to_bytes();
        let canonical =
            announce_canonical_bytes(&id_bytes, req.timestamp_ms, &req.addrs, req.ttl_secs as u32);
        req.signature = URL_SAFE_NO_PAD.encode(other.sign(&canonical).to_bytes());

        let app = router();
        let res = app
            .oneshot(
                Request::post(format!("/rendezvous/{}", req.endpoint_id))
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&req).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn stale_timestamp_rejected() {
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let req = signed_request(&key, vec!["127.0.0.1:9000"], 60, now_ms() - 600_000);
        let app = router();
        let res = app
            .oneshot(
                Request::post(format!("/rendezvous/{}", req.endpoint_id))
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&req).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn expired_entry_not_resolved() {
        let key = SigningKey::from_bytes(&[9u8; 32]);
        let registry = Arc::new(Registry::default());
        let id_bytes = key.verifying_key().to_bytes();
        registry.entries.lock().unwrap().insert(
            id_bytes,
            Entry {
                addrs: vec!["127.0.0.1:9000".into()],
                expires_at_ms: now_ms() - 1,
            },
        );
        let app = Router::new()
            .route("/rendezvous/{id}", get(resolve))
            .with_state(registry);
        let res = app
            .oneshot(
                Request::get(format!("/rendezvous/{}", hex::encode(id_bytes)))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }
}
