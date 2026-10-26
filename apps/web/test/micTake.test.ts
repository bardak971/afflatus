import { describe, expect, it } from "vitest";
import { barsOf, levelOf, LEVELS, proposedTrim, takeClock, trimSaid, type Level } from "../src/mic/take";

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

  it("says a time to the tenth", () => {
    expect(takeClock(4.76)).toBe("0:04.7");
    expect(takeClock(65.2)).toBe("1:05.2");
    expect(takeClock(0)).toBe("0:00.0");
  });
});
