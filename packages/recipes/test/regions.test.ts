import { describe, expect, it } from "vitest";
import { carryOver, dryContext, parseInput, recipeComfySince, regionsFor, type BuiltGraph, type InputSpec, type Recipe } from "@afflatus/core";
import { recipes } from "../src";
import { PICTURE_DROPS } from "../src/shared/pictureForm";
import { REGIONS_NOT_YET, REGIONS_WHY } from "../src/shared/regions";
import { DETECTOR_FILES } from "../src/shared/adetail";

// Regions on the Stage (card #271): one input on every txt2img that can read it, the reason greyed on those that cannot
const recipe = (id: string) => recipes.find((r) => r.id === id)!;
const sdxl = recipe("sdxl.text-to-picture");
const moss = recipe("moss.text-to-picture");
const krea2 = recipe("krea2.text-to-picture");
const KREA2_FILES = { unet: "krea2_turbo_fp8_scaled.safetensors", clip: "qwen3vl_4b_fp8_scaled.safetensors", vae: "qwen_image_vae.safetensors" };
const MOSS_FILES = { unet: "moss_image_sft_int8_convrot.safetensors", clip: "qwen3.5_9b_w4a8_gptq.safetensors", vae: "flux2-vae_small.safetensors" };

const build = (r: Recipe<any>, input: Record<string, unknown>, slots: Record<string, string> = {}): BuiltGraph => r.build(parseInput(r, input), dryContext({ slots }));
const nodes = (b: BuiltGraph, type: string) => Object.entries(b.graph).filter(([, n]) => n.class_type === type);
const one = (b: BuiltGraph, type: string) => nodes(b, type)[0]![1];

const twoBoxes = [
  { id: "l", box: { x: 0, y: 0, w: 0.5, h: 1 }, prompt: "red coat" },
  { id: "r", box: { x: 0.5, y: 0, w: 0.5, h: 1 }, prompt: "blue coat" },
];

