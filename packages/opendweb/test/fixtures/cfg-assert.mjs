#!/usr/bin/env node
// 测试夹具：断言 setup 钩子收到的 payload 含 configPath/configDir
// （R2-M2：`opendweb setup --config <path>` 时插件必须知道目标文件）。
// 期望的 configPath 文件名后缀经 CFG_ASSERT_EXPECT 环境变量传入。
const args = process.argv.slice(2);
if (args.includes("--opendweb-declare")) {
  process.stdout.write(JSON.stringify({ name: "cfg-assert", hooks: ["setup"] }) + "\n");
  process.exit(0);
}
if (args.includes("--opendweb-hook")) {
  let text = "";
  process.stdin.on("data", (d) => (text += d));
  process.stdin.on("end", () => {
    const payload = text ? JSON.parse(text) : {};
    const expect = process.env.CFG_ASSERT_EXPECT ?? "";
    const ok =
      typeof payload.configPath === "string" &&
      payload.configPath.endsWith(expect) &&
      typeof payload.configDir === "string" &&
      payload.configPath.startsWith(payload.configDir);
    if (!ok) {
      process.stderr.write(
        `cfg-assert: bad payload (configPath=${JSON.stringify(payload.configPath)}, configDir=${JSON.stringify(payload.configDir)}, expect suffix ${JSON.stringify(expect)})\n`,
      );
      process.exit(1);
    }
    process.stdout.write("null\n");
    process.exit(0);
  });
}
