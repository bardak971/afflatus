import { describe, expect, it } from "vitest";
import { focusBehindMenu, menuHearsKeys, menuStep } from "../src/ContextMenu";
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
