// cf setup 交互式引导（1.0.0 发现式重写）：认证（浏览器登录 / API token 粘贴）
// → zone 选择 → hostname（对所选 zone 精确算证书深度建议）→ tunnel 选择
// （新建或复用，命名 ownership）→ mode → 计划预览 → apply/dry/abort →
// 幂等 provision（DNS 冲突交互确认）→ 结果（新建 tunnel 时一次性展示
// connector token 与 export 引导）。
// 契约：动态值经 sanitizeUI 堵 UI 注入；失败 rethrow 交宿主归一化；
// InteractiveAbort 是正常退出（exit 0）。
import path from "node:path";
import os from "node:os";
import { exec } from "node:child_process";
import { planExposure, buildIngress, type ExposureMode, type ExposurePlan } from "./route-model.js";
import { provision, tunnelNameFor, type ProvisionResult, type TunnelChoice } from "./provision.js";
import {
  createGateway as defaultGateway,
  type CfGateway,
  type ZoneSummary,
  type TunnelSummary,
  type DnsRecordSummary,
} from "./cf-client.js";
import {
  CF_OAUTH,
  resolveClientId,
  loadStoredAuth,
  saveStoredAuth,
  clearStoredAuth,
  loginFlow,
  getApiToken,
  type StoredAuth,
} from "./auth.js";
import { createPrompts, sanitizeUI, InteractiveAbort, type ClackApi } from "./prompts.js";
import { tokenSummary, type FetchLike } from "./cf-api.js";

/** spinner 形状（@clack spinner 的结构化子集；闭包赋值需要命名类型） */
interface SpinnerLike {
  start(message?: string): void;
  stop(message?: string): void;
  message(text: string): void;
}

export interface RunInteractiveOptions {
  cwd: string;
  tokenEnvName?: string;
  suggestedHostname?: string | undefined;
  suggestedMode?: ExposureMode;
  suggestedAction?: "apply" | "dry";
  forceDryRun?: boolean;
  configPath?: string | null;
  skipVerify?: boolean;
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  writeFile?: (p: string, c: string) => Promise<void>;
  exists?: (p: string) => boolean;
  /** 依赖注入面（测试） */
  clack?: ClackApi;
  createGateway?: (apiToken: string) => Promise<CfGateway>;
  login?: (clientId: string) => Promise<{ accessToken: string; refreshToken?: string }>;
  loadAuth?: () => Promise<StoredAuth | null>;
  persistAuth?: (auth: StoredAuth) => Promise<void>;
  dropAuth?: () => Promise<void>;
  runProvision?: typeof provision;
}

/** 粘贴块中第一个符合 token 形态（>=40 个 [A-Za-z0-9_.-]）的行；无则 null */
function firstTokenLine(buffer: string): string | null {
  for (const line of buffer.split("\n")) {
    const t = line.trim();
    if (t.length >= 40 && /^[A-Za-z0-9_.\-]+$/.test(t)) return t;
  }
  return null;
}

/** 1 -> first, 2 -> second, 3+ -> Nth（zone 深度提示用） */
function ordinal(n: number): string {
  return n === 1 ? "first" : n === 2 ? "second" : n === 3 ? "third" : `${n}th`;
}

function defaultOpenBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${cmd} ${JSON.stringify(url)}`);
}

function dwebHome(env?: Record<string, string | undefined>): string {
  return env?.DWEB_HOME ?? process.env.DWEB_HOME ?? path.join(os.homedir(), ".opendweb");
}

export async function runInteractiveSetup(opts: RunInteractiveOptions): Promise<{ exit: number }> {
  const {
    cwd,
    tokenEnvName = "TUNNEL_TOKEN",
    suggestedHostname,
    suggestedMode = "dual",
    forceDryRun = false,
    configPath = null,
    skipVerify = false,
    env = process.env,
    fetchImpl,
    clack = (await import("@clack/prompts")) as unknown as ClackApi,
    createGateway = (t: string) => defaultGateway(t),
    login = async (clientId: string) => {
      const r = await loginFlow({
        clientId,
        openBrowser: defaultOpenBrowser,
        ...(fetchImpl !== undefined ? { fetchImpl } : {}),
      });
      return { accessToken: r.accessToken, ...(r.refreshToken !== undefined ? { refreshToken: r.refreshToken } : {}) };
    },
    loadAuth = () => loadStoredAuth(dwebHome(env)),
    persistAuth = (a) => saveStoredAuth(dwebHome(env), a),
    runProvision = provision,
    writeFile = async () => {},
    exists = () => false,
  } = opts;
  const ui = createPrompts(clack);
  const spinState: { spin: SpinnerLike | null } = { spin: null };
  try {
    ui.intro("cf setup - interactive wizard");

    // 0) 教程 note：认证路径与最小权限
    ui.note(
      [
        "how this works:",
        "  1. authenticate: log in with your Cloudflare account (browser), or",
        "     paste an API token created at dash.cloudflare.com -> My Profile ->",
        "     API Tokens -> Create Token (Custom):",
        "       Account / Cloudflare Tunnel / Edit",
        "       Zone / DNS / Edit  +  Zone / Zone / Read  (your zone)",
        "  2. pick a zone + hostname, create or reuse a tunnel",
        "  3. ingress rules, DNS routing and the local config are applied for you",
        "     (re-running is safe: existing resources are reused, nothing is",
        "     silently overwritten)",
      ].join("\n"),
      "overview",
    );

    // 1) 认证：env token / 已存登录态 / 浏览器登录 / 粘贴 API token
    let apiToken: string | null = null;
    let stored = await loadAuth();
    if (!forceDryRun) {
      const envToken = env.CLOUDFLARE_API_TOKEN?.trim() ?? "";
      const options: Array<{ value: string; label: string; hint?: string }> = [];
      if (envToken !== "") {
        options.push({ value: "env", label: "use CLOUDFLARE_API_TOKEN from the environment", hint: tokenSummary(envToken) });
      }
      if (stored !== null) {
        options.push({ value: "stored", label: "use the logged-in Cloudflare session", hint: "browser login saved earlier" });
      }
      const clientId = resolveClientId(undefined, env);
      options.push({
        value: "login",
        label: "log in with Cloudflare (opens the browser)",
        ...(clientId === null
          ? { hint: "needs CF_OAUTH_CLIENT_ID until the bundled public client ships" }
          : {}),
      });
      options.push({ value: "paste", label: "paste an API token", hint: "input hidden" });
      const choice = await ui.select<string>({ message: "cloudflare authentication", options });
      if (choice === "env") {
        apiToken = envToken;
      } else if (choice === "stored") {
        apiToken = await getApiToken(dwebHome(env), {
          env,
          stored,
          persist: persistAuth,
          ...(fetchImpl !== undefined ? { fetchImpl } : {}),
        });
        if (apiToken === null) {
          ui.log.message("the saved session is no longer valid - logging in again");
          stored = null;
        }
      }
      if (apiToken === null && (choice === "login" || (choice === "stored" && stored === null))) {
        if (clientId === null) {
          throw new Error(
            "browser login is not configured: create an OAuth client (Manage Account -> OAuth clients) and export CF_OAUTH_CLIENT_ID, or use an API token",
          );
        }
        const spin = ui.spinner();
        spinState.spin = spin;
        spin.start("waiting for the browser login to complete");
        try {
          const tokens = await login(clientId);
          if (tokens.refreshToken === undefined || tokens.refreshToken === "") {
            throw new Error("no refresh token returned (offline_access scope missing?)");
          }
          stored = { refreshToken: tokens.refreshToken, clientId, accessToken: tokens.accessToken };
          await persistAuth(stored);
          apiToken = tokens.accessToken;
          spin.stop("logged in");
        } finally {
          spinState.spin = null;
        }
      }
      if (apiToken === null && choice === "paste") {
        // 单口累积捕获（0.2.x 交互保留）：多行粘贴碎裂成逐行提交，validate 聚合
        for (;;) {
          let buffer = "";
          await ui.password({
            message: "cloudflare API token (paste the token created at My Profile -> API Tokens)",
            validate: (v) => {
              buffer += (v ?? "") + "\n";
              // 累积器对整块做形态扫描（多行粘贴碎裂重组，0.2.x 交互保留）：
              // 任一行出现 >=40 的 token 形态串即通过
              if (firstTokenLine(buffer) === null) {
                return "no token yet - keep pasting (the token is the >=40-char string shown once at creation)";
              }
              return undefined;
            },
          });
          const candidate = firstTokenLine(buffer) ?? buffer.trim();
          ui.log.message(`api token: ${tokenSummary(candidate)}`);
          const confirmed = await ui.confirm({ message: "use this token?" });
          if (confirmed) {
            apiToken = candidate;
            break;
          }
          ui.log.message("re-enter the token");
        }
      }
      if (apiToken === null) {
        throw new Error("no cloudflare credential available (login, CLOUDFLARE_API_TOKEN, or paste a token)");
      }
    }

    // 2) zone + hostname
    let zone: ZoneSummary | null = null;
    let hostname: string | undefined = suggestedHostname;
    if (apiToken !== null) {
      const spin = ui.spinner();
      spinState.spin = spin;
      spin.start("listing zones");
      const gateway = await createGateway(apiToken);
      const zones = await gateway.listZones().catch((e: Error) => {
        throw new Error(`${e.message} (check the token permissions: Zone / Zone / Read)`);
      });
      spin.stop(`${zones.length} zone(s) available`);
      spinState.spin = null;
      if (zones.length === 0) {
        throw new Error("no zones visible to this credential (need Zone / Zone / Read)");
      }
      zone = await ui.select<ZoneSummary>({
        message: "zone (domain)",
        options: zones.map((z) => ({ value: z, label: z.name, hint: z.accountName !== "" ? z.accountName : z.status })),
      });

      // hostname：必须落在所选 zone 下（DNS 记录创建的前提）
      hostname = await ui.text({
        message: `gateway hostname (e.g. ${suggestedHostname ?? `app.${zone.name}`})`,
        ...(suggestedHostname !== undefined
          ? { placeholder: suggestedHostname, defaultValue: suggestedHostname }
          : {}),
        validate: (v) => {
          if (v === undefined || v === "") {
            return suggestedHostname !== undefined ? undefined : "a hostname is required";
          }
          try {
            const plan = planExposure({ hostname: v });
            // dry-run（无凭据）时 zone 未选，仅做 DNS 形态校验
            if (zone !== null && plan.gatewayHost !== zone.name && !plan.gatewayHost.endsWith(`.${zone.name}`)) {
              return `"${plan.gatewayHost}" is not inside the selected zone ${zone.name}`;
            }
            return undefined;
          } catch (e) {
            return (e as Error).message;
          }
        },
      });
    }

    // 3) mode：对所选 zone 精确算深度（免费 Universal SSL 只覆盖 zone 根 + 一级）
    const plan0: ExposurePlan = planExposure({ hostname: hostname ?? "app.example.com", mode: suggestedMode });
    const depth = zone !== null ? plan0.gatewayHost.split(".").length - zone.name.split(".").length : 1;
    const dualRecommended = depth === 0;
    const mode = await ui.select<ExposureMode>({
      message: "routing mode",
      options: [
        {
          value: "dual",
          label: "dual - separate hostnames (gateway + relay.<gateway>)",
          hint: dualRecommended
            ? "recommended - relay.<gateway> is a first-level subdomain, covered by the free Universal SSL cert"
            : `needs a paid edge certificate: relay.${plan0.gatewayHost} would be a ${ordinal(depth + 1)}-level subdomain of ${zone?.name ?? "your zone"}, beyond the free Universal SSL cert (ACM / Total TLS required)`,
        },
        {
          value: "single",
          label: "single - one hostname, /relay and /ping path routing",
          ...(dualRecommended
            ? {}
            : {
                hint: `recommended for ${zone?.name ?? "this zone"} - stays on ${plan0.gatewayHost}, covered by the free Universal SSL cert`,
              }),
        },
      ],
      initialValue: dualRecommended ? suggestedMode : "single",
    });

    // 4) tunnel：按命名 ownership 查找 → 复用或新建（列出现有供选择）
    let tunnelChoice: TunnelChoice = { kind: "auto" };
    if (apiToken !== null && zone !== null) {
      const spin = ui.spinner();
      spinState.spin = spin;
      spin.start("listing tunnels");
      const gateway = await createGateway(apiToken);
      let tunnels: TunnelSummary[] = [];
      try {
        tunnels = await gateway.listTunnels(zone.accountId);
      } catch {
        ui.log.message("tunnel listing unavailable (token may lack Tunnel permissions) - will create a new one");
      }
      spin.stop(`${tunnels.length} tunnel(s)`);
      spinState.spin = null;
      const wantedName = tunnelNameFor(plan0.gatewayHost);
      const existingWanted = tunnels.find((t) => t.name === wantedName);
      const options: Array<{ value: TunnelChoice; label: string; hint?: string }> = [
        {
          value:
            existingWanted !== undefined
              ? { kind: "existing", id: existingWanted.id }
              : { kind: "new", name: wantedName },
          label:
            existingWanted !== undefined
              ? `use existing "${wantedName}"`
              : `create tunnel "${wantedName}"`,
          hint: "recommended",
        },
        ...tunnels
          .filter((t) => t.name !== wantedName)
          .map((t) => ({
            value: { kind: "existing", id: t.id } as TunnelChoice,
            label: `use existing "${t.name}"`,
            hint: `${t.status}${t.connections > 0 ? `, ${t.connections} connector(s) online` : ""}`,
          })),
      ];
      tunnelChoice = await ui.select<TunnelChoice>({ message: "tunnel", options });
    }

    // 5) 计划预览
    const plan: ExposurePlan = planExposure({ hostname: hostname ?? "app.example.com", mode });
    const ingress = buildIngress({ mode: plan.mode, gatewayHost: plan.gatewayHost, relayHost: plan.relayHost });
    const targetConfig = configPath ?? path.join(cwd, "opendweb.config.toml");
    const esc = sanitizeUI;
    ui.note(
      [
        `mode          ${plan.mode === "single" ? "single-domain path routing" : "dual hostname"}`,
        `gateway       ${esc(plan.gatewayHost)} (${esc(plan.publicGatewayUrl)})`,
        `relay         ${esc(plan.relayHost)} (${esc(plan.publicRelayUrl)})`,
        `zone          ${zone !== null ? `${esc(zone.name)} (${esc(zone.accountId)})` : "n/a"}`,
        `tunnel        ${
          tunnelChoice.kind === "existing"
            ? `reuse ${tunnelChoice.id}`
            : tunnelChoice.kind === "new"
              ? `create "${esc(tunnelChoice.name)}"`
              : `find-or-create "${esc(tunnelNameFor(plan.gatewayHost))}"`
        }`,
        `config file   ${esc(targetConfig)}`,
        "",
        "ingress rules:",
        ...ingress.ingress.map((r) => `  ${esc(JSON.stringify(r))}`),
        "",
        "steps:",
        "  1. ensure the tunnel (reuse or create; nothing is deleted)",
        "  2. push ingress rules (full replacement of this tunnel's config)",
        "  3. route DNS CNAMEs to the tunnel (conflicts always ask)",
        `  4. write ${esc(path.basename(targetConfig))}`,
        "  5. verify end-to-end via the public URL (services.json)",
      ].join("\n"),
      "plan",
    );

    // 6) 执行确认
    let action: "apply" | "dry" | "abort";
    if (forceDryRun) {
      action = (await ui.confirm({ message: "dry-run? (nothing will be pushed)" })) ? "dry" : "abort";
    } else {
      action = await ui.select<"apply" | "dry" | "abort">({
        message: "apply this plan?",
        options: [
          { value: "apply", label: "apply - provision tunnel, ingress, DNS, config, verify" },
          { value: "dry", label: "dry-run - print what would happen, change nothing" },
          { value: "abort", label: "abort - exit without changes" },
        ],
        initialValue: opts.suggestedAction ?? "apply",
      });
    }
    if (action === "abort") {
      ui.outro("aborted; nothing was changed");
      return { exit: 0 };
    }

    // 7) 执行（DNS 冲突 → 交互确认；非交互 provision 默认 abort）
    if (apiToken === null || zone === null) {
      ui.outro("dry-run complete (no credential collected - nothing was pushed)");
      return { exit: 0 };
    }
    const gateway = await createGateway(apiToken);
    const spin = ui.spinner();
    spinState.spin = spin;
    let result: ProvisionResult;
    try {
      result = await runProvision({
        client: gateway,
        hostname: plan.gatewayHost,
        mode: plan.mode,
        zone,
        tunnel: tunnelChoice,
        cwd,
        ...(configPath !== null ? { configPath } : {}),
        dryRun: action === "dry",
        skipVerify,
        ...(fetchImpl !== undefined ? { fetchImpl } : {}),
        writeFile,
        exists,
        log: (line) => {
          spinState.spin?.message(line);
        },
        onDnsConflict: async (record: DnsRecordSummary, host: string) => {
          spinState.spin?.stop();
          spinState.spin = null;
          const decision = await ui.select<"replace" | "abort">({
            message: `DNS conflict: ${host} has a ${record.type} record -> ${record.content}. replace it with this tunnel's CNAME?`,
            options: [
              { value: "replace", label: "replace the record (it will be pointed at this tunnel)" },
              { value: "abort", label: "abort - keep the existing record" },
            ],
          });
          spinState.spin = spin;
          spin.start("provisioning");
          return decision;
        },
      });
      spin.stop("provisioning complete");
      spinState.spin = null;
    } catch (e) {
      spinState.spin?.stop();
      spinState.spin = null;
      throw e;
    }

    // 8) 结果与 connector token 引导（一次性显示，不落盘）
    if (action === "dry") {
      ui.outro("dry-run ok - nothing was pushed; re-run and choose apply to execute");
      return { exit: 0 };
    }
    if (result.tunnelToken !== null) {
      ui.note(
        [
          "the connector token below runs cloudflared for this tunnel.",
          "it is shown once here (not stored) - copy it now if you want the",
          "server to co-spawn cloudflared:",
          "",
          `export TUNNEL_TOKEN=${result.tunnelToken}`,
          "",
          "(you can also fetch it again later from Zero Trust -> Networks -> Tunnels)",
        ].join("\n"),
        "connector token",
      );
    }
    ui.log.message("next steps:");
    ui.log.message("  1. start the server:              opendweb server");
    ui.log.message(`  2. point clients at the gateway:   config set relay ${plan.publicGatewayUrl}`);
    ui.log.message(`  3. co-spawn cloudflared with the server: [plugins.options] tunnel = true + ${tokenEnvName}`);
    ui.outro("setup ok (applied)");
    return { exit: 0 };
  } catch (e) {
    if (e instanceof InteractiveAbort) {
      ui.outro("aborted; nothing was changed");
      return { exit: 0 };
    }
    throw e;
  } finally {
    spinState.spin?.stop?.();
  }
}

export { CF_OAUTH };
