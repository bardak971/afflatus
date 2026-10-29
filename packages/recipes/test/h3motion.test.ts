import { describe, expect, it } from "vitest";
import { carriedOf, dryContext, isShown, parseInput, sameWindowGrid, sourceWindows, windowShapeOf, type MediaFacts } from "@afflatus/core";
import { h3Swap } from "../src/h3/swap";
import { CARRY_ON_PROMPT, h3MotionTransfer } from "../src/h3/motionTransfer";
import { H3_FPS } from "../src/h3/family";
import { recipeById } from "../src/index";

type Node = { class_type: string; inputs: Record<string, unknown> };
type Graph = Record<string, Node>;
const of = (graph: Graph, type: string) => Object.values(graph).filter((n) => n.class_type === type);
const node = (graph: Graph, ref: unknown) => graph[(ref as [string, number])[0]]!;
const slots = {
  unet: "u.safetensors", clip: "c.safetensors", videoVae: "v.safetensors", audioVae: "a.safetensors", refUnet: "minimax_h3_ref2va.safetensors",
  swapLora: "swap.safetensors", swapUnet: "minimax_h3_fused_refdelta_r1024_turbo8.safetensors", swapSam: "sam3.1.safetensors",
  h3Control: "minimax_h3_fun_controlnet_union_2.0.safetensors", sdpose: "sdpose.safetensors", rtdetr: "rt_detr.safetensors",
};
const part = (over: Partial<MediaFacts> = {}): MediaFacts => ({ width: 576, height: 1024, frames: 141, fps: H3_FPS, hasSound: true, ...over });
const before = (frames = 22): MediaFacts => ({ width: 576, height: 1024, frames, fps: H3_FPS, hasSound: true, latentFrames: 141 });

/** A Motion transfer window after a swap (no Picture of its own) that carries on from the one before, in its latent. */
const carryOn = (over: Record<string, unknown> = {}, frames = 22) => {
  const input = parseInput(h3MotionTransfer, { afterSwap: true, description: "The man in <Picture 1> dances.", source: { asset: "v1", at: 5 }, previous: { asset: "w1" }, references: [{ asset: "r1", role: "person" }], ...over });
  const built = h3MotionTransfer.build(input, dryContext({
    slots, uploads: { source: "src.mp4", previous: "w.mp4", "previous.latent": "w.safetensors", "references.0": "r1.png" },
    media: { source: part(), previous: before(frames) },
  }));
  return { built, graph: built.graph as Graph };
};

