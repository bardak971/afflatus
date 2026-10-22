import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MenuItem } from "../src/ContextMenu";
import { deleteQuestion, kindActions, MENUS, toBar, toMenu, type KindActionId, type KindFacts, type KindRuns, type MenuKind } from "../src/projects/kindActions";

const SRC = join(import.meta.dirname, "../src");
const ids = Object.values(MENUS).flat().flatMap((s) => (s === "—" ? [] : [s.id]));
const runs: KindRuns = Object.fromEntries(ids.map((id) => [id, () => {}]));
const target = (label: string, disabled = false): MenuItem => ({ label, disabled, run: () => {} });
const subs = { move: [target("Client work"), target("Rushes", true), target("The Inbox")], put: [target("B-roll"), "—" as const, target("The project's root")] };

/** A menu's lines as "label · note" (off: "(off)" after it), rules as "—". */
const lines = (items: MenuItem[]) => items.map((it) => (it === "—" ? "—" : `${it.label}${it.note ? ` · ${it.note}` : ""}${it.disabled ? " (off)" : ""}`));
const menuOf = (f: KindFacts, hide: KindActionId[] = []) => lines(toMenu(kindActions(f, runs, subs, hide), true));

describe("the list of a timeline, a draft, a folder and a project", () => {
  it("holds a timeline's actions in the mock's order, its work actions with them", () => {
    expect(menuOf({ kind: "timeline", clips: 9, toRender: 3, exported: true, unused: { takes: 4, bytes: 1.2e9 } })).toEqual([
      "Open", "Show in Projects", "—",
      "Render all · 3 clips", "Finish…", "Export… · exported before", "Fix all · what Needs a look lists", "—",
      "Rename…", "Put in a folder · renders land there", "Move to · another project", "—",
      expect.stringMatching(/^Bin unused takes… · 4 · /), "Delete… · videos stay",
    ]);
  });

  it("keeps an action the user can make run in its place, off, with its reason; leaves out one that never would", () => {
    const empty = menuOf({ kind: "timeline", clips: 0, unused: null });
    expect(empty).toContain("Render all · no clips (off)");
    expect(empty).toContain("Fix all · no clips (off)");
    // none to bin, nothing to render, a folder that was not moved: nothing the user does makes these work (dead rows)
    expect(empty.some((l) => l.startsWith("Bin unused takes"))).toBe(false);
    expect(menuOf({ kind: "timeline", clips: 3, toRender: 0 }).some((l) => l.startsWith("Render all"))).toBe(false);
    expect(menuOf({ kind: "linked" }).some((l) => l.startsWith("Link again"))).toBe(false);
    // what the place does not do (no folder picker there) is not drawn either
    expect(lines(toMenu(kindActions({ kind: "folder", inProject: true }, { ...runs, import: undefined }, subs), true)).some((l) => l.startsWith("Import"))).toBe(false);
    // its unused takes not read yet: neither "none" nor a count
    expect(menuOf({ kind: "timeline" })).toContain("Bin unused takes… · reading… (off)");
    // the read failed: said, not "reading…" for good
    expect(menuOf({ kind: "timeline", unused: "unread" })).toContain("Bin unused takes… · could not be read (off)");
    const noFolders = lines(toMenu(kindActions({ kind: "timeline", unused: null }, runs, { move: subs.move, put: [] }), true));
    expect(noFolders).toContain("Put in a folder · no folder in its project (off)");
    expect(menuOf({ kind: "linked", missing: true })).toEqual(expect.arrayContaining(["Rescan · not found on your disk (off)", "Link again… · where it is now"]));
  });

  it("lets a place only leave out, never add", () => {
    const whole = menuOf({ kind: "draft" });
    expect(whole).toEqual(["Open", "Show in Projects", "—", "Render again · as its Render button", "Duplicate · a new draft with its forms", "—", "Rename…", "Move to · another project", "—", "Delete… · its outputs stay"]);
    expect(menuOf({ kind: "draft" }, ["open"])).toEqual(whole.filter((l) => l !== "Open"));
    expect(menuOf({ kind: "draft" }, ["show"])).toEqual(whole.filter((l) => l !== "Show in Projects"));
  });

  it("keeps, for several picked, only what acts on them all, counted", () => {
    expect(menuOf({ kind: "timeline", count: 3, unused: null })).toEqual(["Put 3 in a folder · renders land there", "Move 3 to · another project", "—", "Delete 3…"]);
    expect(menuOf({ kind: "draft", count: 2 })).toEqual(["Move 2 to · another project", "—", "Delete 2…"]);
    expect(menuOf({ kind: "folder", count: 2, inProject: true })).toEqual(["Move 2 to", "—", "Delete 2…"]);
  });

  it("gives a folder of the library and one of the disk their two shapes", () => {
    expect(menuOf({ kind: "folder", inProject: true })).toEqual([
      "Open", "Show in Projects", "—", "New folder inside…", "Import a folder here… · copies it in", "Use as the project's root · renders land there", "—", "Rename…", "Move to", "—", "Delete… · items move up",
    ]);
    expect(menuOf({ kind: "folder", inProject: false })).toContain("Use as the project's root · in the Inbox (off)");
    expect(menuOf({ kind: "linked" })).toEqual([
      "Open", "Show in Projects", "—", "Rescan · what changed on disk", "New folder inside… · on your disk", "—", "Rename…", "Move to", "—", "Unlink… · disk untouched",
    ]);
    // only the folder that was linked is renamed, moved or unlinked
    expect(menuOf({ kind: "linked", sub: true })).toEqual(["Open", "Show in Projects", "—", "Rescan · what changed on disk", "New folder inside… · on your disk"]);
  });

  it("gives a project its list, the Inbox the part of it that applies", () => {
    const project = toMenu(kindActions({ kind: "project", hasRoot: false }, runs, subs), true);
    // Archive goes with Rename (it hides, keeps all); Delete alone, last; the three ways to add a folder in one submenu
    expect(lines(project)).toEqual([
      "Work in it", "Show in Projects", "Pin to the rail · one click away", "—",
      "Add a folder", "Make a root folder · renders land there", "—",
      "Rename…", "Archive · hides it, keeps all", "—", "Delete… · items go to the Inbox",
    ]);
    const add = project.find((it) => it !== "—" && it.label === "Add a folder");
    expect(add !== "—" && add?.items && lines(add.items)).toEqual(["New folder inside…", "Import a folder here… · makes its root folder first", "Link a disk folder… · used in place"]);
    const archived = kindActions({ kind: "project", hasRoot: true, archived: true }, runs, subs).map((a) => `${a.label}${a.note ? ` · ${a.note}` : ""}${a.disabled ? " (off)" : ""}`);
    expect(archived).toEqual(expect.arrayContaining(["Work in it · unarchive it first (off)", "Pin to the rail · unarchive it first (off)", "Unarchive · back among the projects", "Import a folder here… · copies it in"]));
    expect(archived.some((l) => l.startsWith("Make a root folder"))).toBe(false);
    // where one works already, Work in it would change nothing: not drawn
    const working = menuOf({ kind: "project", hasRoot: true, pinned: true, working: true });
    expect(working.some((l) => l.startsWith("Work in it"))).toBe(false);
    expect(working).toContain("Unpin from the rail");
    expect(menuOf({ kind: "inbox", pinsFull: true })).toEqual(["Work in it", "Show in Projects", "Pin to the rail · the rail holds four (off)", "—", "Add a folder"]);
    // a project's tree, scoped, keeps only the ways to add a folder: flat there, not one submenu alone
    expect(menuOf({ kind: "inbox" }, ["open", "show", "pin"])).toEqual(["New folder inside…", "Import a folder here… · copies it in", "Link a disk folder… · used in place"]);
  });

  it("has one Rename (F2) for every kind that is renamed, one Delete (Del) for every kind that is deleted", () => {
    for (const kind of Object.keys(MENUS) as MenuKind[]) {
      const specs = MENUS[kind].flatMap((s) => (s === "—" ? [] : [s]));
      const renames = specs.filter((s) => s.id === "rename");
      const deletes = specs.filter((s) => s.id === "delete");
      expect(renames.length, kind).toBe(kind === "inbox" ? 0 : 1);
      for (const r of renames) expect([r.label, r.key]).toEqual(["Rename…", "F2"]);
      expect(deletes.length, kind).toBe(kind === "inbox" || kind === "linked" ? 0 : 1);
      for (const d of deletes) expect([d.label, d.key, d.danger]).toEqual(["Delete…", "Del", true]);
      expect(specs[0]!.key, kind).toBe("Enter");
    }
  });

  it("draws the keys only where they act", () => {
    const keys = (keys: boolean) => toMenu(kindActions({ kind: "draft" }, runs, subs), keys).flatMap((it) => (it === "—" || !it.key ? [] : [it.key]));
    expect(keys(true)).toEqual(["Enter", "F2", "Del"]);
    expect(keys(false)).toEqual([]);
  });
});

