import { describe, expect, it } from "vitest";
import { describeRecipe, dryContext, parseInput, type MediaFacts } from "@afflatus/core";
import { h3Swap, swapCaption } from "../src/h3/swap";
import { H3_FPS } from "../src/h3/family";
import { recipeById } from "../src/index";

type Node = { class_type: string; inputs: Record<string, unknown> };
type Graph = Record<string, Node>;
const of = (graph: Graph, type: string) => Object.values(graph).filter((n) => n.class_type === type);
const slots = { unet: "u.safetensors", clip: "c.safetensors", videoVae: "v.safetensors", audioVae: "a.safetensors", refUnet: "hybrid_turbo.safetensors", swapLora: "swap.safetensors", swapUnet: "minimax_h3_ref2va.safetensors", swapSam: "sam3.1.safetensors" };
const part = (over: Partial<MediaFacts> = {}): MediaFacts => ({ width: 864, height: 480, frames: 141, fps: H3_FPS, hasSound: true, ...over });

const build = (over: Record<string, unknown> = {}, source: MediaFacts = part(), ctx: { slots?: Record<string, string>; has?: (cls: string) => boolean } = {}) => {
  const input = parseInput(h3Swap, { who: "the man in the grey t-shirt.", source: { asset: "v1" }, references: [{ asset: "r1", role: "person" }], fast: false, ...over });
  const built = h3Swap.build(input, dryContext({ slots: ctx.slots ?? slots, uploads: { source: "src.mp4", "references.0": "r1.png", "references.1": "r2.png" }, media: { source }, ...(ctx.has ? { has: ctx.has } : {}) }));
  return { built, graph: built.graph as Graph };
};

