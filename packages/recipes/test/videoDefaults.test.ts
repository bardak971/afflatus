import { describe, expect, it } from "vitest";
import { dryContext, parseInput } from "@afflatus/core";
import { h3Video, ltx25Video, ltxVideo, wanVideo } from "../src";

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
const of = (graph: Graph, type: string) => Object.values(graph).filter((n) => n.class_type === type);
const picture = { width: 832, height: 1216 };
const wanSlots = { i2vHigh: "h.safetensors", i2vLow: "l.safetensors", clip: "c.safetensors", vae: "v.safetensors" };
const ltxSlots = { checkpoint: "ltx-2.3-22b-distilled-fp8.safetensors", clip: "gemma.safetensors", upscaler: "ltx-2.3-spatial-upscaler-x2-1.1.safetensors" };
const h3Slots = { unet: "u.safetensors", clip: "c.safetensors", videoVae: "v.safetensors", audioVae: "a.safetensors" };

const wan = (over: Record<string, unknown>, has?: (t: string) => boolean) =>
  wanVideo.build(parseInput(wanVideo, { prompt: "a", start: "p", ...over }), dryContext({ slots: wanSlots, uploads: { start: "a.png" }, media: { start: picture }, ...(has ? { has } : {}) })).graph as Graph;
const ltx = (over: Record<string, unknown>, has?: (t: string) => boolean) =>
  ltxVideo.build(parseInput(ltxVideo, { prompt: "a", start: "p", ...over }), dryContext({ slots: ltxSlots, uploads: { start: "a.png" }, media: { start: picture }, ...(has ? { has } : {}) })).graph as Graph;
const h3 = (over: Record<string, unknown>, has?: (t: string) => boolean) =>
  h3Video.build(parseInput(h3Video, { description: "a", start: "p", ...over }), dryContext({ slots: h3Slots, uploads: { start: "a.png" }, media: { start: picture }, ...(has ? { has } : {}) })).graph as Graph;

describe("the colour match to the first frame", () => {
  it("is off by default in every video family", () => {
    expect(of(wan({}), "ColorTransfer")).toEqual([]);
    expect(of(ltx({}), "ColorTransfer")).toEqual([]);
    expect(of(h3({}), "ColorTransfer")).toEqual([]);
  });
  it("pulls the frames towards the start picture moment by moment, averaged over about a second (the node pack's Follow Colours)", () => {
    for (const graph of [wan({ colourMatch: true }), ltx({ colourMatch: true }), h3({ colourMatch: true })]) {
      const [match] = of(graph, "AfflatusColorFollow");
      expect(match?.inputs).toMatchObject({ strength: 0.75 });
      expect(match!.inputs.radius as number).toBeGreaterThanOrEqual(8);
      const ref = graph[(match!.inputs.reference as [string, number])[0]]!;
      expect(ref).toMatchObject({ class_type: "LoadImage", inputs: { image: "a.png" } });
      expect(of(graph, "ColorTransfer")).toEqual([]);
    }
  });
  it("without the node pack's Follow Colours, one transform for the whole clip", () => {
    for (const graph of [ltx({ colourMatch: true }, (t) => t !== "AfflatusColorFollow"), h3({ colourMatch: true }, (t) => t !== "AfflatusColorFollow")]) {
      const [match] = of(graph, "ColorTransfer");
      expect(match?.inputs).toMatchObject({ method: "reinhard_lab", source_stats: "uniform", strength: 0.75 });
    }
  });
  it("does nothing without a start picture or without either node", () => {
    const words = wanVideo.build(parseInput(wanVideo, { prompt: "a", colourMatch: true }), dryContext({ slots: { ...wanSlots, t2vHigh: "th.safetensors", t2vLow: "tl.safetensors" } })).graph as Graph;
    expect(of(words, "ColorTransfer")).toEqual([]);
    expect(of(words, "AfflatusColorFollow")).toEqual([]);
    const neither = ltx({ colourMatch: true }, (t) => t !== "ColorTransfer" && t !== "AfflatusColorFollow");
    expect([...of(neither, "ColorTransfer"), ...of(neither, "AfflatusColorFollow")]).toEqual([]);
  });
});

describe("a timeline's canvas", () => {
  // the canvas's own size up to the model's 720p, as Wan's: a 1080p timeline makes 704p clips, not 1088p ones
  it("is taken at its size up to 704p on LTX", () => {
    const at = (canvas: { width: number; height: number }) => of(ltxVideo.build(parseInput(ltxVideo, { prompt: "a", start: "p" }), dryContext({ slots: ltxSlots, uploads: { start: "a.png" }, media: { start: picture }, canvas })).graph as Graph, "EmptyLTXVLatentVideo")[0]!.inputs;
    expect(at({ width: 1080, height: 1920 })).toMatchObject({ width: 352, height: 640 });
    expect(at({ width: 576, height: 1024 })).toMatchObject({ width: 288, height: 512 });
  });
});

