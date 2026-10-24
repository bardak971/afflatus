import { describe, expect, it } from "vitest";
import { recordingPart, recordingParts } from "../src/recordingParts";

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
  it("cuts at the length asked where no pause falls within it (a song: its music never pauses)", () => {
    const parts = recordingParts({ fromS: 0, toS: 30, wantS: 5, ...bounds, pauses: [] });
    expect(parts.map((p) => p.seconds)).toEqual([5, 5, 5, 5, 5, 5]);
    // 174 s of a song at 8 s asked: 8 s clips, not twelve of the most one takes
    const song = recordingParts({ fromS: 0, toS: 174, wantS: 8, ...bounds, pauses: [] });
    expect(song.slice(0, -1).every((p) => p.seconds === 8)).toBe(true);
    expect(song.reduce((s, p) => s + p.seconds, 0)).toBeCloseTo(174, 1);
    // a pause only past the first stretch: the first part the length asked, the next one in the pause
    expect(recordingParts({ fromS: 0, toS: 30, wantS: 8, ...bounds, pauses: [{ start: 15.9, end: 16.1 }] }).slice(0, 2)).toEqual([{ start: 0, seconds: 8 }, { start: 8, seconds: 8 }]);
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
  it("never makes a part past the recording's end, nor past an Out trimmed before a pause (H3 Lip sync's figures)", () => {
    // 9 to 14.5 s without a pause: parts ending at the recording's end, never one of the most a clip takes (14.83 s)
    for (const toS of [9, 10, 12, 14.5]) {
      const parts = recordingParts({ fromS: 0, toS, wantS: 5, ...bounds, pauses: [] });
      expect(parts.at(-1)!.start + parts.at(-1)!.seconds).toBeCloseTo(toS, 5);
      expect(recordingParts({ fromS: 0, toS, wantS: 14.83, ...bounds, pauses: [] })).toEqual([{ start: 0, seconds: toS }]);
    }
    // trimmed to 10 s, the next pause at 11.2: the part ends at the Out
    expect(recordingParts({ fromS: 0, toS: 10, wantS: 5, ...bounds, pauses: [{ start: 11, end: 11.4 }] })).toEqual([{ start: 0, seconds: 5 }, { start: 5, seconds: 5 }]);
    expect(recordingParts({ fromS: 0, toS: 10, wantS: 8, ...bounds, pauses: [{ start: 11, end: 11.4 }] })).toEqual([{ start: 0, seconds: 10 }]);
    for (const p of recordingParts({ fromS: 2, toS: 21, wantS: 5, ...bounds, pauses: [{ start: 22, end: 22.4 }] })) expect(p.start + p.seconds).toBeLessThanOrEqual(21 + 1e-9);
  });
});

/** The one part a voice given to a single Lip sync clip takes (Timelines.voicePart). */
describe("a recording's part for one clip", () => {
  const bounds = { leastS: 4, mostS: 14.83 };
  it("is the whole recording when one clip holds it", () => {
    expect(recordingPart({ fromS: 0, toS: 7, ...bounds, pauses: [{ start: 4.9, end: 5.1 }] })).toEqual({ start: 0, seconds: 7 });
  });

  it("a little longer than one clip holds, is as much as it holds, not half of it", () => {
    // the even share of a short last part gave 7.45, 7.5, 8.5 s here: one clip, not a row of them, is filled
    for (const toS of [14.9, 15, 17, 18.8]) expect(recordingPart({ fromS: 0, toS, ...bounds, pauses: [] })).toEqual({ start: 0, seconds: 14.83 });
    expect(recordingParts({ fromS: 0, toS: 17, wantS: 5, ...bounds, pauses: [] }).map((p) => p.seconds)).not.toContain(14.83);
  });

  it("ends in the pause nearest the most it holds, even one that leaves less than a clip after it", () => {
    // 16 s, a pause at 13: 13 s, where the parts' even share gave 8
    expect(recordingPart({ fromS: 0, toS: 16, ...bounds, pauses: [{ start: 12.9, end: 13.1 }] })).toEqual({ start: 0, seconds: 13 });
    expect(recordingPart({ fromS: 0, toS: 15, ...bounds, pauses: [{ start: 4.5, end: 4.7 }, { start: 10.1, end: 10.3 }] })).toEqual({ start: 0, seconds: 10.2 });
  });

  it("starts where it is asked, and is none past the end", () => {
    expect(recordingPart({ fromS: 2, toS: 9, ...bounds, pauses: [] })).toEqual({ start: 2, seconds: 7 });
    expect(recordingPart({ fromS: 9, toS: 9, ...bounds, pauses: [] })).toBeNull();
  });
});

/** Snap to pauses off (the recording's panel): the parts the length asked, the pauses passed by. */
describe("a recording cut without its pauses", () => {
  const bounds = { leastS: 4, mostS: 14.83 };
  const pauses = [{ start: 4.5, end: 4.9 }, { start: 10, end: 10.4 }];
  it("is cut every length asked, the last part taking what is left", () => {
    expect(recordingParts({ fromS: 0, toS: 15, wantS: 6, ...bounds, pauses, snap: false })).toEqual([{ start: 0, seconds: 6 }, { start: 6, seconds: 9 }]);
    expect(recordingParts({ fromS: 1, toS: 21, wantS: 5, ...bounds, pauses, snap: false }).map((p) => p.seconds)).toEqual([5, 5, 5, 5]);
    expect(recordingParts({ fromS: 0, toS: 13, wantS: 5, ...bounds, pauses, snap: false })).toEqual([{ start: 0, seconds: 5 }, { start: 5, seconds: 8 }]);
  });

  it("snapped, as before: in the pauses", () => {
    expect(recordingParts({ fromS: 0, toS: 15, wantS: 5, ...bounds, pauses }).map((p) => p.start)).toEqual([0, 4.7, 10.2]);
  });
});
