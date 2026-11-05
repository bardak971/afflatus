import { describe, expect, it } from "vitest";
import { keyedRow, runKeyed, type MenuItem } from "../src/ContextMenu";
import { ACTIONS, actionOfKey, itemActions, keyOfEvent, runByKey, toMenu, type ActionId, type ItemFacts, type TuneAt } from "../src/itemActions";
import { TUNED_ROWS } from "../src/passTune";
import { PLACES } from "../src/keys/table";

/** B and Remove background (card #315, the owner's call): its key opens its settings, Enter queues from them; a click still queues. */

const AT: TuneAt = { left: 1, top: 2, width: 3, height: 4 };

const facts: ItemFacts = {
  kind: "image", inBin: false, kept: false, hasSound: false, reading: false, madeHere: true, generated: true, seed: 42, prompt: "a harbour at dawn",
  opener: "Wan", mover: "SCAIL-2", carrier: true, passes: { upscale: "u", background: "b" }, voice: false, comfyOnline: true, compare: true,
  timelines: [], moves: [],
};

/** The list with every run and tune counted, by action. */
function counted() {
  const ran: ActionId[] = [];
  const tuned: Array<{ id: ActionId; at: TuneAt }> = [];
  const ids: ActionId[] = ["upscale", "background"];
  const runs = Object.fromEntries(ids.map((id) => [id, () => ran.push(id)]));
  const tunes = Object.fromEntries(ids.map((id) => [id, (at: TuneAt) => tuned.push({ id, at })]));
  return { list: itemActions(facts, runs, {}, tunes), ran, tuned };
}

describe("B in the viewer and on the Stage", () => {
  it("opens Remove background's settings and queues nothing; U still queues its upscale at once", () => {
    const { list, ran, tuned } = counted();
    const b = actionOfKey(list, "viewer", keyOfEvent({ key: "b", shiftKey: false }))!;
    expect(b.id).toBe("background");
    runByKey(b, () => AT);
    expect(ran).toEqual([]);
    expect(tuned).toEqual([{ id: "background", at: AT }]);
    runByKey(actionOfKey(list, "stage", keyOfEvent({ key: "u", shiftKey: false }))!, () => AT);
    expect(ran).toEqual(["upscale"]);
  });

  it("has the model to pick in its popover", () => {
    expect(TUNED_ROWS.background).toEqual(["model"]);
  });
});

describe("B in a menu of the library", () => {
  it("opens the settings next to the row, and queues nothing", () => {
    const { list, ran, tuned } = counted();
    const menu: MenuItem[] = toMenu(list, "grid");
    const row = keyedRow(menu, ["B"])!;
    expect(row.label).toBe("Remove background");
    expect(row.keyTunes).toBe(true);
    runKeyed(row, AT);
    expect(ran).toEqual([]);
    expect(tuned.map((x) => x.id)).toEqual(["background"]);
    // another pass's key still runs it from the menu
    const u = keyedRow(menu, ["U"])!;
    expect(u.keyTunes).toBeUndefined();
    runKeyed(u, AT);
    expect(ran).toEqual(["upscale"]);
  });
});

describe("what B is said to do", () => {
  it("is no longer queued at once, in the keys sheet nor in the button's tip", () => {
    const rows = PLACES.flatMap((p) => p.groups.flatMap((g) => g.rows));
    const b = rows.find((r) => r.does === "Remove background")!;
    expect(b.note).not.toMatch(/^queued at once/);
    expect(b.note).toMatch(/Enter queues it/);
    expect(ACTIONS.background.tip).toMatch(/B, Shift\+click or ▾/);
  });
});
