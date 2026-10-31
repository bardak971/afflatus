import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OWN_MODEL, parseInput } from "@afflatus/core";
import { recipeById } from "@afflatus/recipes";
import { newId, now, OWNER } from "../src/db";
import { newAssetRow } from "../src/media";
import { filesAsked } from "../src/machineScans";
import { toolNeeds } from "../src/queueTools";
import { CUT_JOB } from "../src/timelineModel";
import { makeApp, type TestApp } from "./helpers";

/**
 * Card #159: the models a clip is finished with, picked in Finish (SeedVR2's, Face refine's, H3's latent upscaler) and in the
 * forms (Face refine's own model, never a file). Rows put in by hand: nothing is rendered.
 */

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

async function video(): Promise<string> {
  const id = newId();
  await t.db.insertInto("assets").values(newAssetRow({
    id, kind: "video", origin: "cut", name: "zz-test clip.mp4", file_key: `assets/${id.slice(0, 2)}/${id}.mp4`, thumb_key: null, mime: "video/mp4", bytes: 1000,
    width: 192, height: 320, duration_ms: 3000, fps: 24, has_sound: 1, folder_id: null, generation_id: null, kept_at: now(),
  })).execute();
  return id;
}
async function clipWithTake(timeline: string): Promise<{ clip: string; take: string }> {
  const clip = (await t.app.inject({ method: "POST", url: `/api/timelines/${timeline}/clips`, payload: { recipe: "scail.motion24" } })).json().clip as string;
  const take = newId();
  await t.db.insertInto("takes").values({ id: take, clip_id: clip, asset_id: await video(), head_ms: 0, tail_ms: 0, trim_start_ms: 0, trim_end_ms: 0, prev_take_id: null, prev_at_ms: null, next_take_id: null, next_at_ms: null, finished_from: null, created_at: now() }).execute();
  await t.db.updateTable("clips").set({ take_id: take }).where("id", "=", clip).execute();
  return { clip, take };
}
const jobInputs = async (ids: string[]) => (await t.db.selectFrom("jobs").select(["inputs", "recipe_id"]).where("id", "in", ids).execute()).map((r) => ({ recipe: r.recipe_id, ...JSON.parse(r.inputs) }));

describe("Finish › SeedVR2 model", () => {
  it("restores with the model picked, and sends a pod that file with the family's VAE", async () => {
    const tl = (await t.app.inject({ method: "POST", url: "/api/timelines", payload: { name: "zz-test finish models" } })).json();
    await clipWithTake(tl.id);
    const res = await t.app.inject({ method: "POST", url: `/api/timelines/${tl.id}/finish`, payload: { route: "seedvr", factor: 2, seedvrModel: "seedvr2_7b_int8.safetensors" } });
    expect(res.statusCode).toBe(200);
    const [job] = await jobInputs(res.json().jobs);
    expect(job).toMatchObject({ recipe: CUT_JOB, route: "seedvr", seedvrModel: "seedvr2_7b_int8.safetensors" });
    const row = (await t.db.selectFrom("jobs").selectAll().where("id", "=", res.json().jobs[0]).executeTakeFirstOrThrow());
    expect(await toolNeeds(t.services as never, row as never)).toMatchObject({ seedvr: true, seedvrModel: "seedvr2_7b_int8.safetensors" });
  });

  it("left as Settings › Models has it, sends no model of its own: a finish made before keeps its key", async () => {
    const tl = (await t.app.inject({ method: "POST", url: "/api/timelines", payload: { name: "zz-test finish models" } })).json();
    const { clip, take } = await clipWithTake(tl.id);
    const res = await t.app.inject({ method: "POST", url: `/api/timelines/${tl.id}/finish`, payload: { route: "seedvr", factor: 2, seedvrModel: "" } });
    const [job] = await jobInputs(res.json().jobs);
    expect(job).not.toHaveProperty("seedvrModel");
    // done with these settings before the model could be picked: Changed leaves it
    const at = new Date(Date.now() + 1000).toISOString();
    await t.db.updateTable("jobs").set({ status: "done", finished_at: at, updated_at: at }).where("id", "in", res.json().jobs).execute();
    const done = newId();
    await t.db.insertInto("takes").values({ id: done, clip_id: clip, asset_id: await video(), head_ms: 0, tail_ms: 0, trim_start_ms: 0, trim_end_ms: 0, prev_take_id: null, prev_at_ms: null, next_take_id: null, next_at_ms: null, finished_from: take, created_at: at }).execute();
    await t.db.updateTable("clips").set({ take_id: done }).where("id", "=", clip).execute();
    await t.db.insertInto("jobs").values({
      id: newId(), owner_id: OWNER, recipe_id: CUT_JOB, label: "zz-test finish", status: "done", priority: 0, clip_id: clip, created_at: at, updated_at: at, finished_at: at,
      inputs: JSON.stringify({ asset: "x", startMs: 0, endMs: 3000, action: "finish", route: "seedvr", by: 2, colour: "lab", seedvrFrames: 0, sharpen: 0, clip, finishedFrom: take }),
    } as never).execute();
    const again = await t.app.inject({ method: "POST", url: `/api/timelines/${tl.id}/finish`, payload: { route: "seedvr", factor: 2, colour: "lab", seedvrFrames: 0, sharpen: 0, redo: "changed" } });
    expect(again.json().skipped).toEqual([{ clip: 1, why: "finished already with these settings" }]);
  });
});

