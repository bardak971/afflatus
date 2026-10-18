import { beforeEach, describe, expect, it } from "vitest";
import type { Recipe } from "@afflatus/core";
import { migrate, openSqlite, type Db } from "../src/db";
import { forecast, forecastFrom, reloadAbove, workOfRow } from "../src/forecast";
import { record, reloaded } from "../src/renders";
import type { RenderRow } from "../src/renderDigests";

/**
 * The forecast's large misses on the owner's record (the 2026-10-15 forecast review, F-10 to F-19): each case with the
 * figures it was said and took.
 */

let db: Db;
let n = 0;
/** A render on record, as the queue writes one: the newest last. */
const row = (over: Partial<RenderRow>): RenderRow => ({
  id: `r${n}`, owner_id: "local", recipe_id: "sdxl.text-to-picture", family: "sdxl", model: "M", model_file: "m", time_key: "k",
  kind: "image", width: 1024, height: 1024, duration_ms: null, steps: 20, status: "done", whole: 1, cold: 0, waited_ms: 0,
  total_ms: 0, load_ms: 500, sample_ms: 0, refine_ms: 0, finish_ms: 1000, step_ms: null, expected_ms: null,
  vram_peak: null, heat_peak: null, asset_id: null, work: 1024 * 1024, machine_id: "m1", gpu: null, node_ms: null, energy_wh: null, power_avg_w: null, ram_peak: null, ram_total: null,
  created_at: new Date(Date.UTC(2026, 9, 1) + n++ * 1000).toISOString(), ...over,
});
/** A picture: `steps` at `stepMs` each, 1 s of finishing after them, its load before. */
const pic = (work: number, steps: number, stepMs: number, over: Partial<RenderRow> = {}) =>
  row({ work, steps, step_ms: stepMs, sample_ms: steps * stepMs, total_ms: (over.load_ms ?? 500) + steps * stepMs + 1000, ...over });
const put = (...rows: RenderRow[]) => db.insertInto("render_stats").values(rows).execute();

beforeEach(async () => {
  db = openSqlite(":memory:");
  await migrate(db);
});

describe("a model with no render like the form", () => {
  /** H3 drafts: 576 × 1024, 121 frames, 8 steps of 20 s. */
  const draft = (model: string) => row({ recipe_id: "h3.video", family: "h3", model_file: model, kind: "video", work: 576 * 1024 * 121, steps: 8, step_ms: 20_000, sample_ms: 160_000, load_ms: 14_000, total_ms: 201_000 });
  /** An H3 finish at 2048 × 1152: nothing sampled of its own, 60 steps of 2.4 s in the pass after (309 s in all). */
  const finish = (model: string) => row({ recipe_id: "h3.video", family: "h3", model_file: model, kind: "video", work: 332_660_736, steps: 60, step_ms: 2435, sample_ms: 0, refine_ms: 160_040, load_ms: 20_845, total_ms: 309_375 });
  const like = { recipeId: "h3.video", family: "h3", samples: false };

  it("prices a model's first finish from the family's finishes, never from its drafts (5,626 s said, 309 s taken)", async () => {
    await put(draft("v3"), draft("v3"), draft("v3"), finish("turbo"), finish("turbo"));
    const f = (await forecast(db, "v3", 332_660_736, 60, false, like))!;
    expect(Math.abs(f.ms - 309_375) / 309_375).toBeLessThan(0.05);
  });

  it("says nothing with no finish in the family either: the recipe's usual is said instead", async () => {
    await put(draft("v3"), draft("v3"), draft("v3"));
    expect(await forecast(db, "v3", 332_660_736, 60, false, like)).toBeNull();
  });
});

describe("a form far larger than any render", () => {
  const points = [{ work: 30e6, stepMs: 10_000 }, { work: 48e6, stepMs: 16_000 }];

  it("is said up to eight times the largest, and past that not priced (a 4096-frame count said 6.2 h for 250 s)", () => {
    expect(forecastFrom(points, 5 * 48e6, 6, 0)!.pace).toBe("untested");
    expect(forecastFrom(points, 35 * 48e6, 6, 0)).toBeNull();
  });
});

