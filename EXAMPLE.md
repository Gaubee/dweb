# dweb Example — End-to-End Testing Guide

This guide walks you through testing dweb's published npm packages end to end. Follow it after every release to verify the full stack.

**Current version: v0.3.1** | [中文版](EXAMPLE-zh.md)

## What You'll Build

```
┌─────────────────────┐                        ┌──────────────────┐
│   opendweb server   │◄── /services.json ──── │  Example clients  │
│                     │    (auto-discovery)    │                  │
│  gateway  :8787     │                        │  A = root         │
│  relay    :3340     │                        │  B = joiner       │
└─────────────────────┘                        └──────────────────┘
     ▲      ▲      ▲
     │      │      │        A signs invites (must stay online)
   A ◄──── B ◄──── ┘        B redeems tokens to join
                             Messages: QUIC direct (preferred) or relay
```

**Key concept**: the **gateway** (port 8787) is the single configuration entry for clients. The relay URL is auto-discovered via `/services.json` — you never need to tell clients about port 3340.

---

## Prerequisites

- Node.js >= 20
- Two machines (or two isolated directories on one machine)
- No proxy configuration needed — `proxy=auto` detects LAN relays automatically

---

## Step 1: Start the Server

```bash
npx opendweb@0.2.0 server
```

You'll see:

```
  * opendweb server v0.3.1
  > Local:   http://localhost:8787
  > Network: http://192.168.1.100:8787

  Use any Network address as the single config entry for clients.

    NAME         PORT   STATE
    gateway      8787   entry point
    relay        3340   enabled

  Press Ctrl+C to stop
```

> Note the **Network** address — that's what clients will use.

### Verify the server

```bash
# Health check
curl http://localhost:8787/healthz

# Service manifest (the key to auto-discovery)
curl http://localhost:8787/services.json
```

The manifest should show the relay on its actual port:

```json
{
  "gateway": "http://192.168.1.100:8787",
  "services": [
    { "name": "relay", "enabled": true, "url": "http://192.168.1.100:3340" }
  ]
}
```

### Server options

```bash
npx opendweb server --gateway 0.0.0.0:9999   # custom port
npx opendweb server --gateway=0.0.0.0:9999   # --opt=value also works
npx opendweb server --no-relay               # relay off
DWEB_TRUST_PROXY=1 npx opendweb server       # behind TLS reverse proxy
```

---

## Step 2: Set Up Client A (Root)

```bash
# One-time setup (persisted to ~/.opendweb/config.json)
npx @jixo/opendweb-example@0.2.0 config set relay http://192.168.1.100:8787

# Initialize as root
npx @jixo/opendweb-example@0.2.0 init --data ~/.dweb-a

# Start chat (keep this running)
npx @jixo/opendweb-example@0.2.0 chat --data ~/.dweb-a
```

Expected:

```
fabric initialized
  endpoint-id : abcdefgh...  (52-char z32 ID)
  data-dir    : ~/.dweb-a
```

```
chat ready as abcdefgh... (~/.dweb-a)
relay: online (1 candidate)
```

> **No `export DWEB_RELAY=...` needed** — the config file persists across terminals.

### Sign an invite

Open a second terminal (keep chat running):

```bash
npx @jixo/opendweb-example@0.2.0 invite --data ~/.dweb-a --ttl 30m
```

This outputs a `dweb1.` prefixed token. Copy it.

> **The chat process must stay running** — invites are redeemed online (issuer-online semantics). If A goes offline, joins will time out.

### The invite safety gate

If no relay is configured, `invite` refuses to sign a dead token:

```bash
DWEB_RELAY=disabled npx @jixo/opendweb-example@0.2.0 invite --data ~/.dweb-a
# error[invite/INVITE_WITHOUT_RELAY]: no relay configured; set one via
#   'config set relay <url>' or pass --allow-relayless ...
```

---

## Step 3: Set Up Client B (Joiner)

On a second machine (or a second data directory):

```bash
# Same one-time config
npx @jixo/opendweb-example@0.2.0 config set relay http://192.168.1.100:8787

# Redeem the invite
npx @jixo/opendweb-example@0.2.0 join --data ~/.dweb-b <paste-token>

# Start chatting
npx @jixo/opendweb-example@0.2.0 chat --data ~/.dweb-b
```

Expected:

```
joined fabric <hex-id>
  endpoint-id : ...
  members     : 2
```

```
chat ready as ... (~/.dweb-b)
relay: online (1 candidate)
-- abcdefgh connected (...)
```

Both sides now see each other. Type messages and press Enter to send.

---

## Step 4: Test the Full Flow

### Messages

Type in either chat terminal — messages appear on the other side instantly (direct connection) or via relay (NAT-blocked).

### Revoke (root only)

```bash
# From A's side, revoke B:
npx @jixo/opendweb-example@0.2.0 revoke <B's-endpoint-id> --data ~/.dweb-a
```

B gets disconnected; subsequent connection attempts are rejected.

### Error diagnostics

Join failures produce actionable error codes:

