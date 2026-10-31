import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { complete, FAST, get, job, makeApp, makeFake, post, referenceCatalog, until, type TestApp } from "./helpers";

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

  it("have a machine that joins after Pause all join paused, and Resume all start it; not after each was paused alone", async () => {
    const [three, four, five] = await Promise.all([makeFake(), makeFake(), makeFake()]);
    const urls: Record<string, string> = { m3: three.url, m4: four.url, m5: five.url };
    const paused = async () => Object.fromEntries((await queue()).machines.map((m: { id: string; paused: boolean }) => [m.id, m.paused]));
    const machines = (more: string[]) => [{ id: "m1", url: one.url }, { id: "m2", url: two.url }, ...more.map((id) => ({ id, url: urls[id]! }))];
    try {
      await post(t.app, "/api/queue/pause", {});
      const a = await enqueue({ prompt: "a cat" });
      await t.app.inject({ method: "PUT", url: "/api/settings", payload: { machines: machines(["m3"]) } });
      expect(await paused()).toEqual({ m1: true, m2: true, m3: true });
      await new Promise((r) => setTimeout(r, 100));
      expect([...sentTo(one), ...sentTo(two), ...sentTo(three)]).toHaveLength(0);
      // Resume all: the newcomer too
      await post(t.app, "/api/queue/resume", {});
      expect(await paused()).toEqual({ m1: false, m2: false, m3: false });
      await until(() => sentTo(one).length + sentTo(two).length + sentTo(three).length === 1);
      for (const fake of [one, two, three]) for (const p of sentTo(fake)) complete(fake, p);
      await until(async () => (await row(a)).status === "done");
      // each paused on its own (the GPU hunt's rest does so): a machine that joins is not held by it
      await post(t.app, "/api/queue/pause", { machine: "m1" });
      await post(t.app, "/api/queue/pause", { machine: "m2" });
      await post(t.app, "/api/queue/pause", { machine: "m3" });
      await t.app.inject({ method: "PUT", url: "/api/settings", payload: { machines: machines(["m3", "m4"]) } });
      expect((await paused()).m4).toBe(false);
      // Pause all, then one machine resumed alone: Pause all no longer holds
      await post(t.app, "/api/queue/pause", {});
      await post(t.app, "/api/queue/resume", { machine: "m1" });
      await t.app.inject({ method: "PUT", url: "/api/settings", payload: { machines: machines(["m3", "m4", "m5"]) } });
      expect((await paused()).m5).toBe(false);
    } finally {
      await Promise.all([three, four, five].map((f) => f.close().catch(() => {})));
    }
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
    // the test's fast waits: the default one reads the history every 5 s, past a 5 s test limit
    const again = new Queue(t.db, t.services.storage, () => t.services.machines(), t.services.registry, FAST);
    await again.start();
    complete(two, sentTo(two)[0]!);
    await until(async () => (await row(a)).status === "done");
    // followed, not sent again: that ComfyUI still had the one prompt, the other none
    expect(sentTo(two)).toHaveLength(1);
    expect(sentTo(one)).toHaveLength(0);
    again.stop();
    await again.idle();
  });

  it("is queued again once its machine stays away, holding the cut asked after it but not an update", async () => {
    await post(t.app, "/api/queue/use-only", { machine: "m2" });
    const a = await enqueue({});
    await until(() => sentTo(two).length === 1);
    await until(async () => Boolean((await row(a)).resume));
    t.services.queue.stop();
    await t.services.queue.idle();
    await post(t.app, "/api/queue/resume", {});
    two.down = true;
    const { Queue } = await import("../src/queue");
    const again = new Queue(t.db, t.services.storage, () => t.services.machines(), t.services.registry, { ...FAST, offlineExpiryMs: 60_000 });
    try {
      await again.start();
      const cut = await again.enqueueCut({ asset: "nope", startMs: 0, endMs: 1000, action: "copy" }, "zz-test cut");
      // lost after the wait a render gets, it waits for its machine, which may still render it: the cut asked after it
      // waits too (an export after a render is made with it), but an update does not wait for a machine that is away
      await until(async () => (await row(a)).status === "queued");
      await new Promise((r) => setTimeout(r, 300));
      expect((await row(cut)).status).toBe("queued");
      expect(sentTo(one)).toHaveLength(0);
      expect([...(await again.takeable([a]))]).toEqual([]);
      // back, its machine is asked for the prompt it had, and that one is followed: never rendered twice
      two.down = false;
      again.nudge();
      await until(async () => (await row(a)).status === "running");
      complete(two, sentTo(two)[0]!);
      await until(async () => (await row(a)).status === "done");
      await until(async () => (await row(cut)).status === "failed");
      expect(sentTo(two)).toHaveLength(1);
      expect(sentTo(one)).toHaveLength(0);
    } finally {
      again.stop();
      await again.idle();
    }
  });

  it("cleared from the waiting list while its machine is away, is dropped from that ComfyUI once it answers", async () => {
    await post(t.app, "/api/queue/use-only", { machine: "m2" });
    const a = await enqueue({});
    await until(() => sentTo(two).length === 1);
    await until(async () => Boolean((await row(a)).resume));
    t.services.queue.stop();
    await t.services.queue.idle();
    await post(t.app, "/api/queue/resume", {});
    two.down = true;
    const { Queue } = await import("../src/queue");
    const again = new Queue(t.db, t.services.storage, () => t.services.machines(), t.services.registry, { ...FAST, offlineExpiryMs: 60_000 });
    try {
      await again.start();
      await until(async () => (await row(a)).status === "queued");
      expect(await again.cancelWaiting()).toBe(1);
      const drops = () => two.calls.filter((c) => c === "POST /queue").length;
      await new Promise((r) => setTimeout(r, 100));
      const before = drops();
      // back: the prompt it may still have is dropped there, not rendered on unseen
      two.down = false;
      again.noteReachable(true, new Map([["m2", true]]));
      await until(() => drops() > before);
    } finally {
      again.stop();
      await again.idle();
    }
  });
});

