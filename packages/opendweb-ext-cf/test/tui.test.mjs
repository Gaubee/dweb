// TUI 引导单测（1.0.0 发现式向导）：fake clack 脚本化驱动 + 注入 createGateway/
// login/loadAuth/persistAuth/runProvision。覆盖：认证四来源（env/stored/login/
// paste）、zone/hostname/mode 深度建议、tunnel 选择（ownership 命名 + 现有列
// 表）、计划预览、apply/dry/abort、DNS 冲突交互、forceDryRun 二元确认、新建
// tunnel 的 connector token 一次性展示。@clack 自身的交互正确性由库测试与
// e2e（管道驱动真库）背书。
import test from "node:test";
import assert from "node:assert/strict";

import { sanitizeUI, InteractiveAbort, createPrompts } from "../dist/prompts.mjs";
import { runInteractiveSetup } from "../dist/tui.mjs";
import { wantsInteractive } from "../dist/cli.mjs";
import { planExposure } from "../dist/route-model.mjs";
import { tokenSummary } from "../dist/cf-api.mjs";

/** fake clack：按类型弹出应答；记录全部调用供断言。text/password 执行 validate
 * （返回 string 即取下一应答重试——模拟 @clack 的重问循环） */
function fakeClack(answers) {
  const queue = [...answers];
  const calls = { text: [], password: [], select: [], confirm: [], intro: [], outro: [], note: [], log: [] };
  const next = (type) => {
    if (queue.length === 0) throw new Error(`fake clack: no scripted answer left for ${type}`);
    const a = queue.shift();
    if (a.type !== type) throw new Error(`fake clack: expected ${a.type}, got call ${type}`);
    return a;
  };
  return {
    calls,
    isCancel: (v) => v === Symbol.for("clack:cancel"),
    intro: (t) => { calls.intro.push(t); },
    outro: (m) => { calls.outro.push(m); },
    note: (body, title) => { calls.note.push({ body, title }); },
    log: { message: (m) => { calls.log.push(m); }, step: (m) => { calls.log.push(m); } },
    spinner: () => ({ start: () => {}, stop: () => {}, message: () => {} }),
    text: async (cfg) => {
      calls.text.push(cfg);
      for (;;) {
        const a = next("text");
        // @clack 语义：空提交且设有 defaultValue 时 validate 收到 undefined，
        // validate 通过后库返回 defaultValue
        const toValidate = a.value === "" && cfg.defaultValue !== undefined ? undefined : a.value;
        const err = cfg.validate?.(toValidate);
        if (err) continue; // 重问：消耗下一个应答
        return a.value === "" && cfg.defaultValue !== undefined ? cfg.defaultValue : a.value;
      }
    },
    password: async (cfg) => {
      calls.password.push(cfg);
      for (;;) {
        const a = next("password");
        const err = cfg.validate?.(a.value);
        if (err) continue; // 重问：消耗下一个应答
        return a.value;
      }
    },
    select: async (cfg) => {
      calls.select.push(cfg);
      return next("select").value;
    },
    confirm: async (cfg) => {
      calls.confirm.push(cfg);
      return next("confirm").value;
    },
  };
}

const A = {
  text: (value) => ({ type: "text", value }),
  password: (value) => ({ type: "password", value }),
  select: (value) => ({ type: "select", value }),
  confirm: (value) => ({ type: "confirm", value }),
};

// ---- fixtures ----

const ZONE_TW = { id: "zone1", name: "tweb.xin", accountId: "acc1", accountName: "Tweb Labs", status: "active" };
const ZONE_OTHER = { id: "zone2", name: "other.example.com", accountId: "acc2", accountName: "Other", status: "active" };
const TUNNELS = [
  { id: "t-old", name: "legacy-tunnel", status: "active", connections: 2 },
  { id: "t-dead", name: "dead-tunnel", status: "inactive", connections: 0 },
];
const API_TOKEN = "unit-test-api-token-0123456789abcdef0123456789";
const HOST = "gaubee.tweb.xin";
const NEW_TUNNEL_CHOICE = { kind: "new", name: "opendweb-gaubee-tweb-xin" };

