import { describe, expect, it } from "vitest";
import { dryContext, parseInput, type BuildContext, type Recipe } from "@afflatus/core";
import { ltxVideo } from "../src/ltx/video";
import { ltx25LipSync, ltx25Video } from "../src/ltx25/video";
import { wanVideo } from "../src/wan/video";
import { ltx25 } from "../src/ltx25/family";
import { FACE_REFINE_OWN_SLOTS, FACE_REFINE_SLOTS } from "../src/h3/faceRefine";

type Node = { class_type: string; inputs: Record<string, unknown> };
type Graph = Record<string, Node>;
const of = (graph: Graph, type: string) => Object.values(graph).filter((n) => n.class_type === type);
const node = (graph: Graph, ref: unknown) => graph[(ref as [string, number])[0]]!;
/** The files the Face Match node compares the take with (the LoadImage of each photo input), or null when there is none. */
const photosOf = (graph: Graph) => {
  const score = of(graph, "AfflatusFaceMatch")[0];
  return score ? Object.entries(score.inputs).filter(([k]) => k.startsWith("photo_")).map(([, v]) => node(graph, v).inputs.image) : null;
};
/** Whether `ref` is `target` or is made from it. */
const madeFrom = (graph: Graph, ref: unknown, target: Node): boolean => {
  const n = node(graph, ref);
  return n === target || Object.values(n.inputs).some((v) => Array.isArray(v) && typeof v[0] === "string" && graph[v[0]] !== undefined && madeFrom(graph, v, target));
};

const ltx25Parts = {
  unet: "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors", clip: "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors",
  videoVae: "ltx-2.5-video-vae-bf16.safetensors", audioVae: "ltx-2.5-audio-vae-bf16.safetensors", upscaler: "ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors",
  msr: "LTX-2.5-Licon-MSR-V2.safetensors", rife: "rife49.pth",
};
const face = { ...FACE_REFINE_SLOTS, ...FACE_REFINE_OWN_SLOTS };
const picture = { width: 832, height: 1216 };

function build<T>(recipe: Recipe<T>, values: Record<string, unknown>, ctx: Partial<BuildContext>) {
  const input = parseInput(recipe, values);
  const built = recipe.build(input, dryContext({ seed: 7, ...ctx }));
  return { built, graph: built.graph as Graph };
}

