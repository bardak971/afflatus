import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MenuItem } from "../src/ContextMenu";
import { ACTIONS, actionIds, itemActions, keysShown, ORDER, PASSES, placeMenu, sideGroups, sideSlot, stageBar, toMenu, type ActionId, type ItemFacts, type Kind, type Place, type Runs } from "../src/itemActions";
import { parseKeys } from "../src/keys/grammar";
import { PLACES } from "../src/keys/table";

const SRC = join(import.meta.dirname, "../src");

/** An item for which everything works: every model there, ComfyUI on, a list to compare in. */
const facts = (kind: Kind, more: Partial<ItemFacts> = {}): ItemFacts => ({
  kind, inBin: false, kept: false, hasSound: true, reading: false, madeHere: true, generated: true, seed: 42,
  opener: "Wan", carrier: true, passes: { upscale: "u", face: "f", background: "b", inpaint: "i", edit: "e", outpaint: "r" }, voice: true,
  comfyOnline: true, compare: true,
  timelines: [{ label: "Add to Harbor", run: () => {} }], moves: [{ label: "The Inbox", run: () => {} }],
  ...more,
});
const runs: Runs = Object.fromEntries(ORDER.map((id) => [id, () => {}]));

/** A menu's lines as "label" (a submenu: its lines after "Passes ›"), rules as "—". */
const lines = (items: MenuItem[]): string[] => items.flatMap((it) => (it === "—" ? ["—"] : it.label === PASSES && it.items ? it.items.map((x) => (x === "—" ? "—" : `${PASSES} › ${x.label}`)) : [it.label]));

describe("the item's list", () => {
  it("holds each media type's actions in the spec's order", () => {
    expect(actionIds("image")).toEqual(["open", "keep", "download", "rename", "reuse-same", "reuse-new", "variation", "i2v", "upscale", "face", "background", "inpaint", "edit", "outpaint", "mirror-h", "mirror-v", "compare", "details", "copy-seed", "comfy", "timeline", "move", "bin"]);
    expect(actionIds("video")).toEqual(["open", "keep", "download", "rename", "reuse-same", "reuse-new", "variation", "extend", "trim", "save-frame", "extract-audio", "voice", "compare", "details", "copy-seed", "comfy", "timeline", "move", "bin"]);
    expect(actionIds("audio")).toEqual(["open", "keep", "download", "rename", "reuse-same", "reuse-new", "variation", "voice", "details", "copy-seed", "comfy", "timeline", "move", "bin"]);
  });

  it("gives each action one label, used by no other", () => {
    const labels = ORDER.map((id) => ACTIONS[id].label);
    expect(new Set(labels).size).toBe(labels.length);
    // the one wording of each, where three were before
    expect(ACTIONS["save-frame"].label).toBe("Save frame");
    expect(ACTIONS.download.label).toBe("Download");
    expect(ACTIONS.variation.label).toBe("Variation");
    expect(ACTIONS.details.label).toBe("Details");
  });

  it("writes every key in the grammar, and lists each in the viewer's keys", () => {
    const viewer = PLACES.find((p) => p.id === "viewer")!;
    const listed = new Set(viewer.groups.flatMap((g) => g.rows.map((r) => r.keys)));
    for (const id of ORDER) {
      const key = ACTIONS[id].key;
      if (!key || id === "open") continue;
      expect(parseKeys(key), id).not.toBeNull();
      expect(listed.has(key), `${id}: ${key}`).toBe(true);
    }
  });

  it("keeps an action that does not apply now in its place, off, with the reason", () => {
    const list = itemActions(facts("video", { hasSound: false, carrier: false, comfyOnline: false }), runs);
    expect(list.map((a) => a.id)).toEqual(actionIds("video"));
    const off = Object.fromEntries(list.filter((a) => a.disabled).map((a) => [a.id, a.note]));
    expect(off).toEqual({ extend: "no video model carries a clip on", "extract-audio": "it has no sound", voice: "it has no sound", comfy: "ComfyUI is offline" });
  });

  it("lets only Open, Download, Compare and Put back work in the bin", () => {
    for (const kind of ["image", "video", "audio"] as const) {
      const list = itemActions(facts(kind, { inBin: true }), runs);
      expect(list.filter((a) => !a.disabled).map((a) => a.id)).toEqual(["open", "download", ...(kind === "audio" ? [] : ["compare" as const]), "bin"]);
      expect(list.at(-1)).toMatchObject({ label: "Put back", key: undefined });
      expect(list.at(-1)!.danger).toBeFalsy();
    }
  });

  it("says why Reuse cannot, until the parameters are read and when it was not made here", () => {
    expect(itemActions(facts("image", { reading: true, generated: false, madeHere: false, seed: null }), runs).find((a) => a.id === "variation")!.note).toBe("reading…");
    const imported = itemActions(facts("image", { generated: false, madeHere: false, seed: null }), runs);
    expect(imported.filter((a) => a.disabled).map((a) => [a.id, a.note])).toEqual([
      ["reuse-same", "not generated here"], ["reuse-new", "not generated here"], ["variation", "not generated here"], ["copy-seed", "no seed"], ["comfy", "not generated here"],
    ]);
  });
});

