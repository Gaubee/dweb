// 平台感知的 release 二进制打包：从 cargo target 拷贝到包内 bin/。
// darwin: build host target 产物 dweb-server → bin/dweb-server-aarch64-apple-darwin
// windows: 优先复用 CI 已构建的 --target x86_64-pc-windows-msvc 产物（.exe）；
//          staging 已放好 bin/dweb-server-x86_64-pc-windows.exe 时直接通过。
import { spawnSync } from "node:child_process";
import { cpSync, chmodSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const binDir = path.join(pkgDir, "bin");
mkdirSync(binDir, { recursive: true });

function findWorkspaceRoot() {
  if (process.env.DWEB_ROOT) return process.env.DWEB_ROOT;
  let dir = pkgDir;
  for (let i = 0; i < 4; i++) {
    if (existsSync(path.join(dir, "Cargo.toml"))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

function resolveTargetDir() {
  const raw = process.env.CARGO_TARGET_DIR ?? path.join(process.env.HOME ?? "~", ".cargo-target", "dweb");
  return raw.replace(/^\$HOME/, process.env.HOME ?? "").replace(/^~/, process.env.HOME ?? "");
}

if (process.platform === "win32") {
  const staged = path.join(binDir, "dweb-server-x86_64-pc-windows.exe");
  if (existsSync(staged)) {
    console.log("packed(win): bin/dweb-server-x86_64-pc-windows.exe (staged)");
    process.exit(0);
  }
  // 本地 Windows 开发：构建 target 产物
  const root = findWorkspaceRoot();
  const targetDir = resolveTargetDir();
  const src = path.join(targetDir, "x86_64-pc-windows-msvc", "release", "dweb-server.exe");
  if (!existsSync(src)) {
    if (root) {
      const built = spawnSync("cargo", ["build", "--release", "--target", "x86_64-pc-windows-msvc", "-p", "dweb-server"], { stdio: "inherit", cwd: root });
      if (built.status !== 0) throw new Error("cargo build failed");
    }
    if (!existsSync(src)) {
      throw new Error(`windows binary not found at ${src} (no MSVC toolchain on non-windows hosts is expected; use CI staging)`);
    }
  }
  cpSync(src, staged);
  console.log(`packed(win): ${staged}`);
  process.exit(0);
}

// darwin（host build）
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

const targetDir = resolveTargetDir();
const src = path.join(targetDir, "release", "dweb-server");
if (!existsSync(src)) {
  throw new Error(`binary not found at ${src}`);
}
const dest = path.join(binDir, "dweb-server-aarch64-apple-darwin");
cpSync(src, dest);
chmodSync(dest, 0o755);
console.log("packed: bin/dweb-server-aarch64-apple-darwin");
