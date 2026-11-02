import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkGraph, dryContext, parseInput, type BuildContext, type MediaFacts, type NodeCatalog } from "@afflatus/core";
import { describe, expect, it } from "vitest";
import { H3_MATCH_PICTURE } from "../src/h3/condition";
import { H3_FPS } from "../src/h3/family";
import { h3LipSync } from "../src/h3/lipsync";
import { h3MotionTransfer } from "../src/h3/motionTransfer";
import { h3Swap } from "../src/h3/swap";
import { h3Video } from "../src/h3/video";

const catalog = JSON.parse(readFileSync(fileURLToPath(new URL("../../../reference/comfy-object-info.json", import.meta.url)), "utf-8")) as NodeCatalog;

type Node = { class_type: string; inputs: Record<string, unknown> };
type Graph = Record<string, Node>;
const of = (graph: Graph, type: string) => Object.entries(graph).filter(([, n]) => n.class_type === type);
const node = (graph: Graph, ref: unknown) => graph[(ref as [string, number])[0]]!;
const reference = (graph: Graph) => of(graph, "MiniMaxH3ReferenceToVideo")[0]![1];
const promptOf = (graph: Graph) => String(reference(graph).inputs.prompt);

const slots = {
  unet: "u.safetensors", clip: "c.safetensors", videoVae: "v.safetensors", audioVae: "a.safetensors", refUnet: "minimax_h3_ref2va.safetensors",
  swapLora: "swap.safetensors", swapUnet: "minimax_h3_fused_refdelta_r1024_turbo8.safetensors", swapSam: "sam3.1.safetensors",
  h3Control: "minimax_h3_fun_controlnet_union_2.0.safetensors", sdpose: "sdpose.safetensors", rtdetr: "rt_detr.safetensors",
};
const joined: MediaFacts = { width: 576, height: 1024, frames: 22, fps: H3_FPS, hasSound: true, latentFrames: 124 };
const continued = { previous: "a.mp4", "previous.latent": "a.safetensors [temp]", "references.0": "r1.png" };

function build(values: Record<string, unknown>, ctx: Partial<BuildContext> = {}, uploads: Record<string, string> = continued) {
  const input = parseInput(h3Video, { description: "She walks on along the beach.", seconds: 5, previous: { asset: "c1" }, references: [{ asset: "r1", role: "person" }], ...values });
  const built = h3Video.build(input, dryContext({ seed: 7, slots, uploads, media: { previous: joined }, ...ctx }));
  return { built, graph: built.graph as Graph };
}

/** The picture given as the reference model's first one is the person's own, brought to the light of the run-up's last frame. */
function expectMatched(graph: Graph, file: string, video: string) {
  const matched = node(graph, reference(graph).inputs["ref_images.ref_image_0"]);
  expect(matched.class_type).toBe(H3_MATCH_PICTURE);
  expect(matched.inputs.strength).toBe(1);
  expect(node(graph, matched.inputs.image)).toEqual({ class_type: "LoadImage", inputs: { image: file } });
  const end = node(graph, matched.inputs.reference);
  expect(end.class_type).toBe("ImageFromBatch");
  expect(end.inputs).toMatchObject({ batch_index: -1, length: 1 });
  const parts = node(graph, end.inputs.image);
  expect(parts.class_type).toBe("GetVideoComponents");
  expect(node(graph, parts.inputs.video).inputs).toEqual({ file: video });
}

