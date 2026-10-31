import { describe, expect, it } from "vitest";
import { dryContext, parseInput, type BuildContext } from "@afflatus/core";
import { h3Video } from "../src/h3/video";
import { FREE_TEXT_ENCODER } from "../src/h3/condition";
import { UPSCALE } from "../src/video/upscale";
import { recipes } from "../src/index";

type Node = { class_type: string; inputs: Record<string, unknown> };
type Graph = Record<string, Node>;
const of = (graph: Graph, type: string) => Object.entries(graph).filter(([, n]) => n.class_type === type);
const idOf = (graph: Graph, type: string) => of(graph, type).map(([id]) => id);
const guiders = (graph: Graph) => of(graph, "SamplerCustomAdvanced").map(([, n]) => graph[(n.inputs.guider as [string, number])[0]]!);

const slots = {
  unet: "u.safetensors", clip: "c.safetensors", videoVae: "v.safetensors", audioVae: "a.safetensors", refUnet: "minimax_h3_ref2va.safetensors", rife: "rife.pth",
  faceRefineUnet: "minimax_h3_fused_refdelta_r1024_turbo8.safetensors", faceDetector: "bbox/face_yolov8m.pt", faceSeg: "segm/person_yolov8m-seg.pt", faceSam: "sam_vit_b_01ec64.pth",
};
const uploads = { "references.0": "person.png", start: "s.png" };
const person = [{ asset: "r1", role: "person" }];
// a pack before 0.43.0: every node but the free one
const olderPack = (n: string) => n !== FREE_TEXT_ENCODER;

function build(values: Record<string, unknown>, ctx: Partial<BuildContext> = {}) {
  return h3Video.build(parseInput(h3Video, { description: "a", ...values }), dryContext({ seed: 7, slots, uploads, media: { start: { width: 576, height: 1024 } }, ...ctx })).graph as Graph;
}

describe("MiniMax H3 · the text encoder let go before sampling (card #202)", () => {
  it("passes the clip's conditioning through the free node, on the encode's own CLIP loader, before the sampler", () => {
    const graph = build({ references: person });
    const [free] = of(graph, FREE_TEXT_ENCODER);
    expect(of(graph, FREE_TEXT_ENCODER)).toHaveLength(1);
    const [encode] = idOf(graph, "MiniMaxH3ReferenceToVideo");
    expect(free![1].inputs).toEqual({ clip: graph[encode!]!.inputs.clip, conditioning: [encode, 0] });
    expect(graph[(free![1].inputs.clip as [string, number])[0]]!.class_type).toBe("CLIPLoader");
    expect(guiders(graph)[0]!.inputs.conditioning).toEqual([free![0], 0]);
  });

  it("waits for the latent re-sample's own encode too, and hands each its own", () => {
    const graph = build({ start: "s1", seconds: 5, short: 576, upscale: UPSCALE.latent, upscaleBy: 1.5 });
    const encodes = idOf(graph, "MiniMaxH3ImageToVideo");
    expect(encodes).toHaveLength(2);
    const [[free, n]] = of(graph, FREE_TEXT_ENCODER) as [[string, Node]];
    // the clip's (with its first frame) and the prompt alone, both through the one node
    expect(graph[(n.inputs.conditioning as [string, number])[0]]!.inputs.first_frame).toBeDefined();
    expect(graph[(n.inputs.also as [string, number])[0]]!.inputs.first_frame).toBeUndefined();
    expect(of(graph, "MMH3UltimateUpscale")[0]![1].inputs.conditioning).toEqual([free, 1]);
    expect(guiders(graph)[0]!.inputs.conditioning).toEqual([free, 0]);
  });

  it("lets it go again after Face refine's encode, before the pass samples", () => {
    const graph = build({ faceRefine: true, references: person });
    const frees = of(graph, FREE_TEXT_ENCODER);
    expect(frees).toHaveLength(2);
    const encodes = idOf(graph, "MiniMaxH3ReferenceToVideo");
    expect(frees.map(([, n]) => n.inputs.conditioning)).toEqual(encodes.map((id) => [id, 0]));
    expect(guiders(graph).map((g) => g.inputs.conditioning).sort()).toEqual(frees.map(([id]) => [id, 0]).sort());
  });

  it("leaves the graph as it was on an older pack", () => {
    for (const values of [{ references: person }, { faceRefine: true, references: person }, { start: "s1", upscale: UPSCALE.latent }]) {
      const now = build(values);
      const before = build(values, { has: olderPack });
      expect(of(before, FREE_TEXT_ENCODER)).toHaveLength(0);
      expect(Object.keys(before).length).toBe(Object.keys(now).length - of(now, FREE_TEXT_ENCODER).length);
      // the samplers guided by the encodes themselves
      for (const g of guiders(before)) expect(before[(g.inputs.conditioning as [string, number])[0]]!.class_type).toMatch(/^MiniMaxH3(ReferenceToVideo|ImageToVideo|AddGuide)$/);
    }
  });

  it("is on every H3 form's sampled variants", () => {
    const forms = new Set<string>();
    for (const recipe of recipes.filter((r) => r.family === "h3")) {
      for (const v of recipe.variants) {
        const input = parseInput(recipe, v.input);
        const graph = recipe.build(input, dryContext({ slots: v.slots ?? {}, uploads: v.uploads ?? {}, media: v.media ?? {}, canvas: v.canvas, ...(v.has ? { has: v.has } : {}) })).graph as Graph;
        // a Finish › Face refine re-encodes nothing of the clip's, but its pass does
        const encodes = of(graph, "MiniMaxH3ReferenceToVideo").length + of(graph, "MiniMaxH3ImageToVideo").length;
        if (!encodes) continue;
        expect(of(graph, FREE_TEXT_ENCODER).length, `${recipe.id} · ${v.name}`).toBeGreaterThan(0);
        forms.add(recipe.id);
      }
    }
    expect([...forms].sort()).toEqual(["h3.lipsync", "h3.motion", "h3.swap", "h3.video"]);
  });
});
