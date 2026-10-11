import { describe, expect, it } from "vitest";
import { dryContext, parseInput } from "@afflatus/core";
import { h3Video, ltxVideo, wanVideo } from "../src";

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
const h3 = (over: Record<string, unknown>) =>
  h3Video.build(parseInput(h3Video, { description: "a", start: "p", ...over }), dryContext({ slots: h3Slots, uploads: { start: "a.png" }, media: { start: picture } })).graph as Graph;

describe("the colour match to the first frame", () => {
  it("is off by default in every video family", () => {
    expect(of(wan({}), "ColorTransfer")).toEqual([]);
    expect(of(ltx({}), "ColorTransfer")).toEqual([]);
    expect(of(h3({}), "ColorTransfer")).toEqual([]);
  });
  it("pulls the frames towards the start picture with one transform for the whole clip", () => {
    for (const graph of [wan({ colourMatch: true }), ltx({ colourMatch: true }), h3({ colourMatch: true })]) {
      const [match] = of(graph, "ColorTransfer");
      expect(match?.inputs).toMatchObject({ method: "reinhard_lab", source_stats: "uniform", strength: 0.75 });
      const ref = graph[(match!.inputs.image_ref as [string, number])[0]]!;
      expect(ref).toMatchObject({ class_type: "LoadImage", inputs: { image: "a.png" } });
    }
  });
  it("does nothing without a start picture or without the node", () => {
    const words = wanVideo.build(parseInput(wanVideo, { prompt: "a", colourMatch: true }), dryContext({ slots: { ...wanSlots, t2vHigh: "th.safetensors", t2vLow: "tl.safetensors" } })).graph as Graph;
    expect(of(words, "ColorTransfer")).toEqual([]);
    expect(of(ltx({ colourMatch: true }, (t) => t !== "ColorTransfer"), "ColorTransfer")).toEqual([]);
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
  it("start light: 0.15 in 2 steps (near sigma 0.66 at shift 11, what DaSiWa's tiled upscaler runs)", () => {
    const parsed = parseInput(h3Video, { description: "a" }) as { upscaleDenoise: number; upscaleSteps: number };
    expect(parsed.upscaleDenoise).toBe(0.15);
    expect(parsed.upscaleSteps).toBe(2);
  });
});
