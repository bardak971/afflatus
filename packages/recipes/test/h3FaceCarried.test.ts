import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkGraph, dryContext, parseInput, type BuildContext, type MediaFacts, type NodeCatalog } from "@afflatus/core";
import { describe, expect, it } from "vitest";
import { H3_FPS } from "../src/h3/family";
import { FACE_REFINE_SLOTS } from "../src/h3/faceRefine";
import { h3LipSync } from "../src/h3/lipsync";
import { h3MotionTransfer } from "../src/h3/motionTransfer";
import { h3Swap } from "../src/h3/swap";
import { h3Video } from "../src/h3/video";

const catalog = JSON.parse(readFileSync(fileURLToPath(new URL("../../../reference/comfy-object-info.json", import.meta.url)), "utf-8")) as NodeCatalog;

type Node = { class_type: string; inputs: Record<string, unknown> };
type Graph = Record<string, Node>;
const of = (graph: Graph, type: string) => Object.entries(graph).filter(([, n]) => n.class_type === type);
const node = (graph: Graph, ref: unknown) => graph[(ref as [string, number])[0]]!;
/** The clip's own reference start, not Face refine's (whose prompt is the face close-up), or undefined on the frames route. */
const ownStart = (graph: Graph) => of(graph, "MiniMaxH3ReferenceToVideo").find(([, n]) => !String(n.inputs.prompt).startsWith("Close-up of the face"))?.[1];
const promptOf = (graph: Graph) => String(ownStart(graph)!.inputs.prompt);
/** The pictures the clip's own sampling is given, by file; null on the frames-and-words route. */
const sampledFiles = (graph: Graph) => {
  const start = ownStart(graph);
  return start ? Object.entries(start.inputs).filter(([k]) => k.startsWith("ref_images.")).map(([, v]) => node(graph, v).inputs.image) : null;
};
/** The picture Face refine follows and draws towards, or null without the pass. */
const refinedTowards = (graph: Graph) => {
  const track = of(graph, "H3FaceTrackCrop")[0]?.[1];
  return track ? node(graph, node(graph, track.inputs.identity_reference).inputs.image).inputs.image : null;
};

const slots = {
  unet: "u.safetensors", clip: "c.safetensors", videoVae: "v.safetensors", audioVae: "a.safetensors", refUnet: "minimax_h3_ref2va.safetensors",
  swapLora: "swap.safetensors", swapUnet: "minimax_h3_fused_refdelta_r1024_turbo8.safetensors", swapSam: "sam3.1.safetensors",
  h3Control: "minimax_h3_fun_controlnet_union_2.0.safetensors", sdpose: "sdpose.safetensors", rtdetr: "rt_detr.safetensors",
  ...FACE_REFINE_SLOTS,
};
const joined: MediaFacts = { width: 576, height: 1024, frames: 22, fps: H3_FPS, hasSound: true, latentFrames: 124 };
const continued = { previous: "a.mp4", "previous.latent": "a.safetensors [temp]", "references.0": "r1.png" };

function build(values: Record<string, unknown>, ctx: Partial<BuildContext> = {}, uploads: Record<string, string> = continued) {
  const input = parseInput(h3Video, { description: "She walks on along the beach.", seconds: 5, previous: { asset: "c1" }, references: [{ asset: "r1", role: "person" }], ...values });
  const built = h3Video.build(input, dryContext({ seed: 7, slots, uploads, media: { previous: joined }, ...ctx }));
  return { built, graph: built.graph as Graph };
}

