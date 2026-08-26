#!/usr/bin/env node
// opendweb CLI — 顶层入口。v0.1 提供 server 启动能力（relay + rendezvous）。
// 用法：
//   opendweb server [--http <bind>] [--relay <bind>] [--no-relay]
// 环境变量与 server-binary 一致：DWEB_HTTP_BIND / DWEB_RELAY_HTTP_BIND / DWEB_RELAY_ENABLED
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const SUPPORTED = `${process.platform}-${process.arch}`;
const EXPECTED = "darwin-arm64";
if (SUPPORTED !== EXPECTED) {
  console.error(
    `opendweb: 当前平台 ${SUPPORTED} 暂不支持。v0.1 仅提供 ${EXPECTED}；服务器部署请使用 docker 镜像 ghcr.io/gaubee/dweb。`,
  );
  process.exit(1);
}

function opt(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const command = process.argv[2] ?? "help";

async function main() {
  if (command === "server") {
    const { startServer } = await import("@jixo/opendweb-server-binary");
    const httpBind = opt("--http", process.env.DWEB_HTTP_BIND ?? "0.0.0.0:8787");
    const relayBind = opt("--relay", process.env.DWEB_RELAY_HTTP_BIND ?? "0.0.0.0:3340");
    const relayEnabled = !process.argv.includes("--no-relay") &&
      (process.env.DWEB_RELAY_ENABLED ?? "true") !== "false";
    const server = await startServer({ httpBind, relayBind, relayEnabled });
    console.log(`opendweb server`);
    console.log(`  rendezvous : http://${httpBind} (/healthz)`);
    if (relayEnabled) console.log(`  relay      : http://${relayBind} (/healthz)`);
    console.log(`  Ctrl+C 停止`);
    const shutdown = () => {
      server.stop().finally(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await server.exited;
    return;
  }
  if (command === "help" || command === "--help") {
    console.log(`opendweb — 应用级组网

用法:
  opendweb server [--http <bind>] [--relay <bind>] [--no-relay]
      启动自托管服务端（rendezvous + relay），默认 0.0.0.0:8787 / 0.0.0.0:3340

组网体验（另开终端，使用 @jixo/opendweb-example）:
  export DWEB_RELAY=custom DWEB_RELAY_URLS=http://<本机IP>:3340
  opendweb-example init --data ~/.dweb-a && opendweb-example chat --data ~/.dweb-a
  opendweb-example join --data ~/.dweb-b <invite-token>  # 另一设备/目录
  opendweb-example chat --data ~/.dweb-b

服务器部署也可用 docker: ghcr.io/gaubee/dweb`);
    return;
  }
  console.error(`未知命令: ${command}（opendweb help 查看用法）`);
  process.exit(1);
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
