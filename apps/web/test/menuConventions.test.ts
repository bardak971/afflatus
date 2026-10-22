import { describe, expect, it } from "vitest";
import type { Asset, Clip, RecipeInfo, Timeline } from "../src/api";
import { groups, menuProblems, type MenuItem } from "../src/ContextMenu";
import { itemActions, ORDER, placeMenu, type ItemFacts, type Kind, type Place, type Runs } from "../src/itemActions";
import { kindActions, MENUS, toMenu as kindMenu, type KindFacts, type KindRuns, type MenuKind } from "../src/projects/kindActions";
import { clipMenuItems, musicMenuItems, pinMenuItems, placeItems, soundMenuItems, type ClipMenuActions, type PlaceActions } from "../src/timeline/menus";
import type { PinMirror } from "../src/timeline/model";

/**
 * The menu conventions (ContextMenu.tsx) held by every menu builder a test can reach without a page: each is walked over
 * the cases that change its rows, and none may break a rule `menuProblems` can tell. The menus built inside components
 * are checked where a DOM test opens them: ContextMenu itself throws on a broken menu under the tests.
 */

const run = () => {};
const row = (label: string, more: Partial<Exclude<MenuItem, "—">> = {}): MenuItem => ({ label, run, ...more });

describe("menuProblems", () => {
  it("passes a menu that follows the conventions", () => {
    expect(menuProblems([row("Open"), row("Keep", { key: "S" }), "—", { label: "Info", items: [row("Details", { key: "P" })] }, "—", row("Move to the bin", { key: "Del", danger: true })])).toEqual([]);
    // a menu of nothing but destructive rows is one group
    expect(menuProblems([row("Clear 3 empty drafts…", { danger: true })])).toEqual([]);
  });

  it("finds the rules first, last or doubled", () => {
    expect(menuProblems(["—", row("A")], "m")).toEqual(["m: starts with a rule"]);
    expect(menuProblems([row("A"), "—"], "m")).toEqual(["m: ends with a rule"]);
    expect(menuProblems([row("A"), "—", "—", row("B")], "m")).toEqual(["m: two rules in a row"]);
  });

  it("finds destructive rows that are not last, alone, in one group", () => {
    expect(menuProblems([row("Delete…", { danger: true }), "—", row("Rename…")], "m")).toEqual(['m: "Rename…" comes after a destructive row (destructive rows go last)']);
    expect(menuProblems([row("Rename…"), row("Delete…", { danger: true })], "m")).toEqual(['m: "Delete…" is destructive but not in a group of its own']);
    expect(menuProblems([row("A"), "—", row("Remove", { danger: true }), "—", row("Delete…", { danger: true })], "m")).toEqual(["m: the destructive rows are split by a rule"]);
  });

  it("finds a greyed row with no reason, a row that does nothing, the ellipsis' faults", () => {
    expect(menuProblems([row("Move up", { disabled: true })], "m")).toEqual(["m › Move up: greyed without its reason (a note), or a dead row to leave out"]);
    expect(menuProblems([{ label: "Nothing" }], "m")).toEqual(["m › Nothing: does nothing"]);
    expect(menuProblems([row("Rename...")], "m")).toEqual(['m › Rename...: an ellipsis is "…", not three dots']);
    expect(menuProblems([{ label: "Move to…", items: [row("Inbox")] }], "m")).toEqual(["m › Move to…: opens a submenu, so no ellipsis"]);
    expect(menuProblems([{ label: "Empty", items: [] }], "m")).toEqual(["m › Empty: no row"]);
  });

  it("finds a key two rows share (the open menu runs the first only) and a key it cannot read", () => {
    expect(menuProblems([row("Split", { key: "S | Ctrl+B" }), { label: "More", items: [row("Keep", { key: "S" })] }], "m")).toEqual(['m › More › Keep: its key S is "Split"\'s too']);
    expect(menuProblems([row("Odd", { key: "Ctrl+" })], "m")).toEqual(['m › Odd: its key "Ctrl+" is not in the keys grammar']);
    // a mouse way (Ctrl + click) is no key the menu runs
    expect(menuProblems([row("Select", { key: "Ctrl+click" }), row("Other", { key: "Ctrl+click" })])).toEqual([]);
  });
});

