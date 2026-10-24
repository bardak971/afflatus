/**
 * The guard behind the shared helpers: `pnpm lint` runs it after oxlint. It fails on what was written by hand again
 * beside a helper that does it, the patterns the 2026-10-11 review found copied a few dozen times:
 *   - a plural made inline (`=== 1 ? "" : "s"`, or "es"): format's `plural` (core's, for the server and the packages);
 *   - a failure banner made inline (`tone: "bad"` with an error's `.message`): sayFailed.ts's `useSayFailed` or `failedBanner`;
 *   - a list of model-file extensions in a pattern: core's modelFiles.ts (`MODEL_EXT`, `isModelFile`, `modelStem`);
 *   - a list of ComfyUI's usual model folders: core's modelFiles.ts (`USUAL_FOLDERS`, `FULL_MODEL_FOLDERS`).
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
 *
 * Rule 11, the menus (the conventions at the top of apps/web/src/ContextMenu.tsx), fails on a match too: a label's
 * ellipsis written as three dots, a menu row greyed with no note saying why, a submenu's row with an ellipsis
 * (`menuFindings`). What only a drawn menu shows is checked where menus are drawn, by ContextMenu's `menuProblems`.
 *
 * Rule 12, the bytes (card #54), fails on a match and reads the tests too: a control character in a source, where a
 * script that wrote a pattern turned its word-boundary escape into the backspace byte. A pattern so written still
 * compiles and matches less (inspect.ts read a loader named "prev" as a source video), and a test's check never fired.
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
  // the usual folders' list as it begins, in any quotes: written by hand five times (server and web), the lists drifted
  // apart. A few folders named for a purpose of their own (those a model comes with, a demo's) are no such list
  {
    test: /["'`]checkpoints["'`],\s*["'`]diffusion_models["'`],\s*(?:["'`]unet["'`],\s*)?["'`]loras["'`],\s*["'`]vae["'`],\s*["'`]text_encoders["'`]/,
    why: "a list of the usual model folders: use USUAL_FOLDERS or FULL_MODEL_FOLDERS (core's modelFiles.ts)",
    except: /packages[\\/]core[\\/]src[\\/]modelFiles\.ts$/,
  },
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

/** Any C0 control character but a tab and the two line ends, and DEL: what no source of ours holds as a byte. */
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** The control characters a file holds as bytes (`CONTROL`), each said by its code, the line shown with them escaped. */
export function controlFindings(file: string, text: string): Finding[] {
  const found: Finding[] = [];
  text.split("\n").forEach((l, i) => {
    const hex = (c: string) => c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
    const codes = [...new Set(l.match(CONTROL) ?? [])].map((c) => `U+00${hex(c)}`);
    if (!codes.length) return;
    const shown = l.trim().replace(CONTROL, (c) => `\\x${hex(c)}`).slice(0, 140);
    found.push({ file, line: i + 1, text: shown, why: `a control character (${codes.join(", ")}) written as a byte: a script turned an escape into it (U+0008 was a word boundary); write the escape` });
  });
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

/**
 * What a web source file that builds menus writes against the menu conventions (rule 11; ContextMenu.tsx holds them),
 * where reading its lines can tell: a label's ellipsis written as three dots, a menu row greyed with no note saying why
 * (a row that can never work is left out; one the user can make work says how), a submenu's row ending in "…". A menu
 * with no head fails the typecheck (`head` is required), and what only a drawn menu shows (the destructive rows last
 * and alone, a key on two rows) is ContextMenu's `menuProblems`, which every test that opens a menu runs.
 */
export function menuFindings(file: string, text: string): Finding[] {
  if (!designed(file)) return [];
  const lines = text.split("\n");
  const menus = /\bMenuItem\b|<ContextMenu\b/.test(text);
  const found: Finding[] = [];
  const say = (i: number, why: string) => found.push({ file, line: i + 1, text: lines[i]!.trim().slice(0, 140), why: `${why} (the menu conventions, ContextMenu.tsx)` });
  lines.forEach((l, i) => {
    if (/^\s*(?:\/\/|\*|\/\*)/.test(l)) return;
    if (labelsOf(l).some((label) => /\.\.\.\s*$/.test(label))) say(i, 'an ellipsis is one character: "…", not three dots');
    if (!menus || !/\blabel:/.test(l)) return;
    if (/\blabel:\s*(["'`])[^"'`]*…\1[^\n]*\bitems:/.test(l)) say(i, "a row that opens a submenu has no ellipsis");
    // a row's object may run over a few lines: its note is looked for up to the next row
    if (/\bdisabled:(?!\s*false\b)/.test(l)) {
      const rest = [l, ...lines.slice(i + 1, i + 4).filter((_, k, all) => !all.slice(0, k + 1).some((x) => /\blabel:/.test(x)))];
      if (!rest.some((x) => /\bnote\b/.test(x))) say(i, "a greyed menu row says why in its note, or is left out as a dead row");
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

/**
 * The marker that takes a line out of the design rules: a comment `// design: <why>` (or `{/* design: <why> *\/}`) at
 * the end of the line, or alone on the line just above it, saying why the line is not a hand-made copy of a kit piece or
 * a token (a stat figure bigger than display, the player's letterbox black, a dot that pulses to mean "live"). The
 * reason is required, so the budget counts only the real one-offs and each exception says where it stands and why. A
 * marker at the end of a line covers that line alone, so one cannot let a neighbour through unseen.
 */
const MARKER = /^\/[/*]\s*design:\s*(?!\*\/)\S/;
/**
 * A marker alone on its line, a whole comment and nothing else (`//`, a block or JSX's `{/* … *\/}`): it speaks for the
 * line below. A block's reason holds no `*\/`, so the reason ends at its own comment's close: a leading marker, code and
 * then another comment is not one comment from the first `/*` to the last `*\/`.
 */
const MARKER_ALONE = /^\s*(?:\/\/\s*design:\s*\S.*|\{?\/\*\s*design:\s*(?!\*\/)\S(?:(?!\*\/).)*\*\/\}?)\s*$/;

/**
 * The comments of a line, each from its `//` or `/*`, read past its strings: a `//design:` inside a string or a URL is
 * text, not a marker. A quote that opens no string (an apostrophe in JSX text) hides what follows it, so such a line
 * goes unmarked and counted, the safe side for a budget.
 */
function commentsOf(line: string): string[] {
  const found: string[] = [];
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "/" && line[i + 1] === "/") {
      found.push(line.slice(i));
      break;
    } else if (c === "/" && line[i + 1] === "*") {
      const end = line.indexOf("*/", i + 2);
      found.push(line.slice(i, end < 0 ? undefined : end + 2));
      if (end < 0) break;
      i = end + 1;
    }
  }
  return found;
}

/**
 * The text with its marked lines blanked, so the rules do not count them (the lines keep their places). A marker with
 * code beside it covers its own line alone, even when it leads the line.
 * @internal exported for the test
 */
export function unmarked(text: string): string {
  const lines = text.split("\n");
  const marked = (l: string) => commentsOf(l).some((c) => MARKER.test(c));
  return lines.map((l, i) => (marked(l) || (i > 0 && MARKER_ALONE.test(lines[i - 1]!)) ? "" : l)).join("\n");
}

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
  {
    id: "close-icon",
    why: "an × of its own (<X>): use CloseButton",
    // An × that is a menu row's icon (`icon: <X …/>`, drawn by the menu beside its words) or the glyph given to an
    // IconButton on its line is not a close of its own: only that button's children are let through (to its close on
    // the line, or the rest of the line when it closes further down), so an × after it on the line still counts. The
    // track's stop in a queued clip's box is drawn at 16 px inside the clip, under the kit's smallest size (taken at 24
    // through its ::before); it is let through by its one shape, the 10 px × alone on its line in TrackClip.tsx.
    count: (f, t) =>
      KIT.test(f)
        ? 0
        : t
            .split("\n")
            .map((l) =>
              l
                .replace(/\bicon:\s*<X\b/g, "")
                .replace(/<(IconButton|CloseButton)\b.*?<\/\1>/g, "")
                .replace(/<(?:IconButton|CloseButton)\b(?:[^>{]|\{[^}]*\})*\/>/g, "")
                .replace(/<(?:IconButton|CloseButton)\b.*/, ""),
            )
            .map((l) => (f === "apps/web/src/timeline/track/TrackClip.tsx" ? l.replace(/^\s*<X size=\{10\} \/>\s*$/, "") : l))
            .reduce((n, l) => n + matches(/<X\b/g, l), 0),
  },
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
    const counted = unmarked(text);
    for (const r of DESIGN_RULES) counts[r.id] = (counts[r.id] ?? 0) + r.count(file, counted);
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
 * cannot import core, and are not read. `tests`: the tests too (apps/<name>/test, packages/<name>/test), for the bytes.
 * @internal exported for the test
 */
export function sources(root: string, { tests = false }: { tests?: boolean } = {}): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== "dist") walk(p);
      } else if (/\.(ts|tsx|mts)$/.test(e.name) && (tests || !/\.test\.tsx?$/.test(e.name))) out.push(p);
    }
  };
  for (const top of ["apps", "packages"]) {
    for (const e of readdirSync(join(root, top), { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      for (const under of tests ? ["src", "test"] : ["src"]) {
        try {
          walk(join(root, top, e.name, under));
        } catch {
          // a package without src (none today), or without tests
        }
      }
    }
  }
  walk(join(root, "scripts"));
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const files = sources(root).map((p) => ({ file: relative(root, p).replace(/\\/g, "/"), text: readFileSync(p, "utf8") }));
  const found = files.flatMap(({ file, text }) => [...sharedFindings(file, text), ...wordFindings(file, text), ...menuFindings(file, text)]);
  // the bytes, in the tests too: card #54's backspace was in a test as well, whose check then never fired
  for (const p of sources(root, { tests: true })) found.push(...controlFindings(relative(root, p).replace(/\\/g, "/"), readFileSync(p, "utf8")));
  for (const f of found) console.error(`${f.file}:${f.line}: ${f.why}\n    ${f.text}`);

  const listed = process.argv.indexOf("--list");
  if (listed > 0) {
    const rule = DESIGN_RULES.find((r) => r.id === process.argv[listed + 1]);
    if (!rule) throw new Error(`--list takes a rule: ${DESIGN_RULES.map((r) => r.id).join(", ")}`);
    for (const { file, text } of files) {
      const n = designed(file) ? rule.count(file, unmarked(text)) : 0;
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
