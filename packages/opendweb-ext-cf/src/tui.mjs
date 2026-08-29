// cf setup 交互引导（TUI，零依赖）：readline 行输入 + 数字选择 + y/d/n 确认。
// 形态判断：setup 是线性流程（token/hostname/mode -> 计划确认 -> 带状态执行
// -> 结果指引），无图形化诉求；token 是秘密，本地 TTY 输入比起 localhost
// web 表单更简单也更安全。所有输出全 ASCII（D10 纪律）；颜色仅在 TTY 且
// 未设 NO_COLOR 时启用。streams 可注入（测试）。
import readline from "node:readline/promises";
import path from "node:path";

import { runSetup, planExposure, renderConfigToml } from "./wizard.js";
import { buildIngress } from "./cf-api.js";

/**
 * 基础输入组件（全部行式，无 raw mode —— 跨平台零惊喜）。
 * 行分发自维护队列而非 rl.question：question 挂起期间到达的额外行会被
 * readline 丢弃（管道预置输入 / 脚本驱动的真实场景），backlog 暂存后逐问
 * 供给；输入关闭时拒绝未决问题（Ctrl+C / EOF -> 上层按失败处理）。
 * @param {{ input: NodeJS.ReadStream & { isTTY?: boolean }, output: NodeJS.WriteStream & { isTTY?: boolean } }} streams
 */
export function createPrompts({ input, output }) {
  const rl = readline.createInterface({ input, output });
  const paint = colors(output);
  const backlog = [];
  const pending = [];
  let closed = false;
  rl.on("line", (line) => {
    const next = pending.shift();
    if (next) next.resolve(line);
    else backlog.push(line);
  });
  rl.on("close", () => {
    closed = true;
    for (const next of pending.splice(0)) next.reject(new Error("input closed before an answer"));
  });
  const readLine = () => {
    if (backlog.length > 0) return Promise.resolve(backlog.shift());
    if (closed) return Promise.reject(new Error("input closed before an answer"));
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  };

  async function ask(label, { default: def, required = false } = {}) {
    for (;;) {
      output.write(`${label}${def !== undefined ? ` (${def})` : ""}: `);
      const answer = (await readLine()).trim();
      const value = answer === "" && def !== undefined ? def : answer;
      if (!required || value !== "") return value;
      output.write(paint.dim("  a value is required\n"));
    }
  }

  async function askSecret(label) {
    // 遮蔽手法：提示语自己写；terminal 模式下按键回显经 _writeToOutput
    // 替换为 '*'（readline 的半私有稳定接口——零依赖下的务实选择），
    // 管道模式本就无回显。
    output.write(`${label} (input hidden): `);
    const orig = rl._writeToOutput?.bind(rl);
    rl._writeToOutput = (s) => rl.output.write(s ? "*" : s);
    try {
      return (await readLine()).trim();
    } finally {
      rl._writeToOutput = orig;
      output.write("\n");
    }
  }

  async function select(label, options) {
    const fallback = options.findIndex((o) => o.default);
    output.write(`? ${label}\n`);
    options.forEach((o, i) => {
      const mark = o.default ? " (default)" : "";
      output.write(`  ${i + 1}) ${o.label}${paint.dim(mark)}\n`);
    });
    for (;;) {
      output.write(`  choose [${fallback + 1}]: `);
      const raw = (await readLine()).trim();
      const idx = raw === "" ? fallback : Number(raw) - 1;
      if (Number.isInteger(idx) && idx >= 0 && idx < options.length) return options[idx].value;
      output.write(paint.dim(`  enter a number between 1 and ${options.length}\n`));
    }
  }

  /**
   * 三态确认：y = apply / d = dry-run / n = abort（回车取默认，通常 apply）。
   * @returns {Promise<"apply" | "dry" | "no">}
   */
  async function confirm3(label, def = "apply") {
    for (;;) {
      output.write(`? ${label} [y] apply / [d] dry-run / [n] abort (${def}): `);
      const raw = (await readLine()).trim().toLowerCase();
      const value = raw === "" ? def : raw;
      if (value === "y" || value === "yes") return "apply";
      if (value === "d" || value === "dry") return "dry";
      if (value === "n" || value === "no") return "no";
      output.write(paint.dim("  answer y, d or n\n"));
    }
  }

  return { ask, askSecret, select, confirm3, rl, paint, close: () => rl.close() };
}

/** NO_COLOR / 非 TTY 时全部恒等（输出内容不因颜色通道而变化） */
function colors(output) {
  if (!output.isTTY || process.env.NO_COLOR) {
    return { dim: (s) => String(s), bold: (s) => String(s), green: (s) => String(s), red: (s) => String(s) };
  }
  return {
    dim: (s) => `\x1b[2m${s}\x1b[22m`,
    bold: (s) => `\x1b[1m${s}\x1b[22m`,
    green: (s) => `\x1b[32m${s}\x1b[39m`,
    red: (s) => `\x1b[31m${s}\x1b[39m`,
  };
}

