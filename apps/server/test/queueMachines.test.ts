import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeComfy } from "@afflatus/comfy/testing";
import { complete, get, job, makeApp, makeFake, post, until, type TestApp } from "./helpers";

/** Several ComfyUIs (settings.ts `machines`): one line of jobs, each machine running one at a time, in parallel. */

let one: FakeComfy;
let two: FakeComfy;
let t: TestApp;
beforeEach(async () => {
  [one, two] = await Promise.all([makeFake(), makeFake()]);
  t = await makeApp({ comfyUrl: one.url });
  await t.app.inject({ method: "PUT", url: "/api/settings", payload: { machines: [{ id: "m1", name: "Studio PC", url: one.url }, { id: "m2", name: "Second GPU", url: two.url }] } });
  await t.services.queue.start();
});
afterEach(async () => {
  await t.close();
  await Promise.all([one.close().catch(() => {}), two.close().catch(() => {})]);
});

const queue = async () => (await get(t.app, "/api/queue")).json();
const row = (id: string) => t.db.selectFrom("jobs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const enqueue = async (over: Record<string, unknown> = {}) => (await post(t.app, "/api/jobs", job(over))).json().ids[0] as string;
const sentTo = (fake: FakeComfy) => [...fake.prompts.keys()];
/** Every prompt either ComfyUI gets is finished, as it comes, until these jobs are done. */
const finishAll = (ids: string[]) =>
  until(async () => {
    for (const fake of [one, two]) for (const p of sentTo(fake)) if (!fake.history[p]) complete(fake, p);
    return (await Promise.all(ids.map(row))).every((r) => r.status === "done");
  });

describe("several ComfyUIs", () => {
  it("run one job each at the same time, and say which machine ran it", async () => {
    const a = await enqueue({ prompt: "a cat" });
    const b = await enqueue({ prompt: "a dog" });
    await until(() => sentTo(one).length === 1 && sentTo(two).length === 1);
    const q = await queue();
    expect(q.machines.map((m: { id: string; running: { id: string } | null }) => [m.id, m.running?.id])).toEqual([["m1", a], ["m2", b]]);
    // the screens that show one running job still get one
    expect(q.running.id).toBe(a);
    await finishAll([a, b]);
    expect((await row(a)).machine_id).toBe("m1");
    expect((await row(b)).machine_id).toBe("m2");
    // each machine's render on record under its own name
    const stats = await t.db.selectFrom("render_stats").select(["id", "machine_id"]).execute();
    expect(Object.fromEntries(stats.map((s) => [s.id, s.machine_id]))).toEqual({ [a]: "m1", [b]: "m2" });
  });

  it("give a machine only what it takes, and a pinned job only to its machine", async () => {
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { machines: [{ id: "m1", url: one.url, takes: "video" }, { id: "m2", url: two.url }] } });
    const a = await enqueue({ prompt: "a cat" });
    await until(() => sentTo(two).length === 1);
    expect(sentTo(one)).toHaveLength(0);
    // pinned to the machine that takes only videos: a pin is the user's word, it runs there
    const b = await enqueue({ prompt: "a dog" });
    expect((await post(t.app, `/api/jobs/${b}/machine`, { machine: "m1" })).statusCode).toBe(200);
    await until(() => sentTo(one).length === 1);
    await finishAll([a, b]);
    expect((await row(b)).machine_id).toBe("m1");
  });

  it("send everything to one machine when the others are paused, and go on when they resume", async () => {
    await post(t.app, "/api/queue/use-only", { machine: "m2" });
    const ids = [await enqueue({ prompt: "a cat" }), await enqueue({ prompt: "a dog" })];
    await until(() => sentTo(two).length === 1);
    expect(sentTo(one)).toHaveLength(0);
    expect((await queue()).machines.map((m: { paused: boolean }) => m.paused)).toEqual([true, false]);
    await post(t.app, "/api/queue/resume", { machine: "m1" });
    await until(() => sentTo(one).length === 1);
    await finishAll(ids);
  });

  it("pause and resume every machine with Pause all and Resume all, each saying it, one resumable alone", async () => {
    const paused = async () => ((await queue()).machines as Array<{ paused: boolean }>).map((m) => m.paused);
    await post(t.app, "/api/queue/pause", {});
    expect(await paused()).toEqual([true, true]);
    expect((await queue()).paused).toBe(true);
    const a = await enqueue({});
    await post(t.app, "/api/queue/resume", { machine: "m2" });
    await until(() => sentTo(two).length === 1);
    expect(sentTo(one)).toHaveLength(0);
    expect((await queue()).paused).toBe(false);
    await post(t.app, "/api/queue/resume", {});
    expect(await paused()).toEqual([false, false]);
    await finishAll([a]);
  });

  it("go on with the machines that answer when one is away", async () => {
    await one.close();
    const ids = [await enqueue({ prompt: "a cat" }), await enqueue({ prompt: "a dog" })];
    await until(() => sentTo(two).length === 1);
    complete(two, sentTo(two)[0]!);
    await until(() => sentTo(two).length === 2);
    complete(two, sentTo(two)[1]!);
    await until(async () => (await Promise.all(ids.map(row))).every((r) => r.status === "done"));
    expect((await queue()).online).toBe(true);
  });

  it("stop a job on the machine it runs on", async () => {
    await post(t.app, "/api/queue/use-only", { machine: "m2" });
    const a = await enqueue({});
    await until(() => sentTo(two).length === 1);
    await until(async () => (await queue()).machines[1].running?.id === a);
    expect((await post(t.app, `/api/jobs/${a}/cancel`)).statusCode).toBe(200);
    await until(async () => (await row(a)).status === "cancelled");
    // dropped from that machine's ComfyUI queue (it was not running yet there), never from the other's
    expect(two.calls).toContain("POST /queue");
    expect(one.calls).not.toContain("POST /queue");
  });

  it("unload one machine, or every one that is not rendering", async () => {
    const frees = (fake: FakeComfy) => fake.calls.filter((c) => c === "POST /free").length;
    await post(t.app, "/api/queue/use-only", { machine: "m1" });
    const a = await enqueue({});
    await until(() => sentTo(one).length === 1);
    // the machine that renders keeps its model; the idle one is unloaded
    expect((await post(t.app, "/api/comfy/free", { machine: "m1" })).statusCode).toBe(400);
    const before = [frees(one), frees(two)];
    expect((await post(t.app, "/api/comfy/free", {})).statusCode).toBe(200);
    expect([frees(one), frees(two)]).toEqual([before[0], before[1]! + 1]);
    await finishAll([a]);
  });
});