describe("a render whose machine stops answering under it", () => {
  /** A queue of its own over the same database and ComfyUIs, with the offline limit `expiryMs`. */
  const queueOf = async (expiryMs: number) => {
    t.services.queue.stop();
    await t.services.queue.idle();
    const { Queue } = await import("../src/queue");
    const q = new Queue(t.db, t.services.storage, () => t.services.machines(), t.services.registry, { ...FAST, offlineExpiryMs: expiryMs });
    await q.start();
    return q;
  };

  it("waits for that machine, which may still render it, instead of rendering it again elsewhere", async () => {
    const q = await queueOf(60_000);
    try {
      await q.setPaused(true, "m2");
      const a = await q.enqueue("sdxl.text-to-picture", job({ prompt: "a cat" }).input);
      await until(() => sentTo(one).length === 1);
      await until(async () => Boolean((await row(a)).resume));
      await q.setPaused(false, "m2");
      one.down = true;
      await until(async () => (await row(a)).status === "queued");
      await new Promise((r) => setTimeout(r, 400));
      expect(sentTo(two)).toHaveLength(0);
      one.down = false;
      q.nudge();
      await until(async () => (await row(a)).status === "running");
      complete(one, sentTo(one)[0]!);
      await until(async () => (await row(a)).status === "done");
      expect(sentTo(one)).toHaveLength(1);
      expect(sentTo(two)).toHaveLength(0);
    } finally {
      q.stop();
      await q.idle();
    }
  });

  it("goes elsewhere once that machine is away past the offline limit, and is dropped there when it answers again", async () => {
    await post(t.app, "/api/queue/pause", { machine: "m2" });
    const a = await enqueue({ prompt: "a cat" });
    await until(() => sentTo(one).length === 1);
    await until(async () => Boolean((await row(a)).resume));
    await post(t.app, "/api/queue/resume", { machine: "m2" });
    one.down = true;
    await until(() => sentTo(two).length === 1);
    one.down = false;
    const before = one.calls.length;
    t.services.queue.noteReachable(true, new Map([["m1", true]]));
    await until(() => one.calls.slice(before).includes("POST /queue"));
    complete(two, sentTo(two)[0]!);
    await until(async () => (await row(a)).status === "done");
    expect((await row(a)).machine_id).toBe("m2");
  });
});