describe("MiniMax H3 · Motion transfer after a swap (H3 · Swap motion retired, card #42)", () => {
  it("is given by hand to a window after a swap, cut alike (a swap's windows are all swaps); Swap motion is gone", () => {
    expect(recipeById("h3.swapMotion")).toBeUndefined();
    expect(h3Swap.traits!.windows!.carryOn).toBeUndefined();
    expect(sameWindowGrid(h3Swap, h3MotionTransfer)).toBe(true);
    // the two read their part of the source by the same inputs
    const window = (r: { inputs: readonly { type: string; id: string }[] }) => r.inputs.find((i) => i.type === "clip" && (i as { role?: string }).role === "source");
    expect(window(h3MotionTransfer)).toMatchObject({ id: "source", window: { start: "sourceStart", seconds: "sourceSeconds" } });
    expect(window(h3Swap)).toMatchObject({ id: "source", window: { start: "sourceStart", seconds: "sourceSeconds" } });
  });

  it("runs on the swap's model, as the window before: its own pick, else the swap's slot, the swap's shifts when it comes from one", () => {
    const unet = (graph: Graph) => of(graph, "UNETLoader").map((n) => n.inputs.unet_name);
    expect(unet(carryOn().graph)).toEqual([slots.swapUnet]);
    expect(unet(carryOn({ swapModel: "minimax_h3_ref2va_other.safetensors" }).graph)).toEqual(["minimax_h3_ref2va_other.safetensors"]);
    // made Motion transfer alone from a swap window: it carries on from the swap, the sampling it had not set the swap's
    expect(h3MotionTransfer.windowFrom!(h3Swap, { look: "x" }, true)).toEqual({ shiftVideo: 12, shiftAudio: 3, look: "x", afterSwap: true });
    expect(h3MotionTransfer.windowFrom!(h3Swap, { shiftVideo: 9 }, true)).toEqual({ shiftVideo: 9, shiftAudio: 3, afterSwap: true });
    // every window of the source made Motion transfer: each one of its own, with its Picture
    expect(h3MotionTransfer.windowFrom!(h3Swap, { look: "x", afterSwap: true }, false)).toEqual({ look: "x", afterSwap: false });
    // the form shows the model it runs on: the swap's after a swap, its own otherwise
    const shown = (values: Record<string, unknown>) => h3MotionTransfer.inputs.filter((i) => isShown(i, values, h3MotionTransfer.inputs)).map((i) => i.id);
    expect(shown({ afterSwap: true })).toEqual(expect.arrayContaining(["swapModel"]));
    expect(shown({ afterSwap: true })).not.toEqual(expect.arrayContaining(["model"]));
    expect(shown({ afterSwap: true })).not.toContain("picture");
    expect(shown({})).toEqual(expect.arrayContaining(["model", "picture"]));
    expect(shown({})).not.toContain("swapModel");
  });

  it("moves a window that carries on by the pose of its part: the ControlNet on the model it samples with, no swap LoRA, no source video in", () => {
    const { built, graph } = carryOn();
    const control = of(graph, "MiniMaxH3FunControlNetApply");
    expect(control).toHaveLength(1);
    expect(control[0]!.inputs).toMatchObject({ strength: 1, start_percent: 0, end_percent: 1 });
    expect(node(graph, control[0]!.inputs.model_patch).inputs.name).toBe(slots.h3Control);
    // the pose drawn by DWPose from the window's own part of the source, at the clip's size
    const pose = node(graph, control[0]!.inputs.control_video);
    expect(pose.class_type).toBe("DWPreprocessor");
    expect(pose.inputs).toMatchObject({ detect_body: "enable", detect_hand: "enable", detect_face: "enable" });
    const scaled = node(graph, pose.inputs.image);
    expect(scaled.inputs).toMatchObject({ width: 576, height: 1024, crop: "center" });
    expect(of(graph, "LoadVideo").map((n) => n.inputs.file)).toContain("src.mp4");
    // sampled with the patched model
    const guider = of(graph, "BasicGuider")[0]!;
    expect(node(graph, guider.inputs.model).class_type).toBe("MiniMaxH3FunControlNetApply");
    // the swap's LoRA left out, and the source only as the pose and the sound: H3's references are the cast's picture alone
    expect(of(graph, "LoraLoaderModelOnly").map((n) => n.inputs.lora_name)).not.toContain(slots.swapLora);
    const ref = of(graph, "MiniMaxH3ReferenceToVideo")[0]!;
    expect(Object.keys(ref.inputs).filter((k) => /video/i.test(k) && ref.inputs[k] !== undefined && Array.isArray(ref.inputs[k]))).toEqual([]);
    expect(String(ref.inputs.prompt)).toContain("The man dances.");
    // carried on from the window before's latent, its 22 frames the run-up
    expect(of(graph, "MiniMaxH3GuidedContinuationWindow")[0]!.inputs).toMatchObject({ overlap_frames: 22, extension_frames: 141 - 22 });
    expect(built.loads).toContain(`model_patches/${slots.h3Control}`);
    // nothing said of the motion (RIFE has no file in these slots)
    expect((built.warnings ?? []).filter((w) => !/RIFE/.test(w))).toEqual([]);
  });

  it("draws the pose with SDPose when asked, RT-DETR finding the people, hands and face as set", () => {
    const { built, graph } = carryOn({ poseFrom: "SDPose", poseHands: false, controlStrength: 0.8, controlEnd: 0.5 });
    const control = of(graph, "MiniMaxH3FunControlNetApply")[0]!;
    expect(control.inputs).toMatchObject({ strength: 0.8, end_percent: 0.5 });
    const drawn = node(graph, control.inputs.control_video);
    expect(drawn.class_type).toBe("SDPoseDrawKeypoints");
    expect(drawn.inputs).toMatchObject({ draw_hands: false, draw_face: true, draw_body: true });
    expect(of(graph, "RTDETR_detect")[0]!.inputs.class_name).toBe("person");
    expect(built.loads).toEqual(expect.arrayContaining([`checkpoints/${slots.sdpose}`, `diffusion_models/${slots.rtdetr}`]));
  });

  it("says on the job a prompt that still names <Video 1>, and no picture of who goes in", () => {
    expect(carryOn({ description: "Replace the woman in <Video 1> with the man in <Picture 1>." }).built.warnings?.join(" ")).toMatch(/still a swap's/);
    expect(carryOn({ references: [] }).built.warnings?.join(" ")).toMatch(/No picture of who goes in/);
  });

  it("takes the run-up the form sets: 39 frames carried, the window cut for them", () => {
    const { graph } = carryOn({ context: "39" }, 39);
    expect(of(graph, "MiniMaxH3GuidedContinuationWindow")[0]!.inputs).toMatchObject({ overlap_frames: 39, extension_frames: 141 - 39 });
  });

  it("writes its prompt from the parts as carrying on, the plain carrying on with none, each window keeping its own", () => {
    expect(h3MotionTransfer.traits!.windows!.own).toEqual(["description", "happens", "cues"]);
    const after = (look: string, happens: string) => h3MotionTransfer.promptFromParts!({ afterSwap: true, look, happens } as never);
    expect(after("", "")).toBe(CARRY_ON_PROMPT);
    expect(after("short brown hair", "he dances")).toBe("The person, short brown hair, carries on moving as in the clip before. He dances.");
    expect(CARRY_ON_PROMPT).not.toMatch(/<(Video|Picture)/);
    // a Motion transfer of its own (a Picture) keeps its own way of writing it
    expect(h3MotionTransfer.promptFromParts!({ previous: { asset: "w1" }, picture: "p1", look: "short brown hair", happens: "" } as never)).toBe("The person: short brown hair.");
  });

  it("gives a window that carries on the clip before's last frame as a second picture of the person, its prompt H3's own layout without typed tags", () => {
    const { graph } = carryOn({ description: "The man with short brown hair in <Picture 1> dances." });
    const ref = of(graph, "MiniMaxH3ReferenceToVideo")[0]!;
    expect(node(graph, ref.inputs["ref_images.ref_image_0"]).class_type).toBe("LoadImage");
    const frame = node(graph, ref.inputs["ref_images.ref_image_1"]);
    expect(frame.class_type).toBe("ImageFromBatch");
    expect(frame.inputs.batch_index).toBe(-1);
    expect(of(graph, "LoadVideo").map((n) => n.inputs.file)).toContain("w.mp4");
    const prompt = String(ref.inputs.prompt);
    expect(prompt).toContain("<Subject 1> is the character in <Picture 1> and <Picture 2>");
    expect(prompt).toContain("The man with short brown hair dances.");
    expect(prompt).not.toMatch(/hair in <Picture 1> dances/);
  });

  it("needs the ControlNet and the swap's model, and SDPose's two models only when it draws the pose", () => {
    const needs = (over: Record<string, unknown>) => h3MotionTransfer.needsWith!(parseInput(h3MotionTransfer, { afterSwap: true, source: { asset: "v1" }, previous: { asset: "w1" }, ...over }), slots);
    expect(needs({})).toEqual(expect.arrayContaining(["h3Control", "swapUnet"]));
    expect(needs({})).not.toContain("sdpose");
    expect(needs({ swapModel: "m.safetensors" })).not.toContain("swapUnet");
    expect(needs({ poseFrom: "SDPose" })).toEqual(expect.arrayContaining(["sdpose", "rtdetr"]));
    // the swap's LoRA and SAM 3 are the swap's own; an empty pick of the ControlNet (its folder empty) is the slot's
    expect(needs({})).not.toContain("swapLora");
    expect(needs({})).not.toContain("swapSam");
    expect(parseInput(h3MotionTransfer, { source: { asset: "v1" }, controlModel: "" }).controlModel).toBeUndefined();
  });

  it("refuses DWPose without its pack, with the way out", () => {
    const input = parseInput(h3MotionTransfer, { afterSwap: true, source: { asset: "v1", at: 5 }, previous: { asset: "w1" }, references: [{ asset: "r1", role: "person" }] });
    const ctx = dryContext({ slots, uploads: { source: "src.mp4", previous: "w.mp4", "references.0": "r1.png" }, media: { source: part(), previous: before() }, has: (cls) => cls !== "DWPreprocessor" });
    expect(() => h3MotionTransfer.build(input, ctx)).toThrow(/comfyui_controlnet_aux.*SDPose/);
  });
});

describe("MiniMax H3 · Motion transfer", () => {
  const build = (over: Record<string, unknown> = {}, media: Record<string, MediaFacts> = {}) => {
    const input = parseInput(h3MotionTransfer, { picture: "p1", source: { asset: "v1" }, description: "A man dances.", ...over });
    const built = h3MotionTransfer.build(input, dryContext({
      slots, uploads: { picture: "p.png", source: "d.mp4", previous: "w.mp4", "previous.latent": "w.safetensors", "references.0": "r1.png" },
      media: { picture: { width: 832, height: 1472 }, source: part({ width: 720, height: 1280 }), ...media },
    }));
    return { built, graph: built.graph as Graph };
  };

  it("opens on the picture as its first frame, moved by the driving video's pose", () => {
    const { graph } = build();
    expect(of(graph, "LoadImage").map((n) => n.inputs.image)).toContain("p.png");
    const control = of(graph, "MiniMaxH3FunControlNetApply")[0]!;
    const pose = node(graph, control.inputs.control_video);
    expect(pose.class_type).toBe("DWPreprocessor");
    // the driving video cut to the clip's size from the centre: the picture's shape
    const scaled = node(graph, pose.inputs.image);
    expect(scaled.inputs.crop).toBe("center");
    expect(Number(scaled.inputs.height) / Number(scaled.inputs.width)).toBeCloseTo(1472 / 832, 1);
    expect(of(graph, "LoadVideo").map((n) => n.inputs.file)).toContain("d.mp4");
  });

  it("carries a window on from the one before, without the picture as its first frame, the clip before's last frame a picture of who moves", () => {
    const { graph } = build({ previous: { asset: "w1" } }, { previous: before() });
    expect(of(graph, "LoadImage").map((n) => n.inputs.image)).not.toContain("p.png");
    const ref = of(graph, "MiniMaxH3ReferenceToVideo")[0]!;
    expect(node(graph, ref.inputs["ref_images.ref_image_0"]).class_type).toBe("ImageFromBatch");
    expect(of(graph, "MiniMaxH3GuidedContinuationWindow")[0]!.inputs).toMatchObject({ overlap_frames: 22, extension_frames: 141 - 22 });
    expect(of(graph, "MiniMaxH3FunControlNetApply")).toHaveLength(1);
    // on the form's own model, not the swap's: it has a Picture of its own
    expect(of(graph, "UNETLoader").map((n) => n.inputs.unet_name)).not.toContain(slots.swapUnet);
  });

  it("waits for the Picture on a source lane: a window that opens is refused without one, one after a swap needs none", () => {
    const picture = h3MotionTransfer.inputs.find((i) => i.id === "picture");
    expect(picture).toMatchObject({ type: "image", role: "source" });
    expect(() => build({ picture: undefined })).toThrow(/needs a picture/);
    expect(() => carryOn()).not.toThrow();
  });
});

describe("a source's windows with H3's run-up", () => {
  it("are cut for the run-up the form has: 5, 22 or 39 frames, the recipe's 22 otherwise", () => {
    expect(carriedOf(h3Swap, {})).toBe(22);
    expect(carriedOf(h3Swap, { context: "39" })).toBe(39);
    expect(carriedOf(h3Swap, { context: "5" })).toBe(5);
    // a count it does not take is the recipe's own
    expect(carriedOf(h3Swap, { context: "17" })).toBe(22);
    // the same whatever a window's form: Motion transfer takes the swap's counts
    for (const context of ["5", "22", "39", "17"]) expect(carriedOf(h3MotionTransfer, { context })).toBe(carriedOf(h3Swap, { context }));
    for (const n of [5, 22, 39]) {
      const shape = windowShapeOf(h3Swap, { context: String(n) })!;
      const windows = sourceWindows({ fromMs: 0, toMs: 20_000, windowMs: 5000, shape });
      for (const [k, w] of windows.entries()) {
        if (k === 0) continue;
        // each window that carries on starts its run-up early, and plays on from where the one before ended
        expect(w.fromMs).toBe(windows[k - 1]!.toMs);
        expect(Math.round((w.fromMs / 1000 - w.start) * H3_FPS)).toBe(n);
      }
    }
  });
});