describe("the Regions row on every txt2img", () => {
  const txt2imgs = recipes.filter((r) => PICTURE_DROPS.get(r.id)?.op === "txt2img");

  it("is on SDXL, MOSS-Image and Krea 2, and said absent with why everywhere else", () => {
    const has = txt2imgs.filter((r) => r.inputs.some((i) => i.id === "regions")).map((r) => r.family).sort();
    expect(has).toEqual(["krea2", "moss", "sdxl"]);
    const why = Object.fromEntries(txt2imgs.filter((r) => !has.includes(r.family)).map((r) => [r.family, r.absent?.find((a) => a.id === "regions")]));
    expect(why).toEqual({
      flux: { id: "regions", label: "Regions", why: REGIONS_NOT_YET },
      klein: { id: "regions", label: "Regions", why: REGIONS_WHY.klein }, qwen: { id: "regions", label: "Regions", why: REGIONS_WHY.qwen },
      qwen21: { id: "regions", label: "Regions", why: REGIONS_WHY.qwen21 }, zimage: { id: "regions", label: "Regions", why: REGIONS_WHY.zimage },
    });
  });

  it("says in its \"?\" that the result is guided, not exact, and what a region's LoRA does there", () => {
    const row = (r: Recipe<any>) => r.inputs.find((i) => i.id === "regions") as Extract<InputSpec, { type: "regions" }>;
    for (const r of [sdxl, moss, krea2]) expect(row(r).note, r.id).toContain("guided, not exact");
    expect(row(krea2)).toMatchObject({ lora: "scoped", max: 8 });
    // nothing promises a face from the person's picture, nor a face redrawn from a box's words: neither is done
    for (const r of [sdxl, moss, krea2]) expect(row(r).note, r.id).not.toMatch(/picture by|from their picture|face found in a person's box/);
    expect(row(sdxl)).toMatchObject({ lora: "scoped", max: 8 });
    expect(row(sdxl).kinds).toBeUndefined();
    expect(row(moss)).toMatchObject({ lora: "global", kinds: true });
    expect(row(moss).note).toContain("put on the whole picture");
  });

  it("is a row of txt2img alone: no other operation drops it", () => {
    for (const [id, { op, drop }] of PICTURE_DROPS) if (op !== "txt2img") expect(drop.regions, id).toBeUndefined();
  });

  it("refuses a text box where boxes have no kinds, and carries regions as the other form takes them", () => {
    expect(() => parseInput(sdxl, { prompt: "a", checkpoint: "x.safetensors", regions: [{ ...twoBoxes[0], kind: "text", text: "HI" }] })).toThrow();
    const spec = sdxl.inputs.find((i) => i.id === "regions") as Extract<InputSpec, { type: "regions" }>;
    const mixed = [{ ...twoBoxes[0], lora: { file: "a.safetensors", weight: 1 } }, { id: "t", box: twoBoxes[1]!.box, prompt: "serif", kind: "text", text: "HI" }];
    expect(regionsFor(spec, mixed)).toEqual([{ ...twoBoxes[0], lora: { file: "a.safetensors", weight: 1 } }]);
    // the same model, another operation: txt2img alone has regions, so nothing goes to img2img
    expect(carryOver(sdxl, recipe("sdxl.redraw"), { regions: mixed }, undefined).regions).toBeUndefined();
  });
});

describe("SDXL's regions: each box's tags masked to it", () => {
  it("adds each region's text over its box beside the prompt's, and the sampler reads them all", () => {
    const b = build(sdxl, { prompt: "two people", checkpoint: "x.safetensors", quality: "masterpiece", size: { width: 1024, height: 1024 }, regions: twoBoxes });
    const texts = nodes(b, "CLIPTextEncode").map(([, n]) => n.inputs.text);
    expect(texts).toEqual(expect.arrayContaining(["masterpiece, two people", "masterpiece, red coat", "masterpiece, blue coat"]));
    // the right box at the right place: half the picture from x 512
    const placed = nodes(b, "MaskComposite").map(([, n]) => n.inputs.x);
    expect(placed).toEqual([0, 512]);
    expect(nodes(b, "ConditioningSetMask")).toHaveLength(2);
    const sampler = one(b, "KSampler");
    expect(b.graph[(sampler.inputs.positive as [string, number])[0]]!.class_type).toBe("ConditioningCombine");
    // no LoRA on a region: no hooks
    expect(nodes(b, "CreateHookLora")).toHaveLength(0);
  });

  it("holds a region's LoRA and its person's to the box with hooks, never on the whole checkpoint", () => {
    const b = build(sdxl, {
      prompt: "a", checkpoint: "x.safetensors", loras: [{ file: "style.safetensors", weight: 0.7 }],
      regions: [{ ...twoBoxes[0], lora: { file: "coat.safetensors", weight: 0.6 }, castLora: { file: "mira.safetensors", weight: 0.8 }, cast: "p1" }, twoBoxes[1]],
    });
    expect(nodes(b, "LoraLoader").map(([, n]) => n.inputs.lora_name)).toEqual(["style.safetensors"]);
    expect(nodes(b, "CreateHookLora").map(([, n]) => [n.inputs.lora_name, n.inputs.strength_model])).toEqual([["coat.safetensors", 0.6], ["mira.safetensors", 0.8]]);
    const combine = one(b, "ConditioningSetPropertiesAndCombine");
    expect(combine.inputs).toMatchObject({ strength: 1, set_cond_area: "default" });
    expect(combine.inputs.hooks).toEqual(one(b, "SetClipHooks").inputs.hooks);
    expect(b.loads).toEqual(expect.arrayContaining(["loras/coat.safetensors", "loras/mira.safetensors"]));
  });

  it("with Detail: face, redraws every face from the prompt in one pass, whoever's box it is in", () => {
    const people = [{ ...twoBoxes[0], cast: "p1", castLora: { file: "mira.safetensors", weight: 0.8 } }, { ...twoBoxes[1], cast: "p2" }];
    const b = build(sdxl, { prompt: "a", checkpoint: "x.safetensors", detailFace: true, regions: people }, DETECTOR_FILES);
    const detailers = nodes(b, "DetailerForEach");
    expect(detailers).toHaveLength(1);
    expect(b.graph[(detailers[0]![1].inputs.positive as [string, number])[0]]!.inputs.text).toBe("a");
    expect(nodes(b, "ImpactSEGSIntersectionFilter")).toHaveLength(0);
  });
});

describe("MOSS-Image", () => {
  it("is ComfyUI's template: SFT, Qwen3.5 9B as moss_image, FLUX.2's small VAE, 25 steps at CFG 2.5 on er_sde, its own shift", () => {
    const b = build(moss, { prompt: "a poster" }, MOSS_FILES);
    expect(one(b, "CLIPLoader").inputs).toMatchObject({ clip_name: "qwen3.5_9b_w4a8_gptq.safetensors", type: "moss_image" });
    expect(one(b, "KSampler").inputs).toMatchObject({ steps: 25, cfg: 2.5, sampler_name: "er_sde", scheduler: "simple" });
    expect(nodes(b, "EmptyFlux2LatentImage")).toHaveLength(1);
    expect(nodes(b, "ModelSamplingAuraFlow")).toHaveLength(0);
    // the layout template's skip-layer guidance comes with regions alone
    expect(nodes(b, "SkipLayerGuidanceDiTSimple")).toHaveLength(0);
    expect(moss.layoutOf!(parseInput(moss, { prompt: "a poster" }))).toBeNull();
    expect(recipeComfySince(moss)).toBe("0.42.0");
  });

  it("writes its regions as the template's layout, and says the JSON as ComfyUI's nodes will write it", () => {
    const regions = [
      { id: "a", box: { x: 0, y: 0.3, w: 0.5, h: 0.7 }, prompt: "a red fox" },
      { id: "b", box: { x: 0.5, y: 0.3, w: 0.5, h: 0.7 }, prompt: "a woman", cast: "p1" },
      { id: "c", box: { x: 0.1, y: 0, w: 0.8, h: 0.25 }, prompt: "big cream serif capitals", kind: "text", text: "FOREST" },
    ];
    const input = { prompt: "a", size: { width: 896, height: 1152 }, regions };
    const b = build(moss, input, MOSS_FILES);
    const canvas = one(b, "CreateBoundingBoxes");
    expect((canvas.inputs.editor_state as { __value__: unknown }).__value__).toEqual([
      { x: 0, y: 346, width: 448, height: 806, metadata: { type: "obj", text: "", desc: "a red fox", palette: [] } },
      { x: 448, y: 346, width: 448, height: 806, metadata: { type: "obj", text: "", desc: "a woman", palette: [] } },
      { x: 90, y: 0, width: 717, height: 288, metadata: { type: "text", text: "FOREST", desc: "big cream serif capitals", palette: [] } },
    ]);
    expect(one(b, "MOSSImageLayoutPrompt").inputs).toMatchObject({ prompt: "a", width: 896, height: 1152, character_boxes: "2" });
    expect(one(b, "SkipLayerGuidanceDiTSimple").inputs).toMatchObject({ double_layers: "", single_layers: "22", start_percent: 0, end_percent: 0.5 });
    // checked against ComfyUI 0.44's own Python on 300 random layouts (2026-11-04): this one among them
    expect(JSON.parse(moss.layoutOf!(parseInput(moss, input))!)).toEqual({
      summary: { caption: "a" },
      items: [
        { label: "object", caption: "a red fox", bbox: [-231, -448, 576, 0] },
        { label: "character", caption: "a woman", bbox: [-231, 0, 576, 448] },
        { label: "text", caption: "big cream serif capitals", text: "FOREST", bbox: [-576, -359, -288, 360] },
      ],
      bbox_coord_space: "abs_centralized", bbox_format: "yxyx",
    });
  });

  it("puts a region's LoRA and its person's on the whole picture: one text reads every box", () => {
    const b = build(moss, { prompt: "a", loras: [{ file: "style.safetensors", weight: 0.5 }], regions: [{ ...twoBoxes[0], lora: { file: "coat.safetensors", weight: 0.6 }, castLora: { file: "mira.safetensors", weight: 0.8 } }] }, MOSS_FILES);
    expect(nodes(b, "LoraLoaderModelOnly").map(([, n]) => n.inputs.lora_name)).toEqual(["style.safetensors", "coat.safetensors", "mira.safetensors"]);
    expect(nodes(b, "CreateHookLora")).toHaveLength(0);
  });

  it("runs Turbo as MATLOWAI's Fast preset: lodestones' LoRA at 0.35, 10 steps, the form's CFG", () => {
    const b = build(moss, { prompt: "a", fast: true }, { ...MOSS_FILES, turbo: "lodestones_moss_sft_8step_dmd_lora_latest.safetensors" });
    expect(one(b, "LoraLoaderModelOnly").inputs).toMatchObject({ lora_name: "lodestones_moss_sft_8step_dmd_lora_latest.safetensors", strength_model: 0.35 });
    expect(one(b, "KSampler").inputs).toMatchObject({ steps: 10, cfg: 2.5 });
  });

  it("puts DeBand on by its switch, the same file by hand once", () => {
    const deband = "moss_image_sft_banding_fix_L37-41_bf16.safetensors";
    const b = build(moss, { prompt: "a", deband: true, loras: [{ file: deband, weight: 0.8 }] }, { ...MOSS_FILES, deband });
    expect(nodes(b, "LoraLoaderModelOnly").map(([, n]) => [n.inputs.lora_name, n.inputs.strength_model])).toEqual([[deband, 0.8]]);
  });

  it("asks a machine for the files its switches and rows need (a pod is sent them)", () => {
    const needs = (input: Record<string, unknown>) => moss.needsWith!(parseInput(moss, { prompt: "a", ...input }), MOSS_FILES, {});
    expect(needs({})).toEqual([]);
    expect(needs({ fast: true })).toEqual(["turbo"]);
    expect(needs({ deband: true })).toEqual(["deband"]);
    expect(needs({ detailFace: true })).toEqual(["faceDetector"]);
    // a fine-tune made for a few steps runs at them without the LoRA
    expect(needs({ fast: true, model: "moss_image_sft_turbo_int8.safetensors" })).toEqual([]);
  });

  it("is txt2img alone: no template does the other operations yet", () => {
    expect(recipes.filter((r) => r.family === "moss").map((r) => r.id)).toEqual(["moss.text-to-picture"]);
  });
});

describe("Krea 2's regions: every box in one pass (ComfyUI-Krea2-Regional), each cast person from their words and LoRA", () => {
  const people = [
    { id: "l", box: { x: 0, y: 0, w: 0.5, h: 1 }, prompt: "a man in a grey coat", cast: "p1", castLora: { file: "fabien.safetensors", weight: 0.8 } },
    { id: "r", box: { x: 0.5, y: 0, w: 0.5, h: 1 }, prompt: "a man in a blue jacket", cast: "p2" },
  ];
  const PERSON_FILES = { ...KREA2_FILES, identityEdit: "krea2_identity_edit_v2_r128.safetensors" };
  const built = (input: Record<string, unknown>, slots: Record<string, string> = KREA2_FILES, up: Record<string, string> = {}) =>
    krea2.build(parseInput(krea2, { prompt: "two friends in a park", ...input }), dryContext({ slots, uploads: up }));

  it("reads each box's words alone, masked to its box, beside the prompt as written (or with where each box lies)", () => {
    const b = built({ regions: twoBoxes });
    expect(nodes(b, "Krea2RegionalPrompt")).toHaveLength(2);
    const applied = one(b, "Krea2ApplyRegional");
    expect(applied.inputs).toMatchObject({ exclusive_masks: true, adaptive_masks: "refine boxes", restrict_img_attn: false });
    const base = (x: typeof b) => x.graph[(one(x, "Krea2ApplyRegional").inputs.conditioning as [string, number])[0]]!.inputs.text;
    // a sentence per box in the base text split a full-body picture of two people into two photos on a pod: off by default
    expect(base(b)).toBe("two friends in a park");
    expect(base(built({ regions: twoBoxes, regionLayout: "Position hints" }))).toBe("two friends in a park. in the left side of the image, prominent: red coat. in the right side of the image, prominent: blue coat");
    // the sampler samples the pack's patched model and its joined text
    const sampler = one(b, "KSampler");
    expect((sampler.inputs.positive as [string, number])).toEqual([nodes(b, "Krea2ApplyRegional")[0]![0], 1]);
    expect(krea2.layoutOf!(parseInput(krea2, { prompt: "two friends in a park", regions: twoBoxes }) as never)).toBe("two friends in a park\nRegion 1: red coat\nRegion 2: blue coat");
    expect(krea2.inputs.find((i) => i.id === "regionLayout")).toMatchObject({ default: "Off", showWhen: "regions", advanced: true });
  });

  it("holds a region's LoRA and its person's to its box with the pack's LoRA nodes, never on the whole model", () => {
    const b = built({ regions: [{ ...twoBoxes[0], lora: { file: "style.safetensors", weight: 0.9 }, castLora: { file: "fabien.safetensors", weight: 0.8 } }, twoBoxes[1]] });
    expect(nodes(b, "Krea2LoRA").map(([, n]) => n.inputs.lora_name)).toEqual(["style.safetensors", "fabien.safetensors"]);
    expect(nodes(b, "LoraLoaderModelOnly")).toHaveLength(0);
    expect(b.loads).toEqual(expect.arrayContaining(["loras/style.safetensors", "loras/fabien.safetensors"]));
  });

  it("draws a cast box from the person's words and LoRA alone, held to the box: no pass from their picture after", () => {
    const b = built({ regions: people, detailFace: true }, { ...PERSON_FILES, ...DETECTOR_FILES });
    // their words are the box's own (the server worked them in), their LoRA gated to the box's tokens
    const texts = nodes(b, "Krea2RegionalPrompt").map(([, n]) => b.graph[(n.inputs.conditioning as [string, number])[0]]!.inputs.text);
    expect(texts).toEqual(["a man in a grey coat", "a man in a blue jacket"]);
    const [left, right] = nodes(b, "Krea2RegionalPrompt").map(([, n]) => n.inputs.loras as [string, number] | undefined);
    expect(b.graph[left![0]]!.inputs).toMatchObject({ lora_name: "fabien.safetensors", strength: 0.8 });
    expect(right).toBeUndefined();
    expect(nodes(b, "LoraLoaderModelOnly")).toHaveLength(0);
    // no Identity Edit, no person's picture, nothing cut around a face; the Detail face pass redraws from the prompt
    for (const type of ["Krea2EditModelPatch", "Krea2EditGroundedEncode", "LoadImage", "KSamplerAdvanced", "AfflatusFaceCrop", "AfflatusFaceBackdrop"]) expect(nodes(b, type), type).toHaveLength(0);
    expect(nodes(b, "DetailerForEach")).toHaveLength(1);
    const needs = krea2.needsWith!(parseInput(krea2, { prompt: "a", regions: people, detailFace: true }) as never);
    expect(needs).not.toContain("identityEdit");
    expect(krea2.inputs.find((i) => i.id === "regionPersonDenoise")).toBeUndefined();
  });

  it("refuses regions with the form's person reference or style images, whose pictures the pack's masks do not cover", () => {
    const values = { prompt: "a", regions: twoBoxes, person: [{ asset: "p", role: "person" }] };
    expect(() => built(values, PERSON_FILES, { "person.0": "p.png" })).toThrow(/regions without/);
    expect(krea2.refuses!.some((r) => r.why.includes("regions without"))).toBe(true);
  });

  it("redraws hires tiles from the prompt alone: the regions' masks are the whole picture's", () => {
    const b = built({ regions: twoBoxes, hires: true, hiresScale: 3, hiresUpscaler: "u.pth" });
    const regional = nodes(b, "Krea2ApplyRegional")[0]![0];
    const tiles = nodes(b, "KSampler").slice(1);
    expect(tiles.length).toBeGreaterThan(0);
    for (const [, n] of tiles) expect(JSON.stringify(n.inputs.model)).not.toContain(`"${regional}"`);
  });
});
