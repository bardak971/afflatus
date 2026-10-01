import { describe, expect, it } from "vitest";
import { baseLabel, modelInfoFrom } from "../src";

describe("what a model file says about itself", () => {
  it("reads a kohya-trained LoRA: its name, what it is for, and the words it was trained with, most used first", () => {
    const info = modelInfoFrom({
      "modelspec.title": "Soft watercolour",
      "modelspec.architecture": "stable-diffusion-xl-v1-base/lora",
      ss_output_name: "soft_wc_v2",
      ss_sd_model_name: "checkpoints/illustriousXL_v01.safetensors",
      ss_training_comment: "None",
      ss_tag_frequency: JSON.stringify({ "10_style": { watercolor: 40, "soft lighting": 12, "1girl": 35 }, "5_more": { watercolor: 20, flowers: 3 } }),
    }, "soft_wc_v2.safetensors");
    expect(info).toEqual({ title: "Soft watercolour", base: "SDXL", trainedOn: "illustriousXL_v01", tags: ["watercolor", "1girl", "soft lighting", "flowers"] });
  });

  it("keeps the trigger phrase and the author's own tags when they were written down", () => {
    const info = modelInfoFrom({ "modelspec.trigger_phrase": "wc_style, soft painting", "modelspec.tags": "style, watercolour", "modelspec.description": "Use at 0.8.", ss_base_model_version: "wan_2.2_14b" });
    expect(info).toEqual({ base: "Wan 2.2", trigger: "wc_style, soft painting", tags: ["style", "watercolour"], about: "Use at 0.8." });
  });

  it("does not repeat the file name as a title, and says nothing for a header that says nothing", () => {
    expect(modelInfoFrom({ ss_output_name: "my_lora" }, "folder/my_lora.safetensors")).toEqual({});
    expect(modelInfoFrom({ ss_tag_frequency: "not json", ss_training_comment: "null" })).toEqual({});
    expect(modelInfoFrom({})).toEqual({});
  });

  it("names model families the way a person would", () => {
    expect([
      "stable-diffusion-xl-v1-base/lora", "sdxl_base_v1-0", "wan2.1/lora", "wan_2.2_14b", "wan-2_1-text2video-14b/lora", "minimax_h3", "MiniMax-H3/lora",
      "flux-1-dev/lora", "flux2_klein_4b", "stable-diffusion-v1/lora", "anima/lora",
    ].map(baseLabel)).toEqual(["SDXL", "SDXL", "Wan 2.1", "Wan 2.2", "Wan 2.1", "MiniMax H3", "MiniMax H3", "FLUX.1", "FLUX.2 Klein", "SD 1.5", "anima"]);
  });
});
