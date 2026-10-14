import { describe, expect, it } from "vitest";
import { dryContext, parseInput, type MediaFacts } from "@afflatus/core";
import { scailMotion } from "../src/scail/motion";
import { chunkLengths } from "../src/motion/driving";
import { SCAIL_FPS } from "../src/scail/family";
import { wanAnimateMotion } from "../src/wananimate/motion";

type Node = { class_type: string; inputs: Record<string, unknown> };
type Graph = Record<string, Node>;
const of = (graph: Graph, type: string) => Object.values(graph).filter((n) => n.class_type === type);
const slots = {
  unet: "scail.safetensors", dpo: "dpo.safetensors", turbo: "lightx2v.safetensors", clip: "umt5.safetensors", vae: "wan_2.1_vae.safetensors",
  clipVision: "clip_vision_h.safetensors", sam: "sam3.1.safetensors", rife: "rife49.pth",
};
const part = (seconds: number, over: Partial<MediaFacts> = {}): MediaFacts => ({ width: 480, height: 854, frames: Math.round(seconds * SCAIL_FPS), fps: SCAIL_FPS, hasSound: true, ...over });

const build = (over: Record<string, unknown> = {}, driving: MediaFacts = part(81 / SCAIL_FPS), has?: (n: string) => boolean) => {
  const input = parseInput(scailMotion, { picture: "p1", driving: { asset: "v1" }, ...over });
  const built = scailMotion.build(input, dryContext({ slots, uploads: { picture: "p.png", driving: "d.mp4" }, media: { picture: { width: 768, height: 1360 }, driving }, ...(has ? { has } : {}) }));
  return { built, graph: built.graph as Graph };
};