function fakeGateway({ zones = [ZONE_TW, ZONE_OTHER], tunnels = TUNNELS, failTunnels = false } = {}) {
  const calls = { listZones: 0, listTunnels: [], tokens: [] };
  return {
    calls,
    async listZones() {
      calls.listZones += 1;
      return zones;
    },
    async listTunnels(accountId) {
      calls.listTunnels.push(accountId);
      if (failTunnels) throw new Error("token lacks Tunnel permissions");
      return tunnels;
    },
  };
}

const successResult = (input) => ({
  plan: planExposure({ hostname: input.hostname, mode: input.mode }),
  accountId: input.zone.accountId,
  zoneId: input.zone.id,
  tunnelId: "t-x",
  tunnelToken: null,
  configWritten: true,
});

function mockProvision(impl) {
  const calls = [];
  return {
    calls,
    run: async (input) => {
      calls.push(input);
      return impl ? impl(input) : successResult(input);
    },
  };
}

/** 标准注入面：paste-token 全流程的答案骨架（可按需截断/覆盖） */
function pasteDriveAnswers({ host = HOST, mode = "single", action = "apply", token = API_TOKEN } = {}) {
  return [
    A.select("paste"),
    A.password(token),
    A.confirm(true),
    A.select(ZONE_TW),
    A.text(host),
    A.select(mode),
    A.select(host === HOST && mode === "single" ? NEW_TUNNEL_CHOICE : { kind: "new", name: `opendweb-${host.replace(/\./g, "-")}` }),
    A.select(action),
  ];
}

function tuiOpts(fk, { gateway, provision, env = {}, ...rest } = {}) {
  return {
    cwd: "/proj",
    env,
    clack: fk,
    createGateway: async (t) => {
      gateway.calls.tokens.push(t);
      return gateway;
    },
    loadAuth: async () => null,
    persistAuth: async () => {},
    runProvision: provision.run,
    writeFile: async () => {},
    exists: () => false,
    ...rest,
  };
}

// ---- 适配层（prompts） ----

test("sanitizeUI: control characters are escaped, printable unicode kept (injection guard)", () => {
  assert.equal(sanitizeUI("ok"), "ok");
  assert.equal(sanitizeUI("bad\u2713host"), "bad\u2713host"); // 可打印 Unicode 保留（@clack 骨架即 Unicode）
  assert.equal(sanitizeUI("esc\x1b[31mred"), "esc\\x1b[31mred"); // ESC 注入转义
  assert.equal(sanitizeUI("line\nbreak"), "line\\x0abreak"); // 换行伪造 UI 转义
  assert.equal(sanitizeUI("del\x7f"), "del\\x7f");
  assert.equal(sanitizeUI("tab\tsep"), "tab\\x09sep"); // Tab 破坏对齐——同样转义
  assert.equal(sanitizeUI("c1\u009cseq"), "c1\\x9cseq"); // C1 控制区（U+0080-U+009F）
  assert.equal(sanitizeUI("stx\u0082"), "stx\\x82");
});

test("createPrompts: a clack cancel result maps to InteractiveAbort; messages sanitized", async () => {
  const cancel = Symbol.for("clack:cancel");
  const fk = {
    isCancel: (v) => v === cancel,
    intro: () => {}, outro: () => {}, note: () => {},
    log: { message: () => {} }, spinner: () => ({ start: () => {}, stop: () => {}, message: () => {} }),
    text: async () => cancel,
    password: async () => "x",
    select: async () => "x",
    confirm: async () => true,
  };
  const ui = createPrompts(fk);
  await assert.rejects(() => ui.text({ message: "m" }), (e) => e instanceof InteractiveAbort);
  // message 类动态值经 sanitizeUI
  const calls = [];
  fk.text = async (cfg) => { calls.push(cfg); return "v"; };
  await ui.text({ message: "inject\nme" });
  assert.equal(calls[0].message, "inject\\x0ame");
});

test("wantsInteractive: explicit flag always; otherwise only TTY without hostname", () => {
  assert.equal(wantsInteractive({ interactive: true, hostname: "x.example.com" }, false), true);
  assert.equal(wantsInteractive({ interactive: true }, false), true);
  assert.equal(wantsInteractive({}, true), true);
  assert.equal(wantsInteractive({}, false), false);
  assert.equal(wantsInteractive({ hostname: "x.example.com" }, true), false);
});