describe("MiniMax H3 · a continuation with the same person pictures gets its face from Face refine (card #223)", () => {
  it("samples it without the person's picture, in the words of a plain continuation, then draws the face towards it, Face refine off in the form", () => {
    const { built, graph } = build({ faceCarried: true, faceRefine: false });
    // the clip's own route and model (the reference model: its Turbo row and steps as the form has them), no picture given,
    // carrying on from the clip before's latent
    expect(sampledFiles(graph)).toEqual([]);
    expect(of(graph, "MiniMaxH3ImageToVideo")).toEqual([]);
    expect(of(graph, "MiniMaxH3LatentTailGuide")).toHaveLength(1);
    expect(of(graph, "UNETLoader").map(([, n]) => n.inputs.unet_name)).toContain(slots.refUnet);
    expect(promptOf(graph)).toContain("This clip carries on the previous shot as one continuous take.");
    expect(promptOf(graph)).not.toMatch(/<Picture|<Subject/);
    // then Face refine towards that picture, on the clip's own model: one model loaded, whatever Face refine model says
    expect(refinedTowards(graph)).toBe("r1.png");
    expect(of(graph, "H3FaceStitch")).toHaveLength(1);
    expect(of(graph, "UNETLoader")).toHaveLength(1);
    expect(built.loads).not.toContain(`diffusion_models/${slots.faceRefineUnet}`);
    // #222's colour match is gone
    expect(of(graph, "AfflatusMatchPicture")).toEqual([]);
    expect(checkGraph(built, catalog)).toEqual([]);
  });

  it("asks a machine for Face refine's files beside the clip's own", () => {
    const needs = h3Video.needsWith!(parseInput(h3Video, { description: "a", previous: { asset: "c1" }, references: [{ asset: "r1", role: "person" }], faceCarried: true }), {});
    expect(needs).toEqual(expect.arrayContaining(["refUnet", "faceDetector"]));
    expect(needs).not.toContain("faceRefineUnet");
    const asSampled = h3Video.needsWith!(parseInput(h3Video, { description: "a", previous: { asset: "c1" }, references: [{ asset: "r1", role: "person" }] }), {});
    expect(asSampled).toContain("refUnet");
    expect(asSampled).not.toContain("faceRefineUnet");
  });

  it("keeps the form's Face refine denoise and steps for the pass, on the clip's own model even where another is picked", () => {
    const { graph } = build({ faceCarried: true, faceRefine: true, faceRefineDenoise: 0.55, faceRefineSteps: 6, faceRefineModel: slots.faceRefineUnet });
    expect(of(graph, "UNETLoader").map(([, n]) => n.inputs.unet_name)).toEqual([slots.refUnet]);
    const refine = of(graph, "SamplerCustomAdvanced").find(([, n]) => node(graph, n.inputs.latent_image).class_type === "H3PerFrameDenoise")![1];
    expect(node(graph, refine.inputs.sigmas).inputs).toMatchObject({ steps: 6, denoise: 0.55 });
    expect(of(graph, "H3FaceStitch")).toHaveLength(1);
  });

  it("samples a continuation whose person pictures changed with them, as it was, without the colour match", () => {
    const { built, graph } = build({ faceCarried: false });
    expect(sampledFiles(graph)).toEqual(["r1.png"]);
    expect(of(graph, "MiniMaxH3ImageToVideo")).toEqual([]);
    expect(of(graph, "H3FaceStitch")).toEqual([]);
    expect(of(graph, "AfflatusMatchPicture")).toEqual([]);
    expect(checkGraph(built, catalog)).toEqual([]);
  });

  it("samples a first clip with its pictures whatever the flag says (nothing to carry the face on from)", () => {
    const { graph } = build({ previous: undefined, faceCarried: true }, { media: {} }, { "references.0": "r1.png" });
    expect(sampledFiles(graph)).toEqual(["r1.png"]);
    expect(of(graph, "H3FaceStitch")).toEqual([]);
  });

  it("leaves a clip with no person picture as it is", () => {
    const { graph } = build({ faceCarried: true, references: [{ asset: "r1", role: "place" }] });
    expect(sampledFiles(graph)).toEqual(["r1.png"]);
    expect(of(graph, "H3FaceStitch")).toEqual([]);
  });

  it("keeps the other pictures in the sampling (a clothing picture), the person's alone left to Face refine", () => {
    const { built, graph } = build(
      { faceCarried: true, references: [{ asset: "r1", role: "person" }, { asset: "r2", role: "clothing" }, { asset: "r3", role: "person" }] },
      {},
      { ...continued, "references.1": "r2.png", "references.2": "r3.png" },
    );
    expect(sampledFiles(graph)).toEqual(["r2.png"]);
    expect(promptOf(graph)).toContain("<Picture 1> gives what appears: identity and look only.");
    expect(promptOf(graph)).not.toContain("<Subject 1> is the character");
    expect(refinedTowards(graph)).toBe("r1.png");
    expect(checkGraph(built, catalog)).toEqual([]);
  });

  it("is Lip sync's too", () => {
    const lip = h3LipSync.build(
      parseInput(h3LipSync, { description: "a beach", references: [{ asset: "r1", role: "person" }], recording: "a1", previous: { asset: "c1" }, faceCarried: true }),
      dryContext({ seed: 7, slots, uploads: { ...continued, recording: "rec.wav" }, media: { previous: joined, recording: { width: 0, height: 0, seconds: 4.2 } } }),
    );
    const graph = lip.graph as Graph;
    expect(sampledFiles(graph)).toEqual([]);
    expect(refinedTowards(graph)).toBe("r1.png");
    expect(h3LipSync.traits?.faceCarried).toBe("faceCarried");
    expect(checkGraph(lip, catalog)).toEqual([]);
  });

  it("leaves Swap character and Motion transfer windows sampled with the person's picture (their job is drawn from it)", () => {
    expect(h3Swap.traits?.faceCarried).toBeUndefined();
    expect(h3MotionTransfer.traits?.faceCarried).toBeUndefined();
    expect(h3Swap.inputs.some((i) => i.id === "faceCarried")).toBe(false);
    expect(h3MotionTransfer.inputs.some((i) => i.id === "faceCarried")).toBe(false);
    // (refused in their forms: a timeline sets it only where the trait names it)
    expect(() => parseInput(h3Swap, { who: "the man", faceCarried: true })).toThrow(/faceCarried/);
    const window = { source: "src.mp4", previous: "w.mp4", "previous.latent": "w.safetensors", "references.0": "r1.png" };
    const media = { source: { ...joined, frames: 141 }, previous: { ...joined, latentFrames: 141 } };
    const swap = h3Swap.build(
      parseInput(h3Swap, { who: "the man", source: { asset: "v1", at: 5 }, previous: { asset: "w1" }, references: [{ asset: "r1", role: "person" }], fast: false, maskOn: true }),
      dryContext({ slots, uploads: window, media }),
    );
    expect(sampledFiles(swap.graph as Graph)).toEqual(["r1.png"]);
    const motion = h3MotionTransfer.build(
      parseInput(h3MotionTransfer, { afterSwap: true, description: "The man in <Picture 1> dances.", source: { asset: "v1", at: 5 }, previous: { asset: "w1" }, references: [{ asset: "r1", role: "person" }] }),
      dryContext({ slots, uploads: window, media }),
    );
    expect(sampledFiles(motion.graph as Graph)?.[0]).toBe("r1.png");
  });
});

