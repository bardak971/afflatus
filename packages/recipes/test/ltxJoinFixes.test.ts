import { describe, expect, it } from "vitest";
import { dryContext, parseInput } from "@afflatus/core";
import { ltxLipSync, ltxVideo, ltx25LipSync, ltx25Video } from "../src";

// #85's fixes to LTX (cards #2 and #40, 2026-10-25): 2.3's pinned silences filled with Room Tone, 2.5's seam colour hand-over
type Recipe = typeof ltxVideo;
type Built = ReturnType<Recipe["build"]>;
type Node = Built["graph"][string];

const one = { checkpoint: "ltx-2.3-22b-distilled.safetensors", clip: "gemma.safetensors", upscaler: "up.safetensors" };
const parts = { unet: "ltx-2.5-distilled.safetensors", clip: "gemma4.safetensors", videoVae: "v.safetensors", audioVae: "a.safetensors", upscaler: "up.safetensors" };
const rec = (seconds: number) => ({ recording: { width: 0, height: 0, seconds } });
const before = (fps: number) => ({ width: 1280, height: 704, frames: 25, fps, hasSound: true });
const inLatent = (fps: number) => ({ ...before(fps), latentFrames: 121, latentSize: { width: 1280, height: 704 } });

function build(recipe: Recipe, over: Record<string, unknown>, ctx: Parameters<typeof dryContext>[0] = {}): Built {
  const slots = recipe.family === "ltx25" ? parts : one;
  return recipe.build(parseInput(recipe, { prompt: "She speaks to the camera.", ...over }), dryContext({ seed: 7, slots, uploads: { previous: "c.mp4", recording: "rec.wav" }, ...ctx }));
}
const all = (b: Built, cls: string) => Object.entries(b.graph).filter(([, n]) => n.class_type === cls);
const ref = (b: Built, r: unknown): Node => b.graph[(r as [string, number])[0]]!;
const idOf = (b: Built, cls: string) => all(b, cls)[0]![0];
const save = (b: Built) => all(b, "VHS_VideoCombine")[0]![1].inputs;
const encodes = (b: Built) => all(b, "LTXVAudioVAEEncode").map(([, n]) => ref(b, n.inputs.audio));

