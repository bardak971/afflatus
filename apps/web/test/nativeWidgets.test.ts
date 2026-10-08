import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "../src");

/** Every .tsx file of the web app. */
function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? tsxFiles(p) : p.endsWith(".tsx") ? [p] : [];
  });
}

/**
 * The browser's own widgets look like no theme of the app's: the app has its own for each (VideoPlayer and
 * AudioPlayer for `controls`, a mono text box for a moment or a seed, Select for a list, Confirm for a question).
 * The import editor is left out: another piece of work is under way there.
 */
const NATIVE: Array<[string, RegExp]> = [
  ["the browser's media controls", /<(video|audio)\b[^>]*\bcontrols\b/],
  ["a date or time picker", /type="(date|datetime-local|time|month|week)"/],
  ["a number box with spin arrows", /type="number"/],
  ["a colour picker", /type="color"/],
  ["a native list", /<select\b/],
  ["a native question", /\b(window\.)?(confirm|alert|prompt)\(/],
];

describe("no native widgets", () => {
  for (const [what, re] of NATIVE) {
    it(`has no ${what}`, () => {
      const found = tsxFiles(SRC)
        .filter((f) => !relative(SRC, f).replaceAll("\\", "/").startsWith("screens/workflowEditor/"))
        .flatMap((f) => readFileSync(f, "utf8").split("\n").map((line, i) => [f, i, line] as const))
        .filter(([, , line]) => re.test(line) && !/^\s*(\/\/|\*)/.test(line))
        .map(([f, i]) => `${relative(SRC, f)}:${i + 1}`);
      expect(found).toEqual([]);
    });
  }
});
