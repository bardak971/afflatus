import { describe, expect, it } from "vitest";
import { clamp, ratioOf, snap, snapUp } from "../src/stageLayer/geometry";
import { handleAt, roomFor } from "../src/stageLayer/useFrameTool";
import { dragFrame, FRAME_RULES, NO_PADS, padded, paddedFrame, padsForRatio, snapSide, type Pads } from "../src/stageLayer/frame";

const natural = { w: 1216, h: 832 };

describe("snapping and ratios", () => {
  it("snaps to a step, or not at all under 2", () => {
    expect(snap(100, 64)).toBe(128);
    expect(snap(90, 64)).toBe(64);
    expect(snap(90.4, 1)).toBe(90.4);
    expect(snapUp(65, 64)).toBe(128);
    expect(snapUp(128, 64)).toBe(128);
    expect(clamp(5, 0, 3)).toBe(3);
  });

  it("reads a ratio from its words", () => {
    expect(ratioOf("16:9")).toBeCloseTo(16 / 9);
    expect(ratioOf("Widescreen 16:9")).toBeCloseTo(16 / 9);
    expect(ratioOf("Portrait 2:3")).toBeCloseTo(2 / 3);
    expect(ratioOf("Free")).toBeNull();
    expect(ratioOf("0:4")).toBeNull();
  });

});

describe("the outpaint frame", () => {
  it("snaps a side so the frame's size is on the step, or back to the picture's edge", () => {
    // 1216 is 19 × 64: the pads are on the step themselves
    expect(snapSide(1216, 0, 180, 64, 1024)).toBe(192);
    expect(snapSide(1216, 0, 20, 64, 1024)).toBe(0);
    // 1000 is not: the frame snaps, the pad takes what is left (1024 − 1000)
    expect(snapSide(1000, 0, 20, 64, 1024)).toBe(24);
    expect(snapSide(1000, 0, 5, 64, 1024)).toBe(0);
    expect(snapSide(1000, 0, -40, 64, 1024)).toBe(0);
    // never past the most
    expect(snapSide(1216, 0, 5000, 64, 1024)).toBe(1024);
    expect(snapSide(1000, 0, 5000, 64, 1024)).toBe(984);
    expect(snapSide(1000, 0, 37, 1, 1024)).toBe(37);
  });

  it("drags a corner out: the two sides it moves, snapped", () => {
    // the mock: the top left corner dragged up and left, 1216 × 832 → 1408 × 960
    const p = dragFrame(NO_PADS, "nw", -200, -120, natural, FRAME_RULES);
    expect(p).toEqual({ padLeft: 192, padTop: 128, padRight: 0, padBottom: 0 });
    expect(padded(p)).toBe(true);
    expect(padded(NO_PADS)).toBe(false);
  });

  it("moves only the side of an edge handle, and back in to nothing", () => {
    const start: Pads = { padLeft: 192, padTop: 0, padRight: 128, padBottom: 0 };
    expect(dragFrame(start, "e", 70, 999, natural, FRAME_RULES)).toEqual({ ...start, padRight: 192 });
    expect(dragFrame(start, "w", 500, 0, natural, FRAME_RULES)).toEqual({ ...start, padLeft: 0 });
    expect(dragFrame(start, "s", 0, 2000, natural, FRAME_RULES).padBottom).toBe(1024);
  });

  it("holds a ratio: the side dragged sets the size, the other axis grows around the middle", () => {
    const rules = { ...FRAME_RULES, ratio: 16 / 9 };
    const p = dragFrame(NO_PADS, "e", 300, 0, natural, rules);
    const f = paddedFrame(natural, p);
    expect(f.w % 64).toBe(0);
    expect(f.h % 64).toBe(0);
    // both sizes on the step: the ratio holds to within one step
    expect(Math.abs(f.h - f.w / (16 / 9))).toBeLessThanOrEqual(32);
    expect(p.padLeft).toBe(0);
    expect(Math.abs(p.padTop - p.padBottom)).toBeLessThanOrEqual(1);
    // the frame never gets smaller than the picture: dragged inwards, it holds the smallest frame of that shape
    const small = paddedFrame(natural, dragFrame(NO_PADS, "e", -900, 0, natural, rules));
    expect(small.w).toBeGreaterThanOrEqual(natural.w);
    expect(small.h).toBeGreaterThanOrEqual(natural.h);
  });

  it("brings a picture to a ratio, in the middle, on the step", () => {
    const sq = padsForRatio(natural, 1, FRAME_RULES);
    expect(paddedFrame(natural, sq)).toMatchObject({ w: 1216, h: 1216 });
    expect(sq).toEqual({ padLeft: 0, padRight: 0, padTop: 192, padBottom: 192 });
    const wide = paddedFrame(natural, padsForRatio(natural, 16 / 9, FRAME_RULES));
    expect(wide).toEqual({ w: 1472, h: 832, x: 128, y: 0 });
    // already of the shape: nothing
    expect(padded(padsForRatio({ w: 1024, h: 1024 }, 1, FRAME_RULES))).toBe(false);
  });

  it("keeps each side under the most, moving what is over to the other side of its axis", () => {
    const p = padsForRatio({ w: 512, h: 512 }, 21 / 9, FRAME_RULES);
    expect(p.padLeft).toBeLessThanOrEqual(1024);
    expect(p.padRight).toBeLessThanOrEqual(1024);
    const tall = dragFrame(NO_PADS, "n", 0, -3000, { w: 512, h: 512 }, { ...FRAME_RULES, ratio: 9 / 21 });
    expect(tall.padTop).toBe(1024);
    expect(tall.padBottom).toBeLessThanOrEqual(1024);
  });
});

describe("the frame's handles", () => {
  it("takes a corner before a side, a side along its length, and nothing inside", () => {
    const pads: Pads = { padLeft: 100, padTop: 0, padRight: 0, padBottom: 0 };
    // the frame runs from x −100 to 1216, y 0 to 832
    expect(handleAt({ x: -95, y: 4 }, natural, pads, 10)).toBe("nw");
    expect(handleAt({ x: 1220, y: 830 }, natural, pads, 10)).toBe("se");
    expect(handleAt({ x: -100, y: 400 }, natural, pads, 10)).toBe("w");
    expect(handleAt({ x: 600, y: 836 }, natural, pads, 10)).toBe("s");
    expect(handleAt({ x: 600, y: 400 }, natural, pads, 10)).toBeNull();
    // past the end of a side, by more than the grab: nothing
    expect(handleAt({ x: 1216, y: 900 }, natural, pads, 10)).toBeNull();
  });

  it("fits the Stage to the frame with room round it, the picture where it sits", () => {
    const room = roomFor(natural, { padLeft: 192, padTop: 128, padRight: 0, padBottom: 0 });
    const m = Math.round(1408 * 0.12);
    expect(room).toEqual({ w: 1408 + 2 * m, h: 960 + 2 * m, x: 192 + m, y: 128 + m });
  });
});
