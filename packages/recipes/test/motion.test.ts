import { describe, expect, it } from "vitest";
import { dryContext, parseInput, sourceWindows, type MediaFacts } from "@afflatus/core";
import { scailMotion, scailMotion24 } from "../src/scail/motion";
import { chunkLengths } from "../src/motion/driving";
import { SCAIL_FPS, SCAIL_H3_GRID } from "../src/scail/family";

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
    // the DPO LoRA at the strength asked (its authors lower it when the driving face shows through), and not at all at 0
    expect(of(build({ dpoStrength: 0.6 }).graph, "LoraLoaderModelOnly").map((n) => n.inputs.strength_model)).toEqual([0.6, 0.8]);
    expect(of(build({ dpoStrength: 0 }).graph, "LoraLoaderModelOnly").map((n) => n.inputs.lora_name)).toEqual(["lightx2v.safetensors"]);
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
    // the two chunks joined (nothing else: the last frame is no longer held, and a window that opens a shot has no lead frame)
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
  });
});

describe("SCAIL-2 at 24 fps on H3's grid (card #36, offered beside the 16 fps one)", () => {
  const at24 = (seconds: number) => {
    const input = parseInput(scailMotion24, { picture: "p1", driving: { asset: "v1" }, drivingSeconds: seconds });
    const media = { picture: { width: 768, height: 1360 }, driving: { width: 480, height: 854, frames: Math.round(seconds * 24), fps: 24, hasSound: true } };
    return scailMotion24.build(input, dryContext({ slots, uploads: { picture: "p.png", driving: "d.mp4" }, media }));
  };
  const lengthOf = (graph: Graph) => of(graph, "WanSCAILToVideo").map((n) => Number(n.inputs.length));
  it("makes only counts on both Wan's grid and H3's: 73, 141, 209, 277 frames", () => {
    for (const n of [73, 141, 209, 277]) expect([(n - 1) % 4, (n - 5) % 17]).toEqual([0, 0]);
    expect(lengthOf(at24(3.2).graph as Graph)).toEqual([73]);
    // 5.9 s, H3's longest clip: 141 frames, as an 81-frame chunk and one of 65 (60 new)
    expect(lengthOf(at24(5.9).graph as Graph)).toEqual([81, 65]);
    // its longest, 11.5 s: 277 frames in 81-frame chunks
    expect(at24(11.55).frames).toBe(81);
    expect(lengthOf(at24(11.55).graph as Graph).reduce((a, b) => a + b - 5, 5)).toBe(277);
    // the form starts on 141 frames (5.9 s), not on 5 s, which would make 73
    expect(scailMotion24.inputs.find((i) => i.id === "drivingSeconds")).toMatchObject({ default: 141 / 24 });
  });
  it("is a 24 fps recipe to the timeline, its driving video and clip before cut at 24, offered", () => {
    expect(scailMotion24.traits).toMatchObject({ fps: 24, frameGrid: SCAIL_H3_GRID, windows: { most: 277, least: 73, carried: 5 } });
    const clips = scailMotion24.inputs.filter((i) => i.type === "clip");
    expect(clips.map((i) => (i.type === "clip" ? i.fps : 0))).toEqual([24, 24]);
    expect(scailMotion24.hidden).toBeUndefined();
    // RIFE is not on by default at 24 (it is at 16)
    expect(scailMotion24.inputs.find((i) => i.id === "smooth")).toMatchObject({ default: false });
  });
  it("leaves the 16 fps recipe as it was", () => {
    expect(scailMotion.traits).toMatchObject({ fps: 16, frameGrid: { step: 4, offset: 1 }, windows: { most: 321, least: 9 } });
    expect(scailMotion.hidden).toBeUndefined();
  });
});

