import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { trailingKeys } from "../src/Tip";

const SRC = join(import.meta.dirname, "../src");

/** Every .tsx file of the web app. */
function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? tsxFiles(p) : p.endsWith(".tsx") ? [p] : [];
  });
}

/** The keys of an object literal written from `at` (its "{"), only those of its own level ({ title } too). */
function topKeys(code: string, at: number): string[] {
  const keys: string[] = [];
  let depth = 0;
  let key = "";
  // at the start or after a comma: what comes is a key, not a value
  let expectKey = true;
  const end = () => {
    if (expectKey && key) keys.push(key);
    key = "";
  };
  for (let i = at; i < code.length; i++) {
    const c = code[i]!;
    if (c === '"' || c === "'" || c === "`") {
      // a string: skipped whole (a template's ${} holds no key of this level); a quoted key is a key
      const from = i + 1;
      for (i++; i < code.length && code[i] !== c; i++) if (code[i] === "\\") i++;
      if (depth === 1 && expectKey) key = code.slice(from, i);
      continue;
    }
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") {
      if (--depth === 0) {
        end();
        break;
      }
    } else if (depth === 1) {
      if (c === ":") {
        end();
        expectKey = false;
      } else if (c === ",") {
        end();
        expectKey = true;
      } else if (/[\w$]/.test(c)) {
        if (expectKey) key += c;
      } else if (!/\s/.test(c)) key = "";
    }
  }
  return keys;
}

/** Elements given a `title` attribute: an element of the page, or a component that hands it to one. */
const HANDED_ON = new Set(["Button", "Link", "AutoText"]);

/**
 * `title` on an element that is not a tooltip: an iframe is named by it. And the workflow editor's
 * screens, which another piece of work has open: the tip takes their titles over when they are hovered
 * (Tip.tsx), and the count here can only go down.
 */
const ALLOWED: Record<string, number> = {
  "screens/workflowEditor/ShowPanel.tsx": 3,
  "screens/workflowEditor/parts.tsx": 1,
};
const NOT_A_TOOLTIP = new Set(["iframe"]);

/** Each file with the elements in it that have a `title`, by name. */
function titled(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const file of tsxFiles(SRC)) {
    // classic JSX: every element is h("tag", { props }) or h(Component, { props })
    const { code } = transformSync(readFileSync(file, "utf8"), { loader: "tsx", jsx: "transform", jsxFactory: "h", jsxFragment: "F" });
    const found: string[] = [];
    for (const m of code.matchAll(/\bh\(\s*(?:"([a-z][\w-]*)"|([A-Z][\w.]*))\s*,\s*\{/g)) {
      const tag = m[1] ?? m[2]!;
      if (m[2] && !HANDED_ON.has(tag)) continue;
      if (NOT_A_TOOLTIP.has(tag)) continue;
      if (topKeys(code, m.index! + m[0].length - 1).includes("title")) found.push(tag);
    }
    if (found.length) out[relative(SRC, file).replaceAll("\\", "/")] = found;
  }
  return out;
}

describe("the app's tooltip", () => {
  it("is the only one: no element has the browser's white title tooltip", () => {
    const over = Object.entries(titled())
      .filter(([file, tags]) => tags.length > (ALLOWED[file] ?? 0))
      .map(([file, tags]) => `${file}: title on <${tags.join(">, <")}> (use data-tip)`);
    expect(over).toEqual([]);
  });

  it("finds a title however it is written", () => {
    const { code } = transformSync(`const a = <button type="button" title={x ? "a" : \`b \${y}\`} onClick={() => f({ title: 1 })} />; const b = <Row title="heading" />;`, { loader: "tsx", jsx: "transform", jsxFactory: "h" });
    const keys = [...code.matchAll(/\bh\(\s*(?:"([a-z][\w-]*)"|([A-Z][\w.]*))\s*,\s*\{/g)].map((m) => [m[1] ?? m[2], topKeys(code, m.index! + m[0].length - 1)]);
    expect(keys).toEqual([["button", ["type", "title", "onClick"]], ["Row", ["title"]]]);
  });

  it("draws the keys a text ends with in brackets as keycaps", () => {
    expect(trailingKeys("Close (Esc)")).toEqual({ text: "Close", keys: "Esc" });
    expect(trailingKeys("Undo the last stroke (Ctrl+Z)")).toEqual({ text: "Undo the last stroke", keys: "Ctrl+Z" });
    expect(trailingKeys("Back to the results (Tab or Esc)")).toEqual({ text: "Back to the results", keys: "Tab or Esc" });
    expect(trailingKeys("Keyboard shortcuts (?)")).toEqual({ text: "Keyboard shortcuts", keys: "?" });
    expect(trailingKeys("Zoom in (Ctrl++)")).toEqual({ text: "Zoom in", keys: "Ctrl++" });
    // a pair, as Compare's tip writes it
    expect(trailingKeys("Drag the wipe (← →)")).toEqual({ text: "Drag the wipe", keys: "← →" });
    // words in brackets are words
    expect(trailingKeys("Seconds per step (s/it)")).toBeNull();
    expect(trailingKeys("One frame back (Shift: ten)")).toBeNull();
    expect(trailingKeys("Image to video (i2v)")).toBeNull();
    expect(trailingKeys("Ten frames (G does the same)")).toBeNull();
    expect(trailingKeys("Pick it (Ctrl+click)")).toBeNull();
  });
});