describe("the list in the command bar", () => {
  it("makes a submenu a row per target that takes it, named after the action", () => {
    const rows = toBar(kindActions({ kind: "timeline", clips: 2, unused: null }, runs, subs)).map((r) => r.label);
    expect(rows).toEqual([
      "Open", "Show in Projects", "Render all", "Finish…", "Export…", "Fix all", "Rename…",
      "Put in B-roll", "Put in the project's root", "Move to Client work", "Move to the Inbox",
      "Delete…",
    ]);
  });
});

describe("the one Delete question", () => {
  it("asks in the mock's words, for one or several", () => {
    expect(deleteQuestion("timeline", ["Rooftop chase"])).toEqual({ title: "Delete Rooftop chase?", text: "Its videos stay in your library; only the sequence goes. A deleted timeline cannot be restored from the bin.", yes: "Delete" });
    expect(deleteQuestion("draft", ["Neon market at dusk"]).text).toBe("It goes with its form and its conversation with the designer. What was made from it stays in your library. A deleted draft cannot be restored from the bin.");
    expect(deleteQuestion("draft", ["a", "b", "c"]).title).toBe("Delete these 3 drafts?");
    expect(deleteQuestion("folder", ["Rushes"]).text).toBe("Its items move to the folder above it. A deleted folder cannot be restored from the bin.");
  });

  it("is asked from one place only: no menu writes its own Delete or Rename line for these kinds", () => {
    for (const f of ["screens/studio/TimelineCards.tsx", "screens/studio/DraftMenu.tsx", "screens/studio/DraftHeader.tsx", "projects/useRowMenus.tsx", "bar/actions/tree.tsx"]) {
      const text = readFileSync(join(SRC, f), "utf8");
      expect(text, f).not.toMatch(/label: "(Delete…|Rename…?|Bin unused takes…|Move to)"/);
      expect(text, f).not.toMatch(/title: "Delete this draft\?"/);
    }
  });
});
