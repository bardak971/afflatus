import { describe, expect, it } from "vitest";
import type { Graph } from "@afflatus/core";
import { suggestSections, type Wiring } from "../src";

/**
 * A first arrangement from the author's frames: sections in reading order, a switch for a pass the
 * output can do without, nothing for a frame with nothing of the form in it, nothing at all without frames.
 */
const graph: Graph = {
  "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "model.safetensors" } },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "a parrot", clip: ["4", 1] } },
  "5": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
  "3": { class_type: "KSampler", inputs: { seed: 1, steps: 20, cfg: 7, sampler_name: "euler", scheduler: "normal", denoise: 1, model: ["4", 0], positive: ["6", 0], negative: ["6", 0], latent_image: ["5", 0] } },
  "10": { class_type: "LatentUpscaleBy", inputs: { samples: ["3", 0], upscale_method: "nearest-exact", scale_by: 1.5 } },
  "11": { class_type: "KSampler", inputs: { seed: 1, steps: 12, cfg: 7, sampler_name: "euler", scheduler: "normal", denoise: 0.4, model: ["4", 0], positive: ["6", 0], negative: ["6", 0], latent_image: ["10", 0] } },
  "8": { class_type: "VAEDecode", inputs: { samples: ["11", 0], vae: ["4", 2] } },
  "20": { class_type: "ImageScaleBy", inputs: { image: ["8", 0], upscale_method: "lanczos", scale_by: 2 } },
  "21": { class_type: "SeedVR2VideoUpscaler", inputs: { images: ["20", 0], resolution: 2160 } },
  "9": { class_type: "SaveImage", inputs: { images: ["21", 0], filename_prefix: "out" } },
};
const slots: Wiring["slots"] = {
  "10": { in: [["samples", "LATENT"]], out: ["LATENT"] },
  "11": { in: [["model", "MODEL"], ["positive", "CONDITIONING"], ["negative", "CONDITIONING"], ["latent_image", "LATENT"]], out: ["LATENT"] },
  "8": { in: [["samples", "LATENT"], ["vae", "VAE"]], out: ["IMAGE"] },
  "20": { in: [["image", "IMAGE"]], out: ["IMAGE"] },
  "21": { in: [["images", "IMAGE"]], out: ["IMAGE"] },
  "9": { in: [["images", "IMAGE"]], out: [] },
  "3": { in: [["model", "MODEL"], ["positive", "CONDITIONING"], ["negative", "CONDITIONING"], ["latent_image", "LATENT"]], out: ["LATENT"] },
};
const wiring = (frames: Wiring["frames"]): Wiring => ({ modes: {}, slots, fallback: {}, labels: {}, panel: [], toggles: [], shared: {}, packs: {}, downloads: {}, links: [], optional: {}, frames });
const frames: Wiring["frames"] = [
  // laid out right to left in the file's order, to show the boxes decide
  { title: "Save With Meta Data", nodes: ["9"], box: [3000, 0, 300, 300] },
  { title: "4K pass", nodes: ["20", "21"], box: [2000, 0, 400, 300] },
  { title: "2nd Pass", nodes: ["10", "11"], box: [1000, 0, 400, 300] },
  { title: "1st Pass", nodes: ["5", "3"], box: [500, 0, 400, 300] },
  { title: "Models and Prompts", nodes: ["4", "6"], box: [0, 0, 400, 300] },
  { title: "🔗 Patreon: https://example.org/x", nodes: ["4"], box: [0, 400, 400, 100] },
];
const placeables = [
  { id: "ctl_3_steps", node: "3" }, { id: "ctl_3_cfg", node: "3" }, { id: "size", node: "5" }, { id: "seed", node: "3" },
  { id: "ctl_10_scale_by", node: "10" }, { id: "ctl_11_denoise", node: "11" }, { id: "ctl_21_resolution", node: "21" },
  { id: "ctl_4_ckpt_name", node: "4" }, { id: "negative", node: "6" }, { id: "ctl_99_loose" },
];

describe("a first arrangement from the author's frames", () => {
  const s = suggestSections(graph, wiring(frames), "9", placeables);

  it("makes sections in reading order, switches for the passes the output can do without, and leaves notes and empty frames alone", () => {
    expect(s.sections.map((x) => x.label)).toEqual(["Models and Prompts", "1st Pass", "2nd Pass", "4K pass"]);
    // the base pass is never a switch; the second pass and the 4K pass are
    // the settings keep the form's order within a section
    expect(s.sections[1]!.items).toEqual(["ctl_3_steps", "ctl_3_cfg", "size", "seed"]);
    expect(s.sections[2]!.items).toEqual([{ toggle: s.toggles[0]!.id, items: ["ctl_10_scale_by", "ctl_11_denoise"] }]);
    expect(s.sections[3]!.items).toEqual([{ toggle: s.toggles[1]!.id, items: ["ctl_21_resolution"] }]);
    expect(s.toggles.map((t) => [t.label, t.default, t.made, t.effects[0]!.nodes])).toEqual([["2nd Pass", true, true, ["10", "11"]], ["4K pass", true, true, ["20", "21"]]]);
    // the frame with the output and nothing of the form in it, and the link frame, are left alone
    expect(s.why.find((w) => w.startsWith('"Save With Meta Data"'))).toMatch(/left alone/);
    expect(s.why.some((w) => w.includes("Patreon"))).toBe(false);
    expect(s.why.at(-1)).toMatch(/1 setting in no frame/);
  });

  it("says so when there is nothing to go by", () => {
    const none = suggestSections(graph, wiring([]), "9", placeables);
    expect(none.sections).toEqual([]);
    expect(none.why).toEqual(["This workflow has no frames to go by: nothing to suggest. Arrange it by hand."]);
  });

  it("makes no switch of a frame whose bypass would cut the output", () => {
    // the decoder alone in a frame: bypassed, nothing of image type reaches the saver
    const odd = suggestSections(graph, wiring([{ title: "Decode", nodes: ["8"], box: [0, 0, 1, 1] }]), "9", [{ id: "ctl_8_x", node: "8" }]);
    expect(odd.sections[0]!.items).toEqual(["ctl_8_x"]);
    expect(odd.toggles).toEqual([]);
  });
});
