// Stages the app for a release: the web app built, the server bundled into one file (its workspace packages
// inlined, the npm packages left outside), and both laid out with the folders the server finds beside itself
// (presets, the node pack, its assets), under release/app. What is staged runs with `node app/apps/server/dist/index.mjs`
// once `npm install --omit=dev` has been run in app/ for the platform it runs on (that is the bundle script's and
// the Dockerfile's part: sharp has one native package per platform).
//
//   node scripts/release/stage.mjs                    → release/app, its package-lock.json resolved here
//   node scripts/release/stage.mjs --lock <file>      → with that package-lock.json instead (one staged before)
//   node scripts/release/stage.mjs --install          → and `npm ci --omit=dev` in it, for this platform
//
// A release resolves the lockfile once (the stage job of release.yml) and hands that one file to the image and
// to every bundle, so all of them install the same tree. It also writes THIRD_PARTY_NOTICES.txt: every
// package that ships, with its licence, from `pnpm licenses list --prod`, and the ffmpeg build the bundles and the image carry.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const out = join(root, "release", "app");
const argv = process.argv.slice(2);
const args = new Set(argv);
const lockAt = argv.includes("--lock") ? argv[argv.indexOf("--lock") + 1] : undefined;
if (argv.includes("--lock") && !lockAt) throw new Error("--lock needs the path of a package-lock.json");
const win = process.platform === "win32";
// on Windows corepack and npm are .cmd files, which Node only runs through the shell (the arguments here are fixed strings)
const run = (cmd, cmdArgs, cwd = root) => execFileSync(cmd, cmdArgs, { cwd, stdio: "inherit", shell: win });

console.log("[stage] web app");
run("corepack", ["pnpm", "exec", "vite", "build", "apps/web"]);

console.log("[stage] server bundle");
await build({
  entryPoints: [join(root, "apps/server/src/index.ts")],
  outfile: join(root, "apps/server/dist/index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // the workspace packages (@afflatus/*) are TypeScript sources: inlined; everything from npm stays outside, installed per platform
  plugins: [{
    name: "npm-external",
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        // only bare specifiers (not an entry, not a relative or absolute path, not a workspace package or node:) stay outside
        if (args.kind === "entry-point" || /^(\.|\/|[A-Za-z]:[\/])/.test(args.path) || args.path.startsWith("@afflatus/") || args.path.startsWith("node:")) return null;
        return { path: args.path, external: true };
      });
    },
  }],
  // a map beside the bundle, read by node's --enable-source-maps (the Dockerfile, the bundles' start scripts): a
  // stack logged by a user's server then names the source file and line, not a line of a 2 MB bundle
  sourcemap: "linked",
  legalComments: "none",
  banner: { js: "// Afflatus server, bundled. AGPL-3.0-only. Sources: https://github.com/bardak971/afflatus" },
  logLevel: "warning",
});

console.log("[stage] layout");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
// what a local run of ComfyUI or of the tests leaves in the tree does not ship
const skip = (path) => /(^|[\\/])(__pycache__|\.pytest_cache)([\\/]|$)|\.pyc$/.test(path);
const copy = (from, to = from) => {
  const src = join(root, from);
  if (!existsSync(src)) throw new Error(`missing: ${from}`);
  cpSync(src, join(out, to), { recursive: true, filter: (path) => !skip(path) });
};
copy("apps/server/dist");
copy("apps/server/assets");
copy("apps/web/dist");
copy("presets");
copy("comfy-nodes");
copy("LICENSE");

// the server's npm dependencies, at the exact versions the lockfile resolved: a package.json for `npm install --omit=dev`
const serverPkg = JSON.parse(readFileSync(join(root, "apps/server/package.json"), "utf8"));
const deps = {};
for (const name of Object.keys(serverPkg.dependencies)) {
  if (name.startsWith("@afflatus/")) continue;
  const installed = JSON.parse(readFileSync(join(root, "apps/server/node_modules", name, "package.json"), "utf8"));
  deps[name] = installed.version;
}
const version = process.env.AFFLATUS_VERSION?.trim() || JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
// a tag (v0.2.1, v0.3.0-rc.1), the package's own version (0.2.1), or "dev": it goes into files and the UI as is
if (!/^v?\d+\.\d+\.\d+(-[\w.]+)?$/.test(version) && version !== "dev") throw new Error(`AFFLATUS_VERSION ${JSON.stringify(version)} is not a version (v1.2.3 or v1.2.3-rc.1)`);
writeFileSync(join(out, "package.json"), JSON.stringify({ name: "afflatus", version, private: true, license: "AGPL-3.0-only", type: "module", dependencies: deps }, null, 2) + "\n");
writeFileSync(join(out, "VERSION"), version + "\n");
console.log(`[stage] ${Object.keys(deps).length} npm dependencies pinned:`, Object.entries(deps).map(([k, v]) => `${k}@${v}`).join(", "));

