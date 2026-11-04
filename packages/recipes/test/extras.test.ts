import { describe, expect, it } from "vitest";
import { dryContext, LATENT_GRID, LATENT_RESAMPLE, parseInput, pickChoice, refusalOf, type BuiltGraph, type ChoiceInput } from "@afflatus/core";
import { familyById, fluxPicture, h3Video, recipeById, recipes, sdxlTextToPicture, wanVideo } from "../src";
import { DAEMON_NEEDED, LYING_SIGMA } from "../src/shared/detail";
import { AUX_NODE } from "../src/shared/guide";
import { SAGE_NEEDED, SAGE_NODE } from "../src/shared/speed";
import { IP_FILES, IP_NOT_BOTH } from "../src/shared/references";

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

describe("reference images on FLUX.1 (Redux)", () => {
  const files = { unet: "flux1-dev.safetensors", clipL: "clip_l.safetensors", t5: "t5.safetensors", vae: "ae.safetensors" };
  const refs = [{ asset: "a", role: "style" }, { asset: "b", role: "object" }];
  it("adds what the vision model sees of each to the prompt, at the strength asked for", () => {
    const b = fluxPicture.build(parseInput(fluxPicture, { prompt: "a", references: refs, referenceStrength: 0.4 }), dryContext({ slots: { ...files, redux: "r.safetensors", vision: "s.safetensors" }, uploads: { "references.0": "a.png", "references.1": "b.png" } }));
    const styled = of(b, "StyleModelApply");
    expect(styled).toHaveLength(2);
    for (const [, n] of styled) expect(n.inputs).toMatchObject({ strength: 0.4, strength_type: "multiply" });
    // chained after the guidance, as the single Redux image was
    expect(styled.map(([, n]) => from(b, n.inputs.conditioning).class_type).sort()).toEqual(["FluxGuidance", "StyleModelApply"]);
  });
  it("without its files, says which", () => {
    expect(() => fluxPicture.build(parseInput(fluxPicture, { prompt: "a", references: refs }), dryContext({ slots: files, uploads: { "references.0": "a.png", "references.1": "b.png" } }))).toThrow(/flux1-redux-dev/);
  });
});

describe("a control image (ControlNet) on every family that has one", () => {
  const slotsOf = (r: (typeof recipes)[number]) => r.variants.find((v) => /guide picture/.test(v.name))!;
  it.each([
    ["sdxl.text-to-picture", "ControlNetApplyAdvanced", "SetUnionControlNetType"],
    ["sdxl.redraw", "ControlNetApplyAdvanced", "SetUnionControlNetType"],
    ["flux.text-to-picture", "ControlNetApplyAdvanced", null],
    ["flux.redraw", "ControlNetApplyAdvanced", null],
    ["qwen.text-to-picture", "ControlNetApplyAdvanced", null],
    ["qwen.redraw", "ControlNetApplyAdvanced", null],
    ["zimage.text-to-picture", "ZImageFunControlnet", null],
    ["zimage.redraw", "ZImageFunControlnet", null],
  ])("%s puts it on with %s", (id, applies, union) => {
    const r = recipes.find((x) => x.id === id)!;
    const v = slotsOf(r);
    const b = r.build(parseInput(r, v.input), dryContext({ slots: v.slots ?? {}, uploads: v.uploads ?? {}, media: v.media ?? {} }));
    expect(of(b, applies), id).toHaveLength(1);
    expect(of(b, "SetUnionControlNetType").length > 0, id).toBe(Boolean(union));
    // the family's own file when the row is left on its download
    const loader = Object.values(b.graph).find((n) => ["ControlNetLoader", "ModelPatchLoader"].includes(n.class_type))!;
    const file = String(loader.inputs.control_net_name ?? loader.inputs.name);
    if (!v.input.guideModel) expect(Object.values(v.slots ?? {})).toContain(file);
  });
  it("starts Qwen Image's union above 1: at 1 its edges and pose did nothing on the pod (2026-11-04)", () => {
    for (const id of ["qwen.text-to-picture", "qwen.redraw"]) {
      const strength = recipes.find((x) => x.id === id)!.inputs.find((i) => i.id === "guideStrength") as { default: number };
      expect(strength.default, id).toBe(1.25);
    }
  });
  // on a PC with SDXL's ControlNet alone, FLUX.1's control image was built with it, and the pod never sent FLUX.1's
  it.each(["flux.text-to-picture", "qwen.text-to-picture", "zimage.text-to-picture", "sdxl.text-to-picture", "sdxl.paint-over"])("%s never starts on another family's ControlNet", (id) => {
    const r = recipes.find((x) => x.id === id)!;
    const others = ["controlnet-union-sdxl-1.0-promax.safetensors", "FLUX.1-dev-ControlNet-Union-Pro-2.0.safetensors", "Qwen-Image-InstantX-ControlNet-Union.safetensors", "Z-Image-Turbo-Fun-Controlnet-Union-2.1-2602-8steps.safetensors"];
    for (const spec of r.inputs.filter((i) => i.type === "choice" && (i.id === "guideModel" || i.id === "repaintModel")) as ChoiceInput[]) {
      expect(pickChoice(spec, others.filter((f) => f !== spec.default)), `${id} ${spec.id}`).toBe(spec.default);
    }
  });
});

