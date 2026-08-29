// CLI 面（./opendweb-plugin）：命令清单 + run。命令与钩子共享 wizard 核心。
import { runSetup, verifyExposure, planExposure } from "./wizard.js";

export default {
  name: "cf",
  apiVersion: 1,
  commands: [
    {
      name: "setup",
      description: "wire a Cloudflare Tunnel to this server: push ingress via API, route DNS, write opendweb.config.toml, verify end-to-end",
      args: {
        type: "object",
        properties: {
          "token-env": { type: "string" },
          hostname: { type: "string" },
          mode: { type: "string" },
          "dry-run": { type: "boolean" },
          "skip-verify": { type: "boolean" },
        },
        required: ["hostname"],
      },
    },
    {
      name: "verify",
      description: "end-to-end check: fetch the public services.json and assert the advertised relay URL",
      args: {
        type: "object",
        properties: { hostname: { type: "string" }, mode: { type: "string" } },
        required: ["hostname"],
      },
    },
    {
      name: "plan",
      description: "show the exposure plan (hosts, URLs, ingress rules) without touching anything",
      args: {
        type: "object",
        properties: { hostname: { type: "string" }, mode: { type: "string" } },
        required: ["hostname"],
      },
    },
  ],
  async run({ command, args, log, cwd }) {
    const mode = args.mode === "single" ? "single" : "dual";
    if (command === "plan") {
      const plan = planExposure({ hostname: args.hostname, mode });
      log(`mode:        ${plan.mode}`);
      log(`gateway:     ${plan.gatewayHost} (${plan.publicGatewayUrl})`);
      log(`relay:       ${plan.relayHost} (${plan.publicRelayUrl})`);
      return { exit: 0 };
    }
    if (command === "verify") {
      const plan = planExposure({ hostname: args.hostname, mode });
      const v = await verifyExposure({ publicGatewayUrl: plan.publicGatewayUrl, expectedRelayUrl: plan.publicRelayUrl });
      if (!v.ok) {
        throw new Error(v.error);
      }
      log(`ok: ${plan.publicGatewayUrl}/services.json advertises ${plan.publicRelayUrl}`);
      return { exit: 0 };
    }
    if (command === "setup") {
      const tokenEnv = args["token-env"] ?? "TUNNEL_TOKEN";
      const token = process.env[tokenEnv];
      if (!token && !args["dry-run"]) {
        throw new Error(`missing ${tokenEnv} in the environment; copy the tunnel token from Zero Trust -> Networks -> Tunnels`);
      }
      await runSetup({
        token: token ?? "dry-run-token",
        hostname: args.hostname,
        mode,
        cwd,
        tokenEnvName: tokenEnv,
        dryRun: Boolean(args["dry-run"]),
        skipVerify: Boolean(args["skip-verify"]),
        log,
      });
      return { exit: 0 };
    }
    return { exit: 2 };
  },
};
