import { describe, expect, it } from "vitest";
import { dryContext, parseInput, type BuildContext } from "@afflatus/core";
import { scailMotion, scailMotion24 } from "../src/scail/motion";
import { FACE_REFINE_OWN_SLOTS, FACE_REFINE_SLOTS } from "../src/h3/faceRefine";

type Node = { class_type: string; inputs: Record<string, unknown> };
type Graph = Record<string, Node>;
const of = (graph: Graph, type: string) => Object.values(graph).filter((n) => n.class_type === type);
const node = (graph: Graph, ref: unknown) => graph[(ref as [string, number])[0]]!;

const slots = {
  unet: "wan2.1_14B_SCAIL_2_int8_convrot.safetensors", clip: "umt5_xxl_fp8_e4m3fn_scaled.safetensors", vae: "wan_2.1_vae.safetensors", clipVision: "clip_vision_h.safetensors",
  sam: "sam3.1_multiplex_fp16.safetensors", ...FACE_REFINE_SLOTS, ...FACE_REFINE_OWN_SLOTS,
};
const part = { width: 480, height: 854, frames: 141, fps: 24, hasSound: true };

function build(values: Record<string, unknown>, ctx: Partial<BuildContext> = {}) {
  const input = parseInput(scailMotion24, { picture: "p1", driving: { asset: "v1" }, drivingSeconds: 141 / 24, ...values });
  const built = scailMotion24.build(input, dryContext({ seed: 7, slots, uploads: { picture: "picture.png", driving: "d.mp4" }, media: { picture: { width: 768, height: 1360 }, driving: part }, ...ctx }));
  return { built, graph: built.graph as Graph };
}

describe("SCAIL-2 at 24 fps · Face refine", () => {
  it("is offered at 24 fps only, off by default, starting on 0.35", () => {
    const spec = (id: string) => scailMotion24.inputs.find((i) => i.id === id);
    expect(spec("faceRefine")).toMatchObject({ type: "toggle", default: false, section: "out" });
    expect(spec("faceRefineDenoise")).toMatchObject({ default: 0.35 });
    // no latent kept: its finish redraws the take's frames, so there is no "only" input
    expect(spec("faceRefineOnly")).toBeUndefined();
    expect(scailMotion24.traits?.faceRefine).toBe("faceRefine");
    expect(scailMotion.inputs.some((i) => i.id === "faceRefine")).toBe(false);
    expect(scailMotion.traits?.faceRefine).toBeUndefined();
  });

  it("changes nothing when it is off", () => {
    const { graph } = build({});
    expect(of(graph, "H3FaceStitch")).toHaveLength(0);
    expect(of(graph, "MiniMaxH3ReferenceToVideo")).toHaveLength(0);
  });

  it("redraws SCAIL's own frames towards the Picture, before the match to the driving video, with the driving sound held", () => {
    const { built, graph } = build({ faceRefine: true });
    const stitch = of(graph, "H3FaceStitch")[0]!;
    // its base is the frames SCAIL made: 141 frames at 24 fps are two of its 81-frame chunks, joined
    expect(node(graph, stitch.inputs.base_images).class_type).toBe("ImageBatch");
    expect(of(graph, "SamplerCustom")).toHaveLength(2);
    const track = of(graph, "H3FaceTrackCrop")[0]!;
    expect(node(graph, node(graph, track.inputs.identity_reference).inputs.image).inputs.image).toBe("picture.png");
    // H3's own pieces from the family's Face refine slots, beside SCAIL's (Wan's) text encoder and VAE
    expect(of(graph, "CLIPLoader").map((n) => n.inputs)).toEqual(expect.arrayContaining([expect.objectContaining({ clip_name: slots.faceClip, type: "minimax" }), expect.objectContaining({ clip_name: slots.clip, type: "wan" })]));
    expect(of(graph, "VAELoader").map((n) => n.inputs.vae_name)).toEqual(expect.arrayContaining([slots.faceVideoVae, slots.faceAudioVae, slots.vae]));
    // the driving video's sound held, the denoise SCAIL's 0.35, no padding (141 frames are on H3's grid)
    expect(node(graph, of(graph, "AfflatusH3AudioLock")[0]!.inputs.audio).class_type).toBe("TrimAudioDuration");
    const refine = of(graph, "SamplerCustomAdvanced")[0]!;
    expect(node(graph, refine.inputs.sigmas).inputs).toMatchObject({ steps: 4, denoise: 0.35 });
    expect(of(graph, "RepeatImageBatch")).toHaveLength(0);
    // the raw side file (what the window after carries on from) and the face score read the refined frames
    const saves = of(graph, "SaveVideo").length + of(graph, "VHS_VideoCombine").length;
    expect(saves).toBeGreaterThan(0);
    const usesStitch = Object.values(graph).filter((n) => Object.values(n.inputs).some((v) => Array.isArray(v) && graph[v[0] as string] === stitch));
    expect(usesStitch.length).toBeGreaterThanOrEqual(2);
    expect(built.loads).toEqual(expect.arrayContaining([`text_encoders/${slots.faceClip}`, `vae/${slots.faceVideoVae}`, `diffusion_models/${slots.faceRefineUnet}`]));
    expect(built.passes?.at(-1)).toMatchObject({ steps: 4 });
    expect(built.warnings ?? []).toEqual([]);
  });

  it("makes a window that carries on up to H3's grid and cuts it back; without the sound, no audio lock", () => {
    const { graph } = build({ faceRefine: true, previous: { asset: "v0" }, keepSound: false }, {
      uploads: { picture: "picture.png", driving: "d.mp4", previous: "prev.mp4", "previous.look": "prev.png" },
      media: { picture: { width: 768, height: 1360 }, driving: part, previous: { width: 480, height: 854, frames: 5, fps: 24 } },
    });
    // 141 frames less the 5 carried: 136, made up with 5 to 141 and cut back to 136
    expect(of(graph, "RepeatImageBatch")[0]!.inputs.amount).toBe(5);
    const stitch = of(graph, "H3FaceStitch")[0]!;
    const cut = of(graph, "ImageFromBatch").find((n) => graph[(n.inputs.image as [string, number])[0]] === stitch)!;
    expect(cut.inputs).toMatchObject({ batch_index: 0, length: 136 });
    expect(of(graph, "AfflatusH3AudioLock")).toHaveLength(0);
  });

  it("is done without, and says why, without H3's text encoder and VAEs", () => {
    const { built, graph } = build({ faceRefine: true }, { slots: { ...slots, faceClip: undefined as never } });
    expect(of(graph, "H3FaceStitch")).toHaveLength(0);
    expect(built.warnings?.join(" ")).toMatch(/text encoder and VAEs/);
  });
});
