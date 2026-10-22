/**
 * The guard behind the shared helpers: `pnpm lint` runs it after oxlint. It fails on what was written by hand again
 * beside a helper that does it, the patterns the 2026-10-11 review found copied a few dozen times:
 *   - a plural made inline (`=== 1 ? "" : "s"`, or "es"): format's `plural` (core's, for the server and the packages);
 *   - a failure banner made inline (`tone: "bad"` with an error's `.message`): sayFailed.ts's `useSayFailed` or `failedBanner`;
 *   - a list of model-file extensions in a pattern: core's modelFiles.ts (`MODEL_EXT`, `isModelFile`, `modelStem`).
 * Only the sources are read (apps/<name>/src, packages/<name>/src, and the scripts that `pnpm check:*` and the rest run),
 * not the tests. `pnpm lint` from the repository root.
 *
 * It also holds the web app's design to a budget (review 4, section 4.3): what the kit and its tokens do, written by hand
 * (an arbitrary font size, radius, z-index or tracking, a raw colour, an × of its own, a spinner of its own, a hand-made
 * icon button, an animation that does not ask motionAllowed). Those were in hundreds of places when the rules came, so
 * they do not fail on a match: scripts/design-budget.json holds each rule's count, and the lint fails when one goes up.
 * When one goes down the lint fails too, with "lower the budget to N", until `tsx scripts/check-shared.ts --budget` writes
 * the new counts in (it never raises one: a budget only ever comes down). The lint does not write the file itself: the
 * budget changes only in a commit its author made, so a lint run on one branch never leaves the tree dirty, and two
 * branches that lowered it meet as a plain conflict on the numbers. `--list <rule>` prints where a rule's matches are.
 *
 * Rule 10 of that list, the words (review 4, P4: one word per act), does fail on a match: the web app's labels were
 * made to say one word per act, so a retired one (Requeue, Face detailer, Generate on a button…) is refused with the word
 * that replaced it. Only what the user reads as a label is looked at: JSX text, and the strings of `label`, `aria-label`
 * and `data-tip`, so an id, a route or a comment keeps its old word.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
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
 * The retired label words, each with the one that replaced it (mock section 3, the owner's picks). `test` is matched
 * against one label's text; "Generate" only where a label starts with it (a button's words), not "Generated".
 */
export const BANNED_WORDS: Array<{ test: RegExp; say: string }> = [
  { test: /^\s*Generate\b/, say: "Render" },
  { test: /\bRequeue\b/, say: "Render again" },
  { test: /\bRetry unchanged\b|\bRetry all \S+ unchanged\b/, say: "Render again" },
  { test: /\bFace detailer\b|\bFace pass\b/, say: "Face refine" },
  { test: /\bHand detailer\b/, say: "Hand refine" },
  { test: /\bCancel (?:this )?render\b/, say: "Stop" },
  { test: /\bCancel this one\b/, say: "Remove from queue" },
  { test: /\bCancel all waiting\b/, say: "Remove all waiting" },
  { test: /\bDelete this picture\b/, say: "Move to bin" },
];