// the whole tree, transitive packages included, written down once: the Dockerfile and the bundle script then
// run `npm ci`, which installs exactly this and nothing newer. With --lock, the one a release staged before
// (so the image and every bundle install the same tree); else resolved here against the registry.
if (lockAt) {
  console.log(`[stage] package-lock.json from ${lockAt}`);
  const lock = JSON.parse(readFileSync(resolve(lockAt), "utf8"));
  const locked = lock.packages?.[""]?.dependencies ?? {};
  const same = Object.keys(deps).length === Object.keys(locked).length && Object.entries(deps).every(([k, v]) => locked[k] === v);
  if (!same) throw new Error(`${lockAt} was staged for other dependencies (${JSON.stringify(locked)}) than these (${JSON.stringify(deps)}): stage again without --lock`);
  lock.version = version;
  lock.packages[""].version = version;
  writeFileSync(join(out, "package-lock.json"), JSON.stringify(lock, null, 2) + "\n");
} else {
  console.log("[stage] package-lock.json");
  run("npm", ["install", "--package-lock-only", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], out);
}

// what ships of other people's code, with its licence: the server's npm packages and what the web bundle
// inlines (React, the icons, the router, the fonts). The licence files are copied whole: the MIT, BSD and ISC
// notices ask to travel with the code, the OFL to travel with the fonts.
console.log("[stage] THIRD_PARTY_NOTICES.txt");
const listed = JSON.parse(execFileSync("corepack", ["pnpm", "licenses", "list", "--prod", "--json"], { cwd: root, encoding: "utf8", shell: win, maxBuffer: 64 * 1024 * 1024 }));
const packages = Object.values(listed).flat().sort((a, b) => a.name.localeCompare(b.name));
const licenceText = (dir) => {
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)([.-]|$)/i.test(f)).sort() : [];
  return files.map((f) => readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n").trim()).join("\n\n");
};
const rule = "-".repeat(78);
// the ffmpeg the bundles and the image carry, read from where it is chosen rather than written a second time here: the tag
// from bundle.mjs, the build (its version and FFmpeg's commit) from Get ffmpeg's archive names, which ffmpegGet.test.ts holds
// to that tag and to checksums.json
const ffmpegTag = /const FFMPEG_TAG = "(autobuild-[\d-]+)";/.exec(readFileSync(join(root, "scripts/release/bundle.mjs"), "utf8"))?.[1];
const ffmpegBuild = /"ffmpeg-(n[\d.]+-\d+-g([0-9a-f]+))-linux64-gpl-[\d.]+\.tar\.xz"/.exec(readFileSync(join(root, "apps/server/src/ffmpegGet.ts"), "utf8"));
if (!ffmpegTag || !ffmpegBuild) throw new Error("the ffmpeg build could not be read from bundle.mjs's FFMPEG_TAG and ffmpegGet.ts's FFMPEG_BUILD, for THIRD_PARTY_NOTICES.txt");
const notices = [
  "Afflatus is free software under the GNU AGPL-3.0 (LICENSE). It ships the packages below, each under its own licence.",
  "The node pack in comfy-nodes/ carries its own LICENSE files; apps/server/assets/LICENSE-danbooru-tags covers the tag list.",
  "sharp's platform package (@img/sharp-*) carries libvips, under the LGPL-3.0-or-later.",
  "",
  `The Windows and Linux bundles and the Docker image carry ffmpeg and ffprobe, unmodified: FFmpeg ${ffmpegBuild[1]}, the GPL build`,
  `of BtbN's FFmpeg-Builds release ${ffmpegTag} (built with --enable-gpl --enable-version3, with the libraries it links in, such as`,
  "x264), under the GPL-3.0-or-later. Its licence is beside the binaries: versions/<version>/bin/LICENSE-ffmpeg.txt in a bundle,",
  "/usr/local/share/doc/ffmpeg/LICENSE.txt in the image (and bin/LICENSE-ffmpeg.txt in the data folder after Get ffmpeg).",
  `The source: FFmpeg's git (https://git.ffmpeg.org/ffmpeg.git) at commit ${ffmpegBuild[2]}, and the build scripts with the`,
  `libraries' versions at https://github.com/BtbN/FFmpeg-Builds, tag ${ffmpegTag}.`,
  "",
  ...packages.map((p) => `${p.name} ${p.versions.join(", ")}  ${p.license}${p.homepage ? `  ${p.homepage}` : ""}`),
  "",
  ...packages.flatMap((p) => {
    const text = p.paths.map(licenceText).find(Boolean);
    return [rule, `${p.name} ${p.versions.join(", ")} (${p.license})`, "", text || `No licence file in the package; its package.json says ${p.license}.`, ""];
  }),
];
writeFileSync(join(out, "THIRD_PARTY_NOTICES.txt"), notices.join("\n"));
console.log(`[stage] ${packages.length} packages in THIRD_PARTY_NOTICES.txt`);

if (args.has("--install")) {
  console.log("[stage] npm ci --omit=dev");
  run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], out);
}
console.log(`[stage] done: ${out}`);
