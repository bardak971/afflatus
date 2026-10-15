import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeRunpod, type FakeComfy, type FakeGpu, type FakeRunpod } from "@afflatus/comfy/testing";
import { readSettings } from "../src/settings";
import { CHECKPOINT, costToday, get, job, makeApp, makeFake, post, until, type TestApp } from "./helpers";

/**
 * Hunt a GPU (hunt.ts) against a pretend RunPod: a GPU made free between two rounds is deployed once, through the Deploy
 * path (its caps, its one pod per volume); a GPU taken before the deploy keeps the hunt going; the home machines it paused
 * go on when it ends, and only those; it gives up at its time, at a cap, or after three refusals; it carries on after a restart.
 */

const KEY = "rpa_test_key_0123456789";
let home: FakeComfy;
let runpod: FakeRunpod;
let t: TestApp;
const spawned: FakeComfy[] = [];

const gpu = (id: string, name: string, price: number, availability: "HIGH" | "NONE" = "NONE", memory = 48): FakeGpu => ({ id, name, memory, price: { secure: price, community: null }, dataCenters: [{ id: "EU-RO-1", availability }] });

beforeEach(async () => {
  home = await makeFake();
  runpod = await startFakeRunpod({
    key: KEY, bootMs: 50, pods: [],
    gpus: [gpu("NVIDIA A40", "A40", 0.44), gpu("NVIDIA GeForce RTX 4090", "RTX 4090", 0.69, "NONE", 24)],
    volumes: [{ id: "vol-ro", name: "afflatus-models", size: 100, dataCenter: "EU-RO-1" }],
    spawn: async () => {
      const c = Object.assign(await makeFake(), { packVersion: "0.13.0" });
      spawned.push(c);
      return c;
    },
  });
  vi.stubEnv("RUNPOD_API_URL", runpod.url);
  vi.stubEnv("RUNPOD_PROXY", "http://127.0.0.1:{id}");
  t = await makeApp({ comfyUrl: home.url });
  t.services.rented.everyMs = 60_000;
  t.services.rented.imageCheck = async () => true;
  t.services.rented.lookAgainMs = 5;
  // the rounds are run by the tests (no timer), each reading RunPod again; a pod's end is still heard as it happens
  t.services.hunt.stop();
  t.services.hunt.freshMs = 0;
  await t.app.inject({ method: "PUT", url: "/api/settings", payload: { runpodKey: KEY } });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // the hunt's own timer stopped and its round under way ended before the app goes: one left running into the close (the
  // timer test's) held the close past its time under a loaded run, and the next test read no ranking
  t.services.hunt.stop();
  await (t.services.hunt as unknown as { ticking: Promise<void> | null }).ticking;
  t.services.rented.stop();
  // the pods' pretend ComfyUIs go first: the app's close waits for the queue to be idle, and a job being sent to a pod
  // (the timer test's pod is up as it ends) waited on a ComfyUI that was only closed after it, past the hook's time
  await Promise.all(spawned.splice(0).map((x) => x.close().catch(() => {})));
  await t.close();
  await Promise.all([home, runpod].map((x) => x.close().catch(() => {})));
});

const DEPLOY = { cloud: "SECURE", template: "afflatus", volume: "", disk: 120, idleMinutes: 10, idleDo: "terminate", watchdogMinutes: 15 };
const start = (change: Record<string, unknown> = {}) => post(t.app, "/api/hunt", { mode: "value", ceiling: 1, hold: "rest", deploy: DEPLOY, ...change });
const creates = () => runpod.calls.filter((c) => c === "POST /v2/pods").length;
const free = (id: string) => (runpod.gpus.find((g) => g.id === id)!.dataCenters[0]!.availability = "HIGH");
const hunt = async () => (await get(t.app, "/api/hunt")).json() as { hunt: { status: string; machine: string | null; pausedByHunt: string[]; asks: number; fails: number; lastError: string | null } | null; ranking: Array<{ name: string; fit: string; stock: string; fits: string }> | null; askedAt: string | null };
const paused = (id = "m1") => t.services.queue.pausedOn(id);
const said = (spy: { mock: { calls: unknown[][] } }, kind: string) => spy.mock.calls.filter((c) => c[0] === kind).map((c) => c[1] as { title: string; body: string });