describe("a Motion transfer recorded with 4096 frames", () => {
  const fps = (id: string) => (id === "scail.motion" ? 16 : undefined);
  const scail = (work: number, width = 480, height = 864) => ({ recipe_id: "scail.motion", kind: "video" as const, width, height, duration_ms: 4969, work });

  it("is left out of the record a forecast reads, and a part sampled larger than it is filed is kept", () => {
    expect(workOfRow(scail(480 * 864 * 4096), fps)).toBeNull();
    // sampled at 576 × 576 and filed at 384 × 384: 2.25 times its pixels in work, its own all the same
    expect(workOfRow(scail(576 * 576 * 81, 384, 384), fps)).toBe(576 * 576 * 81);
    expect(workOfRow(scail(480 * 864 * 81), fps)).toBe(480 * 864 * 81);
  });
});

describe("a recipe with a render or two of its own", () => {
  it("reads the model's other recipe at its own pace against theirs: klein.edit's second render (25 s said, 74 s taken)", async () => {
    await put(...[1, 2, 3, 4].map(() => pic(1_044_480, 20, 1000, { recipe_id: "klein.picture" })));
    await put(pic(1_044_480, 20, 3509, { recipe_id: "klein.edit", time_key: "e" }));
    const f = (await forecast(db, "m", 1_044_480, 20, false, { recipeId: "klein.edit", timeKey: "e2", samples: true }))!;
    const took = 500 + 20 * 3509 + 1000;
    expect(Math.abs(f.ms - took) / took).toBeLessThan(0.05);
  });
});

describe("a render filed warm that loaded its model all the same", () => {
  const krea = (over: Partial<RenderRow>) => pic(1_048_576, 8, 2000, { recipe_id: "krea2.text-to-picture", family: "krea2", model_file: "gonzalomo", load_ms: 1200, ...over });

  it("is not taken for the model's warm load: krea2 gonzalomo rendered twice (140 s said, 19 to 21 s taken)", async () => {
    // the family's renders in memory, the model's first (cold, two minutes) and one filed warm that loaded it again
    await put(...[1, 2, 3, 4, 5].map(() => krea({ model_file: "other" })), krea({ cold: 1, load_ms: 125_000 }), krea({ load_ms: 120_536 }));
    const f = (await forecast(db, "gonzalomo", 1_048_576, 8, false, { recipeId: "krea2.text-to-picture", family: "krea2", machine: "m1" }))!;
    expect(f.ms).toBeLessThan(25_000);
  });

  it("is filed cold: its load is past three times the model's loads in memory, and 15 s at least", async () => {
    await put(...[1, 2, 3].map(() => krea({})));
    expect(await reloaded(db, "gonzalomo", "m1", 120_000)).toBe(true);
    // a video model's text encoder: 14 s in memory or not
    expect(await reloaded(db, "gonzalomo", "m1", 14_000)).toBe(false);
    // nothing on record of the model in memory on that machine: not told
    expect(await reloaded(db, "gonzalomo", "m2", 120_000)).toBe(false);
    // of two loads, one of them a reload, the quicker says what a load in memory is
    expect(reloadAbove([1200, 120_000])).toBe(15_000);
    expect(reloadAbove([14_000, 15_000, 16_000])).toBe(43_500);

    const recipe = { id: "krea2.text-to-picture", family: "krea2" } as Recipe<any>;
    const timing = { model: "G", modelFile: "gonzalomo", timeKey: "k", cold: false, expectedMs: 20_000, expect: {}, work: 1_048_576 };
    const measured = (loadMs: number) => ({ phases: { loading: loadMs, sampling: 16_000 }, stepMs: 2000, vramPeak: null, heatPeak: null });
    const end = (id: string, loadMs: number) =>
      record(db, { id, created_at: new Date().toISOString() }, recipe, { timing, totalSteps: 8, startedAt: Date.now() }, measured(loadMs), "done", true, loadMs + 17_000, undefined, { machine: "m1", gpu: null });
    await end("reloaded", 120_536);
    await end("held", 1_100);
    const cold = Object.fromEntries((await db.selectFrom("render_stats").select(["id", "cold"]).where("id", "in", ["reloaded", "held"]).execute()).map((r) => [r.id, r.cold]));
    expect(cold).toEqual({ reloaded: 1, held: 0 });
  });
});

