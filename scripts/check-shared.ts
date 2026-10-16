/**
 * The guard behind the shared helpers: `pnpm lint` runs it after oxlint. It fails on what was written by hand again
 * beside a helper that does it, the patterns the 2026-10-11 review found copied a few dozen times:
 *   - a plural made inline (`=== 1 ? "" : "s"`, or "es"): format's `plural` (core's, for the server and the packages);
 *   - a failure banner made inline (`tone: "bad"` with an error's `.message`): sayFailed.ts's `useSayFailed` or `failedBanner`;
 *   - a list of model-file extensions in a pattern: core's modelFiles.ts (`MODEL_EXT`, `isModelFile`, `modelStem`).
 * Only the sources are read (apps/<name>/src, packages/<name>/src, and the scripts that `pnpm check:*` and the rest run),
 * not the tests. `pnpm lint` from the repository root.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { plural } from "@afflatus/core";

/** One thing written by hand that a helper does. */
export interface Finding {
  file: string;
  line: number;
  text: string;
  why: string;
}

const EXT = "(?:safetensors|sft|ckpt|pth?|bin|gguf|onnx|engine)";
const RULES: Array<{ test: RegExp; why: string; except?: RegExp }> = [
  // Any ending, not only "s": "match"/"es" and "switch"/"es" slipped past a rule that looked for "s" alone.
  { test: /=== 1 \? "" : "[a-z]+"|!== 1 \? "[a-z]+" : ""/, why: 'a plural made inline: use plural(n, "word") (format.ts, or core for the server)' },
  { test: /tone: "bad"[^\n]*\.message\b|\.message\b[^\n]*tone: "bad"/, why: "a failure banner made inline: use useSayFailed or failedBanner (sayFailed.ts)", except: /apps[\\/]web[\\/]src[\\/]sayFailed\.ts$/ },
  // three extensions or more in one alternation: a model-file list (a pair such as safetensors|sft is a single format)
  { test: new RegExp(`\\b${EXT}(?:\\|${EXT}){2,}\\b`), why: "a list of model-file extensions: use MODEL_EXT, isModelFile or modelStem (core's modelFiles.ts)", except: /packages[\\/]core[\\/]src[\\/]modelFiles\.ts$/ },
];

/** What a source file writes by hand that a helper does, line by line. `file` is its path from the repository root. */
export function sharedFindings(file: string, text: string): Finding[] {
  const found: Finding[] = [];
  const lines = text.split("\n");
  for (const rule of RULES) {
    // This file spells every pattern out in its rules and its header, so it would refuse itself.
    if (rule.except?.test(file) || /(^|[\\/])scripts[\\/]check-shared\.ts$/.test(file)) continue;
    lines.forEach((l, i) => {
      if (rule.test.test(l)) found.push({ file, line: i + 1, text: l.trim().slice(0, 140), why: rule.why });
    });
  }
  return found;
}

/**
 * The source files the guard reads: TypeScript under apps/<name>/src, packages/<name>/src and scripts/. The scripts are
 * read because an inline plural slipped into check-graphs.ts while they were left out; their .mjs run on bare Node,
 * cannot import core, and are not read.
 * @internal exported for the test
 */
export function sources(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== "dist") walk(p);
      } else if (/\.(ts|tsx|mts)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
    }
  };
  for (const top of ["apps", "packages"]) {
    for (const e of readdirSync(join(root, top), { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      try {
        walk(join(root, top, e.name, "src"));
      } catch {
        // a package without src (none today)
      }
    }
  }
  walk(join(root, "scripts"));
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const found = sources(root).flatMap((p) => sharedFindings(relative(root, p).replace(/\\/g, "/"), readFileSync(p, "utf8")));
  for (const f of found) console.error(`${f.file}:${f.line}: ${f.why}\n    ${f.text}`);
  if (found.length) {
    console.error(`\n${plural(found.length, "place")} written by hand beside a shared helper (scripts/check-shared.ts).`);
    process.exit(1);
  }
}
