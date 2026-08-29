# syntax=docker/dockerfile:1

# ---- build stage ----
FROM rust:1.98-slim AS builder
WORKDIR /build
# 覆盖仓库 .cargo/config.toml 的本机绝对 target-dir（容器内不可用）
ENV CARGO_TARGET_DIR=/build/target

COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY .cargo .cargo
COPY crates crates
# workspace 成员必须齐备（client-sdk 是成员；仅构建 server 不编译它）
COPY packages/client-sdk packages/client-sdk

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    cargo build --release -p dweb-server && \
    cp target/release/dweb-server /usr/local/bin/dweb-server

# ---- run stage ----
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY --from=builder /usr/local/bin/dweb-server /usr/local/bin/dweb-server

# gateway 命名（connectivity-ux-hardening）：DWEB_GATEWAY_BIND 为 canonical
# （--http 别名与 DWEB_HTTP_BIND 已在 v0.2 移除）。gateway 承载 rendezvous +
# /healthz + /services.json（服务清单）+ /（纯文本摘要）；relay 独立端口。
# 反向代理终结 TLS 时设 DWEB_TRUST_PROXY=1，services.json 才采信 X-Forwarded-Proto；
# 隧道/反代后的公网入口用 DWEB_PUBLIC_GATEWAY_URL / DWEB_PUBLIC_RELAY_URL 覆盖公告。
ENV DWEB_GATEWAY_BIND=0.0.0.0:8787 \
    DWEB_RELAY_HTTP_BIND=0.0.0.0:3340 \
    DWEB_RELAY_ENABLED=true

EXPOSE 8787 3340

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD curl -sf http://127.0.0.1:8787/healthz || exit 1

ENTRYPOINT ["/usr/local/bin/dweb-server"]
