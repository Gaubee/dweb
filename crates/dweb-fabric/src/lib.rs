pub mod fabric;
pub mod identity;
// 有界 known_addrs 存储（HB 3.1 内部实现细节）
mod known_addrs;
pub mod protocol;
pub mod roster;
pub mod secret;
pub mod session;

pub use fabric::{
    Fabric, FabricConfig, FabricError, FabricEvent, HttpProxyConfig, InviteOptions,
    JOIN_TIMEOUT_MS_DEFAULT, JOIN_TIMEOUT_MS_MAX, JOIN_TIMEOUT_MS_MIN, JoinErrorCode, MemberInfo,
    RelayConfig, RelayProbeFn, RelayStatusSnapshot, RelayStatusView, RelayTlsTrust,
    SecretInjection, normalize_advertise_addrs, precheck_join_token, set_relay_probe_for_tests,
};
pub use session::{LinkStatus, RedeemError, SessionError};
