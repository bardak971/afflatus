import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeComfy } from "@afflatus/comfy/testing";
import { modelOf } from "@afflatus/core";
import { newId, now } from "../src/db";
import { newAssetRow } from "../src/media";
import { gpuOf } from "../src/queue";
import type { RenderRow } from "../src/renderDigests";
import { toolPace } from "../src/renders";
import { CUT_JOB } from "../src/timelineModel";
import { CHECKPOINT, get, job, makeApp, makeFake, post, until, type TestApp } from "./helpers";

/**
 * The figures the queue and the forms say with several machines (the forecast review of 2026-10-15, F-7 and F-20 to F-23):
 * whether each machine holds the model itself, what a batch or a timeline's finish takes through the machines' lanes, and
 * the GPU a render is recorded under.
 */

let fakes: FakeComfy[];
let t: TestApp;
beforeEach(async () => {
  fakes = await Promise.all([makeFake(), makeFake(), makeFake()]);
  for (const f of fakes) f.models.checkpoints = [CHECKPOINT, "other.safetensors"];
  t = await makeApp({ comfyUrl: fakes[0]!.url });
  await t.app.inject({ method: "PUT", url: "/api/settings", payload: { machines: fakes.map((f, i) => ({ id: `m${i + 1}`, name: `GPU ${i + 1}`, url: f.url })) } });
  await t.services.queue.start();
});
afterEach(async () => {
  await t.close();
  await Promise.all(fakes.map((f) => f.close().catch(() => {})));
});

const RECIPE = "sdxl.text-to-picture";
const INPUT = job().input;
/** What a machine's lane was last asked to load, set as a job of that model would leave it. */
const holds = (machine: string, loads: string | null) => {
  (t.services.queue as unknown as { lanes: Map<string, { lastLoads: string | null }> }).lanes.get(machine)!.lastLoads = loads;
};
/** This computer's renders of the form's model: warm ones at 20 s with a 1 s load, cold ones with a 30 s load. */
const rendered = async () => {
  const at = now();
  const row = (i: number, cold: boolean): RenderRow => ({
    id: `r${i}`, owner_id: "local", recipe_id: RECIPE, family: "sdxl", model: "illustrious", model_file: modelOf(t.services.registry.recipe(RECIPE)!.inputs, INPUT)!, time_key: "steps=28",
    kind: "image", width: 832, height: 1216, duration_ms: null, steps: 28, status: "done", whole: 1, cold: cold ? 1 : 0, waited_ms: 0,
    total_ms: (cold ? 30_000 : 1_000) + 19_000, load_ms: cold ? 30_000 : 1_000, sample_ms: 14_000, refine_ms: 0, finish_ms: 5_000, step_ms: 500, expected_ms: null,
    vram_peak: null, heat_peak: null, asset_id: null, work: 832 * 1216, machine_id: "m1", gpu: null, node_ms: null, energy_wh: null, power_avg_w: null, ram_peak: null, ram_total: null, created_at: at,
  });
  await t.db.insertInto("render_stats").values([row(0, false), row(1, false), row(2, false), row(3, false), row(4, true), row(5, true)]).execute();
};

describe("whether a machine must load the model", () => {
  it("is told by each machine's own: m3 holding another model is told cold, m1 holding it warm", async () => {
    await rendered();
    holds("m1", CHECKPOINT);
    holds("m2", CHECKPOINT);
    holds("m3", "other.safetensors");
    const got = await t.services.queue.forecast(RECIPE, INPUT);
    expect(got?.on?.m1?.loadMs).toBe(0);
    expect(got?.on?.m2?.loadMs).toBe(0);
    expect(got?.on?.m3?.loadMs).toBeGreaterThan(25_000);
    expect(got!.on!.m3!.ms - got!.on!.m1!.ms).toBe(got!.on!.m3!.loadMs);
    // Auto says the soonest: a machine holding it
    expect(got?.forecast.loadMs).toBe(0);
  });

  it("is told by the machine a waiting render will run on, after what runs there", async () => {
    await rendered();
    holds("m1", CHECKPOINT);
    const warm = (await t.services.queue.forecast(RECIPE, INPUT))!.on!.m1!.ms;
    // only m3 takes work; it runs a render of another model that does not end, and the next render waits for it
    await post(t.app, "/api/queue/use-only", { machine: "m3" });
    await post(t.app, "/api/jobs", job({ checkpoint: "other.safetensors" }));
    await until(() => fakes[2]!.prompts.size === 1);
    const waiting = (await post(t.app, "/api/jobs", job())).json().ids[0] as string;
    const row = ((await get(t.app, "/api/queue")).json().waiting as Array<{ id: string; machine: string | null; estimateMs: number | null }>).find((w) => w.id === waiting)!;
    expect(row.machine).toBe("m3");
    // judged by the first machine (which holds it), it was said warm
    expect(row.estimateMs! - warm).toBeGreaterThan(25_000);
  });
});

