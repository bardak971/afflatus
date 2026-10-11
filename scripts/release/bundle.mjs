// Packs a release for one platform out of release/app (see stage.mjs): a portable Node runtime, ffmpeg and
// ffprobe where a build can be redistributed (the LGPL builds for Windows and Linux; on macOS the start
// script points at Homebrew), the launchers, and the archive the GitHub release carries.
//
// The archive holds one folder, Afflatus/, laid out the way an install updates itself (HANDOVER-updater.md):
//
//   Afflatus/Afflatus.bat, afflatus.sh       the launchers: start versions/current, again on exit code 75
//   Afflatus/versions/current                one line, the version to start (0.4.0)
//   Afflatus/versions/0.4.0/{node,app,bin}   that version: its Node, the app with its launch.mjs, ffmpeg
//
// data/ is made beside versions/ at the first start; an update adds a version folder and rewrites current.
//
//   node scripts/release/bundle.mjs --platform win-x64|linux-x64|darwin-arm64 [--version v0.2.1] [--ffmpeg autobuild-…] [--record]
//                                   [--release-key <public key, base64>]
//
// --release-key is for trying the updates end to end with a throwaway key (two local bundles, a pretend release
// server): the bundle's server then trusts that key instead of the one in apps/server/src/releaseKey.ts. It is written
// into this bundle's own copy of the server at build time, never read from the environment or a file at run time, so
// that nothing a user or another program sets on an installed Afflatus can change the key its updates are checked
// with. The release workflow never passes it.
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
/** The version's folder under versions/ and its line in versions/current: the tag without its "v" (0.4.0, 0.4.0-rc.1). */
const folder = version.replace(/^v/, "");
const ffmpegTag = opt("ffmpeg", FFMPEG_TAG);
const record = argv.includes("--record");
const releaseKey = opt("release-key", null);
// a key that is not 32 bytes of base64 would make every update refused: said now rather than found in the app
if (releaseKey !== null && Buffer.from(releaseKey, "base64").length !== 32) throw new Error("--release-key is not an Ed25519 public key (32 bytes of base64)");
if (!["win-x64", "linux-x64", "darwin-arm64"].includes(platform)) throw new Error(`unknown platform ${platform}`);
if (!/^v\d+\.\d+\.\d+$/.test(NODE_VERSION)) throw new Error(`NODE_VERSION must be an exact release (v24.x.y), not ${JSON.stringify(NODE_VERSION)}`);

const app = join(root, "release", "app");
if (!existsSync(join(app, "apps/server/dist/index.mjs"))) throw new Error("run scripts/release/stage.mjs first");
if (!existsSync(join(app, "package-lock.json"))) throw new Error("release/app has no package-lock.json: run scripts/release/stage.mjs again (it writes one)");
// launch.mjs tells the server the staged version (the one the web page was built with): it must be this one
const staged = readFileSync(join(app, "VERSION"), "utf8").trim();
if (version !== "dev" && staged !== version) throw new Error(`release/app was staged as ${staged}, not ${version}: stage again with AFFLATUS_VERSION=${version}`);
const dist = join(root, "release", "dist");
const name = `afflatus-${version}-${platform}`;
const parent = join(root, "release", "bundle", name);
const top = join(parent, "Afflatus");
// the version's folder, where the app, its node and its ffmpeg go
const bundle = join(top, "versions", folder);
rmSync(parent, { recursive: true, force: true });
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
/**
 * The zip is written entry by entry, not with Compress-Archive: Windows PowerShell's writes its names with "\"
 * and in the local code page, and the tar Windows ships (which an Afflatus updating itself unpacks with) then
 * refuses a name such as "snow ☃" in an npm package's test files. Here the names take "/" and UTF-8.
 */
const zipScript = (src, name, archive) => [
  "Add-Type -AssemblyName System.IO.Compression.FileSystem",
  `$src = (Resolve-Path -LiteralPath '${src}').Path.TrimEnd('\\')`,
  `$zip = [IO.Compression.ZipFile]::Open('${archive}', 'Create', [Text.Encoding]::UTF8)`,
  "try {",
  "  Get-ChildItem -LiteralPath $src -Recurse -File -Force | ForEach-Object {",
  `    $entry = '${name}/' + $_.FullName.Substring($src.Length + 1).Replace('\\', '/')`,
  "    [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $entry, [IO.Compression.CompressionLevel]::Optimal)",
  "  }",
  "} finally { $zip.Dispose() }",
].join("\n");
const pack = (dir, name, archive) => {
  if (archive.endsWith(".zip")) {
    if (win) ps(zipScript(join(dir, name), name, archive));
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
// npm packages' files whose names are not plain ASCII (@fastify/send's test fixture "snow ☃") are left out: the
// tar Windows ships, which an Afflatus updating itself unpacks with, cannot name them and fails the whole unpack.
// Nothing runs from them
const sweep = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (/[^\x20-\x7e]/.test(entry.name)) {
      console.log(`[bundle] left out, a name the Windows tar cannot unpack: ${path}`);
      rmSync(path, { recursive: true, force: true });
    } else if (entry.isDirectory()) sweep(path);
  }
};
sweep(join(bundle, "app", "node_modules"));
// the version's own start (its environment, the restart and the fall back), updated with the app
cpSync(join(here, "launch.mjs"), join(bundle, "app", "launch.mjs"));
if (releaseKey !== null) {
  // the key's one literal in the bundled server, swapped in this bundle's copy only (release/app keeps the real one)
  const builtIn = /RELEASE_KEY = "([^"]+)"/.exec(readFileSync(join(root, "apps/server/src/releaseKey.ts"), "utf8"))?.[1];
  const server = join(bundle, "app", "apps", "server", "dist", "index.mjs");
  const code = readFileSync(server, "utf8");
  const found = builtIn ? code.split(`"${builtIn}"`).length - 1 : 0;
  if (found !== 1) throw new Error(`the release key is found ${found} times in the bundled server, not once: --release-key cannot be written in`);
  writeFileSync(server, code.replace(`"${builtIn}"`, () => JSON.stringify(releaseKey)));
  console.log(`[bundle] this bundle trusts the release key ${releaseKey}, NOT the one in releaseKey.ts: for tests only`);
}

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

