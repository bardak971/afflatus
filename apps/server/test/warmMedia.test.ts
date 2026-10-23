import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { dryContext, parseInput, warmGraph, type InputSpec } from "@afflatus/core";
import { familyById, recipes } from "@afflatus/recipes";
import { NO_MEDIA, standIns, withTexts } from "../src/queueSubmit";
import { makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";

/**
 * Load (the model ahead) and the "another model" chip on a form still missing its media (card #50): Lip sync with no
 * recording yet said "recording: Invalid input: expected string, received undefined". A warm graph is its loaders, which
 * read no picture, sound or video: a form is never refused for one it has not got yet.
 */

const MEDIA = new Set(["image", "clip", "audio", "references"]);
/** Whether a graph reads one of the stand-ins anywhere: ComfyUI would refuse the name. */
const readsStandIn = (graph: Record<string, { inputs: Record<string, unknown> }>) =>
  Object.values(graph).some((n) => Object.values(n.inputs).some((v) => typeof v === "string" && v.includes(NO_MEDIA)));

describe("every built-in form loads its models with all its media left empty", () => {
  for (const recipe of recipes) {
    it(recipe.id, () => {
      const specs = recipe.inputs as InputSpec[];
      const family = familyById(recipe.family)!;
      // the family's files all there, as on a machine that has them; the form's own settings as its first sample, no media
      const slots = { ...Object.fromEntries(family.slots.map((s) => [s.id, `${s.id}.safetensors`])), ...recipe.variants[0]!.slots };
      const settings = Object.fromEntries(Object.entries(recipe.variants[0]!.input).filter(([id]) => !MEDIA.has(specs.find((s) => s.id === id)?.type ?? "")));
      const input = parseInput(recipe, withTexts(recipe, settings)) as Record<string, unknown>;
      const built = recipe.build(input, dryContext({ slots, ...standIns(recipe, input) }));
      const loaders = warmGraph({ ...built, passes: [] }, { unread: [NO_MEDIA] });
      expect(loaders).not.toBeNull();
      expect(readsStandIn(loaders!.graph)).toBe(false);
    });
  }
});

const FILES = {
  diffusion_models: ["minimax_h3_fl2va_int8_convrot.safetensors", "minimax_h3_fused_refdelta_r1024_turbo8_mystic07_int8_convrot.safetensors", "wan2.1_14B_SCAIL_2_int8_convrot.safetensors"],
  loras: ["h3_character_swap_v1.5.safetensors", "wan2.1_SCAIL_2_DPO_lora_bf16.safetensors", "lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors"],
  checkpoints: ["sam3.1_multiplex_fp16.safetensors"],
  model_patches: ["minimax_h3_fun_controlnet_union_2.0.safetensors"],
  text_encoders: ["qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "umt5_xxl_fp8_e4m3fn_scaled.safetensors"],
  vae: ["minimax_h3_video_vae_fp16.safetensors", "minimax_h3_audio_vae_fp32.safetensors", "wan_2.1_vae.safetensors"],
  clip_vision: ["clip_vision_h.safetensors"],
};

let fake: FakeComfy;
let t: TestApp;
beforeEach(async () => {
  const catalog = referenceCatalog();
  // SAM 3 is a checkpoint: the reference catalog's checkpoints are an SDXL test's
  catalog.CheckpointLoaderSimple!.input.required!.ckpt_name = [FILES.checkpoints];
  fake = await startFakeComfy({ catalog, models: FILES });
  t = await makeApp({ comfyUrl: fake.url });
  await t.services.queue.start();
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

describe("Load and the loaded check on a video form with no media yet", () => {
  // Lip sync with no recording, Swap character and Motion transfer with no source, SCAIL-2 with no driving video nor picture
  for (const recipe of ["h3.lipsync", "h3.swap", "h3.motion", "scail.motion", "scail.motion24"]) {
    it(`${recipe}: loads the model files alone, and says whether they are loaded`, async () => {
      const loaded = await post(t.app, "/api/comfy/loaded", { recipe, input: {} });
      expect(loaded.statusCode).toBe(200);
      // told, not "cannot tell": the form builds with its media stood in for
      expect(loaded.json().loaded).toBe(false);

      const asked = await post(t.app, "/api/jobs/warm", { recipe, input: {} });
      expect(asked.statusCode, asked.body).toBe(200);
      const id = asked.json().id as string;
      await until(async () => fake.prompts.size === 1 || (await t.db.selectFrom("jobs").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status === "failed");
      const job = await t.db.selectFrom("jobs").select(["status", "error"]).where("id", "=", id).executeTakeFirstOrThrow();
      expect(job.error).toBeNull();
      const graph = [...fake.prompts.values()][0]!;
      const classes = Object.values(graph).map((n) => n.class_type);
      expect(classes).toContain("PreviewAny");
      for (const absent of ["LoadImage", "LoadAudio", "LoadVideo", "VHS_LoadVideo", "VHS_LoadAudioUpload"]) expect(classes).not.toContain(absent);
      expect(readsStandIn(graph)).toBe(false);
    });
  }
});
