import { describe, expect, it } from "vitest";
import { plan, planTotal, takes, UNKNOWN_LOAD_MS, type Lane, type Planned } from "../src/schedule";

/** Which machine takes which waiting job (schedule.ts): down the line, each to the machine that would finish it first. */

const lane = (id: string, over: Partial<Lane> = {}): Lane => ({ id, takes: "all", busyForMs: 0, holds: new Set(), pace: 1, ...over });
const job = (id: string, over: Partial<Planned> = {}): Planned => ({ id, makes: "image", pin: null, model: "sdxl", renderMs: 20_000, loadMs: 30_000, ...over });
const where = (lanes: Lane[], jobs: Planned[]) => Object.fromEntries([...plan(lanes, jobs)].map(([id, p]) => [id, p.lane]));

describe("the plan", () => {
  it("counts a pod's files on their way: the job starts there once they came, and goes where it ends sooner", () => {
    // home busy for a minute; the pod free but two minutes from having the job's files
    const lanes = [lane("home", { busyForMs: 60_000, holds: new Set(["sdxl"]) }), lane("pod", { holds: new Set(["sdxl"]) })];
    const got = plan(lanes, [job("a", { fetchMs: new Map([["pod", 120_000]]) })]);
    expect(got.get("a")).toEqual({ lane: "home", startsInMs: 60_000, endsInMs: 80_000 });
    // home busy for longer than the files take: the pod, once they are there
    const busy = [lane("home", { busyForMs: 600_000, holds: new Set(["sdxl"]) }), lane("pod", { holds: new Set(["sdxl"]) })];
    expect(plan(busy, [job("a", { fetchMs: new Map([["pod", 120_000]]) })]).get("a")).toEqual({ lane: "pod", startsInMs: 120_000, endsInMs: 140_000 });
    // files that cannot be told to come (no source): never the sooner place
    expect(where(lanes, [job("a", { fetchMs: new Map([["pod", Infinity]]) })])).toEqual({ a: "home" });
  });

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

describe("a job's files", () => {
  it("go only to the machines that have them; a job pinned to one without them waits", () => {
    expect(where([lane("m1", { busyForMs: 60_000 }), lane("m2")], [job("a", { can: new Set(["m1"]) })])).toEqual({ a: "m1" });
    expect(where([lane("m1"), lane("m2")], [job("a", { can: new Set(["m1"]), pin: "m2" })])).toEqual({});
    expect(takes({ id: "m2", takes: "all" }, { makes: "image", pin: null, can: new Set() })).toBe(false);
  });

  it("reads each machine's own figure for a job before the common one at its pace", () => {
    // the common figure says 15 min, and the pod's pace from other models 0.8; its own renders of the model say 220 s
    const lanes = [lane("home", { busyForMs: 300_000, holds: new Set(["scail"]) }), lane("pod", { pace: 0.8, holds: new Set(["scail"]) })];
    const scail = (id: string) => job(id, { makes: "video", model: "scail", renderMs: 900_000, renderOn: new Map([["home", 900_000], ["pod", 220_000]]) });
    const got = plan(lanes, [scail("a"), scail("b"), scail("c")]);
    // at 220 s a window the pod takes them all, one after another, before home is free and done with one
    expect([...got].map(([id, p]) => [id, p.lane, p.startsInMs])).toEqual([["a", "pod", 0], ["b", "pod", 220_000], ["c", "pod", 440_000]]);
    // its load too: a pod's disk is not this computer's
    const cold = [lane("home", { busyForMs: 300_000 }), lane("pod")];
    expect(where(cold, [job("a", { renderOn: new Map([["home", 20_000], ["pod", 20_000]]), loadOn: new Map([["pod", 400_000]]) })])).toEqual({ a: "home" });
  });
});

describe("a job like nothing rendered yet", () => {
  it("does not make the next job's start early: its machine says no time after it, and the next goes elsewhere", () => {
    const lanes = [lane("m1", { holds: new Set(["sdxl"]) }), lane("m2", { holds: new Set(["sdxl"]) })];
    const got = plan(lanes, [job("new", { renderMs: null }), job("b"), job("c"), job("d", { pin: "m1" })]);
    // placed where it starts soonest, ending at a time that cannot be told
    expect(got.get("new")).toEqual({ lane: "m1", startsInMs: 0, endsInMs: Infinity });
    // the others share the machine whose end is known, never counting the unknown one as nothing
    expect(got.get("b")).toMatchObject({ lane: "m2", startsInMs: 0 });
    expect(got.get("c")).toMatchObject({ lane: "m2", startsInMs: 20_000 });
    // and one that can only go behind it says no start
    expect(got.get("d")!.startsInMs).toBe(Infinity);
  });
});

describe("what a line of jobs takes in all", () => {
  it("is about halved by two free machines: a two-job Finish on two machines takes one job's time", () => {
    const finish = (id: string) => job(id, { makes: "video", model: null, renderMs: 100_000, loadMs: null, frees: true });
    expect(planTotal([lane("m1")], [finish("a"), finish("b")])).toBe(200_000);
    expect(planTotal([lane("m1"), lane("m2")], [finish("a"), finish("b")])).toBe(100_000);
    // each machine at its own pace: the slow one takes nothing it would end later than the fast one would
    expect(planTotal([lane("m1"), lane("pod", { pace: 3 })], [finish("a"), finish("b")])).toBe(200_000);
  });

  it("loads a model once per machine for a run of renders with it, and again after a finish on the GPU freed it", () => {
    expect(planTotal([lane("m1")], [job("a"), job("b")])).toBe(30_000 + 2 * 20_000);
    expect(planTotal([lane("m1", { holds: new Set(["sdxl"]) })], [job("a"), job("f", { model: null, renderMs: 5_000, frees: true }), job("b")])).toBe(20_000 + 5_000 + 30_000 + 20_000);
  });

  it("keeps a clip carried on from the one before after it, on two machines too", () => {
    const lanes = [lane("m1", { holds: new Set(["sdxl"]) }), lane("m2", { holds: new Set(["sdxl"]) })];
    expect(planTotal(lanes, [job("a"), job("b", { after: "a" })])).toBe(40_000);
    expect(planTotal(lanes, [job("a"), job("b")])).toBe(20_000);
  });

  it("is not told when a job cannot be placed or its time is not known", () => {
    expect(planTotal([lane("m1")], [job("a", { pin: "m9" })])).toBeNull();
    expect(planTotal([lane("m1")], [job("a", { renderMs: null })])).toBeNull();
  });
});