describe("a render given up while its machine is away", () => {
  /** A queue of its own over the same database and ComfyUIs, with these options over the fast ones. */
  const queueOf = async (over: Partial<typeof FAST> = {}) => {
    t.services.queue.stop();
    await t.services.queue.idle();
    const { Queue } = await import("../src/queue");
    const q = new Queue(t.db, t.services.storage, () => t.services.machines(), t.services.registry, { ...FAST, ...over });
    await q.start();
    return q;
  };
  /** Whether a ComfyUI was asked to drop a prompt (ComfyClient.interrupt) after its first `from` calls. */
  const dropped = (fake: FakeComfy, from: number) => fake.calls.slice(from).includes("POST /queue");

  it("has its prompt dropped there once it answers, when its attempts are spent under it", async () => {
    const q = await queueOf({ maxAttempts: 1 });
    try {
      await q.setPaused(true, "m2");
      const a = await q.enqueue("sdxl.text-to-picture", job({ prompt: "a cat" }).input);
      await until(async () => Boolean((await row(a)).resume) && sentTo(one).length === 1);
      one.down = true;
      await until(async () => (await row(a)).status === "failed");
      const before = one.calls.length;
      // back: the render it would still run, billed on a pod, is dropped there
      one.down = false;
      q.noteReachable(true, new Map([["m1", true]]));
      await until(() => dropped(one, before));
    } finally {
      q.stop();
      await q.idle();
    }
  });

  it("has its prompt dropped there once it answers, when it was found running at a start and its machine stayed away", async () => {
    await post(t.app, "/api/queue/use-only", { machine: "m2" });
    const a = await enqueue({});
    await until(() => sentTo(two).length === 1);
    await until(async () => Boolean((await row(a)).resume));
    two.down = true;
    const q = await queueOf({ maxAttempts: 1 });
    try {
      await until(async () => (await row(a)).status === "failed");
      const before = two.calls.length;
      two.down = false;
      q.noteReachable(true, new Map([["m2", true]]));
      await until(() => dropped(two, before));
    } finally {
      q.stop();
      await q.idle();
    }
  });

  it("has its prompt dropped there once it answers, when every machine stayed away past the offline limit", async () => {
    const q = await queueOf();
    try {
      await q.setPaused(true, "m2");
      const a = await q.enqueue("sdxl.text-to-picture", job({ prompt: "a cat" }).input);
      await until(async () => Boolean((await row(a)).resume) && sentTo(one).length === 1);
      await q.setPaused(false, "m2");
      two.down = true;
      one.down = true;
      await until(async () => (await row(a)).status === "failed");
      expect((await row(a)).error).toMatch(/stayed offline/);
      const before = one.calls.length;
      one.down = false;
      q.noteReachable(true, new Map([["m1", true]]));
      await until(() => dropped(one, before));
    } finally {
      q.stop();
      await q.idle();
    }
  });
});

