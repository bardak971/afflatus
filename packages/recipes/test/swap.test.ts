import { describe, expect, it } from "vitest";
import { describeRecipe, dryContext, parseInput, slotsRead, type MediaFacts } from "@afflatus/core";
import { h3Swap, SWAP_CAPTION, swapCaption, swapPrompt, swapPromptLacks } from "../src/h3/swap";
import { H3_FPS } from "../src/h3/family";
import { recipeById } from "../src/index";

type Node = { class_type: string; inputs: Record<string, unknown> };
type Graph = Record<string, Node>;
const of = (graph: Graph, type: string) => Object.values(graph).filter((n) => n.class_type === type);
const slots = { unet: "u.safetensors", clip: "c.safetensors", videoVae: "v.safetensors", audioVae: "a.safetensors", refUnet: "hybrid_turbo.safetensors", swapLora: "swap.safetensors", swapUnet: "minimax_h3_ref2va.safetensors", swapSam: "sam3.1.safetensors", rife: "rife_v4.26.safetensors" };
const part = (over: Partial<MediaFacts> = {}): MediaFacts => ({ width: 864, height: 480, frames: 141, fps: H3_FPS, hasSound: true, ...over });

const build = (over: Record<string, unknown> = {}, source: MediaFacts = part(), ctx: { slots?: Record<string, string>; has?: (cls: string) => boolean } = {}) => {
  const input = parseInput(h3Swap, { who: "the man in the grey t-shirt.", source: { asset: "v1" }, references: [{ asset: "r1", role: "person" }], fast: false, maskOn: true, ...over });
  const built = h3Swap.build(input, dryContext({ slots: ctx.slots ?? slots, uploads: { source: "src.mp4", "references.0": "r1.png", "references.1": "r2.png" }, media: { source }, ...(ctx.has ? { has: ctx.has } : {}) }));
  return { built, graph: built.graph as Graph };
};