describe("LTX 2.3's pinned sound: its stretches of exact silence filled first (Room Tone)", () => {
  it("Lip sync: the recording through Room Tone into the encoder, the take's sound the recording as it is", () => {
    const b = build(ltxLipSync, { recording: "a1", recordingSeconds: 5.16 }, { media: rec(5.16) });
    const [toned] = encodes(b);
    expect(toned).toMatchObject({ class_type: "AfflatusRoomTone", inputs: { level_db: -50, seed: 0 } });
    // the take carries what the model was given before the noise: the sound itself
    expect(save(b).audio).toEqual(toned!.inputs.audio);
    expect(ref(b, save(b).audio).class_type).toBe("TrimAudioDuration");
    expect(b.warnings).toBeUndefined();
  });

  it("Lip sync carried on from a sung clip, in its latent: the clip before's sound under the head and the part, filled together", () => {
    const b = build(ltxLipSync, { previous: { asset: "c" }, recording: "a1", recordingSeconds: 6.14 }, { uploads: { previous: "c.mp4", "previous.latent": "c.safetensors", recording: "rec.wav" }, media: { previous: inLatent(25), ...rec(6.14) } });
    expect(all(b, "AfflatusLTXContinuation")).toHaveLength(1);
    const [toned] = encodes(b);
    expect(toned!.class_type).toBe("AfflatusRoomTone");
    expect(ref(b, toned!.inputs.audio).class_type).toBe("AudioConcat");
    expect(all(b, "AfflatusRoomTone")).toHaveLength(1);
  });

  it("Video with audio after a Lip sync clip, on frames: the head's sound (the clip before's file) filled before it is pinned", () => {
    const b = build(ltxVideo, { previous: { asset: "c" }, seconds: 5 }, { media: { previous: before(25) } });
    const [toned] = encodes(b);
    expect(toned).toMatchObject({ class_type: "AfflatusRoomTone", inputs: { audio: [idOf(b, "GetVideoComponents"), 1] } });
    // the model's own sound is the take's, as before
    expect(ref(b, save(b).audio).class_type).toBe("LTXVAudioVAEDecode");
  });

  it("Video with audio's cues: the sound they are laid in filled too", () => {
    const b = build(ltxVideo, { seconds: 5, cues: [{ asset: "s1", start: 0, seconds: 0.6, at: 2.4 }] }, { uploads: { "cues.0": "clap.wav" }, media: { "cues.0": { width: 0, height: 0, seconds: 0.6 } } });
    expect(encodes(b).map((n) => n.class_type)).toEqual(["AfflatusRoomTone"]);
  });

  it("without the node (a pack before 0.41.0): pinned as it is, and Lip sync says so", () => {
    const has = (n: string) => n !== "AfflatusRoomTone";
    const lip = build(ltxLipSync, { recording: "a1", recordingSeconds: 5 }, { media: rec(5), has });
    expect(all(lip, "AfflatusRoomTone")).toEqual([]);
    expect(encodes(lip)[0]!.class_type).toBe("TrimAudioDuration");
    expect(lip.warnings?.join(" ")).toMatch(/no Room Tone \(0\.41\.0\).*LTX 2\.3 can fade the picture to black/);
    const video = build(ltxVideo, { previous: { asset: "c" }, seconds: 5 }, { media: { previous: before(25) }, has });
    expect(video.warnings).toBeUndefined();
  });

  it("2.5 is left as it is: the same recording did not fade there", () => {
    const b = build(ltx25LipSync, { recording: "a1", recordingSeconds: 5.16 }, { media: rec(5.16) });
    expect(all(b, "AfflatusRoomTone")).toEqual([]);
    expect(ltx25LipSync.optionalNodes).not.toContain("AfflatusRoomTone");
    expect(ltxLipSync.optionalNodes).toContain("AfflatusRoomTone");
  });
});

