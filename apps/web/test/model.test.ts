import { describe, expect, it } from "vitest";
import type { InputSpec } from "@afflatus/core";
import { recipeById } from "@afflatus/recipes";
import type { Asset, Clip, RecipeInfo, Take } from "../src/api";
import { layout, otherShape, PAD, pinInputs, placeOf, playAt, shapeOf, stamp, takeTrouble, titleOf } from "../src/timeline/model";

const recipe = (inputs: InputSpec[], id = "h3.video"): RecipeInfo => ({ id, family: "h3", version: 1, title: "Video", summary: "A clip.", output: "video", inputs, traits: null });
const h3 = recipe([
  { id: "prompt", type: "prompt", label: "What happens", style: "sentences" },
  { id: "seconds", type: "number", label: "Length", min: 1, max: 10, step: 0.5, default: 5, unit: " s" },
  { id: "start", type: "image", label: "First frame", role: "start" },
  { id: "end", type: "image", label: "Last frame", role: "end", optional: true },
  { id: "mid", type: "image", label: "Keyframe", role: "mid", optional: true, at: "midAt" },
]);
/** A clip with only what the layout reads: the rest of a clip is the server's business. */
const clip = (over: Partial<Clip> & { id: string }): Clip =>
  ({ kind: "video", recipe: "h3.video", inputs: {}, atMs: 0, lengthMs: 0, takes: [], pictures: [], joined: "cut", join: null, sound: "own", volume: 100, ...over }) as unknown as Clip;

describe("the clips laid along the track", () => {
  it("draws each clip as wide as it is long, one after the other, at the zoom asked", () => {
    const slots = layout([clip({ id: "a", lengthMs: 2000, atMs: 0 }), clip({ id: "b", lengthMs: 3000, atMs: 2000 })], 40, [h3]);
    expect(slots.map((s) => [s.startMs, s.lengthMs, s.left, s.width, s.planned])).toEqual([
      [0, 2000, PAD, 80, false],
      [2000, 3000, PAD + 80, 120, false],
    ]);
  });
  it("gives a clip not rendered yet the length its form asks for, five seconds without one", () => {
    const slots = layout([clip({ id: "a", inputs: { seconds: 3 } }), clip({ id: "b", recipe: "gone" })], 10, [h3]);
    expect(slots.map((s) => [s.lengthMs, s.planned])).toEqual([[3000, true], [5000, true]]);
  });
  it("replaces one clip's length while its edge is dragged", () => {
    const slots = layout([clip({ id: "a", lengthMs: 2000 }), clip({ id: "b", lengthMs: 2000, atMs: 2000 })], 10, [h3], { clip: "a", lengthMs: 1000 });
    expect(slots.map((s) => s.startMs)).toEqual([0, 1000]);
  });
});

describe("the playhead on the track", () => {
  const slots = layout([clip({ id: "a", lengthMs: 2000, atMs: 0 }), clip({ id: "b", lengthMs: 2000, atMs: 2000 }), clip({ id: "c", atMs: 4000 })], 10, [h3]);
  it("stands in the clip under the moment that plays, at its share of the clip", () => {
    const at = placeOf(slots, 3000)!;
    expect(at.slot.clip.id).toBe("b");
    expect(at.x).toBe(PAD + 20 + 10);
    expect(at.layoutMs).toBe(3000);
  });
  it("stays on the last clip that plays past the end, and knows nothing of an empty timeline", () => {
    expect(placeOf(slots, 99_000)!.slot.clip.id).toBe("b");
    expect(placeOf([], 0)).toBeNull();
  });
  it("turns a point of the track back into a moment, and a planned clip into where it would start", () => {
    expect(playAt(slots, PAD + 30)).toBe(3000);
    expect(playAt(slots, PAD + 45)).toBe(4000);
  });
});

describe("a clip's name and pictures", () => {
  it("is the start of what happens in it, else what it is", () => {
    expect(titleOf(clip({ id: "a", inputs: { prompt: " She turns. " } }), h3)).toBe("She turns.");
    expect(titleOf(clip({ id: "a" }), h3)).toBe("New clip");
    expect(titleOf(clip({ id: "a", kind: "still", still: { name: "Dusk" } as Clip["still"] }), undefined)).toBe("Dusk");
  });
  it("finds the inputs its pictures are pinned to", () => {
    expect(pinInputs(h3)).toEqual({ start: "start", end: "end", mid: "mid", midAt: "midAt" });
    expect(pinInputs(undefined)).toEqual({ start: undefined, end: undefined, mid: undefined, midAt: undefined });
    // LTX 2.3 pins a keyframe the same way, from its own inputs
    expect(pinInputs(recipe(recipeById("ltx.video")!.inputs, "ltx.video"))).toEqual({ start: "start", end: "end", mid: "mid", midAt: "midAt" });
  });
});

describe("shapes and stamps", () => {
  it("names a frame's shape, with a little room around square", () => {
    expect(shapeOf(1024, 576)).toBe("wide");
    expect(shapeOf(576, 1024)).toBe("tall");
    expect(shapeOf(768, 760)).toBe("square");
  });
  it("sees a clip in another aspect ratio than the timeline's frame", () => {
    const wide = clip({ id: "a", take: { asset: { width: 1024, height: 576 } } as Clip["take"] });
    expect(otherShape(wide, { width: 576, height: 1024 })).toBe(true);
    expect(otherShape(wide, { width: 1920, height: 1080 })).toBe(false);
    expect(otherShape(wide, { width: null, height: null })).toBe(false);
  });
  it("writes a moment to the tenth of a second", () => {
    expect(stamp(3300)).toBe("0:03.3");
    expect(stamp(61_050)).toBe("1:01.0");
  });
});

describe("a broken take", () => {
  const take = (id: string, fileMs: number, over: Partial<Take> = {}): Take => ({ id, startMs: 0, endMs: fileMs, trimStartMs: 0, trimEndMs: 0, finishedFrom: null, asset: { id: `v-${id}`, durationMs: fileMs } as Asset, ...over }) as Take;
  it("is not a trimmed take, nor a finished take of its draft's length", () => {
    const draft = take("d", 5167, { startMs: 500, endMs: 1500, trimStartMs: 500, trimEndMs: 3667 });
    expect(takeTrouble(draft, [draft])).toBeNull();
    const finished = take("f", 5200, { finishedFrom: "d", startMs: 500, endMs: 1500 });
    expect(takeTrouble(finished, [draft, finished])).toBeNull();
  });
  it("is a finished take whose file is not its draft's length, or a take with nothing left to play", () => {
    const draft = take("d", 5167);
    const short = take("f", 4000, { finishedFrom: "d", startMs: 500, endMs: 500 });
    expect(takeTrouble(short, [draft, short])).toMatch(/^Its file is 4\.0 s, its draft's 5\.2 s/);
    const empty = take("e", 3000, { startMs: 1200, endMs: 1200 });
    expect(takeTrouble(empty, [empty])).toMatch(/^Nothing of it is left to play \(its file is 3\.0 s\)/);
  });
});
