import { describe, expect, it } from "vitest";
import { timeKey, type InputSpec } from "../src";

describe("a render's time key", () => {
  const num = (id: string): InputSpec => ({ id, type: "number", label: id, min: 0, max: 100, step: 1, default: 0 });
  const specs = [num("seed"), num("crf"), num("shift"), num("shiftVideo"), num("drivingStart"), num("seedvrFrames"), num("steps")];
  const key = (values: Record<string, unknown>) => timeKey(specs, values);

  it("leaves out the seed, the quality, the shift and the driving start, which do not change how long it takes", () => {
    const base = key({});
    for (const id of ["seed", "crf", "shift", "shiftVideo", "drivingStart"]) expect(key({ [id]: 7 }), id).toBe(base);
    expect(key({ steps: 7 })).not.toBe(base);
  });

  it("keeps SeedVR2's frames together, which changes its render time several-fold (review K-8)", () => {
    expect(key({ seedvrFrames: 5 })).not.toBe(key({ seedvrFrames: 13 }));
    // left on "by size", the key is the one renders were filed under before it counted
    expect(key({ seedvrFrames: 0 })).toBe(timeKey(specs.filter((s) => s.id !== "seedvrFrames"), {}));
  });
});
