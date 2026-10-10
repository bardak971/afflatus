import { describe, expect, it } from "vitest";
import { dryContext, LATENT_GRID, LATENT_RESAMPLE, parseInput, type BuiltGraph } from "@afflatus/core";
import { familyById, fluxPicture, h3Video, recipeById, sdxlTextToPicture, wanVideo } from "../src";
import { DAEMON_NEEDED, LYING_SIGMA } from "../src/shared/detail";
import { AUX_NODE } from "../src/shared/guide";
import { SAGE_NEEDED, SAGE_NODE } from "../src/shared/speed";

/** Detail boost, tiles, the guide picture, the speed-ups and Redux: the parts the graph checker cannot build (packs it has not got). */
const of = (b: BuiltGraph, cls: string) => Object.entries(b.graph).filter(([, n]) => n.class_type === cls);
const from = (b: BuiltGraph, ref: unknown) => b.graph[(ref as [string, number])[0]]!;
const sdxl = (over: Record<string, unknown>, has: (n: string) => boolean = () => true, uploads: Record<string, string> = {}) =>
  sdxlTextToPicture.build(parseInput(sdxlTextToPicture, { prompt: "a", checkpoint: "x.safetensors", ...over }), dryContext({ has, uploads }));
const without = (...missing: string[]) => (n: string) => !missing.includes(n);

describe("detail boost", () => {
  it("Auto takes Detail Daemon when it is installed: the same sampling through the custom sampler nodes, its sampler in them", () => {
    const b = sdxl({ detail: true, detailStrength: 0.5 });
    expect(of(b, "KSampler")).toHaveLength(0);
    const [, lying] = of(b, LYING_SIGMA)[0]!;
    expect(lying.inputs).toMatchObject({ dishonesty_factor: -0.03, start_percent: 0.2, end_percent: 0.9 });
    const [, sampled] = of(b, "SamplerCustomAdvanced")[0]!;
    expect(from(b, sampled.inputs.sampler).class_type).toBe(LYING_SIGMA);
    expect(from(b, sampled.inputs.sigmas).inputs).toMatchObject({ steps: 28, denoise: 1 });
  });
  it("without it, the built-in sharpen on the model; asked for by name, Detail Daemon is refused in words", () => {
    const b = sdxl({ detail: true, detailStrength: 1 }, without(LYING_SIGMA));
    // only between its steps (20 % to 90 % of 28): the layout steps and the last ones on the plain model
    const parts = of(b, "KSamplerAdvanced").map(([, n]) => [n.inputs.start_at_step, n.inputs.end_at_step, from(b, n.inputs.model).class_type, n.inputs.add_noise]);
    expect(parts).toEqual([[0, 6, "CheckpointLoaderSimple", "enable"], [6, 25, "LatentApplyOperationCFG", "disable"], [25, 28, "CheckpointLoaderSimple", "disable"]]);
    expect(of(b, "KSampler")).toHaveLength(0);
    expect(of(b, "LatentOperationSharpen")[0]![1].inputs.alpha).toBe(0.2);
    expect(() => sdxl({ detail: true, detailMethod: "Lying sigma (Detail Daemon)" }, without(LYING_SIGMA))).toThrow(DAEMON_NEEDED);
  });
  it("off, nothing changes", () => {
    const b = sdxl({});
    expect(of(b, "KSampler")).toHaveLength(1);
    expect(of(b, "LatentApplyOperationCFG")).toHaveLength(0);
  });
});