describe("groups", () => {
  it("puts one rule between the groups that hold rows, none for one left out", () => {
    expect(groups([row("A")], false, [], null, ["—"], [row("B"), "—", row("C")], undefined)).toEqual([row("A"), "—", row("B"), "—", row("C")]);
    expect(groups(false, [])).toEqual([]);
  });
});

// ---- the timeline's menus

const model = {
  id: "zz-test.pins", family: "zz-test", title: "zz-test pins", output: "video", summary: "",
  inputs: [
    { id: "prompt", type: "prompt", label: "Prompt" },
    { id: "first", type: "image", role: "start", label: "First frame", optional: true },
    { id: "last", type: "image", role: "end", label: "Last frame", optional: true },
    { id: "refs", type: "references", media: "image", max: 3, roles: ["character"], label: "References" },
    { id: "voice", type: "audio", role: "voice", label: "Voice" },
  ],
  traits: {},
} as unknown as RecipeInfo;
const video = { id: "zz-test-video", name: "zz-test take", kind: "video", hasSound: true, durationMs: 6000 } as unknown as Asset;
const take = (id: string) => ({ id, asset: video, headMs: 0, tailMs: 0, startMs: 0, endMs: 5000, trimStartMs: 0, trimEndMs: 0 }) as unknown as NonNullable<Clip["take"]>;
const clipOf = (id: string, more: Partial<Clip> = {}): Clip => ({
  id, kind: "video", recipe: model.id, joined: "cut", atMs: 0, lengthMs: 5000, inputs: { prompt: "zz-test" }, music: null, sound: "own", volume: 100,
  take: take(`${id}-t2`), takes: [take(`${id}-t1`), take(`${id}-t2`), take(`${id}-t3`)], pictures: [], job: null, soundAsset: null,
  ...more,
} as unknown as Clip);

const clips = [clipOf("zz-a"), clipOf("zz-b", { joined: "continue", atMs: 5000 }), clipOf("zz-c", { atMs: 10_000 })];
const acts = (over: Partial<ClipMenuActions> = {}): ClipMenuActions => ({
  clips, recipes: [model], inputsOf: (c) => c.inputs as Record<string, unknown>, onClip: () => null,
  pending: { render: false, split: false, duplicate: false, loop: false, add: false, frame: false, range: false },
  render: run, patch: run, setRange: run, split: run, stepTake: run, duplicate: run, loop: run, continueFrom: run, frame: run, open: run, slow: run, remove: run, move: run,
  picked: new Set(), removeMany: run, openJoin: run, toSource: run,
  ...over,
});

