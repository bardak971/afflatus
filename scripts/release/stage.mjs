// Stages the app for a release: the web app built, the server bundled into one file (its workspace packages
// inlined, the npm packages left outside), and both laid out with the folders the server finds beside itself
// (presets, the node pack, its assets), under release/app. What is staged runs with `node app/apps/server/dist/index.mjs`
// once `npm install --omit=dev` has been run in app/ for the platform it runs on (that is the bundle script's and
// the Dockerfile's part: sharp has one native package per platform).
//
//   node scripts/release/stage.mjs            → release/app
//   node scripts/release/stage.mjs --install  → and `npm install --omit=dev` in it, for this platform
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const out = join(root, "release", "app");
const args = new Set(process.argv.slice(2));
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
  sourcemap: false,
  legalComments: "none",
  banner: { js: "// Afflatus server, bundled. AGPL-3.0-only. Sources: https://github.com/bardak971/afflatus" },
  logLevel: "warning",
});

console.log("[stage] layout");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const copy = (from, to = from) => {
  const src = join(root, from);
  if (!existsSync(src)) throw new Error(`missing: ${from}`);
  cpSync(src, join(out, to), { recursive: true });
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
writeFileSync(join(out, "package.json"), JSON.stringify({ name: "afflatus", version, private: true, license: "AGPL-3.0-only", type: "module", dependencies: deps }, null, 2) + "\n");
writeFileSync(join(out, "VERSION"), version + "\n");
console.log(`[stage] ${Object.keys(deps).length} npm dependencies pinned:`, Object.entries(deps).map(([k, v]) => `${k}@${v}`).join(", "));

if (args.has("--install")) {
  console.log("[stage] npm install --omit=dev");
  run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], out);
}
console.log(`[stage] done: ${out}`);
