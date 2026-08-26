// 平台守卫 + 原生模块加载 + 事件解包：v0.1 仅 darwin-arm64。
// 加载策略：把 .node 拷贝到 os.tmpdir() 下的内容寻址新路径再 require——
// 规避网络磁盘（SMB）页缓存不一致导致的 CODESIGNING "Invalid Page"，
// 以及 dyld 对既有路径的坏闭包缓存（同名覆写后同字节仍加载失败）。
// 事件解包：原生层以 JSON 字符串投递事件（TSFN 对象转换在 napi 3.12 不稳定），
// 此处还原为带 Buffer 的类型化对象。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const SUPPORTED = `${process.platform}-${process.arch}`;
const EXPECTED = "darwin-arm64";

if (SUPPORTED !== EXPECTED) {
  throw new Error(
    `@dweb/client-sdk: 当前平台 ${SUPPORTED} 暂不支持。v0.1 仅提供 ${EXPECTED} 原生二进制；其它平台支持将在后续版本提供。`,
  );
}

const SRC = path.join(__dirname, "dweb.darwin-arm64.node");

function loadViaTmp() {
  const buf = fs.readFileSync(SRC);
  const hash = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 24);
  try {
    // 0700 私有目录规避可预测路径的 symlink/TOCTOU 窗口
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dweb-sdk-"));
    const dest = path.join(dir, `${hash}.node`);
    const fd = fs.openSync(dest, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o755);
    try {
      fs.writeFileSync(fd, buf);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return require(dest);
  } catch {
    return null;
  }
}

const Native = loadViaTmp() ?? require(SRC);

const nativeOn = Native.Fabric.prototype.on;
Native.Fabric.prototype.on = function onWrapped(callback) {
  // 原生 TSFN 为 error-first 回调：(err, jsonString)
  return nativeOn.call(this, (err, json) => {
    if (err) return;
    const ev = JSON.parse(json);
    if (typeof ev.dataBase64 === "string") {
      ev.data = Buffer.from(ev.dataBase64, "base64");
      delete ev.dataBase64;
    }
    callback(ev);
  });
};

module.exports = Native;