describe("what a motion render is priced on", () => {
  it("says its own frames, not ImageFromBatch's 'the rest of the batch' (4096)", () => {
    const input = parseInput(scailMotion, { picture: "p1", driving: { asset: "v1" }, previous: { asset: "v0" } });
    const built = scailMotion.build(input, dryContext({ slots, uploads: { picture: "p.png", driving: "d.mp4", previous: "prev.mp4" }, media: { picture: { width: 768, height: 1360 }, driving: part(81 / SCAIL_FPS) } }));
    expect(built.frames).toBe(81);
    // a longer part: the steps counted per chunk, the frames a step samples are one chunk
    const long = scailMotion.build(parseInput(scailMotion, { picture: "p1", driving: { asset: "v1" }, drivingSeconds: 20 }), dryContext({ slots, uploads: { picture: "p.png", driving: "d.mp4" }, media: { picture: { width: 768, height: 1360 }, driving: part(20) } }));
    expect(long.frames).toBe(81);
    expect(long.totalSteps).toBe(6 * 5);
  });

  it("says each chunk's frames: a window carried on into a short last chunk is priced by what it samples, not as two whole chunks", () => {
    // Timeline 17's second window: 5.34 s of the driving video, 85 frames, a chunk of 81 and one of 9
    const { built } = build({ drivingSeconds: 5.3438 }, part(5.3438));
    expect(built.passes!.map((p) => [p.steps, p.frames])).toEqual([[6, 81], [6, 9]]);
    expect(built.totalSteps).toBe(12);
  });
});

/** The node a link points at. */
const at = (graph: Graph, ref: unknown) => graph[(ref as [string, number])[0]]!;
/** Whether a node of `type` is upstream of `ref`. */
const above = (graph: Graph, ref: unknown, type: string): boolean => {
  if (!Array.isArray(ref) || typeof ref[0] !== "string" || !graph[ref[0]]) return false;
  const node = at(graph, ref);
  return node.class_type === type || Object.values(node.inputs).some((v) => above(graph, v, type));
};
/**
 * How many frames a link carries, from the frames the model's decode gives (`decoded`): the nodes between the model and the
 * file, counted as ComfyUI does (RIFE ×2 makes 2n − 1; ImageFromBatch takes what is there; a node of the clip before's is 1).
 */
const framesOf = (graph: Graph, ref: unknown, decoded: number): number => {
  const node = at(graph, ref);
  const i = node.inputs;
  switch (node.class_type) {
    case "VAEDecode":
      return decoded;
    case "LoadImage":
      return 1;
    case "FrameInterpolate":
      return 2 * framesOf(graph, i.images, decoded) - 1;
    case "ImageBatch":
      return framesOf(graph, i.image1, decoded) + framesOf(graph, i.image2, decoded);
    case "ImageFromBatch": {
      const n = framesOf(graph, i.image, decoded);
      // a link: what the node says
      const from = typeof i.batch_index === "number" ? (i.batch_index < 0 ? i.batch_index + n : i.batch_index) : 1;
      return Math.min(n - from, i.length as number);
    }
    case "ColorTransfer":
      return framesOf(graph, i.image_target, decoded);
    default:
      return framesOf(graph, i.image ?? i.images, decoded);
  }
};

