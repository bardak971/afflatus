/**
 * No two modules import each other's values: `pnpm check:cycles`, in CI beside the types and the lint. madge is run pinned
 * through npx (not a dependency of the app), with `.madgerc` telling it to skip `import type`: a cycle of types alone is
 * gone once compiled, and the server's routes all take `import type { Services }` from the module that builds them.
 *
 * Known and allowed, and only those: the cycles through the web's lazyParts.ts. Every module it names is loaded with
 * `import()`, after the page has started, so the modules that import lazyParts.ts (Confirm.tsx for its dialog, the
 * tile menu, the viewer, the editor's screens) are evaluated long before it reaches back to them. Any other cycle fails.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MADGE = "madge@8.0.0";
const ROOTS = ["apps/server/src", "apps/web/src", "packages/core/src", "packages/recipes/src", "packages/comfy/src", "packages/workflows/src"];
/** The one module whose imports are all `import()`: a cycle through it is never one at load time. */
const LAZY = "apps/web/src/lazyParts.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// one command line through the shell (npx is a .cmd on Windows); every word of it is written here, none comes from outside
const run = spawnSync(["npx", "-y", MADGE, "--circular", "--json", "--no-spinner", "--extensions", "ts,tsx", ...ROOTS].join(" "), {
  cwd: root,
  encoding: "utf8",
  shell: true,
  maxBuffer: 64 * 2 ** 20,
});
let cycles: string[][];
try {
  // madge prints the cycles as JSON and exits 1 when it found any: the exit code alone says nothing here
  cycles = JSON.parse(run.stdout.slice(run.stdout.indexOf("["))) as string[][];
} catch {
  console.error(`madge did not answer with its list of cycles:\n${run.stdout}\n${run.stderr}`);
  process.exit(2);
}

const known = cycles.filter((c) => c.includes(LAZY));
const others = cycles.filter((c) => !c.includes(LAZY));
console.log(`${cycles.length} import cycles of values, ${known.length} of them through ${LAZY} (its import()s, allowed).`);
if (others.length) {
  console.error(`\n${others.length} cycle(s) between modules that import each other's values:`);
  for (const c of others) console.error(`  ${[...c, c[0]].join(" > ")}`);
  console.error("\nMove what both need into a module of its own (as MEDIA_LOADERS in packages/workflows/src/nodeKinds.ts).");
  process.exit(1);
}
