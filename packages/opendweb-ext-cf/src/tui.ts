// cf setup 交互式引导编排（2026-08-30 Owner 需求：setup 子命令提供交互
// 引导；第二轮决策：不自写交互终端，改用 @clack/prompts——见 prompts.ts
// 头注）。流程：token -> hostname（库 validate 即时重问）-> mode -> 计划
// 预览（note）-> apply/dry-run/abort 选择 -> 复用 runSetup 执行（log 行 +
// verify spinner）-> 结果指引。
// 契约：动态值经 sanitizeUI 堵 UI 注入；失败 rethrow 交宿主
// dispatchPluginCommand 归一化到 stderr 的 error[plugin/cf]；用户主动中止
// （InteractiveAbort：Ctrl+C/ESC/输入流关闭）是正常退出（exit 0）。
// forceDryRun：--dry-run 不可被确认覆盖——跳过 token 收集（占位 token）、
// 确认退化为二元 go/no-go，与非交互 --dry-run 的零副作用语义一致。
import path from "node:path";

import { runSetup, planExposure, type ExposureMode, type ExposurePlan } from "./wizard.js";
import { buildIngress, decodeTunnelToken, lookupZoneName, extractTunnelToken, tokenSummary, type FetchLike } from "./cf-api.js";
import { createPrompts, sanitizeUI, InteractiveAbort, type ClackApi } from "./prompts.js";

/** spinner 形状（@clack spinner 的结构化子集；闭包赋值需要命名类型） */
interface SpinnerLike {
  start(message?: string): void;
  stop(message?: string): void;
  message(text: string): void;
}

/** 1 -> first, 2 -> second, 3+ -> Nth（zone 深度提示用） */
function ordinal(n: number): string {
  return n === 1 ? "first" : n === 2 ? "second" : n === 3 ? "third" : `${n}th`;
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
  runSetupImpl?: typeof runSetup;
  /** 测试注入 fake；缺省动态 import 真库 */
  clack?: ClackApi;
}

/**
 * 交互式 setup 引导。
 * @returns 成功/中止返回退出码
 * @throws 任一执行步失败——由 dispatchPluginCommand 输出标准错误
 */
