import { describe, expect, it } from "vitest";
import { fold, focusBehindMenu, keyedRow, menuHearsKeys, menuStep, pressedKeys, type MenuItem } from "../src/ContextMenu";
import { commandExtra } from "../src/bar/useBarData";
import type { Item } from "../src/bar/items";

/** An element as far as the menu asks: which of the selectors it sits under. */
const el = (...under: string[]) => ({ closest: (sel: string) => (sel.split(",").some((s) => under.includes(s.trim())) ? {} : null) }) as unknown as Element;

describe("a right-click menu's keys", () => {
  // items 0 and 3 can run; 1 is a rule, 2 is off
  const runnable = [0, 3];

  it("walks the items that can run, round, and Home and End go to the ends", () => {
    expect(menuStep("ArrowDown", runnable, 0, false)).toEqual({ do: "move", to: 3 });
    expect(menuStep("ArrowDown", runnable, 3, false)).toEqual({ do: "move", to: 0 });
    expect(menuStep("ArrowUp", runnable, 0, false)).toEqual({ do: "move", to: 3 });
    // opened with the mouse: nothing active yet, the first ↓ goes to the first item
    expect(menuStep("ArrowDown", runnable, -1, false)).toEqual({ do: "move", to: 0 });
    expect(menuStep("End", runnable, 0, false)).toEqual({ do: "move", to: 3 });
    expect(menuStep("Home", runnable, 3, false)).toEqual({ do: "move", to: 0 });
  });

  it("runs the active item on Enter and on Space (a ticked item toggles as a check box does)", () => {
    expect(menuStep("Enter", runnable, 3, false)).toEqual({ do: "choose" });
    expect(menuStep(" ", runnable, 3, false)).toEqual({ do: "choose" });
    // nothing active: Space and Enter are left alone
    expect(menuStep(" ", runnable, -1, false)).toBeNull();
  });

  it("closes on Escape and Tab; in a submenu Escape and ← go back to its parent", () => {
    expect(menuStep("Escape", runnable, 0, false)).toEqual({ do: "close" });
    expect(menuStep("Tab", runnable, 0, false)).toEqual({ do: "close" });
    expect(menuStep("Escape", runnable, 0, true)).toEqual({ do: "back" });
    expect(menuStep("ArrowLeft", runnable, 0, true)).toEqual({ do: "back" });
    expect(menuStep("ArrowLeft", runnable, 0, false)).toBeNull();
    expect(menuStep("ArrowRight", runnable, 0, false)).toEqual({ do: "sub" });
  });

  it("leaves other keys to the page", () => {
    expect(menuStep("k", runnable, 0, false)).toBeNull();
  });

  it("stands aside while the focus is in a modal that is not the menu (the command bar opened over it)", () => {
    expect(menuHearsKeys(el('[role="dialog"][aria-modal="true"]'))).toBe(false);
    expect(menuHearsKeys(el("[data-context-menu]"))).toBe(true);
    // a menu opened from inside a dialog (the viewer) has the focus itself: it hears its keys
    expect(menuHearsKeys(el("[data-context-menu]", '[role="dialog"][aria-modal="true"]'))).toBe(true);
    expect(menuHearsKeys(el())).toBe(true);
    expect(menuHearsKeys(null)).toBe(true);
  });

  it("tells a modal opened over the menu where the focus was: nowhere once the menu is closed", () => {
    // no menu open: the menu itself is not an answer
    expect(focusBehindMenu(el("[data-context-menu]"))).toBeNull();
  });
});

