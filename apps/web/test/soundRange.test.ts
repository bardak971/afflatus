import { describe, expect, it } from "vitest";
import { pausesIn } from "../src/pauses";
import { firstPart } from "../src/SoundRange";

describe("a part of a sound", () => {
  it("finds the pauses: a quarter second at least well under the loud parts, the sound's quiet ends included", () => {
    // ten samples a second: quiet 0.3 s, words, a 0.5 s pause, words, a 0.2 s dip (too short), words, quiet to the end
    const db = [-70, -70, -70, -12, -10, -14, -60, -60, -60, -60, -60, -11, -13, -60, -60, -12, -10, -65, -65, -65];
    expect(pausesIn(db)).toEqual([{ from: 0, to: 3 }, { from: 6, to: 11 }, { from: 17, to: 20 }]);
  });

  it("starts with the whole sound when it fits, else up to the last pause that fits", () => {
    const pauses = [{ from: 0, to: 0.73 }, { from: 5.53, to: 6.52 }, { from: 9.81, to: 10.36 }, { from: 13.93, to: 15.12 }, { from: 16.89, to: 17.6 }];
    expect(firstPart(12, pauses, 14.8)).toEqual({ start: 0, seconds: 12 });
    // 17.6 s does not fit in 14.8: it ends 0.2 s into the pause at 13.93
    expect(firstPart(17.6, pauses, 14.8)).toEqual({ start: 0, seconds: 14.1 });
    // a voice sample's usual 8 s: into the pause at 5.53
    expect(firstPart(17.6, pauses, 8)).toEqual({ start: 0, seconds: 5.7 });
    // no pause to end on: the longest, a word cut
    expect(firstPart(20, [], 14.8)).toEqual({ start: 0, seconds: 14.8 });
  });
});
