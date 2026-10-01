import { describe, expect, it } from "vitest";
import { baseGroup, baseLabel, identityWords, lineOf, loraFit, modelFit } from "../src";

describe("which LoRAs suit a model family", () => {
  const sdxl = { name: "SDXL", loraMatch: ["stable-diffusion-xl", "sdxl", "pony", "illustrious", "noob"] };
  // a family made from an imported workflow has only the name its user gave it
  const wan = { name: "Wan 2.2", loraMatch: [] };

  it("knows a LoRA made for the family from what its file says", () => {
    expect(loraFit(sdxl, "style.safetensors", { base: "SDXL" })).toBe(2);
    expect(loraFit(wan, "motion.safetensors", { base: "Wan 2.2" })).toBe(2);
  });

  it("takes a close version as probably fine: a Wan 2.1 LoRA on Wan 2.2", () => {
    expect(baseGroup(baseLabel("wan2.1/lora"))).toBe("Wan");
    expect(loraFit(wan, "motion.safetensors", { base: "Wan 2.1" })).toBe(1);
  });

  it("knows a LoRA made for another model", () => {
    expect(loraFit(sdxl, "motion.safetensors", { base: "Wan 2.2" })).toBe(-1);
    expect(loraFit(wan, "style.safetensors", { base: "SDXL" })).toBe(-1);
    expect(loraFit(wan, "klein.safetensors", { base: "FLUX.2 Klein" })).toBe(-1);
  });

  it("falls back on the file's name and folder when the file says nothing", () => {
    expect(loraFit(wan, "Wan/High/WAN-2.2-I2V-something-HIGH.safetensors", {})).toBe(1);
    expect(loraFit(sdxl, "Illustrious/hands.safetensors")).toBe(1);
    expect(loraFit(sdxl, "pony_style.safetensors", { trainedOn: "ponyDiffusionV6XL" })).toBe(1);
    // nothing to go by: unknown, not "wrong"
    expect(loraFit(wan, "something.safetensors", {})).toBe(0);
    expect(loraFit(sdxl, "something.safetensors")).toBe(0);
  });

  it("does not trip on a pattern that is not a valid one", () => {
    expect(loraFit({ name: "SDXL", loraMatch: ["(unclosed"] }, "x.safetensors", { base: "SDXL" })).toBe(2);
  });
});

describe("how well a LoRA suits the very model in use", () => {
  it("knows the lines of SDXL checkpoints, whose LoRAs do not carry over", () => {
    expect(["waiNSFWIllustrious_v140.safetensors", "noobaiXLNAIXL_vPred10.safetensors", "sub\\ponyDiffusionV6XL.safetensors", "cyberrealisticPony_v11.safetensors", "sd_xl_base_1.0.safetensors"].map(lineOf))
      .toEqual(["Illustrious", "Illustrious", "Pony", "Pony", null]);
  });

  it("puts first what was trained on that model, then what is of its line; another line of the same family is said to be so", () => {
    const model = "Illustrious\\waiNSFWIllustrious_v140.safetensors";
    expect(modelFit(model, "style.safetensors", { base: "SDXL", trainedOn: "waiNSFWIllustrious_v140" })).toBe(2);
    expect(modelFit(model, "style.safetensors", { base: "SDXL", trainedOn: "illustriousXL_v01" })).toBe(1);
    expect(modelFit(model, "IL\\style_ilxl.safetensors", { base: "SDXL" })).toBe(1);
    expect(modelFit(model, "style.safetensors", { base: "SDXL", trainedOn: "ponyDiffusionV6XL" })).toBe(-1);
    expect(modelFit(model, "Pony\\style.safetensors")).toBe(-1);
    // nothing says: it stays where its family puts it
    expect(modelFit(model, "style.safetensors", { base: "SDXL" })).toBe(0);
  });

  it("goes by the model's own name and the folder it is kept in, where there is no line to go by", () => {
    const model = "Krea2\\someoneNSFWCheckpoint_v10Krea2_fp8.safetensors";
    expect(identityWords(model)).toEqual(["krea2", "someone"]);
    // filed in a folder of the same name, or named for the same model
    expect(modelFit(model, "Krea2\\better_hands_v3.safetensors")).toBe(1);
    expect(modelFit(model, "better_hands_KREA2.safetensors")).toBe(1);
    expect(modelFit(model, "someone_style.safetensors")).toBe(1);
    expect(modelFit(model, "Wan\\motion.safetensors")).toBe(0);
    // words any model has say nothing
    expect(identityWords("High\\some_model_pruned_fp8_v2.safetensors")).toEqual([]);
    expect(modelFit("High\\some_model_pruned_fp8_v2.safetensors", "High\\other_pruned.safetensors")).toBe(0);
  });
});