describe("every place shows the same list", () => {
  const own: Record<Place, MenuItem[]> = {
    grid: [{ label: "Use in this draft", items: [] }, { label: "Select", key: "Ctrl+click", run: () => {} }],
    stage: [{ label: "Use in this draft", items: [] }],
    viewer: [{ label: "Use in this draft", items: [] }],
    inline: [],
    shelf: [{ label: "Use in clip 3", items: [] }, { label: "Place on the timeline", items: [] }, "—"],
    projects: [{ label: "Show in the Studio", run: () => {} }],
    command: [{ label: "Show in its folder", run: () => {} }],
    queue: [{ label: "Open its draft", run: () => {} }, { label: "Requeue", run: () => {} }, { label: "Remove from the history", run: () => {} }],
  };
  for (const kind of ["image", "video", "audio"] as const) {
    it(`a ${kind}: after its own first section, each place's menu is the list, the passes in a submenu`, () => {
      const list = itemActions(facts(kind), runs);
      const shared = lines(toMenu(list, "viewer"));
      for (const place of Object.keys(own) as Place[]) {
        const menu = placeMenu(own[place], list, place);
        const head = own[place].filter((x) => x !== "—").length;
        expect(lines(menu).slice(head + (head ? 1 : 0)), place).toEqual(shared);
      }
      // the groups apart, in order; the passes folded for a picture
      if (kind === "image") expect(shared.slice(0, 13)).toEqual(["Open", "Keep", "Download", "Rename…", "—", "Reuse · same seed", "Reuse · new seed", "Variation", "Image to video (i2v)", "—", "Passes › Upscale 2x", "Passes › Face detailer", "Passes › Remove background"]);
    });
  }

  it("draws a key only where it acts", () => {
    expect(keysShown("grid", "keep")).toBe(false);
    expect(keysShown("shelf", "variation")).toBe(false);
    expect(keysShown("queue", "download")).toBe(false);
    expect(keysShown("projects", "keep")).toBe(true);
    expect(keysShown("projects", "variation")).toBe(false);
    expect(keysShown("viewer", "variation")).toBe(true);
    expect(keysShown("viewer", "open")).toBe(false);
    expect(keysShown("inline", "rename")).toBe(false);
    expect(keysShown("command", "open")).toBe(true);
    const grid = toMenu(itemActions(facts("image"), runs), "grid");
    expect(grid.some((x) => x !== "—" && x.key)).toBe(false);
  });

  it("puts each action once in the stage's bar: the row, Passes, ··· or the bin", () => {
    for (const kind of ["image", "video", "audio"] as const) {
      const list = itemActions(facts(kind), runs);
      const bar = stageBar(list);
      const placed = [...bar.passes, ...bar.more, ...(bar.bin ? [bar.bin] : []), ...bar.row.filter((a) => !bar.passes.includes(a))].map((a) => a.id);
      expect([...placed].sort(), kind).toEqual(list.map((a) => a.id).sort());
      expect(new Set(placed).size).toBe(placed.length);
    }
    expect(stageBar(itemActions(facts("image"), runs)).row.map((a) => a.label)).toEqual(["Keep", "Variation", "Upscale 2x", "Compare"]);
    expect(stageBar(itemActions(facts("video"), runs)).row.map((a) => a.label)).toEqual(["Keep", "Variation", "Trim", "Compare"]);
    expect(stageBar(itemActions(facts("audio"), runs)).row.map((a) => a.label)).toEqual(["Keep", "Variation"]);
    expect(stageBar(itemActions(facts("audio"), runs)).passes).toEqual([]);
  });

  it("gives every action a place in the viewer's side, but Open", () => {
    const none = ORDER.filter((id) => sideSlot(id) === "none");
    expect(none).toEqual(["open"]);
  });

  it("leaves no place a list of its own: the places' files write none of the list's labels", () => {
    const places = ["TileMenu.tsx", "Viewer.tsx", "viewer/ViewerSidebar.tsx", "viewer/ViewerHeader.tsx", "viewer/useViewerActions.tsx", "projects/useItemMenu.tsx", "bar/useActions.tsx", "screens/queue/History.tsx", "timeline/MediaOverlay.tsx", "screens/studio/DraftResults.tsx"];
    const ids: ActionId[] = ["download", "reuse-same", "reuse-new", "variation", "i2v", "extend", "upscale", "face", "background", "inpaint", "edit", "outpaint", "trim", "save-frame", "extract-audio", "voice", "compare", "details"];
    const found = places.flatMap((file) => {
      const code = readFileSync(join(SRC, file), "utf8");
      return ids.filter((id) => code.includes(`label: "${ACTIONS[id].label}"`) || code.includes(`label="${ACTIONS[id].label}"`)).map((id) => `${file}: ${ACTIONS[id].label}`);
    });
    expect(found).toEqual([]);
  });
});

describe("the viewer's side", () => {
  it("shows the buttons in the list's groups, Download last in Look", () => {
    const run = () => {};
    const all = Object.fromEntries(ORDER.map((id) => [id, run]));
    const groups = sideGroups(itemActions({
      kind: "image", inBin: false, kept: false, hasSound: false, reading: false, madeHere: true, generated: true, seed: 1, opener: "Wan", carrier: false,
      passes: { upscale: "u" }, voice: false, comfyOnline: true, compare: true, timelines: [], moves: [],
    }, all));
    expect(groups.map((g) => g.group)).toEqual(["make", "passes", "look"]);
    expect(groups.at(-1)!.actions.map((a) => a.id)).toEqual(["compare", "details", "download"]);
  });
});