describe("MiniMax H3 · Swap character", () => {
  it("is hidden for now: the screens that offer recipes leave it out, what was made with it still opens", () => {
    expect(describeRecipe(h3Swap).hidden).toBe(true);
    expect(recipeById("h3.swap")).toBe(h3Swap);
  });

  it("carries on from the window before on a source lane: its last 5 frames and their sound pinned at the start, as frames, the window's count kept", () => {
    const input = parseInput(h3Swap, { who: "the man", source: { asset: "v1", at: 5 }, previous: { asset: "w1" }, references: [{ asset: "r1", role: "person" }], fast: false });
    const built = h3Swap.build(input, dryContext({
      slots, uploads: { source: "src.mp4", previous: "w.mp4", "previous.latent": "w.safetensors", "references.0": "r1.png" },
      media: { source: part({ frames: 124 }), previous: { width: 864, height: 480, frames: 5, fps: H3_FPS, hasSound: true, latentFrames: 124 } },
    }));
    const graph = built.graph as Graph;
    // the pin: a guide at frame 0 from the window before's frames, with their sound (the source's own)
    const pin = of(graph, "MiniMaxH3AddGuide")[0]!;
    expect(pin.inputs.frame_idx).toBe(0);
    expect(pin.inputs.audio).toBeDefined();
    // never its latent, even when it was kept: the measured join is on frames
    expect(of(graph, "MiniMaxH3GuidedContinuationWindow")).toEqual([]);
    expect(of(graph, "AfflatusLoadH3Latent")).toEqual([]);
    // the window is the part's 124 frames, the 5 shared among them: hidden on the timeline as the overlap
    expect(of(graph, "MiniMaxH3ReferenceToVideo")[0]!.inputs.length).toBe(124);
    expect(built.overlap).toEqual({ headMs: 208, tailMs: 0 });
    expect(h3Swap.traits?.windows).toEqual({ most: 141, least: 90, carried: 5 });
  });

  it("takes the LoRA's short trained caption as its whole prompt, built from who to replace", () => {
    expect(swapCaption("the man in the grey t-shirt", 1)).toBe("Swap the man in the grey t-shirt in <Video 1> with the character in <Picture 1>.");
    expect(swapCaption("her", 3)).toBe("Swap her in <Video 1> with the character in <Picture 1>, <Picture 2> and <Picture 3>.");
    const { graph } = build();
    const ref = of(graph, "MiniMaxH3ReferenceToVideo")[0]!;
    // the closing full stop the user typed is not doubled
    expect(ref.inputs.prompt).toBe("Swap the man in the grey t-shirt in <Video 1> with the character in <Picture 1>.");
  });

  it("gives the source's part as the reference video, at its own shape", () => {
    const { graph } = build();
    const ref = of(graph, "MiniMaxH3ReferenceToVideo")[0]!;
    const video = graph[(ref.inputs["ref_videos.ref_video_0"] as [string, number])[0]]!;
    expect(video.class_type).toBe("GetVideoComponents");
    expect(graph[(video.inputs.video as [string, number])[0]]).toMatchObject({ class_type: "LoadVideo", inputs: { file: "src.mp4" } });
    // wide like the source, never the form's tall default
    expect(ref.inputs.width as number).toBeGreaterThan(ref.inputs.height as number);
    // its sound is not handed over as a voice when the file keeps the source's own anyway
    expect(Object.keys(ref.inputs).some((k) => k.startsWith("ref_video_audios."))).toBe(false);
  });

  it("runs on MiniMax's reference model the LoRA was trained on, at the source's own size, whatever H3 model is picked elsewhere", () => {
    const { graph } = build();
    expect(of(graph, "UNETLoader").map((n) => n.inputs.unet_name)).toEqual(["minimax_h3_ref2va.safetensors"]);
    const ref = of(graph, "MiniMaxH3ReferenceToVideo")[0]!;
    // 576p by default, in the source's shape
    expect([ref.inputs.width, ref.inputs.height]).toEqual([1024, 576]);
    const own = of(build({ swapSize: "Source" }).graph, "MiniMaxH3ReferenceToVideo")[0]!;
    expect([own.inputs.width, own.inputs.height]).toEqual([864, 480]);
    // a size asked for: a small phone clip made larger, in its own shape
    const phone = of(build({ swapSize: "576p" }, part({ width: 352, height: 640 })).graph, "MiniMaxH3ReferenceToVideo")[0]!;
    expect(phone.inputs.width).toBe(576);
    expect(phone.inputs.height as number).toBeGreaterThan(1000);
    // at its own size, a source smaller than H3 takes is brought to its smallest (384)
    expect(of(build({ swapSize: "Source" }, part({ width: 352, height: 640 })).graph, "MiniMaxH3ReferenceToVideo")[0]!.inputs.width).toBe(384);
  });

  it("samples as the research graph did: the model's own shifts (12 / 3), no fp16 accumulation patch", () => {
    const { graph } = build();
    expect(of(graph, "MiniMaxH3SigmaShift")[0]!.inputs).toMatchObject({ shift_video: 12, shift_audio: 3 });
    expect(of(graph, "ModelPatchTorchSettings")).toHaveLength(0);
  });

  it("puts the swap LoRA on the model, at its strength", () => {
    const { graph } = build({ swapStrength: 0.8 });
    expect(of(graph, "LoraLoaderModelOnly").map((n) => [n.inputs.lora_name, n.inputs.strength_model])).toContainEqual(["swap.safetensors", 0.8]);
  });

  it("lasts the source's part, floored to H3's frame grid, 141 frames at most", () => {
    expect(build().built.frames).toBe(141);
    // 100 frames handed over: 90 (17·5 + 5), never longer than the source
    expect(build({}, part({ frames: 100 })).built.frames).toBe(90);
    expect(build({}, part({ frames: 300 })).built.frames).toBe(141);
  });

  it("files the source's own sound, cut to the clip; or the sound H3 makes when asked", () => {
    const kept = build();
    const saved = kept.graph[kept.built.outputs.find((o) => o.role === "result")!.node]!;
    const sound = kept.graph[(saved.inputs.audio as [string, number])[0]]!;
    expect(sound).toMatchObject({ class_type: "TrimAudioDuration", inputs: { start_index: 0 } });
    expect(sound.inputs.duration as number).toBeCloseTo(141 / H3_FPS, 5);
    const own = build({ keepSound: false });
    const savedOwn = own.graph[own.built.outputs.find((o) => o.role === "result")!.node]!;
    expect(own.graph[(savedOwn.inputs.audio as [string, number])[0]]!.class_type).toBe("VAEDecodeAudio");
  });

  it("refuses without the swap LoRA, and says where it is had", () => {
    const input = parseInput(h3Swap, { who: "x", source: { asset: "v1" }, references: [{ asset: "r1", role: "person" }] });
    expect(() => h3Swap.build(input, dryContext({ slots: { ...slots, swapLora: "" }, uploads: { source: "src.mp4", "references.0": "r1.png" }, media: { source: part() } }))).toThrow(/Character-Swap LoRA/);
  });

  describe("masked: only the person redrawn, the rest of the source kept (§9.9)", () => {
    const from = (graph: Graph, ref: unknown) => graph[(ref as [string, number])[0]]!;

    it("is sampled from the source's own frames, encoded, with the Swap Mask's noise mask, and H3's own audio beside them", () => {
      const { graph } = build();
      const sampler = of(graph, "SamplerCustomAdvanced")[0]!;
      const av = from(graph, sampler.inputs.latent_image);
      expect(av.class_type).toBe("LTXVConcatAVLatent");
      const noised = from(graph, av.inputs.video_latent);
      expect(noised.class_type).toBe("SetLatentNoiseMask");
      expect(noised.inputs.mask).toEqual([expect.any(String), 0]);
      expect(from(graph, noised.inputs.mask).class_type).toBe("AfflatusSwapMask");
      expect(from(graph, noised.inputs.samples).class_type).toBe("VAEEncode");
      // the audio is the reference node's own empty latent's, not the source's
      const audio = from(graph, av.inputs.audio_latent);
      expect(audio.class_type).toBe("LTXVSeparateAVLatent");
      expect(from(graph, audio.inputs.av_latent).class_type).toBe("MiniMaxH3ReferenceToVideo");
    });

    it("tracks the people of the part at the clip's size and its length, and takes the most prominent", () => {
      const { graph } = build();
      const mask = of(graph, "AfflatusSwapMask")[0]!;
      expect(mask.inputs).toMatchObject({ frames: 141, width: 1024, height: 576, grow: 100 });
      const track = from(graph, mask.inputs.track_data);
      expect(track.class_type).toBe("SAM3_VideoTrack");
      expect(from(graph, track.inputs.conditioning).inputs.text).toBe("person");
      expect(of(graph, "CheckpointLoaderSimple").map((n) => n.inputs.ckpt_name)).toEqual(["sam3.1.safetensors"]);
      const scaled = from(graph, track.inputs.images);
      expect(scaled).toMatchObject({ class_type: "ImageScale", inputs: { width: 1024, height: 576 } });
      expect(from(graph, scaled.inputs.image)).toMatchObject({ class_type: "ImageFromBatch", inputs: { batch_index: 0, length: 141 } });
      // the same frames are encoded and pasted onto: one scale of the part
      expect(of(graph, "ImageScale")).toHaveLength(1);
    });

    it("files the source's pixels outside the person: the frames the clip keeps are the render pasted onto the part", () => {
      const { built, graph } = build();
      const saved = graph[built.outputs.find((o) => o.role === "result")!.node]!;
      const pasted = from(graph, saved.inputs.images);
      expect(pasted.class_type).toBe("ImageCompositeMasked");
      expect(from(graph, pasted.inputs.source).class_type).toBe("VAEDecode");
      expect(from(graph, pasted.inputs.destination).class_type).toBe("ImageScale");
      // the paste-back mask is the Swap Mask's second output
      expect(pasted.inputs.mask).toEqual([expect.any(String), 1]);
      expect(from(graph, pasted.inputs.mask).class_type).toBe("AfflatusSwapMask");
      // the Swap Mask's note (no one found) is said on the job
      expect(built.outputs.filter((o) => o.role === "note").map((o) => graph[o.node]!.class_type)).toEqual(["AfflatusSwapMask"]);
      expect(built.warnings).toBeUndefined();
    });

    it("swaps unmasked where the node pack has no Swap Mask, or SAM is not there, and says so on the job", () => {
      const older = build({}, part(), { has: (cls) => cls !== "AfflatusSwapMask" });
      expect(of(older.graph, "SetLatentNoiseMask")).toEqual([]);
      expect(of(older.graph, "SAM3_VideoTrack")).toEqual([]);
      expect(older.built.warnings).toEqual([expect.stringMatching(/without a mask.*node pack has no Swap Mask/)]);
      const noSam = build({}, part(), { slots: { ...slots, swapSam: "" } });
      expect(of(noSam.graph, "SetLatentNoiseMask")).toEqual([]);
      expect(noSam.built.warnings).toEqual([expect.stringMatching(/SAM 3\.1 is not on this ComfyUI/)]);
    });

    it("asks SAM 3.1 of a machine, as the LoRA and the reference model", () => {
      expect(h3Swap.needs).toEqual(["swapLora", "swapUnet", "swapSam"]);
    });
  });
});
