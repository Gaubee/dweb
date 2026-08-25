// @dweb/server-binary：以子进程方式启动 dweb-server，提供可等待的停止方式
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SUPPORTED = `${process.platform}-${process.arch}`;
const EXPECTED = "darwin-arm64";
if (SUPPORTED !== EXPECTED) {
  throw new Error(
    `@dweb/server-binary: 当前平台 ${SUPPORTED} 暂不支持。v0.1 仅提供 ${EXPECTED} 二进制；服务器部署请使用 docker 镜像 ghcr.io/gaubee/dweb。`,
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
  const srcBin = path.join(binDir, "bin", "dweb-server-aarch64-apple-darwin");
  // SMB 网络磁盘上的原生二进制会触发 CODESIGNING Invalid Page：拷到 tmp 内容寻址新路径执行
  const buf = fs.readFileSync(srcBin);
  const hash = createHash("sha256").update(buf).digest("hex").slice(0, 24);
  const binPath = path.join(os.tmpdir(), `dweb-server-${hash}`);
  try {
    fs.rmSync(binPath, { force: true });
    fs.writeFileSync(binPath, buf, { mode: 0o755 });
  } catch {
    // 退回直接执行
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