describe("MiniMax H3 · a continuation's person picture gives the identity alone (card #222)", () => {
  it("says the person's picture gives the face, hair and build, in the run-up's light, in positive words", () => {
    const p = promptOf(build({}).graph);
    expect(p).toContain("<Picture 1> gives only the identity of <Subject 1>: the face, hair and build.");
    expect(p).toContain("only the identity is taken from <Picture 1>: the face, hair and build, in the light of the given opening frames.");
    expect(p).not.toContain("identity and look only");
    expect(p).not.toContain("only the identity and look are taken");
    expect(p).not.toMatch(/\b(not|never|no|without|don't)\b/i);
  });

  it("keeps a clothing picture's look, and a first clip's wording as it was", () => {
    const p = promptOf(build({ references: [{ asset: "r1", role: "person" }, { asset: "r2", role: "clothing" }] }, {}, { ...continued, "references.1": "r2.png" }).graph);
    expect(p).toContain("<Picture 1> gives only the identity of <Subject 1>: the face, hair and build. <Picture 2> gives what appears: identity and look only.");
    const first = promptOf(build({ previous: undefined }, { media: {} }, { "references.0": "r1.png" }).graph);
    expect(first).toContain("<Picture 1> is a reference for who and what appears, not for the scene");
    expect(first).toContain("only the identity and look are taken from <Picture 1>, not its background.");
  });

  it("says a motion window's frame of the clip before gives how the person looks in this take", () => {
    const motion = h3MotionTransfer.build(
      parseInput(h3MotionTransfer, { afterSwap: true, description: "The man in <Picture 1> dances.", source: { asset: "v1", at: 5 }, previous: { asset: "w1" }, references: [{ asset: "r1", role: "person" }] }),
      dryContext({ slots, uploads: { source: "src.mp4", previous: "w.mp4", "previous.latent": "w.safetensors", "references.0": "r1.png" }, media: { source: { ...joined, frames: 141 }, previous: { ...joined, latentFrames: 141 } } }),
    );
    const p = promptOf(motion.graph as Graph);
    expect(p).toContain("<Picture 1> gives only the identity of <Subject 1>: the face, hair and build. <Picture 2> is a frame of the given opening frames: how <Subject 1> looks in this take.");
    expect(p).toContain("only the identity is taken from <Picture 1>: the face, hair and build, in the light of the given opening frames; the look is taken from <Picture 2>, a frame of this take.");
  });
});
