import { describe, expect, it } from "vitest";
import { Planner, type Able, type PodFetch } from "../src/queuePlan";
import type { JobRow, Lane } from "../src/queueModel";

/**
 * Which pods are sent a waiting job's files, and when they are dropped. A job's files went "ahead" to every pod that could
 * take it: two pods busy with other work pulled 40 GB each for jobs that ran on a third (2026-10-18). Then a test pod
 * deployed for one job pinned to it fetched, idle between its renders, the models of the owner's jobs waiting for his PC
 * (card #211). Now: "need" to the pod a job is planned on; "ahead" to the pod a job is pinned to, and for a job placed
 * nowhere (Pause all) that no machine of the user's own can run, to one pod (the one that began its copy, else an idle
 * one); nothing for a job planned on a machine of the user's own; and, at every pass, what a pod was sent for jobs that
 * may no longer run there is dropped.
 */

const file = (name: string) => ({ file: name, folder: "diffusion_models" });
const lane = (id: string, o: { rented?: boolean; running?: boolean; outside?: boolean; paused?: boolean } = {}): Lane =>
  ({ id, machine: { id, ...(o.rented === false ? {} : { rented: { provider: "runpod" } }) }, running: o.running ? { id: "x" } : null, starting: null, paused: Boolean(o.paused), outside: o.outside ? { running: 1, pending: 0 } : null, outsideAt: Date.now() }) as unknown as Lane;

function planner(lanes: Lane[], o: { allPaused?: boolean; holds?: Record<string, string[]> } = {}) {
  const sent: Array<{ lane: string; tier: string; job: string; files: string[] }> = [];
  const asked: Record<string, (job: string) => boolean> = {};
  const podFetch = {
    want: (machine: string, files: Array<{ file: string }>, tier: string, job: string) => void sent.push({ lane: machine, tier, job, files: files.map((f) => f.file) }),
    drop: (machine: string, mayRun: (job: string) => boolean) => void (asked[machine] = mayRun),
    holdsFor: (machine: string, job: string) => Boolean(o.holds?.[machine]?.includes(job)),
  } as unknown as PodFetch;
  const p = new Planner({ podFetch, allPaused: () => Boolean(o.allPaused), lane: (id: string) => lanes.find((l) => l.id === id), machineLanes: () => lanes } as never);
  /** What each pod keeps of these jobs, as the drop would ask it. */
  const kept = (jobs: string[]) => Object.fromEntries(Object.entries(asked).map(([m, mayRun]) => [m, jobs.filter(mayRun)]));
  return { p, sent, kept };
}
const row = (id: string, pin: string | null = null) => ({ id, pin_machine: pin }) as JobRow;
/** `own`: the machines of the user's own that can run it too, with nothing to fetch. */
const able = (fetch: Record<string, string[]>, own: string[] = []): Able => ({ can: new Set([...Object.keys(fetch), ...own]), lacks: {}, fetch: Object.fromEntries(Object.entries(fetch).map(([l, f]) => [l, { files: f.map(file), ms: 0 }])) });

