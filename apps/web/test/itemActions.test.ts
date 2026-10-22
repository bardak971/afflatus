import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MenuItem } from "../src/ContextMenu";
import { ACTIONS, actionIds, itemActions, keyOfEvent, keysShown, ORDER, PASSES, placeMenu, sentPrompt, sideGroups, sideSlot, stageBar, toMenu, type ActionId, type ItemFacts, type Kind, type Place, type Runs } from "../src/itemActions";
import { parseKeys } from "../src/keys/grammar";
import { PLACES } from "../src/keys/table";

const SRC = join(import.meta.dirname, "../src");

/** An item for which everything works: every model there, ComfyUI on, a list to compare in. */
const facts = (kind: Kind, more: Partial<ItemFacts> = {}): ItemFacts => ({
  kind, inBin: false, kept: false, hasSound: true, reading: false, madeHere: true, generated: true, seed: 42, prompt: "a harbour at dawn",
  opener: "Wan", mover: "SCAIL-2", carrier: true, passes: { upscale: "u", face: "f", hand: "h", background: "b", inpaint: "i", edit: "e", outpaint: "r" }, voice: true,
  comfyOnline: true, compare: true,
  timelines: [{ label: "Add to Harbor", run: () => {} }], moves: [{ label: "The Inbox", run: () => {} }],
  ...more,
});
const runs: Runs = Object.fromEntries(ORDER.map((id) => [id, () => {}]));

/** The submenus the list folds into, by their row's label (the Timeline, Move to and Send to of the list are its own). */
const FOLDS = [PASSES, "Make a video", "Video tools", "Info"];
/** A menu's lines as "label" (a submenu of the list: its lines after "Passes ›"), rules as "—". */
const lines = (items: MenuItem[]): string[] => items.flatMap((it) => (it === "—" ? ["—"] : FOLDS.includes(it.label) && it.items ? it.items.map((x) => (x === "—" ? "—" : `${it.label} › ${x.label}`)) : [it.label]));
/** A menu's top rows, by label, rules left out: what the eye goes down. */
const top = (items: MenuItem[]): string[] => items.flatMap((it) => (it === "—" ? [] : [it.items ? `${it.label} ›` : it.label]));

