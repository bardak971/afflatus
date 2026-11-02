import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkGraph, dryContext, parseInput, type BuildContext, type NodeCatalog } from "@afflatus/core";
import { describe, expect, it } from "vitest";
import { H3_RUN_ANCHOR, H3_RUNUP_MATCH, H3_TRIM } from "../src/h3/join";
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

function build(values: Record<string, unknown>, ctx: Partial<BuildContext> = {}, uploads: Record<string, string> = continued) {
  const built = h3Video.build(parseInput(h3Video, { description: "a", seconds: 5, previous: { asset: "c1" }, ...values }), dryContext({ seed: 7, slots, uploads, media: { previous: joined }, ...ctx }));
  return { built, graph: built.graph as Graph };
}

describe("MiniMax H3 · a continuation held to its run's first clip (card #215)", () => {
  it("holds the matched window to the run the clip before carries, and the seam, the decode and the kept latent read it", () => {
    const { built, graph } = build({});
    const [[anchor, n]] = of(graph, H3_RUN_ANCHOR) as [[string, Node]];
    const [loaded] = idOf(graph, "AfflatusLoadH3Latent");
    const [match] = idOf(graph, H3_RUNUP_MATCH);
    // the clip before's latent (the run's look rides in it, or is read on it), the window matched to the clip before first
    expect(n.inputs).toEqual({ previous_av_latent: [loaded, 0], sampled_window: [match, 0], overlap_frames: 22 });
    const [[seam, seamNode]] = of(graph, "AfflatusH3SeamLatent") as [[string, Node]];
    expect(seamNode.inputs.sampled_window).toEqual([anchor, 0]);
    expect(of(graph, "VAEDecode")[0]![1].inputs.samples).toEqual([seam, 0]);
    // the kept latent: the run's look goes on with it to the clip after (no re-encode here to take it from elsewhere)
    expect(of(graph, "AfflatusNormalizeH3Latent")[0]![1].inputs).toEqual({ samples: [anchor, 0] });
    // nothing reads the match but the anchor
    const readers = Object.values(graph).filter((x) => Object.values(x.inputs).some((v) => Array.isArray(v) && v[0] === match));
    expect(readers.map((x) => x.class_type)).toEqual([H3_RUN_ANCHOR]);
    expect(built.overlap).toEqual({ headMs: 917, tailMs: 0, latent: true, seam: true });
    expect(checkGraph(built, catalog)).toEqual([]);
  });

  it("reads the run on the clip before as it was handed over, when it was cut early", () => {
    const { graph } = build({}, { media: { previous: { ...joined, latentCut: 39 } } });
    const [trim] = idOf(graph, H3_TRIM);
    expect(of(graph, H3_RUN_ANCHOR)[0]![1].inputs.previous_av_latent).toEqual([trim, 0]);
  });

  it("reaches the latent re-sample and the model's own frames beside it", () => {
    const { built, graph } = build({ short: 576, upscale: UPSCALE.latent, upscaleBy: 2 });
    const [anchor] = idOf(graph, H3_RUN_ANCHOR);
    const [[seam, seamNode]] = of(graph, "AfflatusH3SeamLatent") as [[string, Node]];
    expect(seamNode.inputs.sampled_window).toEqual([anchor, 0]);
    expect(of(graph, "MMH3UltimateUpscale")[0]![1].inputs.latent).toEqual([seam, 0]);
    expect(of(graph, "VAEDecode").map(([, x]) => x.inputs.samples)).toContainEqual([anchor, 0]);
    expect(of(graph, "AfflatusNormalizeH3Latent")[0]![1].inputs.samples).toEqual([anchor, 0]);
    expect(checkGraph(built, catalog)).toEqual([]);
  });

  it("keeps the run's look through Face refine's re-encode (of the face's region, card #225), which hands on its samples alone", () => {
    const { built, graph } = build({ faceRefine: true, references: [{ asset: "r1", role: "person" }] }, {}, { ...continued, "references.0": "person.png" });
    const [anchor] = idOf(graph, H3_RUN_ANCHOR);
    const normalize = of(graph, "AfflatusNormalizeH3Latent")[0]![1];
    const kept = graph[(normalize.inputs.samples as [string, number])[0]]!;
    expect(kept.class_type).toBe("AfflatusH3InjectRegion");
    expect(kept.inputs.av_latent).toEqual([anchor, 0]);
    expect(normalize.inputs.figures_from).toEqual([anchor, 0]);
    expect(checkGraph(built, catalog)).toEqual([]);
  });

  it("is not there for a clip that opens a chain (it starts a run), a join from frames, or a finish of a draft's kept latent", () => {
    const first = h3Video.build(parseInput(h3Video, { description: "a", seconds: 5 }), dryContext({ slots })).graph as Graph;
    expect(of(first, H3_RUN_ANCHOR)).toHaveLength(0);
    expect(of(build({ joinFrom: "Frames" }).graph, H3_RUN_ANCHOR)).toHaveLength(0);
    // a finish re-samples the draft's latent as it was approved, its run's look loaded with it and kept on
    const { graph } = build({ short: 576, upscale: UPSCALE.latent, upscaleBy: 2 }, {}, { ...continued, "self.latent": "own.safetensors" });
    expect(of(graph, H3_RUN_ANCHOR)).toHaveLength(0);
    const own = of(graph, "AfflatusLoadH3Latent").find(([, x]) => x.inputs.latent === "own.safetensors")![0];
    expect(of(graph, "AfflatusNormalizeH3Latent")[0]![1].inputs).toEqual({ samples: [own, 0] });
  });

  it("is not there for a clip that lands on the clip after: its end is that clip's own frames, held as they are", () => {
    const landed = { ...continued, next: "b.mp4", "next.latent": "b.safetensors [temp]" };
    // landed on in the latent, from the clip after's first frame or where one of its chunks begins, or by its frames
    for (const latentAt of [0, 34, 22]) {
      const { built, graph } = build({ next: { asset: "c2" } }, { media: { previous: joined, next: { ...joined, latentAt } } }, landed);
      expect(of(graph, H3_RUN_ANCHOR)).toHaveLength(0);
      const [match] = idOf(graph, H3_RUNUP_MATCH);
      expect(of(graph, "AfflatusH3SeamLatent")[0]![1].inputs.sampled_window).toEqual([match, 0]);
      expect(checkGraph(built, catalog)).toEqual([]);
    }
  });

  it("a finish by Face refine alone keeps the draft's look through the re-encode", () => {
    const { graph } = build({ faceRefine: true, faceRefineOnly: true, references: [{ asset: "r1", role: "person" }] }, {}, { ...continued, "references.0": "person.png", "self.latent": "own.safetensors" });
    const own = of(graph, "AfflatusLoadH3Latent").find(([, x]) => x.inputs.latent === "own.safetensors")![0];
    const normalize = of(graph, "AfflatusNormalizeH3Latent")[0]![1];
    expect(graph[(normalize.inputs.samples as [string, number])[0]]!.class_type).toBe("AfflatusH3InjectRegion");
    expect(normalize.inputs.figures_from).toEqual([own, 0]);
  });

  it("leaves the graph as on 0.45 on a pack without the node: the match alone, and nothing more for Normalize", () => {
    const now = build({}).graph;
    const { graph } = build({}, { has: (c) => c !== H3_RUN_ANCHOR });
    expect(of(graph, H3_RUN_ANCHOR)).toHaveLength(0);
    expect(Object.keys(graph)).toHaveLength(Object.keys(now).length - 1);
    const [match] = idOf(graph, H3_RUNUP_MATCH);
    expect(of(graph, "AfflatusH3SeamLatent")[0]![1].inputs.sampled_window).toEqual([match, 0]);
    expect(of(graph, "AfflatusNormalizeH3Latent")[0]![1].inputs.samples).toEqual([match, 0]);
    const refined = build({ faceRefine: true, references: [{ asset: "r1", role: "person" }] }, { has: (c) => c !== H3_RUN_ANCHOR }, { ...continued, "references.0": "person.png" }).graph;
    expect(of(refined, "AfflatusNormalizeH3Latent")[0]![1].inputs.figures_from).toBeUndefined();
  });
});

