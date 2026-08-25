# syntax=docker/dockerfile:1

# ---- build stage ----
FROM rust:1.98-slim AS builder
WORKDIR /build

# cargo-chef 缓存依赖层，避免源码变动触发全量重编
RUN cargo install cargo-chef --locked
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates crates
COPY .cargo .cargo

RUN cargo chef prepare --recipe-path recipe.json
RUN cargo chef cook --release --recipe-path recipe.json

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo build --release -p dweb-server && \
    cp target/release/dweb-server /usr/local/bin/dweb-server

# ---- run stage ----
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /usr/local/bin/dweb-server /usr/local/bin/dweb-server

ENV DWEB_HTTP_BIND=0.0.0.0:8787 \
    DWEB_RELAY_HTTP_BIND=0.0.0.0:3340 \
    DWEB_RELAY_ENABLED=true

EXPOSE 8787 3340

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD bash -c 'exec 3<>/dev/tcp/127.0.0.1/8787 && printf "GET /healthz HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n" >&3 && grep -q "200" <&3'

ENTRYPOINT ["/usr/local/bin/dweb-server"]
