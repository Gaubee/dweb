#!/usr/bin/env node
// 测试夹具：本地插件文件（手写最小子进程协议，不依赖 helper 包——测试自包含）。
// 声明：--opendweb-declare → stdout {name, hooks}
// 回调：--opendweb-hook <name> → stdin payload → stdout 结果 JSON
const args = process.argv.slice(2);
const hooks = ["server.preStart", "server.postReady", "server.preStop", "setup"];

if (args.includes("--opendweb-declare")) {
  process.stdout.write(JSON.stringify({ name: "local-echo", hooks }) + "\n");
  process.exit(0);
}

const hookIdx = args.indexOf("--opendweb-hook");
if (hookIdx !== -1) {
  const hook = args[hookIdx + 1];
  if (!hooks.includes(hook)) process.exit(0);
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (text += d));
  process.stdin.on("end", async () => {
    const payload = text ? JSON.parse(text) : {};
    try {
      switch (hook) {
        case "server.preStart":
          process.stdout.write(JSON.stringify({
            server: { publicGatewayUrl: "https://from-local-plugin.example.com" },
          }) + "\n");
          break;
        case "server.postReady":
          process.stdout.write(JSON.stringify({
            bannerLines: [`local-echo ready (server: ${payload.server?.gatewayBind ?? "?"})`],
          }) + "\n");
          break;
        case "server.preStop":
          process.stderr.write("local-echo stopping\n");
          process.stdout.write(JSON.stringify(null) + "\n");
          break;
        case "setup":
          if (payload.options?.fail === true) {
            throw new Error("setup failed as requested");
          }
          process.stdout.write(JSON.stringify({ done: true }) + "\n");
          break;
      }
      process.exit(0);
    } catch (e) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
  });
}