/** Renders waiting: the first runs on the home machine (the pretend ComfyUI never finishes it), the others wait. */
async function queue(n = 3): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push((await post(t.app, "/api/jobs", job({ prompt: `zz-test ${i}` }))).json().ids[0] as string);
  await until(async () => (await t.db.selectFrom("jobs").select("id").where("status", "=", "running").execute()).length === 1);
  return ids;
}

describe("starting a hunt", () => {
  it("is refused with nothing waiting, a ceiling of nothing, a time out of bounds, or one under way; read back and in the queue's status", async () => {
    expect((await start()).statusCode).toBe(409);
    await queue();
    expect((await start({ ceiling: 0 })).statusCode).toBe(400);
    expect((await start({ giveUpMinutes: 5 })).statusCode).toBe(400);
    expect((await start({ giveUpMinutes: 25 * 60 })).statusCode).toBe(400);
    expect((await start()).statusCode).toBe(200);
    expect((await start()).statusCode).toBe(409);
    await t.services.hunt.tick();
    const h = await hunt();
    expect(h.hunt).toMatchObject({ status: "hunting", machine: null, pausedByHunt: ["m1"] });
    expect(h.hunt!.asks).toBeGreaterThanOrEqual(1);
    expect(h.askedAt).toBeTruthy();
    // nothing learned: by the price, both usable, none free
    expect(h.ranking!.map((g) => [g.name, g.fit, g.stock])).toEqual([["A40", "yes", "none free"], ["RTX 4090", "yes", "none free"]]);
    const status = (await get(t.app, "/api/queue")).json();
    expect(status.hunt).toMatchObject({ status: "hunting", hold: "rest", held: 2, firstPick: { name: "A40", price: 0.44 }, machine: null });
    expect(creates()).toBe(0);
  });

  it("is refused at a spending cap, and on a volume another pod uses", async () => {
    await queue();
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { rentCaps: { day: 1, month: 0 } } });
    await t.db.insertInto("rent_sessions").values(costToday("s1")).execute();
    const capped = await start();
    expect(capped.statusCode).toBe(409);
    expect(capped.json().error).toMatch(/spending cap/);
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { rentCaps: { day: 0, month: 0 } } });
    free("NVIDIA A40");
    expect((await post(t.app, "/api/runpod/deploy", { ...DEPLOY, gpu: "NVIDIA A40", volume: "vol-ro", idleDo: "stop" })).statusCode).toBe(200);
    const busy = await start({ deploy: { ...DEPLOY, volume: "vol-ro", idleDo: "stop" } });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toMatch(/in use by A40/);
    expect((await hunt()).hunt).toBeNull();
    expect(await paused()).toBe(false);
  });
});

