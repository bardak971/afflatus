import { describe, expect, it } from "vitest";
import { dryContext, GraphBuilder, type BuildContext } from "@afflatus/core";
import { isSeedvr7b, pixelUpscale, seedvrChunk, seedvrWindow, UPSCALE } from "../src";

/**
 * Card #148's tested graph (scripts/zz-148.ts on an A40, Timeline 6 c1's 1024 × 576 frames doubled), the SeedVR2 nodes as
 * they were sent: the 7B's default has to be this, node for node, so that what the owner picked is what the app runs.
 */
const TESTED: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
  "3": { class_type: "ResizeImageMaskNode", inputs: { input: ["2", 0], resize_type: "scale by multiplier", "resize_type.multiplier": 2, scale_method: "lanczos" } },
  "4": { class_type: "SeedVR2Preprocess", inputs: { resized_images: ["3", 0] } },
  "5": { class_type: "VAELoader", inputs: { vae_name: "seedvr2_ema_vae_fp16.safetensors" } },
  "6": { class_type: "UNETLoader", inputs: { unet_name: "seedvr2_7b_int8_convrot.safetensors", weight_dtype: "default" } },
  "7": { class_type: "VAEEncode", inputs: { pixels: ["4", 0], vae: ["5", 0] } },
  "8": { class_type: "SeedVR2TemporalChunk", inputs: { latent: ["7", 0], temporal_overlap: 2, chunking_mode: "manual", "chunking_mode.frames_per_chunk": 49 } },
  "9": { class_type: "SeedVR2Conditioning", inputs: { model: ["6", 0], vae_conditioning: ["8", 0] } },
  "10": { class_type: "KSampler", inputs: { model: ["6", 0], positive: ["9", 0], negative: ["9", 1], latent_image: ["8", 0], seed: 137, steps: 1, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 } },
  "11": { class_type: "SeedVR2TemporalMerge", inputs: { latents: ["10", 0], temporal_overlap: ["8", 1] } },
  "12": { class_type: "VAEDecode", inputs: { samples: ["11", 0], vae: ["5", 0] } },
  "13": { class_type: "SeedVR2PostProcessing", inputs: { images: ["12", 0], original_resized_images: ["3", 0], color_correction_method: "lab" } },
};

/** What torch says of an A40's memory, and of the owner's 12 GB card, in GiB. */
const A40 = 44.3;
const CARD_12GB = 11.99;

/** The upscale as zz-148.ts built it (the app's own pixelUpscale), with the model and card given. */
function built(model: string, vram?: number, seedvrFrames = 0) {
  const g = new GraphBuilder();
  const parts = g.add("GetVideoComponents", { video: g.out("LoadVideo", { file: "zz.mp4" }) });
  const ctx: BuildContext = dryContext({ seed: 137, slots: { seedvr: model, seedvrVae: "seedvr2_ema_vae_fp16.safetensors" }, ...(vram ? { vram } : {}) });
  pixelUpscale(g, [parts, 0], { upscale: UPSCALE.seedvr, upscaleBy: 2, upscaleModel: "", upscaleColour: "lab", seedvrFrames }, { width: 1024, height: 576 }, ctx);
  return g.graph as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
}
const chunk = (graph: ReturnType<typeof built>) => Object.values(graph).find((n) => n.class_type === "SeedVR2TemporalChunk")!.inputs;

describe("SeedVR2's window (card #148)", () => {
  it("the 7B on an A40-sized card is #148's tested graph, node for node", () => {
    expect(built("seedvr2_7b_int8_convrot.safetensors", A40)).toEqual({
      "1": { class_type: "LoadVideo", inputs: { file: "zz.mp4" } },
      "2": { class_type: "GetVideoComponents", inputs: { video: ["1", 0] } },
      ...TESTED,
    });
    // and the sharp one, the other model of the test
    expect(chunk(built("seedvr2_7b_sharp_int8_convrot.safetensors", A40))).toEqual(TESTED["8"]!.inputs);
    // 49 asked for by hand is the same pass
    expect(chunk(built("seedvr2_7b_int8_convrot.safetensors", CARD_12GB, 49))).toEqual(TESTED["8"]!.inputs);
  });

  it("where 49 does not fit, the widest 4n + 1 the card holds, never under 5", () => {
    // the owner's 12 GB card at ×2 of 576p: the floor, without an overlap (it would sample every frame twice)
    expect(chunk(built("seedvr2_7b_int8_convrot.safetensors", CARD_12GB))).toMatchObject({ "chunking_mode.frames_per_chunk": 5, temporal_overlap: 0 });
    // larger cards in between: narrower than 49, the overlap kept from 13 frames up
    expect(seedvrWindow(2.36, { big: true, vram: 23.6 })).toEqual({ frames: 33, overlap: 2 });
    expect(seedvrWindow(2.36, { big: true, vram: 15.9 })).toEqual({ frames: 13, overlap: 2 });
    // ×3 on an A40: 5.3 Mpx a frame
    expect(seedvrWindow(5.3, { big: true, vram: A40 })).toEqual({ frames: 41, overlap: 2 });
    // the floor, at any size, on any card
    for (const vram of [4, 8, CARD_12GB]) for (const mpx of [1, 2.36, 9.4]) expect(seedvrWindow(mpx, { big: true, vram }).frames).toBeGreaterThanOrEqual(5);
    // a card not known: the 12 GB rule, floored
    expect(seedvrWindow(2.36, { big: true })).toEqual({ frames: 5, overlap: 0 });
    expect(seedvrWindow(5.3, { big: true })).toEqual({ frames: 5, overlap: 0 });
    // a number asked for is kept as it was (4n + 1), the overlap with it from 13 up
    expect(seedvrWindow(2.36, { big: true, vram: A40, asked: 9 })).toEqual({ frames: 9, overlap: 0 });
    expect(seedvrWindow(2.36, { big: true, vram: A40, asked: 21 })).toEqual({ frames: 21, overlap: 2 });
  });

  it("the 3B is as before: by the frame's size, no overlap, whatever the card", () => {
    for (const vram of [undefined, CARD_12GB, A40]) {
      expect(chunk(built("seedvr2_3b_int8_convrot.safetensors", vram))).toEqual({ latent: ["7", 0], temporal_overlap: 0, chunking_mode: "manual", "chunking_mode.frames_per_chunk": seedvrChunk(2.36) });
      expect(seedvrWindow(1.7, { vram })).toEqual({ frames: 9, overlap: 0 });
      expect(seedvrWindow(3.8, { vram })).toEqual({ frames: 1, overlap: 0 });
    }
  });

  it("tells the 7B by its file name, whoever made it", () => {
    expect(["seedvr2_7b_int8_convrot.safetensors", "seedvr2_7b_sharp_fp16.safetensors", "seedvr2_ema_7b_fp16.safetensors", "SeedVR2-7B.gguf"].every(isSeedvr7b)).toBe(true);
    expect(["seedvr2_3b_int8_convrot.safetensors", "seedvr2_ema_3b_fp16.safetensors", "seedvr2_17b.safetensors", undefined].some(isSeedvr7b)).toBe(false);
  });
});
