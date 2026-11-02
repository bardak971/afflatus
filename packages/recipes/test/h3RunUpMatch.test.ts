import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkGraph, dryContext, parseInput, type BuildContext, type NodeCatalog } from "@afflatus/core";
import { describe, expect, it } from "vitest";
import { H3_RUN_ANCHOR, H3_RUNUP_MATCH } from "../src/h3/join";
import { h3Video } from "../src/h3/video";
import { UPSCALE } from "../src/video/upscale";

const catalog = JSON.parse(readFileSync(fileURLToPath(new URL("../../../reference/comfy-object-info.json", import.meta.url)), "utf-8")) as NodeCatalog;

type Node = { class_type: string; inputs: Record<string, unknown> };
type Graph = Record<string, Node>;
const of = (graph: Graph, type: string) => Object.entries(graph).filter(([, n]) => n.class_type === type);
const idOf = (graph: Graph, type: string) => of(graph, type).map(([id]) => id);

const slots = {
  unet: "u.safetensors", clip: "c.safetensors", videoVae: "v.safetensors", audioVae: "a.safetensors", refUnet: "minimax_h3_ref2va.safetensors",
  faceRefineUnet: "minimax_h3_fused_refdelta_r1024_turbo8.safetensors", faceDetector: "bbox/face_yolov8m.pt", faceSeg: "segm/person_yolov8m-seg.pt", faceSam: "sam_vit_b_01ec64.pth",
};
const joined = { width: 576, height: 1024, frames: 22, fps: 24, hasSound: true, latentFrames: 124 };
const continued = { previous: "a.mp4", "previous.latent": "a.safetensors [temp]" };

// a pack of 0.45: the match alone, before Run Anchor (0.46.0, card #215) came after it (h3RunAnchor.test.ts)
const pack045 = (c: string) => c !== H3_RUN_ANCHOR;

function build(values: Record<string, unknown>, ctx: Partial<BuildContext> = {}, uploads: Record<string, string> = continued) {
  const built = h3Video.build(parseInput(h3Video, { description: "a", seconds: 5, previous: { asset: "c1" }, ...values }), dryContext({ seed: 7, slots, uploads, media: { previous: joined }, has: pack045, ...ctx }));
  return { built, graph: built.graph as Graph };
}

describe("MiniMax H3 · a continuation held at the clip before's contrast (card #212), on a pack of 0.45", () => {
  it("matches the sampled window to the clip before's tail, and the seam, the decode and the kept latent read the matched window", () => {
    const { built, graph } = build({});
    const [[match, n]] = of(graph, H3_RUNUP_MATCH) as [[string, Node]];
    const [loaded] = idOf(graph, "AfflatusLoadH3Latent");
    const [sampled] = idOf(graph, "SamplerCustomAdvanced");
    // the clip before's latent as the window was made from it, the window as sampled, the run-up's length
    expect(n.inputs).toEqual({ previous_av_latent: [loaded, 0], sampled_window: [sampled, 0], overlap_frames: 22 });
    // nothing reads the window as sampled but the match: the seam (so the decode) and the latent kept for the clip after
    const [[seam, seamNode]] = of(graph, "AfflatusH3SeamLatent") as [[string, Node]];
    expect(seamNode.inputs.sampled_window).toEqual([match, 0]);
    expect(of(graph, "VAEDecode")[0]![1].inputs.samples).toEqual([seam, 0]);
    expect(of(graph, "AfflatusNormalizeH3Latent")[0]![1].inputs.samples).toEqual([match, 0]);
    const readers = Object.values(graph).filter((x) => Object.values(x.inputs).some((v) => Array.isArray(v) && v[0] === sampled));
    expect(readers.map((x) => x.class_type)).toEqual([H3_RUNUP_MATCH]);
    // still a seamless join
    expect(built.overlap).toEqual({ headMs: 917, tailMs: 0, latent: true, seam: true });
    expect(checkGraph(built, catalog)).toEqual([]);
  });

  it("reaches the latent re-sample and the model's own frames beside it", () => {
    const { built, graph } = build({ short: 576, upscale: UPSCALE.latent, upscaleBy: 2 });
    const [match] = idOf(graph, H3_RUNUP_MATCH);
    expect(match).toBeDefined();
    const [[seam, seamNode]] = of(graph, "AfflatusH3SeamLatent") as [[string, Node]];
    expect(seamNode.inputs.sampled_window).toEqual([match, 0]);
    expect(of(graph, "MMH3UltimateUpscale")[0]![1].inputs.latent).toEqual([seam, 0]);
    // the raw side file: the matched window decoded as it is
    expect(of(graph, "VAEDecode").map(([, x]) => x.inputs.samples)).toContainEqual([match, 0]);
    expect(of(graph, "AfflatusNormalizeH3Latent")[0]![1].inputs.samples).toEqual([match, 0]);
    expect(checkGraph(built, catalog)).toEqual([]);
  });

  it("reaches the kept latent through Face refine's re-encode", () => {
    const { graph } = build({ faceRefine: true, references: [{ asset: "r1", role: "person" }] }, {}, { ...continued, "references.0": "person.png" });
    const [match] = idOf(graph, H3_RUNUP_MATCH);
    const kept = graph[(of(graph, "AfflatusNormalizeH3Latent")[0]![1].inputs.samples as [string, number])[0]]!;
    expect(kept.class_type).toBe("AfflatusH3InjectRegion");
    expect(kept.inputs.av_latent).toEqual([match, 0]);
  });

  it("is not there for a clip that opens a chain, a join from frames, or a finish of a draft's kept latent", () => {
    const first = h3Video.build(parseInput(h3Video, { description: "a", seconds: 5 }), dryContext({ slots })).graph as Graph;
    expect(of(first, H3_RUNUP_MATCH)).toHaveLength(0);
    expect(of(build({ joinFrom: "Frames" }).graph, H3_RUNUP_MATCH)).toHaveLength(0);
    // a finish re-samples the draft's latent as it was approved (matched already when made with the node)
    const { graph } = build({ short: 576, upscale: UPSCALE.latent, upscaleBy: 2 }, {}, { ...continued, "self.latent": "own.safetensors" });
    expect(of(graph, H3_RUNUP_MATCH)).toHaveLength(0);
    const own = of(graph, "AfflatusLoadH3Latent").find(([, x]) => x.inputs.latent === "own.safetensors")![0];
    expect(of(graph, "AfflatusH3SeamLatent")[0]![1].inputs.sampled_window).toEqual([own, 0]);
    expect(of(graph, "AfflatusNormalizeH3Latent")[0]![1].inputs.samples).toEqual([own, 0]);
  });

  it("leaves the graph as it was on a pack without the node (before 0.45.0)", () => {
    const now = build({}).graph;
    const { graph } = build({}, { has: (c) => pack045(c) && c !== H3_RUNUP_MATCH });
    expect(of(graph, H3_RUNUP_MATCH)).toHaveLength(0);
    expect(Object.keys(graph)).toHaveLength(Object.keys(now).length - 1);
    const [sampled] = idOf(graph, "SamplerCustomAdvanced");
    expect(of(graph, "AfflatusH3SeamLatent")[0]![1].inputs.sampled_window).toEqual([sampled, 0]);
    expect(of(graph, "AfflatusNormalizeH3Latent")[0]![1].inputs.samples).toEqual([sampled, 0]);
  });
});