describe("the timeline's menus follow the conventions", () => {
  it("a clip's, wherever it stands and whatever it holds", () => {
    const here = (c: Clip) => ({ clip: c, localMs: 1000, assetMs: 1000 });
    const busy = { render: true, split: true, duplicate: true, loop: true, add: true, frame: true, range: true };
    const cases: Array<[string, Clip, ClipMenuActions]> = [];
    for (const c of clips) {
      cases.push([`${c.id}`, c, acts()]);
      cases.push([`${c.id} at the playhead`, c, acts({ onClip: here })]);
      cases.push([`${c.id} busy`, c, acts({ pending: busy, onClip: here })]);
      cases.push([`${c.id} picked with others`, c, acts({ picked: new Set(clips.map((x) => x.id)) })]);
    }
    cases.push(["first take plays", clipOf("zz-a", { take: take("zz-a-t1") }), acts()]);
    cases.push(["one take", clipOf("zz-a", { takes: [take("zz-a-t2")] }), acts()]);
    cases.push(["no take yet", clipOf("zz-a", { take: null, takes: [] }), acts()]);
    cases.push(["in the queue", clipOf("zz-a", { job: { id: "zz-job", status: "queued" } }), acts()]);
    cases.push(["a still", clipOf("zz-a", { kind: "still", take: null, takes: [] }), acts()]);
    cases.push(["imported, no model", clipOf("zz-b", { recipe: null, atMs: 5000 } as Partial<Clip>), acts()]);
    cases.push(["a model that cannot extend", clipOf("zz-b", { recipe: "zz-test.plain", atMs: 5000 } as Partial<Clip>), acts({ recipes: [model, { ...model, id: "zz-test.plain", inputs: [] } as unknown as RecipeInfo] })]);
    cases.push(["loops already", clipOf("zz-a", { inputs: { first: "zz-p", last: "zz-p" } }), acts()]);
    cases.push(["alone", clipOf("zz-a"), acts({ clips: [clipOf("zz-a")] })]);
    for (const [name, c, a] of cases) expect(menuProblems(clipMenuItems(c, a), name)).toEqual([]);
  });

  it("a clip's keeps a row only where it does something: no Move earlier on the first clip, no Previous take on the first take", () => {
    const labels = (items: MenuItem[]): string[] => items.flatMap((it) => (it === "—" ? [] : [it.label, ...(it.items ? labels(it.items) : [])]));
    const first = labels(clipMenuItems(clips[0]!, acts()));
    expect(first).not.toContain("Move earlier");
    expect(first).toContain("Move later");
    expect(labels(clipMenuItems(clipOf("zz-a", { take: take("zz-a-t1") }), acts()))).not.toContain("Previous take");
    expect(labels(clipMenuItems(clipOf("zz-a", { inputs: { first: "zz-p", last: "zz-p" } }), acts()))).not.toContain("Make it loop");
    // its last row, alone: Remove
    const menu = clipMenuItems(clips[1]!, acts());
    expect(menu.at(-2)).toBe("—");
    expect(menu.at(-1)).toMatchObject({ label: "Remove clip", danger: true, key: "Del" });
  });

  it("a clip's audio, the music's, a pinned frame's", () => {
    const sound = { patch: run, pick: run, select: run };
    for (const s of ["own", "muted", "file"] as const) {
      for (const soundAsset of [null, { id: "zz-s", name: "zz-test.wav" }]) {
        for (const hasSound of [true, false]) {
          const c = clipOf("zz-a", { sound: s, soundAsset, take: { ...take("zz-a-t2"), asset: { ...video, hasSound } } } as Partial<Clip>);
          expect(menuProblems(soundMenuItems(c, sound), `${s} ${Boolean(soundAsset)} ${hasSound}`)).toEqual([]);
        }
      }
    }
    expect(menuProblems(soundMenuItems(clipOf("zz-a", { kind: "still", take: null, takes: [] }), sound), "still")).toEqual([]);
    const music = { asset: { id: "zz-m", name: "zz-test song" }, volume: 80, fadeInMs: 1000, fadeOutMs: 2000, duck: true } as unknown as Timeline["music"];
    for (const m of [undefined, music, { ...music!, duck: false }]) expect(menuProblems(musicMenuItems(m, { pick: run, open: run, edit: run }), "music")).toEqual([]);
    const pin = (more: Partial<PinMirror>): PinMirror => ({ where: "start", input: "first", asset: "zz-p", on: false, why: null, ...more });
    for (const p of [pin({}), pin({ on: true }), pin({ why: "carried on from the clip before: the join would no longer meet" })]) {
      expect(menuProblems(pinMenuItems(p, { mirror: run, remove: run }), "pin")).toEqual([]);
      expect(menuProblems(pinMenuItems(p, { mirror: run, open: run, change: run, remove: run }), "pin, all")).toEqual([]);
    }
  });

  it("a library item's in the timeline's media, its places first", () => {
    const place = (current: Clip | null): PlaceActions => ({ current, clips, recipes: [model], music: false, inputsOf: (c) => c.inputs as Record<string, unknown>, editInputs: run, select: run, patch: run, edit: run, openMusic: run, add: run });
    for (const kind of ["image", "video", "audio"] as const) {
      const a = { id: "zz-i", kind, name: "zz-test", hasSound: true } as unknown as Asset;
      const list = itemActions(facts(kind), runs);
      for (const current of [null, clips[1]!]) expect(menuProblems(placeMenu(placeItems(a, place(current)), list, "shelf"), `${kind} ${current ? "on a clip" : ""}`)).toEqual([]);
    }
  });
});

// ---- the library item's list, in every place it is drawn

const facts = (kind: Kind, more: Partial<ItemFacts> = {}): ItemFacts => ({
  kind, inBin: false, kept: false, hasSound: true, reading: false, madeHere: true, generated: true, seed: 42, prompt: "zz-test",
  opener: "Wan", mover: "SCAIL-2", carrier: true, passes: { upscale: "u", face: "f", hand: "h", background: "b", inpaint: "i", edit: "e", outpaint: "r" }, voice: true,
  comfyOnline: true, compare: true,
  timelines: [{ label: "Add to zz-test", run }], moves: [{ label: "The Inbox", run }],
  ...more,
});
const runs: Runs = { ...Object.fromEntries(ORDER.map((id) => [id, run])), erase: run };