describe("the bar's preview of a command", () => {
  const row = (over: Partial<Item>): Item => ({ key: "cmd:render-clips:1", kind: "command", label: "Render clips 1", meta: "Queues clip 1", verb: "run", ...over }) as Item;

  it("says the estimate, the clips and the timeline of a render command", () => {
    const extra = commandExtra(row({ command: { cmd: "render-clips", clips: [1, 2] } as Item["command"] }), { ms: 90_000, basis: 3, ahead: 1 } as never, { id: "t", name: "zz-test" });
    expect(extra?.text).toBe("Queues clip 1");
    expect(extra?.facts.map((f) => f.k)).toEqual(["estimate", "queue ahead", "clips", "timeline"]);
    expect(extra?.facts.find((f) => f.k === "clips")?.v).toBe("1, 2");
  });

  it("says nothing of a row that is not a command", () => {
    expect(commandExtra(row({ kind: "timeline" }), undefined, null)).toBeUndefined();
    expect(commandExtra(null, undefined, null)).toBeUndefined();
  });
});

describe("a row's key in an open menu", () => {
  const press = (key: string, mods: { shift?: boolean; ctrl?: boolean } = {}) => pressedKeys({ key, shiftKey: Boolean(mods.shift), ctrlKey: Boolean(mods.ctrl), altKey: false, metaKey: false });
  const ran: string[] = [];
  const row = (label: string, key?: string, more: Partial<Extract<MenuItem, object>> = {}): MenuItem => ({ label, key, run: () => ran.push(label), ...more });
  const items: MenuItem[] = [
    row("Open", "Enter"),
    row("Keep", "S"),
    "—",
    row("Reuse · new seed", "Shift+L"),
    row("Off", "V", { disabled: true }),
    { label: "Passes", items: [row("Upscale 2x", "U"), row("Face refine", "F")] },
    { label: "Off family", disabled: true, items: [row("Hidden", "H")] },
    row("Select", "Ctrl+click"),
    row("Move to the bin", "Del"),
  ];
  const hit = (pressed: string[]) => (keyedRow(items, pressed) as { label: string } | null)?.label ?? null;

  it("writes a key press in the keys' grammar", () => {
    expect(press("s")).toEqual(["S"]);
    expect(press("L", { shift: true })).toEqual(["Shift+L"]);
    expect(press("Backspace")).toEqual(["Backspace", "Del"]);
    expect(press("?", { shift: true })).toEqual(["?"]);
    expect(press("Enter", { ctrl: true })).toEqual(["Ctrl+Enter"]);
  });

  it("runs the row whose key it is, in a submenu too; never one that is off, nor the menu's own keys", () => {
    expect(hit(press("s"))).toBe("Keep");
    expect(hit(press("l"))).toBeNull();
    expect(hit(press("L", { shift: true }))).toBe("Reuse · new seed");
    expect(hit(press("u"))).toBe("Upscale 2x");
    expect(hit(press("Backspace"))).toBe("Move to the bin");
    // off, or in a submenu that is off
    expect(hit(press("v"))).toBeNull();
    expect(hit(press("h"))).toBeNull();
    // Enter runs the row the arrows are on; a mouse move is no key
    expect(hit(press("Enter"))).toBeNull();
    expect(hit(["Ctrl+click"])).toBeNull();
  });
});

describe("a family of rows as a submenu", () => {
  const rows: MenuItem[] = [{ label: "Details", run: () => {} }, { label: "Copy the seed", run: () => {} }, { label: "Open in ComfyUI", disabled: true, note: "ComfyUI is offline", run: () => {} }];

  it("folds 3 or more into one row, and leaves fewer flat", () => {
    expect(fold("Info", null, rows)).toEqual([{ label: "Info", icon: null, disabled: false, note: undefined, items: rows }]);
    expect(fold("Info", null, rows.slice(0, 2))).toEqual(rows.slice(0, 2));
    expect(fold("Make a video", null, rows.slice(0, 2), 2)).toHaveLength(1);
  });

  it("is off, with its first row's reason, when none of its rows works", () => {
    const off = rows.map((r) => (r === "—" ? r : { ...r, disabled: true, note: r.note ?? "reading…" }));
    expect(fold("Info", null, off)[0]).toMatchObject({ disabled: true, note: "reading…" });
  });
});
