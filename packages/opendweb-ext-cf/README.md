# @jixo/opendweb-ext-cf

Cloudflare Tunnel plugin for the [opendweb](https://www.npmjs.com/package/opendweb) server CLI: guided exposure setup (ingress push via the Cloudflare API, DNS routing, end-to-end verification) and optional `cloudflared` co-spawn for the server's lifetime.

Zero runtime dependencies — everything (including the interactive wizard UI) is bundled at build time.

## Faces

This package exposes two entry points:

- `.` — the plugin face, loaded by the opendweb server from `opendweb.config.toml`:

  ```toml
  [[plugins]]
  name = "cf"

  [plugins.options]
  tokenEnv = "TUNNEL_TOKEN" # default
  tunnel   = true           # co-spawn cloudflared with the server
  ```

  Hooks: `setup` (non-interactive wizard), `server.postReady` (self-check + co-spawn + banner lines), `server.preStop` (reap the co-spawned child).

- `./opendweb-plugin` — the command face, run by the opendweb CLI: `cf setup` (interactive `@clack/prompts` wizard when on a TTY), plus `verify` / `plan` / `status` subcommands.

## Quick start

```sh
# 1. get a tunnel token (Zero Trust -> Networks -> Tunnels) and export it
export TUNNEL_TOKEN=...

# 2. guided setup: hostname, ingress push, DNS route, verification
npx opendweb cf setup

# 3. let the server own the tunnel process
npx opendweb server   # with [plugins.options] tunnel = true
```

A tunnel child that dies after the startup grace window is never a silent fake success — a `WARNING` goes to stderr and the banner reflects reality.

## Development

`npm run build` (tsdown) → `npm test`; `npm run pack:dry` gates the release artifact (builds first, asserts zero runtime dependencies and no bundled-import residue in `dist`).

License: MIT OR Apache-2.0.