// ---- 认证步骤 ----

test("auth step: options are conditional (env/stored only when available); paste path collects and echoes a summary", async () => {
  const fk = fakeClack(pasteDriveAnswers());
  const gateway = fakeGateway();
  const provision = mockProvision();
  const r = await runInteractiveSetup(tuiOpts(fk, { gateway, provision, env: {} }));
  assert.equal(r.exit, 0);
  // env 未设、无已存登录态：只有 login + paste 两个选项；login 提示需要 CF_OAUTH_CLIENT_ID
  const auth = fk.calls.select[0];
  assert.deepEqual(auth.options.map((o) => o.value), ["login", "paste"]);
  assert.match(auth.options[0].hint, /CF_OAUTH_CLIENT_ID/);
  // 提交后回显头尾对照摘要
  assert.ok(fk.calls.log.includes(`api token: ${tokenSummary(API_TOKEN)}`), JSON.stringify(fk.calls.log));
});

test("auth step: env token option first with a summary hint; stored session option with cached access token", async () => {
  // env 路径
  const fkEnv = fakeClack([
    A.select("env"),
    A.select(ZONE_TW),
    A.text(HOST),
    A.select("single"),
    A.select(NEW_TUNNEL_CHOICE),
    A.select("apply"),
  ]);
  const gatewayEnv = fakeGateway();
  const provisionEnv = mockProvision();
  const envToken = "env-token-0123456789abcdef0123456789abcdef";
  const rEnv = await runInteractiveSetup(
    tuiOpts(fkEnv, { gateway: gatewayEnv, provision: provisionEnv, env: { CLOUDFLARE_API_TOKEN: envToken } }),
  );
  assert.equal(rEnv.exit, 0);
  assert.deepEqual(fkEnv.calls.select[0].options.map((o) => o.value), ["env", "login", "paste"]);
  assert.equal(fkEnv.calls.select[0].options[0].hint, tokenSummary(envToken));
  assert.ok(gatewayEnv.calls.tokens.every((t) => t === envToken), JSON.stringify(gatewayEnv.calls.tokens));

  // stored 路径：缓存 access token 未过期 -> 直接使用，无网络刷新
  const fkStored = fakeClack([
    A.select("stored"),
    A.select(ZONE_TW),
    A.text(HOST),
    A.select("single"),
    A.select(NEW_TUNNEL_CHOICE),
    A.select("apply"),
  ]);
  const gatewayStored = fakeGateway();
  const provisionStored = mockProvision();
  const rStored = await runInteractiveSetup(
    tuiOpts(fkStored, {
      gateway: gatewayStored,
      provision: provisionStored,
      env: {},
      loadAuth: async () => ({ refreshToken: "rt", clientId: "cid", accessToken: "at-cached", expiresAt: Date.now() + 3_600_000 }),
    }),
  );
  assert.equal(rStored.exit, 0);
  assert.deepEqual(fkStored.calls.select[0].options.map((o) => o.value), ["stored", "login", "paste"]);
  assert.ok(gatewayStored.calls.tokens.every((t) => t === "at-cached"), JSON.stringify(gatewayStored.calls.tokens));
});

test("auth step: browser login persists the session and uses the returned access token", async () => {
  const fk = fakeClack([
    A.select("login"),
    A.select(ZONE_TW),
    A.text(HOST),
    A.select("single"),
    A.select(NEW_TUNNEL_CHOICE),
    A.select("apply"),
  ]);
  const gateway = fakeGateway();
  const provision = mockProvision();
  const persisted = [];
  const loginCalls = [];
  const r = await runInteractiveSetup(
    tuiOpts(fk, {
      gateway,
      provision,
      env: { CF_OAUTH_CLIENT_ID: "cid-9" },
      login: async (clientId) => {
        loginCalls.push(clientId);
        return { accessToken: "at-browser", refreshToken: "rt-browser" };
      },
      persistAuth: async (a) => persisted.push(a),
    }),
  );
  assert.equal(r.exit, 0);
  assert.deepEqual(loginCalls, ["cid-9"]);
  assert.deepEqual(persisted, [{ refreshToken: "rt-browser", clientId: "cid-9", accessToken: "at-browser" }]);
  assert.ok(gateway.calls.tokens.length >= 1 && gateway.calls.tokens.every((t) => t === "at-browser"));
  assert.equal(provision.calls.length, 1);
  // login 选项已配置：不带 CF_OAUTH_CLIENT_ID 提示
  assert.equal(fk.calls.select[0].options[0].hint, undefined);
});