describe("a pass in tiles", () => {
  it("cuts the enlarged picture, redraws each tile lightly and puts them back at the size asked for", () => {
    const b = sdxl({ hires: true, hiresScale: 3, hiresUpscaler: "u.pth" });
    const [, merged] = of(b, "ImageMergeTileList")[0]!;
    expect(merged.inputs).toMatchObject({ final_width: 2496, final_height: 3648, overlap: 128 });
    const decoded = from(b, merged.inputs.image_list);
    const sampled = from(b, decoded.inputs.samples);
    expect(sampled.class_type).toBe("KSampler");
    expect(sampled.inputs.denoise).toBe(0.45);
    expect(from(b, from(b, sampled.inputs.latent_image).inputs.pixels).class_type).toBe("SplitImageToTileList");
    // the hires pass runs once for each of the 3 × 4 tiles: its steps count that many times
    expect(b.totalSteps).toBe(28 + 15 * 12);
  });
  it("Auto keeps a usual hires fix whole, and a ComfyUI without the tile nodes is told to update", () => {
    expect(of(sdxl({ hires: true, hiresScale: 1.5, hiresUpscaler: "u.pth" }), "SplitImageToTileList")).toHaveLength(0);
    expect(() => sdxl({ hires: true, hiresScale: 3, hiresUpscaler: "u.pth" }, without("SplitImageToTileList"))).toThrow(/update ComfyUI/);
  });
  it("the upscale tool's light pass, too large for a whole pass, is made in tiles rather than skipped", () => {
    const sharper = recipeById("sdxl.sharper")!;
    const b = sharper.build(parseInput(sharper, { source: "p", checkpoint: "x.safetensors", upscaler: "u.pth" }), dryContext({ uploads: { source: "s.png" }, media: { source: { width: 1664, height: 2432 } } }));
    expect(of(b, "SplitImageToTileList")).toHaveLength(1);
    expect(of(b, "KSampler")).toHaveLength(1);
    // asked whole, it is gone over whole at any size; where the tile nodes are missing, it says so rather than skip the pass
    const whole = sharper.build(parseInput(sharper, { source: "p", checkpoint: "x.safetensors", upscaler: "u.pth", tiles: "Whole picture" }), dryContext({ uploads: { source: "s.png" }, media: { source: { width: 1664, height: 2432 } } }));
    expect(of(whole, "SplitImageToTileList")).toHaveLength(0);
    expect(of(whole, "KSampler")).toHaveLength(1);
    expect(() => sharper.build(parseInput(sharper, { source: "p", checkpoint: "x.safetensors", upscaler: "u.pth" }), dryContext({ uploads: { source: "s.png" }, media: { source: { width: 1664, height: 2432 } }, has: without("SplitImageToTileList") }))).toThrow(/update ComfyUI/);
  });
});

describe("a guide picture", () => {
  const guide = { guide: "g1", guideModel: "union.safetensors" };
  it("edges: found by ComfyUI's Canny, the union ControlNet told so, both texts guided into the sampler", () => {
    const b = sdxl({ ...guide, guideStrength: 0.6 }, () => true, { guide: "g.png" });
    expect(of(b, "LoadImage")[0]![1].inputs.image).toBe("g.png");
    expect(of(b, "SetUnionControlNetType")[0]![1].inputs.type).toBe("canny/lineart/anime_lineart/mlsd");
    const [applyId, apply] = of(b, "ControlNetApplyAdvanced")[0]!;
    expect(from(b, apply.inputs.image).class_type).toBe("Canny");
    expect(apply.inputs).toMatchObject({ strength: 0.6, start_percent: 0, end_percent: 0.8 });
    const [, ks] = of(b, "KSampler")[0]!;
    expect(ks.inputs.positive).toEqual([applyId, 0]);
    expect(ks.inputs.negative).toEqual([applyId, 1]);
  });
  it("depth and pose: found by comfyui_controlnet_aux, or refused in words without it", () => {
    const b = sdxl({ ...guide, guideFollows: "Pose" }, () => true, { guide: "g.png" });
    expect(of(b, AUX_NODE)[0]![1].inputs.preprocessor).toBe("DWPreprocessor");
    expect(of(b, "SetUnionControlNetType")[0]![1].inputs.type).toBe("openpose");
    expect(() => sdxl({ ...guide, guideFollows: "Depth" }, without(AUX_NODE), { guide: "g.png" })).toThrow(/comfyui_controlnet_aux/);
  });
  it("a hires pass in tiles is redrawn from the text alone (a tile is not the whole guide)", () => {
    const b = sdxl({ ...guide, hires: true, hiresScale: 3, hiresUpscaler: "u.pth" }, () => true, { guide: "g.png" });
    const samplers = of(b, "KSampler").map(([, n]) => from(b, n.inputs.positive).class_type);
    expect(samplers).toEqual(["ControlNetApplyAdvanced", "CLIPTextEncode"]);
  });
  it("starts on xinsir's union ControlNet, the one the family offers to download", () => {
    const b = sdxl({ guide: "g1" }, () => true, { guide: "g.png" });
    expect(of(b, "ControlNetLoader")[0]![1].inputs.control_net_name).toBe("controlnet-union-sdxl-1.0-promax.safetensors");
  });
});

describe("faster sampling", () => {
  const slots = { i2vHigh: "h.safetensors", i2vLow: "l.safetensors", clip: "c.safetensors", vae: "v.safetensors" };
  const wan = (over: Record<string, unknown>, has: (n: string) => boolean = () => true) =>
    wanVideo.build(parseInput(wanVideo, { prompt: "a", start: "p", ...over }), dryContext({ slots, has, uploads: { start: "a.png" }, media: { start: { width: 832, height: 1216 } } }));
  it("SageAttention patches both Wan models, with the kernel asked for", () => {
    const b = wan({ sage: true, sageKernel: "auto", fast: false });
    expect(of(b, SAGE_NODE).map(([, n]) => n.inputs.sage_attention)).toEqual(["auto", "auto"]);
    expect(of(b, "TorchCompileModel")).toHaveLength(0);
  });
  it("is refused in words without KJNodes", () => {
    expect(() => wan({ sage: true }, without(SAGE_NODE))).toThrow(SAGE_NEEDED);
  });
});

