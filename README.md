# dweb

[中文版](README-zh.md)

Application-level networking platform (dweb-cloud): lets multi-device applications form logical networks — like game rooms, not a system-level VPN — with controlled, invite-based membership. Peers connect directly over QUIC when possible and fall back to a self-hostable relay.

```text
Identity  Ed25519 EndpointId (stable identity, decoupled from network
          addresses; z-base-32 display form)
Roster    signed facts (Genesis/Grant/Join/Revoke), content-addressed
          (BLAKE3) + union-merge convergence; controlled invites via
          issuer-online single redemption (challenge-response PoP +
          invite_id CAS consumption)
Session   iroh 1.1: QUIC direct + NAT traversal + self-hosted relay
          fallback; dual ALPN (regular/redeem); gating on both sides
          (gate before data); per-frame resource caps
Sync      opaque envelopes, bidirectional send/receive (Automerge
          adapter planned as a separate change)
```

## Packages

| npm package | Role |
| --- | --- |
| [`opendweb`](https://www.npmjs.com/package/opendweb) | Server CLI — `npx opendweb server` starts the self-hosted gateway + relay |
| [`@jixo/opendweb-server-binary`](https://www.npmjs.com/package/@jixo/opendweb-server-binary) | Server binary wrapper used by the CLI; also exposes a programmatic `startServer()` |
| [`@jixo/opendweb-example`](https://www.npmjs.com/package/@jixo/opendweb-example) | Reference two-process client CLI (`init` / `invite` / `join` / `chat`) |
| [`@jixo/opendweb-client-sdk`](https://www.npmjs.com/package/@jixo/opendweb-client-sdk) | Node SDK for embedding fabrics in your own app (napi-rs; darwin-arm64 / win32-x64) |

All packages are published at v0.2.1. Server deployments on other platforms can use the docker image `ghcr.io/gaubee/dweb`.

## Repository layout

- `crates/dweb-fabric` — networking kernel (Rust lib: identity/protocol/roster/session/fabric facade)
- `crates/dweb-server` — self-hosted server: iroh relay + rendezvous (Rust bin)
- `packages/client-sdk` — `@jixo/opendweb-client-sdk` (napi-rs)
- `packages/example` — `@jixo/opendweb-example` two-process fabric CLI
- `packages/server-binary` — `@jixo/opendweb-server-binary` server npm wrapper
- `docker/` — image `ghcr.io/gaubee/dweb` (rendezvous 8787 + relay 3340)

## Quick start

```bash
# 1. Start the self-hosted server (gateway + relay) — top-level CLI
npx opendweb server
#   or: docker run -p 8787:8787 -p 3340:3340 ghcr.io/gaubee/dweb
#   The banner lists every Network address. Any of them is the single
#   config entry for clients — the gateway discovers the relay URL
#   automatically via /services.json.

# 2. On each client machine: one-time config (persisted to ~/.opendweb/config.json)
npx @jixo/opendweb-example config set relay http://192.168.2.13:8787
#   A bare 0.1.0 relay URL (http://host:3340) also works (legacy mode).

# 3. Terminal A: initialize and keep a chat session running
npx @jixo/opendweb-example init --data ~/.dweb-a
npx @jixo/opendweb-example invite --data ~/.dweb-a --ttl 30m   # copy the token
npx @jixo/opendweb-example chat --data ~/.dweb-a

# 4. Terminal B (another directory/device): redeem the invite and chat
npx @jixo/opendweb-example join --data ~/.dweb-b <token>
npx @jixo/opendweb-example chat --data ~/.dweb-b
```

Expected server banner:

```text
  * opendweb server v0.2.1
  > Local:   http://localhost:8787
  > Network: http://192.168.1.100:8787

  Use any Network address as the single config entry for clients.

    NAME         PORT   STATE
    gateway      8787   entry point
    rendezvous   8787   merged into gateway
    relay        3340   enabled

  Press Ctrl+C to stop
```

**Invites must be redeemed while the inviter is online** (issuer-online single redemption): the inviter's process (e.g. a `chat` session) must stay running during redemption. A one-shot `invite` process produces a usable token in relay mode, but with no relay configured signing is refused outright (unless the `--allow-relayless` escape hatch is passed).

No per-terminal `export DWEB_RELAY=...` is needed — since v0.2 the client config (`config set relay`) is persisted once in `~/.opendweb/config.json` (dir 0700 / file 0600) and applies to every command. Configuration precedence is `flag > env > file > default`; `config list` shows each key's effective value and its source.

Proxy behavior: `--proxy auto|on|off` (default `auto`, config key `proxy`) controls whether the HTTP control plane (relay connections) goes through the system proxy; env read order is `HTTP_PROXY > http_proxy > HTTPS_PROXY > https_proxy`, consistent with iroh. **The QUIC data plane (direct connections + NAT traversal) never goes through an HTTP proxy** — in `auto` mode, a LAN relay that is directly reachable bypasses the proxy automatically, so the old manual `NO_PROXY` dance is gone.

Join failures carry stable error codes (`error[join/<code>]`): e.g. `NO_REACHABLE_PATH` fails instantly with guidance, `DIAL_TIMEOUT` notes the issuer is likely offline.

## Self-hosting the server

```bash
docker run -d -p 8787:8787 -p 3340:3340 ghcr.io/gaubee/dweb
# Clients configure the single entry point (the gateway discovers the relay):
#   config set relay http://<relay-host>:8787
```

Without docker, `npx opendweb server` runs the same binary. Server flags:

```bash
npx opendweb server --gateway 0.0.0.0:9999  # custom gateway port (--opt=value also works)
npx opendweb server --relay 0.0.0.0:3350    # custom relay port
npx opendweb server --no-relay              # relay off
DWEB_TRUST_PROXY=1 npx opendweb server      # behind a TLS-terminating reverse proxy
npx opendweb server --public-gateway https://dweb.example.com \
                    --public-relay   https://dweb.example.com   # see below
```

The gateway (port 8787) serves `/healthz`, `/services.json`, `/rendezvous/{id}` and a plain-text summary at `/`; the relay (port 3340) is a separate listener. Verify a running server with:

```bash
curl http://localhost:8787/healthz        # -> 200
curl http://localhost:8787/services.json  # -> machine-readable service manifest
```

### Environment variables (server)

| Variable | Default | Description |
| --- | --- | --- |
| `DWEB_GATEWAY_BIND` | `0.0.0.0:8787` | gateway listen address (healthz/rendezvous/services.json) |
| `DWEB_RELAY_HTTP_BIND` | `0.0.0.0:3340` | relay listen address |
| `DWEB_RELAY_ENABLED` | `true` | set to `false`/`0`/`off` to disable the relay |
| `DWEB_TRUST_PROXY` | unset | set `1` behind a TLS-terminating reverse proxy to honor `X-Forwarded-Proto` |
| `DWEB_PUBLIC_GATEWAY_URL` | unset | public gateway entry behind a reverse proxy/tunnel (e.g. `https://dweb.example.com`); when set, services.json and the banner advertise this value for the entry |
| `DWEB_PUBLIC_RELAY_URL` | unset | public relay entry; independent of the gateway override (flags `--public-gateway`/`--public-relay` are equivalent) |

Precedence is `flag > env > default`. Invalid public URLs are hard errors at startup.

## Deployment without a public IP: reverse proxy / tunnel (vendor-neutral, Cloudflare Tunnel as reference)

When the host has no public IP, any front-end that terminates TLS and forwards plain HTTP/WS upstream works (Cloudflare Tunnel, ngrok, frp, Caddy on a VPS...). There are only two requirements:

1. **Announce the public entry**: set `DWEB_PUBLIC_GATEWAY_URL` / `DWEB_PUBLIC_RELAY_URL`
   (form `http(s)://host[:port]`, no path — iroh clients drop the path of a relay
   URL); the gateway and relay entries can be overridden independently;
2. **Keep the upstream plain HTTP/WS**: the server listens in plaintext; TLS is
   terminated by the front-end (with `DWEB_TRUST_PROXY=1`, derived entries honor
   `X-Forwarded-Proto`).

Cloudflare Tunnel reference (free tier works; the domain must be hosted on CF):

```bash
# Zero Trust dashboard -> Networks -> Tunnels: create a tunnel, copy TUNNEL_TOKEN,
# route Public Hostnames by path on a single domain: /relay*, /ping* -> http://dweb:3340,
# everything else -> http://dweb:8787 (iroh clients build the /relay path themselves,
# so a single domain is enough)
cd docker && TUNNEL_TOKEN=... \
  DWEB_PUBLIC_GATEWAY_URL=https://dweb.example.com \
  DWEB_PUBLIC_RELAY_URL=https://dweb.example.com \
  docker compose up -d
# No host ports are published (tunnel-only exposure). Clients (from any network):
#   config set relay https://dweb.example.com
```

Direct hole-punching never goes through the tunnel (iroh QUIC peer-to-peer); the tunnel only carries the short rendezvous/services.json requests and relay fallback traffic (WS — iroh's 15s pings keep it alive through CF's 100s idle timeout). Field research and risks (measured mainland-China latency, ToS boundaries): `docs/research-cf-tunnel.md`.

## Client SDK (Node, darwin-arm64 / win32-x64)

```js
const { Fabric } = require("@jixo/opendweb-client-sdk");

const relay = { mode: "custom", urls: ["http://192.168.2.13:3340"] }; // relay URL from the server's /services.json

// Machine A: create the fabric (this node becomes root) and sign an invite
const a = await Fabric.createRoot({ dataDir: "/path/a", relay });
const token = await a.invite(60 * 60_000, null); // dweb1.-prefixed token, valid 60 min
const off = a.on((e) => console.log(e.type, e.data?.toString("utf8"))); // events; off() unsubscribes
console.log(await a.relayStatus()); // { mode, urls, online, lastError, activeUrl }

// Machine B: redeem the token (issuer must be online) and exchange messages
const b = await Fabric.joinWithToken({ dataDir: "/path/b", relay }, token);
await b.connect(a.endpointId);
await a.send(b.endpointId, Buffer.from("ping"));
await a.revoke(b.endpointId); // root-only

await a.shutdown();
await b.shutdown();
```

Event types: `peer-connected` / `peer-disconnected` (`endpointId`), `roster-updated`, `message` (`from`, `data: Buffer`), `path-changed` (`endpointId`, `status: "direct" | "relay" | "unknown"`), `relay-online` / `relay-offline` (full `RelayStatus` payload). Always read the initial state from `relayStatus()`; events only carry subsequent transitions.

`FabricOptions`: `dataDir` (required), `relay?: { mode: "n0" } | { mode: "disabled" } | { mode: "custom", urls: [...] }`, `httpProxy?: "none" | "from-env" | { url }` (default `"none"`; QUIC data plane never proxied), `advertiseAddrs?: string[]`, `joinTimeoutMs?: number` (default 30000, range 1s..10m).

## Identity storage and recovery (trust-model neutral)

The kernel does not mandate where the secret lives — that is a product trust-model decision:

```text
purely local (default)     encrypted custody                product-managed
identity.key file          account system stores the        service holds the
(FileSecretStore)          exportSecret ciphertext; the     plaintext key
                           passphrase-derived key stays
                           with the user
```

```js
const token = await fabric.exportSecretPassphrase("passphrase"); // dwebkey1... ciphertext
const handle = await importSecret(token, "passphrase"); // opaque handle
const fabric2 = await Fabric.createRoot({ dataDir }, handle); // restore the same identity
```

- Export is an **identity export** (identity seed only, no roster — the roster is rebuilt via network sync)
- The handle is one-shot: if construction fails it is returned automatically and can be retried; the plaintext seed never passes through a JS string
- Custom storage (Keychain / managed backends): implement the `SecretStore` trait on the Rust side (`load`/`create` with linearized insert-if-absent) and inject it via `SecretInjection::Store`

## Documentation and testing

- [EXAMPLE.md](EXAMPLE.md) — end-to-end release regression manual (English)
- [EXAMPLE-zh.md](EXAMPLE-zh.md) — the same manual in Chinese
- `docs/research-cf-tunnel.md` — Cloudflare Tunnel field research

## Development

```bash
cargo test --workspace                              # Rust (fabric kernel + server)
pnpm --filter @jixo/opendweb-client-sdk test        # node --test (SDK lifecycle)
pnpm --filter @jixo/opendweb-example test           # node --test (two-process relay E2E)
```

- The repository lives on a network disk: Rust builds use a local `CARGO_TARGET_DIR` (`.cargo/config.toml` machine-local config; CI/containers override via env).
- Native binaries are loaded from a content-addressed temp path (avoids SMB page cache and dyld bad-closure issues).
- Development is OpenSpec-driven; see `openspec/changes/` for active changes.

## License

MIT OR Apache-2.0. Repository: <https://github.com/Gaubee/dweb>.