describe("SCAIL-2 · Motion transfer", () => {
  it("cuts a part into SCAIL-2's 81-frame chunks, each after the first carrying 5 frames of the one before", () => {
    expect(chunkLengths(81, 81, 5)).toEqual([81]);
    expect(chunkLengths(49, 81, 5)).toEqual([49]);
    // 160 frames: 81, then 79 new ones in a chunk of 81 (76 new) and the 3 left over too few for a chunk
    expect(chunkLengths(157, 81, 5)).toEqual([81, 81]);
    expect(chunkLengths(161, 81, 5)).toEqual([81, 81, 9]);
    // whatever the part, the chunks' new frames stay on the 4k + 1 grid
    for (const total of [9, 77, 85, 233, 321]) {
      const made = chunkLengths(total, 81, 5).reduce((sum, n, i) => sum + (i ? n - 5 : n), 0);
      expect((made - 1) % 4).toBe(0);
      expect(made).toBeLessThanOrEqual(total);
      expect(total - made).toBeLessThan(4);
    }
  });

  it("animates the picture (Animation mode), in its shape, from the driving video's pose and SAM 3's masks", () => {
    const { graph } = build();
    const [cond] = of(graph, "WanSCAILToVideo");
    expect(cond!.inputs).toMatchObject({ replacement_mode: false, length: 81, previous_frame_count: 5, video_frame_offset: 0 });
    // tall like the picture, at 576p on the grid of 32 the node takes
    expect([cond!.inputs.width, cond!.inputs.height]).toEqual([576, 1024]);
    expect(of(graph, "SCAIL2ColoredMask")[0]!.inputs).toMatchObject({ replacement_mode: false, object_indices: "", sort_by: "left_to_right" });
    expect(of(graph, "SAM3_VideoTrack")).toHaveLength(2);
    // as ComfyUI's template: the DPO LoRA, then lightx2v at 0.8, 6 steps at CFG 1
    expect(of(graph, "LoraLoaderModelOnly").map((n) => [n.inputs.lora_name, n.inputs.strength_model])).toEqual([["dpo.safetensors", 1], ["lightx2v.safetensors", 0.8]]);
    expect(of(graph, "SamplerCustom")[0]!.inputs.cfg).toBe(1);
    expect(of(graph, "BasicScheduler")[0]!.inputs.steps).toBe(6);
  });

  it("takes a timeline's frame when it is on one, whatever the picture's shape", () => {
    const input = parseInput(scailMotion, { picture: "p1", driving: { asset: "v1" } });
    const graph = scailMotion.build(input, dryContext({ slots, uploads: { picture: "p.png", driving: "d.mp4" }, media: { picture: { width: 768, height: 1360 }, driving: part(81 / SCAIL_FPS) }, canvas: { width: 1024, height: 576 } })).graph as Graph;
    const cond = of(graph, "WanSCAILToVideo")[0]!;
    expect((cond.inputs.width as number) > (cond.inputs.height as number)).toBe(true);
  });

  it("makes a longer part in chunks inside the job, joined without their carried frames", () => {
    const { graph, built } = build({ drivingSeconds: 10 }, part(10));
    const conds = of(graph, "WanSCAILToVideo");
    expect(conds.map((n) => n.inputs.length)).toEqual([81, 81]);
    // the second chunk carries on from the first: its offset wired from it, the first chunk's frames handed over
    expect(Array.isArray(conds[1]!.inputs.video_frame_offset)).toBe(true);
    expect(conds[1]!.inputs.previous_frames).toBeDefined();
    expect(of(graph, "ImageFromBatch").some((n) => n.inputs.batch_index === 5)).toBe(true);
    expect(of(graph, "ImageBatch")).toHaveLength(1);
    expect(built.passes).toHaveLength(2);
  });

  it("matches the clip to the driving video, keeps its sound and doubles the frames with RIFE", () => {
    const { graph } = build();
    expect(of(graph, "ColorTransfer")[0]!.inputs).toMatchObject({ method: "reinhard_lab", source_stats: "uniform" });
    expect(of(graph, "ImageAddNoise")).toHaveLength(1);
    // brought down to the phone video's own short side (480), never made larger
    expect(of(graph, "ImageScale").at(-1)!.inputs).toMatchObject({ width: 480, height: 854 });
    expect(of(graph, "TrimAudioDuration")[0]!.inputs.duration).toBeCloseTo(81 / SCAIL_FPS);
    expect(of(graph, "FrameInterpolate")).toHaveLength(1);
    const plain = build({ matchDriving: false, keepSound: false, smooth: false }).graph;
    expect(of(plain, "ColorTransfer")).toHaveLength(0);
    expect(of(plain, "TrimAudioDuration")).toHaveLength(0);
    expect(of(plain, "FrameInterpolate")).toHaveLength(0);
    // a silent driving video: nothing to keep
    expect(of(build({}, part(81 / SCAIL_FPS, { hasSound: false })).graph, "TrimAudioDuration")).toHaveLength(0);
  });

  it("shows an animated live preview with KJNodes, on the model that samples", () => {
    const preview = of(build().graph, "ModelPreviewOverrideKJ");
    expect(preview).toHaveLength(1);
    expect(of(build({ livePreview: false }).graph, "ModelPreviewOverrideKJ")).toHaveLength(0);
  });

  it("moves only the person asked for, in the order asked", () => {
    const { graph } = build({ person: 2, order: "Biggest first" });
    expect(of(graph, "SCAIL2ColoredMask")[0]!.inputs).toMatchObject({ object_indices: "1", sort_by: "area" });
  });

  it("refuses without a picture or a driving video", () => {
    expect(() => scailMotion.build(parseInput(scailMotion, { driving: { asset: "v1" } }), dryContext({ slots, uploads: { driving: "d.mp4" } }))).toThrow(/picture/);
    // without a driving video the form is not valid: parseInput refuses it before any build
    expect(() => parseInput(scailMotion, { picture: "p1" })).toThrow();
  });
});