describe("the offline limit", () => {
  it("does not give up the jobs while a paused machine answers, nor a job pinned to a paused machine", async () => {
    t.services.queue.stop();
    await t.services.queue.idle();
    const { Queue } = await import("../src/queue");
    const q = new Queue(t.db, t.services.storage, () => t.services.machines(), t.services.registry, FAST);
    await q.start();
    try {
      // the PC paused by hand (or by a GPU hunt) answers; the other machine is switched off for the night
      await q.setPaused(true, "m1");
      two.down = true;
      const pinned = await q.enqueue("sdxl.text-to-picture", job({ prompt: "a cat" }).input, { machine: "m1" });
      const any = await q.enqueue("sdxl.text-to-picture", job({ prompt: "a dog" }).input);
      await new Promise((r) => setTimeout(r, 600));
      expect([(await row(pinned)).status, (await row(any)).status]).toEqual(["queued", "queued"]);
      // the paused PC away too: what waits for any ComfyUI is given up in the end, what waits for that PC's Resume is not
      one.down = true;
      await until(async () => (await row(any)).status === "failed");
      expect((await row(pinned)).status).toBe("queued");
    } finally {
      q.stop();
      await q.idle();
    }
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
    await t.db.insertInto("render_stats").values([stat("a", "m1", 500), stat("b", "m1", 500), stat("b2", "m1", 500), stat("c", "m2", 1500), stat("d", "m2", 1500), stat("d2", "m2", 1500), stat("e", "m2", 900, "steps=30"), stat("f", "m1", 400, "steps=40")]).execute();
    // one render of the second settings on m1 says nothing of its pace (a cold load, the card busy elsewhere)
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

  it("says when the waiting list is done as the plan shares it between the machines, not the sum of its renders", async () => {
    const at = new Date().toISOString();
    const stat = (id: string, machine: string) => ({
      id, owner_id: "local", recipe_id: "sdxl.text-to-picture", family: "sdxl", model: "m", model_file: "m.safetensors", time_key: "steps=20", kind: "image" as const,
      width: 832, height: 1216, duration_ms: null, steps: 20, status: "done" as const, whole: 1, cold: 0, waited_ms: 0, total_ms: 10_000, load_ms: 0, sample_ms: 10_000,
      refine_ms: 0, finish_ms: 0, step_ms: 500, expected_ms: null, work: 832 * 1216, vram_peak: null, heat_peak: null, asset_id: null, machine_id: machine, gpu: null, created_at: at,
    });
    await t.db.insertInto("render_stats").values(["a", "b", "c"].flatMap((x) => [stat(`${x}1`, "m1"), stat(`${x}2`, "m2")])).execute();
    expect((await queue()).waitingEndsInMs).toBeNull();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await enqueue({}));
    await until(() => sentTo(one).length === 1 && sentTo(two).length === 1);
    const q = await queue();
    const waiting = q.waiting as Array<{ estimateMs: number | null; startsInMs: number | null }>;
    expect(waiting).toHaveLength(4);
    const sum = waiting.reduce((n, w) => n + w.estimateMs!, 0);
    // four 10 s renders behind two running ones, two machines: about 30 s, where their sum says 40
    expect(q.waitingEndsInMs).toBeGreaterThanOrEqual(Math.max(...waiting.map((w) => w.startsInMs!)));
    expect(q.waitingEndsInMs).toBeLessThan(sum * 0.8);
    await finishAll(ids);
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

  it("goes again to another machine when its own is taken out under it (a pod terminated), whatever its address answers", async () => {
    await post(t.app, "/api/queue/pause", { machine: "m1" });
    const a = await enqueue({ prompt: "a dog" });
    await until(() => sentTo(two).length === 1);
    await until(async () => Boolean((await row(a)).resume));
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { machines: [{ id: "m1", name: "Studio PC", url: one.url }] } });
    await post(t.app, "/api/queue/resume", { machine: "m1" });
    // what RunPod's proxy answers for a pod that is no longer there
    const real = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => (String(input).startsWith(two.url) ? Promise.resolve(new Response("Not Found", { status: 404 })) : real(input, init))) as typeof fetch;
    try {
      await until(() => sentTo(one).length === 1);
    } finally {
      globalThis.fetch = real;
    }
    await finishAll([a]);
    expect((await row(a)).machine_id).toBe("m1");
  });

  it("goes to any machine once its own is taken out, instead of waiting for it for ever", async () => {
    await post(t.app, "/api/queue/pause", { machine: "m2" });
    const a = (await post(t.app, "/api/jobs", { ...job({ prompt: "a dog" }), machine: "m2" })).json().ids[0] as string;
    await new Promise((r) => setTimeout(r, 200));
    expect((await row(a)).status).toBe("queued");
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { machines: [{ id: "m1", name: "Studio PC", url: one.url }] } });
    t.services.queue.nudge();
    await until(() => sentTo(one).length === 1);
    expect((await row(a)).pin_machine).toBeNull();
    await finishAll([a]);
    expect((await row(a)).machine_id).toBe("m1");
  });

  it("done again after its machine was taken out, goes to any machine; a model load asked of a machine there is not is refused", async () => {
    await post(t.app, "/api/queue/pause", { machine: "m2" });
    const a = (await post(t.app, "/api/jobs", { ...job({ prompt: "a dog" }), machine: "m2" })).json().ids[0] as string;
    expect(await t.services.queue.cancel(a)).toBe(true);
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { machines: [{ id: "m1", name: "Studio PC", url: one.url }] } });
    t.services.queue.nudge();
    await until(async () => (await queue()).machines.length === 1);
    // the machines did not change since: nothing else would free its pin, and it would wait for ever
    const b = await t.services.queue.again(a);
    expect((await row(b)).pin_machine).toBeNull();
    await until(() => sentTo(one).length === 1);
    await finishAll([b]);
    expect((await post(t.app, "/api/jobs/warm", { ...job({}), machine: "m9" })).statusCode).toBe(400);
  });
});

