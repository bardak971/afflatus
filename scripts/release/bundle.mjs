// Packs a release for one platform out of release/app (see stage.mjs): a portable Node runtime, ffmpeg and
// ffprobe where a build can be redistributed (the LGPL builds for Windows and Linux; on macOS the start
// script points at Homebrew), the launcher, and the archive the GitHub release carries.
//
//   node scripts/release/bundle.mjs --platform win-x64|linux-x64|darwin-arm64 [--version v0.2.1] [--ffmpeg autobuild-…] [--record]
//
// Runs on the platform it packs for (npm ci resolves sharp's native package for the host). Everything it
// downloads is one exact release, checked against a SHA-256 before it is unpacked: Node against nodejs.org's
// SHASUMS256.txt, ffmpeg against the BtbN release's checksums.sha256 or, when a release has none, against
// checksums.json beside this script (--record writes the entry the first time a tag is used).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Node the bundles run on: one exact release, the newest of major 24 when it was last bumped (the
 * Dockerfile runs on node:24 too). To bump: take the version from https://nodejs.org/dist/index.json and set
 * it here; the checksum comes from nodejs.org at run time.
 */
const NODE_VERSION = "v24.21.0";
/**
 * The ffmpeg the Windows and Linux bundles carry: the 9.0 release-branch build (LGPL) of one dated BtbN autobuild, not
 * the rolling "latest". A tag from https://github.com/BtbN/FFmpeg-Builds/releases, of the form
 * autobuild-YYYY-MM-DD-HH-MM; the script refuses to run while this is empty, and --ffmpeg names one for a run.
 */