describe("a job a ComfyUI had when Afflatus stopped", () => {
  it("is followed again on the machine it was sent to", async () => {
    await post(t.app, "/api/queue/use-only", { machine: "m2" });
    const a = await enqueue({});
    await until(() => sentTo(two).length === 1);
    await until(async () => Boolean((await row(a)).resume));
    // a new process over the same database and the same two ComfyUIs
    t.services.queue.stop();
    await t.services.queue.idle();
    const { Queue } = await import("../src/queue");
    const again = new Queue(t.db, t.services.storage, () => t.services.machines(), t.services.registry);
    await again.start();
    complete(two, sentTo(two)[0]!);
    await until(async () => (await row(a)).status === "done");
    expect(sentTo(one)).toHaveLength(0);
    again.stop();
    await again.idle();
  });
});

describe("each machine's pace", () => {
  it("is learned from renders of the same model and settings on several machines, and says where a waiting job will run", async () => {
    const { machinePaces } = await import("../src/forecast");
    const at = new Date().toISOString();
    const stat = (id: string, machine: string, stepMs: number, timeKey = "steps=20") => ({
      id, owner_id: "local", recipe_id: "sdxl.text-to-picture", family: "sdxl", model: "m", model_file: "m.safetensors", time_key: timeKey, kind: "image" as const,
      width: 832, height: 1216, duration_ms: null, steps: 20, status: "done" as const, whole: 1, cold: 0, waited_ms: 0, total_ms: stepMs * 20, load_ms: 0, sample_ms: stepMs * 20,
      refine_ms: 0, finish_ms: 0, step_ms: stepMs, expected_ms: null, work: 832 * 1216, vram_peak: null, heat_peak: null, asset_id: null, machine_id: machine, gpu: null, created_at: at,
    });
    // the second machine takes three times as long per step; a model rendered on one machine only says nothing
    await t.db.insertInto("render_stats").values([stat("a", "m1", 500), stat("b", "m1", 500), stat("c", "m2", 1500), stat("d", "m2", 1500), stat("e", "m2", 900, "steps=30")]).execute();
    const paces = await machinePaces(t.db);
    expect(paces.get("m2")! / paces.get("m1")!).toBeCloseTo(3, 1);

    // a waiting job says the machine it will probably run on
    await post(t.app, "/api/queue/use-only", { machine: "m1" });
    const a = await enqueue({});
    const b = await enqueue({});
    await until(() => sentTo(one).length === 1);
    const waiting = (await queue()).waiting as Array<{ id: string; machine: string | null; startsInMs: number | null }>;
    expect(waiting.find((w) => w.id === b)).toMatchObject({ machine: "m1" });
    await finishAll([a, b]);
  });
});

