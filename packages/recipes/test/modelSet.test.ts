import { describe, expect, it } from "vitest";
import { checkModelSet, dryContext, graphFiles, loraFit, parseInput, setPlaces, type Family, type ModelInfo, type Recipe, type SetLook } from "@afflatus/core";
import { ltx, ltx25, ltx25Video, ltxVideo, wan, wanVideo } from "../src";

/**
 * A render's files checked as the server checks them: the recipe built with the family's usual files (its downloads), some
 * of them or of the form's swapped, and what the built graph loads held against the family's declarations.
 */
function check(family: Family, recipe: Recipe<any>, o: { input?: Record<string, unknown>; slots?: Record<string, string | null>; look?: SetLook } = {}) {
  const v = recipe.variants[0]!;
  const slots: Record<string, string> = Object.fromEntries(family.slots.map((s) => [s.id, s.get?.file ?? `${s.id}.safetensors`]));
  for (const [id, file] of Object.entries(o.slots ?? {})) {
    if (file === null) delete slots[id];
    else slots[id] = file;
  }
  const input = parseInput(recipe, { ...v.input, ...o.input }) as Record<string, unknown>;
  const graph = recipe.build(input, dryContext({ slots, uploads: v.uploads ?? {}, media: v.media ?? {}, canvas: v.canvas })).graph;
  const folders = Object.fromEntries(family.slots.map((s) => [s.id, s.folder]));
  return checkModelSet(family, setPlaces(family, recipe.inputs, input, graphFiles(graph, slots, folders)), o.look);
}
const texts = (found: ReturnType<typeof check>) => found.map((f) => `${f.at}: ${f.text}${f.black ? " [refused]" : ""}`);
const byHash = (hashes: Record<string, string>): SetLook => ({ sha256: (_folder, file) => hashes[file] });
const withInfo = (info: Record<string, ModelInfo>): SetLook => ({ info: (_folder, file) => info[file] });

describe("LTX 2.5's set", () => {
  it("passes its own files, and an unknown file without a word", () => {
    expect(check(ltx25, ltx25Video)).toEqual([]);
    expect(check(ltx25, ltx25Video, { slots: { videoVae: "my_vae.safetensors" } })).toEqual([]);
  });
  it("refuses LTX 2.3's VAE, by its name or a renamed copy's hash", () => {
    expect(texts(check(ltx25, ltx25Video, { slots: { videoVae: "LTX23_video_vae_bf16.safetensors" } }))).toEqual([
      "videoVae: This VAE is LTX 2.3's: LTX 2.5 needs ltx-2.5-video-vae-bf16 (Settings › Models has it). [refused]",
    ]);
    const renamed = check(ltx25, ltx25Video, { slots: { videoVae: "video_vae.safetensors" }, look: byHash({ "video_vae.safetensors": "01EA62D09BC139F95C5DEE7B5C062AD6A3E6CD8BE910A1983AC02E7EB5B8EE3B" }) });
    expect(renamed.map((f) => [f.at, f.black])).toEqual([["videoVae", true]]);
  });
  it("refuses Gemma 3 as its text encoder", () => {
    expect(texts(check(ltx25, ltx25Video, { slots: { clip: "gemma_3_12B_it_fp4_mixed.safetensors" } }))).toEqual([
      "clip: This text encoder is Gemma 3, LTX 2.3's text encoder (2.5's is Gemma 4, with the projection inside): LTX 2.5 needs gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot (Settings › Models has it). [refused]",
    ]);
  });
  it("warns of a LoRA trained for LTX 2.3, by its name or its base model on Civitai", () => {
    const lora = (file: string, look?: SetLook) => texts(check(ltx25, ltx25Video, { input: { loras: [{ file, weight: 1 }] }, look }));
    expect(lora("ltx23_dolly_zoom.safetensors")).toEqual(["loras: This LoRA was trained for LTX 2.3: on LTX 2.5 it may do nothing."]);
    expect(lora("dolly_zoom.safetensors", withInfo({ "dolly_zoom.safetensors": { base: "LTX", civitaiBase: "LTXV 2.3" } }))).toEqual(["loras: This LoRA was trained for LTX 2.3: on LTX 2.5 it may do nothing."]);
    expect(lora("ltx2.5_dolly_zoom.safetensors")).toEqual([]);
    expect(lora("dolly_zoom.safetensors")).toEqual([]);
  });
  it("warns of a LoRA its header says is for another model altogether", () => {
    expect(texts(check(ltx25, ltx25Video, { input: { loras: [{ file: "film_grain.safetensors", weight: 1 }] }, look: withInfo({ "film_grain.safetensors": { base: "SDXL" } }) }))).toEqual([
      "loras: This LoRA was trained for SDXL: on LTX 2.5 it does nothing.",
    ]);
  });
});