// 4. the launchers, versions/current and the README. The launchers stay this small and never change once
// unpacked (cmd reads a running .bat from disk as it goes): the rest is in the version's launch.mjs. Both go into
// every archive, as the layout is the same everywhere.
console.log("[bundle] launchers");
writeFileSync(join(top, "versions", "current"), folder);
writeFileSync(join(top, "Afflatus.bat"), [
  "@echo off",
  "setlocal",
  'cd /d "%~dp0"',
  ":start",
  'set "AFFLATUS_V="',
  'for /f "usebackq delims=" %%v in ("versions\\current") do if not defined AFFLATUS_V set "AFFLATUS_V=%%v"',
  'if not defined AFFLATUS_V (echo versions\\current names no version to start. & pause & exit /b 1)',
  '"versions\\%AFFLATUS_V%\\node\\node.exe" "versions\\%AFFLATUS_V%\\app\\launch.mjs" %*',
  "if %errorlevel%==75 goto start",
  "if errorlevel 1 pause",
  "",
].join("\r\n"));
writeFileSync(join(top, "afflatus.sh"), [
  "#!/usr/bin/env bash",
  'cd "$(dirname "$0")" || exit 1',
  ...(platform === "darwin-arm64" ? [
    'if ! command -v ffmpeg >/dev/null 2>&1; then',
    '  echo "ffmpeg is not installed: trims, exports and video previews need it. Install it with:  brew install ffmpeg"',
    'fi',
    'xattr -dr com.apple.quarantine versions 2>/dev/null || true',
  ] : []),
  "while :; do",
  `  v="$(head -n 1 versions/current | tr -d '[:space:]')"`,
  '  [ -n "$v" ] || { echo "versions/current names no version to start."; exit 1; }',
  '  node="versions/$v/node/bin/node"',
  '  [ -x "$node" ] || node="versions/$v/node/node.exe"',
  '  "$node" "versions/$v/app/launch.mjs" "$@"',
  "  code=$?",
  '  [ "$code" -eq 75 ] || exit "$code"',
  "done",
  "",
].join("\n"));
chmodSync(join(top, "afflatus.sh"), 0o755);
writeFileSync(join(top, "README.txt"), [
  `Afflatus ${version} for ${platform}`,
  "",
  platform === "win-x64" ? "Double-click Afflatus.bat. Your browser opens on http://127.0.0.1:8720." : "Run ./afflatus.sh. Your browser opens on http://127.0.0.1:8720.",
  "First, in Settings, give it the address of your ComfyUI (http://127.0.0.1:8188 when it runs on this computer).",
  "Your data (library, settings, timelines) lives in the data folder next to this file, made at the first start.",
  "Afflatus updates itself: Settings > About says when a release is out and installs it. The releases it has are in",
  "versions/: the one it runs, and the one before it to go back to.",
  "Coming from 0.3.0: unpack this beside the old folder and start it; it offers to bring your library over.",
  platform === "darwin-arm64" ? "ffmpeg is needed for trims, exports and video previews: brew install ffmpeg" : `ffmpeg and ffprobe (LGPL builds by BtbN) are in versions/${folder}/bin/, with their build named in VERSIONS.txt there.`,
  "",
  "Afflatus is free software under the AGPL-3.0: https://github.com/bardak971/afflatus",
  `The other people's code it ships, and their licences, are listed in versions/${folder}/app/THIRD_PARTY_NOTICES.txt.`,
  "",
].join("\n"));

// 5. the archive
console.log("[bundle] archive");
const archive = join(dist, platform === "win-x64" ? `${name}.zip` : `${name}.tar.gz`);
rmSync(archive, { force: true });
pack(parent, "Afflatus", archive);
rmSync(tmp, { recursive: true, force: true });
console.log(`[bundle] done: ${archive}`);
