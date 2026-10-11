import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeComfy } from "@afflatus/comfy/testing";
import { roughly, timeKey } from "@afflatus/core";
import { forecast } from "../src/forecast";
import { cellOf, digestDays, merge, type RenderRow } from "../src/renderDigests";
import { clear, fold } from "../src/renders";
import { list, summary } from "../src/rendersRead";
import { CHECKPOINT, complete, get, job, makeApp, makeFake, post, until, type TestApp } from "./helpers";

let fake: FakeComfy;
let t: TestApp;

beforeEach(async () => {
  fake = await makeFake();
  t = await makeApp({ comfyUrl: fake.url });
  await t.services.queue.start();
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-02T18:00:00.000Z");
let n = 0;
/** A render on record, as the queue would have written it. */
const row = (over: Partial<RenderRow> & { ago?: number } = {}): RenderRow => {
  const { ago = 0, ...rest } = over;
  return {
    id: `r${n++}`, owner_id: "local", recipe_id: "sdxl.text-to-picture", family: "sdxl", model: "illustrious", model_file: "illustrious", time_key: "steps=28",
    kind: "image", width: 832, height: 1216, duration_ms: null, steps: 28, status: "done", whole: 1, cold: 0, waited_ms: 0,
    total_ms: 20_000, load_ms: 1_000, sample_ms: 16_000, refine_ms: 0, finish_ms: 3_000, step_ms: 570, expected_ms: 20_000,
    vram_peak: 70, heat_peak: 68, asset_id: null, work: 832 * 1216, created_at: new Date(NOW - ago).toISOString(), ...rest,
  };
};
const put = (rows: RenderRow[]) => t.db.insertInto("render_stats").values(rows).execute();
const rendered = async (over: Record<string, unknown> = {}) => {
  const before = fake.prompts.size;
  const id = (await post(t.app, "/api/jobs", job(over))).json().ids[0] as string;
  await until(() => fake.prompts.size === before + 1);
  complete(fake, [...fake.prompts.keys()].at(-1)!);
  await until(async () => (await t.db.selectFrom("jobs").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status === "done");
  // its record is written after the job is said done
  await t.services.queue.idle();
  return id;
};
const recordOf = (id: string) => t.db.selectFrom("render_stats").selectAll().where("id", "=", id).executeTakeFirst();

describe("a render is put on record", () => {
  it("with what it was made with, how long it took, and whether its model had to load", async () => {
    const first = await rendered({ steps: 20 });
    const a = (await recordOf(first))!;
    expect(a).toMatchObject({ recipe_id: "sdxl.text-to-picture", family: "sdxl", model: "illustrious", model_file: "illustrious", status: "done", kind: "image", width: 832, height: 1216, steps: 20, whole: 1, cold: 1 });
    expect(a.time_key).toContain("steps=20");
    expect(a.asset_id).toBe((await get(t.app, "/api/assets")).json().items[0].id);
    // the parts add up to the whole
    expect(a.load_ms + a.sample_ms + a.refine_ms + a.finish_ms).toBe(a.total_ms);
    // nothing was known before the first render
    expect(a.expected_ms).toBeNull();

    // the same model again: nothing to load, and now there is something to expect it by
    const b = (await recordOf(await rendered({ steps: 20, prompt: "a dog" })))!;
    expect(b).toMatchObject({ cold: 0, model_file: "illustrious" });
    expect(b.expected_ms).not.toBeNull();
    // another model: it loads first
    expect((await recordOf(await rendered({ checkpoint: "other.safetensors" })))!).toMatchObject({ cold: 1, model_file: "other" });
  });

  it("when it is stopped while it renders, as stopped; what never reached ComfyUI is not a render", async () => {
    const id = (await post(t.app, "/api/jobs", job())).json().ids[0] as string;
    await until(() => fake.prompts.size === 1);
    await post(t.app, `/api/jobs/${id}/cancel`);
    await until(async () => (await t.db.selectFrom("jobs").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status === "cancelled");
    await until(async () => Boolean(await recordOf(id)));
    expect((await recordOf(id))!).toMatchObject({ status: "cancelled", kind: null, asset_id: null });

    // a checkpoint ComfyUI does not have: refused before anything is sent
    const refused = (await post(t.app, "/api/jobs", job({ checkpoint: "missing.safetensors" }))).json().ids?.[0] as string | undefined;
    if (refused) {
      await until(async () => (await t.db.selectFrom("jobs").select("status").where("id", "=", refused).executeTakeFirstOrThrow()).status === "failed");
      expect(await recordOf(refused)).toBeUndefined();
    }
  });
});

describe("figures of several renders", () => {
  it("the usual one is the middle of those whose model was loaded; the slow ones, the load and the peaks are told apart", () => {
    const c = cellOf([
      row({ total_ms: 20_000 }), row({ total_ms: 22_000 }), row({ total_ms: 24_000 }),
      row({ total_ms: 61_000, cold: 1, load_ms: 40_000, vram_peak: 96, heat_peak: 81 }),
      row({ status: "failed", total_ms: 9_000, kind: null }), row({ status: "cancelled", total_ms: 4_000, kind: null }),
      row({ kind: "video", duration_ms: 5_000, total_ms: 120_000, waited_ms: 30_000, expected_ms: 100_000 }),
    ]);
    expect(c).toMatchObject({ renders: 7, done: 5, failed: 1, cancelled: 1, cold: 1, images: 4, videos: 1, videoMs: 5_000, lostMs: 13_000, longestMs: 120_000 });
    expect(c.totalMs).toBe(20_000 + 22_000 + 24_000 + 61_000 + 9_000 + 4_000 + 120_000);
    // the middle of the four that did not load: 20, 22, 24, 120
    expect(c.usualMs).toBe(24_000);
    expect(c.coldMs).toBe(61_000);
    expect(c.loadUsualMs).toBe(40_000);
    expect(c.vramPeak).toBe(96);
    expect(c.heatPeak).toBe(81);
    expect(c.waitedSlowMs).toBe(30_000);
  });

  it("put together: sums add up, a usual is the middle of the usuals, each counted for its renders", () => {
    const a = cellOf([row({ total_ms: 10_000 }), row({ total_ms: 10_000 }), row({ total_ms: 10_000 })]);
    const b = cellOf([row({ total_ms: 50_000 })]);
    const both = merge([a, b]);
    expect(both).toMatchObject({ renders: 4, done: 4, totalMs: 80_000, usualMs: 10_000, longestMs: 50_000 });
    expect(merge([b, b, b, b, a]).usualMs).toBe(50_000);
  });
});

describe("renders older than they are kept become figures per model and day", () => {
  it("folds in one go: two folds at the same moment count no row twice", async () => {
    await put([row({ ago: 100 * DAY, total_ms: 30_000 }), row({ ago: 100 * DAY + 3_600_000, total_ms: 34_000 }), row({ ago: 95 * DAY })]);
    const [a, b] = await Promise.all([fold(t.db, 90, NOW), fold(t.db, 90, NOW)]);
    expect(a + b).toBe(3);
    const days = await t.db.selectFrom("render_days").selectAll().where("recipe_id", "=", "*").orderBy("day").execute();
    expect(days.map((d) => JSON.parse(d.figures).renders)).toEqual([2, 1]);
  });

  it("only whole days go; the day's figures, and the day as a whole, stay for good", async () => {
    await put([
      row({ ago: 100 * DAY, total_ms: 30_000 }), row({ ago: 100 * DAY + 3_600_000, total_ms: 34_000 }),
      row({ ago: 100 * DAY, recipe_id: "wan.video", family: "wan", model: "wan-high", model_file: "wan-high", kind: "video", duration_ms: 5_000, total_ms: 130_000 }),
      row({ ago: 95 * DAY, total_ms: 21_000 }),
      row({ ago: 10 * DAY }), row({ ago: 0 }),
    ]);
    expect(await fold(t.db, 0, NOW)).toBe(0);
    expect(await fold(t.db, 90, NOW)).toBe(4);
    expect((await t.db.selectFrom("render_stats").selectAll().execute()).length).toBe(2);
    const days = await t.db.selectFrom("render_days").selectAll().orderBy("day").orderBy("recipe_id").execute();
    expect(days.map((d) => `${d.day} ${d.recipe_id} ${d.model_file}`)).toEqual([
      "2026-06-24 * ", "2026-06-24 sdxl.text-to-picture illustrious", "2026-06-24 wan.video wan-high", "2026-06-29 * ", "2026-06-29 sdxl.text-to-picture illustrious",
    ]);
    expect(JSON.parse(days[1]!.figures)).toMatchObject({ renders: 2, done: 2, totalMs: 64_000, usualMs: 34_000 });
    expect(JSON.parse(days[0]!.figures)).toMatchObject({ renders: 3, images: 2, videos: 1, videoMs: 5_000 });
    // nothing more to fold
    expect(await fold(t.db, 90, NOW)).toBe(0);

    // the charts still reach back: rows and folded days in one view
    const all = await summary(t.db, t.services.registry, "all", 90, NOW);
    expect(all.tiles).toMatchObject({ done: 6, images: 5, videos: 1 });
    expect(all.times.length).toBeGreaterThanOrEqual(101);
    expect(all.finished.images.reduce((a, b) => a + b, 0)).toBe(5);
    expect(all.models.map((m) => [m.key, m.renders])).toEqual([["wan.video", 1], ["sdxl.text-to-picture", 5]]);
  });
});

describe("what the tab shows", () => {
  it("a period cut into stretches, with the models by the GPU time they took", async () => {
    await put([
      row({ ago: 2 * 3_600_000 }), row({ ago: 2 * 3_600_000 + 60_000, total_ms: 24_000 }), row({ ago: 30 * 3_600_000, cold: 1, load_ms: 9_000, total_ms: 28_000 }),
      row({ ago: 3 * 3_600_000, recipe_id: "wan.video", family: "wan", model: "wan-high + wan-low", model_file: "wan-high", time_key: "seconds=5", kind: "video", duration_ms: 5_000, width: 480, height: 832, steps: 4, total_ms: 130_000, load_ms: 40_000, sample_ms: 70_000, finish_ms: 20_000, step_ms: 19_000, cold: 1, vram_peak: 95, heat_peak: 77 }),
      row({ ago: 3 * 3_600_000 - 200_000, recipe_id: "wan.video", family: "wan", model: "wan-high + wan-low", model_file: "wan-high", time_key: "seconds=5", kind: "video", duration_ms: 5_000, width: 480, height: 832, steps: 4, total_ms: 92_000, load_ms: 2_000, sample_ms: 70_000, finish_ms: 20_000, step_ms: 21_000 }),
      row({ ago: 3_600_000, status: "failed", kind: null, total_ms: 7_000 }),
    ]);
    const week = await summary(t.db, t.services.registry, "week", 90, NOW);
    expect(week.times).toHaveLength(28);
    expect(week.step).toBe(6 * 3_600_000);
    expect(week.tiles).toMatchObject({ done: 5, images: 3, videos: 2, failed: 1, cancelled: 0, loads: 2, lostMs: 7_000, videoMs: 10_000, vramPeak: 95, heatPeak: 77 });
    expect(week.models.map((m) => m.key)).toEqual(["wan.video", "sdxl.text-to-picture"]);
    const wan = week.models[0]!;
    expect(wan).toMatchObject({ name: "Wan 2.2 · Video", renders: 2, usualMs: 92_000, gpuMs: 222_000, kind: "video" });
    // what the button will say, spelled out for the setting used most
    expect(wan.setting).toMatchObject({ width: 480, height: 832, seconds: 5, steps: 4, samples: 2, warmMs: 92_000, loadMs: 38_000 });
    expect(wan.files).toHaveLength(1);
    expect(wan.files[0]).toMatchObject({ file: "wan-high", renders: 2 });
    // its pace against its own usual, where it rendered
    expect(wan.pace.filter((v) => v !== null).length).toBe(1);
    expect(week.finished.bad.reduce((a, b) => a + b, 0)).toBe(1);
    expect(week.phases.sampling.reduce((a, b) => a + b, 0)).toBe(16_000 * 4 + 70_000 * 2);

    const day = await summary(t.db, t.services.registry, "day", 90, NOW);
    expect(day.times).toHaveLength(24);
    expect(day.tiles.done).toBe(4);
  });

  it("all of it the same a moment later: the stretch the figures cover is in whole minutes, so the page's copy is still current (304)", async () => {
    // a record of weeks: "all" is cut into whole days, and nothing else of it moves within the day
    await put([row({ ago: 20 * DAY }), row({ ago: 3_600_000 })]);
    const now = await summary(t.db, t.services.registry, "all", 90, NOW);
    const later = await summary(t.db, t.services.registry, "all", 90, NOW + 1_234);
    expect(later.spanMs % 60_000).toBe(0);
    expect(JSON.stringify(later)).toBe(JSON.stringify(now));
  });

  it("the stretch the figures cover is to the minute: a first render 1 h 29 min ago leaves the GPU busy under 100 %, and the stretch the same a moment later", async () => {
    // the first render on record, 80 min of GPU time ending 1 h 29 min ago
    await put([row({ ago: 89 * 60_000, total_ms: 80 * 60_000 })]);
    const now = await summary(t.db, t.services.registry, "day", 90, NOW);
    expect(now.spanMs).toBe(89 * 60_000);
    expect(now.tiles.gpuMs / now.spanMs).toBeLessThanOrEqual(1);
    // the last day moves with the clock, but the stretch said does not move with every call
    expect((await summary(t.db, t.services.registry, "day", 90, NOW + 1_234)).spanMs).toBe(now.spanMs);
  });

  it("the period before as long for the headline's change, the failures out of memory per model, the video length per stretch", async () => {
    await put([
      row({ ago: 3_600_000 }), row({ ago: 2 * 3_600_000, kind: "video", duration_ms: 5_000 }),
      row({ ago: 3 * 3_600_000, status: "failed", kind: null, total_ms: 9_000, vram_peak: 99 }),
      row({ ago: 4 * 3_600_000, status: "failed", kind: null, total_ms: 4_000, vram_peak: 60 }),
      // the day before: the prior period
      row({ ago: DAY + 3_600_000, total_ms: 50_000 }), row({ ago: DAY + 2 * 3_600_000, total_ms: 30_000 }),
      // two days back: in neither
      row({ ago: 2 * DAY + 3_600_000 }),
    ]);
    const day = await summary(t.db, t.services.registry, "day", 90, NOW);
    expect(day.prior).toMatchObject({ gpuMs: 80_000, done: 2, failed: 0 });
    // no job left to say why it failed: a full memory alone is not counted as out of memory
    expect(day.tiles.oom).toBe(0);
    expect(day.models[0]).toMatchObject({ failed: 2, oom: 0, lostMs: 13_000 });
    expect(day.finished.videoMs.reduce((a, b) => a + b, 0)).toBe(5_000);
    // nothing before the record starts: no change to say
    expect((await summary(t.db, t.services.registry, "week", 90, NOW)).prior).toBeNull();
    expect((await summary(t.db, t.services.registry, "all", 90, NOW)).prior).toBeNull();
    expect((await list(t.db, t.services.registry, { trouble: true })).items.map((i) => i.oom)).toEqual([false, false]);
  });

  it("the failures and stops that never reached ComfyUI count too, as the Queue lists them; a job that rendered counts once", async () => {
    const jobAt = (id: string, status: "failed" | "cancelled" | "done", ago: number, warm = 0) => {
      const at = new Date(NOW - ago).toISOString();
      return {
        id, owner_id: "local", recipe_id: "sdxl.text-to-picture", label: "zz-test", inputs: "{}", status, warm, look: null, priority: 0, depends_on: null,
        attempts: 0, resume: null, error: status === "failed" ? "this cannot run on your ComfyUI" : null, generation_id: null, clip_id: null, clip_fit: 0,
        draft_id: null, folder_id: null, finished_from: null, created_at: at, started_at: null, finished_at: at, updated_at: at,
      };
    };
    // one failure on record (it ran on ComfyUI), and its job: counted once
    // (and a render two days back, so that the record reaches over the period before)
    await put([row({ id: "ran", ago: 3_600_000, status: "failed", kind: null, total_ms: 7_000 }), row({ ago: 2 * DAY + 3_600_000 })]);
    await t.db.insertInto("jobs").values([
      jobAt("ran", "failed", 3_600_000),
      // refused before it was sent, twice, and stopped while it waited
      jobAt("refused1", "failed", 2 * 3_600_000), jobAt("refused2", "failed", 5 * 3_600_000), jobAt("waited", "cancelled", 3_600_000),
      // a warm-up only loads models: not in the history, not counted; a failure the day before is the prior period's
      jobAt("warm", "failed", 3_600_000, 1), jobAt("yesterday", "failed", DAY + 3_600_000),
      // older than the rows are kept: a folded day keeps no job ids, so it is left out rather than counted twice
      jobAt("old", "failed", 100 * DAY),
    ]).execute();
    const day = await summary(t.db, t.services.registry, "day", 90, NOW);
    expect(day.tiles).toMatchObject({ failed: 3, cancelled: 1, unsent: { failed: 2, cancelled: 1 }, lostMs: 7_000 });
    expect(day.finished.bad.reduce((a, b) => a + b, 0)).toBe(4);
    expect(day.prior).toMatchObject({ failed: 1 });
    expect((await summary(t.db, t.services.registry, "all", 90, NOW)).tiles.failed).toBe(4);
  });

  it("the renders one by one, newest first, a page at a time, or only those that went wrong", async () => {
    await put(Array.from({ length: 7 }, (_x, i) => row({ ago: i * 60_000, status: i === 3 ? "failed" : "done" })));
    const first = await list(t.db, t.services.registry, { limit: 5 });
    expect(first).toMatchObject({ total: 7, more: true });
    expect(first.items).toHaveLength(5);
    expect(first.items[0]).toMatchObject({ name: "SDXL · txt2img", status: "done", phases: { loading: 1_000, sampling: 16_000, refining: 0, finishing: 3_000 }, cold: false });
    const next = await list(t.db, t.services.registry, { limit: 5, before: first.items.at(-1)!.at });
    expect(next.items).toHaveLength(2);
    expect(next.more).toBe(false);
    expect((await list(t.db, t.services.registry, { trouble: true })).items.map((i) => i.status)).toEqual(["failed"]);
    expect((await get(t.app, "/api/renders?only=trouble")).json().total).toBe(1);
    expect((await get(t.app, "/api/renders/summary?period=month")).json().tiles.done).toBe(6);
    expect((await get(t.app, "/api/renders/size")).json()).toMatchObject({ renders: 7, days: 0 });
    expect((await t.app.inject({ method: "DELETE", url: "/api/renders" })).statusCode).toBe(200);
    expect((await get(t.app, "/api/renders")).json().total).toBe(0);
  });
});

describe("a summary cut into days reads the days over from their digests", () => {
  /** Two months of renders of every sort, the same each run: recipes, model files, endings, loads, spills, upscales and hires passes. */
  const history = (): RenderRow[] => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
    const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
    const kinds = [
      { recipe_id: "sdxl.text-to-picture", family: "sdxl", kind: "image" as const, files: ["illustrious", "pony"], keys: ["steps=28", "steps=28;hires=true", "steps=40"] },
      { recipe_id: "wan.video", family: "wan", kind: "video" as const, files: ["wan-high"], keys: ["seconds=5", "seconds=3"] },
      { recipe_id: "tool.finish.rtx", family: "tools", kind: "video" as const, files: [""], keys: ["scale=2"] },
      { recipe_id: "tools.upscale", family: "tools", kind: "image" as const, files: ["4x-ultra"], keys: ["scale=2"] },
    ];
    const rows: RenderRow[] = [];
    for (let day = 0; day < 62; day++) {
      for (let k = Math.floor(rand() * 9); k > 0; k--) {
        const what = pick(kinds);
        const status = pick(["done", "done", "done", "done", "failed", "cancelled"] as const);
        const total = Math.round(5_000 + rand() * 300_000);
        rows.push(row({
          id: `zz-test-${rows.length}`, ago: day * DAY + Math.floor(rand() * DAY), recipe_id: what.recipe_id, family: what.family, kind: status === "done" ? what.kind : pick([what.kind, null]),
          model: `zz ${pick(what.files)}`, model_file: pick(what.files), time_key: pick(what.keys), width: pick([512, 832, null]), height: pick([768, 1216]),
          duration_ms: what.kind === "video" ? pick([3_000, 5_000]) : null, status, whole: rand() < 0.9 ? 1 : 0, cold: rand() < 0.2 ? 1 : 0, waited_ms: Math.round(rand() * 60_000),
          total_ms: total, load_ms: Math.round(rand() * 20_000), sample_ms: Math.round(total * 0.6), refine_ms: pick([0, Math.round(total * 0.2)]), finish_ms: Math.round(total * 0.1),
          step_ms: rand() < 0.2 ? null : rand() * 900, expected_ms: rand() < 0.2 ? null : Math.round(total * (0.3 + rand())), vram_peak: rand() < 0.2 ? null : 50 + rand() * 50, heat_peak: 60 + rand() * 20,
        }));
      }
    }
    return rows;
  };
  const periods: Array<Parameters<typeof summary>[2]> = ["day", "week", "month", "all", { from: NOW - 3 * DAY, to: NOW - DAY }, { from: NOW - 45 * DAY, to: NOW - 5 * DAY }];
  const answers = async () => {
    const all: string[] = [];
    for (const p of periods) all.push(JSON.stringify(await summary(t.db, t.services.registry, p, 90, NOW)));
    return all;
  };
  /** The same summaries worked out from the rows alone, the digests set aside and put back after. */
  const fromRows = async () => {
    const kept = await t.db.selectFrom("render_digests").selectAll().execute();
    await t.db.deleteFrom("render_digests").execute();
    const all = await answers();
    if (kept.length) await t.db.insertInto("render_digests").values(kept).execute();
    return all;
  };
  const digested = async () => (await t.db.selectFrom("render_digests").select("day").orderBy("day").execute()).map((d) => d.day);

  it("to the same byte as from the rows, with folded days, a render late into a day digested, and a fold of digested days", async () => {
    await put(history());
    // the fold digests the days over, up to the day before NOW's
    await fold(t.db, 90, NOW);
    const days = await digested();
    expect(days.length).toBeGreaterThan(40);
    expect(days.at(-1)! < "2026-10-02").toBe(true);
    // a day's digest is read, not worked out again: a digest changed by hand shows
    const expected = await fromRows();
    expect(await answers()).toEqual(expected);
    // every part of the answer has something in it
    const all = JSON.parse(expected[3]!) as Awaited<ReturnType<typeof summary>>;
    expect(all.tiles.spills && all.tiles.tools && all.models.length === 4 && all.models.every((m) => m.setting && m.trend.length === 24)).toBeTruthy();
    expect([...all.upscale.video, ...all.upscale.pictures].map((u) => u.key)).toEqual(["tool.finish.rtx", "tools.upscale", "hires"]);
    const one = await t.db.selectFrom("render_digests").selectAll().where("day", "=", days.at(-1)!).executeTakeFirstOrThrow();
    await t.db.updateTable("render_digests").set({ digest: JSON.stringify({ ...JSON.parse(one.digest), tools: 1000 }) }).where("day", "=", one.day).execute();
    expect((await summary(t.db, t.services.registry, "all", 90, NOW)).tiles.tools).toBeGreaterThan(1000);
    await t.db.updateTable("render_digests").set({ digest: one.digest }).where("day", "=", one.day).execute();

    // a render written into a day digested already (the clock set back): that day is digested again
    const late = row({ id: "zz-test-late", ago: 10 * DAY, recipe_id: "wan.video", family: "wan", kind: "video", model_file: "wan-high", duration_ms: 5_000, total_ms: 400_000 });
    await put([late]);
    await digestDays(t.db, NOW, late.created_at.slice(0, 10));
    expect(await answers()).toEqual(await fromRows());

    // older days fold: their digests go with their rows, and the charts read their figures instead
    await fold(t.db, 30, NOW);
    expect((await digested())[0]! >= new Date(NOW - 30 * DAY).toISOString().slice(0, 10)).toBe(true);
    expect(await answers()).toEqual(await fromRows());

    // forgetting every render time forgets the digests too
    await clear(t.db);
    expect(await digested()).toEqual([]);
  });

  it("a render on record digests the days over that were not yet", async () => {
    await put([row({ id: "zz-test-before", ago: NOW - Date.now() + 2 * DAY })]);
    expect(await digested()).toEqual([]);
    await rendered();
    expect(await digested()).toEqual([new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10)]);
  });
});

describe("the next render's time is forecast from the record", () => {
  it("the words, the seed and the files do not change the key; the steps, the size and what it is handed do", () => {
    const recipe = t.services.registry.recipe("sdxl.text-to-picture")!;
    const base = { prompt: "a", checkpoint: CHECKPOINT };
    const key = timeKey(recipe.inputs, base);
    expect(timeKey(recipe.inputs, { ...base, prompt: "something else", seed: 5, checkpoint: "other.safetensors" })).toBe(key);
    expect(timeKey(recipe.inputs, { ...base, steps: 40 })).not.toBe(key);
    expect(timeKey(recipe.inputs, { ...base, hires: true })).not.toBe(key);
    expect(timeKey(recipe.inputs, { ...base, size: { width: 1536, height: 1536 } })).not.toBe(key);
  });

  it("what waits says what it will take, with the load when its model is not the one before it", async () => {
    const recipe = t.services.registry.recipe("sdxl.text-to-picture")!;
    const key = timeKey(recipe.inputs, { prompt: "a", checkpoint: CHECKPOINT });
    await put([row({ time_key: key, total_ms: 20_000 }), row({ time_key: key, total_ms: 50_000, load_ms: 31_000, cold: 1 }), row({ time_key: key, model: "other", model_file: "other", total_ms: 60_000, load_ms: 41_000, cold: 1 })]);
    await rendered();
    await post(t.app, "/api/queue/pause");
    await post(t.app, "/api/jobs", job({ prompt: "one" }));
    await post(t.app, "/api/jobs", job({ prompt: "two", checkpoint: "other.safetensors" }));
    await post(t.app, "/api/jobs", job({ prompt: "three", checkpoint: "other.safetensors" }));
    // the queue keeps what it learned for half a minute: a fresh one reads it now
    const fresh = await makeApp({ db: t.db, dir: t.dir, comfyUrl: fake.url });
    const waiting = (await get(fresh.app, "/api/queue")).json().waiting.map((w: { estimateMs: number }) => w.estimateMs);
    fresh.services.queue.stop();
    await fresh.app.close();
    // the loaded model: no load. Another one: its load, once.
    expect(waiting[0]).toBeLessThan(25_000);
    expect(waiting[1]).toBeGreaterThan(waiting[2]);
    expect(waiting[1] - waiting[2]).toBeGreaterThan(25_000);
  });

  it("is the one figure the form's Output line and its Generate button say, the load counted once for a batch", async () => {
    const recipe = t.services.registry.recipe("sdxl.text-to-picture")!;
    const key = timeKey(recipe.inputs, { prompt: "a", checkpoint: CHECKPOINT });
    await put([row({ time_key: key, total_ms: 20_000 }), row({ time_key: key, model: "other", model_file: "other", total_ms: 60_000, load_ms: 41_000, cold: 1 })]);
    await rendered();
    const advice = async (over: Record<string, unknown>) => (await post(t.app, "/api/advice", job(over))).json().estimate as { text: string; ms: number; loadMs: number };
    // the model in memory: nothing to load; the line says the figure the button rounds the same way
    const held = await advice({});
    expect(held.loadMs).toBe(0);
    expect(held.text).toContain(`About ${roughly(held.ms)},`);
    // another model: its load is in the figure, and said apart so that a batch loads it once
    const other = await advice({ checkpoint: "other.safetensors" });
    expect(other.loadMs).toBe(41_000);
    expect(other.ms).toBeGreaterThan(other.loadMs);
    expect(other.text).toContain(`About ${roughly(other.ms)},`);
  });
});

describe("the forecast reads the renders like the form", () => {
  it("prices an upscale from the model's upscales, not from its txt2img, with what surrounds its steps from the same settings", async () => {
    // txt2img: 1 MP, 28 steps of 500 ms. The sharper pass of the same model: 4 MP re-sampled in tiles, 10 steps of 4 s, no sampling of its own
    await put([
      ...Array.from({ length: 4 }, () => row({ work: 1e6, steps: 28, step_ms: 500, total_ms: 20_000 })),
      ...Array.from({ length: 3 }, () => row({ recipe_id: "sdxl.sharper", time_key: "by=2", work: 4e6, steps: 10, step_ms: 4_000, sample_ms: 0, refine_ms: 52_000, finish_ms: 7_000, total_ms: 60_000 })),
    ]);
    const like = { recipeId: "sdxl.sharper", timeKey: "by=2", family: "sdxl", samples: false };
    const sharper = (await forecast(t.db, "illustrious", 4e6, 10, false, like))!;
    // its steps, what its renders took beyond them (the pass after is not counted twice), the text it encodes first
    expect(sharper.ms).toBe(10 * 4_000 + (60_000 - 1_000 - 40_000) + 1_000);
    // read among the model's txt2img renders, it was off by far
    expect(Math.abs((await forecast(t.db, "illustrious", 4e6, 10, false))!.ms - 60_000)).toBeGreaterThan(12_000);
    // txt2img still reads its own
    expect((await forecast(t.db, "illustrious", 1e6, 28, false, { recipeId: "sdxl.text-to-picture", timeKey: "steps=28", samples: true }))!.ms).toBe(20_000);
  });

  it("reads the renders recorded with one frame of a video with their frames, and leaves the rows as they were", async () => {
    // continuations recorded before their frames were read: the work of one 576 × 1024 frame, a clip of 141 frames
    const old = () => row({ recipe_id: "h3.video", family: "h3", model_file: "h3", kind: "video", width: 576, height: 1024, duration_ms: 5854, work: 576 * 1024, steps: 8, step_ms: 15_000, total_ms: 150_000 });
    await put([old(), old(), old()]);
    const fps = (id: string) => (id === "h3.video" ? 24 : undefined);
    const f = (await forecast(t.db, "h3", 576 * 1024 * 141, 8, false, { recipeId: "h3.video", fps }))!;
    expect(f.ms).toBe(150_000);
    expect(f.pace).toBe("usual");
    expect((await t.db.selectFrom("render_stats").select("work").where("model_file", "=", "h3").execute()).map((r) => r.work)).toEqual([576 * 1024, 576 * 1024, 576 * 1024]);
    // the speed not known: those rows say nothing rather than a hundred times too much
    expect(await forecast(t.db, "h3", 576 * 1024 * 141, 8, false, { recipeId: "h3.video" })).toBeNull();
  });

  it("with the model to load and none of its renders loaded cold, takes the family's load: never less than with the model in memory", async () => {
    await put([row(), row(), row({ model: "other", model_file: "other", total_ms: 60_000, load_ms: 41_000, cold: 1 })]);
    const warm = (await forecast(t.db, "illustrious", 832 * 1216, 28, false, { family: "sdxl" }))!;
    const cold = (await forecast(t.db, "illustrious", 832 * 1216, 28, true, { family: "sdxl" }))!;
    expect(cold.loadMs).toBe(40_000);
    expect(cold.ms).toBe(warm.ms + 40_000);
    // no family's either: any model's
    expect((await forecast(t.db, "illustrious", 832 * 1216, 28, true, { family: "nope" }))!.loadMs).toBe(40_000);
  });
});

describe("the figures as Prometheus reads them", () => {
  it("counters from the record, folded days included, and gauges of what is going on", async () => {
    await put([row({ total_ms: 20_000 }), row({ total_ms: 50_000, cold: 1, load_ms: 31_000 }), row({ status: "failed", kind: null, total_ms: 7_000 }), row({ ago: 100 * DAY, total_ms: 30_000 })]);
    await fold(t.db, 90, NOW);
    const res = await get(t.app, "/metrics");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    const body = res.body;
    expect(body).toContain('afflatus_renders_total{recipe="sdxl.text-to-picture",family="SDXL",title="txt2img",status="done"} 3');
    expect(body).toContain('afflatus_renders_total{recipe="sdxl.text-to-picture",family="SDXL",title="txt2img",status="failed"} 1');
    expect(body).toContain('afflatus_render_model_loads_total{recipe="sdxl.text-to-picture",family="SDXL",title="txt2img"} 1');
    expect(body).toContain('afflatus_render_seconds_total{recipe="sdxl.text-to-picture",family="SDXL",title="txt2img",phase="loading"} 34');
    expect(body).toContain('afflatus_render_duration_seconds_bucket{recipe="sdxl.text-to-picture",family="SDXL",title="txt2img",le="40"} 2');
    expect(body).toContain('afflatus_render_duration_seconds_bucket{recipe="sdxl.text-to-picture",family="SDXL",title="txt2img",le="+Inf"} 3');
    expect(body).toContain('afflatus_render_duration_seconds_sum{recipe="sdxl.text-to-picture",family="SDXL",title="txt2img"} 100');
    expect(body).toMatch(/afflatus_queue_jobs\{state="queued"\} 0/);
    expect(body).toMatch(/afflatus_comfy_online 1/);
  });

  it("name an imported workflow by a hash when asked by a name that is not the server's own: its id and title are the user's words", async () => {
    await put([row(), row({ recipe_id: "workflow.zz-test-my-secret-scene", family: "workflow" })]);
    const own = (await get(t.app, "/metrics")).body;
    expect(own).toContain('recipe="workflow.zz-test-my-secret-scene"');
    // a scraper asks by the pod's address; a page that pointed its own name at this machine looks the same
    const foreign = await get(t.app, "/metrics", { host: "10.1.2.3:8720" });
    expect(foreign.statusCode).toBe(200);
    expect(foreign.body).not.toContain("secret");
    expect(foreign.body).toMatch(/afflatus_renders_total\{recipe="workflow-[0-9a-f]{10}",title="workflow-[0-9a-f]{10}",status="done"\} 1/);
    // the built-in recipes keep their names: they are Afflatus's own
    expect(foreign.body).toContain('afflatus_renders_total{recipe="sdxl.text-to-picture",family="SDXL",title="txt2img",status="done"} 1');
  });
});