describe("LTX 2.3's set", () => {
  const split = { checkpoint: null };
  it("passes its own files, one checkpoint or split", () => {
    expect(check(ltx, ltxVideo)).toEqual([]);
    expect(check(ltx, ltxVideo, { slots: split })).toEqual([]);
  });
  it("refuses LTX-2's VAE in its split set", () => {
    expect(texts(check(ltx, ltxVideo, { slots: { ...split, videoVae: "LTX2_video_vae_bf16.safetensors" } }))).toEqual([
      "videoVae: This VAE is LTX-2's: LTX 2.3 needs LTX23_video_vae_bf16 (Settings › Models has it). [refused]",
    ]);
  });
  it("warns of LTX-2's model picked in the form, and of LTX-2's LoRA", () => {
    const found = check(ltx, ltxVideo, { slots: split, input: { model: "ltx-2-19b-dev-fp8.safetensors", loras: [{ file: "ltx-2-19b-lora-camera-control-dolly-in.safetensors", weight: 1 }] } });
    expect(texts(found)).toEqual([
      expect.stringMatching(/^model: This model is LTX-2's: LTX 2\.3 needs /),
      "loras: This LoRA was trained for LTX-2: on LTX 2.3 it may do nothing.",
    ]);
    expect(found.every((f) => !f.black)).toBe(true);
  });
});

describe("Wan 2.2's set", () => {
  const high = "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors";
  const low = "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors";
  it("passes its own pair, and a fine-tune's files it does not know", () => {
    expect(check(wan, wanVideo, { input: { model: high, modelLow: low } })).toEqual([]);
    expect(check(wan, wanVideo, { input: { model: "SmoothMix_H.safetensors", modelLow: "SmoothMix_L.safetensors" } })).toEqual([]);
  });
  it("warns of the pair swapped, by name or a renamed copy's hash", () => {
    expect(texts(check(wan, wanVideo, { input: { model: low, modelLow: high } }))).toEqual([
      "model: This model is the pair's low-noise file: the High-noise model takes the high-noise one.",
      "modelLow: This model is the pair's high-noise file: the Low-noise model takes the low-noise one.",
    ]);
    const renamed = check(wan, wanVideo, { input: { model: "a.safetensors", modelLow: low }, look: byHash({ "a.safetensors": "5471A457B6AC404202A5FBE6C11595A3D5641FC766B00F38763F72303FFFC21E" }) });
    expect(renamed.map((f) => [f.at, f.black])).toEqual([["model", false]]);
  });
  it("refuses the 5B's VAE under the 14B pair", () => {
    expect(texts(check(wan, wanVideo, { input: { model: high, modelLow: low }, slots: { vae: "wan2.2_vae.safetensors" } }))).toEqual([
      "vae: This VAE is Wan 2.2 5B's (48 channels): the 14B models need wan_2.1_vae (Settings › Models has it). [refused]",
    ]);
  });
  it("warns of a LoRA's low-noise file in the high-noise list", () => {
    const found = check(wan, wanVideo, { input: { model: high, modelLow: low, loras: [{ file: "orbit_low_noise.safetensors", weight: 1 }], lorasLow: [{ file: "orbit_low_noise.safetensors", weight: 1 }] } });
    expect(texts(found)).toEqual(["loras: This LoRA is the low-noise file of a Wan LoRA: it goes in LoRAs (low noise)."]);
    // the graph names it once; each list that holds it is held against its own place
    const both = check(wan, wanVideo, { input: { model: high, modelLow: low, loras: [{ file: "orbit_high_noise.safetensors", weight: 1 }], lorasLow: [{ file: "orbit_high_noise.safetensors", weight: 1 }] } });
    expect(texts(both)).toEqual(["lorasLow: This LoRA is the high-noise file of a Wan LoRA: it goes in LoRAs (high noise)."]);
  });
});

describe("the LoRA picker's fit", () => {
  it("puts a LoRA of another LTX version with the other models, a Wan 2.1 LoRA still with Wan 2.2", () => {
    expect(loraFit(ltx25, "ltx23_dolly.safetensors", { base: "LTX" })).toBe(-1);
    expect(loraFit(ltx25, "dolly.safetensors", { base: "LTX", civitaiBase: "LTXV2" })).toBe(-1);
    expect(loraFit(ltx25, "dolly.safetensors", { base: "LTX" })).toBe(2);
    expect(loraFit(wan, "orbit.safetensors", { base: "Wan 2.1" })).toBeGreaterThan(0);
  });
});
