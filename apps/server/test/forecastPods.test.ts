import { describe, expect, it } from "vitest";
import { migrate, openSqlite, type Db } from "../src/db";
import { forecast, fromRates, gpuPaces, machinePaces, paceOf, rates, rentedLoadMs } from "../src/forecast";
import type { RenderRow } from "../src/renderDigests";

/**
 * A machine's and a GPU's pace when pods come and go (review 2026-10-15, F-1, F-2, F-3, F-8, F-9): every deploy is a new
 * machine id, so a new pod was told another card's times as they were, the GPU hunt multiplied a pod's time by its pace a
 * second time, one render made a GPU's pace, and a first cold load read another machine's disk.
 */

const HOME = "NVIDIA GeForce RTX 4070 Ti";
const A40 = "NVIDIA A40";
const ADA = "NVIDIA RTX 2000 Ada Generation";
/** A Wan window: 832 × 480, 81 frames, eight steps. */
const W = 832 * 480 * 81;

let n = 0;
const at = (i: number) => new Date(Date.UTC(2026, 9, 10, 0, 0, i)).toISOString();
/** A Wan render on record: eight steps of `stepMs`, a 10 s load and 20 s around them. */
const row = (machine: string, gpu: string | null, stepMs: number, over: Partial<RenderRow> = {}): RenderRow => ({
  id: `r${n++}`, owner_id: "local", recipe_id: "wan.i2v", family: "wan", model: "Wan", model_file: "wan22", time_key: "steps=8",
  kind: "video", width: 832, height: 480, duration_ms: 5000, steps: 8, status: "done", whole: 1, cold: 0, waited_ms: 0,
  total_ms: 8 * stepMs + 30_000, load_ms: 10_000, sample_ms: 8 * stepMs, refine_ms: 0, finish_ms: 0, step_ms: stepMs, expected_ms: null,
  vram_peak: null, heat_peak: null, asset_id: null, work: W, machine_id: machine, gpu, node_ms: null, energy_wh: null, power_avg_w: null, ram_peak: null, ram_total: null, created_at: at(n), ...over,
});
/** An SDXL picture: 28 steps of `stepMs`. */
const picture = (machine: string, gpu: string | null, stepMs: number, over: Partial<RenderRow> = {}) =>
  row(machine, gpu, stepMs, { recipe_id: "sdxl.t2p", family: "sdxl", model_file: "pony", time_key: "steps=28", kind: "image", duration_ms: null, steps: 28, work: 1024 * 1024, total_ms: 28 * stepMs + 2_000, load_ms: 500, sample_ms: 28 * stepMs, ...over });
/** RunPod's pod, seen running before its first render: its GPU is known from then. */
const session = (machine: string, gpu: string) => ({ id: `s${n++}`, machine_id: machine, pod: machine.slice(3), rate: 0.4, started_at: at(n), ended_at: null, seen_at: at(n), gpu, up_at: null, idle_minutes: 10 });

async function record(rows: RenderRow[], sessions: Array<ReturnType<typeof session>> = []): Promise<Db> {
  const db = openSqlite(":memory:");
  await migrate(db);
  for (let i = 0; i < rows.length; i += 200) await db.insertInto("render_stats").values(rows.slice(i, i + 200)).execute();
  if (sessions.length) await db.insertInto("rent_sessions").values(sessions).execute();
  return db;
}
const like = (machine: string | null, paces: ReadonlyMap<string, number>) => ({ recipeId: "wan.i2v", family: "wan", samples: true, machine, paces });
const times = <T>(k: number, make: () => T) => Array.from({ length: k }, make);

