import { describe, expect, it } from "vitest";
import { cutOn, recordingPart, recordingParts } from "../src/recordingParts";

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

/** The window ± 0 (the recording's panel): the parts the length asked, the pauses passed by. */
describe("a recording cut without a window", () => {
  const bounds = { leastS: 4, mostS: 14.83 };
  const pauses = [{ start: 4.5, end: 4.9 }, { start: 10, end: 10.4 }];
  it("is cut every length asked, the last part taking what is left", () => {
    expect(recordingParts({ fromS: 0, toS: 15, wantS: 6, ...bounds, pauses, windowS: 0 })).toEqual([{ start: 0, seconds: 6 }, { start: 6, seconds: 9 }]);
    expect(recordingParts({ fromS: 1, toS: 21, wantS: 5, ...bounds, pauses, windowS: 0 }).map((p) => p.seconds)).toEqual([5, 5, 5, 5]);
    expect(recordingParts({ fromS: 0, toS: 13, wantS: 5, ...bounds, pauses, windowS: 0 })).toEqual([{ start: 0, seconds: 5 }, { start: 5, seconds: 8 }]);
  });

  it("with the window, as before: in the pauses", () => {
    expect(recordingParts({ fromS: 0, toS: 15, wantS: 5, ...bounds, pauses }).map((p) => p.start)).toEqual([0, 4.7, 10.2]);
  });
});