describe("a timeline's clips of a model that joins in a kept latent", () => {
  /** The nodes an H3 join in the latent takes (h3.video's latentNodes): the Afflatus node pack's. */
  const packNodes = ["AfflatusLoadH3Latent", "MiniMaxH3GuidedContinuationWindow", "MiniMaxH3LatentTailGuide", "AfflatusH3SeamLatent"];
  /** A ComfyUI with MiniMax H3's files, with or without the pack. */
  const h3Fake = (pack: boolean) =>
    startFakeComfy({
      catalog: Object.fromEntries(Object.entries(referenceCatalog()).filter(([type]) => pack || !packNodes.includes(type))),
      models: { checkpoints: [], diffusion_models: ["minimax_h3_fl2va_demo.safetensors"], text_encoders: ["qwen3vl_32b_minimax_h3_demo.safetensors"], vae: ["minimax_h3_video_vae_demo.safetensors", "minimax_h3_audio_vae_demo.safetensors"] },
    });

  it("go to a machine with the Afflatus node pack while one has it; a clip made in Create goes anywhere", async () => {
    const [h1, h2] = await Promise.all([h3Fake(true), h3Fake(false)]);
    try {
      await t.app.inject({ method: "PUT", url: "/api/settings", payload: { machines: [{ id: "m1", name: "Studio PC", url: h1.url }, { id: "m2", name: "Second GPU", url: h2.url }] } });
      for (const m of ["m1", "m2"]) await post(t.app, `/api/setup/rescan?machine=${m}`, {});
      // paused: the jobs stay waiting, and the status says where each would run
      await post(t.app, "/api/queue/pause", {});
      const tl = (await post(t.app, "/api/timelines", { name: "zz-test Chain" })).json();
      const first = (await post(t.app, `/api/timelines/${tl.id}/clips`, { recipe: "h3.video" })).json().clip as string;
      const second = (await post(t.app, `/api/timelines/${tl.id}/clips`, { recipe: "h3.video" })).json().clip as string;
      const ids = (await post(t.app, `/api/timelines/${tl.id}/render`, { clips: [{ id: first, input: { description: "She walks." } }, { id: second, input: { description: "She turns." } }] })).json().ids as string[];
      const alone = (await post(t.app, "/api/jobs", { recipe: "h3.video", input: { description: "A boat." } })).json().ids[0] as string;
      const waiting = (await queue()).waiting as Array<{ id: string; runsOn: string[] | null; lacks: Record<string, { why?: string }> | null }>;
      for (const id of ids) expect(waiting.find((w) => w.id === id)).toMatchObject({ runsOn: ["m1"], lacks: { m2: { why: expect.stringContaining("node pack") } } });
      expect(waiting.find((w) => w.id === alone)?.runsOn).toBeNull();
    } finally {
      await Promise.all([h1.close().catch(() => {}), h2.close().catch(() => {})]);
    }
  });
});
