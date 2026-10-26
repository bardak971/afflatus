import { describe, expect, it } from "vitest";
import { aroundRemoved, keptAround, type RemovedPart } from "../src/timelineRemoved";

/** A removed part of one clip, `id`, kept with clip `before`. */
const part = (id: string, before: string): RemovedPart => ({ before, rows: [{ clip: { id, take_id: `t-${id}` }, takes: [{ id: `t-${id}` }] }], joined: "continue", take: null });

describe("a stretch made anew around its removed parts (card #114)", () => {
  it("leaves the pieces between the parts, each with the parts just before it; one not held whole is dropped", () => {
    const a = part("a", "x");
    const b = part("b", "y");
    const c = part("c", "z");
    const d = part("d", "w");
    const { pieces, dropped } = aroundRemoved(5000, 30000, [
      { part: b, fromMs: 10000, toMs: 12000 },
      { part: a, fromMs: 3000, toMs: 6000 },
      { part: c, fromMs: 12000, toMs: 15000 },
      { part: d, fromMs: 29000, toMs: 31000 },
    ]);
    // a starts before the In, d has nothing after it: both go; b and c lie end to end, one gap
    expect(dropped).toEqual([a, d]);
    expect(pieces).toEqual([{ fromMs: 5000, toMs: 10000, after: [] }, { fromMs: 15000, toMs: 30000, after: [b, c] }]);
  });

  it("keeps each part with the first clip after it, and one a piece made no clip of with the next clip, as one part", () => {
    const b = part("b", "y");
    const c = part("c", "z");
    const pieces = [{ after: [] }, { after: [b] }, { after: [c] }];
    const kept = keptAround(pieces, ["n0", null, "n2"], (p, before) => ({ ...p, before }));
    expect(kept.dropped).toEqual([]);
    expect(kept.kept.map((p) => [p.before, p.rows.map((r) => r.clip.id)])).toEqual([["n2", ["b", "c"]]]);
    // none after them: dropped
    expect(keptAround(pieces, ["n0", "n1", null], (p, before) => ({ ...p, before })).dropped).toEqual([c]);
  });
});