describe("the item's list", () => {
  it("holds each media type's actions in the spec's order", () => {
    expect(actionIds("image")).toEqual(["open", "keep", "download", "rename", "reuse-same", "reuse-new", "variation", "i2v", "motion", "upscale", "face", "hand", "background", "inpaint", "edit", "outpaint", "mirror-h", "mirror-v", "compare", "details", "copy-seed", "copy-prompt", "comfy", "timeline", "move", "send", "bin"]);
    expect(actionIds("video")).toEqual(["open", "keep", "download", "rename", "reuse-same", "reuse-new", "variation", "extend", "motion", "trim", "save-frame", "extract-audio", "remove-sound", "voice", "compare", "details", "copy-seed", "copy-prompt", "comfy", "timeline", "move", "send", "bin"]);
    expect(actionIds("audio")).toEqual(["open", "keep", "download", "rename", "reuse-same", "reuse-new", "variation", "trim", "voice", "details", "copy-seed", "copy-prompt", "comfy", "timeline", "move", "bin"]);
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
    // a row's keys may be several ways to the same ("Del | Backspace"): each one is listed
    const listed = new Set(viewer.groups.flatMap((g) => g.rows.flatMap((r) => [r.keys, ...r.keys.split("|").map((k) => k.trim())])));
    for (const id of ORDER) {
      const key = ACTIONS[id].key;
      if (!key || id === "open") continue;
      expect(parseKeys(key), id).not.toBeNull();
      expect(listed.has(key), `${id}: ${key}`).toBe(true);
    }
  });

  it("reads Shift with a letter as a key of its own, never as the letter alone", () => {
    expect(keyOfEvent({ key: "H", shiftKey: true })).toBe("Shift+H");
    expect(keyOfEvent({ key: "u", shiftKey: false })).toBe("U");
    expect(keyOfEvent({ key: "U", shiftKey: true })).toBe("Shift+U");
    expect(keyOfEvent({ key: "Delete", shiftKey: true })).toBe("Del");
    // Backspace is Del wherever Del works
    expect(keyOfEvent({ key: "Backspace", shiftKey: false })).toBe("Del");
    expect(keyOfEvent({ key: "?", shiftKey: true })).toBe("?");
  });

  it("keeps an action the user can make work in its place, off, with the reason; leaves out what never can", () => {
    const list = itemActions(facts("video", { hasSound: false, carrier: false, comfyOnline: false, shares: [{ label: "Telegram", run: () => {} }] }), runs);
    // a video without sound has none to take, nor a voice to give
    expect(list.map((a) => a.id)).toEqual(actionIds("video").filter((id) => !["extract-audio", "remove-sound", "voice"].includes(id)));
    const off = Object.fromEntries(list.filter((a) => a.disabled).map((a) => [a.id, a.note]));
    // a model to install, ComfyUI to start: the user can
    expect(off).toEqual({ extend: "no video model carries a clip on", comfy: "ComfyUI is offline" });
    expect(itemActions(facts("video", { voice: false }), runs).find((a) => a.id === "voice")).toMatchObject({ disabled: true, note: "no model takes a voice sample" });
  });

  it("lists only the bin's own in the bin: Put back first, then Open, Download and Compare, Delete now last", () => {
    for (const kind of ["image", "video", "audio"] as const) {
      const list = itemActions(facts(kind, { inBin: true }), { ...runs, erase: () => {} });
      expect(list.map((a) => a.id)).toEqual(["bin", "open", "download", ...(kind === "audio" ? [] : ["compare" as const]), "erase"]);
      expect(list.filter((a) => a.disabled)).toEqual([]);
      expect(list[0]).toMatchObject({ label: "Put back", key: undefined });
      expect(list[0]!.danger).toBeFalsy();
      expect(list.at(-1)).toMatchObject({ label: "Delete now…", danger: true });
    }
    // where Delete now is not run, it is not there (never a dead row)
    expect(itemActions(facts("image", { inBin: true }), runs).map((a) => a.id)).not.toContain("erase");
  });

  it("says why Reuse cannot while the parameters are read or its model is gone; leaves it out of what was not made here", () => {
    const madeHere: ActionId[] = ["reuse-same", "reuse-new", "variation", "copy-seed", "copy-prompt", "comfy"];
    const reading = itemActions(facts("image", { reading: true, generated: false, madeHere: false, seed: null, prompt: null }), runs);
    expect(reading.filter((a) => madeHere.includes(a.id)).map((a) => [a.id, a.note])).toEqual(madeHere.map((id) => [id, "reading…"]));
    // the listing says it has no render: nothing that needs one, even while it is read
    const listed = itemActions(facts("image", { reading: true, generated: false, madeHere: false, seed: null, prompt: null, madeElsewhere: true }), runs);
    expect(listed.filter((a) => madeHere.includes(a.id))).toEqual([]);
    const imported = itemActions(facts("image", { generated: false, madeHere: false, seed: null, prompt: null }), runs);
    expect(imported.filter((a) => madeHere.includes(a.id) || a.disabled)).toEqual([]);
    // made here, its model gone since: installing it again brings Reuse back
    const gone = itemActions(facts("image", { generated: false }), runs);
    expect(gone.filter((a) => a.disabled).map((a) => [a.id, a.note])).toEqual([["reuse-same", "its model is not here"], ["reuse-new", "its model is not here"], ["variation", "its model is not here"]]);
  });

  it("leaves out of an imported sound everything a render would give", () => {
    const sound = itemActions(facts("audio", { generated: false, madeHere: false, seed: null, prompt: null, madeElsewhere: true }), runs);
    expect(sound.map((a) => a.id)).toEqual(["open", "keep", "download", "rename", "trim", "voice", "details", "timeline", "move", "bin"]);
    expect(sound.filter((a) => a.disabled)).toEqual([]);
    expect(top(placeMenu([], sound, "grid", [{ label: "Select", key: "Ctrl+click", run: () => {} }]))).toEqual(["Open", "Keep", "Download", "Rename…", "Trim", "Use as voice sample", "Details", "Timeline ›", "Move to ›", "Select", "Move to the bin"]);
  });

  it("leaves out Open where the item is the one shown, and Compare where the place cannot", () => {
    const ids = itemActions(facts("image", { shownHere: true, compare: "open it from a list" }), runs).map((a) => a.id);
    expect(ids).not.toContain("open");
    expect(ids).not.toContain("compare");
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
    queue: [{ label: "Open its draft", run: () => {} }, { label: "Render again", run: () => {} }, { label: "Remove from the history", run: () => {} }],
  };
  for (const kind of ["image", "video", "audio"] as const) {
    it(`a ${kind}: after its own first section, each place's menu is the list, the passes in a submenu`, () => {
      const list = itemActions(facts(kind), runs);
      const shared = lines(toMenu(list, "viewer"));
      // the command bar lays submenus flat by their path: only the passes keep theirs there
      const flat = lines(toMenu(list, "viewer", "passes"));
      for (const place of Object.keys(own) as Place[]) {
        const menu = placeMenu(own[place], list, place);
        const head = own[place].filter((x) => x !== "—").length;
        expect(lines(menu).slice(head + (head ? 1 : 0)), place).toEqual(place === "command" ? flat : shared);
      }
      // the groups apart, in order; the families folded
      if (kind === "image") expect(shared.slice(0, 15)).toEqual(["Open", "Keep", "Download", "Rename…", "—", "Reuse · same seed", "Reuse · new seed", "Variation", "Make a video › Image to video (i2v)", "Make a video › Motion transfer…", "—", "Passes › Upscale 2x", "Passes › Face refine", "Passes › Hand refine", "Passes › Remove background"]);
    });
  }

  it("draws a key only where it acts", () => {
    // a menu runs a row on its key (ContextMenu's keyedRow): every key but Enter, the menu's own
    expect(keysShown("grid", "keep")).toBe(true);
    expect(keysShown("grid", "open")).toBe(false);
    expect(keysShown("shelf", "variation")).toBe(true);
    expect(keysShown("queue", "download")).toBe(true);
    expect(keysShown("projects", "keep")).toBe(true);
    expect(keysShown("projects", "variation")).toBe(true);
    expect(keysShown("viewer", "variation")).toBe(true);
    expect(keysShown("viewer", "open")).toBe(false);
    // on the stage Enter opens it large and F2 asks its name
    expect(keysShown("inline", "rename")).toBe(true);
    expect(keysShown("stage", "open")).toBe(true);
    expect(keysShown("command", "open")).toBe(true);
    // in a menu, a submenu's rows keep their keys
    const grid = toMenu(itemActions(facts("image"), runs), "grid");
    const keyOf = (label: string, items: MenuItem[] = grid): string | undefined => {
      for (const x of items) {
        if (x === "—") continue;
        if (x.label === label) return x.key;
        const inner = x.items && keyOf(label, x.items);
        if (inner) return inner;
      }
      return undefined;
    };
    expect(["Open", "Keep", "Download", "Rename…", "Reuse · new seed", "Upscale 2x", "Image to video (i2v)", "Details", "Copy the prompt", "Move to the bin"].map((l) => keyOf(l)))
      .toEqual([undefined, "S", "D", "F2", "Shift+L", "U", "M", "P", "Shift+C", "Del"]);
  });

  it("folds the families into submenus: a picture's, a video's and a sound's top rows", () => {
    const select: MenuItem[] = [{ label: "Select", key: "Ctrl+click", run: () => {} }];
    const picture = placeMenu([], itemActions(facts("image"), runs), "grid", select);
    expect(top(picture)).toEqual(["Open", "Keep", "Download", "Rename…", "Reuse · same seed", "Reuse · new seed", "Variation", "Make a video ›", "Passes ›", "Info ›", "Timeline ›", "Move to ›", "Select", "Move to the bin"]);
    const video = placeMenu([], itemActions(facts("video"), runs), "grid", select);
    expect(top(video)).toEqual(["Open", "Keep", "Download", "Rename…", "Reuse · same seed", "Reuse · new seed", "Variation", "Make a video ›", "Trim", "Video tools ›", "Info ›", "Timeline ›", "Move to ›", "Select", "Move to the bin"]);
    expect(lines(video).filter((l) => l.startsWith("Video tools ›"))).toEqual(["Video tools › Save frame", "Video tools › Extract audio", "Video tools › Remove sound", "Video tools › Use as voice sample"]);
    expect(lines(video).filter((l) => l.startsWith("Info ›"))).toEqual(["Info › Compare", "Info › Details", "Info › Copy the seed", "Info › Copy the prompt", "Info › Open in ComfyUI"]);
    // fewer than a family's own: flat (a video without sound keeps Save frame alone)
    expect(top(toMenu(itemActions(facts("video", { hasSound: false }), runs), "grid"))).toContain("Save frame");
    // a submenu none of whose rows works is off, with the first one's reason
    const none = toMenu(itemActions(facts("image", { opener: null, mover: null }), runs), "grid").find((x) => x !== "—" && x.label === "Make a video");
    expect(none).toMatchObject({ disabled: true, note: "no video model takes a first frame" });
  });

  it("puts Select with Timeline and Move to, above the bin; in the bin, in a group of its own before Delete now", () => {
    const select: MenuItem[] = [{ label: "Select", key: "Ctrl+click", run: () => {} }];
    const menu = lines(placeMenu([{ label: "Use in this draft", items: [] }], itemActions(facts("image"), runs), "grid", select));
    expect(menu[0]).toBe("Use in this draft");
    expect(menu.slice(-5)).toEqual(["Timeline", "Move to", "Select", "—", "Move to the bin"]);
    const bin = lines(placeMenu([], itemActions(facts("image", { inBin: true }), { ...runs, erase: () => {} }), "grid", select));
    expect(bin.slice(-4)).toEqual(["—", "Select", "—", "Delete now…"]);
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
    expect(stageBar(itemActions(facts("audio"), runs)).row.map((a) => a.label)).toEqual(["Keep", "Variation", "Trim"]);
    expect(stageBar(itemActions(facts("audio"), runs)).passes).toEqual([]);
  });

  it("gives every action a place in the viewer's side, but Open", () => {
    const none = ORDER.filter((id) => sideSlot(id) === "none");
    expect(none).toEqual(["open"]);
  });

  it("leaves no place a list of its own: the places' files write none of the list's labels", () => {
    const places = ["TileMenu.tsx", "Viewer.tsx", "viewer/ViewerSidebar.tsx", "viewer/ViewerHeader.tsx", "viewer/useViewerActions.tsx", "projects/useItemMenu.tsx", "bar/useActions.tsx", "screens/queue/History.tsx", "timeline/MediaOverlay.tsx", "screens/studio/DraftResults.tsx"];
    const ids: ActionId[] = ["download", "reuse-same", "reuse-new", "variation", "i2v", "extend", "upscale", "face", "hand", "background", "inpaint", "edit", "outpaint", "trim", "save-frame", "extract-audio", "remove-sound", "voice", "compare", "details"];
    const found = places.flatMap((file) => {
      const code = readFileSync(join(SRC, file), "utf8");
      return ids.filter((id) => code.includes(`label: "${ACTIONS[id].label}"`) || code.includes(`label="${ACTIONS[id].label}"`)).map((id) => `${file}: ${ACTIONS[id].label}`);
    });
    expect(found).toEqual([]);
  });
});

describe("Copy the prompt", () => {
  it("copies the prompt as sent: one text as it is, the quality tags in front, a form in parts each part under its name", () => {
    const sdxl = [{ id: "prompt", type: "prompt", label: "Prompt" }, { id: "negative", type: "prompt", label: "Negative prompt" }, { id: "quality", type: "prompt", label: "Quality tags" }, { id: "steps", type: "number", label: "Steps" }];
    expect(sentPrompt({ prompt: " a harbour at dawn ", negative: "blurry", steps: 28 }, sdxl)).toBe("a harbour at dawn");
    expect(sentPrompt({ prompt: "a harbour", negative: "blurry", quality: "masterpiece, best quality," }, sdxl)).toBe("masterpiece, best quality, a harbour");
    const h3 = [{ id: "description", type: "prompt", label: "What happens" }, { id: "soundscape", type: "prompt", label: "Sound effects" }, { id: "music", type: "prompt", label: "Music" }];
    expect(sentPrompt({ description: "A boat leaves the harbour.", soundscape: "gulls", music: "" }, h3)).toBe("What happens: A boat leaves the harbour.\n\nSound effects: gulls");
    // its recipe gone: the input named prompt
    expect(sentPrompt({ prompt: "a harbour", steps: 4 })).toBe("a harbour");
    expect(sentPrompt({ negative: "blurry" }, sdxl)).toBeNull();
  });

  it("is in the list next to Copy the seed, its key in the viewer's sheet; off while read, out where there is none", () => {
    const list = itemActions(facts("image"), runs);
    const ids = list.map((a) => a.id);
    expect(ids.indexOf("copy-prompt")).toBe(ids.indexOf("copy-seed") + 1);
    expect(list.find((a) => a.id === "copy-prompt")).toMatchObject({ label: "Copy the prompt", key: "Shift+C", disabled: false });
    expect(itemActions(facts("image", { prompt: null, reading: true }), runs).find((a) => a.id === "copy-prompt")!.note).toBe("reading…");
    expect(itemActions(facts("image", { prompt: null }), runs).map((a) => a.id)).not.toContain("copy-prompt");
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

describe("a pass just queued", () => {
  it("says Queued on its own button for a moment, the others as they were", () => {
    const list = itemActions(facts("image", { queued: { upscale: true } }), runs);
    expect(list.find((a) => a.id === "upscale")).toMatchObject({ label: "Queued", done: true, disabled: false });
    expect(list.find((a) => a.id === "face")).toMatchObject({ label: "Face refine" });
    expect(list.find((a) => a.id === "face")!.done).toBeUndefined();
  });

  it("does not say it where the action is off now (the item went to the bin meanwhile)", () => {
    // in the bin there is no Upscale button at all to say it on
    expect(itemActions(facts("image", { inBin: true, queued: { upscale: true } }), runs).find((a) => a.id === "upscale")).toBeUndefined();
  });
});

describe("Send to", () => {
  const ids = (f: ItemFacts) => itemActions(f, {}).map((a) => a.id);
  it("is in a picture's and a video's list only when Telegram or Discord is set up", () => {
    const telegram = [{ label: "Telegram", run: () => {} }];
    expect(ids(facts("image"))).not.toContain("send");
    expect(ids(facts("image", { shares: [] }))).not.toContain("send");
    expect(ids(facts("image", { shares: telegram }))).toContain("send");
    expect(ids(facts("video", { shares: telegram }))).toContain("send");
    expect(ids(facts("audio", { shares: telegram }))).not.toContain("send");
    const send = itemActions(facts("image", { shares: telegram }), {}).find((a) => a.id === "send")!;
    expect(send.disabled).toBe(false);
    expect(send.items).toHaveLength(1);
  });
});