describe("renders of the very same form", () => {
  /** H3 windows of 576 × 1024 × 107 frames, 20 steps: the model's others step 7.5 s at that size, those with an end frame 24.6 s. */
  const W = 63_111_168;
  const h3 = (key: string, stepMs: number, work = W) => row({ recipe_id: "h3.video", family: "h3", model_file: "h3", kind: "video", time_key: key, work, steps: 20, step_ms: stepMs, sample_ms: 20 * stepMs, load_ms: 14_000, total_ms: 14_000 + 20 * stepMs + 40_000 });

  it("set the step from two of them on this machine (192 s said, 544 s taken)", async () => {
    await put(...[0.8, 1.2, 0.8, 1.2, 0.8, 1.2].map((k) => h3("plain", 7_500 * k, W * k)), h3("end", 24_573), h3("end", 24_785));
    const f = (await forecast(db, "h3", W, 20, false, { recipeId: "h3.video", timeKey: "end", family: "h3", samples: true, machine: "m1" }))!;
    expect(Math.abs(f.ms - 552_764) / 552_764).toBeLessThan(0.03);
  });

  it("with one of them only, the model's pace stands", async () => {
    await put(...[0.8, 1.2, 0.8, 1.2, 0.8, 1.2].map((k) => h3("plain", 7_500 * k, W * k)), h3("end", 24_573));
    const f = (await forecast(db, "h3", W, 20, false, { recipeId: "h3.video", timeKey: "end", family: "h3", samples: true, machine: "m1" }))!;
    expect(f.ms).toBeLessThan(300_000);
  });
});

describe("what surrounds the steps, read from other settings of the recipe", () => {
  it("is read at the form's size: 8 s of video decode and save longer than 5 s did (27 s → about 43 s)", async () => {
    const five = 576 * 1024 * 121;
    await put(...[1, 2, 3].map(() => row({ recipe_id: "h3.video", family: "h3", model_file: "h3", kind: "video", time_key: "seconds=5", work: five, steps: 8, step_ms: 10_000, sample_ms: 80_000, load_ms: 14_000, total_ms: 14_000 + 80_000 + 27_000 })));
    const eight = 576 * 1024 * 193;
    const f = (await forecast(db, "h3", eight, 8, false, { recipeId: "h3.video", timeKey: "seconds=8", family: "h3", samples: true }))!;
    const around = f.ms - 14_000 - 8 * 10_000 * (eight / five);
    expect(around).toBeGreaterThan(27_000 * 1.5);
    expect(around).toBeLessThan(27_000 * 1.7);
  });
});

describe("the middle of an even count", () => {
  it("is the mean of the two middle values: m2's third SDXL picture (11.6 s said, 6.2 s taken)", async () => {
    // two renders of the same form, one of them slowed: the next one is said between them, not as the slower
    await put(pic(1_011_712, 20, 250, { load_ms: 400, time_key: "s" }), pic(1_011_712, 20, 500, { load_ms: 400, time_key: "s" }));
    const f = (await forecast(db, "m", 1_011_712, 20, false, { recipeId: "sdxl.text-to-picture", timeKey: "s", machine: "m1" }))!;
    expect(f.ms).toBe(400 + 20 * 375 + 1000);
  });

  it("of under three loads in memory, takes the family's on this machine", async () => {
    await put(...[1, 2, 3, 4].map(() => pic(1_011_712, 20, 250, { model_file: "other", load_ms: 300 })), pic(1_011_712, 20, 250, { load_ms: 9_000 }));
    const f = (await forecast(db, "m", 1_011_712, 20, false, { recipeId: "sdxl.text-to-picture", family: "sdxl", machine: "m1" }))!;
    expect(f.ms).toBeLessThan(300 + 20 * 250 + 1000 + 2_000);
  });
});
