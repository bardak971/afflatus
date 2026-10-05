import { describe, expect, it } from "vitest";
import { guessModel } from "../src/model";

const ckpt = (name: string, size = 1024) => ({
  "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: name } },
  "2": { class_type: "EmptyLatentImage", inputs: { width: size, height: size, batch_size: 1 } },
});

describe("the model a workflow seems to be for", () => {
  it("reads the family off node types and file names", () => {
    expect(guessModel({ "1": { class_type: "WanVideoModelLoader", inputs: { model: "x.safetensors" } } })).toBe("Wan 2.2");
    expect(guessModel({ "1": { class_type: "UnetLoaderGGUF", inputs: { unet_name: "wan2.2_i2v_high_noise_14B_Q5_K_M.gguf" } } })).toBe("Wan 2.2");
    expect(guessModel({ "1": { class_type: "UnetLoaderGGUF", inputs: { unet_name: "wan2.1_t2v_1.3B.gguf" } } })).toBe("Wan 2.1");
    expect(guessModel({ "1": { class_type: "UnetLoaderGGUF", inputs: { unet_name: "qwen_image_2.1-Q4_K_M.gguf" } } })).toBe("Qwen Image 2.1");
    expect(guessModel({ "1": { class_type: "UNETLoader", inputs: { unet_name: "qwen_image_fp8.safetensors" } } })).toBe("Qwen Image");
    expect(guessModel({ "1": { class_type: "UNETLoader", inputs: { unet_name: "flux2-klein-9b.safetensors" } } })).toBe("FLUX.2 Klein");
    expect(guessModel({ "1": { class_type: "UNETLoader", inputs: { unet_name: "flux1-dev.safetensors" } } })).toBe("FLUX.1");
    expect(guessModel({ "1": { class_type: "LTXVLoader", inputs: { ckpt_name: "ltx-2.3-22b-dev.safetensors" } } })).toBe("LTX 2.3");
  });

  it("tells SDXL from SD 1.5 by the checkpoint's name, else by the latent's size", () => {
    expect(guessModel(ckpt("Babes Illustrious BSY V5 DMD2.safetensors"))).toBe("SDXL");
    expect(guessModel(ckpt("ponyDiffusionV6XL.safetensors"))).toBe("SDXL");
    expect(guessModel(ckpt("sd_xl_base_1.0.safetensors"))).toBe("SDXL");
    expect(guessModel(ckpt("v1-5-pruned-emaonly.safetensors", 512))).toBe("SD 1.5");
    expect(guessModel(ckpt("someFineTune.safetensors", 1024))).toBe("SDXL");
    expect(guessModel(ckpt("someFineTune.safetensors", 512))).toBe("SD 1.5");
  });

  it("is not fooled by a prompt, and says nothing when nothing says", () => {
    expect(guessModel({ "1": { class_type: "CLIPTextEncode", inputs: { text: "a wan smile, flux of pixels" } } })).toBe("");
    expect(guessModel({ "1": { class_type: "LoadImage", inputs: { image: "pixel.png" } } })).toBe("");
  });
});