describe("the clip's own model, Face refine's alone (0.8.3 review)", () => {
  it("is refused for an upscaler's model by Finish and by Render, before any job is queued", async () => {
    const tl = (await t.app.inject({ method: "POST", url: "/api/timelines", payload: { name: "zz-test finish models" } })).json();
    await clipWithTake(tl.id);
    for (const payload of [{ route: "seedvr", seedvrModel: OWN_MODEL }, { route: "latent", latentModel: OWN_MODEL }, { route: "model", upscaleModel: OWN_MODEL }]) {
      const res = await t.app.inject({ method: "POST", url: `/api/timelines/${tl.id}/finish`, payload: { factor: 2, ...payload } });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    // a form's: SeedVR2's model set to it is refused at Render; Face refine's is taken
    const render = (values: Record<string, unknown>) => t.app.inject({ method: "POST", url: "/api/jobs", payload: { recipe: "h3.video", input: { description: "a", start: "s1", ...values } } });
    const refused = await render({ upscale: "SeedVR2", seedvrModel: OWN_MODEL });
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toMatch(/not offered here/);
    expect(() => parseInput(recipeById("h3.video")!, { description: "a", upscaleLatentModel: OWN_MODEL })).toThrow(/not offered here/);
    expect(parseInput(recipeById("h3.video")!, { description: "a", faceRefineModel: OWN_MODEL })).toMatchObject({ faceRefineModel: OWN_MODEL });
    expect(await t.db.selectFrom("jobs").select("id").execute()).toEqual([]);
  });
});

describe("a form's model inputs, as the files a job asks for", () => {
  const video = recipeById("h3.video")!;
  const form = (values: Record<string, unknown>) => parseInput(video, { description: "a", references: [{ asset: "r1", role: "person" }], ...values }) as unknown as Record<string, unknown>;

  it("asks for Face refine's model only with Face refine on, and never for the clip's own", () => {
    const asked = (values: Record<string, unknown>) => filesAsked(video, form(values)).map((f) => f.file);
    expect(asked({ faceRefine: true, faceRefineModel: "other_h3_ref2va.safetensors" })).toContain("other_h3_ref2va.safetensors");
    expect(asked({ faceRefine: false, faceRefineModel: "other_h3_ref2va.safetensors" })).not.toContain("other_h3_ref2va.safetensors");
    expect(asked({ faceRefine: true, faceRefineModel: OWN_MODEL })).not.toContain(OWN_MODEL);
  });

  it("asks for the Face refine model picked on a SCAIL-2 or LTX 2.5 form (card #204), none left out", () => {
    for (const [id, values] of [["scail.motion24", { picture: "p1", driving: { asset: "v1" } }], ["ltx25.video", { prompt: "a" }]] as const) {
      const recipe = recipeById(id)!;
      const asked = (more: Record<string, unknown>) => filesAsked(recipe, parseInput(recipe, { ...values, faceRefine: true, ...more }) as unknown as Record<string, unknown>).filter((f) => f.input === "faceRefineModel");
      expect(asked({ faceRefineModel: "other_h3_ref2va.safetensors" }), id).toEqual([expect.objectContaining({ file: "other_h3_ref2va.safetensors", folder: "diffusion_models" })]);
      expect(asked({}), id).toEqual([]);
    }
  });

  it("asks for SeedVR2's and the latent upscaler's only on their routes", () => {
    const asked = (values: Record<string, unknown>) => filesAsked(video, form(values)).map((f) => f.file);
    expect(asked({ upscale: "Video: SeedVR2 (restores)", seedvrModel: "seedvr2_7b.safetensors" })).toContain("seedvr2_7b.safetensors");
    expect(asked({ upscale: "Off", seedvrModel: "seedvr2_7b.safetensors" })).not.toContain("seedvr2_7b.safetensors");
    expect(asked({ upscale: "Latent: re-sampled", upscaleLatentModel: "minimax_h3_latent_upscaler_v2.safetensors" })).toContain("minimax_h3_latent_upscaler_v2.safetensors");
    expect(asked({ upscale: "Latent: re-sampled", upscaleWith: "Plain resize", upscaleLatentModel: "minimax_h3_latent_upscaler_v2.safetensors" })).not.toContain("minimax_h3_latent_upscaler_v2.safetensors");
  });
});

describe("a LoRA list's six places, Turbo's row among them (card #189)", () => {
  it("refuses a render with six LoRAs of its own and Turbo on, before any job is queued; takes five, or six with Turbo off", async () => {
    const render = (values: Record<string, unknown>) => t.app.inject({ method: "POST", url: "/api/jobs", payload: { recipe: "h3.video", input: { description: "a", start: "s1", ...values } } });
    const six = Array.from({ length: 6 }, (_, i) => ({ file: `zz-test-${i}.safetensors`, weight: 0.5 }));
    const turbo = { fast: true, turboLora: "zz-test-h3-turbo.safetensors" };
    const refused = await render({ ...turbo, loras: six });
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toMatch(/7 LoRAs, 6 at most \(Turbo takes a place/);
    expect(await t.db.selectFrom("jobs").select("id").execute()).toEqual([]);
    expect((await render({ ...turbo, loras: six.slice(1) })).body).not.toMatch(/at most/);
    expect((await render({ ...turbo, loras: [...six.slice(1), { file: "zz-test-h3-turbo.safetensors", weight: 0.8 }] })).body).not.toMatch(/at most/);
    expect((await render({ fast: false, loras: six })).body).not.toMatch(/at most/);
  });
});