describe("LTX 2.5 · Face refine", () => {
  it("is offered on both 2.5 forms with H3's words and defaults, not on 2.3", () => {
    for (const recipe of [ltx25Video, ltx25LipSync]) {
      const spec = (id: string) => recipe.inputs.find((i) => i.id === id);
      expect(spec("faceRefine")).toMatchObject({ type: "toggle", default: false, section: "out", label: "Face refine" });
      expect(spec("faceRefineDenoise")).toMatchObject({ default: 0.45 });
      // by the model (4 on the fused turbo it runs on)
      expect(spec("faceRefineSteps")).toMatchObject({ default: 0, auto: "by model" });
      // its finish redraws the take's frames: no "only" input; and no H3 model of its own to redraw with (card #159)
      expect(spec("faceRefineOnly")).toBeUndefined();
      // card #204: H3's files to pick, without the clip's own (its model is not H3's)
      expect(spec("faceRefineModel")).toMatchObject({ type: "model", slot: "faceRefineUnet", showWhen: "faceRefine" });
      expect(spec("faceRefineModel")).not.toHaveProperty("own");
      expect(recipe.traits?.faceRefine).toBe("faceRefine");
    }
    expect(ltxVideo.inputs.some((i) => i.id === "faceRefine")).toBe(false);
    expect(ltxVideo.traits?.faceRefine).toBeUndefined();
  });

  it("has H3's Face refine files in its family, offered only with its two forms", () => {
    for (const id of ["faceRefineUnet", "faceDetector", "faceSeg", "faceSam", "faceClip", "faceVideoVae", "faceAudioVae"]) {
      expect(ltx25.slots.find((s) => s.id === id)).toMatchObject({ optional: true, onlyFor: ["ltx25.video", "ltx25.lipsync"] });
    }
  });

  it("changes nothing when it is off; the take is scored against the cast's picture", () => {
    const { graph } = build(ltx25Video, { prompt: "a", references: [{ asset: "r1", role: "person" }] }, { slots: ltx25Parts, uploads: { "references.0": "r1.png" } });
    expect(of(graph, "H3FaceStitch")).toHaveLength(0);
    expect(photosOf(graph)).toEqual(["r1.png"]);
  });

  it("redraws the decoded frames towards the cast's picture, padded to H3's grid and cut back, the take's sound held, before RIFE", () => {
    const { built, graph } = build(ltx25Video, { prompt: "a", references: [{ asset: "r1", role: "person" }], faceRefine: true, smooth: true, smoothWith: "RIFE (pixels)" }, {
      slots: { ...ltx25Parts, ...face }, uploads: { "references.0": "r1.png" },
    });
    const stitch = of(graph, "H3FaceStitch")[0]!;
    // 5 s at 24 are 121 frames (8n + 1): made up with 3 to H3's 124 (17k + 5), cut back to 121
    expect(of(graph, "RepeatImageBatch")[0]!.inputs.amount).toBe(3);
    const cut = of(graph, "ImageFromBatch").find((n) => node(graph, n.inputs.image) === stitch)!;
    expect(cut.inputs).toMatchObject({ batch_index: 0, length: 121 });
    const track = of(graph, "H3FaceTrackCrop")[0]!;
    expect(node(graph, node(graph, track.inputs.identity_reference).inputs.image).inputs.image).toBe("r1.png");
    // the model's own sound, decoded, held under the redrawn faces
    expect(node(graph, of(graph, "AfflatusH3AudioLock")[0]!.inputs.audio).class_type).toBe("LTXVAudioVAEDecode");
    expect(node(graph, of(graph, "SamplerCustomAdvanced").at(-1)!.inputs.sigmas).inputs).toMatchObject({ steps: 4, denoise: 0.45 });
    // RIFE interpolates the refined frames; the score reads them
    expect(madeFrom(graph, of(graph, "FrameInterpolate")[0]!.inputs.images, cut)).toBe(true);
    expect(node(graph, of(graph, "AfflatusFaceMatch")[0]!.inputs.image)).toBe(cut);
    // H3's own text encoder and VAEs, beside LTX's
    expect(of(graph, "CLIPLoader").map((n) => n.inputs.clip_name)).toContain(face.faceClip);
    expect(built.loads).toEqual(expect.arrayContaining([`diffusion_models/${face.faceRefineUnet}`, `text_encoders/${face.faceClip}`, `vae/${face.faceAudioVae}`]));
    expect(built.passes?.at(-1)).toMatchObject({ steps: 4 });
    expect(built.totalSteps).toBe(built.passes!.reduce((n, p) => n + p.steps, 0));
    expect(built.warnings ?? []).toEqual([]);
  });

  it("refines towards the first frame without a reference, and asks for its files only with a person's picture", () => {
    const { graph } = build(ltx25Video, { prompt: "a", start: "p1", faceRefine: true }, { slots: { ...ltx25Parts, ...face }, uploads: { start: "a.png" }, media: { start: picture } });
    const track = of(graph, "H3FaceTrackCrop")[0]!;
    expect(node(graph, node(graph, track.inputs.identity_reference).inputs.image).inputs.image).toBe("a.png");
    expect(photosOf(graph)).toEqual(["a.png"]);
    expect(ltx25Video.needsWith!(parseInput(ltx25Video, { prompt: "a", start: "p1", faceRefine: true }), {})).toEqual(expect.arrayContaining(["faceRefineUnet", "faceClip", "faceVideoVae", "faceAudioVae"]));
    expect(ltx25Video.needsWith!(parseInput(ltx25Video, { prompt: "a", faceRefine: true }), {})).not.toContain("faceRefineUnet");
  });

  it("holds the recording under the faces on Lip sync", () => {
    const { graph } = build(ltx25LipSync, { prompt: "a", references: [{ asset: "r1", role: "person" }], recording: "a1", recordingSeconds: 5.9, faceRefine: true }, {
      slots: { ...ltx25Parts, ...face }, uploads: { "references.0": "r1.png", recording: "rec.wav" }, media: { recording: { width: 0, height: 0, seconds: 5.9 } },
    });
    expect(of(graph, "H3FaceStitch")).toHaveLength(1);
    expect(of(graph, "LTXVAudioVAEDecode")).toHaveLength(0);
    expect(of(graph, "AfflatusH3AudioLock")).toHaveLength(1);
  });

  it("is left out with LTX's temporal upscaler (48 a second), and said", () => {
    const { built, graph } = build(ltx25Video, { prompt: "a", start: "p1", faceRefine: true, smooth: true, smoothWith: "LTX temporal (latent)" }, {
      slots: { ...ltx25Parts, ...face, temporal: "ltx-2.5-latent-temporal-upscaler-x2-bf16-1.0.safetensors" }, uploads: { start: "a.png" }, media: { start: picture },
    });
    expect(of(graph, "H3FaceStitch")).toHaveLength(0);
    expect(built.warnings?.join(" ")).toMatch(/temporal upscaler doubled the frames/);
  });

  it("asks for none of its files or nodes when the temporal upscaler leaves it out (a pod would fetch H3's ~38 GB for nothing)", () => {
    const values = { prompt: "a", references: [{ asset: "r1", role: "person" }], faceRefine: true, smooth: true };
    const faceSlots = (needs: string[]) => needs.filter((n) => n.startsWith("face"));
    const needs = (smoothWith: string, slots: Record<string, string> = {}, more: Record<string, unknown> = {}) =>
      ltx25Video.needsWith!(parseInput(ltx25Video, { ...values, smoothWith, ...more }), slots);
    const temporal = { temporal: "ltx-2.5-latent-temporal-upscaler-x2-bf16-1.0.safetensors" };
    // asked for by name, or Auto with the temporal file there: the pass is left out, so are its files
    expect(faceSlots(needs("LTX temporal (latent)"))).toEqual([]);
    expect(needs("LTX temporal (latent)")).toContain("temporal");
    expect(faceSlots(needs("Auto", temporal))).toEqual([]);
    // with RIFE, Auto without the temporal file, or Auto with SeedVR2 (RIFE after it): refined, its files asked
    for (const asked of [needs("RIFE (pixels)", temporal), needs("Auto"), needs("Auto", temporal, { upscale: "Video: SeedVR2 (restores)" })]) {
      expect(asked).toEqual(expect.arrayContaining(["faceRefineUnet", "faceDetector", "faceClip", "faceVideoVae", "faceAudioVae"]));
    }
    // its nodes: none when the temporal upscaler is asked for by name; with RIFE they are
    const nodes = (smoothWith: string) => ltx25Video.nodes(parseInput(ltx25Video, { ...values, smoothWith }));
    expect(nodes("LTX temporal (latent)")).not.toContain("MiniMaxH3ReferenceToVideo");
    expect(nodes("RIFE (pixels)")).toContain("MiniMaxH3ReferenceToVideo");
  });

  it("says why without its files", () => {
    const { built, graph } = build(ltx25Video, { prompt: "a", start: "p1", faceRefine: true }, { slots: ltx25Parts, uploads: { start: "a.png" }, media: { start: picture } });
    expect(of(graph, "H3FaceStitch")).toHaveLength(0);
    expect(built.warnings?.join(" ")).toMatch(/MiniMax H3's text encoder and VAEs/);
  });
});

describe("LTX 2.3 and Wan · the face score", () => {
  const ltx23 = { unet: "SomeoneLTX23_v4.safetensors", videoVae: "LTX23_video_vae.safetensors", audioVae: "LTX23_audio_vae.safetensors", projection: "ltx-2.3_text_projection.safetensors", clip: "gemma_3_12B_it.safetensors" };
  const wan = { i2vHigh: "wan2.2_i2v_high_noise_14B.safetensors", i2vLow: "wan2.2_i2v_low_noise_14B.safetensors", clip: "umt5_xxl.safetensors", vae: "wan_2.1_vae.safetensors" };

  it("takes the cast person's picture as an internal input", () => {
    for (const recipe of [ltxVideo, wanVideo] as Recipe<unknown>[]) expect(recipe.inputs.find((i) => i.id === "facePhoto")).toMatchObject({ type: "image", role: "face", internal: true, optional: true });
    // 2.5 takes the cast as reference pictures
    expect(ltx25Video.inputs.some((i) => i.id === "facePhoto")).toBe(false);
  });

  it("scores against the cast's picture before the first frame's, the first frame without one", () => {
    const cast = build(ltxVideo, { prompt: "a", start: "p1", facePhoto: "f1" }, { slots: ltx23, uploads: { start: "a.png", facePhoto: "face.png" }, media: { start: picture } });
    expect(photosOf(cast.graph)).toEqual(["face.png"]);
    expect(photosOf(build(wanVideo, { prompt: "a", start: "p1" }, { slots: wan, uploads: { start: "a.png" }, media: { start: picture } }).graph)).toEqual(["a.png"]);
    expect(photosOf(build(wanVideo, { prompt: "a", start: "p1", facePhoto: "f1" }, { slots: wan, uploads: { start: "a.png", facePhoto: "face.png" }, media: { start: picture } }).graph)).toEqual(["face.png"]);
  });

  it("scores nothing without anyone to compare with: words alone, or a clip carried on with no cast", () => {
    expect(photosOf(build(wanVideo, { prompt: "a" }, { slots: { ...wan, t2vHigh: "wan2.2_t2v_high_noise_14B.safetensors", t2vLow: "wan2.2_t2v_low_noise_14B.safetensors" } }).graph)).toBeNull();
    const carried = build(ltxVideo, { prompt: "a", previous: { asset: "c1" } }, { slots: ltx23, uploads: { previous: "a.mp4" }, media: { previous: { width: 704, height: 1280, frames: 25, fps: 25, hasSound: true } } });
    expect(photosOf(carried.graph)).toBeNull();
  });

  it("scores nothing where the node is not", () => {
    const { graph } = build(wanVideo, { prompt: "a", start: "p1" }, { slots: wan, uploads: { start: "a.png" }, media: { start: picture }, has: (n) => n !== "AfflatusFaceMatch" });
    expect(photosOf(graph)).toBeNull();
  });
});