describe("Wan Animate 2 · Motion transfer", () => {
  const wslots = { unet: "wan_animate_2_int8_convrot.safetensors", turbo: "lightx2v.safetensors", clip: "umt5.safetensors", vae: "wan_2.1_vae.safetensors", clipVision: "clip_vision_h.safetensors", rife: "rife49.pth" };
  const at24 = (seconds: number): MediaFacts => ({ width: 480, height: 854, frames: Math.round(seconds * 24), fps: 24, hasSound: true });
  const wbuild = (over: Record<string, unknown> = {}, driving: MediaFacts = at24(81 / 24)) => {
    const input = parseInput(wanAnimateMotion, { picture: "p1", driving: { asset: "v1" }, ...over });
    return wanAnimateMotion.build(input, dryContext({ slots: wslots, uploads: { picture: "p.png", driving: "d.mp4" }, media: { picture: { width: 768, height: 1360 }, driving } })).graph as Graph;
  };

  it("runs as ComfyUI's template: the driving video as it is, lightx2v at 1, 6 steps of LCM at CFG 1, the reference's frame trimmed", () => {
    const graph = wbuild();
    const cond = of(graph, "WanAnimate2ToVideo")[0]!;
    expect(cond.inputs).toMatchObject({ length: 81, width: 576, height: 1024, pose_strength: 1, reference_image_strength: 1 });
    expect(of(graph, "LoraLoaderModelOnly")[0]!.inputs).toMatchObject({ lora_name: "lightx2v.safetensors", strength_model: 1 });
    expect(of(graph, "KSamplerSelect")[0]!.inputs.sampler_name).toBe("lcm");
    expect(of(graph, "WanAnimate2Cache")[0]!.inputs).toMatchObject({ device: "cpu", dtype: "int8" });
    expect(of(graph, "TrimVideoLatent")).toHaveLength(1);
    // one window: nothing carried on
    expect(of(graph, "WanAnimate2ToVideo")).toHaveLength(1);
  });

  it("keeps the driving video's pace (24 a second, as H3's), RIFE off by default, one window a job", () => {
    // 3.4 s at most: a longer part goes on a timeline, window after window
    expect(() => parseInput(wanAnimateMotion, { picture: "p1", driving: { asset: "v1" }, drivingSeconds: 10 })).toThrow();
    const graph = wbuild({ drivingSeconds: 3.3 }, at24(3.3));
    expect(of(graph, "WanAnimate2ToVideo").map((n) => n.inputs.length)).toEqual([77]);
    expect(of(graph, "ContextWindowsManual")).toHaveLength(0);
    expect(of(graph, "FrameInterpolate")).toHaveLength(0);
    expect(of(graph, "TrimAudioDuration")[0]!.inputs.duration).toBeCloseTo(77 / 24);
  });

  it("gives the motion branch its own prompt when one is written", () => {
    const graph = wbuild({ motion: "He raps to the camera." });
    const pose = of(graph, "WanAnimate2ToVideo")[0]!.inputs.positive_pose as [string, number];
    expect((graph[pose[0]]!.inputs as { text: string }).text).toBe("He raps to the camera.");
  });

  it("carries on from the clip before: its last frame starts the clip, and is dropped from it", () => {
    const input = parseInput(wanAnimateMotion, { picture: "p1", driving: { asset: "v1" }, previous: { asset: "v0" } });
    const graph = wanAnimateMotion.build(input, dryContext({ slots: wslots, uploads: { picture: "p.png", driving: "d.mp4", previous: "prev.mp4" }, media: { picture: { width: 768, height: 1360 }, driving: at24(81 / 24) } })).graph as Graph;
    expect(of(graph, "WanAnimate2ToVideo")[0]!.inputs.continue_motion).toBeDefined();
    expect(of(graph, "LoadVideo").map((n) => n.inputs.file)).toContain("prev.mp4");
    expect(of(graph, "ImageFromBatch").some((n) => Array.isArray(n.inputs.batch_index))).toBe(true);
  });
  it("keeps its own frames beside the clip, for the window after to carry on from", () => {
    const wa = wanAnimateMotion.build(parseInput(wanAnimateMotion, { picture: "p1", driving: { asset: "v1" } }), dryContext({ slots: wslots, uploads: { picture: "p.png", driving: "d.mp4" }, media: { picture: { width: 768, height: 1360 }, driving: at24(81 / 24) } }));
    expect(wa.outputs.map((o) => o.role)).toEqual(["result", "raw", "score"]);
  });
  it("keeps the sound of the frames it makes: from after the one carried over", () => {
    const input = parseInput(wanAnimateMotion, { picture: "p1", driving: { asset: "v1" }, previous: { asset: "v0" } });
    const graph = wanAnimateMotion.build(input, dryContext({ slots: wslots, uploads: { picture: "p.png", driving: "d.mp4", previous: "prev.mp4" }, media: { picture: { width: 768, height: 1360 }, driving: at24(81 / 24) } })).graph as Graph;
    const trim = of(graph, "TrimAudioDuration")[0]!;
    expect(trim.inputs.start_index).toBeCloseTo(1 / 24);
    expect(trim.inputs.duration).toBeCloseTo(80 / 24);
  });
});