test("auth step: browser login without a configured client id is a hard error", async () => {
  const fk = fakeClack([A.select("login")]);
  const gateway = fakeGateway();
  await assert.rejects(
    () => runInteractiveSetup(tuiOpts(fk, { gateway, provision: mockProvision(), env: {} })),
    /browser login is not configured: create an OAuth client .* CF_OAUTH_CLIENT_ID, or use an API token/s,
  );
});

test("paste step: declining the confirmation restarts entry; the second token wins", async () => {
  const second = "another-unit-test-api-token-0123456789abcdef";
  const fk = fakeClack([
    A.select("paste"),
    A.password(API_TOKEN),
    A.confirm(false), // 拒绝 -> 重输
    A.password(second),
    A.confirm(true),
    A.select(ZONE_TW),
    A.text(HOST),
    A.select("single"),
    A.select(NEW_TUNNEL_CHOICE),
    A.select("apply"),
  ]);
  const gateway = fakeGateway();
  const r = await runInteractiveSetup(tuiOpts(fk, { gateway, provision: mockProvision(), env: {} }));
  assert.equal(r.exit, 0);
  assert.ok(fk.calls.log.some((l) => l === "re-enter the token"), "restart hint shown");
  assert.deepEqual(gateway.calls.tokens, [second, second, second], JSON.stringify(gateway.calls.tokens));
});

test("paste step: the validator accumulator rejects short and non-token input (re-ask loop)", async () => {
  // 首行 junk：validate 持续拒绝 -> fake 的重问循环耗尽脚本应答（即重问语义生效）
  const fk = fakeClack([A.select("paste"), A.password("junk with spaces !!")]);
  await assert.rejects(
    () => runInteractiveSetup(tuiOpts(fk, { gateway: fakeGateway(), provision: mockProvision(), env: {} })),
    /no scripted answer left for password/,
  );
  const validate = fk.calls.password[0].validate;
  assert.match(validate("anything"), /no token yet - keep pasting/, "first junk line keeps the prompt open");

  // 独立闭包：短输入同样被拒
  const fk2 = fakeClack([A.select("paste"), A.password("short")]);
  await assert.rejects(
    () => runInteractiveSetup(tuiOpts(fk2, { gateway: fakeGateway(), provision: mockProvision(), env: {} })),
    /no scripted answer left for password/,
  );
  const v2 = fk2.calls.password[0].validate;
  assert.match(v2("still-short"), /no token yet - keep pasting/);
  // 合法裸 token 的接受分支由全部成功走完的 paste 驱动覆盖（confirm 会出现）
});

// ---- zone / hostname / mode ----

test("zone step: zones listed once; empty zone list is a hard error with permission guidance", async () => {
  const fk = fakeClack(pasteDriveAnswers());
  const gateway = fakeGateway();
  const r = await runInteractiveSetup(tuiOpts(fk, { gateway, provision: mockProvision(), env: {} }));
  assert.equal(r.exit, 0);
  assert.equal(gateway.calls.listZones, 1);
  assert.deepEqual(fk.calls.select[1].options.map((o) => o.value), [ZONE_TW, ZONE_OTHER]); // 选项 value 是 zone 对象
  assert.equal(fk.calls.select[1].options[0].label, "tweb.xin");

  const fkEmpty = fakeClack([A.select("paste"), A.password(API_TOKEN), A.confirm(true)]);
  await assert.rejects(
    () => runInteractiveSetup(tuiOpts(fkEmpty, { gateway: fakeGateway({ zones: [] }), provision: mockProvision(), env: {} })),
    /no zones visible to this credential/,
  );
});

