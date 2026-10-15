import { describe, expect, it } from "vitest";
import { dryContext, parseInput, type MediaFacts } from "@afflatus/core";
import { recipeById } from "@afflatus/recipes";
import { migrate, openSqlite, OWNER, type Db } from "../src/db";
import { chunksOf, forecast, fromRates, rates, sizedFrom, workOf } from "../src/forecast";

/**
 * What a render's work is (the forecast review of 2026-10-15, F-11, F-12, F-14): the graphs whose nodes say no size are
 * measured from what they sample, a picture redrawn in tiles is priced tile by tile, a count of "all frames" is no frame
 * count, and the fallback says what the machine and the load add.
 */

const build = (id: string, input: Record<string, unknown>, media: Record<string, MediaFacts>, uploads: Record<string, string> = { source: "s.png" }) => {
  const recipe = recipeById(id)!;
  return recipe.build(parseInput(recipe, input) as never, dryContext({ slots: {}, uploads, media }));
};

let n = 0;
async function db(): Promise<Db> {
  const d = openSqlite(":memory:");
  await migrate(d);
  return d;
}
/** A finished render on the record: `steps` at `stepMs`, `load` before them, `rest` after. */
const row = (over: { recipe: string; work: number; steps: number; stepMs: number; load: number; rest?: number; cold?: 0 | 1; machine?: string; model?: string; family?: string }) => ({
  id: `zz-test-${n++}`, owner_id: OWNER, recipe_id: over.recipe, family: over.family ?? "sdxl", model: "M", model_file: over.model ?? "m", time_key: "k",
  kind: "image", width: 1024, height: 1024, duration_ms: null, steps: over.steps, status: "done", whole: 1, cold: over.cold ?? 0, waited_ms: 0,
  total_ms: over.load + over.steps * over.stepMs + (over.rest ?? 1000), load_ms: over.load, sample_ms: 0, refine_ms: over.steps * over.stepMs, finish_ms: over.rest ?? 1000,
  step_ms: over.stepMs, expected_ms: null, vram_peak: null, heat_peak: null, asset_id: null, work: over.work, machine_id: over.machine ?? "m1", gpu: null,
  created_at: new Date(Date.UTC(2026, 9, 1) + n * 1000).toISOString(),
});

describe("a picture redrawn in tiles", () => {
  it("is priced tile by tile: twice the size on each side is four times the tiles at a tile's work each, not sixteen times", async () => {
    const sharper = (side: number) => build("sdxl.sharper", { source: "p", checkpoint: "x.safetensors", upscaler: "u.pth" }, { source: { width: side, height: side } });
    const small = sharper(1216);
    const large = sharper(2432);
    const ws = workOf(small);
    const wl = workOf(large);
    // a tile's work, whatever the picture's size
    expect(ws.pixels).toBe(1024 * 1024);
    expect(wl.pixels).toBe(1024 * 1024);
    expect(wl.steps / ws.steps).toBeCloseTo(36 / 9, 5);
    const d = await db();
    const tileStep = 250;
    await d.insertInto("render_stats").values([1, 2, 3].map(() => row({ recipe: "sdxl.sharper", work: ws.pixels, steps: ws.steps, stepMs: tileStep, load: 500 })) as never).execute();
    const f = await forecast(d, "m", wl.pixels * wl.frames, wl.steps, false, { recipeId: "sdxl.sharper", samples: false, chunks: chunksOf(large, wl.pixels) });
    const truth = 500 + wl.steps * tileStep + 1000;
    // 505 s said where it took 128 s, before
    expect(f!.ms / truth).toBeGreaterThan(0.9);
    expect(f!.ms / truth).toBeLessThan(1.1);
    expect(f!.pace).toBe("usual");
    await d.destroy();
  });

  it("after a hires first pass: the first pass at its own size, then the tiles", () => {
    const built = build("sdxl.text-to-picture", { prompt: "a", checkpoint: "x.safetensors", size: { width: 1024, height: 1024 }, hires: true, hiresScale: 3, tiles: "Tiles", steps: 20, hiresSteps: 10 }, {}, {});
    const chunks = chunksOf(built, workOf(built).pixels)!;
    expect(workOf(built).pixels).toBe(1024 * 1024);
    expect(chunks[0]).toEqual({ work: 1024 * 1024, steps: 20 });
    expect(chunks[1]!.work).toBe(1024 * 1024);
    expect(chunks[1]!.steps).toBe(built.totalSteps - 20);
  });
});

