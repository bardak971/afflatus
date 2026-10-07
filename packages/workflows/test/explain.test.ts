import { describe, expect, it } from "vitest";
import type { Graph } from "@afflatus/core";
import { offLine, sectionSummary, type Toggle, type Wiring } from "../src";

/** Plain words worked out from the graph: what a switch does off, what a section's nodes do. */
const graph: Graph = {
  "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "model.safetensors" } },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "a parrot", clip: ["4", 1] } },
  "5": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
  "3": { class_type: "KSampler", inputs: { seed: 1, steps: 20, cfg: 7, sampler_name: "euler", scheduler: "normal", denoise: 1, model: ["4", 0], positive: ["6", 0], negative: ["6", 0], latent_image: ["5", 0] } },
  "10": { class_type: "LatentUpscaleBy", inputs: { samples: ["3", 0], upscale_method: "nearest-exact", scale_by: 1.5 }, _meta: { title: "Upscale latent" } },
  "11": { class_type: "KSampler", inputs: { seed: 1, steps: 12, cfg: 7, sampler_name: "euler", scheduler: "normal", denoise: 0.4, model: ["4", 0], positive: ["6", 0], negative: ["6", 0], latent_image: ["10", 0] }, _meta: { title: "Hires sampler" } },
  "8": { class_type: "VAEDecode", inputs: { samples: ["11", 0], vae: ["4", 2] } },
  "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "out" } },
} as Graph;
const wiring: Wiring = {
  modes: {}, fallback: {}, labels: {}, panel: [], toggles: [], shared: {}, packs: {}, downloads: {}, links: [], optional: {}, frames: [],
  slots: {
    "10": { in: [["samples", "LATENT"]], out: ["LATENT"] },
    "11": { in: [["model", "MODEL"], ["positive", "CONDITIONING"], ["negative", "CONDITIONING"], ["latent_image", "LATENT"]], out: ["LATENT"] },
    "8": { in: [["samples", "LATENT"], ["vae", "VAE"]], out: ["IMAGE"] },
  },
};

describe("what a switch does off", () => {
  it("names the work skipped and what the node after it reads instead", () => {
    const hires: Toggle = { id: "sw_hires", label: "Hires fix", default: true, writes: [], effects: [{ nodes: ["10", "11"], activeWhen: true, mode: "skip" }] };
    expect(offLine(graph, wiring, hires)).toBe("Off: Upscale latent and Hires sampler are skipped; VAEDecode takes KSampler's output instead.");
  });
  it("says nothing for a switch that turns nothing off", () => {
    expect(offLine(graph, wiring, { id: "sw_x", label: "X", default: true, writes: [], effects: [{ nodes: ["10"], activeWhen: false, mode: "bypass" }] })).toBeNull();
  });
});

describe("what a section's nodes do", () => {
  it("in the order they run, each kind once", () => {
    expect(sectionSummary(graph, ["9", "3", "4", "11", "6"])).toBe("What it does: loads the model, encodes the prompt, samples, saves the result.");
    expect(sectionSummary(graph, [])).toBeNull();
  });
});