test("hostname step: suggested hostname becomes placeholder+defaultValue; empty input takes it", async () => {
  const fk = fakeClack([
    A.select("paste"),
    A.password(API_TOKEN),
    A.confirm(true),
    A.select(ZONE_TW),
    A.text(""), // 空提交 -> defaultValue
    A.select("single"),
    A.select({ kind: "new", name: "opendweb-app-tweb-xin" }),
    A.select("apply"),
  ]);
  const provision = mockProvision();
  const r = await runInteractiveSetup(
    tuiOpts(fk, { gateway: fakeGateway(), provision, env: {}, suggestedHostname: "app.tweb.xin" }),
  );
  assert.equal(r.exit, 0);
  assert.equal(fk.calls.text[0].defaultValue, "app.tweb.xin");
  assert.equal(fk.calls.text[0].placeholder, "app.tweb.xin");
  assert.equal(provision.calls[0].hostname, "app.tweb.xin");
});

test("hostname step: junk and outside-zone hostnames are re-asked until valid", async () => {
  const fk = fakeClack([
    A.select("paste"),
    A.password(API_TOKEN),
    A.confirm(true),
    A.select(ZONE_TW),
    A.text("bad host"), // planExposure 拒绝
    A.text("elsewhere.org"), // 不在所选 zone 内
    A.text(HOST), // 通过
    A.select("single"),
    A.select(NEW_TUNNEL_CHOICE),
    A.select("apply"),
  ]);
  const provision = mockProvision();
  const r = await runInteractiveSetup(tuiOpts(fk, { gateway: fakeGateway(), provision, env: {} }));
  assert.equal(r.exit, 0);
  assert.equal(provision.calls[0].hostname, HOST);
});

test("mode step: gateway below the zone apex recommends single (relay.<gateway> needs a paid edge cert)", async () => {
  const fk = fakeClack(pasteDriveAnswers({ host: HOST, mode: "single" }));
  const r = await runInteractiveSetup(tuiOpts(fk, { gateway: fakeGateway(), provision: mockProvision(), env: {} }));
  assert.equal(r.exit, 0);
  const modeSel = fk.calls.select.find((c) => c.options?.[0]?.value === "dual");
  const dual = modeSel.options.find((o) => o.value === "dual");
  const single = modeSel.options.find((o) => o.value === "single");
  assert.match(dual.hint, /needs a paid edge certificate: relay\.gaubee\.tweb\.xin would be a second-level subdomain of tweb\.xin/);
  assert.match(dual.hint, /ACM \/ Total TLS required/);
  assert.match(single.hint, /recommended for tweb\.xin - stays on gaubee\.tweb\.xin/);
  assert.equal(modeSel.initialValue, "single");
});

test("mode step: gateway at the zone apex keeps dual recommended", async () => {
  const fk = fakeClack([
    A.select("paste"),
    A.password(API_TOKEN),
    A.confirm(true),
    A.select(ZONE_TW),
    A.text("tweb.xin"), // gateway == zone -> relay 为一级子域
    A.select("dual"),
    A.select({ kind: "new", name: "opendweb-tweb-xin" }),
    A.select("apply"),
  ]);
  const r = await runInteractiveSetup(tuiOpts(fk, { gateway: fakeGateway(), provision: mockProvision(), env: {} }));
  assert.equal(r.exit, 0);
  const modeSel = fk.calls.select.find((c) => c.options?.[0]?.value === "dual");
  assert.match(modeSel.options.find((o) => o.value === "dual").hint, /recommended - relay\.<gateway> is a first-level subdomain/);
  assert.equal(modeSel.options.find((o) => o.value === "single").hint, undefined);
  assert.equal(modeSel.initialValue, "dual");
});

// ---- tunnel 步骤 ----

