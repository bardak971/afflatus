import { describe, expect, it } from "vitest";
import { barsOf, evenly, levelOf, LEVELS, proposedTrim, takeName, trimSaid, type Level, type Reading } from "../src/mic/take";

/** A take read at LEVELS a second: `quiet` seconds of silence, `voice` of speech, `after` of silence. */
function take(quiet: number, voice: number, after: number): { levels: Level[]; total: number } {
  const of = (s: number, db: number) => Array.from({ length: Math.round(s * LEVELS) }, () => ({ peak: db > -40 ? 0.5 : 0.001, db }));
  return { levels: [...of(quiet, -70), ...of(voice, -12), ...of(after, -70)], total: quiet + voice + after };
}

describe("the trim proposed for a take", () => {
  it("cuts the silence at both ends, a little of it kept", () => {
    const t = take(0.65, 3.5, 0.85);
    const trim = proposedTrim(t.levels, t.total)!;
    expect(trim.from).toBeCloseTo(0.5, 2);
    expect(trim.to).toBeCloseTo(0.65 + 3.5 + 0.15, 2);
    expect(trimSaid(trim, t.total)).toBe("Cuts 0.5 s of silence at the start and 0.7 s at the end: 3.8 s left.");
  });

  it("cuts one end alone when only that end is silent", () => {
    const t = take(0, 3, 1);
    const trim = proposedTrim(t.levels, t.total)!;
    expect(trim.from).toBe(0);
    expect(trimSaid(trim, t.total)).toBe("Cuts 0.9 s of silence at the end: 3.1 s left.");
  });

  it("proposes nothing for a take with no silence at its ends, one of silence alone, or a pause too short to count", () => {
    expect(proposedTrim(take(0, 3, 0).levels, 3)).toBeNull();
    expect(proposedTrim(take(2, 0, 0).levels, 2)).toBeNull();
    // under a quarter second: a breath, not a silence
    expect(proposedTrim(take(0.15, 3, 0.15).levels, 3.3)).toBeNull();
    expect(proposedTrim([], 0)).toBeNull();
  });

  it("keeps a pause between the words: only the ends are cut", () => {
    const t = { levels: [...take(0.5, 1, 1).levels, ...take(0, 1, 0.5).levels], total: 4 };
    const trim = proposedTrim(t.levels, t.total)!;
    expect(trim.from).toBeCloseTo(0.35, 2);
    expect(trim.to).toBeCloseTo(3.65, 2);
  });
});

describe("the trim of a take read late (a busy PC, a hidden tab)", () => {
  /** Readings `every` seconds apart: silence, then a voice from `from` to `to`, then silence, over `total` seconds. */
  const late = (every: number, from: number, to: number, total: number): Reading[] =>
    Array.from({ length: Math.floor(total / every) }, (_, k) => {
      const at = (k + 1) * every;
      // a reading hears the last moment before it: the voice while it lasts
      return { at, level: at > from && at <= to + 0.02 ? { peak: 0.5, db: -12 } : { peak: 0.001, db: -70 } };
    });

  it("trims at the voice's own times with fewer readings than LEVELS a second", () => {
    // 8 readings a second, not 20: counted as 20 a second the voice would end at 1.2 s and the trim cut its last words
    const total = 4;
    const levels = evenly(late(1 / 8, 1, 3, total), total);
    expect(levels).toHaveLength(total * LEVELS);
    const trim = proposedTrim(levels, total)!;
    expect(trim.from).toBeGreaterThan(0.7);
    expect(trim.from).toBeLessThanOrEqual(1);
    expect(trim.to).toBeGreaterThanOrEqual(3);
    expect(trim.to).toBeLessThan(3.4);
  });

  it("counts a gap in the readings next to the voice as the voice, so a word is never cut", () => {
    // read once a second (a hidden tab): the voice from 1.5 s to 2.5 s is heard by the reading at 2 s only
    const readings: Reading[] = [1, 2, 3, 4].map((at) => ({ at, level: at === 2 ? { peak: 0.5, db: -12 } : { peak: 0.001, db: -70 } }));
    const trim = proposedTrim(evenly(readings, 4), 4)!;
    expect(trim.from).toBeLessThanOrEqual(1.5);
    expect(trim.to).toBeGreaterThanOrEqual(2.5);
  });

  it("gives nothing for a take with no reading", () => {
    expect(evenly([], 3)).toEqual([]);
  });
});

describe("a take's numbers", () => {
  it("reads a window's loudest sample and loudness", () => {
    expect(levelOf([0.5, -0.5, 0.5, -0.5])).toEqual({ peak: 0.5, db: expect.closeTo(-6.02, 1) as number });
    expect(levelOf([0, 0]).db).toBe(-90);
    expect(levelOf([1.4]).peak).toBe(1);
  });

  it("draws a long take in the bars it is given, each the loudest of its share", () => {
    const levels = Array.from({ length: 400 }, (_, k) => ({ peak: k === 399 ? 1 : 0.01, db: -40 }));
    const bars = barsOf(levels, 180);
    expect(bars).toHaveLength(180);
    expect(bars.at(-1)).toBe(100);
    expect(barsOf(levels.slice(0, 10), 180)).toHaveLength(10);
  });

  it("names a take with nothing a file name cannot hold", () => {
    const name = takeName("Clip 3's voice", new Date(2026, 9, 26, 14, 3));
    expect(name).toMatch(/^Recording · Clip 3's voice · .+ 14\.03$/);
    expect(name).not.toMatch(/[:*?"<>|\/]/);
  });
});
