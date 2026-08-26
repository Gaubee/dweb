// 从 cargo target 拷贝 darwin-arm64 release 二进制到包内 bin/
import { spawnSync } from "node:child_process";
import { cpSync, chmodSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const binDir = path.join(pkgDir, "bin");
mkdirSync(binDir, { recursive: true });

// workspace root：env 覆盖 > 向上探测含 Cargo.toml 的目录；找不到则跳过 build（复用已有产物）
function findWorkspaceRoot() {
  if (process.env.DWEB_ROOT) return process.env.DWEB_ROOT;
  let dir = pkgDir;
  for (let i = 0; i < 4; i++) {
    if (existsSync(path.join(dir, "Cargo.toml"))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

const root = findWorkspaceRoot();
if (root) {
  const built = spawnSync("cargo", ["build", "--release", "-p", "dweb-server"], {
    stdio: "inherit",
    cwd: root,
  });
  if (built.status !== 0) {
    throw new Error("cargo build failed");
  }
}

const rawTarget = process.env.CARGO_TARGET_DIR ?? path.join(process.env.HOME ?? "~", ".cargo-target", "dweb");
// CI env 可能携带未展开的 $HOME/~/ 字面量
const targetDir = rawTarget
  .replace(/^\$HOME/, process.env.HOME ?? "")
  .replace(/^~/, process.env.HOME ?? "");
const src = path.join(targetDir, "release", "dweb-server");
if (!existsSync(src)) {
  throw new Error(`binary not found at ${src}`);
}
const dest = path.join(binDir, "dweb-server-aarch64-apple-darwin");
cpSync(src, dest);
chmodSync(dest, 0o755);
console.log("packed: bin/dweb-server-aarch64-apple-darwin");