describe("the hunt", () => {
  it("deploys the best-ranked GPU once it is free, once, and says so", async () => {
    const say = vi.spyOn(t.services.notify, "say");
    await queue();
    expect((await start()).statusCode).toBe(200);
    await t.services.hunt.tick();
    expect(creates()).toBe(0);
    free("NVIDIA GeForce RTX 4090");
    free("NVIDIA A40");
    await t.services.hunt.tick();
    expect(creates()).toBe(1);
    // the cheaper (nothing learned yet: value goes by the price)
    expect(runpod.pods[0]).toMatchObject({ gpu: "NVIDIA A40", dataCenterId: "EU-RO-1" });
    const h = await hunt();
    expect(h.hunt).toMatchObject({ status: "up" });
    const machine = (await readSettings(t.db)).machines.find((m) => m.rented)!;
    expect(h.hunt!.machine).toBe(machine.id);
    expect(said(say, "gpuFound")).toEqual([expect.objectContaining({ title: "A40 found", body: expect.stringMatching(/^Deployed in EU-RO-1 at \$0\.44\/h, after \d+ s of hunting; 2 renders waiting for it\.$/) })]);
    // never a second pod
    await t.services.hunt.tick();
    await t.services.hunt.tick();
    expect(creates()).toBe(1);
    // the deploy dialog's choices, as the Deploy path keeps them
    expect(machine.rented).toMatchObject({ idleMinutes: 10, deployed: true });
    expect(await paused()).toBe(true);
  });

  it("on its own: asks every round while it hunts, deploys the moment one is free, and only once", async () => {
    // its timer on, rounds 30 ms apart
    Object.assign(t.services.hunt, { stopped: false, everyMs: 30 });
    await queue();
    await start();
    await until(async () => ((await hunt()).hunt?.asks ?? 0) >= 3);
    expect(creates()).toBe(0);
    free("NVIDIA A40");
    await until(async () => (await hunt()).hunt?.status === "up");
    const asks = (await hunt()).hunt!.asks;
    await new Promise((r) => setTimeout(r, 200));
    expect(creates()).toBe(1);
    // up: RunPod's stock is not asked any more
    expect((await hunt()).hunt!.asks).toBe(asks);
  });

  it("goes on when the GPU is taken just before the deploy, and deploys once it is free again", async () => {
    await queue();
    await start();
    free("NVIDIA A40");
    runpod.noCapacity.add("NVIDIA A40");
    await t.services.hunt.tick();
    expect(runpod.pods).toHaveLength(0);
    let h = await hunt();
    expect(h.hunt).toMatchObject({ status: "hunting", fails: 0 });
    expect(h.hunt!.lastError).toMatch(/No A40 free any more/);
    runpod.noCapacity.clear();
    await t.services.hunt.tick();
    h = await hunt();
    expect(h.hunt!.status).toBe("up");
    expect(runpod.pods).toHaveLength(1);
  });

  it("respects the ceiling and the GPUs left out, and a change of them is taken at once", async () => {
    await queue();
    await start({ ceiling: 0.6, leftOut: ["NVIDIA A40"] });
    free("NVIDIA A40");
    free("NVIDIA GeForce RTX 4090");
    // a round whose read of RunPod failed (a loaded run) ranks nothing and is asked again at the next: a few rounds at most
    let h = await hunt();
    for (let i = 0; i < 5 && !h.ranking; i++) {
      await t.services.hunt.tick();
      h = await hunt();
    }
    expect(creates()).toBe(0);
    expect(h.ranking, JSON.stringify(h.hunt)).not.toBeNull();
    expect(h.ranking!.map((g) => [g.name, g.fits])).toEqual([["A40", "left out by you"], ["RTX 4090", "over your $0.60/h"]]);
    expect((await t.app.inject({ method: "PATCH", url: "/api/hunt", payload: { ceiling: 0 } })).statusCode).toBe(400);
    // a change of another field keeps them as they are
    expect((await t.app.inject({ method: "PATCH", url: "/api/hunt", payload: { hold: "keep" } })).statusCode).toBe(200);
    expect((await hunt()).hunt).toMatchObject({ leftOut: ["NVIDIA A40"], ceiling: 0.6, mode: "value", hold: "keep" });
    await t.services.hunt.tick();
    expect(creates()).toBe(0);
    expect((await t.app.inject({ method: "PATCH", url: "/api/hunt", payload: { leftOut: [], ceiling: 0.8, mode: "fast" } })).statusCode).toBe(200);
    // nothing learned: no time, so "fast" orders by the price too
    await t.services.hunt.tick();
    expect(runpod.pods.map((p) => p.gpu)).toEqual(["NVIDIA A40"]);
  });

  it("gives up at its time: told why, the home machine resumed", async () => {
    const say = vi.spyOn(t.services.notify, "say");
    await queue();
    await start({ giveUpMinutes: 10 });
    await t.services.hunt.tick();
    expect(await paused()).toBe(true);
    // a time already past is refused
    expect((await t.app.inject({ method: "PATCH", url: "/api/hunt", payload: { giveUpMinutes: 10 } })).statusCode).toBe(200);
    const at = Date.now() + 11 * 60_000;
    t.services.hunt.now = () => at;
    expect((await t.app.inject({ method: "PATCH", url: "/api/hunt", payload: { giveUpMinutes: 10 } })).statusCode).toBe(400);
    free("NVIDIA A40");
    await t.services.hunt.tick();
    expect((await hunt()).hunt).toBeNull();
    expect(creates()).toBe(0);
    expect(await paused()).toBe(false);
    expect(said(say, "huntGaveUp")).toEqual([{ title: "The GPU hunt gave up", body: "No GPU you would take came free in 11 min. 1 home machine resumed.", key: expect.any(String) }]);
  });

  it("ends when nothing waits for it any more", async () => {
    const say = vi.spyOn(t.services.notify, "say");
    await queue();
    await start();
    await post(t.app, "/api/queue/cancel-waiting", {});
    free("NVIDIA A40");
    await t.services.hunt.tick();
    expect((await hunt()).hunt).toBeNull();
    expect(creates()).toBe(0);
    expect(await paused()).toBe(false);
    expect(said(say, "huntGaveUp")[0]?.body).toMatch(/^Nothing waits for a GPU any more\./);
  });

  it("at a spending cap: the deploy path refuses, nothing is made, and the hunt ends", async () => {
    const say = vi.spyOn(t.services.notify, "say");
    await queue();
    await start();
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { rentCaps: { day: 1, month: 0 } } });
    await t.db.insertInto("rent_sessions").values(costToday("s1")).execute();
    free("NVIDIA A40");
    await t.services.hunt.tick();
    expect(creates()).toBe(0);
    expect((await hunt()).hunt).toBeNull();
    expect(await paused()).toBe(false);
    expect(said(say, "huntGaveUp")[0]?.body).toMatch(/^A spending cap is reached/);
  });

  it("RunPod's balance too low ends it at once; any other refusal ends it at the third in a row", async () => {
    await queue();
    await start();
    free("NVIDIA A40");
    runpod.failCreate = 402;
    await t.services.hunt.tick();
    expect((await hunt()).hunt).toBeNull();
    runpod.failCreate = 403;
    await start();
    await t.services.hunt.tick();
    await t.services.hunt.tick();
    expect((await hunt()).hunt).toMatchObject({ status: "hunting", fails: 2 });
    await t.services.hunt.tick();
    expect((await hunt()).hunt).toBeNull();
    expect(runpod.pods).toHaveLength(0);
    expect(await paused()).toBe(false);
  });

  it("never makes a second pod on a volume in use: it keeps hunting", async () => {
    await queue();
    await start({ deploy: { ...DEPLOY, volume: "vol-ro", idleDo: "stop" } });
    // the user deploys on that volume meanwhile
    free("NVIDIA GeForce RTX 4090");
    expect((await post(t.app, "/api/runpod/deploy", { ...DEPLOY, gpu: "NVIDIA GeForce RTX 4090", volume: "vol-ro", idleDo: "stop" })).statusCode).toBe(200);
    free("NVIDIA A40");
    await t.services.hunt.tick();
    expect(creates()).toBe(1);
    const h = await hunt();
    expect(h.hunt).toMatchObject({ status: "hunting", fails: 0 });
    expect(h.hunt!.lastError).toMatch(/in use by RTX 4090/);
  });

  it("carries on after a restart, its paused machine kept as its own", async () => {
    await queue();
    await start();
    await t.services.hunt.tick();
    t.services.hunt.stop();
    const again = await makeApp({ db: t.db, comfyUrl: home.url });
    try {
      again.services.rented.everyMs = 60_000;
      again.services.rented.imageCheck = async () => true;
      again.services.hunt.stop();
      again.services.hunt.freshMs = 0;
      expect(again.services.hunt.view().hunt).toMatchObject({ status: "hunting", pausedByHunt: ["m1"] });
      // the round its start began, ended first
      await again.services.hunt.tick();
      free("NVIDIA A40");
      await again.services.hunt.tick();
      expect(again.services.hunt.view().hunt?.status).toBe("up");
      expect(creates()).toBe(1);
    } finally {
      again.services.hunt.stop();
      again.services.rented.stop();
      again.services.notify.stop();
      again.services.queue.stop();
    }
  });

  it("stopped mid-deploy with no pod kept: ends, deploys nothing more, resumes what it paused", async () => {
    await queue();
    await start();
    await t.services.hunt.tick();
    t.services.hunt.stop();
    // as if Afflatus stopped between RunPod making the pod and the machine being kept: the pod may exist, unseen
    const row = await t.db.selectFrom("settings").select("value").where("key", "=", "hunt").executeTakeFirstOrThrow();
    const st = { ...JSON.parse(row.value), status: "deploying", deployingSince: new Date().toISOString(), before: [] };
    await t.db.updateTable("settings").set({ value: JSON.stringify(st) }).where("key", "=", "hunt").execute();
    const again = await makeApp({ db: t.db, comfyUrl: home.url });
    try {
      again.services.hunt.stop();
      free("NVIDIA A40");
      await again.services.hunt.tick();
      expect(again.services.hunt.view().hunt).toBeNull();
      expect(creates()).toBe(0);
      expect(await again.services.queue.pausedOn("m1")).toBe(false);
    } finally {
      again.services.hunt.stop();
      again.services.rented.stop();
      again.services.notify.stop();
      again.services.queue.stop();
    }
  });
});