describe("a waiting render on a machine that holds nothing", () => {
  it("is told cold: nothing was asked to load there yet (it was told warm)", async () => {
    await rendered();
    holds("m1", CHECKPOINT);
    const warm = (await t.services.queue.forecast(RECIPE, INPUT))!.on!.m1!.ms;
    // paused, the line is judged by the first machine, which holds nothing known now
    await post(t.app, "/api/queue/pause", {});
    holds("m1", null);
    const waiting = (await post(t.app, "/api/jobs", job())).json().ids[0] as string;
    const row = ((await get(t.app, "/api/queue")).json().waiting as Array<{ id: string; estimateMs: number | null }>).find((w) => w.id === waiting)!;
    expect(row.estimateMs! - warm).toBeGreaterThan(25_000);
  });
});

describe("a form placed from its recipe's usual times (its model never rendered)", () => {
  it("is said on each machine, each with its own load, and only on the machines that can render it", async () => {
    // renders of the recipe with another model: the form's own model was never rendered
    const at = now();
    await t.db.insertInto("render_stats").values([0, 1, 2, 3].map((i): RenderRow => ({
      id: `o${i}`, owner_id: "local", recipe_id: RECIPE, family: "sdxl", model: "other", model_file: "other.safetensors", time_key: "steps=28",
      kind: "image", width: 832, height: 1216, duration_ms: null, steps: 28, status: "done", whole: 1, cold: i === 0 ? 1 : 0, waited_ms: 0,
      total_ms: (i === 0 ? 30_000 : 1_000) + 19_000, load_ms: i === 0 ? 30_000 : 1_000, sample_ms: 14_000, refine_ms: 0, finish_ms: 5_000, step_ms: 500, expected_ms: null,
      vram_peak: null, heat_peak: null, asset_id: null, work: 832 * 1216, machine_id: "m1", gpu: null, node_ms: null, energy_wh: null, power_avg_w: null, ram_peak: null, ram_total: null, created_at: at,
    }))).execute();
    holds("m1", CHECKPOINT);
    holds("m3", "other.safetensors");
    fakes[1]!.models.checkpoints = ["other.safetensors"];
    await post(t.app, "/api/setup/rescan?machine=m2", {});
    const got = await t.services.queue.forecast(RECIPE, INPUT);
    // every machine was given the first one's figure, warm as it held the model
    expect(got?.on?.m3?.ms).toBeGreaterThan(got!.on!.m1!.ms + 20_000);
    expect("can" in got! && got.can).toEqual(["m1", "m3"]);
    // the editor's figures: m2, without the file, is not one Auto or Render on can take
    const said = (await post(t.app, "/api/forecasts", { forms: [{ recipe: RECIPE, input: INPUT }] })).json();
    expect(said.can[0]).toEqual(["m1", "m3"]);
    expect(said.ms[0]).toBe(got!.on!.m1!.ms);
  });
});

describe("Auto on the form", () => {
  it("counts only the machines that have the form's files, and shares a batch between them", async () => {
    await rendered();
    for (const m of ["m1", "m2", "m3"]) holds(m, CHECKPOINT);
    fakes[1]!.models.checkpoints = ["other.safetensors"];
    await post(t.app, "/api/setup/rescan?machine=m2", {});
    const got = await t.services.queue.forecast(RECIPE, INPUT);
    expect("auto" in got! && got.auto).toEqual(["m1", "m3"]);
    // the advice the Generate button reads: each machine's load, and the machines Auto shares a batch between
    const advice = (await post(t.app, "/api/advice", { recipe: RECIPE, input: INPUT })).json().estimate;
    expect(advice).toMatchObject({ auto: ["m1", "m3"], loadOn: { m1: 0, m3: 0 } });
  });
});

