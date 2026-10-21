import { describe, expect, it } from "vitest";
import { recordingParts } from "../src/recordingParts";

/** A recording cut into Lip sync clips at its pauses (the mock's "cut at its pauses", 2026-10-20). */
describe("a recording cut into clips", () => {
  const bounds = { leastS: 4, mostS: 14.83 };
  it("ends each part in the pause nearest the length asked, never inside a word", () => {
    // pauses at 4.5, 10.1 and 13.2 s: 5 s asked gives 4.6, then 5.6 (10.2), then the rest
    const parts = recordingParts({ fromS: 0, toS: 15, wantS: 5, ...bounds, pauses: [{ start: 4.5, end: 4.7 }, { start: 10.1, end: 10.3 }, { start: 13.2, end: 13.4 }] });
    expect(parts[0]).toEqual({ start: 0, seconds: 4.6 });
    expect(parts[1]).toEqual({ start: 4.6, seconds: 5.6 });
    expect(parts[2]).toEqual({ start: 10.2, seconds: 4.8 });
    expect(parts.reduce((s, p) => s + p.seconds, 0)).toBeCloseTo(15, 5);
    for (const p of parts) expect(p.seconds).toBeGreaterThanOrEqual(4);
  });
  it("cuts at the most one clip takes where no pause falls within it", () => {
    const parts = recordingParts({ fromS: 0, toS: 30, wantS: 5, ...bounds, pauses: [] });
    expect(parts[0]).toEqual({ start: 0, seconds: 14.83 });
    expect(parts.reduce((s, p) => s + p.seconds, 0)).toBeCloseTo(30, 1);
  });
  it("gives a short last part to the one before when one clip holds both, else shares it evenly", () => {
    // 5 s then 2 s left: one clip of 7 s
    expect(recordingParts({ fromS: 0, toS: 7, wantS: 5, ...bounds, pauses: [{ start: 4.9, end: 5.1 }] })).toEqual([{ start: 0, seconds: 7 }]);
    // 14 s then 2 s: too long for one clip, 8 and 8
    expect(recordingParts({ fromS: 0, toS: 16, wantS: 14, ...bounds, pauses: [{ start: 13.9, end: 14.1 }] })).toEqual([{ start: 0, seconds: 8 }, { start: 8, seconds: 8 }]);
  });
  it("a recording shorter than a clip is one clip", () => {
    expect(recordingParts({ fromS: 0, toS: 9, wantS: 5, ...bounds, pauses: [{ start: 4, end: 4.3 }] })).toHaveLength(2);
    expect(recordingParts({ fromS: 0, toS: 3, wantS: 5, ...bounds, pauses: [] })).toEqual([{ start: 0, seconds: 3 }]);
  });
});
