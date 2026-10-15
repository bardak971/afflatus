import { beforeEach, describe, expect, it } from "vitest";
import { timeKey } from "@afflatus/core";
import { scailMotion } from "@afflatus/recipes";
import { migrate, openSqlite, type Db } from "../src/db";
import { forecast, forecastFrom, machinePaces, onMachine, type Chunk } from "../src/forecast";
import type { RenderRow } from "../src/renderDigests";

/**
 * A render's forecast on the machine it goes to, and a Motion transfer window carried on from the clip before priced by
 * the frames it samples (Timeline 17, 2026-10-14: a rented A40 rendered each window in 214 to 226 s while New take said
 * 6 min for the first and 12 for the second, and Render all 59 min for six).
 */

/** A Motion transfer window as Timeline 17 renders it: 480 × 864. */
const PX = 480 * 864;
const MODEL = "sam3.1_multiplex_fp16";
const HOME = "m1";
const A40 = "rp-a40";

let db: Db;
let n = 0;
const at = new Date().toISOString();
/** A render on record, as the queue writes one. */
const row = (machine: string, over: Partial<RenderRow>): RenderRow => ({
  id: `r${n++}`, owner_id: "local", recipe_id: "scail.motion", family: "scail", model: "SCAIL", model_file: MODEL, time_key: "driving+;picture+;steps=6",
  kind: "video", width: 480, height: 864, duration_ms: 4821, steps: 6, status: "done", whole: 1, cold: 0, waited_ms: 0,
  total_ms: 0, load_ms: 0, sample_ms: 0, refine_ms: 0, finish_ms: 0, step_ms: null, expected_ms: null,
  vram_peak: null, heat_peak: null, asset_id: null, work: PX * 77, machine_id: machine, gpu: null, node_ms: null, energy_wh: null, power_avg_w: null, created_at: at, ...over,
});
/** A window of 77 frames in one chunk: six steps. */
const first = (machine: string, stepMs: number, totalMs: number, loadMs: number) => row(machine, { step_ms: stepMs, total_ms: totalMs, load_ms: loadMs, sample_ms: 6 * stepMs });
/**
 * A window carried on from the one before: 85 frames, a chunk of 81 and one of 9, six steps each. Its step is measured on
 * its first chunk (the monitor's first pass), so twelve of them are more than its sampling took.
 */
const carried = (machine: string, stepMs: number, sampleMs: number, totalMs: number, loadMs: number) =>
  row(machine, { steps: 12, work: PX * 81, duration_ms: 5013, step_ms: stepMs, sample_ms: sampleMs, total_ms: totalMs, load_ms: loadMs });
/** A picture both machines rendered with the same settings, three times each: what their paces are learned from. */
const qwen = (machine: string, stepMs: number) => row(machine, {
  recipe_id: "qwen21.motion-picture", family: "qwen21", model_file: "qwen_image_2.1", time_key: "steps=40", kind: "image", duration_ms: null,
  steps: 40, work: 1024 * 1024, step_ms: stepMs, sample_ms: 40 * stepMs, total_ms: 40 * stepMs + 5_000,
});

/** A window as the forecast is asked it: alone (77 frames) or carried on (81 + 9). */
const like = (machine: string | null, paces: ReadonlyMap<string, number>, chunks?: Chunk[]) => ({ recipeId: "scail.motion", family: "scail", samples: true, machine, paces, chunks });
const CLIP1: Chunk[] = [{ work: PX * 77, steps: 6 }];
const CLIP2: Chunk[] = [{ work: PX * 81, steps: 6 }, { work: PX * 9, steps: 6 }];

beforeEach(async () => {
  db = openSqlite(":memory:");
  await migrate(db);
  await db.insertInto("render_stats").values([
    // this computer's 4070 Ti: about 15 min a window
    first(HOME, 130_000, 900_000, 30_000), first(HOME, 128_000, 890_000, 30_000), first(HOME, 132_000, 910_000, 30_000),
    carried(HOME, 135_000, 860_000, 920_000, 30_000),
    // the rented A40: two windows, as Timeline 17's first two (their real figures)
    first(A40, 21_146, 214_298, 56_851), carried(A40, 22_853, 150_129, 225_042, 41_912),
    // both rendered the same Qwen pictures: the A40 at 0.7 of this computer's step
    qwen(HOME, 1_000), qwen(HOME, 1_000), qwen(HOME, 1_000), qwen(A40, 700), qwen(A40, 700), qwen(A40, 700),
    // a second pod that rendered those pictures only, at 0.5
    qwen("rp-other", 500), qwen("rp-other", 500), qwen("rp-other", 500),
  ]).execute();
});

