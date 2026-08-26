// @dweb/server-binary：以子进程方式启动 dweb-server，提供可等待的停止方式
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PLATFORM_BINARIES = {
  "darwin-arm64": "dweb-server-aarch64-apple-darwin",
  "win32-x64": "dweb-server-x86_64-pc-windows-msvc.exe",
};
const SUPPORTED = `${process.platform}-${process.arch}`;
const BINARY_NAME = PLATFORM_BINARIES[SUPPORTED];
if (!BINARY_NAME) {
  throw new Error(
    `@jixo/opendweb-server-binary: 当前平台 ${SUPPORTED} 暂不支持。v0.1 提供 ${Object.keys(PLATFORM_BINARIES).join(" / ")}；其它平台请使用 docker 镜像 ghcr.io/gaubee/dweb。`,
  );
}

/**
 * @typedef {Object} StartServerOptions
 * @property {string} [httpBind]   rendezvous/healthz 监听地址，默认 127.0.0.1:8787
 * @property {string} [relayBind]  relay HTTP 监听地址，默认 127.0.0.1:3340
 * @property {boolean} [relayEnabled] 默认 true
 */

/**
 * 启动 dweb-server 子进程。
 * @param {StartServerOptions} [options]
 * @returns {Promise<{ pid: number, httpUrl: string, relayHttpUrl: string, stop: () => Promise<void>, exited: Promise<number> }>}
 */
export async function startServer(options = {}) {
  const binDir = path.dirname(fileURLToPath(import.meta.url));
  const srcBin = path.join(binDir, "bin", BINARY_NAME);
  // SMB 网络磁盘上的原生二进制会触发 CODESIGNING Invalid Page：拷到私有 tmp 目录执行
  const buf = fs.readFileSync(srcBin);
  const hash = createHash("sha256").update(buf).digest("hex").slice(0, 24);
  let binPath = srcBin;
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opendweb-server-"));
    const dest = path.join(dir, hash);
    const fd = fs.openSync(dest, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o755);
    try {
      fs.writeFileSync(fd, buf);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    binPath = dest;
  } catch {
    binPath = srcBin; // 退回直接执行源路径
  }

  const httpBind = options.httpBind ?? "127.0.0.1:8787";
  const relayBind = options.relayBind ?? "127.0.0.1:3340";
  const env = {
    ...process.env,
    DWEB_HTTP_BIND: httpBind,
    DWEB_RELAY_HTTP_BIND: relayBind,
    DWEB_RELAY_ENABLED: options.relayEnabled === false ? "false" : "true",
  };

  const child = spawn(binPath, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  if (typeof child.pid !== "number") {
    throw new Error("failed to spawn dweb-server");
  }

  const exited = new Promise((resolve, reject) => {
    child.once("exit", (code) => resolve(code ?? 0));
    child.once("error", reject);
  });

  const stop = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill("SIGINT");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 5000).unref();
    });

  const httpUrl = `http://${httpBind}`;
  const relayHttpUrl = `http://${relayBind}`;
  return { pid: child.pid, httpUrl, relayHttpUrl, stop, exited };
}