describe("LTX 2.5's seam: its first own frames brought to the clip before's last as filed, then let go over a second", () => {
  const latentCtx = (fps: number, more: Record<string, string> = {}) => ({ uploads: { previous: "c.mp4", "previous.latent": "c.safetensors", ...more }, media: { previous: inLatent(fps) } });

  it("one transform from the first own frame to the run-up's last, at full strength, then three quarters, half and a quarter", () => {
    const b = build(ltx25Video, { previous: { asset: "c" }, seconds: 5 }, latentCtx(24));
    expect(b.overlap).toMatchObject({ latent: true, seam: true });
    const frames = b.frames!;
    const [[, transfer]] = all(b, "ColorTransfer") as [[string, Node]];
    expect(transfer.inputs).toMatchObject({ method: "reinhard_lab", source_stats: "target_frame", "source_stats.target_index": 0, strength: 1 });
    // the target: a second of the seam's own frames from the first after the head (25), at 24 a second
    const target = ref(b, transfer.inputs.image_target);
    expect(target.inputs).toMatchObject({ batch_index: 25, length: 24 });
    expect(ref(b, target.inputs.image).inputs).toMatchObject({ batch_index: 32, length: frames });
    // the reference: the run-up as handed over, its last frame
    const filed = ref(b, transfer.inputs.image_ref);
    expect(filed.inputs).toMatchObject({ image: [idOf(b, "GetVideoComponents"), 0], batch_index: 24, length: 1 });
    expect(all(b, "ImageBlend").map(([, n]) => n.inputs.blend_factor)).toEqual([0.75, 0.5, 0.25]);
    // head, four pieces of six frames, then the rest: what is filed and scored
    const batches = all(b, "ImageBatch");
    expect(batches).toHaveLength(5);
    const rest = ref(b, batches.at(-1)![1].inputs.image2);
    expect(rest.inputs).toMatchObject({ batch_index: 49, length: frames - 49 });
    expect(save(b).images).toEqual([batches.at(-1)![0], 0]);
  });

  it("not on 2.3 (its decode agreed to ΔE 0.2), on frames, nor with the chain's colour match carried on", () => {
    const b23 = build(ltxVideo, { previous: { asset: "c" }, seconds: 5 }, latentCtx(25));
    expect(b23.overlap).toMatchObject({ seam: true });
    expect(all(b23, "ColorTransfer")).toEqual([]);
    expect(all(build(ltx25Video, { previous: { asset: "c" }, seconds: 5 }, { media: { previous: before(24) } }), "ColorTransfer")).toEqual([]);
    // the look carried on instead: one ColorTransfer, colourCarried's, over every frame
    const look = build(ltx25Video, { previous: { asset: "c" }, seconds: 5 }, { ...latentCtx(24, { "previous.look": "look.png" }), has: (n: string) => n !== "AfflatusColorFollow" });
    expect(all(look, "ColorTransfer").map(([, n]) => n.inputs.source_stats)).toEqual(["target_frame"]);
    expect(all(look, "ImageBlend")).toEqual([]);
  });

  it("Lip sync carried on in the latent gets it too, and a ComfyUI without ColorTransfer the seam as decoded", () => {
    const lip = build(ltx25LipSync, { previous: { asset: "c" }, recording: "a1", recordingSeconds: 5 }, { ...latentCtx(24, { recording: "rec.wav" }), media: { previous: inLatent(24), ...rec(5) } });
    expect(all(lip, "ColorTransfer")).toHaveLength(1);
    const bare = build(ltx25Video, { previous: { asset: "c" }, seconds: 5 }, { ...latentCtx(24), has: (n: string) => n !== "ColorTransfer" });
    expect(all(bare, "ImageBlend")).toEqual([]);
  });

  it("the chain's colour match carried on through the temporal upscaler: the run-up's last frame and Colour Follow's rate doubled", () => {
    const at = (b: Built) => all(b, "ColorTransfer")[0]![1].inputs["source_stats.target_index"] as number;
    const noFollow = { has: (n: string) => n !== "AfflatusColorFollow" };
    const asIs = build(ltx25Video, { previous: { asset: "c" }, seconds: 5 }, { uploads: { previous: "c.mp4", "previous.look": "look.png" }, media: { previous: before(24) }, ...noFollow });
    // on frames: a clip carried on in the latent takes RIFE (card #105)
    const doubledCtx = { uploads: { previous: "c.mp4", "previous.look": "look.png" }, media: { previous: before(24) }, slots: { ...parts, temporal: "t.safetensors" } };
    const doubled = build(ltx25Video, { previous: { asset: "c" }, seconds: 5, smooth: true, smoothWith: "LTX temporal (latent)" }, { ...doubledCtx, ...noFollow });
    // T tokens become 2T - 1: frame i of the model's is frame 2i of the doubled clip
    expect(at(asIs)).toBeGreaterThan(0);
    expect(at(doubled)).toBe(2 * at(asIs));
    const radius = (b: Built) => all(b, "AfflatusColorFollow")[0]![1].inputs.radius;
    expect(radius(build(ltx25Video, { previous: { asset: "c" }, seconds: 5 }, { uploads: { previous: "c.mp4", "previous.look": "look.png" }, media: { previous: before(24) } }))).toBe(12);
    expect(radius(build(ltx25Video, { previous: { asset: "c" }, seconds: 5, smooth: true, smoothWith: "LTX temporal (latent)" }, doubledCtx))).toBe(24);
  });
});