describe("what a batch or a timeline's finish takes in all", () => {
  it("is about halved by two free machines that hold the model, and a renders' count is spread between them", async () => {
    await rendered();
    for (const m of ["m1", "m2", "m3"]) holds(m, CHECKPOINT);
    const one = (await t.services.queue.total([{ recipe: RECIPE, input: INPUT }])).ms!;
    expect(one).toBeGreaterThan(15_000);
    // three machines, two renders: one each, at the same time
    expect((await t.services.queue.total([{ recipe: RECIPE, input: INPUT, times: 2 }])).ms).toBe(one);
    // one machine: one after the other
    await post(t.app, "/api/queue/use-only", { machine: "m1" });
    expect((await t.services.queue.total([{ recipe: RECIPE, input: INPUT, times: 2 }])).ms).toBe(2 * one);
    // a render carried on from the one before waits for it, on any number of machines
    await post(t.app, "/api/queue/resume", {});
    expect((await t.services.queue.total([{ recipe: RECIPE, input: INPUT }, { recipe: RECIPE, input: INPUT, after: 0 }])).ms).toBe(2 * one);
    // a form nothing like was rendered: not told
    expect((await t.services.queue.total([{ recipe: "nope", input: {} }])).ms).toBeNull();
  });

  it("takes a two-job Finish in one finish's time on two free machines", async () => {
    const video = newAssetRow({
      id: newId(), kind: "video", origin: "uploaded", name: "zz-test clip", file_key: "assets/x.mp4", thumb_key: null, mime: "video/mp4", bytes: 10, width: 640, height: 360,
      duration_ms: 2_000, fps: 24, has_sound: 0, folder_id: null, generation_id: null, source_id: null, deleted_at: null,
    });
    await t.db.insertInto("assets").values(video).execute();
    const work = 1280 * 720 * 48;
    await t.db.insertInto("render_stats").values([0, 1, 2].map((i): RenderRow => ({
      id: `f${i}`, owner_id: "local", recipe_id: "tool.finish.seedvr", family: "tools", model: "SeedVR2", model_file: "", time_key: "", kind: "video", width: 1280, height: 720,
      duration_ms: 2_000, steps: 0, status: "done", whole: 1, cold: 0, waited_ms: 0, total_ms: 60_000, load_ms: 0, sample_ms: 0, refine_ms: 60_000, finish_ms: 0, step_ms: null,
      expected_ms: null, vram_peak: null, heat_peak: null, asset_id: null, work, machine_id: "m1", gpu: null, node_ms: null, energy_wh: null, power_avg_w: null, ram_peak: null, ram_total: null, created_at: now(),
    }))).execute();
    const finish = { recipe: CUT_JOB, input: { asset: video.id, startMs: 0, endMs: 2_000, action: "finish", route: "seedvr", by: 2 } };
    expect((await t.services.queue.total([finish, finish])).ms).toBe(60_000);
    await post(t.app, "/api/queue/use-only", { machine: "m1" });
    expect((await t.services.queue.total([finish, finish])).ms).toBe(120_000);
  });
});

describe("a tool's pace", () => {
  it("is each machine's own: a slow pod's finishes are its pace, not runs that spilled", async () => {
    const at = now();
    const run = (id: string, machine: string, total: number, expected: number | null): RenderRow => ({
      id, owner_id: "local", recipe_id: "tool.finish.seedvr", family: "tools", model: "SeedVR2", model_file: "", time_key: "", kind: "video", width: 1280, height: 720,
      duration_ms: 2_000, steps: 0, status: "done", whole: 1, cold: 0, waited_ms: 0, total_ms: total, load_ms: 0, sample_ms: 0, refine_ms: total, finish_ms: 0, step_ms: null,
      expected_ms: expected, vram_peak: null, heat_peak: null, asset_id: null, work: 1_000, machine_id: machine, gpu: null, node_ms: null, energy_wh: null, power_avg_w: null, ram_peak: null, ram_total: null, created_at: at,
    });
    // this computer at 60 s; the pod at 150 s, each expected at this computer's 60 s; one run here that spilled
    await t.db.insertInto("render_stats").values([run("a", "m1", 60_000, 60_000), run("b", "m1", 60_000, 60_000), run("c", "m1", 61_000, 60_000), run("s", "m1", 200_000, 60_000),
      run("p1", "pod", 150_000, 60_000), run("p2", "pod", 150_000, 60_000)]).execute();
    expect(await toolPace(t.db, "tool.finish.seedvr", "m1")).toBe(60);
    expect(await toolPace(t.db, "tool.finish.seedvr", "pod")).toBe(150);
    // a machine with none of its own: every machine's at its pace
    expect(await toolPace(t.db, "tool.finish.seedvr", "m2", 2)).toBe(2 * (await toolPace(t.db, "tool.finish.seedvr"))!);
  });
});

describe("the GPU a render is recorded under", () => {
  it("is the one its ComfyUI renders on, not the first card of the computer", () => {
    const cards = [{ name: "NVIDIA GeForce RTX 3060" }, { name: "NVIDIA GeForce RTX 4070 Ti" }];
    expect(gpuOf("cuda:1 NVIDIA GeForce RTX 4070 Ti : cudaMallocAsync", cards)).toBe("NVIDIA GeForce RTX 4070 Ti");
    expect(gpuOf("cuda:0 NVIDIA A40 : cudaMallocAsync", [{ name: "GPU 0" }])).toBe("NVIDIA A40");
    // not said: the feed's when it reports one card, else none
    expect(gpuOf(null, [{ name: "NVIDIA A40" }])).toBe("NVIDIA A40");
    expect(gpuOf(null, cards)).toBeNull();
    expect(gpuOf("cpu", [])).toBeNull();
  });
});