describe("a new pod's forecast", () => {
  it("of a GPU rendered on before: the old pod's time, not this computer's", async () => {
    // this computer 60 s a step; an A40 pod deployed before, 30 s; a new A40 pod, nothing rendered yet
    const db = await record([...times(6, () => row("m1", HOME, 60_000)), ...times(4, () => row("rp-old", A40, 30_000))], [session("rp-old", A40), session("rp-new", A40)]);
    const paces = await machinePaces(db);
    expect(paces.get("rp-new")).toBe(paces.get("rp-old"));
    // 8 × 30 s + 30 s: what the old A40 took (it said 510 s, this computer's)
    expect((await forecast(db, "wan22", W, 8, false, like("rp-new", paces)))!.ms).toBe(270_000);
  });

  it("of a GPU never rendered on: the speed table's guess against a card rendered on", async () => {
    // the A40 rendered the pictures both machines did at half this computer's step; a new 2000 Ada pod: the table says it is
    // 0.2 of a 4090 where the A40 is 0.45, so 2.25 times the A40's time (it said 9.8 min, the A40's; it took about 21.5)
    const db = await record(
      [...times(2, () => row("m1", HOME, 150_000)), ...times(4, () => row("rp-a40", A40, 70_000)), ...times(3, () => picture("m1", HOME, 500)), ...times(3, () => picture("rp-a40", A40, 250))],
      [session("rp-a40", A40), session("rp-ada", ADA)],
    );
    const paces = await machinePaces(db);
    expect(paces.get("rp-ada")! / paces.get("rp-a40")!).toBeCloseTo(0.45 / 0.2, 5);
    const ms = (await forecast(db, "wan22", W, 8, false, like("rp-ada", paces)))!.ms;
    expect(ms).toBe(10_000 + (8 * 70_000 + 20_000) * 2.25);
  });

  it("keeps a machine's few own renders beside its twin's with the same card: one slow first render does not stand for it", async () => {
    // m2, the same 4070 Ti, rendered the picture five times at 245 ms a step; m1 once, a slow first render at 450
    const db = await record([...times(5, () => picture("m2", HOME, 245)), picture("m1", HOME, 450)]);
    const paces = await machinePaces(db);
    const f = (await forecast(db, "pony", 1024 * 1024, 28, false, { recipeId: "sdxl.t2p", family: "sdxl", samples: true, machine: "m1", paces }))!;
    expect(f.samples).toBe(6);
    expect(f.ms).toBeLessThan(28 * 300 + 2_500);
  });
});

describe("the forecast on no machine in particular (the GPU hunt's)", () => {
  it("reads every render at the common pace, so that the hunt's GPU pace is not applied twice", async () => {
    const db = await record([...times(6, () => row("m1", HOME, 60_000)), ...times(6, () => row("rp-a40", A40, 30_000))]);
    const paces = await machinePaces(db);
    const common = (await forecast(db, "wan22", W, 8, false, like(null, paces)))!.ms;
    // the newest renders are the A40's: read as they are they said the A40's 270 s, which the hunt then halved again
    const onHome = (await forecast(db, "wan22", W, 8, false, like("m1", paces)))!.ms;
    // (what surrounds the A40's steps is read at the common pace too: a little over this computer's)
    expect(paceOf(paces, "m1")).toBe(1);
    expect(common / onHome).toBeGreaterThan(0.99);
    expect(common / onHome).toBeLessThan(1.05);
  });

  it("with this computer alone is its figure, unchanged", async () => {
    const db = await record(times(5, () => row("m1", HOME, 60_000)));
    const paces = await machinePaces(db);
    expect(paces.get("m1")).toBe(1);
    const mine = (await forecast(db, "wan22", W, 8, false, like("m1", paces)))!.ms;
    expect(mine).toBe(510_000);
    expect((await forecast(db, "wan22", W, 8, false, like(null, paces)))!.ms).toBe(mine);
    expect((await forecast(db, "wan22", W, 8, false, like(null, new Map())))!.ms).toBe(mine);
  });
});

describe("a GPU's pace", () => {
  it("is not learned from one render: a GPU compared with nothing is left out", async () => {
    // one A40 render slowed three times (a cold disk): it read as pace 1.5 where the card is twice as fast
    const db = await record([...times(6, () => row("m1", HOME, 60_000)), row("rp-a40", A40, 90_000)]);
    expect(await gpuPaces(db)).toEqual([{ gpu: HOME, pace: 1, renders: 6 }]);
  });

  it("counts the renders compared, not every render of the card", async () => {
    const db = await record([...times(6, () => row("m1", HOME, 60_000)), ...times(3, () => row("rp-a40", A40, 30_000)), ...times(20, () => picture("m1", HOME, 500))]);
    const paces = await gpuPaces(db);
    expect(paces.find((g) => g.gpu === HOME)).toMatchObject({ renders: 6 });
    expect(paces.find((g) => g.gpu === A40)).toMatchObject({ renders: 3 });
  });
});

