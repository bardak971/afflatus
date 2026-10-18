import { describe, expect, it } from "vitest";
import { Planner, type Able, type PodFetch } from "../src/queuePlan";
import type { JobRow, Lane } from "../src/queueModel";

/**
 * Which pods are sent a waiting job's files. A job's files went "ahead" to every pod that could take it: two pods busy with
 * other work pulled 40 GB each for jobs that ran on a third (2026-10-18). Now: "need" to the pod a job is planned on; "ahead"
 * only for a job planned on no pod, to one idle pod; and what was sent for jobs that may no longer run there is dropped.
 */

const file = (name: string) => ({ file: name, folder: "diffusion_models" });
const lane = (id: string, o: { rented?: boolean; running?: boolean; outside?: boolean; paused?: boolean } = {}): Lane =>
  ({ id, machine: { id, ...(o.rented === false ? {} : { rented: { provider: "runpod" } }) }, running: o.running ? { id: "x" } : null, starting: null, paused: Boolean(o.paused), outside: o.outside ? { running: 1, pending: 0 } : null, outsideAt: Date.now() }) as unknown as Lane;

function planner(lanes: Lane[], allPaused = false) {
  const sent: Array<{ lane: string; tier: string; job: string; files: string[] }> = [];
  const dropped: Array<{ lane: string; kept: string[] }> = [];
  const podFetch = {
    want: (machine: string, files: Array<{ file: string }>, tier: string, job: string) => void sent.push({ lane: machine, tier, job, files: files.map((f) => f.file) }),
    drop: (machine: string, mayRun: (job: string) => boolean) => void dropped.push({ lane: machine, kept: ["a", "b", "c", "gone"].filter(mayRun) }),
  } as unknown as PodFetch;
  const p = new Planner({ podFetch, allPaused: () => allPaused, lane: (id: string) => lanes.find((l) => l.id === id), machineLanes: () => lanes } as never);
  return { p, sent, dropped };
}
const row = (id: string, pin: string | null = null) => ({ id, pin_machine: pin }) as JobRow;
const able = (fetch: Record<string, string[]>): Able => ({ can: new Set(Object.keys(fetch)), lacks: {}, fetch: Object.fromEntries(Object.entries(fetch).map(([l, f]) => [l, { files: f.map(file), ms: 0 }])) });

describe("the files sent to pods for the waiting jobs", () => {
  it("go to the pod each job is planned on: three takes on three idle pods, each its own", () => {
    const { p, sent } = planner([lane("p1"), lane("p2"), lane("p3")]);
    const rows = [row("a"), row("b"), row("c")];
    const all = { p1: ["h3.safetensors"], p2: ["h3.safetensors"], p3: ["h3.safetensors"] };
    p.sendFiles(rows, new Map(rows.map((r) => [r.id, able(all)])), new Map([["a", { lane: "p1" }], ["b", { lane: "p2" }], ["c", { lane: "p3" }]]), rows);
    expect(sent).toEqual([
      { lane: "p1", tier: "need", job: "a", files: ["h3.safetensors"] },
      { lane: "p2", tier: "need", job: "b", files: ["h3.safetensors"] },
      { lane: "p3", tier: "need", job: "c", files: ["h3.safetensors"] },
    ]);
  });

  it("go ahead, for a job planned on this PC, to one idle pod only: never to a busy one, one busy outside Afflatus, or one with work planned", () => {
    const lanes = [lane("home", { rented: false }), lane("busy", { running: true }), lane("outside", { outside: true }), lane("planned"), lane("idle1"), lane("idle2")];
    const { p, sent } = planner(lanes);
    const rows = [row("a"), row("b")];
    const fetch = { busy: ["x.safetensors"], outside: ["x.safetensors"], planned: ["x.safetensors"], idle1: ["x.safetensors"], idle2: ["x.safetensors"] };
    p.sendFiles(rows, new Map([["a", able(fetch)], ["b", able({})]]), new Map([["a", { lane: "home" }], ["b", { lane: "planned" }]]), rows);
    expect(sent).toEqual([{ lane: "idle1", tier: "ahead", job: "a", files: ["x.safetensors"] }]);
  });

  it("go nowhere else for a job planned on a pod that has its files already", () => {
    const { p, sent } = planner([lane("p1"), lane("p2")]);
    const rows = [row("a")];
    p.sendFiles(rows, new Map([["a", able({ p2: ["x.safetensors"] })]]), new Map([["a", { lane: "p1" }]]), rows);
    expect(sent).toEqual([]);
  });

  it("are dropped from a pod once none of their jobs may run there: done, cancelled, or pinned to another machine", () => {
    const { p, dropped } = planner([lane("home", { rented: false }), lane("p1"), lane("p2")]);
    // a is waiting, b is pinned to p2, c is pinned to p1; "gone" is not in the queue any more
    p.sendFiles([], new Map(), new Map(), [row("a"), row("b", "p2"), row("c", "p1")]);
    expect(dropped).toEqual([{ lane: "p1", kept: ["a", "c"] }, { lane: "p2", kept: ["a", "b"] }]);
  });
});
