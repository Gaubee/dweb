#!/usr/bin/env node
// dweb-server CLI 入口：转发参数与信号到平台二进制
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const binDir = path.dirname(fileURLToPath(import.meta.url));

const PLATFORM_BINARIES = {
  "darwin-arm64": "dweb-server-aarch64-apple-darwin",
  "win32-x64": "dweb-server-x86_64-pc-windows.exe",
};
const SUPPORTED = `${process.platform}-${process.arch}`;
const BINARY_NAME = PLATFORM_BINARIES[SUPPORTED];
if (!BINARY_NAME) {
  console.error(
    `@jixo/opendweb-server-binary: 当前平台 ${SUPPORTED} 暂不支持。v0.1 提供 ${Object.keys(PLATFORM_BINARIES).join(" / ")}；其它平台请使用 docker 镜像 ghcr.io/gaubee/dweb。`,
  );
  process.exit(1);
}

const binPath = path.join(binDir, BINARY_NAME);
const child = spawn(binPath, process.argv.slice(2), {
  stdio: "inherit",
  env: process.env,
});

const forward = (sig) => () => {
  if (!child.killed) child.kill(sig);
};
process.on("SIGINT", forward("SIGINT"));
process.on("SIGTERM", forward("SIGTERM"));
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