describe("the library item's menus follow the conventions", () => {
  it("for every kind, in and out of the bin, read or not, made here or not, in every place, with a place's own rows", () => {
    const states: Array<Partial<ItemFacts>> = [
      {}, { inBin: true }, { reading: true, seed: null, prompt: null }, { madeHere: false, generated: false, madeElsewhere: true, seed: null, prompt: null },
      { opener: null, mover: null, carrier: false, passes: {}, voice: false, comfyOnline: false, compare: "open it from a list" }, { hasSound: false },
      { busy: { upscale: true, variation: true } }, { shares: [{ label: "zz-test chat", run }] }, { moves: [{ label: "The Inbox", disabled: true, note: "here", run }] },
    ];
    const places: Place[] = ["grid", "stage", "viewer", "shelf", "projects", "queue", "command"];
    for (const kind of ["image", "video", "audio"] as const) {
      for (const state of states) {
        const list = itemActions(facts(kind, state), runs);
        for (const place of places) {
          const name = `${kind} ${JSON.stringify(state)} ${place}`;
          expect(menuProblems(placeMenu([], list, place), name)).toEqual([]);
          // a take's: its own first rows, its Remove last with the bin left out
          const own = [row("Play this take"), row("Face refine", { note: "as a new take" })];
          const last = [row("Remove take 2", { danger: true })];
          expect(menuProblems(placeMenu(own, list.filter((a) => a.id !== "bin"), place, [], last), `${name}, a take's`)).toEqual([]);
          // a finished job's: its Remove from the history with the bin, in one last group
          expect(menuProblems(placeMenu(own, list, place, [row("Select", { key: "Ctrl+click" })], [row("Remove from the history", { danger: true })]), `${name}, a job's`)).toEqual([]);
        }
      }
    }
  });

  it("puts the bin's Delete now last, alone, after Put back and what looks at it", () => {
    const menu = placeMenu([], itemActions(facts("image", { inBin: true }), runs), "grid");
    expect(menu.flatMap((it) => (it === "—" ? ["—"] : [it.label]))).toEqual(["Put back", "Open", "Download", "—", "Compare", "—", "Delete now…"]);
  });
});

// ---- the timelines, drafts, folders and projects

describe("the kind menus follow the conventions", () => {
  it("for every kind, one or several, whatever is known of it, with their keys or without", () => {
    const ids = Object.values(MENUS).flat().flatMap((s) => (s === "—" ? [] : [s.id]));
    const all: KindRuns = Object.fromEntries(ids.map((id) => [id, run]));
    const subs = { move: [row("Client work"), row("Rushes", { disabled: true, note: "already there" }), row("The Inbox")], put: [row("B-roll"), "—" as const, row("The project's root")] };
    const states: Array<Partial<KindFacts>> = [
      {}, { count: 3 }, { clips: 0 }, { clips: 4, toRender: 0 }, { clips: 4, toRender: 2, exported: true }, { unused: null }, { unused: "unread" }, { unused: { takes: 3, bytes: 1e9 } },
      { inProject: false }, { inProject: true }, { sub: true }, { missing: true }, { archived: true }, { hasRoot: true }, { pinned: true }, { pinsFull: true }, { working: true },
    ];
    for (const kind of Object.keys(MENUS) as MenuKind[]) {
      for (const state of states) {
        // a project and the Inbox are never picked with others
        if ((kind === "project" || kind === "inbox") && state.count) continue;
        for (const keys of [true, false]) {
          const name = `${kind} ${JSON.stringify(state)}`;
          expect(menuProblems(kindMenu(kindActions({ kind, ...state }, all, subs), keys), name)).toEqual([]);
          // a place that does not do some of them (no import here): those are left out, never greyed with no reason
          expect(menuProblems(kindMenu(kindActions({ kind, ...state }, { ...all, import: undefined, link: undefined }, subs), keys), `${name}, fewer runs`)).toEqual([]);
        }
      }
    }
  });
});