describe("SCAIL-2 carrying on from the clip before", () => {
  it("anchors its first chunk on that clip's last 5 frames, dropped and colour-held as a chunk's", () => {
    const input = parseInput(scailMotion, { picture: "p1", driving: { asset: "v1" }, previous: { asset: "v0" } });
    const graph = scailMotion.build(input, dryContext({ slots, uploads: { picture: "p.png", driving: "d.mp4", previous: "prev.mp4" }, media: { picture: { width: 768, height: 1360 }, driving: part(81 / SCAIL_FPS) } })).graph as Graph;
    expect(of(graph, "WanSCAILToVideo")[0]!.inputs.previous_frames).toBeDefined();
    expect(of(graph, "ImageFromBatch").some((n) => n.inputs.batch_index === 5)).toBe(true);
  });
  it("keeps the sound of the frames it makes, from after the 5 carried over: windows of one source play its sound end to end", () => {
    const input = parseInput(scailMotion, { picture: "p1", driving: { asset: "v1" }, previous: { asset: "v0" } });
    const graph = scailMotion.build(input, dryContext({ slots, uploads: { picture: "p.png", driving: "d.mp4", previous: "prev.mp4" }, media: { picture: { width: 768, height: 1360 }, driving: part(81 / SCAIL_FPS) } })).graph as Graph;
    const trim = of(graph, "TrimAudioDuration")[0]!;
    expect(trim.inputs.start_index).toBeCloseTo(5 / SCAIL_FPS);
    expect(trim.inputs.duration).toBeCloseTo(76 / SCAIL_FPS);
  });
  it("keeps the model's own frames beside the clip, for the window after to carry on from (not the finished ones)", () => {
    const sc = scailMotion.build(parseInput(scailMotion, { picture: "p1", driving: { asset: "v1" } }), dryContext({ slots, uploads: { picture: "p.png", driving: "d.mp4" }, media: { picture: { width: 768, height: 1360 }, driving: part(81 / SCAIL_FPS) } }));
    expect(sc.outputs.map((o) => o.role)).toEqual(["result", "raw", "score"]);
    const raw = (sc.graph as Graph)[sc.outputs[1]!.node]!;
    // at the model's own speed, not RIFE's doubled one
    expect(JSON.stringify(raw.inputs)).toMatch(/16/);
  });
  it("measures the face along the clip against the Picture, with the Face Match node only", () => {
    const has = (n: string) => n !== "nothing";
    const { built } = build({}, part(81 / SCAIL_FPS), has);
    const score = built.outputs.find((o) => o.role === "score");
    expect(score).toBeDefined();
    expect((built.graph as Graph)[score!.node]!.class_type).toBe("AfflatusFaceMatch");
    const without = build({}, part(81 / SCAIL_FPS), (n) => n !== "AfflatusFaceMatch").built;
    expect(without.outputs.some((o) => o.role === "score")).toBe(false);
  });
  it("says it makes a long source window by window, carrying on from the clip before", () => {
    expect(scailMotion.traits).toMatchObject({ continues: "clip", windows: { most: 321, carried: 5 } });
    expect(wanAnimateMotion.traits).toMatchObject({ continues: "clip", windows: { most: 81, carried: 1 } });
  });
});

describe("what a motion render is priced on", () => {
  it("says its own frames, not ImageFromBatch's 'the rest of the batch' (4096)", () => {
    const input = parseInput(scailMotion, { picture: "p1", driving: { asset: "v1" }, previous: { asset: "v0" } });
    const built = scailMotion.build(input, dryContext({ slots, uploads: { picture: "p.png", driving: "d.mp4", previous: "prev.mp4" }, media: { picture: { width: 768, height: 1360 }, driving: part(81 / SCAIL_FPS) } }));
    expect(built.frames).toBe(81);
  });
});
