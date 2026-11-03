import { describe, expect, it } from "vitest";
import { firstPart, pausesOfSound } from "../src/SoundRange";

describe("a part of a sound", () => {
  it("snaps to the pauses the server cuts recordings at, not to its own reading of the loudness", () => {
    // GET /assets/:id/pauses, in seconds: the very marks a recording dropped on a timeline is cut into clips at
    expect(pausesOfSound({ pauses: [{ start: 0, end: 0.31 }, { start: 2.4, end: 2.95 }] })).toEqual([{ from: 0, to: 0.31 }, { from: 2.4, to: 2.95 }]);
    // not read (yet, or the sound could not be): nothing to snap to
    expect(pausesOfSound(undefined)).toEqual([]);
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
