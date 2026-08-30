# @jixo/opendweb-config

`definePlugin` helper for writing [opendweb](https://www.npmjs.com/package/opendweb) local plugin files — it wraps the declare/hook subprocess protocol (`--opendweb-declare` / `--opendweb-hook` + JSON over stdin/stdout) so a plugin only declares `{ name, hooks }`.

Runtime-agnostic: Deno, Bun, and Node can all host a plugin file; there are no `node:` dependencies at import time.

## Usage

```js
// opendweb.plugins/cf.ts  (local plugin file referenced from opendweb.config.toml)
#!/usr/bin/env -S deno run
import { definePlugin } from "npm:@jixo/opendweb-config";

export default definePlugin({
  name: "my-notify",
  hooks: {
    async "server.postReady"(ctx) {
      // ctx.options — plugin options from opendweb.config.toml
      // ctx.server  — resolved server config (public URLs, ...)
    },
  },
});
```

Under Node/Bun the same file works with a plain `import { definePlugin } from "@jixo/opendweb-config";` — only the shebang and specifier style differ.

## Protocol notes

- Declaring: the host runs the file with `--opendweb-declare`; `definePlugin` prints the hook manifest as JSON and exits.
- Hook calls: the host runs it with `--opendweb-hook <name>` and pipes the context JSON via stdin; the return value (or thrown error) is printed as JSON on stdout.
- stdout is fully flushed before the process exits (large hook results are never truncated mid-JSON).

License: MIT OR Apache-2.0.