describe("MiniMax H3 · a continuation's person picture in the run-up's light (card #222)", () => {
  it("brings the person's picture to the run-up's last frame before the reference model encodes it", () => {
    const { built, graph } = build({});
    expectMatched(graph, "r1.png", "a.mp4");
    expect(of(graph, H3_MATCH_PICTURE)).toHaveLength(1);
    expect(checkGraph(built, catalog)).toEqual([]);
  });

  it("matches every person picture to the one frame, and leaves the other roles as they are", () => {
    const { graph } = build(
      { references: [{ asset: "r1", role: "person" }, { asset: "r2", role: "clothing" }, { asset: "r3", role: "person" }] },
      {},
      { ...continued, "references.1": "r2.png", "references.2": "r3.png" },
    );
    const start = reference(graph).inputs;
    expect(node(graph, start["ref_images.ref_image_1"])).toEqual({ class_type: "LoadImage", inputs: { image: "r2.png" } });
    const [a, c] = [node(graph, start["ref_images.ref_image_0"]), node(graph, start["ref_images.ref_image_2"])];
    expect([a.class_type, c.class_type]).toEqual([H3_MATCH_PICTURE, H3_MATCH_PICTURE]);
    expect(a.inputs.reference).toEqual(c.inputs.reference);
    expect(of(graph, "ImageFromBatch")).toHaveLength(1);
  });

  it("also on a continuation made from the clip before's frames (Join from: Frames)", () => {
    const { built, graph } = build({ joinFrom: "Frames" });
    expectMatched(graph, "r1.png", "a.mp4");
    expect(checkGraph(built, catalog)).toEqual([]);
  });

  it("gives a first clip's picture as it is", () => {
    const { built, graph } = build({ previous: undefined }, { media: {} }, { "references.0": "r1.png" });
    expect(node(graph, reference(graph).inputs["ref_images.ref_image_0"])).toEqual({ class_type: "LoadImage", inputs: { image: "r1.png" } });
    expect(of(graph, H3_MATCH_PICTURE)).toEqual([]);
    expect(of(graph, "ImageFromBatch")).toEqual([]);
    expect(checkGraph(built, catalog)).toEqual([]);
  });

  it("gives it as it is with a pack older than 0.48.0", () => {
    const { built, graph } = build({}, { has: (cls) => cls !== H3_MATCH_PICTURE });
    expect(node(graph, reference(graph).inputs["ref_images.ref_image_0"])).toEqual({ class_type: "LoadImage", inputs: { image: "r1.png" } });
    expect(of(graph, "ImageFromBatch")).toEqual([]);
    expect(checkGraph(built, catalog)).toEqual([]);
  });

  it("is in every H3 form: Lip sync, Swap character, Motion transfer", () => {
    const lip = h3LipSync.build(
      parseInput(h3LipSync, { description: "a beach", references: [{ asset: "r1", role: "person" }], recording: "a1", previous: { asset: "c1" } }),
      dryContext({ slots, uploads: { ...continued, recording: "rec.wav" }, media: { previous: joined, recording: { width: 0, height: 0, seconds: 4.2 } } }),
    );
    expectMatched(lip.graph as Graph, "r1.png", "a.mp4");
    const window = { source: "src.mp4", previous: "w.mp4", "previous.latent": "w.safetensors", "references.0": "r1.png" };
    const media = { source: { ...joined, frames: 141 }, previous: { ...joined, latentFrames: 141 } };
    const swap = h3Swap.build(
      parseInput(h3Swap, { who: "the man", source: { asset: "v1", at: 5 }, previous: { asset: "w1" }, references: [{ asset: "r1", role: "person" }], fast: false, maskOn: true }),
      dryContext({ slots, uploads: window, media }),
    );
    expectMatched(swap.graph as Graph, "r1.png", "w.mp4");
    const motion = h3MotionTransfer.build(
      parseInput(h3MotionTransfer, { afterSwap: true, description: "The man in <Picture 1> dances.", source: { asset: "v1", at: 5 }, previous: { asset: "w1" }, references: [{ asset: "r1", role: "person" }] }),
      dryContext({ slots, uploads: window, media }),
    );
    const graph = motion.graph as Graph;
    expectMatched(graph, "r1.png", "w.mp4");
    // the window's own picture of the clip before's last frame is that same frame, read once, and given as it is
    const start = reference(graph).inputs;
    expect(node(graph, start["ref_images.ref_image_1"]).class_type).toBe("ImageFromBatch");
    expect(node(graph, start["ref_images.ref_image_0"]).inputs.reference).toEqual(start["ref_images.ref_image_1"]);
    expect(of(graph, "ImageFromBatch")).toHaveLength(1);
    for (const built of [lip, swap, motion]) expect(checkGraph(built, catalog)).toEqual([]);
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