describe("reference images on SDXL (IP-Adapter)", () => {
  const r = recipes.find((x) => x.id === "sdxl.text-to-picture")!;
  const v = r.variants.find((x) => /IP-Adapter Plus/.test(x.name))!;
  const faceId = r.variants.find((x) => /FaceID/.test(x.name))!;
  const built = (x: typeof v) => r.build(parseInput(r, x.input), dryContext({ slots: x.slots ?? {}, uploads: x.uploads ?? {} }));
  it("reads a style by its style alone, anything else by its look, and a person by their face (FaceID with its LoRA)", () => {
    const b = built(v);
    expect(of(b, "IPAdapterAdvanced").map(([, n]) => n.inputs.weight_type)).toEqual(["style transfer", "linear"]);
    expect(of(b, "IPAdapterFaceID")).toHaveLength(0);
    const p = built(faceId);
    expect(of(p, "IPAdapterFaceID")).toHaveLength(1);
    expect(of(p, "IPAdapterAdvanced")).toHaveLength(0);
    expect(of(p, "LoraLoaderModelOnly").map(([, n]) => n.inputs.lora_name)).toEqual(["ip-adapter-faceid-plusv2_sdxl_lora.safetensors"]);
    // every pass samples the referenced model
    for (const [, k] of of(p, "KSampler")) expect(from(p, k.inputs.model).class_type).toBe("IPAdapterFaceID");
  });
  // the pack's last commit, built into the pod base, requires the InsightFace model's name; the Registry's 2.0.0 has no such
  // input and refuses one it does not know (card #282: every FaceID graph refused on a pod of image 0.1.55)
  it("names buffalo_l to the InsightFace loader where it asks which, and only there", () => {
    const loader = (inputs?: string[]) => of(r.build(parseInput(r, faceId.input), dryContext({ slots: faceId.slots ?? {}, uploads: faceId.uploads ?? {}, ...(inputs ? { inputs: (n: string) => (n === "IPAdapterInsightFaceLoader" ? inputs : null) } : {}) })), "IPAdapterInsightFaceLoader").map(([, n]) => n.inputs);
    expect(loader(["provider", "model_name"])).toEqual([{ provider: "CPU", model_name: "buffalo_l" }]);
    expect(loader(["provider"])).toEqual([{ provider: "CPU" }]);
    expect(loader()).toEqual([{ provider: "CPU" }]);
  });
  // on the pod test a place picture beside a FaceID person was copied and no person drawn (card #280)
  it.each(["sdxl.text-to-picture", "sdxl.redraw"])("%s refuses a person's picture with any other, before it is queued and in its build", (id) => {
    const recipe = recipeById(id)!;
    const refs = (...roles: string[]) => ({ references: roles.map((role, i) => ({ asset: `r${i}`, role })) });
    for (const other of ["style", "place", "object", "clothing"]) expect(refusalOf(recipe, refs("person", other)), other).toBe(IP_NOT_BOTH);
    expect(refusalOf(recipe, refs("place", "person"))).toBe(IP_NOT_BOTH);
    // each alone, or two people, or two looks: taken
    for (const ok of [refs(), refs("person"), refs("person", "person"), refs("style", "place")]) expect(refusalOf(recipe, ok)).toBeNull();
    const variant = recipe.variants.find((x) => x.input.references)!;
    const both = parseInput(recipe, { ...variant.input, ...refs("person", "place") });
    expect(() => recipe.build(both, dryContext({ slots: IP_FILES, uploads: { "references.0": "a.png", "references.1": "b.png" }, media: variant.media ?? {} }))).toThrow(IP_NOT_BOTH);
  });
  it("asks a machine for FaceID's files only with a person", () => {
    const style = parseInput(r, { ...v.input, references: [{ asset: "a", role: "style" }] });
    expect(r.needsWith!(style, {}, {})).toEqual(expect.arrayContaining(["ipVision", "ipAdapter"]));
    expect(r.needsWith!(style, {}, {})).not.toContain("faceId");
  });
  it("finds Plus's file by its name, never FaceID's (a PC with FaceID's alone had it in the Plus slot)", () => {
    const slots = familyById("sdxl")!.slots;
    const hits = (id: string, file: string) => slots.find((s) => s.id === id)!.detect.some((d) => new RegExp(d, "i").test(file));
    expect(hits("ipAdapter", "ip-adapter-faceid-plusv2_sdxl.bin")).toBe(false);
    expect(hits("ipAdapter", "ip-adapter-plus_sdxl_vit-h.safetensors")).toBe(true);
    expect(hits("ipAdapter", "ip-adapter-plus-face_sdxl_vit-h.safetensors")).toBe(false);
    expect(hits("faceId", "ip-adapter-faceid-plusv2_sdxl.bin")).toBe(true);
  });
});

describe("ControlNet tile on SDXL's Upscale", () => {
  const r = recipes.find((x) => x.id === "sdxl.sharper")!;
  it.each(["ControlNet tile, whole", "ControlNet tile, in tiles"])("%s: the union in tile mode, given the picture it redraws", (name) => {
    const v = r.variants.find((x) => x.name === name)!;
    const b = r.build(parseInput(r, v.input), dryContext({ slots: v.slots ?? {}, uploads: v.uploads ?? {}, media: v.media ?? {} }));
    expect(of(b, "SetUnionControlNetType").map(([, n]) => n.inputs.type)).toEqual(["tile"]);
    const [, applied] = of(b, "ControlNetApplyAdvanced")[0]!;
    expect(from(b, applied.inputs.image).class_type).toBe(/in tiles/.test(name) ? "SplitImageToTileList" : "ImageScale");
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