test("tunnel step: ownership name first; existing tunnels listed with status/connector hints", async () => {
  const fk = fakeClack(pasteDriveAnswers({ mode: "single" }));
  const provision = mockProvision();
  const r = await runInteractiveSetup(tuiOpts(fk, { gateway: fakeGateway(), provision, env: {} }));
  assert.equal(r.exit, 0);
  const tunnelSel = fk.calls.select.find((c) => c.options?.[0]?.value?.kind !== undefined);
  assert.equal(tunnelSel.options[0].label, 'create tunnel "opendweb-gaubee-tweb-xin"');
  assert.equal(tunnelSel.options[0].hint, "recommended");
  assert.deepEqual(tunnelSel.options[1], {
    value: { kind: "existing", id: "t-old" },
    label: 'use existing "legacy-tunnel"',
    hint: "active, 2 connector(s) online",
  });
  assert.deepEqual(tunnelSel.options[2], {
    value: { kind: "existing", id: "t-dead" },
    label: 'use existing "dead-tunnel"',
    hint: "inactive",
  });
  // 选项 value 原样进入 provision
  assert.deepEqual(provision.calls[0].tunnel, NEW_TUNNEL_CHOICE);

  // 已存在同名 tunnel：首项变为复用
  const fkReuse = fakeClack([
    A.select("paste"),
    A.password(API_TOKEN),
    A.confirm(true),
    A.select(ZONE_TW),
    A.text(HOST),
    A.select("single"),
    A.select({ kind: "existing", id: "t-named" }),
    A.select("apply"),
  ]);
  const provisionReuse = mockProvision();
  await runInteractiveSetup(
    tuiOpts(fkReuse, {
      gateway: fakeGateway({ tunnels: [{ id: "t-named", name: "opendweb-gaubee-tweb-xin", status: "active", connections: 1 }] }),
      provision: provisionReuse,
      env: {},
    }),
  );
  const reuseSel = fkReuse.calls.select.find((c) => c.options?.[0]?.value?.kind !== undefined);
  assert.equal(reuseSel.options[0].label, 'use existing "opendweb-gaubee-tweb-xin"');
  assert.deepEqual(reuseSel.options[0].value, { kind: "existing", id: "t-named" });
  assert.deepEqual(provisionReuse.calls[0].tunnel, { kind: "existing", id: "t-named" });
});

test("tunnel step: listing failure degrades to create-new with a log line", async () => {
  const fk = fakeClack(pasteDriveAnswers({ mode: "single" }));
  const provision = mockProvision();
  const r = await runInteractiveSetup(
    tuiOpts(fk, { gateway: fakeGateway({ failTunnels: true }), provision, env: {} }),
  );
  assert.equal(r.exit, 0);
  assert.ok(fk.calls.log.some((l) => /tunnel listing unavailable/.test(l)), JSON.stringify(fk.calls.log));
  const tunnelSel = fk.calls.select.find((c) => c.options?.[0]?.value?.kind !== undefined);
  assert.equal(tunnelSel.options.length, 1, "only the create option when listing failed");
  assert.deepEqual(provision.calls[0].tunnel, NEW_TUNNEL_CHOICE);
});

// ---- 计划预览与确认 ----

test("plan note: full preview (mode/hosts/zone/tunnel/config file, ingress rules, steps); apply runs provision", async () => {
  const fk = fakeClack(pasteDriveAnswers({ mode: "single" }));
  const provision = mockProvision();
  const r = await runInteractiveSetup(tuiOpts(fk, { gateway: fakeGateway(), provision, env: {} }));
  assert.equal(r.exit, 0);
  assert.equal(fk.calls.note[0].title, "overview");
  assert.match(fk.calls.note[0].body, /how this works:/);
  assert.match(fk.calls.note[0].body, /Zone \/ DNS \/ Edit/);
  const plan = fk.calls.note[1];
  assert.equal(plan.title, "plan");
  assert.match(plan.body, /mode\s+single-domain path routing/);
  assert.match(plan.body, /gateway\s+gaubee\.tweb\.xin \(https:\/\/gaubee\.tweb\.xin\)/);
  assert.match(plan.body, /relay\s+relay\.gaubee\.tweb\.xin \(https:\/\/gaubee\.tweb\.xin\)/); // single：relay URL 即 gateway URL
  assert.match(plan.body, /zone\s+tweb\.xin \(acc1\)/);
  assert.match(plan.body, /tunnel\s+create "opendweb-gaubee-tweb-xin"/);
  assert.match(plan.body, /config file\s+\/proj\/opendweb\.config\.toml/);
  assert.match(plan.body, /ingress rules:/);
  assert.match(plan.body, /\{"hostname":"gaubee\.tweb\.xin","path":"\^\/relay\.\*","service":"http:\/\/localhost:3340"\}/);
  assert.match(plan.body, /steps:/);
  assert.ok(plan.body.includes("\n"), "note body keeps structural newlines");
  // provision 输入完整
  const input = provision.calls[0];
  assert.equal(input.hostname, HOST);
  assert.equal(input.mode, "single");
  assert.deepEqual(input.zone, ZONE_TW);
  assert.equal(input.cwd, "/proj");
  assert.equal(input.dryRun, false);
  assert.equal(input.skipVerify, false);
  assert.equal(typeof input.onDnsConflict, "function");
  assert.match(fk.calls.outro.join("\n"), /setup ok \(applied\)/);
  assert.ok(fk.calls.log.some((l) => /next steps:/.test(l)));
});

