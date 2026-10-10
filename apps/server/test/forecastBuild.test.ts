import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { newId, now, OWNER } from "../src/db";
import { workOf } from "../src/forecast";
import { CHECKPOINT, makeApp, referenceCatalog, type TestApp } from "./helpers";

/**
 * The graph a form is forecast from is the one its render will sample: the files it is handed stood in for with
 * what is known of them (a picture's size, a clip's size and the frames a join takes), a finish built on its draft.
 */

const FILES = {
  checkpoints: [CHECKPOINT],
  diffusion_models: ["minimax_h3_fl2va_fp8.safetensors"],
  text_encoders: ["qwen3vl_32b_minimax_h3_fp8.safetensors"],
  vae: ["minimax_h3_video_vae_fp16.safetensors", "minimax_h3_audio_vae.safetensors"],
  loras: ["minimax_h3_turbo_lora.safetensors"],
  upscale_models: [],
};

let fake: FakeComfy;
let t: TestApp;
beforeEach(async () => {
  fake = await startFakeComfy({ catalog: referenceCatalog(), models: FILES });
  t = await makeApp({ comfyUrl: fake.url });
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

/** A library row with what is known of its file (none is read here). */
async function asset(kind: "image" | "video", facts: { width: number; height: number; duration_ms?: number }) {
  const id = newId();
  const at = now();
  await t.db.insertInto("assets").values({
    id, owner_id: OWNER, kind, origin: "uploaded", name: `zz-test ${kind}`, file_key: `assets/${id}`, thumb_key: null, mime: kind === "video" ? "video/mp4" : "image/png", bytes: 4,
    width: facts.width, height: facts.height, duration_ms: facts.duration_ms ?? null, fps: kind === "video" ? 24 : null, has_sound: 0, folder_id: null, generation_id: null, kept_at: at, deleted_at: null, created_at: at,
  } as never).execute();
  return id;
}

describe("the graph a form is forecast from", () => {
  it("is built at the size of the picture it is handed, not a square stand-in", async () => {
    const picture = await asset("image", { width: 1216, height: 832 });
    const built = (await t.services.queue.builtOf("sdxl.outpaint", { source: picture, prompt: "a", checkpoint: CHECKPOINT, padLeft: 128, padRight: 128, padTop: 0, padBottom: 0 }))!;
    const scaled = Object.values(built.graph).find((n) => n.class_type === "ImageScale")!;
    expect(scaled.inputs).toMatchObject({ width: 1216 + 256, height: 832 });
  });

  it("continues a clip at that clip's size, with the frames the join shares sampled too", async () => {
    const before = await asset("video", { width: 576, height: 1024, duration_ms: 5854 });
    const alone = workOf((await t.services.queue.builtOf("h3.video", { description: "a", seconds: 5 }))!);
    // a clip handed over as an object: before, it had no stand-in, the build threw, and the forecast fell back on a rate a second
    const built = (await t.services.queue.builtOf("h3.video", { description: "a", seconds: 5, previous: { asset: before } }))!;
    const work = workOf(built);
    expect(work.pixels).toBe(576 * 1024);
    // its own five seconds and the 22 frames of the clip before (on the model's frame grid)
    expect(work.frames).toBeGreaterThan(alone.frames);
  });

  it("builds a finish that re-samples its draft's latent on that latent, as submit does: not as the draft and its finish both", async () => {
    const input = { description: "a", seconds: 5, upscale: "Latent: re-sampled" };
    const both = (await t.services.queue.builtOf("h3.video", input))!;
    const finish = (await t.services.queue.builtOf("h3.video", input, { finishedFrom: "zz-test-take" }))!;
    const classes = (b: typeof both) => Object.values(b.graph).map((n) => n.class_type);
    expect(classes(both)).toContain("SamplerCustomAdvanced");
    expect(classes(finish)).not.toContain("SamplerCustomAdvanced");
    expect(classes(finish)).toContain("AfflatusLoadH3Latent");
    expect(finish.totalSteps).toBeLessThan(both.totalSteps);
    expect(workOf(finish).frames).toBe(workOf(both).frames);
  });
});