describe("MiniMax H3 · Swap character", () => {
  it("is offered again (the owner, 2026-10-17: to test its speed options on a source lane)", () => {
    expect(describeRecipe(h3Swap).hidden).toBeUndefined();
    expect(recipeById("h3.swap")).toBe(h3Swap);
  });

  it("carries on from the window before on a source lane in its latent, as H3's own clips: its last 22 frames the run-up, the join decoded as one piece with it", () => {
    const input = parseInput(h3Swap, { who: "the man", source: { asset: "v1", at: 5 }, previous: { asset: "w1" }, references: [{ asset: "r1", role: "person" }], fast: false, maskOn: true });
    const built = h3Swap.build(input, dryContext({
      slots, uploads: { source: "src.mp4", previous: "w.mp4", "previous.latent": "w.safetensors", "references.0": "r1.png" },
      media: { source: part({ frames: 141 }), previous: { width: 1024, height: 576, frames: 22, fps: H3_FPS, hasSound: true, latentFrames: 141 } },
    }));
    const graph = built.graph as Graph;
    // the window before's exact tokens: loaded, pinned at the start of the window, and decoded with the new ones
    expect(of(graph, "AfflatusLoadH3Latent").map((n) => n.inputs.latent)).toEqual(["w.safetensors"]);
    expect(of(graph, "MiniMaxH3GuidedContinuationWindow")[0]!.inputs).toMatchObject({ overlap_frames: 22, extension_frames: 141 - 22 });
    expect(of(graph, "MiniMaxH3LatentTailGuide")).toHaveLength(1);
    expect(of(graph, "AfflatusH3SeamLatent")[0]!.inputs.overlap_frames).toBe(22);
    // no frames pinned in its place: the one guide is the source's sound, for the lips
    expect(of(graph, "MiniMaxH3AddGuide").map((n) => [n.inputs.image === undefined, n.inputs.audio !== undefined])).toEqual([[true, true]]);
    // still masked: the sampler starts from the source's own latent, the person's tokens to redraw
    const sampler = of(graph, "SamplerCustomAdvanced")[0]!;
    expect(graph[(sampler.inputs.latent_image as [string, number])[0]]!.class_type).toBe("LTXVConcatAVLatent");
    expect(built.overlap).toMatchObject({ headMs: 917, latent: true, seam: true });
    expect(h3Swap.traits?.windows).toEqual({ most: 141, least: 90, carried: 22 });
  });

  it("carries on by the window before's frames when its latent was not kept: pinned at the start with their sound", () => {
    const input = parseInput(h3Swap, { who: "the man", source: { asset: "v1", at: 5 }, previous: { asset: "w1" }, references: [{ asset: "r1", role: "person" }], fast: false, maskOn: true });
    const built = h3Swap.build(input, dryContext({
      slots, uploads: { source: "src.mp4", previous: "w.mp4", "references.0": "r1.png" },
      media: { source: part({ frames: 124 }), previous: { width: 864, height: 480, frames: 22, fps: H3_FPS, hasSound: true } },
    }));
    const graph = built.graph as Graph;
    const pin = of(graph, "MiniMaxH3AddGuide").find((n) => n.inputs.image !== undefined)!;
    expect(pin.inputs.frame_idx).toBe(0);
    expect(pin.inputs.audio).toBeDefined();
    expect(of(graph, "MiniMaxH3GuidedContinuationWindow")).toEqual([]);
    expect(of(graph, "MiniMaxH3ReferenceToVideo")[0]!.inputs.length).toBe(124);
    expect(built.overlap).toEqual({ headMs: 917, tailMs: 0 });
  });

  it("takes the LoRA's short trained caption as its whole prompt, built from who to replace", () => {
    expect(swapCaption("the man in the grey t-shirt", 1)).toBe("Swap the man in the grey t-shirt in <Video 1> with the character in <Picture 1>.");
    expect(swapCaption("her", 3)).toBe("Swap her in <Video 1> with the character in <Picture 1>, <Picture 2> and <Picture 3>.");
    const { graph } = build();
    const ref = of(graph, "MiniMaxH3ReferenceToVideo")[0]!;
    // the closing full stop the user typed is not doubled
    expect(ref.inputs.prompt).toBe("Swap the man in the grey t-shirt in <Video 1> with the character in <Picture 1>.");
  });

  it("sends the prompt as written when it names the references, starting from the caption (the owner, 2026-10-18)", () => {
    expect(parseInput(h3Swap, { source: { asset: "v1" }, references: [] }).who).toBe(SWAP_CAPTION);
    const own = "Swap the rapper in <Video 1> with the character in <Picture 1>. He keeps his sunglasses.";
    const { graph, built } = build({ who: own });
    expect(of(graph, "MiniMaxH3ReferenceToVideo")[0]!.inputs.prompt).toBe(own);
    expect(built.warnings ?? []).not.toContainEqual(expect.stringContaining("The prompt has no"));
    // a few words without a reference (a clip made before) are still the person in the caption
    expect(swapPrompt("the man", 1)).toBe("Swap the man in <Video 1> with the character in <Picture 1>.");
  });

  it("shows the mask alone: the tracking, the masks drawn over the frames and a video of them, no H3 model loaded", () => {
    const { built, graph } = build({ maskPreview: true, source: { asset: "v1", pick: { x: 0.4, y: 0.5 } } });
    const types = new Set(Object.values(graph).map((n) => n.class_type));
    expect(types.has("SAM3_VideoTrack") && types.has("AfflatusSwapMask") && types.has("AfflatusSwapMaskPreview")).toBe(true);
    for (const gone of ["UNETLoader", "SamplerCustomAdvanced", "CLIPLoader", "VAELoader", "LoraLoaderModelOnly"]) expect(types.has(gone), gone).toBe(false);
    expect(built.outputs).toEqual([{ node: expect.any(String), kind: "video", role: "result" }]);
    // SAM 3 alone, a light job: the queue clears nothing for it and keeps H3 noted as loaded
    expect(built.loads).toEqual(["checkpoints/sam3.1.safetensors"]);
    expect(built.light).toBe(true);
    // the click picks the person, as in the render
    expect(of(graph, "AfflatusSwapMask")[0]!.inputs).toMatchObject({ pick_x: 0.4, pick_y: 0.5 });
    // a ComfyUI whose pack has no preview node yet: said, not sent
    expect(() => build({ maskPreview: true }, part(), { has: (cls) => cls !== "AfflatusSwapMaskPreview" })).toThrow(/node pack 0.26.0/);
  });

  it("gives the Mask card's settings to the nodes' own inputs, at the tested values by default (the owner, 2026-10-18)", () => {
    const plain = build().graph;
    expect(of(plain, "AfflatusSwapMask")[0]!.inputs).toMatchObject({ grow: 100, paste_grow: 30, paste_blur: 5 });
    // the node's own 3 is not sent: a pack before 0.27.0 has no paste_reach
    expect(of(plain, "AfflatusSwapMask")[0]!.inputs.paste_reach).toBeUndefined();
    expect(of(plain, "SAM3_VideoTrack")[0]!.inputs).toMatchObject({ detection_threshold: 0.3, max_objects: 8, detect_interval: 1 });
    expect(of(plain, "CLIPTextEncode").map((n) => n.inputs.text)).toContain("person");
    const set = build({ grow: 200, pasteGrow: 60, pasteBlur: 8, pasteReach: 5, track: "woman", detectionThreshold: 0.2, maxObjects: 12, detectInterval: 2, denoise: 0.85 }).graph;
    expect(of(set, "AfflatusSwapMask")[0]!.inputs).toMatchObject({ grow: 200, paste_grow: 60, paste_blur: 8, paste_reach: 5 });
    expect(of(set, "SAM3_VideoTrack")[0]!.inputs).toMatchObject({ detection_threshold: 0.2, max_objects: 12, detect_interval: 2 });
    expect(of(set, "CLIPTextEncode").map((n) => n.inputs.text)).toContain("woman");
    expect(of(set, "BasicScheduler")[0]!.inputs.denoise).toBe(0.85);
    expect(of(plain, "BasicScheduler")[0]!.inputs.denoise).toBe(1);
  });

  it("pastes the render back by the mask, by difference, or not at all", () => {
    expect(of(build().graph, "ImageCompositeMasked")).toHaveLength(1);
    const diff = build({ paste: "Difference", pasteThreshold: 0.1, pasteBlur: 6 }).graph;
    expect(of(diff, "ImageCompositeMasked")).toEqual([]);
    expect(of(diff, "AfflatusSwapPaste")[0]!.inputs).toMatchObject({ threshold: 0.1, blur: 6 });
    const off = build({ paste: "Off" }).graph;
    expect(of(off, "ImageCompositeMasked")).toEqual([]);
    expect(of(off, "AfflatusSwapPaste")).toEqual([]);
    // a pack without the node yet: pasted by the mask, and said
    const old = build({ paste: "Difference" }, part(), { has: (cls) => cls !== "AfflatusSwapPaste" });
    expect(of(old.graph, "ImageCompositeMasked")).toHaveLength(1);
    expect(old.built.warnings).toContainEqual(expect.stringContaining("node pack 0.29.0"));
  });

  it("starts with the Mask off: the whole frame redrawn, no SAM (the owner, 2026-10-18)", () => {
    const input = parseInput(h3Swap, { who: "the man.", source: { asset: "v1" }, references: [{ asset: "r1", role: "person" }] });
    expect(input.maskOn).toBe(false);
  });

  it("with the Mask off, redraws the whole frame: no SAM, and nothing said of a missing mask", () => {
    const { built, graph } = build({ maskOn: false });
    expect(of(graph, "SAM3_VideoTrack")).toEqual([]);
    expect(of(graph, "AfflatusSwapMask")).toEqual([]);
    expect(built.warnings ?? []).not.toContainEqual(expect.stringContaining("without a mask"));
    expect(() => build({ maskOn: false, maskPreview: true })).toThrow(/needs the Mask on/);
  });

  it("gives Veda its sparsity when it is on", () => {
    const vedaSlots = { ...slots, veda: "minimax_h3_r2va_veda_preview_fp8.safetensors" };
    const veda = of(build({ veda: true, vedaGenerated: 16, vedaReference: 48 }, part(), { slots: vedaSlots }).graph, "VedaSparseAttention")[0]!;
    expect(veda.inputs).toMatchObject({ generated_sparsity: "16", reference_sparsity: "48" });
  });

  it("tags the tracking and the mask as processing, not as steps of the sampling bar", () => {
    const { built, graph } = build();
    const id = (type: string) => Object.entries(graph).find(([, n]) => n.class_type === type)![0];
    expect(built.phases[id("SAM3_VideoTrack")]).toBe("processing");
    expect(built.phases[id("AfflatusSwapMask")]).toBe("processing");
    expect(built.phases[id("SamplerCustomAdvanced")]).toBe("sampling");
  });

  it("still runs a prompt that leaves out the source or the picture, and says so on the job", () => {
    expect(swapPromptLacks("Swap the man in <Video 1> with a tall woman.", 1)).toEqual(["<Picture 1>"]);
    expect(swapPromptLacks("Swap him with the character in <Picture 1>.", 1)).toEqual(["<Video 1>"]);
    // no picture given: none is asked for; plain words are the caption's, which has both
    expect(swapPromptLacks("Swap the man in <Video 1>.", 0)).toEqual([]);
    expect(swapPromptLacks("the man", 1)).toEqual([]);
    const { built } = build({ who: "Swap the man in <Video 1> with a tall woman." });
    expect(built.warnings).toContainEqual(expect.stringContaining("The prompt has no <Picture 1>"));
  });

  it("describes the person for the fused turbo, which took a cartoon on a TV for him with the caption alone", () => {
    const turbo = h3Swap.presets!.find((p) => new RegExp(p.match, "i").test("minimax_h3_fused_refdelta_r1024_turbo8.safetensors"))!;
    expect(String(turbo.values.who)).toMatch(/^Swap the person in <Video 1> with the character in <Picture 1>\. .*Keep the room of <Video 1> exactly as it is\.$/);
    // positive words only: a negation drew what it names (people at the table, 2026-10-18)
    expect(String(turbo.values.who)).not.toMatch(/(not|no|never|people)/i);
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

  it("runs on the reference model picked, and a distilled one takes its few steps with no turbo LoRA on top", () => {
    const fused = "minimax_h3_fused_refdelta_r1024_turbo8_mystic07_int8_convrot.safetensors";
    const turbo = { ...slots, turbo: "minimax_h3_fl2v_turbo_8step.safetensors" };
    const sampled = (over: Record<string, unknown>) => {
      const { graph } = build(over, part(), { slots: turbo });
      return {
        unet: of(graph, "UNETLoader").map((n) => n.inputs.unet_name),
        loras: of(graph, "LoraLoaderModelOnly").map((n) => n.inputs.lora_name),
        steps: of(graph, "BasicScheduler")[0]!.inputs.steps,
      };
    };
    expect(sampled({ swapModel: fused, fast: true, turboSteps: 4 })).toEqual({ unet: [fused], loras: ["swap.safetensors"], steps: 4 });
    // MiniMax's own with Turbo: the turbo LoRA, then the swap LoRA, its 8 steps
    expect(sampled({ fast: true })).toEqual({ unet: ["minimax_h3_ref2va.safetensors"], loras: ["minimax_h3_fl2v_turbo_8step.safetensors", "swap.safetensors"], steps: 8 });
    // a hybrid fine-tune named turbo (DaSiWa's) is distilled as well: its own steps, no LoRA
    const dasiwa = "DasiwaMinimaxH3_dasiwaHybridTurboV3_int8.safetensors";
    expect(sampled({ swapModel: dasiwa, fast: true })).toEqual({ unet: [dasiwa], loras: ["swap.safetensors"], steps: 8 });
    // the form offers H3's reference models, what is made from them (the fused merge) and the hybrids; not the frames model
    const field = describeRecipe(h3Swap).inputs.find((i) => i.id === "swapModel")!;
    const offered = (file: string) => field.type === "model" && field.match!.some((m) => new RegExp(m, "i").test(file));
    expect([fused, dasiwa, "DasiwaMinimaxH3_dasiwaHybridV3_int8.safetensors", "minimax_h3_ref2va_pruned_int8_convrot.safetensors"].every(offered)).toBe(true);
    expect(offered("minimax_h3_fl2va_pruned_int8_convrot.safetensors")).toBe(false);
    // Turbo asks for a turbo LoRA only where the model is not distilled: the reference model's own
    const asked = (over: Record<string, unknown>) => h3Swap.needsWith!(parseInput(h3Swap, { who: "the man", source: { asset: "v1" }, references: [{ asset: "r1", role: "person" }], smooth: false, ...over }), slots);
    expect(asked({ fast: true })).toEqual(["refTurbo"]);
    expect(asked({ fast: true, swapModel: dasiwa })).toEqual([]);
    expect(asked({ fast: false })).toEqual([]);
  });

  it("draws the lips to the source's own sound, by default: the sound the file carries, anchored from the first frame", () => {
    const { graph } = build();
    const [guide] = of(graph, "MiniMaxH3AddGuide");
    expect(guide!.inputs.frame_idx).toBe(0);
    const [trim] = Object.entries(graph).filter(([, n]) => n.class_type === "TrimAudioDuration");
    expect(guide!.inputs.audio).toEqual([trim![0], 0]);
    // the one cut of the source's sound, for the guide and the file
    expect(of(graph, "TrimAudioDuration")).toHaveLength(1);
    expect(of(build({ soundGuide: false }).graph, "MiniMaxH3AddGuide")).toHaveLength(0);
    // with H3's own sound in the file there is no source sound to follow
    expect(of(build({ soundGuide: true, keepSound: false }).graph, "MiniMaxH3AddGuide")).toHaveLength(0);
  });

  it("replaces the person clicked on the first frame: the click goes to the Swap Mask, on a first window only", () => {
    const { graph } = build({ source: { asset: "v1", pick: { x: 0.38, y: 0.46 } } });
    expect(of(graph, "AfflatusSwapMask")[0]!.inputs).toMatchObject({ pick_x: 0.38, pick_y: 0.46 });
    expect(of(build().graph, "AfflatusSwapMask")[0]!.inputs.pick_x).toBeUndefined();
    // a window carrying on follows the person the window before replaced, whatever was clicked
    const input = parseInput(h3Swap, { who: "the man", source: { asset: "v1", at: 5, pick: { x: 0.38, y: 0.46 } }, previous: { asset: "w1" }, references: [{ asset: "r1", role: "person" }], fast: false, maskOn: true });
    const carried = h3Swap.build(input, dryContext({
      slots, uploads: { source: "src.mp4", previous: "w.mp4", "references.0": "r1.png" },
      media: { source: part({ frames: 124 }), previous: { width: 864, height: 480, frames: 22, fps: H3_FPS, hasSound: true } },
    })).graph as Graph;
    expect(of(carried, "AfflatusSwapMask")[0]!.inputs.pick_x).toBeUndefined();
    // a click is a point on the frame, nothing else
    expect(() => parseInput(h3Swap, { who: "x", source: { asset: "v1", pick: { x: 2, y: 0.5 } }, references: [] })).toThrow();
  });

  it("starts a fused reference turbo on its own 4 steps, er_sde / beta; a distilled H3 file on 8; MiniMax's reference model on the reference turbo LoRA", () => {
    const presets = h3Swap.presets ?? [];
    const first = (file: string) => presets.find((p) => new RegExp(p.match, "i").test(file))?.values;
    expect(first("minimax_h3_fused_refdelta_r1024_turbo8_mystic07_int8_convrot.safetensors")).toMatchObject({ fast: true, turboSteps: 4, sampler: "er_sde", scheduler: "beta", shiftVideo: 12, shiftAudio: 3 });
    expect(first("DasiwaMinimaxH3_dasiwaHybridTurboV3_int8.safetensors")).toMatchObject({ fast: true, turboSteps: 8 });
    // MiniMax's reference model with Turbo: the reference model's own turbo LoRA, else the usual one
    const lora = (extra: Record<string, string>) => of(build({ fast: true }, part(), { slots: { ...slots, ...extra } }).graph, "LoraLoaderModelOnly").map((n) => n.inputs.lora_name);
    expect(lora({ turbo: "minimax_h3_fl2v_turbo_8step.safetensors", refTurbo: "minimax_h3_ref2v_turbo_4step.safetensors" })).toEqual(["minimax_h3_ref2v_turbo_4step.safetensors", "swap.safetensors"]);
    expect(lora({ turbo: "minimax_h3_fl2v_turbo_8step.safetensors" })).toEqual(["minimax_h3_fl2v_turbo_8step.safetensors", "swap.safetensors"]);
    // with no turbo LoRA at all, the reference one is asked for
    const ask = (over: Record<string, unknown>, have: Record<string, string>) => h3Swap.needsWith!(parseInput(h3Swap, { who: "the man", source: { asset: "v1" }, references: [], smooth: false, ...over }), { ...slots, ...have });
    expect(ask({ fast: true }, {})).toEqual(["refTurbo"]);
    expect(ask({ fast: true }, { turbo: "t.safetensors" })).toEqual([]);
    expect(ask({ fast: true, swapModel: "DasiwaMinimaxH3_dasiwaHybridTurboV3_int8.safetensors" }, {})).toEqual([]);
    // the form's start on the reference LoRA's 4 steps at 6 / 3
    expect(h3Swap.starts?.[0]?.values).toEqual({ turboSteps: 4, shiftVideo: 6, shiftAudio: 3 });
  });

  describe("Veda sparse attention", () => {
    const vedaSlots = { ...slots, veda: "minimax_h3_r2va_veda_preview_fp8.safetensors" };

    it("goes on the model last before the sampler, after the LoRAs and the shifts, with its predictor", () => {
      const { built, graph } = build({ veda: true }, part(), { slots: vedaSlots });
      const [veda] = of(graph, "VedaSparseAttention");
      expect(veda!.inputs).toMatchObject({ predictor: "minimax_h3_r2va_veda_preview_fp8.safetensors", generated_sparsity: "32", reference_sparsity: "32" });
      const [shift] = Object.entries(graph).find(([, n]) => n.class_type === "MiniMaxH3SigmaShift")!;
      expect(veda!.inputs.model).toEqual([shift, 0]);
      expect(built.warnings ?? []).not.toContainEqual(expect.stringContaining("Veda"));
      expect(of(build({}, part(), { slots: vedaSlots }).graph, "VedaSparseAttention")).toHaveLength(0);
    });

    it("runs the full attention without its node pack or its predictor, and says so on the job", () => {
      const noPack = build({ veda: true }, part(), { slots: vedaSlots, has: (cls) => cls !== "VedaSparseAttention" });
      expect(of(noPack.graph, "VedaSparseAttention")).toHaveLength(0);
      expect(noPack.built.warnings).toContainEqual(expect.stringContaining("veda-sparse-attention node pack"));
      const noPredictor = build({ veda: true });
      expect(of(noPredictor.graph, "VedaSparseAttention")).toHaveLength(0);
      expect(noPredictor.built.warnings).toContainEqual(expect.stringContaining("predictor"));
    });

    it("asks for its predictor only when it is on, and takes its node pack as an optional one", () => {
      const parsed = (over: Record<string, unknown>) => parseInput(h3Swap, { who: "the man", source: { asset: "v1" }, references: [{ asset: "r1", role: "person" }], fast: false, smooth: false, ...over });
      expect(h3Swap.nodes(parsed({ veda: true }))).not.toContain("VedaSparseAttention");
      expect(h3Swap.optionalNodes).toContain("VedaSparseAttention");
      expect(h3Swap.needsWith!(parsed({ veda: true }), slots)).toEqual(["veda"]);
      expect(h3Swap.needsWith!(parsed({}), slots)).toEqual([]);
    });
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
      // RIFE off: the frames saved are the pasted ones themselves
      const { built, graph } = build({ smooth: false });
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

    it("shows the Swap Mask the part's frames, whose faces pick the person; a first window has no window before to follow", () => {
      const { graph } = build();
      const mask = of(graph, "AfflatusSwapMask")[0]!;
      expect(from(graph, mask.inputs.images).class_type).toBe("ImageScale");
      expect(mask.inputs.previous).toBeUndefined();
    });

    it("follows the person the window before replaced: its handed-over frames go to the Swap Mask, at the clip's size", () => {
      const input = parseInput(h3Swap, { who: "the man", source: { asset: "v1", at: 5 }, previous: { asset: "w1" }, references: [{ asset: "r1", role: "person" }], fast: false, maskOn: true });
      const built = h3Swap.build(input, dryContext({
        slots, uploads: { source: "src.mp4", previous: "w.mp4", "references.0": "r1.png" },
        media: { source: part({ frames: 124 }), previous: { width: 1024, height: 576, frames: 5, fps: H3_FPS, hasSound: true } },
      }));
      const graph = built.graph as Graph;
      const mask = of(graph, "AfflatusSwapMask")[0]!;
      const before = from(graph, mask.inputs.previous);
      expect(before).toMatchObject({ class_type: "ImageScale", inputs: { width: 1024, height: 576 } });
      const frames = from(graph, before.inputs.image);
      expect(from(graph, frames.inputs.video)).toMatchObject({ class_type: "LoadVideo", inputs: { file: "w.mp4" } });
      // its colours: the transform from this window's last carried frame to the window before's last frame, on every frame,
      // before the paste-back
      const pasted = of(graph, "ImageCompositeMasked")[0]!;
      const matched = from(graph, pasted.inputs.source);
      expect(matched).toMatchObject({ class_type: "ColorTransfer", inputs: { method: "reinhard_lab", source_stats: "target_frame", "source_stats.target_index": 4, strength: 1 } });
      expect(from(graph, matched.inputs.image_ref)).toMatchObject({ class_type: "ImageFromBatch", inputs: { batch_index: -1, length: 1 } });
      expect(from(graph, matched.inputs.image_target).class_type).toBe("VAEDecode");
    });

    it("leaves a first window's colours as they are: it has no window before to match", () => {
      expect(of(build().graph, "ColorTransfer")).toEqual([]);
    });

    it("asks SAM 3.1 of a machine only with the Mask on, the LoRA and its model always, the family's own models never", () => {
      expect(h3Swap.needs).toEqual(["swapLora", "swapUnet"]);
      // the family's video and reference models: no form of it reads them, so no machine is asked for them
      const read = slotsRead(h3Swap, ["unet", "refUnet", "swapLora", "clip", "videoVae"]);
      expect(read.has("unet")).toBe(false);
      expect(read.has("refUnet")).toBe(false);
      expect([...read].sort()).toEqual(["clip", "swapLora", "videoVae"]);
      const asks = (over: Record<string, unknown>) => h3Swap.needsWith!(parseInput(h3Swap, { who: "the man", source: { asset: "v1" }, references: [], fast: false, smooth: false, ...over }), {});
      expect(asks({})).not.toContain("swapSam");
      expect(asks({ maskOn: true })).toContain("swapSam");
      expect(asks({ maskOn: true, maskPreview: true })).toContain("swapSam");
      // RIFE with "RIFE ×2" on (the default), never with it off: a pod rendered at half the rate without a word (2026-10-18)
      expect(asks({ smooth: true })).toContain("rife");
      expect(asks({})).not.toContain("rife");
    });
  });
});
