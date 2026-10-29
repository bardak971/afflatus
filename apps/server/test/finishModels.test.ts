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

describe("a form's model inputs, as the files a job asks for", () => {
  const video = recipeById("h3.video")!;
  const form = (values: Record<string, unknown>) => parseInput(video, { description: "a", references: [{ asset: "r1", role: "person" }], ...values }) as unknown as Record<string, unknown>;

  it("asks for Face refine's model only with Face refine on, and never for the clip's own", () => {
    const asked = (values: Record<string, unknown>) => filesAsked(video, form(values)).map((f) => f.file);
    expect(asked({ faceRefine: true, faceRefineModel: "other_h3_ref2va.safetensors" })).toContain("other_h3_ref2va.safetensors");
    expect(asked({ faceRefine: false, faceRefineModel: "other_h3_ref2va.safetensors" })).not.toContain("other_h3_ref2va.safetensors");
    expect(asked({ faceRefine: true, faceRefineModel: OWN_MODEL })).not.toContain(OWN_MODEL);
  });

  it("asks for SeedVR2's and the latent upscaler's only on their routes", () => {
    const asked = (values: Record<string, unknown>) => filesAsked(video, form(values)).map((f) => f.file);
    expect(asked({ upscale: "Video: SeedVR2 (restores)", seedvrModel: "seedvr2_7b.safetensors" })).toContain("seedvr2_7b.safetensors");
    expect(asked({ upscale: "Off", seedvrModel: "seedvr2_7b.safetensors" })).not.toContain("seedvr2_7b.safetensors");
    expect(asked({ upscale: "Latent: re-sampled", upscaleLatentModel: "minimax_h3_latent_upscaler_v2.safetensors" })).toContain("minimax_h3_latent_upscaler_v2.safetensors");
    expect(asked({ upscale: "Latent: re-sampled", upscaleWith: "Plain resize", upscaleLatentModel: "minimax_h3_latent_upscaler_v2.safetensors" })).not.toContain("minimax_h3_latent_upscaler_v2.safetensors");
  });
});
