import { describe, expect, it } from "vitest";
import { dryContext, parseInput, type BuildContext } from "@afflatus/core";
import { h3Video } from "../src/h3/video";
import { UPSCALE } from "../src/video/upscale";
import { recipeById } from "../src/index";

type Node = { class_type: string; inputs: Record<string, unknown> };
type Graph = Record<string, Node>;
const of = (graph: Graph, type: string) => Object.values(graph).filter((n) => n.class_type === type);
const node = (graph: Graph, ref: unknown) => graph[(ref as [string, number])[0]]!;
const idOf = (graph: Graph, n: Node) => Object.entries(graph).find(([, x]) => x === n)![0];

const slots = {
  unet: "u.safetensors", clip: "c.safetensors", videoVae: "v.safetensors", audioVae: "a.safetensors", refUnet: "minimax_h3_ref2va.safetensors", rife: "rife.pth",
  faceRefineUnet: "minimax_h3_fused_refdelta_r1024_turbo8.safetensors", faceDetector: "bbox/face_yolov8m.pt", faceSeg: "segm/person_yolov8m-seg.pt", faceSam: "sam_vit_b_01ec64.pth",
};
const uploads = { "references.0": "place.png", "references.1": "person.png" };
const people = [{ asset: "r0", role: "place" }, { asset: "r1", role: "person" }];

function build(values: Record<string, unknown>, ctx: Partial<BuildContext> = {}) {
  const built = h3Video.build(parseInput(h3Video, { description: "a", ...values }), dryContext({ seed: 7, slots, uploads, ...ctx }));
  return { built, graph: built.graph as Graph };
}

