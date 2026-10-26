import { describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { useRef } from "react";
import type { Clip, RecipeInfo, Timeline } from "../../src/api";
import { ContextMenu } from "../../src/ContextMenu";
import { useNewClock } from "../../src/timeline/clock";
import { clipMenuItems, type ClipMenuActions } from "../../src/timeline/menus";
import type { PlayerHandle } from "../../src/timeline/Player";
import { unsplittable } from "../../src/timeline/runSplit";
import { useClipSteps } from "../../src/timeline/useClipSteps";
import { useRange } from "../../src/timeline/useRange";
import { draw } from "./render";

/**
 * Split greyed where the server refuses it (card #120's B10, card #122): a clip of a recording or a window of the source
 * keeps its whole part in both halves, so Split at the playhead, Split at In / Out, the slow motion and the loop back that
 * split under In or Out, and a range removed inside one such clip are off, their reason on them; S says it in the note.
 */

const video = {
  id: "zz-test.video", family: "zz-test", title: "Video", output: "video", summary: "", version: 1,
  inputs: [{ id: "description", type: "prompt", label: "What happens" }],
} as unknown as RecipeInfo;
const lipSync = {
  id: "zz-test.lipsync", family: "zz-test", title: "Lip sync", output: "video", summary: "", version: 1,
  inputs: [{ id: "description", type: "prompt", label: "What happens" }, { id: "recording", type: "audio", role: "sound", label: "Recording", window: { start: "recordingStart", seconds: "recordingSeconds" } }],
} as unknown as RecipeInfo;
const motion = {
  id: "zz-test.motion", family: "zz-test", title: "Motion transfer", output: "video", summary: "", version: 1,
  inputs: [{ id: "driving", type: "clip", role: "source", label: "Driving video", window: { start: "drivingStart", seconds: "drivingSeconds" } }],
  traits: { windows: {} },
} as unknown as RecipeInfo;
const recipes = [video, lipSync, motion];

const take = (id: string) => ({ id, asset: { id: `${id}-video`, name: "zz-test take.mp4", kind: "video", durationMs: 5000 }, startMs: 0, endMs: 5000, headMs: 0, tailMs: 0, trimStartMs: 0, trimEndMs: 0 });
const clip = (id: string, at: number, recipe: string, inputs: Record<string, unknown>) =>
  ({ id, kind: "video", recipe, joined: "cut", join: null, atMs: at, lengthMs: 5000, inputs, music: null, take: take(`${id}-take`), takes: [take(`${id}-take`)], sound: "own", volume: 100, pictures: [] }) as unknown as Clip;
/** A plain clip, a clip of a recording, a window of the source, 5 s each. */
const plain = clip("zz-test-plain", 0, video.id, {});
const sung = clip("zz-test-sung", 5000, lipSync.id, { recording: "zz-test-talk", recordingStart: 0, recordingSeconds: 5 });
const window_ = clip("zz-test-window", 10_000, motion.id, { driving: { asset: "zz-test-source" }, drivingStart: 0, drivingSeconds: 5 });
const clips = [plain, sung, window_];
const source = { asset: "zz-test-source", atMs: 10_000, fromMs: 0, toMs: 5000 } as unknown as Timeline["source"];
const unsplit = (c: Clip) => unsplittable(c, recipes, source);

const menuOf = (c: Clip) => {
  const acts = { clips, recipes, source, inputsOf: (x: Clip) => x.inputs, onClip: (x: Clip) => (x.id === c.id ? { clip: x, localMs: 2500, assetMs: 2500 } : null), picked: new Set<string>(), pending: {}, split: vi.fn() } as unknown as ClipMenuActions;
  const drawn = draw(<ContextMenu at={{ x: 10, y: 10 }} label="Actions on this clip" head={{ title: "Clip" }} items={clipMenuItems(c, acts)} onClose={() => {}} />);
  return { acts, ...drawn };
};

describe("Split at the playhead on a clip's menu", () => {
  it("is greyed on a clip of a recording and on a window of the source, with why; on for a plain clip", () => {
    for (const [c, why] of [[sung, /a recording's clip: its part does not split; Remove it, or cut the recording again/], [window_, /a window of the source: its part does not split; Remove it, or set the windows anew in Source settings/]] as const) {
      const { unmount } = menuOf(c);
      const row = screen.getByRole("menuitem", { name: /Split at the playhead/ });
      expect((row as HTMLButtonElement).disabled).toBe(true);
      expect(row.textContent).toMatch(why);
      unmount();
    }
    menuOf(plain);
    expect((screen.getByRole("menuitem", { name: /Split at the playhead/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("the range's actions over such a clip", () => {
  function items(range: { inMs: number; outMs: number }) {
    let rows!: ReturnType<ReturnType<typeof useRange>["rangeItems"]>;
    let set!: ReturnType<typeof useRange>["setRange"];
    function Rig() {
      const clock = useNewClock();
      const player = useRef<PlayerHandle | null>(null);
      const r = useRange({ id: "zz-test-range", clips, durationMs: 15_000, clock, player, playing: false, setPlaying: () => {}, unsplit, on: { after: () => {}, select: () => {}, note: () => {}, say: () => {}, writeBetween: () => {}, askRemoval: async () => true } });
      set = r.setRange;
      rows = r.rangeItems();
      return null;
    }
    draw(<Rig />);
    act(() => set(range));
    const flat = rows.flatMap((g) => (g === "—" ? [] : [g]));
    return (label: string) => flat.find((x) => x.label === label)!;
  }

  it("greys Split at In and Out, the slow motion and the loop back when In or Out falls inside one, and says which", () => {
    // In inside the plain clip, Out inside the recording's
    const row = items({ inMs: 2000, outMs: 7000 });
    expect(row("Split at In and Out")).toMatchObject({ disabled: true, note: expect.stringMatching(/^Out is inside clip 2, a recording's clip/) });
    expect(row("Slow motion ×2")).toMatchObject({ disabled: true });
    expect(row("Loop back to In")).toMatchObject({ disabled: true, note: expect.stringMatching(/^Out is inside clip 2/) });
    // a range taking whole clips off is still removed (their parts are cut out, asked first)
    expect(row("Remove range")).toMatchObject({ disabled: false });
  });

  it("greys Remove range inside one window of the source; leaves it all on over plain clips and on cuts", () => {
    const inside = items({ inMs: 11_000, outMs: 13_000 });
    expect(inside("Remove range")).toMatchObject({ disabled: true, note: expect.stringMatching(/^the range is inside clip 3, a window of the source/) });
    const plainOnly = items({ inMs: 1000, outMs: 4000 });
    for (const label of ["Split at In and Out", "Slow motion ×2", "Loop back to In", "Remove range"]) expect(plainOnly(label)).toMatchObject({ disabled: false });
    // In and Out on the recording clip's cuts: nothing split inside it
    const onCuts = items({ inMs: 5000, outMs: 10_000 });
    expect(onCuts("Split at In and Out")).toMatchObject({ disabled: false });
  });
});

describe("S on such a clip", () => {
  it("says in the note why it is not split, and sends nothing", () => {
    const split = { isPending: false, mutate: vi.fn() };
    const notes: string[] = [];
    let here!: (only?: string | null) => void;
    function Rig() {
      const clock = useNewClock();
      const player = useRef<PlayerHandle | null>({ where: () => ({ clip: sung, assetMs: 2500 }) } as unknown as PlayerHandle);
      here = useClipSteps({ clips, slots: [], clock, player, cursor: null, split: split as never, patch: { mutate: vi.fn() } as never, select: () => {}, setNote: (t) => void (t && notes.push(t)), setSaid: () => {}, setPreview: () => {}, unsplit }).splitHere;
      return null;
    }
    draw(<Rig />);
    act(() => here());
    expect(split.mutate).not.toHaveBeenCalled();
    expect(notes).toEqual(["Clip 2 not split: a recording's clip: its part does not split; Remove it, or cut the recording again"]);
  });
});
