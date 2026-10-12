import { describe, expect, it } from "vitest";
import { plan, takes, UNKNOWN_LOAD_MS, type Lane, type Planned } from "../src/schedule";

/** Which machine takes which waiting job (schedule.ts): down the line, each to the machine that would finish it first. */

const lane = (id: string, over: Partial<Lane> = {}): Lane => ({ id, takes: "all", busyForMs: 0, holds: new Set(), pace: 1, ...over });
const job = (id: string, over: Partial<Planned> = {}): Planned => ({ id, makes: "image", pin: null, model: "sdxl", renderMs: 20_000, loadMs: 30_000, ...over });
const where = (lanes: Lane[], jobs: Planned[]) => Object.fromEntries([...plan(lanes, jobs)].map(([id, p]) => [id, p.lane]));

describe("the plan", () => {
  it("keeps the line's order on one machine, each job starting when the one before ends", () => {
    const got = plan([lane("m1", { holds: new Set(["sdxl"]) })], [job("a"), job("b"), job("c", { model: "flux" })]);
    expect([...got].map(([id, p]) => [id, p.lane, p.startsInMs])).toEqual([["a", "m1", 0], ["b", "m1", 20_000], ["c", "m1", 40_000]]);
  });

  it("leaves a job for the machine that holds its model when that one frees up sooner than a load takes", () => {
    const lanes = [lane("m1", { busyForMs: 5_000, holds: new Set(["sdxl"]) }), lane("m2")];
    expect(where(lanes, [job("a")])).toEqual({ a: "m1" });
    // the same machine busy for longer than the load: the free one loads it
    expect(where([lane("m1", { busyForMs: 60_000, holds: new Set(["sdxl"]) }), lane("m2")], [job("a")])).toEqual({ a: "m2" });
  });

  it("waits a little for a faster machine rather than taking a slow one that is free", () => {
    const lanes = [lane("fast", { busyForMs: 10_000, holds: new Set(["wan"]) }), lane("slow", { pace: 3, holds: new Set(["wan"]) })];
    expect(where(lanes, [job("clip", { model: "wan", renderMs: 60_000 })])).toEqual({ clip: "fast" });
    // a short one goes to the free machine all the same
    expect(where(lanes, [job("pic", { model: "wan", renderMs: 2_000 })])).toEqual({ pic: "slow" });
  });

  it("never waits for a machine whose running job's end cannot be told", () => {
    expect(where([lane("m1", { busyForMs: null, holds: new Set(["sdxl"]) }), lane("m2")], [job("a")])).toEqual({ a: "m2" });
  });

  it("shares a line of the same model between two free machines", () => {
    const lanes = [lane("m1", { holds: new Set(["sdxl"]) }), lane("m2", { holds: new Set(["sdxl"]) })];
    expect(where(lanes, [job("a"), job("b"), job("c")])).toEqual({ a: "m1", b: "m2", c: "m1" });
  });

  it("takes a load it knows nothing of as a modest one, so a machine holding the model is still preferred", () => {
    const lanes = [lane("m1", { busyForMs: UNKNOWN_LOAD_MS - 1, holds: new Set(["sdxl"]) }), lane("m2")];
    expect(where(lanes, [job("a", { loadMs: null, renderMs: null })])).toEqual({ a: "m1" });
  });

  it("gives a machine only what it takes, a pinned job only to its machine, and leaves out what none takes", () => {
    const lanes = [lane("m1", { takes: "video" }), lane("m2", { takes: "image" })];
    expect(where(lanes, [job("pic"), job("clip", { makes: "video" }), job("pinned", { pin: "m1" }), job("gone", { pin: "m9" })])).toEqual({ pic: "m2", clip: "m1", pinned: "m1" });
    expect(takes({ id: "m2", takes: "image" }, { makes: "video", pin: "m2" })).toBe(true);
  });
});
