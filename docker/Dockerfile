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

ENV DWEB_HTTP_BIND=0.0.0.0:8787 \
    DWEB_RELAY_HTTP_BIND=0.0.0.0:3340 \
    DWEB_RELAY_ENABLED=true

EXPOSE 8787 3340

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD curl -sf http://127.0.0.1:8787/healthz || exit 1

ENTRYPOINT ["/usr/local/bin/dweb-server"]