describe("a machine's pace", () => {
  it("is its pace on the model's family where it was compared on it", async () => {
    // the A40 at 0.7 of this computer on Qwen pictures, at 0.25 on Wan windows
    const qwen = (machine: string, gpu: string, stepMs: number) => picture(machine, gpu, stepMs, { recipe_id: "qwen.t2p", family: "qwen", model_file: "qwen" });
    const db = await record([...times(3, () => qwen("m1", HOME, 1_000)), ...times(3, () => qwen("rp-a40", A40, 700)), ...times(3, () => row("m1", HOME, 120_000)), ...times(3, () => row("rp-a40", A40, 30_000))]);
    const paces = await machinePaces(db);
    expect(paceOf(paces, "rp-a40", "wan")! / paceOf(paces, "m1", "wan")!).toBeCloseTo(0.25, 5);
    expect(paceOf(paces, "rp-a40", "qwen")! / paceOf(paces, "m1", "qwen")!).toBeCloseTo(0.7, 5);
    // the reference machine is 1 on each family it was compared on, not 0.85 on one and 1.15 on the other
    expect(paceOf(paces, "m1", "wan")).toBeCloseTo(1, 5);
    expect(paceOf(paces, "m1", "qwen")).toBeCloseTo(1, 5);
    expect(paceOf(paces, "rp-a40", "wan")).toBeCloseTo(0.25, 5);
  });

  it("compares windows of different lengths on their step for the work", async () => {
    // this computer rendered 5 s windows, the pod 3 s ones (fewer frames, a cheaper step): the same pace per frame
    const short = { duration_ms: 3000, work: 832 * 480 * 49, time_key: "steps=8;seconds=3" };
    const db = await record([...times(3, () => row("m1", HOME, 60_000)), ...times(3, () => row("rp-a40", A40, (30_000 * 49) / 81, short))]);
    const paces = await machinePaces(db);
    expect(paces.get("rp-a40")! / paces.get("m1")!).toBeCloseTo(0.5, 5);
  });

  it("lasts past a week of this computer's renders", async () => {
    // a pod's three renders, then 700 of this computer's (more than the latest 600 the paces were read from)
    const db = await record([...times(3, () => row("m1", HOME, 60_000)), ...times(3, () => row("rp-a40", A40, 30_000)), ...times(700, () => picture("m1", HOME, 500))]);
    expect((await machinePaces(db)).get("rp-a40")! / (await machinePaces(db)).get("m1")!).toBeCloseTo(0.5, 5);
  });
});

describe("a first cold load", () => {
  it("is read from this machine's disk first: the family's loads here, then any model's, before another machine's of the model", async () => {
    // m2 loaded the Wan model in 73 s; this computer never loaded it, but loads its SDXL models in 15 s
    const db = await record([
      ...times(3, () => row("m1", HOME, 60_000)), row("m2", HOME, 60_000, { cold: 1, load_ms: 73_000, total_ms: 8 * 60_000 + 93_000 }),
      picture("m1", HOME, 500, { cold: 1, load_ms: 15_000, total_ms: 28 * 500 + 16_500 }),
    ]);
    const paces = await machinePaces(db);
    const f = (await forecast(db, "wan22", W, 8, true, like("m1", paces)))!;
    expect(f.loadMs).toBe(15_000 - 10_000);
    // a machine that never loaded anything cold: the others' loads of the model
    expect((await forecast(db, "wan22", W, 8, true, like("m3", paces)))!.loadMs).toBe(73_000 - 10_000);
  });
});