const FFMPEG_TAG = "autobuild-2026-10-04-20-51";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const platform = opt("platform", { win32: "win-x64", linux: "linux-x64", darwin: "darwin-arm64" }[process.platform]);
const version = opt("version", process.env.AFFLATUS_VERSION?.trim() || "dev");
// the version names files and is written into the launchers: a tag (v1.2.3, v1.2.3-rc.1) or "dev", nothing else
if (!/^v\d+\.\d+\.\d+(-[\w.]+)?$/.test(version) && version !== "dev") throw new Error(`--version ${JSON.stringify(version)} is not a release tag (v1.2.3 or v1.2.3-rc.1)`);
/** The version inside a .bat `set "X=…"` (% doubled, no quote) and inside a POSIX single-quoted string. */
const batVersion = version.replace(/%/g, "%%").replace(/"/g, "");
const shVersion = `'${version.replace(/'/g, "'\\''")}'`;
const ffmpegTag = opt("ffmpeg", FFMPEG_TAG);
const record = argv.includes("--record");
if (!["win-x64", "linux-x64", "darwin-arm64"].includes(platform)) throw new Error(`unknown platform ${platform}`);
if (!/^v\d+\.\d+\.\d+$/.test(NODE_VERSION)) throw new Error(`NODE_VERSION must be an exact release (v24.x.y), not ${JSON.stringify(NODE_VERSION)}`);

const app = join(root, "release", "app");
if (!existsSync(join(app, "apps/server/dist/index.mjs"))) throw new Error("run scripts/release/stage.mjs first");
if (!existsSync(join(app, "package-lock.json"))) throw new Error("release/app has no package-lock.json: run scripts/release/stage.mjs again (it writes one)");
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

// ---- downloads, each checked against a SHA-256 before it counts
const headers = process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
const get = async (url, init = {}) => {
  const res = await fetch(url, { redirect: "follow", ...init });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return res;
};
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
/** "<hex>  <name>" lines (SHASUMS256.txt, checksums.sha256) → { name: hex }. */
const parseSums = (text) => Object.fromEntries([...text.matchAll(/^([0-9a-f]{64})\s+\*?(\S+)\s*$/gim)].map((m) => [m[2].replace(/^.*\//, ""), m[1].toLowerCase()]));
/**
 * The archive at `file`, downloaded from `url` unless a copy with the right checksum is already there. The
 * download goes to a temporary name and is renamed only once its checksum matches: a cut-off or tampered
 * archive is never unpacked, and never reused on the next run either.
 */
const fetchChecked = async (url, file, expected) => {
  if (existsSync(file)) {
    if (sha256(file) === expected) {
      console.log(`[bundle] ${file} is there and checks out`);
      return;
    }
    console.log(`[bundle] ${file} does not match its checksum: fetching again`);
    rmSync(file, { force: true });
  }
  console.log(`[bundle] fetching ${url}`);
  const part = `${file}.part`;
  rmSync(part, { force: true });
  writeFileSync(part, Buffer.from(await (await get(url)).arrayBuffer()));
  const got = sha256(part);
  if (got !== expected) {
    rmSync(part, { force: true });
    throw new Error(`${url}: SHA-256 ${got} is not the ${expected} expected`);
  }
  renameSync(part, file);
};

// 1. the app, with its npm dependencies for this platform, exactly as the staging resolved them
console.log("[bundle] app");
cpSync(app, join(bundle, "app"), { recursive: true });
run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], join(bundle, "app"));

// 2. a portable Node: the one release named above, from nodejs.org, checked against its SHASUMS256.txt
console.log(`[bundle] node runtime ${NODE_VERSION}`);
const nodeName = `node-${NODE_VERSION}-${platform === "win-x64" ? "win-x64" : platform === "linux-x64" ? "linux-x64" : "darwin-arm64"}`;
const nodeFile = `${nodeName}.${platform === "win-x64" ? "zip" : "tar.gz"}`;
const nodeSums = parseSums(await (await get(`https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`)).text());
if (!nodeSums[nodeFile]) throw new Error(`nodejs.org lists no ${nodeFile} for ${NODE_VERSION}`);
const nodeArchive = join(root, "release", nodeFile);
await fetchChecked(`https://nodejs.org/dist/${NODE_VERSION}/${nodeFile}`, nodeArchive, nodeSums[nodeFile]);
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

// 3. ffmpeg and ffprobe: one dated BtbN LGPL build (redistributable); macOS has none, the launcher says what to install
mkdirSync(join(bundle, "bin"), { recursive: true });
if (platform !== "darwin-arm64") {
  if (!ffmpegTag) throw new Error("no ffmpeg build is named: set FFMPEG_TAG in scripts/release/bundle.mjs to a dated BtbN release tag (autobuild-YYYY-MM-DD-HH-MM, from https://github.com/BtbN/FFmpeg-Builds/releases), or pass --ffmpeg <tag>. The rolling \"latest\" build is not used: a release carries one known ffmpeg.");
  if (!/^autobuild-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}$/.test(ffmpegTag)) throw new Error(`${ffmpegTag} is not a BtbN autobuild tag (autobuild-YYYY-MM-DD-HH-MM)`);
  console.log(`[bundle] ffmpeg (LGPL, BtbN ${ffmpegTag})`);
  // the release's files are listed through the API: a build's name carries its git revision, so it cannot be spelled out here
  const release = await (await get(`https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/tags/${ffmpegTag}`, { headers: { Accept: "application/vnd.github+json", ...headers } })).json();
  const assets = release.assets ?? [];
  // the 9.0 release branch (n9.0.x), not the master nightly: a release ships an ffmpeg that is itself a release
  const wanted = platform === "win-x64" ? /^ffmpeg-n9\.0[\w.-]*-win64-lgpl-9\.0\.zip$/ : /^ffmpeg-n9\.0[\w.-]*-linux64-lgpl-9\.0\.tar\.xz$/;
  const asset = assets.find((a) => wanted.test(a.name));
  if (!asset) throw new Error(`BtbN release ${ffmpegTag} has no 9.0 LGPL build for ${platform} among: ${assets.map((a) => a.name).join(", ") || "nothing"}`);
  // the checksum: the release's own list when it has one; else the one written down here the first time (--record)
  const sumsFile = join(here, "checksums.json");
  const sums = JSON.parse(readFileSync(sumsFile, "utf8"));
  const listed = assets.find((a) => a.name === "checksums.sha256");
  let expected = listed ? parseSums(await (await get(listed.browser_download_url, { headers })).text())[asset.name] : sums.sha256[asset.name];
  if (listed && !expected) throw new Error(`${ffmpegTag}'s checksums.sha256 does not list ${asset.name}`);
  const archive = join(root, "release", asset.name);
  if (!expected) {
    if (!record) throw new Error(`${ffmpegTag} carries no checksums.sha256 and scripts/release/checksums.json has no entry for ${asset.name}: run once with --record to write its SHA-256 down, then commit checksums.json`);
    console.log(`[bundle] fetching ${asset.browser_download_url} (recording its checksum)`);
    const part = `${archive}.part`;
    rmSync(part, { force: true });
    writeFileSync(part, Buffer.from(await (await get(asset.browser_download_url, { headers })).arrayBuffer()));
    expected = sha256(part);
    rmSync(archive, { force: true });
    renameSync(part, archive);
    sums.sha256[asset.name] = expected;
    writeFileSync(sumsFile, JSON.stringify(sums, null, 2) + "\n");
    console.log(`[bundle] recorded ${asset.name} ${expected} in checksums.json`);
  }
  await fetchChecked(asset.browser_download_url, archive, expected);
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
  writeFileSync(join(bundle, "bin", "VERSIONS.txt"), `ffmpeg and ffprobe: BtbN FFmpeg-Builds ${ffmpegTag}, ${asset.name} (SHA-256 ${expected})\nnode: ${NODE_VERSION}\n`);
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
    `set "AFFLATUS_VERSION=${batVersion}"`,
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
    `export AFFLATUS_VERSION=${shVersion}`,
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
  platform === "darwin-arm64" ? "ffmpeg is needed for trims, exports and video previews: brew install ffmpeg" : "ffmpeg and ffprobe (LGPL builds by BtbN) are in bin/, with their build named in bin/VERSIONS.txt.",
  "",
  "Afflatus is free software under the AGPL-3.0: https://github.com/bardak971/afflatus",
  "The other people's code it ships, and their licences, are listed in app/THIRD_PARTY_NOTICES.txt.",
  "",
].join("\n"));

// 5. the archive
console.log("[bundle] archive");
const archive = join(dist, platform === "win-x64" ? `${name}.zip` : `${name}.tar.gz`);
rmSync(archive, { force: true });
pack(join(root, "release", "bundle"), name, archive);
rmSync(tmp, { recursive: true, force: true });
console.log(`[bundle] done: ${archive}`);
