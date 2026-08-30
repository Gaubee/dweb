// cf setup 交互式引导编排（2026-08-30 Owner 需求：setup 子命令提供交互
// 引导；第二轮决策：不自写交互终端，改用 @clack/prompts——见 prompts.mjs
// 头注）。流程：token -> hostname（库 validate 即时重问）-> mode -> 计划
// 预览（note）-> apply/dry-run/abort 选择 -> 复用 runSetup 执行（log 行 +
// verify spinner）-> 结果指引。
// 契约：动态值经 sanitizeUI 堵 UI 注入；失败 rethrow 交宿主
// dispatchPluginCommand 归一化到 stderr 的 error[plugin/cf]；用户主动中止
// （InteractiveAbort：Ctrl+C/ESC/输入流关闭）是正常退出（exit 0）。
// forceDryRun：--dry-run 不可被确认覆盖——跳过 token 收集（占位 token）、
// 确认退化为二元 go/no-go，与非交互 --dry-run 的零副作用语义一致。
import path from "node:path";

import { runSetup, planExposure } from "./wizard.js";
import { buildIngress } from "./cf-api.js";
import { createPrompts, sanitizeUI, InteractiveAbort } from "./prompts.mjs";

/**
 * 交互式 setup 引导。
 * @param {{ cwd: string, tokenEnvName?: string, suggestedHostname?: string, suggestedMode?: "dual" | "single",
 *           suggestedAction?: "apply" | "dry", forceDryRun?: boolean, configPath?: string | null, skipVerify?: boolean,
 *           env?: Record<string, string | undefined>,
 *           fetchImpl?: typeof fetch, writeFile?: (p: string, c: string) => Promise<void>,
 *           exists?: (p: string) => boolean, runSetupImpl?: typeof runSetup,
 *           clack?: Awaited<typeof import("@clack/prompts")> }} opts
 * @returns {Promise<{ exit: number }>} 成功/中止返回退出码
 * @throws {Error} 任一执行步失败——由 dispatchPluginCommand 输出标准错误
 */
export async function runInteractiveSetup(opts) {
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
    clack = await import("@clack/prompts"),
  } = opts;
  const ui = createPrompts(clack);
  let spin = null;
  try {
    ui.intro("cf setup - interactive wizard");

    // 1) token：dry-run 不需要（与非交互 --dry-run 的占位语义一致）
    let token = forceDryRun ? "dry-run-token" : env[tokenEnvName];
    if (!forceDryRun) {
      if (token) {
        const choice = await ui.select({
          message: `tunnel token (detected ${tokenEnvName} in the environment)`,
          options: [
            { value: "env", label: `use ${tokenEnvName} from the environment`, hint: "recommended" },
            { value: "paste", label: "paste a different token", hint: "input hidden" },
          ],
        });
        if (choice === "paste") token = await ui.password({ message: "tunnel token (copy from Zero Trust -> Networks -> Tunnels)" });
      } else {
        token = await ui.password({ message: `tunnel token (${tokenEnvName} not set; copy from Zero Trust -> Networks -> Tunnels)` });
      }
      if (!token) throw new Error(`no tunnel token provided (set ${tokenEnvName} or paste one when asked)`);
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
          return e.message;
        }
      },
    });

    // 3) mode
    const mode = await ui.select({
      message: "routing mode",
      options: [
        { value: "dual", label: "dual - separate hostnames (gateway + relay.<gateway>)", hint: "recommended" },
        { value: "single", label: "single - one hostname, /relay and /ping path routing" },
      ],
      initialValue: suggestedMode,
    });

    // 4) 计划预览
    const plan = planExposure({ hostname, mode });
    const ingress = buildIngress({ mode: plan.mode, gatewayHost: plan.gatewayHost, relayHost: plan.relayHost });
    const targetConfig = configPath ?? path.join(cwd, "opendweb.config.toml");
    ui.note(
      [
        `mode          ${plan.mode === "single" ? "single-domain path routing" : "dual hostname"}`,
        `gateway       ${plan.gatewayHost} (${plan.publicGatewayUrl})`,
        `relay         ${plan.relayHost} (${plan.publicRelayUrl})`,
        `config file   ${targetConfig}`,
        "",
        "ingress rules:",
        ...ingress.ingress.map((rule) => `  ${JSON.stringify(rule)}`),
        "",
        "steps:",
        "  1. push ingress rules to Cloudflare (tunnel configurations API)",
        "  2. route DNS CNAMEs to the tunnel (best-effort)",
        `  3. write ${targetConfig}`,
        "  4. verify end-to-end via the public URL (services.json)",
      ].join("\n"),
      "plan",
    );

    // 5) 确认：forceDryRun 下没有 apply 选项（--dry-run 语义不可覆盖）
    let action;
    if (forceDryRun) {
      action = (await ui.confirm({ message: "run this plan as a dry-run? (nothing will be pushed)" })) ? "dry" : "no";
    } else {
      action = await ui.select({
        message: "apply this plan?",
        options: [
          { value: "apply", label: "apply - push ingress, route DNS, write config, verify" },
          { value: "dry", label: "dry-run - rehearse with zero side effects" },
          { value: "no", label: "abort - change nothing" },
        ],
        initialValue: suggestedAction === "dry" ? "dry" : "apply",
      });
    }
    if (action === "no") {
      ui.outro("aborted; nothing was changed");
      return { exit: 0 };
    }

    // 6) 执行：复用非交互的 runSetup 编排；log 行直出，verify 用 spinner
    let spinStarted = false;
    const result = await runSetupImpl({
      token,
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
        if (spin !== null && spinStarted) {
          spin.stop();
          spinStarted = false;
        }
        ui.log.message(sanitizeUI(`  ${line}`));
      },
      verifyProgress: ({ elapsedMs, lastError }) => {
        // 公网生效有延迟是常态：spinner 常驻并随轮询更新文案
        if (spin === null) spin = ui.spinner();
        if (!spinStarted) {
          spin.start(sanitizeUI(`verifying via the public gateway... ${Math.round(elapsedMs / 1000)}s (${lastError})`));
          spinStarted = true;
        } else {
          spin.message(sanitizeUI(`verifying via the public gateway... ${Math.round(elapsedMs / 1000)}s (${lastError})`));
        }
      },
    });
    if (spin !== null && spinStarted) {
      spin.stop();
      spinStarted = false;
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
    spin?.stop?.();
  }
}
