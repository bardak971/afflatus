import { describe, expect, it } from "vitest";
import { FULL_MODEL_FOLDERS, USUAL_FOLDERS } from "../src";

/** The usual model folders, one list for the server and the web (they were five, written by hand). */
describe("the usual model folders", () => {
  it("are the twelve the Find models page offered, in its order; the full models' are those less embeddings", () => {
    expect(USUAL_FOLDERS).toEqual(["checkpoints", "diffusion_models", "loras", "vae", "text_encoders", "clip_vision", "upscale_models", "latent_upscale_models", "controlnet", "model_patches", "audio_encoders", "embeddings"]);
    expect(FULL_MODEL_FOLDERS).toEqual(["checkpoints", "diffusion_models", "loras", "vae", "text_encoders", "clip_vision", "upscale_models", "latent_upscale_models", "controlnet", "model_patches", "audio_encoders"]);
  });
});