test("plan note: dynamic values are escaped, layout newlines survive", async () => {
  const fk = fakeClack(pasteDriveAnswers({ mode: "single" }));
  const r = await runInteractiveSetup(
    tuiOpts(fk, { gateway: fakeGateway(), provision: mockProvision(), env: {}, cwd: "/pr\x1boj" }),
  );
  assert.equal(r.exit, 0);
  const body = fk.calls.note[1].body;
  assert.ok(body.includes("\n"), "layout newlines survive");
  assert.ok(body.includes("\\x1b"), "control chars in dynamic values are escaped");
  assert.ok(!body.includes("pr\x1boj"), "raw control char must not reach the note body");
});

test("action select: abort exits 0 without running provision", async () => {
  const fk = fakeClack(pasteDriveAnswers({ mode: "single", action: "abort" }));
  const provision = mockProvision();
  const r = await runInteractiveSetup(tuiOpts(fk, { gateway: fakeGateway(), provision, env: {} }));
  assert.equal(r.exit, 0);
  assert.equal(provision.calls.length, 0);
  assert.match(fk.calls.outro.join("\n"), /aborted; nothing was changed/);
});

test("action select: dry passes dryRun to provision and outros without pushing", async () => {
  const fk = fakeClack(pasteDriveAnswers({ mode: "single", action: "dry" }));
  const provision = mockProvision();
  const r = await runInteractiveSetup(tuiOpts(fk, { gateway: fakeGateway(), provision, env: {} }));
  assert.equal(r.exit, 0);
  assert.equal(provision.calls[0].dryRun, true);
  assert.match(fk.calls.outro.join("\n"), /dry-run ok - nothing was pushed/);
});

test("clack cancel (Ctrl+C) maps to abort semantics (exit 0)", async () => {
  const cancel = Symbol.for("clack:cancel");
  const fk = fakeClack([]);
  fk.select = async () => cancel; // 第一个问题（认证来源）即取消
  const r = await runInteractiveSetup(tuiOpts(fk, { gateway: fakeGateway(), provision: mockProvision(), env: {} }));
  assert.equal(r.exit, 0);
  assert.match(fk.calls.outro.join("\n"), /aborted; nothing was changed/);
});

test("provision failures rethrow for dispatcher normalization", async () => {
  const fk = fakeClack(pasteDriveAnswers({ mode: "single" }));
  await assert.rejects(
    () =>
      runInteractiveSetup(
        tuiOpts(fk, {
          gateway: fakeGateway(),
          env: {},
          provision: mockProvision(async () => {
            throw new Error("boom from cloudflare api");
          }),
        }),
      ),
    /boom from cloudflare api/,
  );
});

// ---- DNS 冲突交互 ----

