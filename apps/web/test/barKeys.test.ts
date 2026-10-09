import { describe, expect, it } from "vitest";
import { COMMAND_KEYS, commandKeys, keyItems, navItems, templateItems } from "../src/bar/items";
import { MODE_KEYS, modeOf, type CommandId } from "../src/bar/parse";
import { allRows, searchKeys } from "../src/keys/search";
import { PLACES, rowKeys, type RowId } from "../src/keys/table";

const ROWS = PLACES.reduce((n, p) => n + p.groups.reduce((m, g) => m + g.rows.length, 0), 0);

describe("the bar's ? mode", () => {
  it("is opened by a ? typed first", () => {
    expect(MODE_KEYS["?"]).toBe("keys");
    expect(modeOf("?split")).toEqual({ mode: "keys", text: "split" });
    expect(modeOf("? ctrl z")).toEqual({ mode: "keys", text: "ctrl z" });
    expect(modeOf("?")).toEqual({ mode: "keys", text: "" });
    // only first: a question mark further on is part of the search
    expect(modeOf("what?").mode).toBe("all");
  });

  it("lists every row of the table with nothing typed, the open places first", () => {
    const rows = allRows(["editor", "everywhere"]);
    expect(rows).toHaveLength(ROWS);
    expect(rows[0]!.place.id).toBe("editor");
    expect(rows[0]!.here).toBe(true);
    // Everywhere is always open: never marked as here
    expect(rows.find((f) => f.place.id === "everywhere")!.here).toBe(false);
  });

  it("finds by words the rows the sheet finds, each with its keys and its place", () => {
    const found = searchKeys("split", ["everywhere"], "Ctrl+K")!;
    expect(found.kq).toBeNull();
    const items = keyItems(found.all, "Ctrl+K");
    const split = items.find((i) => i.label === "Split at the playhead")!;
    expect(split.keys).toBe("S | Ctrl+B");
    expect(split.meta).toContain("Timeline editor");
    expect(split.keyRow).toMatchObject({ place: "editor", row: "editor:Clips:1" });
  });

  it("finds a key first, the open places first, and lights the caps it matched", () => {
    const found = searchKeys("s", ["editor", "everywhere"], "Ctrl+K")!;
    expect(found.kq).not.toBeNull();
    // S itself before the keys that only start with it (Shift, Space), and the open editor's S before the viewer's
    const first = found.keys[0]!;
    expect(first.place.id).toBe("editor");
    expect(first.row.does).toBe("Split at the playhead");
    expect(found.keys.findIndex((f) => f.hits?.[0]?.key === "Shift")).toBeGreaterThan(found.keys.findIndex((f) => f.place.id === "viewer"));
    expect(keyItems([first], "Ctrl+K")[0]!.keyRow!.hits).toEqual([{ way: 0, chord: 0, key: "S" }]);
  });

  it("lights Redo's Ctrl+Shift+Z for ctrl z, not its other way Ctrl+Y", () => {
    const found = searchKeys("ctrl z", ["everywhere"], "Ctrl+K")!;
    const redo = found.keys.find((f) => f.row.keys === "Ctrl+Shift+Z | Ctrl+Y");
    expect(redo, "a row Ctrl+Shift+Z | Ctrl+Y in the table").toBeDefined();
    expect(redo!.hits!.every((h) => h.way === 0)).toBe(true);
  });

  it("draws the bar's own row with the shortcut the settings recorded", () => {
    const found = searchKeys("command bar", ["everywhere"], "Ctrl+Shift+P")!;
    expect(keyItems(found.all, "Ctrl+Shift+P").find((i) => i.label === "Command bar")!.keys).toBe("Ctrl+Shift+P");
  });

  it("is empty for an empty search (the bar then lists every row)", () => {
    expect(searchKeys("  ", [], "Ctrl+K")).toBeNull();
  });
});

describe("the keys on the bar's rows", () => {
  it("reads every command's key from a row of the key table that exists", () => {
    for (const [cmd, at] of Object.entries(COMMAND_KEYS)) expect(rowKeys(at!.row, at!.half), cmd).toBeTruthy();
  });

  it("gives split and the takes the keys the app uses for them", () => {
    expect(commandKeys({ cmd: "split" })).toBe("S | Ctrl+B");
    expect(commandKeys({ cmd: "previous-take" })).toBe("Alt+[");
    expect(commandKeys({ cmd: "next-take" })).toBe("Alt+]");
    expect(commandKeys({ cmd: "pause" })).toBeUndefined();
    expect(commandKeys({ cmd: "export" })).toBeUndefined();
  });

  it("says no Ctrl+Enter on Generate and rendering a clip: in the bar it runs a row's second action", () => {
    expect(commandKeys({ cmd: "generate" })).toBeUndefined();
    expect(commandKeys({ cmd: "render-clips", clips: [3] })).toBeUndefined();
    expect(Object.values(COMMAND_KEYS).map((at) => rowKeys(at!.row, at!.half))).not.toContain("Ctrl+Enter");
  });

  it("puts the keys on the command and place rows that have one", () => {
    const templates = new Map(templateItems().map((t) => [t.key.slice(4) as CommandId, t]));
    expect(templates.get("split")!.keys).toBe("S | Ctrl+B");
    expect(templates.get("render-clips")!.keys).toBeUndefined();
    const nav = navItems([]);
    expect(nav.find((n) => n.key === "nav:keys")!.keys).toBe("?");
    expect(nav.filter((n) => n.keys).map((n) => n.key)).toEqual(["nav:keys"]);
  });

  it("takes one chord of a pair", () => {
    expect(rowKeys("take" as RowId)).toBe("Alt+[ Alt+]");
    expect(rowKeys("take", 0)).toBe("Alt+[");
    expect(rowKeys("take", 1)).toBe("Alt+]");
  });
});
