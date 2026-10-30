import { describe, expect, it } from "vitest";
import type { Clip, Measure, Take } from "../src/api";
import { change, colourShift, DRIFT, driftOf, driftWords, past, pct, runEnd, runSeries, runStart, runTicks, sharpOf, signed } from "../src/timeline/lookDrift";
import { clipFacts } from "../src/timeline/track/peek";

const measure = (luma: number, sharp: number, more: Partial<Measure> = {}): Measure => ({ luma, sharp, ...more });

/** A clip as the drift reads it: how it joins, and the measure of the take that plays. */
const clip = (joined: "continue" | "cut", m: Measure | null) => ({ joined, take: m ? ({ measure: m } as Take) : null }) as Pick<Clip, "joined" | "take">;

describe("how far a look slides along its run", () => {
  // clip 1 cut, clips 2-4 one run, clip 5 a cut that starts another
  const clips = [clip("cut", measure(100, 10)), clip("continue", measure(101, 9)), clip("continue", measure(90, 6.6, { pace: 3 })), clip("continue", measure(99, 8)), clip("cut", measure(80, 5))];

  it("finds the run's first and last clip", () => {
    expect(runStart(clips, 3)).toBe(0);
    expect(runStart(clips, 0)).toBe(0);
    expect(runStart(clips, 4)).toBe(4);
    expect(runEnd(clips, 1)).toBe(3);
    expect(runEnd(clips, 4)).toBe(4);
  });

  it("says a change as a part, a tiny figure kept from blowing it up, and with a real minus", () => {
    expect(change(68, 100)).toBeCloseTo(-0.32);
    expect(change(0.02, 0.001, 0.01)).toBeCloseTo(1.9);
    expect(change(null, 3)).toBeNull();
    expect(pct(-0.32)).toBe("−32 %");
    expect(pct(0.012)).toBe("+1 %");
    // a change that rounds to nothing has no minus
    expect(pct(-0.004)).toBe("+0 %");
    expect(signed(-1.24)).toBe("−1.2");
    expect(signed(-0.01)).toBe("+0.0");
    expect(colourShift(measure(1, 1, { chroma: { u: 3, v: 4 } }), measure(1, 1, { chroma: { u: 0, v: 0 } }))).toBe(5);
    expect(colourShift(measure(1, 1), measure(1, 1, { chroma: { u: 0, v: 0 } }))).toBeNull();
  });

  it("warns past the thresholds: darker than -8 %, softer than -15 %, slower than -15 %, a colour shift past 3", () => {
    expect(DRIFT).toMatchObject({ luma: -0.08, sharp: -0.15, pace: -0.15, colour: 3 });
    expect(past("luma", -0.09)).toBe(true);
    expect(past("luma", -0.07)).toBe(false);
    expect(past("sharp", -0.16)).toBe(true);
    expect(past("pace", -0.1)).toBe(false);
    expect(past("colour", 3.2)).toBe(true);
    expect(past("colour", null)).toBe(false);
  });

  it("reads a clip against the one before and against the run's start", () => {
    const d = driftOf(clips, 2)!;
    expect(d).toMatchObject({ start: 0, before: 1, same: false });
    expect(d.hop.luma).toBeCloseTo(90 / 101 - 1);
    expect(d.whole.sharp).toBeCloseTo(-0.34);
    // a figure the other take does not carry
    expect(d.whole.pace).toBeNull();
    expect(driftWords(d)).toBe("darker, softer than clip 1");
  });

  it("says one column when the clip before is the run's start", () => {
    expect(driftOf(clips, 1)).toMatchObject({ start: 0, before: 0, same: true });
  });

  it("says nothing for a cut, the first clip, or a take not measured", () => {
    expect(driftOf(clips, 0)).toBeNull();
    expect(driftOf(clips, 4)).toBeNull();
    expect(driftOf([clip("cut", measure(1, 1)), clip("continue", null)], 1)).toBeNull();
    expect(driftWords(null)).toBeNull();
  });

  it("warns against the clip before when the run's start is still close", () => {
    const d = driftOf([clip("cut", measure(100, 10)), clip("continue", measure(100, 12)), clip("continue", measure(100, 9.5))], 2);
    expect(driftWords(d)).toBe("softer than clip 2");
  });

  it("draws the whole run against its start, a clip not measured as a gap", () => {
    const run = runSeries([...clips.slice(0, 2), clip("continue", null), ...clips.slice(3)], 1);
    expect(run.map((p) => p.index)).toEqual([0, 1, 2, 3]);
    expect(run[0]).toEqual({ index: 0, sharp: 1, luma: 1, grain: null });
    expect(run[2]).toEqual({ index: 2, sharp: null, luma: null, grain: null });
    expect(run[3]!.sharp).toBeCloseTo(0.8);
    // a start not measured: nothing to draw against
    expect(runSeries([clip("cut", null), clip("continue", measure(1, 1))], 1)).toEqual([]);
  });

  it("marks a few clip numbers under the chart, the shown one first, and fits a run of 60", () => {
    expect(runTicks(2, 1)).toEqual([0, 1]);
    expect(runTicks(3, 1)).toEqual([0, 1, 2]);
    // 20 clips from clip 1: the ends, every fifth, the shown one (15)
    expect(runTicks(20, 14)).toEqual([0, 4, 9, 14, 19]);
    const sixty = runTicks(60, 33, 1);
    expect(sixty).toContain(33);
    expect(sixty).toContain(0);
    expect(sixty).toContain(59);
    expect(sixty.length).toBeLessThanOrEqual(8);
    // none crowd another
    for (let i = 1; i < sixty.length; i++) expect(sixty[i]! - sixty[i - 1]!).toBeGreaterThanOrEqual(60 / 8);
  });
});

