# @jixo/opendweb-ext-cf 1.0

Cloudflare Tunnel provider for the [opendweb](https://www.npmjs.com/package/opendweb) server CLI: browser-login (or API-token) discovery of zones and tunnels, idempotent provisioning of ingress rules + DNS + local config, end-to-end verification, and a managed cloudflared connector runtime. Zero runtime dependencies.

## What changed in 1.0 (breaking)

- **One credential instead of two.** 0.x asked for a connector token (TUNNEL_TOKEN) *and* a management token (CF_API_TOKEN). 1.0 authenticates once - browser OAuth login (`opendweb cf login`) or a single `CLOUDFLARE_API_TOKEN` - and discovers accounts, zones and tunnels through the API, fetching connector tokens on demand.
- **Account IDs are derived, never asked for.** The zone object carries its account; pick a zone and everything else follows (0.x's `zones?account.id=` filtering failed for scoped tokens - fixed by design).
- **Idempotent provisioning.** Re-running setup reuses the tunnel (`opendweb-<hostname>` naming), no-ops equal configs and correct DNS records, and asks before replacing a conflicting DNS record. Nothing is silently overwritten; nothing is deleted.
- **cloudflared auto-install.** An existing binary on PATH (or `CLOUDFLARED_BIN`) is used; otherwise the official binary is fetched (GitHub releases) into `~/.opendweb/cloudflared/`. Note: the downloader performs no checksum verification - pin `CLOUDFLARED_BIN` to a binary you trust if that matters to you.
- `TUNNEL_TOKEN` remains the *runtime* credential for `[plugins.options] tunnel = true` (the server co-spawns cloudflared); setup shows it once at the end of a fresh provision. The old two-token wizard is gone.

## Authentication

Two paths, tried in this order at each prompt:

1. **Browser login** (preferred): `npx opendweb cf login` runs OAuth Authorization Code + PKCE against Cloudflare, receiving the callback on `http://127.0.0.1:18971/callback`. The refresh token is stored in `~/.opendweb/cf-auth.json` (0600); access tokens live in memory only. Requires an OAuth client: until a bundled public client ships, create one (Manage Account -> OAuth clients) with grant types **Authorization Code + Refresh Token**, token endpoint auth **None (PKCE)**, redirect URI `http://127.0.0.1:18971/callback`, and these permission scopes: **Zone / Read, DNS / Read + Edit, and "Argo Tunnel (Legacy)" / Read + Edit** (the legacy-named row is Cloudflare Tunnel), then export `CF_OAUTH_CLIENT_ID`. Verified end-to-end 2026-08-31 against the real authorize/token endpoints: this scope set drives the full provisioning chain (zones, DNS records, tunnel create/configure/token/delete) - no API-token fallback needed.
2. **API token** (fallback): `CLOUDFLARE_API_TOKEN` with a custom token carrying
   - Account / Cloudflare Tunnel / Edit
   - Zone / DNS / Edit
   - Zone / Zone / Read

   Paste it in the wizard (masked input, head/tail summary, explicit confirm) or export it for CI.

## Flow

```
npx opendweb cf login            # once (browser)
npx opendweb cf setup            # zone -> hostname -> tunnel -> mode -> apply
npx opendweb server              # with [plugins.options] tunnel = true + TUNNEL_TOKEN
```

`cf setup` is safe to re-run: it reconciles toward the desired state (reuse/no-op/ask). `cf status` reports config, plan, plugin lock, auth session and resource anchors. `cf verify` runs the public end-to-end check (services.json). `cf plan` previews hostnames and ingress rules.

A tunnel child dying after the startup grace window is never a silent fake success - a WARNING goes to stderr. Ingress is always pushed as a full replacement ending in a `http_status:404` catch-all; this tunnel's config is owned by opendweb, so do not hand-edit it for other purposes.

## Development

`npm run build` (tsdown) -> `npm test`; `npm run pack:dry` gates the artifact (builds first; asserts zero runtime dependencies, no bundled-import residue in dist, and a dist size cap). The control-plane gateway defaults to a hand-rolled REST client; `CF_CLIENT=sdk` switches to the official `cloudflare` SDK (tree-shakable) for comparison - both implement the same `CfGateway` interface.

License: MIT OR Apache-2.0.
