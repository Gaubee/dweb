// cf setup 交互式引导编排（2026-08-30 Owner 需求：setup 子命令提供 TUI
// 引导；线性流程 + 秘密 token 本地输入，故 TUI 而非 WebUI——判断依据见
// prompts.mjs 头注）。流程：token -> hostname（校验重问）-> mode -> 计划
// 预览 -> 确认 -> 复用 runSetup 执行 -> 结果指引。
// 契约（P1-2）：全部输出经 asciiEscape 的受控 writer（createWriter，见
// prompts.mjs）；失败 rethrow 交宿主 dispatchPluginCommand 归一化到
// stderr 的 error[plugin/cf] 通道；用户主动中止是正常退出（exit 0）。
// forceDryRun（P1-1）：--dry-run 不可被确认框覆盖——跳过 token 收集
// （占位 token）、确认退化为二元 go/no-go，保证零副作用语义与非交互
// --dry-run 一致。
import path from "node:path";

import { runSetup, planExposure } from "./wizard.js";
import { buildIngress } from "./cf-api.js";
import { createPrompts, createWriter } from "./prompts.mjs";

/**
 * 交互式 setup 引导。
 * @param {{ cwd: string, tokenEnvName?: string, suggestedHostname?: string, suggestedMode?: "dual" | "single",
 *           suggestedAction?: "apply" | "dry", forceDryRun?: boolean, configPath?: string | null, skipVerify?: boolean,
 *           stdin?: NodeJS.ReadStream, stdout?: NodeJS.WriteStream, env?: Record<string, string | undefined>,
 *           fetchImpl?: typeof fetch, writeFile?: (p: string, c: string) => Promise<void>,
 *           exists?: (p: string) => boolean, runSetupImpl?: typeof runSetup }} opts
 * @returns {Promise<{ exit: number } | undefined>} 成功/中止返回退出码
 * @throws {Error} 任一执行步失败（含输入关闭）——由 dispatchPluginCommand 输出标准错误
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
    stdin = process.stdin,
    stdout = process.stdout,
    env = process.env,
    fetchImpl,
    writeFile,
    exists,
    runSetupImpl = runSetup,
  } = opts;
  const ui = createPrompts({ input: stdin, output: stdout });
  const w = createWriter(stdout);
  try {
    w.line();
    w.line("cf setup - interactive wizard", w.paint.bold);
    w.line("wire a Cloudflare Tunnel to this opendweb server", w.paint.dim);
    w.line();

    // 1) token：dry-run 不需要（与非交互 --dry-run 的占位语义一致）
    let token = forceDryRun ? "dry-run-token" : env[tokenEnvName];
    if (!forceDryRun) {
      if (token) {
        w.line(`detected ${tokenEnvName} in the environment`, w.paint.dim);
        const choice = await ui.select("tunnel token", [
          { value: "env", label: `use ${tokenEnvName} from the environment`, default: true },
          { value: "paste", label: "paste a different token" },
        ]);
        if (choice === "paste") token = await ui.askSecret(`tunnel token (copy from Zero Trust -> Networks -> Tunnels)`);
      } else {
        w.line(`no ${tokenEnvName} in the environment; paste the tunnel token`, w.paint.dim);
        token = await ui.askSecret(`tunnel token (copy from Zero Trust -> Networks -> Tunnels)`);
      }
      if (!token) throw new Error(`no tunnel token provided (set ${tokenEnvName} or paste one when asked)`);
    }

    // 2) hostname：带校验重问（planExposure 的 DNS 形态校验即权威）
    let hostname;
    for (;;) {
      hostname = await ui.ask("gateway hostname (e.g. dweb.example.com)", {
        default: suggestedHostname,
        required: suggestedHostname === undefined,
      });
      try {
        planExposure({ hostname });
        break;
      } catch (e) {
        w.line(`  ${e.message}`, w.paint.dim);
      }
    }

    // 3) mode
    const mode = await ui.select("routing mode", [
      { value: "dual", label: "dual - separate hostnames (gateway + relay.<gateway>)", default: suggestedMode !== "single" },
      { value: "single", label: "single - one hostname, /relay and /ping path routing", default: suggestedMode === "single" },
    ]);

    // 4) 计划预览
    const plan = planExposure({ hostname, mode });
    const ingress = buildIngress({ mode: plan.mode, gatewayHost: plan.gatewayHost, relayHost: plan.relayHost });
    const targetConfig = configPath ?? path.join(cwd, "opendweb.config.toml");
    w.line();
    w.line("plan:");
    w.line(`  mode          ${plan.mode === "single" ? "single-domain path routing" : "dual hostname"}`);
    w.line(`  gateway       ${plan.gatewayHost} (${plan.publicGatewayUrl})`);
    w.line(`  relay         ${plan.relayHost} (${plan.publicRelayUrl})`);
    w.line(`  config file   ${targetConfig}`);
    w.line("  ingress rules:");
    for (const rule of ingress.ingress) w.line(`    ${JSON.stringify(rule)}`);
    w.line("  this will:");
    w.line("    1. push ingress rules to Cloudflare (tunnel configurations API)");
    w.line("    2. route DNS CNAMEs to the tunnel (best-effort)");
    w.line(`    3. write ${targetConfig}`);
    w.line("    4. verify end-to-end via the public URL (services.json)");
    w.line();

    // 5) 确认：forceDryRun 下没有 apply 选项（--dry-run 语义不可覆盖）
    let action;
    if (forceDryRun) {
      action = (await ui.confirm("run this plan as a dry-run? (nothing will be pushed)")) ? "dry" : "no";
    } else {
      action = await ui.confirm3("apply this plan?", suggestedAction);
    }
    if (action === "no") {
      w.line();
      w.line("aborted; nothing was changed");
      return { exit: 0 };
    }

    // 6) 执行：复用非交互的 runSetup 编排，log 行带前缀缩进
    w.line();
    let lastBucket = -1;
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
      log: (line) => w.line(`  | ${line}`, w.paint.dim),
      verifyProgress: ({ elapsedMs, lastError }) => {
        // 轮询 ~1s 一次：每 5s 汇报一次等待状态（公网生效有延迟是常态）
        const bucket = Math.floor(elapsedMs / 5000);
        if (bucket > lastBucket) {
          lastBucket = bucket;
          w.line(`  | still verifying... ${Math.round(elapsedMs / 1000)}s (${lastError})`, w.paint.dim);
        }
      },
    });

    // 7) 结果与下一步指引
    w.line();
    w.line(`setup ok (${action === "dry" ? "dry-run" : "applied"})`, w.paint.green);
    if (action === "dry") {
      w.line("this was a rehearsal - nothing was pushed; re-run and choose [y] to apply", w.paint.dim);
    } else {
      w.line("next steps:");
      w.line("  1. start the server:              opendweb server");
      w.line(`  2. point clients at the gateway:   config set relay ${result.plan.publicGatewayUrl}`);
      w.line("to co-spawn cloudflared with the server, add [plugins.options] tunnel = true", w.paint.dim);
    }
    return { exit: 0 };
  } finally {
    ui.close();
  }
}
