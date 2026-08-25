//! @dweb/client-sdk 绑定层：fabric kernel 的 Node API 投影。
//! 占位实现，kernel session API 稳定后填充（fabric-mvp 5.2）。

use napi_derive::napi;

/// SDK 原生层版本
#[napi]
pub fn native_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