describe("the machines' paces and the cards'", () => {
  it("are on one scale when pods pile renders onto one card: two A40 pods of three renders each against a PC with four", async () => {
    // each deploy is a new machine: this PC is the machines' 1 (four renders), the A40 the cards' (six): read on two scales a
    // new A40 pod was told 1.43 times its time, and the hunt's A40 (the common pace times the card's) as much
    const qwen = (machine: string, gpu: string, stepMs: number) => picture(machine, gpu, stepMs, { recipe_id: "qwen.t2p", family: "qwen", model_file: "qwen" });
    const db = await record([...times(4, () => qwen("m1", HOME, 1_000)), ...times(3, () => qwen("rp-0", A40, 700)), ...times(3, () => qwen("rp-1", A40, 700))], [session("rp-new", A40)]);
    const paces = await machinePaces(db);
    expect(paces.get("m1")).toBe(1);
    expect(paces.get("rp-new")).toBeCloseTo(0.7, 5);
    expect((await gpuPaces(db)).find((g) => g.gpu === A40)!.pace).toBeCloseTo(0.7, 5);
    expect((await gpuPaces(db)).find((g) => g.gpu === HOME)!.pace).toBeCloseTo(1, 5);
    const at = { recipeId: "qwen.t2p", family: "qwen", samples: true, paces };
    const onNew = (await forecast(db, "qwen", 1024 * 1024, 28, false, { ...at, machine: "rp-new" }))!.ms;
    const onOld = (await forecast(db, "qwen", 1024 * 1024, 28, false, { ...at, machine: "rp-0" }))!.ms;
    expect(onNew).toBe(onOld);
  });
});

describe("a model never rendered here", () => {
  it("reads the renders of the same recipe with the family's other models, not the recipe's usual time", async () => {
    // a new version of the Wan model: none of its renders yet; the family's other recipe is left out
    const db = await record([...times(3, () => row("m1", HOME, 60_000)), ...times(3, () => row("m1", HOME, 10_000, { recipe_id: "wan.t2v", model_file: "wan21" }))]);
    const paces = await machinePaces(db);
    const before = (await forecast(db, "wan22", W, 8, false, like("m1", paces)))!.ms;
    expect((await forecast(db, "wan23", W, 8, false, like("m1", paces)))!.ms).toBe(before);
    // nor any recipe of the family it rendered: nothing said here, the recipe's usual time is (fromRates)
    expect(await forecast(db, "wan23", W, 8, false, { ...like("m1", paces), recipeId: "wan.flf" })).toBeNull();
  });
});

describe("the fallback's usual times", () => {
  it("keep a recipe's finishes apart from its drafts: a fresh install's first finish is not priced from the drafts", async () => {
    const h3 = (sampleMs: number, totalMs: number) => row("m1", HOME, 1_000, { recipe_id: "h3.video", family: "h3", model_file: "h3", sample_ms: sampleMs, total_ms: totalMs, load_ms: 0 });
    const recipe = { id: "h3.video", inputs: [] } as unknown as Parameters<typeof fromRates>[1];
    const drafts = await record(times(3, () => h3(150_000, 210_000)));
    expect(fromRates(await rates(drafts), recipe, {}, { samples: true })!.ms).toBe(210_000);
    expect(fromRates(await rates(drafts), recipe, {}, { samples: false })).toBeNull();
    const both = await record([...times(3, () => h3(150_000, 210_000)), ...times(2, () => h3(0, 34_000))]);
    expect(fromRates(await rates(both), recipe, {}, { samples: false })!.ms).toBe(34_000);
    expect(fromRates(await rates(both), recipe, {}, { samples: true })!.ms).toBe(210_000);
    // not told which: the drafts', as before
    expect(fromRates(await rates(both), recipe, {})!.ms).toBe(210_000);
    // a draft with only renders filed as sampling nothing (their sampling not seen) reads those
    const unseen = await record(times(2, () => h3(0, 34_000)));
    expect(fromRates(await rates(unseen), recipe, {}, { samples: true })!.ms).toBe(34_000);
  });
});

describe("a pod's model load, for the GPU hunt", () => {
  it("is what the pods' cold loads add over their warm ones, not this computer's", async () => {
    const db = await record(
      [...times(3, () => row("m1", HOME, 60_000, { cold: 1, load_ms: 15_000 })), row("rp-a40", A40, 30_000, { cold: 1, load_ms: 61_000 }), row("rp-a40", A40, 30_000, { load_ms: 11_000 })],
      [session("rp-a40", A40)],
    );
    expect(await rentedLoadMs(db, "wan")).toBe(50_000);
    expect(await rentedLoadMs(await record(times(3, () => row("m1", HOME, 60_000, { cold: 1 }))), "wan")).toBeNull();
  });
});
