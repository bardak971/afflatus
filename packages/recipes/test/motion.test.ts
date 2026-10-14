import { describe, expect, it } from "vitest";
import { dryContext, parseInput, type MediaFacts } from "@afflatus/core";
import { scailMotion } from "../src/scail/motion";
import { chunkLengths } from "../src/motion/driving";
import { SCAIL_FPS } from "../src/scail/family";

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
