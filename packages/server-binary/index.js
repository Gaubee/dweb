// @dweb/server-binary：以子进程方式启动 dweb-server，提供可等待的停止方式。
// gateway 命名（design D1）：gatewayBind 为 canonical；
// 透传 DWEB_GATEWAY_BIND / DWEB_TRUST_PROXY 等环境变量。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PLATFORM_BINARIES = {
  "darwin-arm64": "dweb-server-aarch64-apple-darwin",
  "win32-x64": "dweb-server-x86_64-pc-windows.exe",
};
const SUPPORTED = `${process.platform}-${process.arch}`;
const BINARY_NAME = PLATFORM_BINARIES[SUPPORTED];
if (!BINARY_NAME) {
  throw new Error(
    `@jixo/opendweb-server-binary: platform ${SUPPORTED} is not supported yet. v0.2 ships ${Object.keys(PLATFORM_BINARIES).join(" / ")}; use the docker image ghcr.io/gaubee/dweb for other platforms.`,
  );
}

/**
 * @typedef {Object} StartServerOptions
 * @property {string} [gatewayBind] gateway（rendezvous/healthz/services.json）监听地址，默认 127.0.0.1:8787
 * @property {string} [relayBind]   relay HTTP 监听地址，默认 127.0.0.1:3340
 * @property {boolean} [relayEnabled] 默认 true
 * @property {boolean} [trustProxy]  true 时向子进程设置 DWEB_TRUST_PROXY=1（采信 X-Forwarded-Proto）；
 *                                   false 时设为 "0"；缺省时继承父进程环境
 */

/**
 * 启动 dweb-server 子进程。
 * @param {StartServerOptions} [options]
 * @returns {Promise<{ pid: number, gatewayUrl: string, httpUrl: string, relayHttpUrl: string, servicesUrl: string, stop: () => Promise<void>, exited: Promise<number> }>}
 */
export async function startServer(options = {}) {
  const binDir = path.dirname(fileURLToPath(import.meta.url));
  const srcBin = path.join(binDir, "bin", BINARY_NAME);
  // SMB 网络磁盘（开发机）上的原生二进制会触发 CODESIGNING Invalid Page：
  // darwin 拷到私有 tmp 内容寻址路径执行。Windows 无此问题且 tmp 无扩展名
  // 拷贝会被 Defender/路径解析干扰——直接执行源路径。
  let binPath = srcBin;
  if (process.platform === "darwin") {
    try {
      const buf = fs.readFileSync(srcBin);
      const hash = createHash("sha256").update(buf).digest("hex").slice(0, 24);
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
  }

  const gatewayBind = options.gatewayBind ?? "127.0.0.1:8787";
  const relayBind = options.relayBind ?? "127.0.0.1:3340";
  const env = {
    ...process.env,
    DWEB_GATEWAY_BIND: gatewayBind,
    DWEB_RELAY_HTTP_BIND: relayBind,
    DWEB_RELAY_ENABLED: options.relayEnabled === false ? "false" : "true",
  };
  if (options.trustProxy !== undefined) {
    env.DWEB_TRUST_PROXY = options.trustProxy ? "1" : "0";
  }

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

  const gatewayUrl = `http://${gatewayBind}`;
  const relayHttpUrl = `http://${relayBind}`;
  // httpUrl 为旧字段名保留（值同 gatewayUrl）
  return {
    pid: child.pid,
    gatewayUrl,
    httpUrl: gatewayUrl,
    relayHttpUrl,
    servicesUrl: `${gatewayUrl}/services.json`,
    stop,
    exited,
  };
}