describe("the files it deploys with", () => {
  it("adds the files of the renders queued since it began, not those whose jobs were left out", async () => {
    await queue(2);
    const listed = (await get(t.app, "/api/runpod/deploy/models?cloud=SECURE")).json().jobs.files as Array<{ file: string; folder: string }>;
    const first = listed.find((f) => f.file === CHECKPOINT)!;
    expect(first).toBeTruthy();
    // the dialog sent no file ticked and left the waiting jobs' checkpoint out
    expect((await start({ deploy: { ...DEPLOY, leaveOut: [{ file: first.file, folder: first.folder }] } })).statusCode).toBe(200);
    // a render queued since, of another checkpoint: its file is fetched while the pod starts
    await post(t.app, "/api/jobs", job({ prompt: "zz-test later", checkpoint: "zz-test-later.safetensors" }));
    free("NVIDIA A40");
    await t.services.hunt.tick();
    expect(creates()).toBe(1);
    const machine = (await readSettings(t.db)).machines.find((m) => m.rented)!;
    const files = machine.rented!.files.map((f) => f.file);
    expect(files).toContain("zz-test-later.safetensors");
    expect(files).not.toContain(CHECKPOINT);
  });
});

describe("the home machines", () => {
  it("rest: paused while it hunts and while its pod runs, resumed once the pod is terminated", async () => {
    await queue();
    await start();
    expect(await paused()).toBe(true);
    free("NVIDIA A40");
    await t.services.hunt.tick();
    const id = (await hunt()).hunt!.machine!;
    await until(async () => (await t.services.rented.poll(), runpod.pods[0]!.status === "RUNNING"));
    await t.services.hunt.tick();
    expect(await paused()).toBe(true);
    expect((await post(t.app, `/api/machines/${id}/stop`, { how: "terminate" })).statusCode).toBe(200);
    await until(async () => (await hunt()).hunt === null);
    expect(await paused()).toBe(false);
  });

  it("rest: resumed once its pod on a volume is stopped (its machine kept)", async () => {
    await queue();
    await start({ deploy: { ...DEPLOY, volume: "vol-ro", idleDo: "stop" } });
    free("NVIDIA A40");
    await t.services.hunt.tick();
    const id = (await hunt()).hunt!.machine!;
    await until(async () => (await t.services.rented.poll(), runpod.pods[0]!.status === "RUNNING"));
    expect(await paused()).toBe(true);
    expect((await post(t.app, `/api/machines/${id}/stop`, { how: "stop" })).statusCode).toBe(200);
    await until(async () => (await hunt()).hunt === null);
    expect((await readSettings(t.db)).machines.some((m) => m.id === id)).toBe(true);
    expect(await paused()).toBe(false);
  });

  it("rest: resumed when the hunt is cancelled; a machine resumed by hand is left alone after", async () => {
    await queue();
    await start();
    expect(await paused()).toBe(true);
    expect((await t.app.inject({ method: "DELETE", url: "/api/hunt" })).statusCode).toBe(200);
    expect(await paused()).toBe(false);
    expect((await hunt()).hunt).toBeNull();
    // again: resumed by hand, then paused by hand; the hunt's end does not touch it
    await start();
    await post(t.app, "/api/queue/resume", { machine: "m1" });
    await until(async () => (await hunt()).hunt!.pausedByHunt.length === 0);
    await post(t.app, "/api/queue/pause", { machine: "m1" });
    await t.app.inject({ method: "DELETE", url: "/api/hunt" });
    expect(await paused()).toBe(true);
  });

  it("a machine paused before the hunt is not the hunt's to resume; keep pauses nothing; changing the hold pauses or resumes", async () => {
    await queue();
    await post(t.app, "/api/queue/pause", { machine: "m1" });
    await start();
    expect((await hunt()).hunt!.pausedByHunt).toEqual([]);
    await t.app.inject({ method: "DELETE", url: "/api/hunt" });
    expect(await paused()).toBe(true);
    await post(t.app, "/api/queue/resume", { machine: "m1" });
    await start({ hold: "keep" });
    expect(await paused()).toBe(false);
    await t.app.inject({ method: "PATCH", url: "/api/hunt", payload: { hold: "rest" } });
    expect(await paused()).toBe(true);
    expect((await hunt()).hunt!.pausedByHunt).toEqual(["m1"]);
    await t.app.inject({ method: "PATCH", url: "/api/hunt", payload: { hold: "keep" } });
    expect(await paused()).toBe(false);
  });

  it("with one ComfyUI, its Resume takes the hunt's pause off too", async () => {
    await queue();
    await start();
    expect((await get(t.app, "/api/queue")).json().paused).toBe(true);
    await post(t.app, "/api/queue/resume", {});
    expect(await paused()).toBe(false);
  });
});