| Scenario | What you see |
|---|---|
| Inviter offline | `error[join/DIAL_TIMEOUT]: issuer did not respond within 30s (relay online: issuer likely offline...)` |
| Token already used | `error[join/TOKEN_CONSUMED]: this invite token was already used; invites are single-use` |
| Token signed without relay | `error[join/NO_REACHABLE_PATH]: the token carries no relay URL...` (fails instantly) |
| Wrong data dir | `error[join/WRONG_FABRIC]: data dir ... belongs to fabric <a> but the token is for fabric <b>; use a fresh --data directory` |
| Expired token | `error[join/TOKEN_EXPIRED]: the invite token has expired; ask the inviter for a new one` |

---

## Configuration Reference

```bash
npx @jixo/opendweb-example@0.2.0 config list
```

```
relay         = http://192.168.1.100:8787  (file)
proxy         = auto                        (default)
data          = ~/.dweb-example             (default)
inviteTtlMs   = 3600000                     (default)
joinTimeoutMs = 30000                       (default)
```

| Command | Description |
|---|---|
| `config set relay <url>` | Set relay (gateway or bare relay URL) |
| `config set relay <url1> <url2>` | Multiple relays (iroh handles failover) |
| `config set proxy auto\|on\|off` | Proxy policy |
| `config set data <dir>` | Default data directory |
| `config unset <key>` | Reset to default |

**Precedence**: `flag > env > file > default`. Environment `DWEB_RELAY=disabled` overrides the file.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `invite` fails with INVITE_WITHOUT_RELAY | No relay configured | `config set relay http://<IP>:8787` |
| `join` times out (DIAL_TIMEOUT) | Inviter offline | Keep A's chat running |
| `join` fails instantly (NO_REACHABLE_PATH) | Token signed without relay | Have A configure relay, then re-invite |
| Chat shows `relay offline` WARNING | Relay unreachable | Check server process / firewall |
| `gateway ... returned JSON but not a services manifest` | Pointed at wrong HTTP service | Verify the address runs `opendweb server` |

---

## Post-Release Regression Checklist

Run after every npm publish:

- [ ] `npx opendweb@<ver> server` starts; banner is ASCII, IPs enumerated
- [ ] `curl /healthz` returns 200
- [ ] `curl /services.json` shows relay on port 3340
- [ ] `config set relay http://<IP>:8787` resolves gateway → relay URL
- [ ] `init` + `chat` shows `relay: online`
- [ ] `invite` produces a `dweb1.` token
- [ ] No-relay `invite` → `error[invite/INVITE_WITHOUT_RELAY]`
- [ ] Second machine `join <token>` → `joined fabric ... members: 2`
- [ ] Bidirectional chat messages arrive (including non-ASCII text)
- [ ] `revoke` disconnects the revoked peer
- [ ] Same token re-join → `error[join/TOKEN_CONSUMED]`
- [ ] Inviter offline → `error[join/DIAL_TIMEOUT]` within 30s
- [ ] Relayless token `join` → `error[join/NO_REACHABLE_PATH]` instantly
- [ ] `config list` shows source annotations
- [ ] Invalid `config set relay` → no write + exit 1

---

## v0.2 → v0.3 Changes

- `relayStatus()` / `relay-*` events now include **`activeUrl`** (lowest-config-order connected relay; events carry the transition-time snapshot copy)
- Server public-entry overrides: `--public-gateway` / `--public-relay` and `DWEB_PUBLIC_*_URL` (reverse-proxy/tunnel deployments, see compose.yaml)
- n0 mode `urls` is now iroh's real default relay list (4 regional nodes, matching actual dialing)
- Rust API: `relay_ca_tls` narrowed to `RelayTlsTrust` (PlatformRoot | CustomPem; N0+CustomPem rejected)
- Windows artifacts built by CI cross-compilation (release workflow replaces them automatically); npm tarball manifest gate
- Lifecycle convergence: shutdown completion semantics (concurrent/sequential/cancellation-safe, no residual tasks, no post-completion events), bounded known_addrs, bounded send

## v0.1 → v0.2 Changes

| Area | v0.1 | v0.2 |
|---|---|---|
| Client config | `export DWEB_RELAY=...` per terminal | `config set relay` once, persisted |
| Relay discovery | Manually specify port 3340 | Auto via gateway `/services.json` |
| Invite safety | Signs dead tokens silently | Refuses (with `--allow-relayless` escape) |
| Join diagnostics | 30s silent timeout | 8 error codes with actionable messages |
| Default TTL | 10 minutes | 60 minutes (`--ttl 30m` adjustable) |
| Proxy | Manual `NO_PROXY` | `auto` probes and bypasses |
| Relay status | Silent (fake "ready") | Visible online/offline + lastError |
| Wrong fabric | Misleading "corrupted" | Dedicated error with guidance |
| CLI args | `--opt value` only | `--opt=value`, `~` expansion, unknown option errors |

## Links

- [README](README.md) — project overview, SDK usage
- [中文测试手册](EXAMPLE-zh.md) — this guide in Chinese