describe("NAG on LTX", () => {
  it("is off by default, and on it patches the model every pass samples with, fed the negative", () => {
    expect(of(ltx({}), "LTX2_NAG")).toEqual([]);
    const graph = ltx({ nag: true });
    const nags = Object.entries(graph).filter(([, n]) => n.class_type === "LTX2_NAG");
    expect(nags.length).toBeGreaterThanOrEqual(1);
    expect(nags[0]![1].inputs).toMatchObject({ nag_scale: 11, nag_alpha: 0.25, nag_tau: 2.5 });
    const guided = of(graph, "CFGGuider").map((n) => (n.inputs.model as [string, number])[0]);
    for (const id of guided) expect(graph[id]!.class_type).toBe("LTX2_NAG");
  });
  it("stays out above CFG 1, without a negative, or without KJNodes", () => {
    expect(of(ltx({ nag: true, cfg: 3 }), "LTX2_NAG")).toEqual([]);
    expect(of(ltx({ nag: true, negative: "" }), "LTX2_NAG")).toEqual([]);
    expect(of(ltx({ nag: true }, (t) => t !== "LTX2_NAG"), "LTX2_NAG")).toEqual([]);
  });
});

describe("H3's re-sample defaults", () => {
  it("start light: 0.15 in 2 steps (near sigma 0.66 at shift 11)", () => {
    const parsed = parseInput(h3Video, { description: "a" }) as { upscaleDenoise: number; upscaleSteps: number };
    expect(parsed.upscaleDenoise).toBe(0.15);
    expect(parsed.upscaleSteps).toBe(2);
  });
});

describe("LTX 2.5", () => {
  // as ComfyUI's own template (2026-10-15): split files with the projection inside the Gemma 4 file, euler_ancestral in both
  // passes on LTX's schedules, the dual CFG guider at 1 and 1, 24 frames a second, the decoder's tiles 512 / 64 / 16
  const slots = { unet: "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors", clip: "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors", videoVae: "ltx-2.5-video-vae-bf16.safetensors", audioVae: "ltx-2.5-audio-vae-bf16.safetensors", upscaler: "ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors" };
  const b = ltx25Video.build(parseInput(ltx25Video, { prompt: "a", start: "p" }), dryContext({ slots, uploads: { start: "a.png" }, media: { start: picture } }));
  const graph = b.graph as Graph;
  it("loads its split files, the text encoder as one file", () => {
    expect(of(graph, "CLIPLoader")[0]!.inputs).toMatchObject({ clip_name: slots.clip, type: "ltxv" });
    expect(of(graph, "DualCLIPLoader")).toEqual([]);
    expect(of(graph, "CheckpointLoaderSimple")).toEqual([]);
    expect(of(graph, "UNETLoader")[0]!.inputs.unet_name).toBe(slots.unet);
    expect(of(graph, "LoraLoaderModelOnly")).toEqual([]);
  });
  it("samples both passes with euler_ancestral on LTX's schedules, through the dual CFG guider at 1 and 1", () => {
    expect(of(graph, "KSamplerSelect").map((n) => n.inputs.sampler_name)).toEqual(["euler_ancestral"]);
    expect(of(graph, "CFGGuider")).toEqual([]);
    expect(of(graph, "LTXVDualCFGGuider").map((n) => [n.inputs.video_cfg, n.inputs.audio_cfg])).toEqual([[1, 1], [1, 1]]);
    expect(of(graph, "ManualSigmas").map((n) => n.inputs.sigmas)).toEqual(["1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0", "0.85, 0.725, 0.4219, 0.0"]);
    expect(of(graph, "LTXVImgToVideoInplace").map((n) => n.inputs.strength)).toEqual([0.7, 1]);
  });
  it("runs at 24 frames a second, 5 s being 121 frames, and decodes in the template's tiles", () => {
    expect(of(graph, "LTXVConditioning")[0]!.inputs.frame_rate).toBe(24);
    expect(of(graph, "EmptyLTXVLatentVideo")[0]!.inputs.length).toBe(121);
    expect(of(graph, "LTXVEmptyLatentAudio")[0]!.inputs).toMatchObject({ frames_number: 121, frame_rate: 24 });
    expect(of(graph, "VAEDecodeTiled")[0]!.inputs).toMatchObject({ tile_size: 512, temporal_size: 64, temporal_overlap: 16 });
    expect(of(graph, "VHS_VideoCombine")[0]!.inputs.frame_rate).toBe(24);
    expect(b.loads).toEqual(expect.arrayContaining([`diffusion_models/${slots.unet}`, `text_encoders/${slots.clip}`, `vae/${slots.videoVae}`, `vae/${slots.audioVae}`]));
  });
  it("offers no NAG, and refuses without its parts", () => {
    expect(ltx25Video.inputs.some((i) => i.id === "nag")).toBe(false);
    expect(() => ltx25Video.build(parseInput(ltx25Video, { prompt: "a" }), dryContext({ slots: { unet: slots.unet, clip: slots.clip } }))).toThrow(/video VAE/);
  });
});