describe("the look of a picture (FLUX.1 Redux)", () => {
  const files = { unet: "flux1-dev.safetensors", clipL: "clip_l.safetensors", t5: "t5.safetensors", vae: "ae.safetensors" };
  it("adds what the vision model sees to the prompt, at the strength asked for", () => {
    const b = fluxPicture.build(parseInput(fluxPicture, { prompt: "a", look: "l1", lookStrength: 0.4 }), dryContext({ slots: { ...files, redux: "r.safetensors", vision: "s.safetensors" }, uploads: { look: "l.png" } }));
    const [, styled] = of(b, "StyleModelApply")[0]!;
    expect(styled.inputs).toMatchObject({ strength: 0.4, strength_type: "multiply" });
    expect(from(b, styled.inputs.conditioning).class_type).toBe("FluxGuidance");
  });
  it("without its files, says which", () => {
    expect(() => fluxPicture.build(parseInput(fluxPicture, { prompt: "a", look: "l1" }), dryContext({ slots: files, uploads: { look: "l.png" } }))).toThrow(/flux1-redux-dev/);
  });
});

describe("a continuation handed over before the clip before's frozen tail", () => {
  const slots = { unet: "minimax_h3_int8.safetensors", clip: "h3_clip.safetensors", vae: "h3_vae.safetensors", audioVae: "h3_audio_vae.safetensors" };
  // the clip before's latent holds 124 frames; it is handed over at frame 107 (17 × 6 + 5), where it still moves
  const cutAt = { width: 576, height: 1024, frames: 22, fps: 24, hasSound: true, latentFrames: 107, latentCut: 107 };
  const build = (has: (c: string) => boolean = () => true) => h3Video.build(
    parseInput(h3Video, { description: "a", previous: { asset: "c1" }, seconds: 5 }),
    dryContext({ slots, uploads: { previous: "a.mp4", "previous.latent": "a.safetensors [temp]" }, media: { previous: cutAt }, has }),
  );
  it("is continued in the latent, its latent cut to the frame it stops on", () => {
    const b = build();
    const [, trim] = of(b, "AfflatusTrimH3Latent")[0]!;
    expect(trim.inputs.frames).toBe(107);
    expect(from(b, trim.inputs.samples).class_type).toBe("AfflatusLoadH3Latent");
    const [, win] = of(b, "MiniMaxH3GuidedContinuationWindow")[0]!;
    expect(from(b, win.inputs.previous_av_latent).class_type).toBe("AfflatusTrimH3Latent");
  });
  it("without the node that cuts (an older Afflatus pack), from its frames", () => {
    const b = build((n) => n !== "AfflatusTrimH3Latent");
    expect(of(b, "MiniMaxH3GuidedContinuationWindow")).toHaveLength(0);
    expect(of(b, "AfflatusTrimH3Latent")).toHaveLength(0);
  });
});

describe("what a recipe says of itself, for the generic runner", () => {
  it("H3 asks for its draft's own latent only for a latent re-sample finish, and names the node that cuts a kept latent", () => {
    expect(h3Video.finishing?.(parseInput(h3Video, { description: "a", upscale: LATENT_RESAMPLE }))).toEqual({ latent: "own" });
    expect(h3Video.finishing?.(parseInput(h3Video, { description: "a", upscale: "Video: SeedVR2 (restores)" }))).toBeNull();
    expect(h3Video.traits).toMatchObject({ frameGrid: LATENT_GRID, latentTrim: "AfflatusTrimH3Latent" });
    // a recipe that keeps no latent asks nothing of the draft it finishes
    expect(wanVideo.finishing).toBeUndefined();
    expect(wanVideo.traits?.latentTrim).toBeUndefined();
  });

  it("each family's own prompt rules travel with it (Family.lint): the server holds a reply to them", () => {
    const lint = (family: string, text: string) => familyById(family)?.lint?.({ text, main: "prompt", changes: { prompt: text } }).map((l) => l.text) ?? [];
    expect(lint("flux", "(a cat:1.3), masterpiece")).toEqual([expect.stringMatching(/weight/), expect.stringMatching(/Quality words/)]);
    expect(lint("qwen21", "(a cat:1.3)")).toEqual([expect.stringMatching(/Qwen does not read weights/)]);
    expect(lint("sdxl", "long_hair, long_hair")).toEqual([expect.stringMatching(/Underscores/), expect.stringMatching(/Repeated tags/)]);
    expect(familyById("tools")?.lint).toBeUndefined();
  });
});