describe("a forecast on the machine the render goes to", () => {
  it("reads that machine's own renders of the model as soon as it has some: two A40 windows say 220 s, not this computer's 15 min", async () => {
    const paces = await machinePaces(db);
    const one = (await forecast(db, MODEL, PX * 77, 6, false, like(A40, paces, CLIP1)))!;
    expect(one.samples).toBe(2);
    expect(one.ms).toBeGreaterThan(190_000);
    expect(one.ms).toBeLessThan(240_000);
    const home = (await forecast(db, MODEL, PX * 77, 6, false, like(HOME, paces, CLIP1)))!;
    expect(home.ms).toBeGreaterThan(800_000);
    expect(home.ms).toBeLessThan(1_000_000);
  });

  it("prices a window carried on into a short second chunk by the frames it samples: near the first window's time, never twice it", async () => {
    const paces = await machinePaces(db);
    const one = (await forecast(db, MODEL, PX * 77, 6, false, like(A40, paces, CLIP1)))!;
    const two = (await forecast(db, MODEL, PX * 81, 12, false, like(A40, paces, CLIP2)))!;
    // its real render took 225 s, the first 214 s
    expect(two.ms).toBeGreaterThan(200_000);
    expect(two.ms).toBeLessThan(250_000);
    expect(two.ms / one.ms).toBeLessThan(1.25);
    // its twelve steps all priced as the 81-frame chunk's: what New take said before
    const flat = (await forecast(db, MODEL, PX * 81, 12, false, like(A40, paces)))!;
    expect(flat.ms).toBeGreaterThan(two.ms * 1.3);
  });

  it("reads this computer's renders at the machine's pace, learned on another model, when it has none of this one; as they are when its pace is not known", async () => {
    const paces = await machinePaces(db);
    expect(paces.get("rp-other")! / paces.get(HOME)!).toBeCloseTo(0.5, 2);
    const home = (await forecast(db, MODEL, PX * 77, 6, false, like(HOME, paces, CLIP1)))!;
    const other = (await forecast(db, MODEL, PX * 77, 6, false, like("rp-other", paces, CLIP1)))!;
    // what surrounds the steps scales with them, the load does not: a little over half
    expect(other.ms / home.ms).toBeGreaterThan(0.5);
    expect(other.ms / home.ms).toBeLessThan(0.6);
    // a machine never compared: this computer's renders as they are (it rendered the recipe most)
    const unknown = (await forecast(db, MODEL, PX * 77, 6, false, like("rp-new", paces, CLIP1)))!;
    expect(unknown.ms).toBe(home.ms);
  });

  it("keeps a machine's own renders of another recipe from standing for this one", () => {
    const rows = [
      { machine_id: HOME, recipe_id: "scail.motion", step_ms: 100, total_ms: 1_000, load_ms: 100, sample_ms: 600, refine_ms: 0 },
      { machine_id: A40, recipe_id: "scail.other", step_ms: 10, total_ms: 100, load_ms: 50, sample_ms: 60, refine_ms: 0 },
    ];
    const paces = new Map([[HOME, 1], [A40, 0.5]]);
    // the A40 has none of this recipe: this computer's, at the A40's pace (the load as it was)
    expect(onMachine(rows, { machine: A40, paces, recipeId: "scail.motion" })).toEqual([{ ...rows[0], step_ms: 50, total_ms: 100 + 900 * 0.5, sample_ms: 300 }]);
    expect(onMachine(rows, { machine: A40, paces, recipeId: "scail.other" })).toEqual([rows[1]]);
    expect(onMachine(rows, { machine: null, paces })).toBe(rows);
  });
});

describe("a part made in chunks", () => {
  it("is priced chunk by chunk, each at its own size", () => {
    const points = [{ work: 100, stepMs: 1_000 }, { work: 50, stepMs: 500 }];
    expect(forecastFrom(points, 100, 12, 0)!.ms).toBe(12_000);
    expect(forecastFrom(points, 100, 12, 0, [{ work: 100, steps: 6 }, { work: 10, steps: 6 }])!.ms).toBe(6_000 + 600);
  });
});

describe("the settings a render is filed under", () => {
  it("leave out where a Motion transfer part starts in its driving video: the windows of a timeline are one set of settings", () => {
    const base = { driving: { asset: "d" }, picture: "p", drivingSeconds: 5.3438 };
    expect(timeKey(scailMotion.inputs, { ...base, drivingStart: 21.272 })).toBe(timeKey(scailMotion.inputs, { ...base, drivingStart: 26.272 }));
    expect(timeKey(scailMotion.inputs, { ...base, drivingStart: 0 })).not.toContain("drivingStart");
  });
});