describe("a Motion transfer window as filed", () => {
  const SHAPES = [
    { recipe: scailMotion, slots, fps: 16, shape: { fps: 16, most: 321, least: 9, carried: 5 } },
  ] as const;
  const made = (recipe: (typeof SHAPES)[number]["recipe"], s: Record<string, string>, fps: number, over: Record<string, unknown>, uploads: Record<string, string> = {}) => {
    const input = parseInput(recipe as typeof scailMotion, { picture: "p1", driving: { asset: "v1" }, ...over });
    return recipe.build(input as never, dryContext({
      slots: s, uploads: { picture: "p.png", driving: "d.mp4", ...uploads },
      media: { picture: { width: 768, height: 1360 }, driving: { width: 480, height: 854, frames: 81, fps, hasSound: true } },
    }));
  };

  it("takes every window a timeline makes of a long source: its first, those carrying on and those after a scene cut", () => {
    for (const { recipe, shape, fps } of SHAPES) {
      for (const windowMs of [1000, 3000, 3400, 5000, 8000, 20_000, 30_000]) {
        for (const cutsMs of [[], [7300, 15_100, 40_000]]) {
          const windows = sourceWindows({ fromMs: 1500, toMs: 61_500, windowMs, shape, cutsMs });
          expect(windows.length).toBeGreaterThan(1);
          expect(windows.some((w) => !w.opens)).toBe(true);
          for (const w of windows) {
            const input = parseInput(recipe as typeof scailMotion, { picture: "p1", driving: { asset: "v1" }, drivingStart: w.start, drivingSeconds: w.seconds });
            // the part cut at the model's speed holds the frames planned: those it shows, and those carried
            const planned = Math.round((w.toMs - w.fromMs) / (1000 / fps)) + (w.opens ? 0 : shape.carried);
            expect(Math.floor(input.drivingSeconds * fps)).toBeGreaterThanOrEqual(planned);
          }
        }
      }
    }
  });

  it("with RIFE ×2: 2n − 1 frames at twice the rate, a window that carries on opening on the frame between the clip before's last and its own first, its sound from there", () => {
    for (const { recipe, slots: s, fps, shape } of SHAPES) {
      for (const previous of [false, true]) {
        const built = made(recipe, s, fps, { drivingSeconds: 81.5 / fps, smooth: true, ...(previous ? { previous: { asset: "v0" } } : {}) }, previous ? { previous: "prev.mp4", "previous.look": "prev.png" } : {});
        const graph = built.graph as Graph;
        const saver = graph[built.outputs[0]!.node]!;
        const carried = previous ? shape.carried : 0;
        const filed = framesOf(graph, saver.inputs.images, 81);
        const own = 81 - carried;
        // its last frame no longer held (a stop of 1/32 s at every join, then a jump): 2n − 1, and one more before them when it
        // carries on, RIFE's frame from the clip before's last as filed (dropped after RIFE) to its own first
        expect(filed).toBe(previous ? 2 * own : 2 * own - 1);
        expect(saver.inputs.frame_rate).toBe(2 * fps);
        const trim = of(graph, "TrimAudioDuration")[0]!.inputs;
        // its sound as long as its own part, from half a model frame before it when it carries on: the clock stays the source's
        expect(trim.duration as number).toBeCloseTo(own / fps, 6);
        expect(trim.start_index as number).toBeCloseTo(previous ? (carried - 0.5) / fps : 0, 6);
        if (previous) {
          expect(of(graph, "FrameInterpolate").map((n) => at(graph, n.inputs.images).class_type)).toEqual(["ImageBatch"]);
        }
        // the model's own frames beside it, as made, at the model's speed: not matched, not grained
        const raw = graph[built.outputs[1]!.node]!;
        expect(framesOf(graph, raw.inputs.images, 81)).toBe(81 - carried);
        expect(raw.inputs.frame_rate).toBe(fps);
        expect(above(graph, raw.inputs.images, "ImageAddNoise")).toBe(false);
        expect(above(graph, raw.inputs.images, "ImageBlur")).toBe(false);
      }
      // without RIFE, n frames at the model's speed
      const plain = made(recipe, s, fps, { drivingSeconds: 81.5 / fps, smooth: false });
      expect(framesOf(plain.graph as Graph, (plain.graph as Graph)[plain.outputs[0]!.node]!.inputs.images, 81)).toBe(81);
    }
  });

  it("puts its grain on last, after RIFE: grain interpolated shimmered at half the rate", () => {
    for (const { recipe, slots: s, fps } of SHAPES) {
      const built = made(recipe, s, fps, { smooth: true });
      const graph = built.graph as Graph;
      const saver = graph[built.outputs[0]!.node]!;
      expect(at(graph, saver.inputs.images).class_type).toBe("ImageAddNoise");
      expect(above(graph, saver.inputs.images, "FrameInterpolate")).toBe(true);
      const interpolate = of(graph, "FrameInterpolate")[0]!;
      expect(above(graph, interpolate.inputs.images, "ImageAddNoise")).toBe(false);
      // the colour and the softness still before it
      expect(above(graph, interpolate.inputs.images, "ColorTransfer")).toBe(true);
      expect(above(graph, interpolate.inputs.images, "ImageBlur")).toBe(true);
      // not asked to match the driving video: no grain either
      expect(of(made(recipe, s, fps, { smooth: true, matchDriving: false }).graph as Graph, "ImageAddNoise")).toHaveLength(0);
    }
  });

  it("samples on the form's Shift: the scheduler reads the shifted model, at SCAIL-2's own 8 by default", () => {
    for (const { recipe, slots: s, fps } of SHAPES) {
      const scheduler = (over: Record<string, unknown>) => {
        const graph = made(recipe, s, fps, over).graph as Graph;
        return at(graph, of(graph, "BasicScheduler")[0]!.inputs.model);
      };
      expect(scheduler({}).class_type).toBe("ModelSamplingSD3");
      expect(scheduler({}).inputs.shift).toBe(8);
      expect(scheduler({ shift: 3 }).inputs.shift).toBe(3);
    }
  });
});