// card #105: a clip carried on in the latent is doubled by RIFE, not by the temporal upscaler (#40's jump at the join)
describe("Interpolate ×2 on a clip carried on in the clip before's latent: RIFE", () => {
  const withBoth = { ...parts, temporal: "t.safetensors", rife: "rife49.pth" };
  const inLatentCtx = { uploads: { previous: "c.mp4", "previous.latent": "c.safetensors" }, media: { previous: inLatent(24) }, slots: withBoth };
  // the temporal upscaler's file loaded (the spatial one, two passes, is an LTXVLatentUpsampler too)
  const temporalLoads = (b: Built) => all(b, "LatentUpscaleModelLoader").filter(([, n]) => n.inputs.model_name === "t.safetensors");
  const said = "Interpolated with RIFE, not LTX's temporal upscaler: this clip carries on in the clip before's latent, where the upscaler's settle pass makes the frames at the join anew and the join jumps.";

  it("Auto takes RIFE there, without a word, and the join is decoded as one piece", () => {
    const b = build(ltx25Video, { previous: { asset: "c" }, seconds: 5, smooth: true }, inLatentCtx);
    expect(temporalLoads(b)).toEqual([]);
    expect(all(b, "FrameInterpolate")).toHaveLength(1);
    expect(b.overlap).toMatchObject({ latent: true, seam: true });
    expect(b.warnings ?? []).not.toContain(said);
    expect(b.loads).not.toContain("latent_upscale_models/t.safetensors");
    // the same clip on frames (no kept latent) still takes the temporal upscaler
    const frames = build(ltx25Video, { previous: { asset: "c" }, seconds: 5, smooth: true }, { uploads: { previous: "c.mp4" }, media: { previous: before(24) }, slots: withBoth });
    expect(temporalLoads(frames)).toHaveLength(1);
    expect(all(frames, "FrameInterpolate")).toEqual([]);
  });

  it("the temporal upscaler asked for by name: RIFE, and one line on the job says why; even without its file", () => {
    for (const recipe of [ltx25Video, ltxVideo]) {
      const ctx = recipe === ltxVideo ? { ...inLatentCtx, media: { previous: inLatent(25) }, slots: { ...one, temporal: "t.safetensors", rife: "rife49.pth" } } : inLatentCtx;
      const b = build(recipe, { previous: { asset: "c" }, seconds: 5, smooth: true, smoothWith: "LTX temporal (latent)" }, ctx);
      expect(temporalLoads(b)).toEqual([]);
      expect(all(b, "FrameInterpolate")).toHaveLength(1);
      expect(b.overlap).toMatchObject({ latent: true, seam: true });
      expect(b.warnings!.filter((w) => w === said)).toHaveLength(1);
    }
    const without = build(ltx25Video, { previous: { asset: "c" }, seconds: 5, smooth: true, smoothWith: "LTX temporal (latent)" }, { ...inLatentCtx, slots: { ...parts, rife: "rife49.pth" } });
    expect(all(without, "FrameInterpolate")).toHaveLength(1);
    expect(() => build(ltx25Video, { seconds: 5, smooth: true, smoothWith: "LTX temporal (latent)" }, { slots: { ...parts, rife: "rife49.pth" } })).toThrow(/temporal upscaler was not found/);
  });

  it("a clip that carries on is sent RIFE, and Face refine's files and nodes, whichever way it goes", () => {
    const values = parseInput(ltx25Video, { prompt: "a", previous: { asset: "c" }, smooth: true, smoothWith: "LTX temporal (latent)", faceRefine: true });
    expect(ltx25Video.needsWith!(values, { temporal: "t.safetensors" })).toEqual(expect.arrayContaining(["rife", "temporal"]));
    expect(ltx25Video.nodes(values)).toContain("MiniMaxH3ReferenceToVideo");
    // a clip on its own, doubled by the temporal upscaler: neither
    const alone = parseInput(ltx25Video, { prompt: "a", smooth: true, smoothWith: "LTX temporal (latent)", faceRefine: true });
    expect(ltx25Video.needsWith!(alone, { temporal: "t.safetensors" })).not.toContain("rife");
    expect(ltx25Video.nodes(alone)).not.toContain("MiniMaxH3ReferenceToVideo");
  });
});