test("onDnsConflict: wired to a replace/abort select; the decision reaches provision", async () => {
  let decision = null;
  const fk = fakeClack([
    ...pasteDriveAnswers({ mode: "single" }).slice(0, -1), // 到 apply 为止
    A.select("apply"),
    A.select("replace"), // 冲突选择
  ]);
  const provision = mockProvision(async (input) => {
    decision = await input.onDnsConflict(
      { id: "r7", type: "A", name: HOST, content: "203.0.113.9" },
      HOST,
    );
    return successResult(input);
  });
  const r = await runInteractiveSetup(tuiOpts(fk, { gateway: fakeGateway(), provision, env: {} }));
  assert.equal(r.exit, 0);
  assert.equal(decision, "replace");
  const conflictSel = fk.calls.select.at(-1);
  assert.match(conflictSel.message, /DNS conflict: gaubee\.tweb\.xin has a A record -> 203\.0\.113\.9/);
  assert.deepEqual(conflictSel.options.map((o) => o.value), ["replace", "abort"]);
  assert.match(fk.calls.outro.join("\n"), /setup ok \(applied\)/);
});

// ---- forceDryRun（无凭据） ----

test("forceDryRun: no auth prompts at all; declining the binary confirm aborts with exit 0", async () => {
  const fk = fakeClack([A.select("dual"), A.confirm(false)]);
  const provision = mockProvision();
  const r = await runInteractiveSetup(
    tuiOpts(fk, { gateway: fakeGateway(), provision, env: {}, forceDryRun: true, suggestedHostname: HOST }),
  );
  assert.equal(r.exit, 0);
  assert.equal(fk.calls.password.length, 0, "dry-run must not demand a token");
  assert.equal(fk.calls.select.length, 1, "only the mode select is asked");
  assert.equal(fk.calls.select[0].options[0].value, "dual");
  assert.match(fk.calls.confirm[0].message, /dry-run\? \(nothing will be pushed\)/);
  assert.equal(provision.calls.length, 0);
  assert.match(fk.calls.outro.join("\n"), /aborted; nothing was changed/);
});

test("forceDryRun: confirming runs no provisioning and outros the no-credential contract", async () => {
  const fk = fakeClack([A.select("dual"), A.confirm(true)]);
  const provision = mockProvision();
  const spies = { fetch: 0, write: 0 };
  const r = await runInteractiveSetup(
    tuiOpts(fk, {
      gateway: fakeGateway(),
      provision,
      env: {},
      forceDryRun: true,
      suggestedHostname: HOST,
      fetchImpl: async () => {
        spies.fetch += 1;
        throw new Error("must not be called");
      },
      writeFile: async () => {
        spies.write += 1;
      },
    }),
  );
  assert.equal(r.exit, 0);
  assert.equal(provision.calls.length, 0, "no credential -> nothing is provisioned");
  assert.equal(spies.fetch, 0);
  assert.equal(spies.write, 0);
  // 计划预览使用建议 hostname
  assert.match(fk.calls.note[1].body, /gateway\s+gaubee\.tweb\.xin/);
  assert.match(fk.calls.outro.join("\n"), /dry-run complete \(no credential collected - nothing was pushed\)/);
});

// ---- 结果：connector token 一次性展示 ----

test("result: a newly created tunnel surfaces the connector token note with the export line", async () => {
  const fk = fakeClack(pasteDriveAnswers({ mode: "single" }));
  const provision = mockProvision((input) => ({ ...successResult(input), tunnelId: "t-new", tunnelToken: "tok-once" }));
  const r = await runInteractiveSetup(tuiOpts(fk, { gateway: fakeGateway(), provision, env: {} }));
  assert.equal(r.exit, 0);
  const tokenNote = fk.calls.note.find((n) => n.title === "connector token");
  assert.ok(tokenNote, `connector token note missing: ${JSON.stringify(fk.calls.note.map((n) => n.title))}`);
  assert.match(tokenNote.body, /export TUNNEL_TOKEN=tok-once/);
  assert.match(tokenNote.body, /not stored/);
  assert.match(fk.calls.outro.join("\n"), /setup ok \(applied\)/);
});

test("result: no connector token -> no token note", async () => {
  const fk = fakeClack(pasteDriveAnswers({ mode: "single" }));
  await runInteractiveSetup(tuiOpts(fk, { gateway: fakeGateway(), provision: mockProvision(), env: {} }));
  assert.equal(fk.calls.note.find((n) => n.title === "connector token"), undefined);
});