describe("the dialog's live ranking", () => {
  it("needs no hunt, and asks RunPod at most every 20 s", async () => {
    t.services.hunt.freshMs = 20_000;
    await queue();
    const asks = () => runpod.calls.filter((c) => c === "GET /v2/catalog/gpus").length;
    const first = await post(t.app, "/api/hunt/rank", { mode: "cheap", ceiling: 0.5, cloud: "SECURE" });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ held: 2 });
    expect((first.json().ranking as Array<{ name: string; fit: string }>).map((g) => [g.name, g.fit])).toEqual([["A40", "yes"], ["RTX 4090", "price"]]);
    await post(t.app, "/api/hunt/rank", { mode: "fast", ceiling: 2, cloud: "SECURE", volume: "vol-ro" });
    expect(asks()).toBe(1);
    expect((await post(t.app, "/api/hunt/rank", { ceiling: 1, volume: "vol-gone" })).statusCode).toBe(409);
  });

  it("a GPU rendered on once is a guess, not learned; a deploy's own cost from the sessions that ended", async () => {
    runpod.gpus.push(gpu("NVIDIA H100 80GB HBM3", "H100 SXM", 2.69, "NONE", 80));
    const at = new Date().toISOString();
    const stat = (id: string, gpuName: string, stepMs: number) => ({
      id, owner_id: "local", recipe_id: "sdxl.text-to-picture", family: "sdxl", model: "illustrious", model_file: "illustrious", time_key: "steps=28", kind: "image" as const,
      width: 832, height: 1216, duration_ms: null, steps: 28, status: "done" as const, whole: 1, cold: 0, waited_ms: 0, total_ms: stepMs * 28 + 1000, load_ms: 1000, sample_ms: stepMs * 28,
      refine_ms: 0, finish_ms: 0, step_ms: stepMs, expected_ms: null, work: 832 * 1216, vram_peak: null, heat_peak: null, asset_id: null, machine_id: "m1", gpu: gpuName, created_at: at,
    });
    // the home 4090 three times, a rented H100 once at a quarter of its step: one render is no pace
    await t.db.insertInto("render_stats").values([stat("a", "cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync", 500), stat("b", "cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync", 500), stat("c", "cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync", 500), stat("d", "NVIDIA H100 80GB HBM3", 125)]).execute();
    // a session that booted 5 min and stopped 10 min after its last work
    const t0 = Date.now() - 3_600_000;
    const iso = (ms: number) => new Date(ms).toISOString();
    await t.db.insertInto("rent_sessions").values({ id: "zz-s", machine_id: "rp-zz", pod: "zz", rate: 0.44, started_at: iso(t0), ended_at: iso(t0 + 20 * 60_000), seen_at: null, gpu: "NVIDIA A40", up_at: iso(t0 + 5 * 60_000), idle_minutes: 10 }).execute();
    await t.db.insertInto("render_stats").values({ ...stat("e", "NVIDIA A40", 500), machine_id: "rp-zz", total_ms: 5 * 60_000, created_at: iso(t0 + 10 * 60_000) }).execute();
    await queue();
    const res = (await post(t.app, "/api/hunt/rank", { mode: "value", ceiling: 5 })).json() as { ranking: Array<{ name: string; price: number; cost: number | null; timeSaid: string; overhead: number | null }>; overhead: unknown };
    const by = Object.fromEntries(res.ranking.map((g) => [g.name, g]));
    expect(by["H100 SXM"]).toMatchObject({ timeSaid: "a guess" });
    // its time guessed from the 4090's by the table (1.9 times as fast), not its own render (4 times)
    expect(by["H100 SXM"]!.cost! / by["RTX 4090"]!.cost!).toBeCloseTo(2.69 / 1.9 / 0.69, 6);
    expect(res.overhead).toEqual({ bootMs: 5 * 60_000, idleMs: 10 * 60_000, sessions: 1 });
    for (const g of res.ranking) expect(g.overhead).toBeCloseTo((g.price * 15) / 60, 10);
  });

  it("times learned from the user's renders by GPU, guessed elsewhere; a file that ran out of memory on a GPU makes it too small", async () => {
    runpod.gpus.push(gpu("NVIDIA H100 80GB HBM3", "H100 SXM", 2.69, "NONE", 80));
    const at = new Date().toISOString();
    const stat = (id: string, gpuName: string, stepMs: number, status: "done" | "failed" = "done") => ({
      id, owner_id: "local", recipe_id: "sdxl.text-to-picture", family: "sdxl", model: "illustrious", model_file: "illustrious", time_key: "steps=28", kind: "image" as const,
      width: 832, height: 1216, duration_ms: null, steps: 28, status, whole: 1, cold: 0, waited_ms: 0, total_ms: stepMs * 28 + 1000, load_ms: 1000, sample_ms: stepMs * 28,
      refine_ms: 0, finish_ms: 0, step_ms: stepMs, expected_ms: null, work: 832 * 1216, vram_peak: null, heat_peak: null, asset_id: null, machine_id: "m1", gpu: gpuName, created_at: at,
    });
    // the home 4090 three times, a rented H100 three times at half its step (on record before the renders are queued: their
    // forecasts are kept half a minute); then a render on an A40 that ran out of memory
    const home4090 = "cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync";
    await t.db.insertInto("render_stats").values([stat("a", home4090, 500), stat("b", home4090, 500), stat("c", home4090, 500), ...["d", "e", "f"].map((id) => stat(id, "cuda:0 NVIDIA H100 80GB HBM3 : cudaMallocAsync", 250))]).execute();
    const ids = await queue();
    await t.db.insertInto("render_stats").values(stat(ids[2]!, "cuda:0 NVIDIA A40 : cudaMallocAsync", 500, "failed")).execute();
    await t.db.updateTable("jobs").set({ error: "torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB" }).where("id", "=", ids[2]!).execute();
    const ranking = (await post(t.app, "/api/hunt/rank", { mode: "fast", ceiling: 5 })).json().ranking as Array<{ name: string; seconds: number | null; timeSaid: string; fit: string; fits: string }>;
    const by = Object.fromEntries(ranking.map((g) => [g.name, g]));
    expect(by["RTX 4090"]).toMatchObject({ timeSaid: "from 3 of your renders", fit: "yes" });
    expect(by["H100 SXM"]).toMatchObject({ timeSaid: "from 3 of your renders", fit: "yes" });
    expect(by["RTX 4090"]!.seconds).toBeGreaterThan(0);
    expect(by["H100 SXM"]!.seconds! / by["RTX 4090"]!.seconds!).toBeCloseTo(0.5, 1);
    expect(by["A40"]).toMatchObject({ fit: "small", fits: "too small for these files" });
    expect(ranking.map((g) => g.name)).toEqual(["H100 SXM", "RTX 4090", "A40"]);
  });
});