// card #108: the clip before a join in the latent takes RIFE too, so a whole chain in the latent does (the join after a clip
// the temporal upscaler doubled still stepped ×7.6 on the pod re-check)
describe("Interpolate ×2 on a clip the clip after carries on in, in its latent: RIFE", () => {
  const withBoth = { ...parts, temporal: "t.safetensors", rife: "rife49.pth" };
  const temporalLoads = (b: Built) => all(b, "LatentUpscaleModelLoader").filter(([, n]) => n.inputs.model_name === "t.safetensors");
  const said = "Interpolated with RIFE, not LTX's temporal upscaler: the clip after carries on in this clip's latent, where the upscaler's settle pass makes the frames at the join anew and the join jumps.";

  it("Auto takes RIFE there without a word; a clip nothing carries on from keeps the temporal upscaler", () => {
    const first = build(ltx25Video, { seconds: 5, smooth: true, latentAfter: true }, { slots: withBoth });
    expect(temporalLoads(first)).toEqual([]);
    expect(all(first, "FrameInterpolate")).toHaveLength(1);
    expect(first.warnings ?? []).not.toContain(said);
    const alone = build(ltx25Video, { seconds: 5, smooth: true }, { slots: withBoth });
    expect(temporalLoads(alone)).toHaveLength(1);
    expect(all(alone, "FrameInterpolate")).toEqual([]);
  });

  it("a chain of three on Auto: RIFE on each clip, the joins decoded as one piece", () => {
    const inLatentCtx = { uploads: { previous: "c.mp4", "previous.latent": "c.safetensors" }, media: { previous: inLatent(24) }, slots: withBoth };
    const chain = [
      build(ltx25Video, { seconds: 5, smooth: true, latentAfter: true }, { slots: withBoth }),
      build(ltx25Video, { previous: { asset: "c" }, seconds: 5, smooth: true, latentAfter: true }, inLatentCtx),
      build(ltx25Video, { previous: { asset: "c" }, seconds: 5, smooth: true }, inLatentCtx),
    ];
    for (const b of chain) {
      expect(temporalLoads(b)).toEqual([]);
      expect(all(b, "FrameInterpolate")).toHaveLength(1);
    }
    for (const b of chain.slice(1)) expect(b.overlap).toMatchObject({ latent: true, seam: true });
  });

  it("the temporal upscaler asked for by name: RIFE, one line on the job says why, even without its file", () => {
    for (const recipe of [ltx25Video, ltxVideo]) {
      const slots = recipe === ltxVideo ? { ...one, temporal: "t.safetensors", rife: "rife49.pth" } : withBoth;
      const b = build(recipe, { seconds: 5, smooth: true, smoothWith: "LTX temporal (latent)", latentAfter: true }, { slots });
      expect(temporalLoads(b)).toEqual([]);
      expect(all(b, "FrameInterpolate")).toHaveLength(1);
      expect(b.warnings!.filter((w) => w === said)).toHaveLength(1);
    }
    const without = build(ltx25Video, { seconds: 5, smooth: true, smoothWith: "LTX temporal (latent)", latentAfter: true }, { slots: { ...parts, rife: "rife49.pth" } });
    expect(all(without, "FrameInterpolate")).toHaveLength(1);
  });

  it("is sent RIFE's files and Face refine's, not the temporal file it would not use", () => {
    const values = parseInput(ltx25Video, { prompt: "a", smooth: true, smoothWith: "LTX temporal (latent)", faceRefine: true, latentAfter: true });
    const needs = ltx25Video.needsWith!(values, { temporal: "t.safetensors" });
    expect(needs).toContain("rife");
    expect(needs).not.toContain("temporal");
    expect(ltx25Video.nodes(values)).toContain("MiniMaxH3ReferenceToVideo");
    const auto = parseInput(ltx25Video, { prompt: "a", smooth: true, latentAfter: true });
    expect(ltx25Video.needsWith!(auto, { temporal: "t.safetensors" })).toContain("rife");
  });
});