/** The length asked ± a window (card #130): a pause, else a lyric line's end, else the quietest moment, only within it. */
describe("a recording cut within a window", () => {
  const bounds = { leastS: 4, mostS: 14.83 };
  /** Loudness at ten samples a second: -20 dB everywhere but the dips given (seconds → dB). */
  const levels = (seconds: number, dips: Record<number, number> = {}) => {
    const db = Array.from({ length: seconds * 10 }, () => -20);
    for (const [t, v] of Object.entries(dips)) db[Math.floor(Number(t) * 10)] = v;
    return { rate: 10, db };
  };

  it("never takes a pause outside the window: a song's closing pause made a last part of 14 s", () => {
    // Timeline 6's song: 174 s, one pause at its very end (172.7–174.0), 5 s asked
    const parts = recordingParts({ fromS: 0, toS: 174, wantS: 5, ...bounds, pauses: [{ start: 172.695562, end: 173.9735 }] });
    for (const p of parts) expect(p.seconds).toBeLessThanOrEqual(6.5 + 1e-9);
    expect(parts.reduce((s, p) => s + p.seconds, 0)).toBeCloseTo(174, 1);
    // a pause 8 s past the length asked is passed by, as any outside the window
    expect(recordingParts({ fromS: 0, toS: 20, wantS: 5, ...bounds, pauses: [{ start: 12.9, end: 13.1 }] })[0]).toEqual({ start: 0, seconds: 5 });
  });

  it("ends at the end of the lyric line nearest the length asked when no pause is there", () => {
    const lines = [{ start: 0, end: 0 }, { start: 0, end: 3.2 }, { start: 3.2, end: 5.9 }, { start: 5.9, end: 9.1 }, { start: 9.1, end: 13 }, { start: 13, end: 17 }];
    const parts = recordingParts({ fromS: 0, toS: 20, wantS: 5, ...bounds, pauses: [], lines, levels: levels(20, { 4.5: -50 }) });
    // 5.9 (not 3.2: outside the window), then 9.1 from 5.9 asks 10.9 (9.1 and 13 are 1.8 and 2.1 away: none), the quietest
    expect(parts[0]).toEqual({ start: 0, seconds: 5.9 });
    expect(cutOn(5.9, { pauses: [], lines }, 1.5)).toBe("line");
    // a pause in the window wins over a line nearer
    expect(recordingParts({ fromS: 0, toS: 20, wantS: 5, ...bounds, pauses: [{ start: 3.9, end: 4.3 }], lines })[0]).toEqual({ start: 0, seconds: 4.1 });
    // a section's name, a line of no length, is no break
    expect(recordingParts({ fromS: 0, toS: 20, wantS: 5, ...bounds, pauses: [], lines: [{ start: 5, end: 5 }] })[0]).toEqual({ start: 0, seconds: 5 });
  });

  it("ends at the quietest moment of the window with neither", () => {
    const parts = recordingParts({ fromS: 0, toS: 20, wantS: 5, ...bounds, pauses: [], levels: levels(20, { 4.0: -60, 6.2: -45, 8: -70 }) });
    // 4.05 is the quietest within 3.5 to 6.5 (8 is outside it)
    expect(parts[0]).toEqual({ start: 0, seconds: 4.05 });
    expect(cutOn(4.05, { pauses: [] }, 1.5)).toBe("quiet");
    expect(cutOn(4.05, { pauses: [] }, 0)).toBe("length");
    // all alike: the one nearest the length asked
    expect(recordingParts({ fromS: 0, toS: 20, wantS: 5, ...bounds, pauses: [], levels: levels(20) })[0]!.seconds).toBeCloseTo(5, 1);
  });

  it("ends each part where a clip of the model can, nearest the spot, so that rendered clips meet on the lyric lines", () => {
    // H3: 17k + 5 frames at 24 a second; the first opens on a cut, the others carry on from 22 frames (steps of 0.71 s)
    const clipGrid = { fps: 24, grid: { step: 17, offset: 5 }, head: 22, firstHead: 0 };
    // the owner's song (2026-10-27) from its first sung line: lines end at 15.878, 20.745, 25.532, 30.239, 34.548
    const lines = [10.851, 12.766, 15.878, 18.032, 20.745, 23.059, 25.532, 27.926, 30.239, 32.633, 34.548, 37.66].map((end, k, all) => ({ start: k ? all[k - 1]! : 2.553, end }));
    const parts = recordingParts({ fromS: 10.8, toS: 40, wantS: 5, ...bounds, pauses: [], lines, clipGrid });
    const ends = parts.slice(0, -1).map((p) => p.start + p.seconds);
    // the first a count of H3's frames, the others whole steps after their run-up
    expect(Math.round(parts[0]!.seconds * 24 - 5) % 17).toBe(0);
    for (const p of parts.slice(1, -1)) expect(Math.round(p.seconds * 24) % 17).toBe(0);
    // each within half a step of a line's end, and the error never carried on: the cuts do not slide off the lines
    for (const e of ends) expect(Math.min(...[15.878, 20.745, 25.532, 30.239, 34.548, 37.66].map((l) => Math.abs(l - e)))).toBeLessThan(17 / 48);
    // the panel counts them on the lines within half a step
    for (const e of ends) expect(cutOn(e, { pauses: [], lines }, 1.5, 17 / 48)).toBe("line");
    expect(cutOn(ends[0]!, { pauses: [], lines }, 1.5)).toBe("quiet");
    // the parts meet end to end, to the hundredth
    for (const [k, p] of parts.slice(1).entries()) expect(p.start).toBeCloseTo(parts[k]!.start + parts[k]!.seconds, 5);
    // carrying on from a clip before, the first is a whole number of steps too
    const carried = recordingParts({ fromS: 10.8, toS: 40, wantS: 5, ...bounds, pauses: [], lines, clipGrid: { ...clipGrid, firstHead: 22 } });
    expect(Math.round(carried[0]!.seconds * 24) % 17).toBe(0);
  });

  it("keeps the window within what one clip takes", () => {
    // 4 s asked ± 1.5: never under the 4 s a clip takes, a dip at 3 s passed by
    const parts = recordingParts({ fromS: 0, toS: 30, wantS: 4, ...bounds, pauses: [{ start: 2.9, end: 3.1 }], levels: levels(30, { 3: -80 }) });
    for (const p of parts) expect(p.seconds).toBeGreaterThanOrEqual(4);
    // 14.5 asked ± 1.5: never over the most
    for (const p of recordingParts({ fromS: 0, toS: 60, wantS: 14.5, ...bounds, pauses: [], levels: levels(60, { 15.5: -80 }) })) expect(p.seconds).toBeLessThanOrEqual(14.83);
  });
});