describe("SCAIL-2's chunks", () => {
  it("anchor each chunk on the one before as it is kept: its colours held, from the second chunk on", () => {
    const { graph } = build({ drivingSeconds: 20 }, part(20));
    const conds = of(graph, "WanSCAILToVideo");
    expect(conds.length).toBeGreaterThanOrEqual(3);
    // the first chunk hands on its frames as decoded (nothing was held), every one after its frames as held
    expect(at(graph, conds[1]!.inputs.previous_frames).class_type).toBe("VAEDecode");
    for (const cond of conds.slice(2)) expect(at(graph, cond.inputs.previous_frames).class_type).toBe("ColorTransfer");
    // without ColorTransfer, as decoded
    const plain = build({ drivingSeconds: 20 }, part(20), (n) => n !== "ColorTransfer").graph;
    for (const cond of of(plain, "WanSCAILToVideo").slice(1)) expect(at(plain, cond.inputs.previous_frames).class_type).toBe("VAEDecode");
  });
});

describe("a Motion transfer window matched to the driving video", () => {
  const scail = (uploads: Record<string, string>, over: Record<string, unknown> = {}) => {
    const input = parseInput(scailMotion, { picture: "p1", driving: { asset: "v1" }, ...(uploads.previous ? { previous: { asset: "v0" } } : {}), ...over });
    return scailMotion.build(input, dryContext({ slots, uploads: { picture: "p.png", driving: "d.mp4", ...uploads }, media: { picture: { width: 768, height: 1360 }, driving: part(81 / SCAIL_FPS) } })).graph as Graph;
  };
  const toDriving = (graph: Graph) => of(graph, "ColorTransfer").filter((n) => n.inputs.source_stats === "uniform");

  it("opening a shot, takes the driving video's colours, pooled over its part", () => {
    const graph = scail({});
    expect(toDriving(graph)).toHaveLength(1);
    expect(at(graph, toDriving(graph)[0]!.inputs.image_ref).class_type).toBe("ImageScale");
  });

  it("carrying on, takes the transform the clip before was filed with: read from its own first frame to that clip's last as filed", () => {
    const graph = scail({ previous: "prev.mp4", "previous.look": "prev.png" });
    expect(toDriving(graph)).toHaveLength(0);
    const look = of(graph, "ColorTransfer").find((n) => n.inputs.source_stats === "target_frame")!;
    expect(look.inputs).toMatchObject({ method: "reinhard_lab", "source_stats.target_index": 0, strength: 1 });
    expect(at(graph, look.inputs.image_ref).inputs.image).toBe("prev.png");
    // the frame it is read from: its first, softened and grained as the clip before's last was filed, put before the clip
    const both = at(graph, look.inputs.image_target);
    expect(both.class_type).toBe("ImageBatch");
    expect(at(graph, both.inputs.image1).class_type).toBe("ImageAddNoise");
    expect(above(graph, both.inputs.image1, "ImageBlur")).toBe(true);
    // and dropped after: the clip keeps its own frames
    const after = of(graph, "ImageFromBatch").find((n) => at(graph, n.inputs.image) === look)!;
    expect(after.inputs).toMatchObject({ batch_index: 1, length: 4096 });
  });

  it("carrying on without the clip before's last frame as filed (not read), takes the driving video's colours as before", () => {
    expect(toDriving(scail({ previous: "prev.mp4" }))).toHaveLength(1);
    expect(of(scail({ previous: "prev.mp4", "previous.look": "prev.png" }, { matchDriving: false }), "ColorTransfer").filter((n) => n.inputs.source_stats !== "per_frame")).toHaveLength(0);
  });
});