describe("each machine's files", () => {
  /** The second machine lists the other checkpoint only, and is looked at again now. */
  const twoLacksIt = async () => {
    two.models.checkpoints = ["other.safetensors"];
    await post(t.app, "/api/setup/rescan?machine=m2", {});
  };

  it("send a job only to a machine that has its model file, and say so on the waiting job", async () => {
    await twoLacksIt();
    const a = await enqueue({});
    const b = await enqueue({});
    await until(() => sentTo(one).length === 1);
    const waiting = (await queue()).waiting as Array<{ id: string; runsOn: string[] | null; lacks: unknown }>;
    expect(waiting.find((w) => w.id === b)).toMatchObject({ runsOn: ["m1"], lacks: { m2: { off: false, files: [{ file: "illustrious.safetensors", folder: "checkpoints" }] } } });
    await finishAll([a, b]);
    expect(sentTo(two)).toHaveLength(0);
  });

  it("keep a job pinned to a machine without its file waiting, and start it there once the file comes", async () => {
    await twoLacksIt();
    await post(t.app, "/api/queue/pause", {});
    const a = await enqueue({});
    expect((await post(t.app, `/api/jobs/${a}/machine`, { machine: "m2" })).statusCode).toBe(200);
    await post(t.app, "/api/queue/resume", {});
    await new Promise((r) => setTimeout(r, 100));
    expect([...sentTo(one), ...sentTo(two)]).toHaveLength(0);
    expect(((await queue()).waiting as Array<{ id: string; runsOn: string[] | null }>)[0]?.runsOn).toEqual(["m1"]);
    // the file arrives (a download, or put in by hand and looked for again): the job goes
    two.models.checkpoints = ["other.safetensors", "illustrious.safetensors"];
    await post(t.app, "/api/setup/rescan?machine=m2", {});
    await until(() => sentTo(two).length === 1);
    await finishAll([a]);
    expect((await row(a)).machine_id).toBe("m2");
  });

  it("give a machine nothing of a family switched off there", async () => {
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { machines: [{ id: "m1", url: one.url }, { id: "m2", url: two.url, families: { sdxl: false } }] } });
    const a = await enqueue({});
    const b = await enqueue({});
    await until(() => sentTo(one).length === 1);
    await finishAll([a, b]);
    expect(sentTo(two)).toHaveLength(0);
    expect((await row(b)).machine_id).toBe("m1");
  });
});

describe("each machine's answer", () => {
  it("is what the status poll heard, paused or not, and says so the moment it changes", async () => {
    await post(t.app, "/api/queue/pause", { machine: "m2" });
    const online = async () => Object.fromEntries(((await queue()).machines as Array<{ id: string; online: boolean | null }>).map((m) => [m.id, m.online]));
    // a paused machine is asked nothing by the queue: before, its ComfyUI could stop and it still read as online
    t.services.queue.noteReachable(true, new Map([["m1", true], ["m2", false]]));
    expect(await online()).toEqual({ m1: true, m2: false });
    t.services.queue.noteReachable(true, new Map([["m2", true]]));
    expect((await online()).m2).toBe(true);
  });
});

describe("a job sent to a machine", () => {
  it("runs there, the machine that would end it first or not; one there is not is refused", async () => {
    // the first machine is busy: left to the queue the job would go to the second, sent to the first it waits for it
    const a = await enqueue({ prompt: "a cat" });
    await until(() => sentTo(one).length === 1);
    const b = (await post(t.app, "/api/jobs", { ...job({ prompt: "a dog" }), machine: "m1" })).json().ids[0] as string;
    expect((await row(b)).pin_machine).toBe("m1");
    expect((await post(t.app, "/api/jobs", { ...job({}), machine: "m9" })).statusCode).toBe(400);
    await finishAll([a, b]);
    expect((await row(b)).machine_id).toBe("m1");
  });
});