describe("a graph whose nodes say no size", () => {
  it("is measured from what it samples: an edit's canvas with the pictures it reads, a detailer's guide size, a tool's picture", () => {
    const edit = (refs: number) => workOf(build("qwen21.edit", { source: "p", prompt: "a", references: Array.from({ length: refs }, (_, i) => ({ asset: `r${i}`, role: "clothing" })) }, { source: { width: 768, height: 1376 } }, { source: "s.png", "references.0": "a.png", "references.1": "b.png" }));
    expect(edit(0).pixels).toBe(Math.round(768 * 1376 * 1.4));
    expect(edit(2).pixels).toBe(Math.round(768 * 1376 * 2.2));
    const motion = build("qwen21.motion-picture", { source: "f", people: [{ asset: "a", role: "person" }, { asset: "b", role: "person" }] }, { source: { width: 768, height: 1376 } }, { source: "f.png", "people.0": "a.png", "people.1": "b.png" });
    // the first pass reads the frame and both photos; the relight only what the first made
    expect(chunksOf(motion, workOf(motion).pixels)!.map((c) => c.work)).toEqual([Math.round(768 * 1376 * 2.2), Math.round(768 * 1376 * 1.4)]);
    const face = build("sdxl.fix-face", { source: "p", checkpoint: "x.safetensors", detector: "bbox/face.pt" }, { source: { width: 832, height: 1216 } });
    expect(workOf(face).pixels).toBe(1024 * 1024);
    const cut = build("tools.remove-background", { source: "p", model: "b.safetensors" }, { source: { width: 1536, height: 2048 } });
    expect(workOf(cut).pixels).toBe(0);
    expect(workOf(sizedFrom(cut, { source: { width: 1536, height: 2048 } })).pixels).toBe(1536 * 2048);
    // a graph that says its size keeps it
    expect(sizedFrom(face, { source: { width: 4000, height: 4000 } })).toBe(face);
  });

  it("learns from its own renders: a Face detailer with its checkpoint in memory is not told its cold renders' time", async () => {
    const face = build("sdxl.fix-face", { source: "p", checkpoint: "x.safetensors", detector: "bbox/face.pt", steps: 28 }, { source: { width: 832, height: 1216 } });
    const w = workOf(face);
    const d = await db();
    await d.insertInto("render_stats").values([
      row({ recipe: "sdxl.fix-face", work: w.pixels, steps: 28, stepMs: 300, load: 65_000, cold: 1 }),
      row({ recipe: "sdxl.fix-face", work: w.pixels, steps: 28, stepMs: 300, load: 66_000, cold: 1 }),
      row({ recipe: "sdxl.fix-face", work: w.pixels, steps: 28, stepMs: 300, load: 700 }),
    ] as never).execute();
    const f = await forecast(d, "m", w.pixels * w.frames, w.steps, false, { recipeId: "sdxl.fix-face", samples: false });
    // 74 s said, 10 s taken, before
    expect(f!.ms).toBeGreaterThan(9_000);
    expect(f!.ms).toBeLessThan(11_000);
    await d.destroy();
  });
});

describe("a count of every frame", () => {
  it("is no frame count: ImageFromBatch's 4096 is not read as 4096 frames", () => {
    const built = {
      graph: {
        "1": { class_type: "EmptyLatentImage", inputs: { width: 832, height: 480, batch_size: 1 } },
        "2": { class_type: "ImageFromBatch", inputs: { batch_index: 0, length: 4096 } },
        "3": { class_type: "WanVideo", inputs: { num_frames: 81 } },
      },
      phases: {}, outputs: [], totalSteps: 6, loads: [],
    };
    expect(workOf(built).frames).toBe(81);
  });
});

describe("the fallback, for a form no render is placed against", () => {
  it("is the recipe's run at the machine's pace, with its load as it comes: warm, cold, or its family's cold", async () => {
    const d = await db();
    await d.insertInto("render_stats").values([
      row({ recipe: "tools.remove-background", family: "tools", model: "", work: 0, steps: 1, stepMs: 9_000, load: 1_000, rest: 0 }),
      row({ recipe: "tools.remove-background", family: "tools", model: "", work: 0, steps: 1, stepMs: 9_000, load: 1_000, rest: 0 }),
      row({ recipe: "sdxl.text-to-picture", work: 1, steps: 1, stepMs: 1_000, load: 61_000, rest: 0, cold: 1 }),
    ] as never).execute();
    const all = await rates(d);
    const recipe = recipeById("tools.remove-background")!;
    expect(fromRates(all, recipe, {})!.ms).toBe(10_000);
    expect(fromRates(all, recipe, {}, { pace: 2 })!.ms).toBe(19_000);
    // never cold here: its family's cold load (the tools'), else none known: the warm one
    const cold = fromRates(all, recipe, {}, { cold: true })!;
    expect(cold.ms).toBe(10_000);
    const sdxl = fromRates(all, recipeById("sdxl.text-to-picture")!, {}, { cold: true })!;
    expect(sdxl.ms).toBe(62_000);
    await d.destroy();
  });

  it("takes each machine's pace out of what it learns: a pod half as fast does not make every machine's fallback slower", async () => {
    const d = await db();
    const pic = (machine: string, stepMs: number, recipe = "sdxl.text-to-picture", model = "m") => row({ recipe, model, work: 1024 * 1024, steps: 20, stepMs, load: 500, rest: 0, machine });
    // the machines' paces are learned against each other on the same settings (machinePaces): m1, compared on the most
    // renders, is the common pace (1), m2 2, the pod 3
    await d.insertInto("render_stats").values([
      ...[1, 2, 3].flatMap(() => [pic("m1", 1000), pic("m2", 2000), pic("rp-slow", 3000)]),
      pic("m1", 1000),
      ...[1, 2, 3].map(() => pic("rp-slow", 3000, "sdxl.redraw", "m-redraw")),
    ] as never).execute();
    const all = await rates(d);
    const redraw = recipeById("sdxl.redraw")!;
    // rendered on the pod alone: 60 s there is 20 s at the common pace (m1's), 40 s on m2
    expect(fromRates(all, redraw, {})!.ms).toBe(20_000 + 500);
    expect(fromRates(all, redraw, {}, { pace: 2 })!.ms).toBe(40_000 + 500);
    await d.destroy();
  });
});
