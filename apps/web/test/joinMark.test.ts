import { describe, expect, it } from "vitest";
import { cutAtJoinFigure, cutAtJoinSaid, cutsAtJoin } from "@afflatus/core";
import type { Clip, Take } from "../src/api";
import { joinMarkOf } from "../src/timeline/track/joinMark";
import { clipFacts } from "../src/timeline/track/peek";

const take = (handover?: number, runUpCut?: { atMs: number; db: number } | null): Take => ({ id: "t", startMs: 0, endMs: 3000, headMs: 917, trimStartMs: 0, trimEndMs: 0, asset: { id: "v" }, measure: handover === undefined ? null : { handover, ...(runUpCut !== undefined ? { runUpCut } : {}) }, joinKind: "seamless", seamless: true }) as unknown as Take;
const clip = (over: Partial<Clip>): Clip => ({ id: "c", kind: "video", recipe: "h3.video", inputs: {}, takes: [], joined: "continue", join: "fresh", take: null, job: null, failed: null, lengthMs: 3000, ...over }) as unknown as Clip;

// card #161: Timeline 17's circle between clips 1 and 2 said seamless while clip 2's take cut to a shed (run-up end ×20)
describe("the circle between two clips", () => {
  it("says a seamless join whose take cut at its run-up's end, apart from one that carries on", () => {
    expect(joinMarkOf(clip({ take: take(20) }), true)).toBe("cuts");
    expect(joinMarkOf(clip({ take: take(5.7) }), true)).toBe("cuts");
    // the highest a join that flows read (×2.8), and a take not measured
    expect(joinMarkOf(clip({ take: take(2.8) }), true)).toBe("fresh");
    expect(joinMarkOf(clip({ take: take() }), true)).toBe("fresh");
    // a cut a few frames after the run-up, its step at the join small (Oct 27: 10 frames on, ×0.5)
    expect(joinMarkOf(clip({ take: take(0.5, { atMs: 417, db: 13.6 }) }), true)).toBe("cuts");
    expect(joinMarkOf(clip({ take: take(0.5, null) }), true)).toBe("fresh");
  });

  it("keeps the other states: stale first, a cut, a seamless join still to render", () => {
    expect(joinMarkOf(clip({ join: "stale", take: take(20) }), true)).toBe("stale");
    expect(joinMarkOf(clip({ joined: "cut", join: "cut", take: take(20) }), false)).toBe("cut");
    expect(joinMarkOf(clip({ join: null as unknown as Clip["join"], take: null }), true)).toBe("planned");
  });

  it("says the figure and what it measured, and the hover card carries it as an attention chip", () => {
    expect(cutsAtJoin({ handover: 20 })).toBe(true);
    expect(cutsAtJoin({ handover: 3 })).toBe(false);
    expect(cutsAtJoin(null)).toBe(false);
    expect(cutAtJoinSaid({ handover: 20 })).toBe("the take cuts at the join: where its run-up ends the picture jumps ×20.0 against its own motion (×3 and under carries on). The model left the clip before there: render a new take");
    expect(cutAtJoinSaid({ handover: 0.5, runUpCut: { atMs: 417, db: 13.6 } })).toBe("the take cuts to another shot 0.42 s after its run-up (two frames 13.6 dB apart, at least 6 dB further apart than the frames around them). The model left the clip before there: render a new take");
    expect(cutAtJoinFigure({ handover: 20, runUpCut: { atMs: 0, db: 10.2 } })).toBe("first frame");
    const c = clip({ take: take(20) });
    expect(clipFacts(c, 1, [clip({ id: "a" }), c], null).chips).toContainEqual({ text: "cut at the join · ×20.0", tone: "attention" });
    const flows = clip({ take: take(1.2) });
    expect(clipFacts(flows, 1, [clip({ id: "a" }), flows], null).chips.some((x) => x.text.startsWith("cut at the join"))).toBe(false);
  });
});
