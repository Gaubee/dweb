# fabric/relay-ca-tls-api

## Purpose

FabricConfig.relay_ca_tls 当前直接暴露 iroh_relay::tls::CaTlsConfig（上游类型），
包含 insecure_skip_verify 能力——公共 API 耦合与安全边界未收口。

## ADDED Requirements

### Requirement: 受限 TLS 信任抽象

relay_ca_tls SHALL 使用 dweb 自有的受限枚举（如
`RelayTlsTrust::PlatformRoot | CustomPem(Vec<u8>)`）或通过 feature flag
限制为 test-only。公共 Rust API MUST NOT 直接暴露 iroh_relay 上游类型。
`insecure_skip_verify` MUST NOT 在默认构建中对下游可达。

#### Scenario: 自定义 CA 信任

- **WHEN** 自托管 relay 使用自定义 CA 签发证书
- **THEN** 调用方可通过 CustomPem(path) 配置信任，无需依赖上游类型

#### Scenario: insecure 不可达

- **WHEN** 默认 feature 构建的公共 API
- **THEN** insecure_skip_verify 不可调用（仅 test feature 下可用）
