// Packs a release for one platform out of release/app (see stage.mjs): a portable Node runtime, ffmpeg and
// ffprobe where a build can be redistributed (the LGPL builds for Windows and Linux; on macOS the start
// script points at Homebrew), the launcher, and the archive the GitHub release carries.
//
//   node scripts/release/bundle.mjs --platform win-x64|linux-x64|darwin-arm64 [--version 0.1.0] [--node 24]
//
// Runs on the platform it packs for (npm install resolves sharp's native package for the host).
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const platform = opt("platform", { win32: "win-x64", linux: "linux-x64", darwin: "darwin-arm64" }[process.platform]);
const version = opt("version", process.env.AFFLATUS_VERSION?.trim() || "dev");
const nodeMajor = opt("node", "24");
if (!["win-x64", "linux-x64", "darwin-arm64"].includes(platform)) throw new Error(`unknown platform ${platform}`);

const app = join(root, "release", "app");
if (!existsSync(join(app, "apps/server/dist/index.mjs"))) throw new Error("run scripts/release/stage.mjs first");
const dist = join(root, "release", "dist");
const name = `afflatus-${version}-${platform}`;
const bundle = join(root, "release", "bundle", name);
rmSync(bundle, { recursive: true, force: true });
mkdirSync(bundle, { recursive: true });
mkdirSync(dist, { recursive: true });
const win = process.platform === "win32";
const run = (cmd, args, cwd = bundle) => execFileSync(cmd, args, { cwd, stdio: "inherit", shell: win });
/** A zip opened or made with PowerShell on Windows (the tar at hand may be Git's, which knows no zip); tar elsewhere. */
const ps = (command) => execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", command], { stdio: "inherit" });
const unpack = (archive, dest) => {
  if (archive.endsWith(".zip")) {
    if (win) ps(`Expand-Archive -LiteralPath '${archive}' -DestinationPath '${dest}' -Force`);
    else run("unzip", ["-q", archive, "-d", dest], root);
  } else run("tar", [archive.endsWith(".xz") ? "-xJf" : "-xzf", archive, "-C", dest], root);
};
const pack = (dir, name, archive) => {
  if (archive.endsWith(".zip")) {
    if (win) ps(`Compress-Archive -LiteralPath '${join(dir, name)}' -DestinationPath '${archive}' -CompressionLevel Optimal -Force`);
    else run("zip", ["-qr", archive, name], dir);
  } else run("tar", ["-czf", archive, name], dir);
};
const fetchTo = async (url, file) => {
  console.log(`[bundle] fetching ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
};

// 1. the app, with its npm dependencies for this platform
console.log("[bundle] app");
cpSync(app, join(bundle, "app"), { recursive: true });
run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], join(bundle, "app"));

// 2. a portable Node: the newest release of the major asked for, from nodejs.org
console.log("[bundle] node runtime");
const index = await (await fetch("https://nodejs.org/dist/index.json")).json();
const node = index.find((v) => v.version.startsWith(`v${nodeMajor}.`));
if (!node) throw new Error(`no Node ${nodeMajor} release listed`);
const nodeName = `node-${node.version}-${platform === "win-x64" ? "win-x64" : platform === "linux-x64" ? "linux-x64" : "darwin-arm64"}`;
const nodeArchive = join(root, "release", `${nodeName}.${platform === "win-x64" ? "zip" : "tar.gz"}`);
if (!existsSync(nodeArchive)) await fetchTo(`https://nodejs.org/dist/${node.version}/${nodeName}.${platform === "win-x64" ? "zip" : "tar.gz"}`, nodeArchive);
const tmp = join(root, "release", "tmp-node");
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
unpack(nodeArchive, tmp);
renameSync(join(tmp, nodeName), join(bundle, "node"));
// the runtime alone: npm and its docs are not needed to run
for (const extra of ["node_modules", "npm", "npx", "npm.cmd", "npx.cmd", "corepack", "corepack.cmd", "CHANGELOG.md", "README.md", "include", "share"]) rmSync(join(bundle, "node", extra), { recursive: true, force: true });
rmSync(join(bundle, "node", "lib", "node_modules"), { recursive: true, force: true });
rmSync(join(bundle, "node", "bin", "npm"), { force: true });
rmSync(join(bundle, "node", "bin", "npx"), { force: true });
rmSync(join(bundle, "node", "bin", "corepack"), { force: true });

// 3. ffmpeg and ffprobe: BtbN's LGPL builds (redistributable); macOS has none, the launcher says what to install
mkdirSync(join(bundle, "bin"), { recursive: true });
if (platform !== "darwin-arm64") {
  console.log("[bundle] ffmpeg (LGPL)");
  const asset = platform === "win-x64" ? "ffmpeg-master-latest-win64-lgpl.zip" : "ffmpeg-master-latest-linux64-lgpl.tar.xz";
  const archive = join(root, "release", asset);
  if (!existsSync(archive)) await fetchTo(`https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/${asset}`, archive);
  const ftmp = join(root, "release", "tmp-ffmpeg");
  rmSync(ftmp, { recursive: true, force: true });
  mkdirSync(ftmp, { recursive: true });
  unpack(archive, ftmp);
  const inner = readdirSync(ftmp).find((d) => d.startsWith("ffmpeg"));
  for (const tool of ["ffmpeg", "ffprobe"]) {
    const exe = platform === "win-x64" ? `${tool}.exe` : tool;
    cpSync(join(ftmp, inner, "bin", exe), join(bundle, "bin", exe));
    if (platform !== "win-x64") chmodSync(join(bundle, "bin", exe), 0o755);
  }
  cpSync(join(ftmp, inner, "LICENSE.txt"), join(bundle, "bin", "LICENSE-ffmpeg.txt"), { force: true });
  rmSync(ftmp, { recursive: true, force: true });
}

// 4. the launcher
console.log("[bundle] launcher");
if (platform === "win-x64") {
  writeFileSync(join(bundle, "Afflatus.bat"), [
    "@echo off",
    "setlocal",
    'cd /d "%~dp0"',
    'set "PATH=%~dp0bin;%PATH%"',
    'if "%DATA_DIR%"=="" set "DATA_DIR=%~dp0data"',
    'if "%PORT%"=="" set "PORT=8720"',
    `set "AFFLATUS_VERSION=${version}"`,
    "echo Afflatus %AFFLATUS_VERSION% - http://127.0.0.1:%PORT%  (close this window to stop it)",
    'start "" /b cmd /c "timeout /t 3 >nul & start "" http://127.0.0.1:%PORT%"',
    '"%~dp0node\\node.exe" "%~dp0app\\apps\\server\\dist\\index.mjs"',
    "if errorlevel 1 pause",
    "",
  ].join("\r\n"));
} else {
  const mac = platform === "darwin-arm64";
  writeFileSync(join(bundle, "afflatus.sh"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'cd "$(dirname "$0")"',
    'export PATH="$PWD/bin:$PATH"',
    'export DATA_DIR="${DATA_DIR:-$PWD/data}"',
    'export PORT="${PORT:-8720}"',
    `export AFFLATUS_VERSION="${version}"`,
    ...(mac ? [
      'if ! command -v ffmpeg >/dev/null 2>&1; then',
      '  echo "ffmpeg is not installed: trims, exports and video previews need it. Install it with:  brew install ffmpeg"',
      'fi',
      'xattr -dr com.apple.quarantine node 2>/dev/null || true',
    ] : []),
    'echo "Afflatus $AFFLATUS_VERSION - http://127.0.0.1:$PORT  (Ctrl+C stops it)"',
    `(sleep 3; ${mac ? "open" : "xdg-open"} "http://127.0.0.1:$PORT" >/dev/null 2>&1 || true) &`,
    'exec "$PWD/node/bin/node" "$PWD/app/apps/server/dist/index.mjs"',
    "",
  ].join("\n"));
  chmodSync(join(bundle, "afflatus.sh"), 0o755);
}
writeFileSync(join(bundle, "README.txt"), [
  `Afflatus ${version} for ${platform}`,
  "",
  platform === "win-x64" ? "Double-click Afflatus.bat. Your browser opens on http://127.0.0.1:8720." : "Run ./afflatus.sh. Your browser opens on http://127.0.0.1:8720.",
  "First, in Settings, give it the address of your ComfyUI (http://127.0.0.1:8188 when it runs on this computer).",
  "Your data (library, settings, timelines) lives in the data folder next to this file. To update, unpack the next release over this one; the data folder stays.",
  platform === "darwin-arm64" ? "ffmpeg is needed for trims, exports and video previews: brew install ffmpeg" : "ffmpeg and ffprobe (LGPL builds by BtbN) are in bin/.",
  "",
  "Afflatus is free software under the AGPL-3.0: https://github.com/bardak971/afflatus",
  "",
].join("\n"));

// 5. the archive
console.log("[bundle] archive");
const archive = join(dist, platform === "win-x64" ? `${name}.zip` : `${name}.tar.gz`);
rmSync(archive, { force: true });
pack(join(root, "release", "bundle"), name, archive);
rmSync(tmp, { recursive: true, force: true });
console.log(`[bundle] done: ${archive}`);
