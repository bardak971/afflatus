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

  it("not on 2.3 (its decode agreed to ΔE 0.2), on frames, with the chain's colour match carried on, nor doubled by the temporal upscaler", () => {
    const b23 = build(ltxVideo, { previous: { asset: "c" }, seconds: 5 }, latentCtx(25));
    expect(b23.overlap).toMatchObject({ seam: true });
    expect(all(b23, "ColorTransfer")).toEqual([]);
    expect(all(build(ltx25Video, { previous: { asset: "c" }, seconds: 5 }, { media: { previous: before(24) } }), "ColorTransfer")).toEqual([]);
    // the look carried on instead: one ColorTransfer, colourCarried's, over every frame
    const look = build(ltx25Video, { previous: { asset: "c" }, seconds: 5 }, { ...latentCtx(24, { "previous.look": "look.png" }), has: (n: string) => n !== "AfflatusColorFollow" });
    expect(all(look, "ColorTransfer").map(([, n]) => n.inputs.source_stats)).toEqual(["target_frame"]);
    expect(all(look, "ImageBlend")).toEqual([]);
    const doubled = build(ltx25Video, { previous: { asset: "c" }, seconds: 5, smooth: true, smoothWith: "LTX temporal (latent)" }, { ...latentCtx(24), slots: { ...parts, temporal: "t.safetensors" } });
    expect(all(doubled, "AfflatusLTXSeamLatent")).toEqual([]);
    expect(all(doubled, "ColorTransfer")).toEqual([]);
  });

  it("Lip sync carried on in the latent gets it too, and a ComfyUI without ColorTransfer the seam as decoded", () => {
    const lip = build(ltx25LipSync, { previous: { asset: "c" }, recording: "a1", recordingSeconds: 5 }, { ...latentCtx(24, { recording: "rec.wav" }), media: { previous: inLatent(24), ...rec(5) } });
    expect(all(lip, "ColorTransfer")).toHaveLength(1);
    const bare = build(ltx25Video, { previous: { asset: "c" }, seconds: 5 }, { ...latentCtx(24), has: (n: string) => n !== "ColorTransfer" });
    expect(all(bare, "ImageBlend")).toEqual([]);
  });
});