/** The labels on a line of the web app: JSX text between tags, and the strings given to label, aria-label and data-tip. */
export function labelsOf(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)) out.push(m[1]!);
  // a JSX text that runs to the end of the line (the closing tag on a line of its own)
  const tail = /^\s*([A-Z][^<>{}=;]*)$/.exec(line);
  if (tail && !/^\s*(?:import|export|const|let|return|if|else|case|type|interface)\b/.test(line)) out.push(tail[1]!);
  // a string given to one of them, or both of a choice between two strings (`label={on ? "A" : "B"}`)
  for (const m of line.matchAll(/(?:\blabel|\baria-label|\bdata-tip)\s*[:=]\s*\{?\s*(?:[^"'`,}]*\?\s*)?(["'`])((?:(?!\1).)*)\1(?:\s*:\s*(["'`])((?:(?!\3).)*)\3)?/g)) {
    out.push(m[2]!);
    if (m[4] !== undefined) out.push(m[4]);
  }
  return out;
}

/** The retired words a web source file still shows as labels, line by line (rule 10). */
export function wordFindings(file: string, text: string): Finding[] {
  if (!designed(file)) return [];
  const found: Finding[] = [];
  text.split("\n").forEach((l, i) => {
    // a comment says what the code did, in the words of its time
    if (/^\s*(?:\/\/|\*|\/\*)/.test(l)) return;
    for (const label of labelsOf(l)) {
      const banned = BANNED_WORDS.find((w) => w.test.test(label));
      if (banned) found.push({ file, line: i + 1, text: l.trim().slice(0, 140), why: `a retired label word: say "${banned.say}" (one word per act, review 4 P4)` });
    }
  });
  return found;
}

/** A design rule held to a budget: how many times the web app's files do by hand what the kit or a token does. */
interface DesignRule {
  id: string;
  why: string;
  /** How many times one file breaks it. */
  count(file: string, text: string): number;
}

const matches = (re: RegExp, text: string) => text.match(re)?.length ?? 0;
/** The kit itself, where the one spinner, the one close and the icon button are made. */
const KIT = /^apps\/web\/src\/ui\.tsx$/;

/** The rules, in the order of the review's list (section 4.3; rule 10, the banned words, is `wordFindings`, which fails outright). */
export const DESIGN_RULES: DesignRule[] = [
  { id: "font-size", why: "an arbitrary font size (text-[Npx]): use the type scale (text-micro … text-display)", count: (_f, t) => matches(/\btext-\[\d+(?:\.\d+)?px\]/g, t) },
  { id: "radius", why: "an arbitrary radius (rounded-[Npx]): use rounded-key, -chip, -control, -card or -dialog", count: (_f, t) => matches(/\brounded(?:-[a-z]{1,2})?-\[\d+(?:\.\d+)?px\]/g, t) },
  { id: "z-index", why: "an arbitrary z-index (z-[N]): use a named layer (z-sticky … z-tip)", count: (_f, t) => matches(/\bz-\[\d+\]/g, t) },
  { id: "tracking", why: "an arbitrary tracking (tracking-[…]): use the type scale's, or tracking-label", count: (_f, t) => matches(/\btracking-\[/g, t) },
  {
    id: "raw-colour",
    why: "a raw colour (bg-red…, [#hex]): use a colour token",
    // the charts and the transitions' looks draw in colours of their own
    count: (f, t) => (/\.tsx$/.test(f) && !/transitionLook|[Cc]hart/.test(f) ? matches(/\bbg-(?:red|amber|zinc|gray|neutral|slate|white|black)\b|\[#[0-9a-fA-F]{3,8}\]/g, t) : 0),
  },
  { id: "close-icon", why: "an × of its own (<X>): use CloseButton", count: (f, t) => (KIT.test(f) ? 0 : matches(/<X\b/g, t)) },
  { id: "pulse-spin", why: "animate-pulse or animate-spin: use .m-skeleton or Spinner", count: (f, t) => (KIT.test(f) ? 0 : matches(/\banimate-(?:pulse|spin)\b/g, t)) },
  {
    id: "icon-button",
    why: "a hand-made icon button (a <button> sized h-N w-N or size-N): use IconButton",
    // a heuristic, line by line: a button whose classes give it a square size is most often an icon alone
    count: (f, t) => (KIT.test(f) ? 0 : t.split("\n").filter((l) => /<button\b/.test(l) && /className=.*\b(?:size-\d|h-\d+(?:\.\d)?\s+w-\d)/.test(l)).length),
  },
  {
    id: "animate-motion",
    why: "an animation from script (.animate()) in a file that never asks motionAllowed: ask it first",
    count: (_f, t) => (/\bmotionAllowed\b/.test(t) ? 0 : matches(/\.animate\??\.?\(/g, t)),
  },
];

/** The files the design rules read: the web app's sources (paths from the repository root). */
const designed = (file: string) => file.startsWith("apps/web/src/");

/** Each design rule's count over the files given (their path from the repository root, and their text). */
export function designCounts(files: Array<{ file: string; text: string }>): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(DESIGN_RULES.map((r) => [r.id, 0]));
  for (const { file, text } of files) {
    if (!designed(file)) continue;
    for (const r of DESIGN_RULES) counts[r.id] = (counts[r.id] ?? 0) + r.count(file, text);
  }
  return counts;
}

/** The counts against the budget: the rules that went up (a failure), and those that came down (a budget to lower). */
export function overBudget(counts: Record<string, number>, budget: Record<string, number>): { up: string[]; down: string[] } {
  const up: string[] = [];
  const down: string[] = [];
  for (const r of DESIGN_RULES) {
    const now = counts[r.id] ?? 0;
    // a rule with no budget yet is held at nothing
    const allowed = budget[r.id] ?? 0;
    if (now > allowed) up.push(`${r.id}: ${now}, over its budget of ${allowed}. ${r.why}`);
    else if (now < allowed) down.push(`${r.id}: ${now}, under its budget of ${allowed}`);
  }
  return { up, down };
}

/**
 * What a lint run says about the budget, and whether it fails. A count under its budget fails as one over it does, or the
 * budget would only come down when someone remembered to run `--budget`, and a later addition could take the slack back
 * unseen. `writing` is the `--budget` run that has just written the counts in (nothing over), which leaves nothing under.
 * @internal exported for the test
 */
export function budgetVerdict(counts: Record<string, number>, budget: Record<string, number>, writing: boolean): { lines: string[]; fails: boolean } {
  const lines: string[] = [];
  for (const r of DESIGN_RULES) {
    const now = counts[r.id] ?? 0;
    const allowed = budget[r.id] ?? 0;
    if (now > allowed) lines.push(`design budget: ${r.id}: ${now}, over its budget of ${allowed}. ${r.why} (tsx scripts/check-shared.ts --list ${r.id} shows where)`);
    else if (now < allowed && !writing) lines.push(`design budget: ${r.id}: ${now}, under its budget of ${allowed}: lower the budget to ${now} (tsx scripts/check-shared.ts --budget)`);
  }
  return { lines, fails: lines.length > 0 };
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
  const files = sources(root).map((p) => ({ file: relative(root, p).replace(/\\/g, "/"), text: readFileSync(p, "utf8") }));
  const found = files.flatMap(({ file, text }) => [...sharedFindings(file, text), ...wordFindings(file, text)]);
  for (const f of found) console.error(`${f.file}:${f.line}: ${f.why}\n    ${f.text}`);

  const listed = process.argv.indexOf("--list");
  if (listed > 0) {
    const rule = DESIGN_RULES.find((r) => r.id === process.argv[listed + 1]);
    if (!rule) throw new Error(`--list takes a rule: ${DESIGN_RULES.map((r) => r.id).join(", ")}`);
    for (const { file, text } of files) {
      const n = designed(file) ? rule.count(file, text) : 0;
      if (n) console.log(`${file}: ${n}`);
    }
    // The shared findings are printed above whatever the rule, so a listing run fails on them as the lint does.
    process.exit(found.length ? 1 : 0);
  }
  const budgetFile = join(root, "scripts", "design-budget.json");
  const counts = designCounts(files);
  const budget = JSON.parse(readFileSync(budgetFile, "utf8")) as Record<string, number>;
  let writing = false;
  if (process.argv.includes("--budget")) {
    // only ever down: a count over its budget is a failure to fix, not one to write in
    if (overBudget(counts, budget).up.length) console.error("A rule is over its budget: the budget is not raised.");
    else {
      writeFileSync(budgetFile, `${JSON.stringify(counts, null, 2)}\n`);
      console.log("design budget: written down to today's counts.");
      writing = true;
    }
  }
  const verdict = budgetVerdict(counts, budget, writing);
  for (const line of verdict.lines) console.error(line);
  if (found.length) console.error(`\n${plural(found.length, "place")} written by hand beside a shared helper (scripts/check-shared.ts).`);
  if (found.length || verdict.fails) process.exit(1);
}