/**
 * 交互式 setup 引导：收集 token/hostname/mode -> 计划预览 -> y/d/n 确认 ->
 * 复用 runSetup 执行（dry-run 同一编排）。任一步失败返回 exit 1；用户主动
 * 中止返回 exit 0（不是错误）。
 * @param {{ cwd: string, tokenEnvName?: string, suggestedHostname?: string, suggestedMode?: "dual" | "single",
 *           suggestedAction?: "apply" | "dry", configPath?: string | null, skipVerify?: boolean,
 *           stdin?: NodeJS.ReadStream, stdout?: NodeJS.WriteStream, env?: Record<string, string | undefined>,
 *           fetchImpl?: typeof fetch, writeFile?: (p: string, c: string) => Promise<void>,
 *           exists?: (p: string) => boolean, runSetupImpl?: typeof runSetup }} opts
 * @returns {Promise<{ exit: number }>}
 */
export async function runInteractiveSetup(opts) {
  const {
    cwd,
    tokenEnvName = "TUNNEL_TOKEN",
    suggestedHostname,
    suggestedMode = "dual",
    suggestedAction = "apply",
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
  const out = (line = "") => stdout.write(`${line}\n`);
  const dim = (line = "") => stdout.write(`${ui.paint.dim(line)}\n`);
  try {
    out();
    out(ui.paint.bold("cf setup - interactive wizard"));
    out(ui.paint.dim("wire a Cloudflare Tunnel to this opendweb server"));
    out();

    // 1) token：环境已设则默认复用；否则粘贴（回显遮蔽）
    let token = env[tokenEnvName];
    if (token) {
      dim(`detected ${tokenEnvName} in the environment`);
      const choice = await ui.select("tunnel token", [
        { value: "env", label: `use ${tokenEnvName} from the environment`, default: true },
        { value: "paste", label: "paste a different token" },
      ]);
      if (choice === "paste") token = await ui.askSecret(`tunnel token (copy from Zero Trust -> Networks -> Tunnels)`);
    } else {
      dim(`no ${tokenEnvName} in the environment; paste the tunnel token`);
      token = await ui.askSecret(`tunnel token (copy from Zero Trust -> Networks -> Tunnels)`);
    }
    if (!token) throw new Error(`no tunnel token provided (set ${tokenEnvName} or paste one when asked)`);

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
        stdout.write(ui.paint.dim(`  ${e.message}\n`));
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
    out();
    out("plan:");
    out(`  mode          ${plan.mode === "single" ? "single-domain path routing" : "dual hostname"}`);
    out(`  gateway       ${plan.gatewayHost} (${plan.publicGatewayUrl})`);
    out(`  relay         ${plan.relayHost} (${plan.publicRelayUrl})`);
    out(`  config file   ${targetConfig}`);
    out("  ingress rules:");
    for (const rule of ingress.ingress) out(`    ${JSON.stringify(rule)}`);
    out("  this will:");
    out("    1. push ingress rules to Cloudflare (tunnel configurations API)");
    out("    2. route DNS CNAMEs to the tunnel (best-effort)");
    out(`    3. write ${targetConfig}`);
    out("    4. verify end-to-end via the public URL (services.json)");
    out();

    // 5) 确认（apply / dry-run / abort）
    const action = await ui.confirm3("apply this plan?", suggestedAction);
    if (action === "no") {
      out();
      out("aborted; nothing was changed");
      return { exit: 0 };
    }

    // 6) 执行：复用非交互的 runSetup 编排，log 行带前缀缩进
    out();
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
      log: (line) => stdout.write(ui.paint.dim(`  | ${line}\n`)),
      verifyProgress: ({ elapsedMs, lastError }) => {
        // 轮询 ~1s 一次：每 5s 汇报一次等待状态（公网生效有延迟是常态）
        const bucket = Math.floor(elapsedMs / 5000);
        if (bucket > lastBucket) {
          lastBucket = bucket;
          stdout.write(ui.paint.dim(`  | still verifying... ${Math.round(elapsedMs / 1000)}s (${lastError})\n`));
        }
      },
    });

    // 7) 结果与下一步指引
    out();
    out(ui.paint.green(`setup ok (${action === "dry" ? "dry-run" : "applied"})`));
    if (action === "dry") {
      dim("this was a rehearsal - nothing was pushed; re-run and choose [y] to apply");
    } else {
      out("next steps:");
      out("  1. start the server:              opendweb server");
      out(`  2. point clients at the gateway:   config set relay ${result.plan.publicGatewayUrl}`);
      dim("to co-spawn cloudflared with the server, add [plugins.options] tunnel = true");
    }
    return { exit: 0 };
  } catch (e) {
    out();
    stdout.write(ui.paint.red(`failed: ${e?.message ?? String(e)}\n`));
    return { exit: 1 };
  } finally {
    ui.close();
  }
}

/** 非 TTY 下渲染合并片段（供未来复用；当前作为 renderConfigToml 的再导出锚点） */
export { renderConfigToml };