describe("MiniMax H3 · Face refine", () => {
  it("is on every H3 form, off by default, in the Output chapter", () => {
    for (const id of ["h3.video", "h3.lipsync", "h3.swap", "h3.motion"]) {
      const spec = recipeById(id)!.inputs.find((i) => i.id === "faceRefine");
      expect(spec, id).toMatchObject({ type: "toggle", default: false, section: "out" });
      expect(recipeById(id)!.inputs.find((i) => i.id === "faceRefineOnly"), id).toMatchObject({ internal: true });
    }
  });

  it("changes nothing when it is off", () => {
    const { graph } = build({ references: people });
    expect(of(graph, "H3FaceStitch")).toHaveLength(0);
    expect(of(graph, "SamplerCustomAdvanced")).toHaveLength(1);
    // the kept latent is the sampled one
    expect(node(graph, of(graph, "AfflatusNormalizeH3Latent")[0]!.inputs.samples).class_type).toBe("SamplerCustomAdvanced");
  });

  it("redraws the decoded faces towards the person's picture, before RIFE, and keeps the refined frames' latent", () => {
    const { built, graph } = build({ faceRefine: true, references: people, subject: "short dark hair, round glasses." });
    const [stitch] = of(graph, "H3FaceStitch");
    expect(stitch).toBeDefined();
    expect(node(graph, stitch!.inputs.base_images).class_type).toBe("VAEDecode");
    // RIFE interpolates the refined frames
    expect(node(graph, of(graph, "FrameInterpolate")[0]!.inputs.images)).toBe(stitch);
    // the cast person's picture, not the first reference (a place), followed by identity and given as <Picture 1>
    const track = of(graph, "H3FaceTrackCrop")[0]!;
    const picture = node(graph, node(graph, track.inputs.identity_reference).inputs.image);
    expect(picture.inputs.image).toBe("person.png");
    expect(track.inputs).toMatchObject({ detector: slots.faceDetector, fallback_detector: slots.faceSeg, crop_factor: 2.5, identity_threshold: 0.28 });
    const r2v = of(graph, "MiniMaxH3ReferenceToVideo").find((n) => n.inputs["ref_images.ref_image_0"] === track.inputs.identity_reference)!;
    expect(r2v.inputs.prompt).toBe("Close-up of the face of the person in <Picture 1>, short dark hair, round glasses. Sharp focus, clear details.");
    // on the fused reference turbo, at 4 steps, 0.45, the clip's seed; the clip's sound held
    const samplers = of(graph, "SamplerCustomAdvanced");
    expect(samplers).toHaveLength(2);
    const refine = samplers.find((n) => node(graph, n.inputs.latent_image).class_type === "H3PerFrameDenoise")!;
    expect(node(graph, refine.inputs.sigmas).inputs).toMatchObject({ steps: 4, denoise: 0.45, scheduler: "simple" });
    expect(node(graph, refine.inputs.noise).inputs.noise_seed).toBe(7);
    const loaders = of(graph, "UNETLoader").map((n) => n.inputs.unet_name);
    expect(loaders).toContain(slots.faceRefineUnet);
    const lock = of(graph, "AfflatusH3AudioLock")[0]!;
    expect(node(graph, lock.inputs.audio).class_type).toBe("VAEDecodeAudio");
    // pasted over SAM's outline of the face
    expect(node(graph, stitch!.inputs.masks).class_type).toBe("H3FaceMaskSAM");
    // the clip after carries on from the refined faces: the kept latent is them encoded, the sampled sound kept
    const kept = node(graph, of(graph, "AfflatusNormalizeH3Latent")[0]!.inputs.samples);
    expect(kept.class_type).toBe("H3InjectVideoLatent");
    expect(node(graph, kept.inputs.images)).toBe(stitch);
    expect(node(graph, kept.inputs.av_latent).class_type).toBe("SamplerCustomAdvanced");
    // a pass of the job's progress, and its files loaded
    expect(built.passes?.at(-1)).toEqual({ node: idOf(graph, refine), steps: 4 });
    expect(built.loads).toEqual(expect.arrayContaining([`diffusion_models/${slots.faceRefineUnet}`, `ultralytics/${slots.faceDetector}`, `sams/${slots.faceSam}`]));
    expect(built.warnings ?? []).toEqual([]);
  });

  it("draws no face towards a place, clothing, object or style picture: with no person, it is done without and says why (B19)", () => {
    const { built, graph } = build({ faceRefine: true, references: [{ asset: "r0", role: "clothing" }] });
    expect(of(graph, "H3FaceTrackCrop")).toHaveLength(0);
    expect(built.warnings).toContainEqual(expect.stringMatching(/^Not face-refined: the clip has no person's picture/));
    // nor scored against it, as before
    expect(of(graph, "AfflatusFaceMatch")).toHaveLength(0);
    // and asks for none of its files
    expect(h3Video.needsWith!(parseInput(h3Video, { description: "a", faceRefine: true, references: [{ asset: "r0", role: "place" }] }), {}).filter((x) => x.startsWith("face"))).toEqual([]);
  });

  it("without a cast person, follows the picture the clip opens on and scores against it, as the LTX and SCAIL forms do (R1)", () => {
    const opening = build({ faceRefine: true, start: "p1", references: [{ asset: "r0", role: "place" }] }, { uploads: { ...uploads, start: "open.png" }, media: { start: { width: 576, height: 1024 } } });
    const track = of(opening.graph, "H3FaceTrackCrop")[0]!;
    expect(node(opening.graph, node(opening.graph, track.inputs.identity_reference).inputs.image).inputs.image).toBe("open.png");
    const score = of(opening.graph, "AfflatusFaceMatch")[0]!;
    expect(node(opening.graph, score.inputs.photo_1).inputs.image).toBe("open.png");
    expect(h3Video.needsWith!(parseInput(h3Video, { description: "a", faceRefine: true, start: "p1" }), {})).toEqual(expect.arrayContaining(["faceRefineUnet", "faceDetector"]));
    // the cast's picture comes first
    const cast = build({ faceRefine: true, start: "p1", references: people }, { uploads: { ...uploads, start: "open.png" }, media: { start: { width: 576, height: 1024 } } });
    expect(node(cast.graph, node(cast.graph, of(cast.graph, "H3FaceTrackCrop")[0]!.inputs.identity_reference).inputs.image).inputs.image).toBe("person.png");
    // a Motion transfer's Picture is who it moves
    const motion = recipeById("h3.motion")!;
    const moved = motion.build(parseInput(motion, { picture: "p", source: { asset: "v" }, faceRefine: true }), dryContext({
      slots: { ...slots, h3Control: "minimax_h3_fun_controlnet_union_2.0.safetensors" }, uploads: { picture: "who.png", source: "drive.mp4" },
      media: { picture: { width: 576, height: 1024 }, source: { width: 576, height: 1024, frames: 141, fps: 24, hasSound: true } },
    }));
    const movedGraph = moved.graph as Graph;
    expect(moved.warnings ?? []).not.toContainEqual(expect.stringMatching(/no person's picture/));
    expect(node(movedGraph, node(movedGraph, of(movedGraph, "H3FaceTrackCrop")[0]!.inputs.identity_reference).inputs.image).inputs.image).toBe("who.png");
    expect(motion.needsWith!(parseInput(motion, { picture: "p", source: { asset: "v" }, faceRefine: true }), {})).toEqual(expect.arrayContaining(["faceRefineUnet", "faceDetector"]));
  });

  it("pastes over the face's box without SAM, and follows no body without the person detector", () => {
    const { built, graph } = build({ faceRefine: true, references: people }, { slots: { ...slots, faceSam: undefined as never, faceSeg: undefined as never } });
    expect(of(graph, "H3FaceStitch")[0]!.inputs.masks).toBeUndefined();
    expect(of(graph, "SAMLoader")).toHaveLength(0);
    expect(of(graph, "H3FaceTrackCrop")[0]!.inputs.fallback_detector).toBe("none");
    // the coarser paste is said on the job (card #47)
    expect(built.warnings).toEqual(["Ran without SAM's outline (the face pasted over its box): no SAM model on this ComfyUI (sam_vit_b_01ec64.pth in models/sams; Settings › Models has it)."]);
  });

  it("says the box paste where SAM's node pack is not there (a pod whose Impact Pack failed), the model sent or not", () => {
    const { built, graph } = build({ faceRefine: true, references: people }, { has: (n: string) => n !== "SAMLoader" });
    expect(of(graph, "H3FaceStitch")[0]!.inputs.masks).toBeUndefined();
    expect(of(graph, "SAMLoader")).toHaveLength(0);
    expect(built.loads).not.toContain(`sams/${slots.faceSam}`);
    expect(built.warnings).toEqual(["Ran without SAM's outline (the face pasted over its box): its node pack comfyui-impact-pack is missing."]);
    // a Finish › Face refine says it too
    const finish = build({ faceRefine: true, faceRefineOnly: true, references: people }, { has: (n: string) => n !== "SAMLoader" });
    expect(finish.built.warnings).toContain("Ran without SAM's outline (the face pasted over its box): its node pack comfyui-impact-pack is missing.");
  });

  it("is done without, and says why, with no picture, no model or no detector", () => {
    const cases: Array<[Record<string, unknown>, Partial<BuildContext>, RegExp]> = [
      [{ references: [] }, {}, /no person's picture/],
      // (with neither the fused turbo nor a model of the clip's that follows a picture)
      [{ references: [], start: "s1" }, { slots: { ...slots, faceRefineUnet: undefined as never, refUnet: undefined as never }, uploads: { ...uploads, start: "s.png" } }, /no fused reference turbo/],
      [{ references: people }, { slots: { ...slots, faceDetector: undefined as never } }, /no face detector/],
    ];
    for (const [values, ctx, said] of cases) {
      const { built, graph } = build({ faceRefine: true, ...values }, ctx);
      expect(of(graph, "H3FaceStitch")).toHaveLength(0);
      expect(built.warnings?.join(" ")).toMatch(said);
    }
  });

  it("asks for its node pack, and is done without it where the job runs without", () => {
    const asked: string[] = [];
    const { graph } = build({ faceRefine: true, references: people }, { wants: (w) => (asked.push(`${w.input}:${w.nodes.join()}:${w.without}`), null) });
    expect(asked).toContain("faceRefine:H3FaceStitch:Face refine");
    expect(of(graph, "H3FaceStitch")).toHaveLength(0);
  });

  it("finishes a kept take from its own latent: nothing sampled but the faces", () => {
    const input = parseInput(h3Video, { description: "a", faceRefine: true, faceRefineOnly: true, references: people });
    expect(h3Video.finishing?.(input)).toEqual({ latent: "own" });
    const { built, graph } = build({ faceRefine: true, faceRefineOnly: true, references: people }, { uploads: { ...uploads, "self.latent": "own.safetensors" } });
    expect(of(graph, "AfflatusLoadH3Latent").map((n) => n.inputs.latent)).toContain("own.safetensors");
    // the only sampler is the faces': the clip itself is not sampled again
    const samplers = of(graph, "SamplerCustomAdvanced");
    expect(samplers).toHaveLength(1);
    expect(node(graph, samplers[0]!.inputs.latent_image).class_type).toBe("H3PerFrameDenoise");
    expect(built.totalSteps).toBe(4);
    expect(built.passes).toEqual([{ node: idOf(graph, samplers[0]!), steps: 4 }]);
    // a plain finish of the clip asks for nothing of its draft
    expect(h3Video.finishing?.(parseInput(h3Video, { description: "a", faceRefine: true }))).toBeNull();
  });

  it("finishes a kept take with none of the clip's model loaded: a pod was sent the model and LoRA it never samples with", () => {
    const own = { uploads: { ...uploads, "self.latent": "own.safetensors" } };
    const { built, graph } = build({ faceRefine: true, faceRefineOnly: true, references: people, loras: [{ file: "mine.safetensors", weight: 0.8 }] }, { slots: { ...slots, turbo: "minimax_h3_turbo.safetensors" }, ...own });
    // the one model is the faces'
    expect(of(graph, "UNETLoader").map((n) => n.inputs.unet_name)).toEqual([slots.faceRefineUnet]);
    expect(of(graph, "LoraLoaderModelOnly")).toHaveLength(0);
    expect(built.loads).not.toContain(`diffusion_models/${slots.refUnet}`);
    // and needs no reference model to be built
    expect(() => build({ faceRefine: true, faceRefineOnly: true, references: people }, { slots: { ...slots, refUnet: undefined as never }, ...own })).not.toThrow();
    expect(h3Video.needsWith!(parseInput(h3Video, { description: "a", faceRefine: true, faceRefineOnly: true, references: people }), {})).not.toContain("refUnet");
  });

  it("fails a Finish › Face refine that cannot refine, with why: the take made again was named a face pass", () => {
    const own = { "self.latent": "own.safetensors" };
    expect(() => build({ faceRefine: true, faceRefineOnly: true, references: people }, { uploads: { ...uploads, ...own }, slots: { ...slots, faceRefineUnet: undefined as never, refUnet: undefined as never } })).toThrow(/no fused reference turbo/);
    expect(() => build({ faceRefine: true, faceRefineOnly: true, references: people }, { uploads: { ...uploads, ...own }, has: (cls) => cls !== "H3FaceStitch" })).toThrow(/comfyui-h3-facerefine/);
  });

  it("needs its pack on a Finish › Face refine, never asks for it as an option to do without: run without it, the finish failed (review of 0.6.0, H-21)", () => {
    const own = { "self.latent": "own.safetensors" };
    const asked: string[] = [];
    const lacking = { uploads: { ...uploads, ...own }, has: (cls: string) => !cls.startsWith("H3Face"), wants: (w: { input: string }) => (asked.push(w.input), null) };
    expect(() => build({ faceRefine: true, faceRefineOnly: true, references: people }, lacking)).toThrow(/comfyui-h3-facerefine/);
    expect(asked).not.toContain("faceRefine");
    // with the pack there, the pass is built
    expect(of(build({ faceRefine: true, faceRefineOnly: true, references: people }, { uploads: { ...uploads, ...own }, wants: () => null }).graph, "H3FaceStitch")).toHaveLength(1);
  });

  it("says why it is done without on a pack with no audio lock, where it was left out without a word", () => {
    const { built, graph } = build({ faceRefine: true, references: people }, { has: (cls) => cls !== "AfflatusH3AudioLock" });
    expect(of(graph, "H3FaceStitch")).toHaveLength(0);
    expect(built.warnings?.join(" ")).toMatch(/no H3 Audio Lock yet/);
  });

  it("asks for its files on every form that has it (a pod was never sent them), and none with it off", () => {
    const face = ["faceRefineUnet", "faceDetector", "faceSeg", "faceSam"];
    const forms: Array<[string, Record<string, unknown>]> = [
      ["h3.video", { description: "a" }], ["h3.lipsync", { description: "a", recording: "r" }], ["h3.motion", { picture: "p", source: { asset: "v" } }],
      ["h3.swap", { who: "the man", source: { asset: "v" } }], ["h3.motion", { afterSwap: true, previous: { asset: "w" }, source: { asset: "v" } }],
    ];
    for (const [id, values] of forms) {
      const r = recipeById(id)!;
      expect(r.needsWith!(parseInput(r, { ...values, faceRefine: true, references: [{ asset: "r1", role: "person" }] }), {}), id).toEqual(expect.arrayContaining(face));
      expect(r.needsWith!(parseInput(r, { ...values, references: [{ asset: "r1", role: "person" }] }), {}).filter((x) => x.startsWith("face")), id).toEqual([]);
      // with no person's picture the pass leaves the clip as it is: none of its files is asked for (a Motion transfer's Picture
      // is one: who it moves)
      const towards = id === "h3.motion" && "picture" in values && !("previous" in values);
      expect(r.needsWith!(parseInput(r, { ...values, faceRefine: true, references: [] }), {}).filter((x) => x.startsWith("face")), id).toEqual(towards ? expect.arrayContaining(face) : []);
    }
    const scail = recipeById("scail.motion24")!;
    expect(scail.needsWith!(parseInput(scail, { picture: "p", driving: { asset: "v" }, faceRefine: true }), {})).toEqual(expect.arrayContaining([...face, "faceClip", "faceVideoVae", "faceAudioVae"]));
  });

  it("takes the form's own How they look into its prompt on a swap and a Motion transfer, which have one such field", () => {
    const prompt = (graph: Graph) => of(graph, "MiniMaxH3ReferenceToVideo").map((n) => String(n.inputs.prompt)).find((p) => p.startsWith("Close-up of the face"));
    const swap = recipeById("h3.swap")!;
    const swapped = swap.build(parseInput(swap, { who: "", inSource: "the woman", look: "short grey hair.", source: { asset: "v1" }, references: [{ asset: "r1", role: "person" }], faceRefine: true }), dryContext({
      slots: { ...slots, swapLora: "swap.safetensors", swapUnet: "minimax_h3_ref2va.safetensors" }, uploads: { source: "src.mp4", "references.0": "person.png" },
      media: { source: { width: 576, height: 1024, frames: 141, fps: 24, hasSound: true } },
    })).graph as Graph;
    expect(prompt(swapped)).toBe("Close-up of the face of the person in <Picture 1>, short grey hair. Sharp focus, clear details.");
    const motion = recipeById("h3.motion")!;
    expect(motion.inputs.filter((i) => i.type === "prompt" && i.label === "How they look").map((i) => i.id)).toEqual(["look"]);
    const moved = motion.build(parseInput(motion, { picture: "p1", source: { asset: "v1" }, look: "a red scarf", references: [{ asset: "r1", role: "person" }], faceRefine: true }), dryContext({
      slots: { ...slots, h3Control: "minimax_h3_fun_controlnet_union_2.0.safetensors" }, uploads: { picture: "p.png", source: "v.mp4", "references.0": "person.png" },
      media: { picture: { width: 576, height: 1024 }, source: { width: 576, height: 1024, frames: 141, fps: 24, hasSound: true } },
    })).graph as Graph;
    expect(prompt(moved)).toBe("Close-up of the face of the person in <Picture 1>, a red scarf. Sharp focus, clear details.");
  });

  it("after the latent re-sample, refines the larger frames and keeps the sampled latent as it is", () => {
    const { graph } = build({ faceRefine: true, references: people, upscale: UPSCALE.latent });
    const stitch = of(graph, "H3FaceStitch")[0]!;
    expect(node(graph, stitch.inputs.base_images).class_type).toBe("VAEDecodeTiled");
    expect(of(graph, "H3InjectVideoLatent").filter((n) => node(graph, n.inputs.images) === stitch)).toHaveLength(0);
  });

  it("runs on the other H3 forms the same way", () => {
    const swap = recipeById("h3.swap")!;
    const input = parseInput(swap, { who: "Replace the woman in <Video 1> with the man in <Picture 1>.", source: { asset: "v1" }, references: [{ asset: "r1", role: "person" }], faceRefine: true });
    const graph = swap.build(input, dryContext({
      slots: { ...slots, swapLora: "swap.safetensors", swapUnet: "minimax_h3_ref2va.safetensors" },
      uploads: { source: "src.mp4", "references.0": "person.png" },
      media: { source: { width: 576, height: 1024, frames: 141, fps: 24, hasSound: true } },
    })).graph as Graph;
    const track = of(graph, "H3FaceTrackCrop")[0]!;
    expect(node(graph, node(graph, track.inputs.identity_reference).inputs.image).inputs.image).toBe("person.png");
  });
});