export async function runInteractiveSetup(opts: RunInteractiveOptions): Promise<{ exit: number }> {
  const {
    cwd,
    tokenEnvName = "TUNNEL_TOKEN",
    suggestedHostname,
    suggestedMode = "dual",
    suggestedAction = "apply",
    forceDryRun = false,
    configPath = null,
    skipVerify = false,
    env = process.env,
    fetchImpl,
    writeFile,
    exists,
    runSetupImpl = runSetup,
    clack = (await import("@clack/prompts")) as unknown as ClackApi,
  } = opts;
  const ui = createPrompts(clack);
  // spinner 状态经 holder 对象持有：TS 对「回调内赋值的 let」会做错误的
  // null 窄化（同步路径上视其为 null），对象属性读写则始终用声明类型
  const spinState: { spin: SpinnerLike | null; started: boolean } = { spin: null, started: false };
  try {
    ui.intro("cf setup - interactive wizard");

    // 0) 教程 note（2026-08-30 用户实测反馈：CF 网页向导的「服务」表单 URL
    // 必填（placeholder localhost:8080），不教正确值用户会被卡住）：服务指
    // cloudflared 把流量转发到哪——gateway 端口 8787；网页里这条路由之后
    // 会被本工具经 API 推送的最终配置覆盖，所以填对只是省事、不填也行
    if (!forceDryRun) {
      ui.note(
        [
          "how to get a tunnel token (Cloudflare Zero Trust):",
          "  1. Zero Trust -> Networks -> Tunnels -> Create a tunnel (connector)",
          "  2. name it anything (e.g. opendweb)",
          "  3. the wizard offers a public-hostname / service route:",
          "     - you may skip that step, or",
          "     - if the service URL form is required, enter HTTP + localhost:8787",
          "       (the opendweb gateway port; any route you create here is later",
          "       rewritten by this tool via the Cloudflare API)",
          "  4. finish and copy the token shown with the connector install command",
          "",
          "also create a management API token (needed to push routing via API;",
          "the connector token above cannot call the API):",
          "  dash.cloudflare.com -> My Profile -> API Tokens -> Create Token -> Custom:",
          "  Account / Cloudflare Tunnel / Edit  +  Zone / DNS / Edit (your zone)",
        ].join("\n"),
        "token tutorial",
      );
    }

    // 1) token：dry-run 不需要（与非交互 --dry-run 的占位语义一致）。
    // 粘贴宽容度（2026-08-31 Owner 三轮定案：单口直贴，不选通道）：多行块
    // 在单行 password 框里碎裂成逐行提交——validate 充当累积器，闭包 buffer
    // 聚合整块（含空行/前后文字），命中 token 形态即过；全程遮蔽。命中后
    // 显示头尾摘要并由用户确认，不确认则整段重输
    const collectToken = async (message: string): Promise<string> => {
      for (;;) {
        let buffer = "";
        await ui.password({
          message,
          validate: (v) => {
            buffer += (v ?? "") + "\n";
            if (extractTunnelToken(buffer) !== null) return undefined;
            if (buffer.trim() === "") return "paste the token (the eyJ... string) or the whole install command";
            return "no token in the input yet - keep pasting (multi-line text is collected as one block)";
          },
        });
        const extracted = extractTunnelToken(buffer) ?? buffer.trim();
        ui.log.message(`token: ${tokenSummary(extracted)}`);
        const confirmed = await ui.confirm({ message: "use this token?" });
        if (confirmed) return extracted;
        ui.log.message("re-enter the token");
      }
    };

    let token = forceDryRun ? "dry-run-token" : env[tokenEnvName];
    let apiToken: string | undefined;
    if (!forceDryRun) {
      if (token) {
        const choice = await ui.select({
          message: `tunnel token (detected ${tokenEnvName} in the environment)`,
          options: [
            { value: "env" as const, label: `use ${tokenEnvName} from the environment`, hint: "recommended" },
            { value: "paste" as const, label: "paste a different token", hint: "input hidden" },
          ],
        });
        if (choice === "paste") {
          token = await collectToken("tunnel token (Zero Trust -> Networks -> Tunnels: your tunnel -> copy token)");
        }
      } else {
        token = await collectToken(
          `tunnel token (${tokenEnvName} not set; Zero Trust -> Networks -> Tunnels: create or open a tunnel/connector, then copy its token)`,
        );
      }
      if (!token) throw new Error(`no tunnel token provided (set ${tokenEnvName} or paste one when asked)`);

      // 1b) 管理 API token：connector token 无 REST 权限（PUT configurations
      // 实测 401）——apply 必须有独立 API Token；dry-run 不需要
      const envApiToken = env.CF_API_TOKEN;
      if (envApiToken && envApiToken.trim() !== "") {
        apiToken = envApiToken.trim();
        ui.log.message(`api token: ${tokenSummary(apiToken)} (CF_API_TOKEN)`);
      } else {
        apiToken = (await ui.password({
          message: "management API token (CF_API_TOKEN; create at My Profile -> API Tokens - Tunnel Edit + DNS Edit)",
          validate: (v) => {
            const t = (v ?? "").trim();
            if (t.length < 40 || !/^[A-Za-z0-9_.-]+$/.test(t)) {
              return "paste the API token (the string shown once at creation: >=40 chars, no spaces)";
            }
            return undefined;
          },
        })).trim();
        ui.log.message(`api token: ${tokenSummary(apiToken)}`);
      }
    }

    // 2) hostname：库 validate 即时重问（planExposure 的 DNS 形态校验即权威）。
    // @clack 语义：空提交且设有 defaultValue 时 validate 收到 undefined（库在
    // validate 通过后才回退到 defaultValue）——undefined 必须放行
    const hostname = await ui.text({
      message: "gateway hostname (e.g. dweb.example.com)",
      ...(suggestedHostname !== undefined ? { placeholder: suggestedHostname, defaultValue: suggestedHostname } : {}),
      validate: (v) => {
        if (v === undefined || v === "") {
          return suggestedHostname !== undefined ? undefined : "a hostname is required";
        }
        try {
          planExposure({ hostname: v });
          return undefined;
        } catch (e) {
          return (e as Error).message;
        }
      },
    });

    // 3) mode：按 zone 证书覆盖给建议。CF 免费 Universal SSL 只覆盖 zone 根
    // 与一级子域（*.zone）：dual 的 relay.<gateway> 相对 zone 深两级的场景
    // （如 gateway=a.b.example.com、zone=example.com）不在免费证书内，选 dual
    // 会让 relay 端 HTTPS 握手失败——此时建议 single（或 ACM/Total TLS）。
    // zone 查询失败（TUNNEL_TOKEN 内嵌 token 通常无 Zone:Read，实测必现）时
    // 按段数启发式：>=3 段的 gateway 其 relay 多半是二级子域——宁可误荐
    // single（永远可用）也不能继续无差别推荐 dual（2026-08-31 用户实测）。
    let modeHints: { dual: string; single: string; dualRecommended: boolean } | null = null;
    if (!forceDryRun && fetchImpl !== undefined && token !== undefined) {
      try {
        const creds = decodeTunnelToken(token);
        const spin = ui.spinner();
        spinState.spin = spin;
        spin.start("checking zone certificate coverage");
        const zone = await lookupZoneName({
          fetchImpl,
          accountTag: creds.accountTag,
          apiToken: creds.apiToken,
          host: hostname,
        });
        spin.stop("zone check done");
        spinState.spin = null;
        if (zone) {
          const depth = hostname.split(".").length - zone.zoneName.split(".").length;
          modeHints =
            depth === 0
              ? {
                  dual: "recommended - relay.<gateway> is a first-level subdomain, covered by the free Universal SSL cert",
                  single: "one hostname, /relay and /ping path routing",
                  dualRecommended: true,
                }
              : {
                  dual: `needs a paid edge certificate: relay.${hostname} would be a ${ordinal(depth + 1)}-level subdomain of ${zone.zoneName}, beyond the free Universal SSL cert (ACM / Total TLS required)`,
                  single: `recommended for ${zone.zoneName} - stays on ${hostname}, covered by the free Universal SSL cert`,
                  dualRecommended: false,
                };
        }
      } catch {
        // 查询异常（网络/解码）：落入下方段数启发式
      }
    }
    if (modeHints === null && !forceDryRun) {
      const labels = hostname.split(".").filter(Boolean).length;
      if (labels >= 3) {
        modeHints = {
          dual: `caution: relay.${hostname} is likely a 2nd-level subdomain (beyond the free Universal SSL cert; needs ACM/Total TLS unless your zone is itself multi-label)`,
          single: `recommended for ${hostname} - stays on one hostname covered by the free Universal SSL cert (zone depth could not be confirmed)`,
          dualRecommended: false,
        };
      } else {
        modeHints = {
          dual: "recommended - relay.<gateway> is a first-level subdomain of your zone, covered by the free Universal SSL cert",
          single: "one hostname, /relay and /ping path routing",
          dualRecommended: true,
        };
      }
    }
    const dualHint = modeHints === null ? "recommended" : modeHints.dual;
    const singleHint = modeHints !== null && !modeHints.dualRecommended ? modeHints.single : undefined;
    const mode = await ui.select<ExposureMode>({
      message: "routing mode",
      options: [
        {
          value: "dual",
          label: "dual - separate hostnames (gateway + relay.<gateway>)",
          ...(dualHint !== undefined ? { hint: dualHint } : {}),
        },
        {
          value: "single",
          label: "single - one hostname, /relay and /ping path routing",
          ...(singleHint !== undefined ? { hint: singleHint } : {}),
        },
      ],
      initialValue: modeHints !== null && !modeHints.dualRecommended ? "single" : suggestedMode,
    });

    // 4) 计划预览（note 的 body 是结构性多行文本：动态值逐项 sanitize，
    // 换行保留给 @clack 排版）
    const plan: ExposurePlan = planExposure({ hostname, mode });
    const ingress = buildIngress({ mode: plan.mode, gatewayHost: plan.gatewayHost, relayHost: plan.relayHost });
    const targetConfig = configPath ?? path.join(cwd, "opendweb.config.toml");
    const esc = sanitizeUI;
    ui.note(
      [
        `mode          ${plan.mode === "single" ? "single-domain path routing" : "dual hostname"}`,
        `gateway       ${esc(plan.gatewayHost)} (${esc(plan.publicGatewayUrl)})`,
        `relay         ${esc(plan.relayHost)} (${esc(plan.publicRelayUrl)})`,
        `config file   ${esc(targetConfig)}`,
        "",
        "ingress rules:",
        ...ingress.ingress.map((rule) => `  ${esc(JSON.stringify(rule))}`),
        "",
        "steps:",
        "  1. push ingress rules to Cloudflare (tunnel configurations API)",
        "  2. route DNS CNAMEs to the tunnel (best-effort)",
        `  3. write ${esc(targetConfig)}`,
        "  4. verify end-to-end via the public URL (services.json)",
      ].join("\n"),
      "plan",
    );

    // 5) 确认：forceDryRun 下没有 apply 选项（--dry-run 语义不可覆盖）
    let action: "apply" | "dry" | "no";
    if (forceDryRun) {
      action = (await ui.confirm({ message: "run this plan as a dry-run? (nothing will be pushed)" })) ? "dry" : "no";
    } else {
      action = await ui.select({
        message: "apply this plan?",
        options: [
          { value: "apply" as const, label: "apply - push ingress, route DNS, write config, verify" },
          { value: "dry" as const, label: "dry-run - rehearse with zero side effects" },
          { value: "no" as const, label: "abort - change nothing" },
        ],
        initialValue: suggestedAction === "dry" ? "dry" : "apply",
      });
    }
    if (action === "no") {
      ui.outro("aborted; nothing was changed");
      return { exit: 0 };
    }

    // 6) 执行：复用非交互的 runSetup 编排；log 行直出，verify 用 spinner
    //（token 的防御性复检同时完成 string 窄化：forceDryRun 占位或已过 throw）
    if (!token) throw new Error(`no tunnel token provided (set ${tokenEnvName} or paste one when asked)`);
    const result = await runSetupImpl({
      token,
      ...(apiToken !== undefined ? { apiToken } : {}),
      hostname,
      mode,
      cwd,
      configPath,
      tokenEnvName,
      dryRun: action === "dry",
      skipVerify: skipVerify || action === "dry",
      ...(fetchImpl ? { fetchImpl } : {}),
      ...(writeFile ? { writeFile } : {}),
      ...(exists ? { exists } : {}),
      log: (line) => {
        if (spinState.spin !== null && spinState.started) {
          spinState.spin.stop();
          spinState.started = false;
        }
        ui.log.message(sanitizeUI(`  ${line}`));
      },
      verifyProgress: ({ elapsedMs, lastError }) => {
        // 公网生效有延迟是常态：spinner 常驻并随轮询更新文案
        if (spinState.spin === null) spinState.spin = ui.spinner();
        const text = sanitizeUI(`verifying via the public gateway... ${Math.round(elapsedMs / 1000)}s (${lastError})`);
        if (!spinState.started) {
          spinState.spin.start(text);
          spinState.started = true;
        } else {
          spinState.spin.message(text);
        }
      },
    });
    if (spinState.spin !== null && spinState.started) {
      spinState.spin.stop();
      spinState.started = false;
    }

    // 7) 结果与下一步指引
    if (action === "dry") {
      ui.outro("dry-run ok - nothing was pushed; re-run and choose apply to execute");
    } else {
      ui.log.message("next steps:");
      ui.log.message("  1. start the server:              opendweb server");
      ui.log.message(`  2. point clients at the gateway:   config set relay ${result.plan.publicGatewayUrl}`);
      ui.log.message("  3. co-spawn cloudflared with the server: [plugins.options] tunnel = true");
      ui.outro("setup ok (applied)");
    }
    return { exit: 0 };
  } catch (e) {
    if (e instanceof InteractiveAbort) {
      ui.outro("aborted; nothing was changed");
      return { exit: 0 };
    }
    throw e;
  } finally {
    spinState.spin?.stop();
  }
}
