import { describe, expect, it } from "vitest";
import { baseGroup, baseLabel, loraFit } from "../src";

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
