import { describe, expect, it } from "vitest";
import { schemaFor, type InputSpec } from "@afflatus/core";
import { recipes } from "@afflatus/recipes";
import { snapTo, snapReachingEnd, partCommitted } from "../src/snap";

type NumberSpec = Extract<InputSpec, { type: "number" }>;
const takes = (spec: NumberSpec, v: number) => schemaFor([spec]).safeParse({ [spec.id]: v }).success;

describe("the slider's snap", () => {
  const numbers = recipes.flatMap((r) => r.inputs.filter((s): s is NumberSpec => s.type === "number").map((s) => ({ recipe: r.id, spec: s })));

  it("gives a value the recipe takes at both ends of every built-in number input", () => {
    expect(numbers.length).toBeGreaterThan(20);
    for (const { recipe, spec } of numbers) {
      const step = spec.step ?? 1;
      // dragged past either end, Home and End, and one arrow step beyond each
      for (const v of [-Infinity, spec.min, spec.min - step, spec.max, spec.max + step, Infinity]) {
        const snapped = snapTo(v, spec.min, spec.max, step);
        expect(takes(spec, snapped), `${recipe} ${spec.id}: ${v} → ${snapped}`).toBe(true);
      }
      // a built-in range ends on its own grid, so that End reaches its max (SeedVR2's 0 is "auto", then 1, 5, 9…: one step cannot say both)
      if (spec.id !== "seedvrFrames") expect(snapTo(spec.max, spec.min, spec.max, step), `${recipe} ${spec.id}`).toBe(spec.max);
    }
  });

  it("counts its steps from the range's start, as imported ranges need", () => {
    expect(snapTo(1080, 320, 1080, 16)).toBe(1072);
    expect(snapTo(-5, -0.999, 100, 0.01)).toBe(-0.999);
    expect(snapTo(1000, 0, 58.458568, 0.01)).toBeLessThanOrEqual(58.458568);
    // Wan's length is on the 4n+1 grid
    expect([0, 3, 4, 40, 81, 99].map((v) => snapTo(v, 1, 81, 4))).toEqual([1, 5, 5, 41, 81, 81]);
    expect(snapTo(0.3, 0, 1, 0.1)).toBe(0.3);
    expect(snapTo(0.55, 0, 1, 0.05)).toBe(0.55);
  });
});

describe("a range's knob reaching its own end", () => {
  it("lands on the end when dragged past the last step's middle, a range of 5.06 s by steps of 0.1", () => {
    expect(snapReachingEnd(5.06, 0, 5.06, 0.1)).toBe(5.06);
    expect(snapReachingEnd(5.04, 0, 5.06, 0.1)).toBe(5.06);
    // short of the middle: the last step, as before
    expect(snapReachingEnd(5.02, 0, 5.06, 0.1)).toBe(5);
    expect(snapReachingEnd(2.34, 0, 5.06, 0.1)).toBe(2.3);
    // an end on a step: unchanged
    expect(snapReachingEnd(5, 0, 5, 0.1)).toBe(5);
  });
});

describe("a part as its strip commits it", () => {
  it("keeps the end of the video exactly when the part reaches it, to a tenth elsewhere", () => {
    // a 5.04 s video: rounded, its end went back to 5.0 when the knob was let go
    expect(partCommitted(0, 5.04, 5.04)).toEqual({ start: 0, seconds: 5.04 });
    expect(partCommitted(1.23, 5.04, 5.04)).toEqual({ start: 1.2, seconds: 5.04 - 1.2 });
    expect(partCommitted(0, 3.27, 5.04)).toEqual({ start: 0, seconds: 3.3 });
    // held to the longest a part may be
    expect(partCommitted(0, 5.04, 5.04, 3.375)).toEqual({ start: 0, seconds: 3.375 });
  });
});
