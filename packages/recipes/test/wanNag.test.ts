import { describe, expect, it } from "vitest";
import { dryContext, parseInput } from "@afflatus/core";
import { wanVideo } from "../src";

const slots = {
  i2vHigh: "h.safetensors", i2vLow: "l.safetensors", clip: "c.safetensors", vae: "v.safetensors",
  i2vTurboHigh: "i2v_lightx2v_high.safetensors", i2vTurboLow: "i2v_lightx2v_low.safetensors",
};
const build = (over: Record<string, unknown>, has: (t: string) => boolean = () => true) =>
  wanVideo.build(parseInput(wanVideo, { prompt: "a", start: "p", ...over }), dryContext({ slots, uploads: { start: "a.png" }, media: { start: { width: 720, height: 1280 } }, has })).graph;
const nodes = (graph: Record<string, { class_type: string; inputs: Record<string, unknown> }>, type: string) => Object.entries(graph).filter(([, n]) => n.class_type === type);

describe("wan.video: NAG gives Turbo a negative prompt", () => {
  it("puts WanVideoNAG on both models Turbo runs at CFG 1, fed by the negative, and the samplers on them", () => {
    const graph = build({ fast: true, turboHybrid: false });
    const nags = nodes(graph, "WanVideoNAG");
    expect(nags).toHaveLength(2);
    expect(nags[0]![1].inputs).toMatchObject({ nag_scale: 11, nag_alpha: 0.25, nag_tau: 2.5 });
    const samplers = nodes(graph, "KSamplerAdvanced").map(([, n]) => (n.inputs.model as [string, number])[0]);
    expect(samplers.sort()).toEqual(nags.map(([id]) => id).sort());
    // the negative it reads is the one the samplers are given
    const negatives = new Set(nodes(graph, "KSamplerAdvanced").map(([, n]) => JSON.stringify(n.inputs.negative)));
    expect([...negatives]).toEqual([JSON.stringify(nags[0]![1].inputs.conditioning)]);
  });
  it("leaves the hybrid lead alone: it runs at full CFG, where the negative acts already", () => {
    const graph = build({ fast: true, turboHybrid: true, turboSteps: 6 });
    const lead = nodes(graph, "KSamplerAdvanced").find(([, n]) => n.inputs.start_at_step === 0)!;
    expect(graph[(lead[1].inputs.model as [string, number])[0]]!.class_type).not.toBe("WanVideoNAG");
    expect(nodes(graph, "WanVideoNAG")).toHaveLength(2);
  });
  it("is not there at full steps, when switched off, without a negative, or without KJNodes", () => {
    expect(nodes(build({ fast: false }), "WanVideoNAG")).toEqual([]);
    expect(nodes(build({ fast: true, nag: false }), "WanVideoNAG")).toEqual([]);
    expect(nodes(build({ fast: true, negative: " " }), "WanVideoNAG")).toEqual([]);
    expect(nodes(build({ fast: true }, (t) => t !== "WanVideoNAG"), "WanVideoNAG")).toEqual([]);
  });
});
