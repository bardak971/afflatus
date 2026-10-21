import { describe, expect, it } from "vitest";
import { carriedOf, dryContext, parseInput, sourceWindows, windowShapeOf, type MediaFacts } from "@afflatus/core";
import { h3Swap } from "../src/h3/swap";
import { h3SwapMotion, SWAP_MOTION_PROMPT } from "../src/h3/swapMotion";
import { h3MotionTransfer } from "../src/h3/motionTransfer";
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

/** A window of Swap motion that carries on from the one before, in its latent. */
const carryOn = (over: Record<string, unknown> = {}, frames = 22) => {
  const input = parseInput(h3SwapMotion, { who: "The man in <Picture 1> dances.", source: { asset: "v1", at: 5 }, previous: { asset: "w1" }, references: [{ asset: "r1", role: "person" }], ...over });
  const built = h3SwapMotion.build(input, dryContext({
    slots, uploads: { source: "src.mp4", previous: "w.mp4", "previous.latent": "w.safetensors", "references.0": "r1.png" },
    media: { source: part(), previous: before(frames) },
  }));
  return { built, graph: built.graph as Graph };
};

describe("MiniMax H3 · Swap motion", () => {
  it("is offered beside H3's others", () => {
    expect(recipeById("h3.swapMotion")).toBe(h3SwapMotion);
    expect(h3SwapMotion.family).toBe("h3");
  });

  it("makes a window that opens a shot exactly as Swap character does", () => {
    const values = { who: "Replace the woman in <Video 1> with the man in <Picture 1>.", source: { asset: "v1" }, references: [{ asset: "r1", role: "person" }] };
    const ctx = () => dryContext({ slots, uploads: { source: "src.mp4", "references.0": "r1.png" }, media: { source: part() } });
    expect(h3SwapMotion.build(parseInput(h3SwapMotion, values), ctx()).graph).toEqual(h3Swap.build(parseInput(h3Swap, values), ctx()).graph);
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

  it("says on the job a prompt that still names <Video 1>, and that the Mask is the first window's", () => {
    const { built } = carryOn({ who: "Replace the woman in <Video 1> with the man in <Picture 1>.", maskOn: true });
    expect(built.warnings?.join(" ")).toMatch(/still a swap's/);
    expect(built.warnings?.join(" ")).toMatch(/Mask is the first window's/);
  });

  it("takes the run-up the form sets: 39 frames carried, the window cut for them", () => {
    const { graph } = carryOn({ context: "39" }, 39);
    expect(of(graph, "MiniMaxH3GuidedContinuationWindow")[0]!.inputs).toMatchObject({ overlap_frames: 39, extension_frames: 141 - 39 });
  });

  it("starts a window that carries on on clip 1's person, carrying on (Make puts it there), each window keeping its own", () => {
    expect(h3SwapMotion.traits!.windows!.own).toEqual(["who", "happens"]);
    const swap = "Replace the young woman dancing in <Video 1> with the man with short brown hair in <Picture 1>. Keep the man's face and hair from <Picture 1>. he has a manly build and is wearing a white shirt with jeans. Match the position, scale, pose and movement in <Video 1>. Preserve the scene. ";
    expect(h3SwapMotion.windowCarryOn!({ who: swap })).toEqual({
      who: "The man with short brown hair carries on moving as in the clip before. He has a manly build and is wearing a white shirt with jeans.",
    });
    // nobody named to take it from (the caption the form starts on): nothing carried, the window writes its own from the
    // parts, the plain one with none (card #34)
    expect(h3SwapMotion.windowCarryOn!({ who: "Swap the person in <Video 1> with the character in <Picture 1>." })).toEqual({});
    expect(h3SwapMotion.promptFromParts!({ previous: { asset: "w1" }, look: "", happens: "" } as never)).toBe(SWAP_MOTION_PROMPT);
    expect(SWAP_MOTION_PROMPT).not.toMatch(/<(Video|Picture)/);
  });

  it("gives a window that carries on the clip before's last frame as a second picture of the person, its prompt H3's own layout without typed tags", () => {
    const { graph } = carryOn({ who: "The man with short brown hair in <Picture 1> dances." });
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

  it("needs the ControlNet, and SDPose's two models only when it draws the pose", () => {
    const needs = (over: Record<string, unknown>) => h3SwapMotion.needsWith!(parseInput(h3SwapMotion, { who: "x", source: { asset: "v1" }, previous: { asset: "w1" }, ...over }), slots);
    expect(needs({})).toContain("h3Control");
    expect(needs({})).not.toContain("sdpose");
    expect(needs({ poseFrom: "SDPose" })).toEqual(expect.arrayContaining(["sdpose", "rtdetr"]));
    // the first window, a swap, is made without them; an empty pick of the ControlNet (its folder empty) is the slot's
    const first = parseInput(h3SwapMotion, { who: "x", source: { asset: "v1" }, controlModel: "" });
    expect(first.controlModel).toBeUndefined();
    expect(h3SwapMotion.needsWith!(first, slots)).not.toContain("h3Control");
  });

  it("refuses DWPose without its pack, with the way out", () => {
    const input = parseInput(h3SwapMotion, { who: "x", source: { asset: "v1", at: 5 }, previous: { asset: "w1" }, references: [{ asset: "r1", role: "person" }] });
    const ctx = dryContext({ slots, uploads: { source: "src.mp4", previous: "w.mp4", "references.0": "r1.png" }, media: { source: part(), previous: before() }, has: (cls) => cls !== "DWPreprocessor" });
    expect(() => h3SwapMotion.build(input, ctx)).toThrow(/comfyui_controlnet_aux.*SDPose/);
  });
});

describe("MiniMax H3 · Motion transfer", () => {
  const build = (over: Record<string, unknown> = {}, media: Record<string, MediaFacts> = {}) => {
    const input = parseInput(h3MotionTransfer, { picture: "p1", driving: { asset: "v1" }, description: "A man dances.", ...over });
    const built = h3MotionTransfer.build(input, dryContext({
      slots, uploads: { picture: "p.png", driving: "d.mp4", previous: "w.mp4", "previous.latent": "w.safetensors", "references.0": "r1.png" },
      media: { picture: { width: 832, height: 1472 }, driving: part({ width: 720, height: 1280 }), ...media },
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
  });

  it("waits for the Picture on a source lane (a required picture of its own), each window keeping its own prompt", () => {
    const picture = h3MotionTransfer.inputs.find((i) => i.id === "picture");
    expect(picture).toMatchObject({ type: "image", role: "source" });
    expect(picture && "optional" in picture ? picture.optional : undefined).toBeFalsy();
    expect(h3MotionTransfer.traits!.windows!.own).toEqual(["description", "happens"]);
  });
});

describe("a source's windows with H3's run-up", () => {
  it("are cut for the run-up the form has: 5, 22 or 39 frames, the recipe's 22 otherwise", () => {
    expect(carriedOf(h3Swap, {})).toBe(22);
    expect(carriedOf(h3Swap, { context: "39" })).toBe(39);
    expect(carriedOf(h3Swap, { context: "5" })).toBe(5);
    // a count it does not take is the recipe's own
    expect(carriedOf(h3Swap, { context: "17" })).toBe(22);
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