// code review 2026-11-02, finding 13: Run-up Match divided a landed end's fine detail too, and Run Anchor moved an End frame
// picture's pinned last frame
describe("MiniMax H3 · a window that ends on frames of its own keeps them (card #234)", () => {
  // the inputs each node takes, as the server reads them from the machine's catalog (inputsIn)
  const takes = (node: string) => {
    const n = (catalog as Record<string, { input?: { required?: object; optional?: object } }>)[node];
    return n ? [...Object.keys(n.input?.required ?? {}), ...Object.keys(n.input?.optional ?? {})] : null;
  };
  const landed = { ...continued, next: "b.mp4", "next.latent": "b.safetensors [temp]" };
  const matchOf = (graph: Graph) => of(graph, H3_RUNUP_MATCH)[0]![1].inputs;

  it("fades Run-up Match out over a landing's tail, the clip after's own frames", () => {
    for (const frames of [5, 22, 39]) {
      const { built, graph } = build({ next: { asset: "c2" } }, { inputs: takes, media: { previous: joined, next: { ...joined, frames } } }, landed);
      expect(matchOf(graph).end_frames).toBe(frames);
      expect(checkGraph(built, catalog)).toEqual([]);
    }
  });

  it("holds a continuation's End frame picture: Run Anchor left out, Run-up Match faded out over its end", () => {
    const { built, graph } = build({ end: "e1" }, { inputs: takes }, { ...continued, end: "e.png" });
    expect(of(graph, "MiniMaxH3ImageToVideo")[0]![1].inputs.last_frame).toBeDefined();
    expect(of(graph, H3_RUN_ANCHOR)).toHaveLength(0);
    expect(matchOf(graph).end_frames).toBe(22);
    const [match] = idOf(graph, H3_RUNUP_MATCH);
    expect(of(graph, "AfflatusNormalizeH3Latent")[0]![1].inputs.samples).toEqual([match, 0]);
    expect(checkGraph(built, catalog)).toEqual([]);
  });

  it("corrects a plain continuation's whole window as before, and sends an older pack's node nothing it does not take", () => {
    expect(matchOf(build({}, { inputs: takes }).graph).end_frames).toBeUndefined();
    const older = (node: string) => (node === H3_RUNUP_MATCH ? ["previous_av_latent", "sampled_window", "overlap_frames"] : takes(node));
    expect(matchOf(build({ next: { asset: "c2" } }, { inputs: older, media: { previous: joined, next: joined } }, landed).graph).end_frames).toBeUndefined();
    // (not known: what the node took before 0.49.3)
    expect(matchOf(build({ end: "e1" }, {}, { ...continued, end: "e.png" }).graph).end_frames).toBeUndefined();
  });
});