describe("the clip's figures on the hover card", () => {
  const asset = { id: "a", width: 1024, height: 576, fps: 48 } as Take["asset"];
  const takeOf = (id: string, more: Partial<Take> = {}) => ({ id, asset, joinKind: null, renderMs: 450_000, trimStartMs: 0, trimEndMs: 0, measure: null, ...more }) as unknown as Take;
  const video = (more: Partial<Clip>): Clip => ({ id: "c", kind: "video", joined: "cut", join: null, job: null, failed: null, lengthMs: 6400, recipe: "h3", takes: [], take: null, still: null, ...more }) as unknown as Clip;

  it("says length, render time, join, run-up, take, size and a render on its way", () => {
    const t1 = takeOf("t1", { measure: measure(100, 12) });
    const t2 = takeOf("t2", { joinKind: "seamless", seamless: true, measure: measure(101, 8.2, { drift: { width: 1.02 } }) });
    const first = video({ id: "c1", take: t1, takes: [t1] });
    const second = video({ id: "c2", joined: "continue", join: "fresh", take: t2, takes: [t1, t2], job: { id: "j", status: "running" } });
    const f = clipFacts(second, 1, [first, second], 1.1);
    expect(f.head).toEqual({ text: "6.4 s", detail: "rendered in 7 min 30 s" });
    expect(f.chips).toEqual([
      { text: "seamless join ×1.1", tone: "accent" },
      { text: "run-up ×1.02", tone: "neutral" },
      { text: "take 2 of 2", tone: "neutral" },
    ]);
    expect(f.drift).toMatchObject({ start: 0, same: true });
    expect(f.drift!.whole.sharp).toBeCloseTo(-0.32);
    expect(f.foot).toEqual([{ text: "1024 × 576 · 48 fps" }, { text: "rendering a new take", tone: "accent" }]);
    expect(f.lines).toEqual([]);
  });

  it("says the face figure of the take that plays, beside its join (card #18)", () => {
    const t = takeOf("t", { measure: measure(100, 12, { face: 0.712 }) });
    const f = clipFacts(video({ id: "a", take: t, takes: [t] }), 0, [video({ id: "a", take: t, takes: [t] })], null);
    expect(f.chips).toEqual([{ text: "face 0.71", tone: "neutral" }]);
  });

  it("gives a cut no figures, and keeps what needs attention", () => {
    const t = takeOf("t", { measure: measure(100, 12) });
    const a = video({ id: "a", take: t, takes: [t] });
    const b = video({ id: "b", take: t, takes: [t], join: "stale", failed: "out of memory" });
    const f = clipFacts(b, 1, [a, b], null);
    expect(f.chips).toEqual([{ text: "hard cut", tone: "neutral" }]);
    expect(f.drift).toBeNull();
    expect(f.lines).toEqual([{ text: "The last render failed", tone: "warn" }, { text: "Join stale: clip 1 changed since", tone: "attention" }]);
  });

  it("keeps a few words for a still or a clip not rendered", () => {
    expect(clipFacts(video({ kind: "still", lengthMs: 3000 }), 0, [], null)).toMatchObject({ head: null, lines: [{ text: "Still · 3.0 s" }] });
    expect(clipFacts(video({ lengthMs: 0 }), 0, [], null).lines).toEqual([{ text: "Not rendered yet", tone: "dim" }]);
    expect(clipFacts(video({ lengthMs: 0, failed: "x" }), 0, [], null).lines).toEqual([{ text: "The render failed", tone: "warn" }]);
    expect(clipFacts(video({ lengthMs: 0, job: { id: "j", status: "queued" } }), 0, [], null).lines).toEqual([{ text: "Queued for a render", tone: "dim" }]);
  });
});

describe("grain and sharpness without it", () => {
  const m = (sharp: number, edges?: number, grain?: number) => ({ luma: 100, sharp, ...(edges != null ? { edges } : {}), ...(grain != null ? { grain } : {}) });
  it("compares sharpness without the grain when both takes have it, else the older figure for both", () => {
    expect(sharpOf(m(9, 4), m(6, 5))).toBe(4);
    expect(sharpOf(m(9, 4), m(6))).toBe(9);
    expect(sharpOf(m(9))).toBe(9);
  });
  it("warns of a clip grainier than the one before, and says so", () => {
    const clips = [{ joined: "cut" as const, take: { measure: m(5, 4, 0.6) } }, { joined: "continue" as const, take: { measure: m(6, 4, 1.2) } }] as never;
    const d = driftOf(clips, 1)!;
    expect(d.hop.grain).toBeCloseTo(1);
    expect(past("grain", d.hop.grain)).toBe(true);
    expect(driftWords(d)).toMatch(/grainier/);
  });
});

describe("the face along a run", () => {
  it("warns of a clip whose person drifted against the run's start, and says so", () => {
    const m = (face: number) => ({ luma: 100, sharp: 5, face });
    const clips = [{ joined: "cut" as const, take: { measure: m(0.54) } }, { joined: "continue" as const, take: { measure: m(0.52) } }, { joined: "continue" as const, take: { measure: m(0.29) } }] as never;
    expect(past("face", driftOf(clips, 1)!.hop.face)).toBe(false);
    const d = driftOf(clips, 2)!;
    expect(d.whole.face).toBeCloseTo(-0.46, 2);
    expect(driftWords(d)).toMatch(/less alike/);
  });
});