describe("the files sent to pods for the waiting jobs", () => {
  it("go to the pod each job is planned on: three takes on three idle pods, each its own", () => {
    const { p, sent } = planner([lane("p1"), lane("p2"), lane("p3")]);
    const rows = [row("a"), row("b"), row("c")];
    const all = { p1: ["h3.safetensors"], p2: ["h3.safetensors"], p3: ["h3.safetensors"] };
    p.sendFiles(rows, new Map(rows.map((r) => [r.id, able(all)])), new Map([["a", { lane: "p1" }], ["b", { lane: "p2" }], ["c", { lane: "p3" }]]));
    expect(sent).toEqual([
      { lane: "p1", tier: "need", job: "a", files: ["h3.safetensors"] },
      { lane: "p2", tier: "need", job: "b", files: ["h3.safetensors"] },
      { lane: "p3", tier: "need", job: "c", files: ["h3.safetensors"] },
    ]);
  });

  it("go to no pod for the jobs planned on this PC: a pod idle between the renders of the job pinned to it fetches none of theirs", () => {
    // card #211's run: a test pod deployed for one job pinned to it, that job done; the owner's two jobs waiting for his PC,
    // which runs a third. The pod, idle, could take either once sent its model, and had begun one's (13.5 GB) a pass before
    const { p, sent, kept } = planner([lane("m1", { rented: false, running: true }), lane("pod")], { holds: { pod: ["a"] } });
    const rows = [row("a"), row("b")];
    const s = p.sendFiles(rows, new Map([["a", able({ pod: ["muse.safetensors"] }, ["m1"])], ["b", able({ pod: ["krea.safetensors"] }, ["m1"])]]), new Map([["a", { lane: "m1" }], ["b", { lane: "m1" }]]));
    p.dropUnsought(rows, s);
    expect(sent).toEqual([]);
    // the copy it had begun is stopped (what is in stays: dropUnsought leaves a file that came)
    expect(kept(["a", "b"])).toEqual({ pod: [] });
  });

  it("go ahead, for a job placed nowhere (Pause all) that only a pod can run, to one idle pod only: never to a busy one, one busy outside Afflatus, or one with work planned", () => {
    const lanes = [lane("home", { rented: false }), lane("busy", { running: true }), lane("outside", { outside: true }), lane("planned"), lane("idle1"), lane("idle2")];
    const { p, sent } = planner(lanes, { allPaused: true });
    const rows = [row("a"), row("b")];
    const fetch = { busy: ["x.safetensors"], outside: ["x.safetensors"], planned: ["x.safetensors"], idle1: ["x.safetensors"], idle2: ["x.safetensors"] };
    p.sendFiles(rows, new Map([["a", able(fetch)], ["b", able({})]]), new Map([["b", { lane: "planned" }]]));
    expect(sent).toEqual([{ lane: "idle1", tier: "ahead", job: "a", files: ["x.safetensors"] }]);
  });

  it("go to no pod for a job placed nowhere (Pause all) that a machine of the user's own can run: Resume decides where", () => {
    const { p, sent } = planner([lane("home", { rented: false }), lane("p1")], { allPaused: true });
    p.sendFiles([row("a")], new Map([["a", able({ p1: ["x.safetensors"] }, ["home"])]]), new Map());
    expect(sent).toEqual([]);
  });

  it("stay ahead on the pod that began the copy, busy since or not: never a second copy elsewhere", () => {
    const { p, sent } = planner([lane("home", { rented: false }), lane("p1", { running: true }), lane("p2")], { allPaused: true, holds: { p1: ["a"] } });
    const rows = [row("a")];
    p.sendFiles(rows, new Map([["a", able({ p1: ["x.safetensors"], p2: ["x.safetensors"] })]]), new Map());
    expect(sent).toEqual([{ lane: "p1", tier: "ahead", job: "a", files: ["x.safetensors"] }]);
  });

  it("stay on the pod a job is pinned to, busy as it is, while everything is paused", () => {
    const { p, sent, kept } = planner([lane("p1", { running: true }), lane("p2")], { allPaused: true });
    const rows = [row("a", "p1")];
    const s = p.sendFiles(rows, new Map([["a", able({ p1: ["x.safetensors"] })]]), new Map());
    p.dropUnsought(rows, s);
    expect(sent).toEqual([{ lane: "p1", tier: "ahead", job: "a", files: ["x.safetensors"] }]);
    expect(kept(["a"])).toEqual({ p1: ["a"], p2: [] });
  });

  it("go nowhere else for a job planned on a pod that has its files already", () => {
    const { p, sent } = planner([lane("p1"), lane("p2")]);
    const rows = [row("a")];
    p.sendFiles(rows, new Map([["a", able({ p2: ["x.safetensors"] })]]), new Map([["a", { lane: "p1" }]]));
    expect(sent).toEqual([]);
  });
});

describe("what a pod was sent, dropped once its job may no longer run there", () => {
  it("goes for a job done or cancelled, or pinned to another machine: at every pass, with nothing waiting too", () => {
    const { p, kept } = planner([lane("home", { rented: false }), lane("p1"), lane("p2")]);
    // the last waiting job cancelled: no rows looked at, the drop still runs; b pinned to p2, c to p1, "gone" left the queue
    p.dropUnsought([row("a"), row("b", "p2"), row("c", "p1")], new Map());
    expect(kept(["a", "b", "c", "gone"])).toEqual({ p1: ["a", "c"], p2: ["a", "b"] });
  });

  it("goes from the pod a job was planned on before, once the plan has it on another (a job's files on two pods at once)", () => {
    const { p, kept } = planner([lane("p1"), lane("p2")]);
    const rows = [row("a")];
    const sent = p.sendFiles(rows, new Map([["a", able({ p1: ["x.safetensors"], p2: ["x.safetensors"] })]]), new Map([["a", { lane: "p2" }]]));
    p.dropUnsought(rows, sent);
    expect(kept(["a"])).toEqual({ p1: [], p2: ["a"] });
  });

  it("stays on a pod not judged this pass (its ComfyUI restarting for a node pack): nothing goes ahead to another pod meanwhile", () => {
    const { p, sent, kept } = planner([lane("home", { rented: false }), lane("p1"), lane("p2")], { holds: { p1: ["a"] } });
    const rows = [row("a")];
    // p1 restarts: no fetch entry for it this pass, and p2 idle could take the job's files
    const s = p.sendFiles(rows, new Map([["a", { ...able({ p2: ["x.safetensors"] }), unjudged: new Set(["p1"]) }]]), new Map([["a", { lane: "home" }]]));
    p.dropUnsought(rows, s);
    expect(sent).toEqual([]);
    expect(kept(["a"])).toEqual({ p1: ["a"], p2: [] });
  });

  it("stays on the pod a job is pinned to, whatever this pass made of that pod", () => {
    const { p, kept } = planner([lane("p1"), lane("p2")]);
    const rows = [row("a", "p1")];
    // p1 not answering this pass: the job is in no pod's fetch, and the pass sent its files nowhere
    p.dropUnsought(rows, new Map([["a", new Set<string>()]]));
    expect(kept(["a"])).toEqual({ p1: ["a"], p2: [] });
  });

  it("stays for a job the plan did not look at this pass (running, or waiting for another job)", () => {
    const { p, kept } = planner([lane("p1")]);
    p.dropUnsought([row("a")], new Map([["other", new Set(["p1"])]]));
    expect(kept(["a"])).toEqual({ p1: ["a"] });
  });
});
