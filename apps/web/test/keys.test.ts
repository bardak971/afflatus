import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { capText, keyQuery, matchKeys, parseKeys } from "../src/keys/grammar";
import { PLACES } from "../src/keys/table";

const SRC = join(import.meta.dirname, "../src");

/** Every .ts and .tsx file of the web app. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? sources(p) : /\.tsx?$/.test(p) ? [p] : [];
  });
}

/** What every file writes as a key: a menu item's hint (`{ label: …, key: "S" }`), a tip's keys (`data-tip-keys="Esc"`). */
function written(): Array<{ file: string; kind: "menu" | "tip"; keys: string }> {
  const out: Array<{ file: string; kind: "menu" | "tip"; keys: string }> = [];
  for (const path of sources(SRC)) {
    const file = relative(SRC, path).replaceAll("\\", "/");
    const code = readFileSync(path, "utf8");
    for (const m of code.matchAll(/\{\s*label:[^\n]*?\bkey:\s*"([^"]+)"/g)) out.push({ file, kind: "menu", keys: m[1]! });
    for (const m of code.matchAll(/data-tip-keys="([^"]+)"/g)) out.push({ file, kind: "tip", keys: m[1]! });
  }
  return out;
}

/** A chord as one string, the same however it was written ("Alt + ←" and "Alt+←"). */
const chordsOf = (keys: string): string[] => {
  const p = parseKeys(keys);
  return p && !("code" in p) ? p.ways.flatMap((w) => w.pair.map((c) => c.join("+"))) : [];
};

describe("the keys grammar", () => {
  it("reads chords, alternatives, pairs, mouse moves and code", () => {
    expect(parseKeys("Ctrl+Shift+Z | Ctrl+Y")).toEqual({ ways: [{ pair: [["Ctrl", "Shift", "Z"]], mouse: false }, { pair: [["Ctrl", "Y"]], mouse: false }] });
    expect(parseKeys("← →")).toEqual({ ways: [{ pair: [["←"], ["→"]], mouse: false }] });
    expect(parseKeys("S | Ctrl+B")).toEqual({ ways: [{ pair: [["S"]], mouse: false }, { pair: [["Ctrl", "B"]], mouse: false }] });
    expect(parseKeys("Tab or Esc")).toEqual({ ways: [{ pair: [["Tab"]], mouse: false }, { pair: [["Esc"]], mouse: false }] });
    expect(parseKeys("Ctrl+click")).toEqual({ ways: [{ pair: [["Ctrl", "click"]], mouse: true }] });
    expect(parseKeys("{a|b|c}")).toEqual({ code: "{a|b|c}" });
    // the older spelling with spaces round the plus, and the plus key itself
    expect(parseKeys("Alt + ←")).toEqual({ ways: [{ pair: [["Alt", "←"]], mouse: false }] });
    expect(parseKeys("Ctrl++")).toEqual({ ways: [{ pair: [["Ctrl", "+"]], mouse: false }] });
    // names of the same key, as a recorder or an older line wrote them
    expect(parseKeys("Control+Escape")).toEqual({ ways: [{ pair: [["Ctrl", "Esc"]], mouse: false }] });
    expect(parseKeys("Ctrl ↵")).toEqual({ ways: [{ pair: [["Ctrl"], ["Enter"]], mouse: false }] });
  });

  it("refuses what is not keys", () => {
    for (const s of ["i2v", "Shift: ten", "s/it", "G does the same", "click+Ctrl", "drag drop", ""]) expect(parseKeys(s), s).toBeNull();
  });

  it("writes Ctrl and Alt the Mac's way on a Mac", () => {
    expect([capText("Ctrl", true), capText("Alt", true), capText("Meta", true), capText("Shift", true)]).toEqual(["⌘", "⌥", "⌘", "Shift"]);
    expect([capText("Ctrl", false), capText("Alt", false)]).toEqual(["Ctrl", "Alt"]);
  });

  it("answers a key search: exact chords first, then keys by the start of their name", () => {
    const s = keyQuery("s")!;
    expect(matchKeys("S | Ctrl+B", s)).toEqual({ rank: 0, hits: [{ way: 0, chord: 0, key: "S" }] });
    expect(matchKeys("Shift+Z", s)).toEqual({ rank: 2, hits: [{ way: 0, chord: 0, key: "Shift" }] });
    expect(matchKeys("Ctrl+Z", keyQuery("ctrl z")!)).toEqual({ rank: 0, hits: [{ way: 0, chord: 0, key: "Ctrl" }, { way: 0, chord: 0, key: "Z" }] });
    expect(matchKeys("Ctrl+Shift+Z | Ctrl+Y", keyQuery("ctrl z")!)?.rank).toBe(1);
    expect(matchKeys("Ctrl+Z", keyQuery("cmd z")!)?.rank).toBe(0);
    expect(keyQuery("split")).toBeNull();
  });

  it("lights only the caps of the chords that answer, not the same key in another way", () => {
    // Redo: "ctrl z" is in its first way; the Ctrl of Ctrl+Y stays unlit
    expect(matchKeys("Ctrl+Shift+Z | Ctrl+Y", keyQuery("ctrl z")!)!.hits).toEqual([{ way: 0, chord: 0, key: "Ctrl" }, { way: 0, chord: 0, key: "Z" }]);
    expect(matchKeys("Ctrl+Shift+Z | Ctrl+Y", keyQuery("ctrl y")!)!.hits).toEqual([{ way: 1, chord: 0, key: "Ctrl" }, { way: 1, chord: 0, key: "Y" }]);
    // the chord that answers exactly wins over one that only holds the keys among others
    expect(matchKeys("Ctrl+Shift+Z | Ctrl+Z", keyQuery("ctrl z")!)).toEqual({ rank: 0, hits: [{ way: 1, chord: 0, key: "Ctrl" }, { way: 1, chord: 0, key: "Z" }] });
    // a searched Ctrl lights the cap written Meta, as it is written
    expect(matchKeys("Meta+K", keyQuery("ctrl k")!)!.hits).toEqual([{ way: 0, chord: 0, key: "Meta" }, { way: 0, chord: 0, key: "K" }]);
    // every chord that answers as well is lit: both halves of a pair
    expect(matchKeys("Alt+[ Alt+]", keyQuery("alt")!)!.hits).toEqual([{ way: 0, chord: 0, key: "Alt" }, { way: 0, chord: 1, key: "Alt" }]);
  });
});

describe("the key table", () => {
  it("writes every row in the grammar", () => {
    const bad = PLACES.flatMap((p) => p.groups.flatMap((g) => g.rows.filter((r) => !parseKeys(r.keys)).map((r) => `${p.name} › ${g.name}: "${r.keys}"`)));
    expect(bad).toEqual([]);
  });

  it("marks mouse rows, and only those, as mouse moves", () => {
    const bad = PLACES.flatMap((p) => p.groups.flatMap((g) => g.rows.filter((r) => {
      const parsed = parseKeys(r.keys);
      const mouse = Boolean(parsed && "ways" in parsed && parsed.ways.some((w) => w.mouse));
      return mouse !== Boolean(r.mouse);
    }).map((r) => `${p.name}: "${r.keys}"`)));
    expect(bad).toEqual([]);
  });

  it("has every menu hint and tip key of the app in the grammar", () => {
    const bad = written().filter((w) => !parseKeys(w.keys)).map((w) => `${w.file} (${w.kind}): "${w.keys}"`);
    expect(bad).toEqual([]);
  });

  it("lists every key a menu shows, in some place", () => {
    const listed = new Set(PLACES.flatMap((p) => p.groups.flatMap((g) => g.rows.flatMap((r) => chordsOf(r.keys)))));
    const missing = written()
      .filter((w) => w.kind === "menu")
      .flatMap((w) => chordsOf(w.keys).filter((c) => !listed.has(c)).map((c) => `${w.file}: ${c}`));
    expect([...new Set(missing)]).toEqual([]);
  });
});
