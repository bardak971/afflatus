import { describe, expect, it } from "vitest";
import { dryContext, graphFiles, parseInput } from "@afflatus/core";
import { ltx, ltxLipSync, ltxVideo } from "../src";

/**
 * LTX 2.3's one checkpoint given as the Model (card #103, 2026-10-26): built as a diffusion model, its UNETLoader read
 * a file only checkpoints had, and the split files the checkpoint stands for were wanted too. A fresh pod was sent the
 * checkpoint into checkpoints, never the audio VAE, and the job was refused at its submit for both.
 */

const CKPT = ltx.slots.find((s) => s.id === "checkpoint")!.get!.file;
// as a fresh pod's build is handed them (podSlotFiles): every required slot named, the split ones by their downloads
const pod = { checkpoint: CKPT, clip: "gemma_3_12B_it_fp4_mixed.safetensors", videoVae: "LTX23_video_vae_bf16.safetensors", audioVae: "LTX23_audio_vae_bf16.safetensors", projection: "ltx-2.3_text_projection_bf16.safetensors", upscaler: "up.safetensors" };
const folders = Object.fromEntries(ltx.slots.map((s) => [s.id, s.folder]));
const build = (recipe: typeof ltxVideo, over: Record<string, unknown>, options?: string[]) =>
  recipe.build(parseInput(recipe, { prompt: "A red ball rolls. The audio is wind.", ...over }), dryContext({ seed: 7, slots: pod, uploads: { recording: "rec.wav" }, media: { recording: { width: 0, height: 0, seconds: 5 } }, ...(options ? { options: () => options } : {}) }));
const classes = (b: ReturnType<typeof build>) => Object.values(b.graph).map((n) => n.class_type);

describe("LTX 2.3's one checkpoint picked as the Model", () => {
  for (const [name, recipe, over] of [["Video with audio", ltxVideo, {}], ["Lip sync", ltxLipSync, { recording: "a1", recordingSeconds: 5 }]] as const) {
    it(`${name}: is loaded as the checkpoint, never by UNETLoader, and asks for none of the split files`, () => {
      const b = build(recipe, { ...over, model: CKPT });
      expect(classes(b)).toContain("CheckpointLoaderSimple");
      expect(classes(b)).not.toContain("UNETLoader");
      expect(b.loads).toContain(`checkpoints/${CKPT}`);
      expect(b.loads.some((f) => f.startsWith("vae/") || f.includes("text_projection"))).toBe(false);
      // what a pod is sent for it is what the graph loads, each in the folder its loader reads
      const files = graphFiles(b.graph, pod, folders).map((f) => `${f.folder}/${f.file}`);
      expect(files).toContain(`checkpoints/${CKPT}`);
      expect(files.some((f) => f.includes("audio_vae") || f.startsWith("diffusion_models/"))).toBe(false);
    });
  }

  it("is a diffusion model where this ComfyUI offers it as one (a copy in diffusion_models): UNETLoader, the split files, all in their own folders", () => {
    const b = build(ltxVideo, { model: CKPT }, [CKPT]);
    expect(classes(b)).toContain("UNETLoader");
    expect(classes(b)).not.toContain("CheckpointLoaderSimple");
    const files = graphFiles(b.graph, pod, folders).map((f) => `${f.folder}/${f.file}`);
    // never counted in checkpoints, where a pod having it was taken to have what UNETLoader reads
    expect(files).toEqual(expect.arrayContaining([`diffusion_models/${CKPT}`, `vae/${pod.videoVae}`, `vae/${pod.audioVae}`, `text_encoders/${pod.projection}`]));
    expect(files).not.toContain(`checkpoints/${CKPT}`);
  });

  it("another diffusion model is still one", () => {
    const b = build(ltxVideo, { model: "ltx-2.3-finetune.safetensors" });
    expect(classes(b)).toContain("UNETLoader");
    expect(b.loads).toEqual(expect.arrayContaining(["diffusion_models/ltx-2.3-finetune.safetensors", `vae/${pod.audioVae}`]));
  });
});
