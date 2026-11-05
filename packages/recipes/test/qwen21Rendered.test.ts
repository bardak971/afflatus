import { describe, expect, it } from "vitest";
import { dryContext, parseInput, type Recipe } from "@afflatus/core";
import { recipeById } from "../src";
import { ALL_DETAIL, DETECTOR_FILES } from "../src/shared/adetail";

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
const of = (g: Graph, cls: string) => Object.entries(g).filter(([, n]) => n.class_type === cls);

/** A recipe built from its first variant with these inputs changed, on a ComfyUI that has every node (and `slots` more files). */
function built(id: string, change: Record<string, unknown>, media?: Record<string, unknown>, slots: Record<string, string> = {}): Graph {
  const recipe = recipeById(id) as Recipe<any>;
  const v = recipe.variants[0]!;
  const input = parseInput(recipe, { ...v.input, ...change });
  const ctx = dryContext({ slots: { ...v.slots, ...slots }, uploads: v.uploads ?? {}, media: { ...(v.media ?? {}), ...(media ?? {}) } as Record<string, any>, has: () => true });
  return (recipe.build(input as never, ctx) as { graph: Graph }).graph;
}

/** What the form starts a file on, as apps/web/src/form.ts reads the presets. */
const startsOn = (r: Recipe<any>, file: string) => {
  const matched = (r.presets ?? []).filter((p) => new RegExp(p.match, "i").test(file));
  return Object.assign({}, ...[...matched].reverse().map((p) => p.values)) as Record<string, unknown>;
};

describe("Qwen Image 2.1's picture forms, as they rendered on a pod (card #275)", () => {
  it("the detail boost is Lying sigma alone: the built-in sharpen gave grain and black blotches", () => {
    for (const method of ["Auto", "Lying sigma (Detail Daemon)"]) {
      const g = built("qwen21.text-to-picture", { detail: true, detailMethod: method });
      expect(of(g, "LatentApplyOperationCFG"), method).toEqual([]);
      expect(of(g, "LyingSigmaSampler"), method).toHaveLength(1);
    }
    const method = (recipeById("qwen21.text-to-picture") as Recipe<any>).inputs.find((i) => i.id === "detailMethod") as { options: string[] };
    expect(method.options).toEqual(["Auto", "Lying sigma (Detail Daemon)"]);
    // without Detail Daemon, ComfyUI is said to need it rather than the picture broken
    const q = recipeById("qwen21.text-to-picture") as Recipe<any>;
    expect(() => q.build(parseInput(q, { ...q.variants[0]!.input, detail: true }) as never, dryContext({ slots: q.variants[0]!.slots ?? {}, has: (n: string) => n !== "LyingSigmaSampler" }))).toThrow(/Detail-Daemon/);
    // the other families keep the sharpen where Detail Daemon is not installed
    const z = recipeById("zimage.text-to-picture") as Recipe<any>;
    const zg = (z.build(parseInput(z, { ...z.variants[0]!.input, detail: true }) as never, dryContext({ slots: z.variants[0]!.slots ?? {}, has: (n: string) => n !== "LyingSigmaSampler" })) as { graph: Graph }).graph;
    expect(of(zg, "LatentApplyOperationCFG")).toHaveLength(1);
  });

  it("Upscale 2x's colour match is given the colours alone: its VAE decodes an alpha, which ColorTransfer refused", () => {
    // gone over whole, and in tiles
    for (const [tiles, last] of [["Whole picture", "VAEDecode"], ["Tiles", "ImageMergeTileList"]]) {
      const g = built("qwen21.sharper", { colourMatch: true, tiles }, { source: { width: 896, height: 1152 } });
      const [, transfer] = of(g, "ColorTransfer")[0]!;
      const [from] = transfer.inputs.image_target as [string, number];
      expect(g[from]!.class_type, tiles).toBe("SplitImageWithAlpha");
      expect(g[(g[from]!.inputs.image as [string, number])[0]]!.class_type, tiles).toBe(last);
    }
    // without the colour match, nothing is added
    expect(of(built("qwen21.sharper", { colourMatch: false }, { source: { width: 896, height: 1152 } }), "SplitImageWithAlpha")).toEqual([]);
    // the families whose VAE gives colours alone are as they were
    expect(of(built("zimage.sharper", { colourMatch: true }, { source: { width: 896, height: 1152 } }), "SplitImageWithAlpha")).toEqual([]);
  });

  it("the Turbo file starts on 8 steps on every form of the kit: at the full model's 40 its pictures came out overcooked", () => {
    for (const id of ["qwen21.text-to-picture", "qwen21.redraw", "qwen21.paint-over", "qwen21.outpaint", "qwen21.sharper", "qwen21.fix-face"]) {
      expect(startsOn(recipeById(id) as Recipe<any>, "qwen_image_2.1_turbo_int8_convrot.safetensors"), id).toMatchObject({ steps: 8 });
      expect(startsOn(recipeById(id) as Recipe<any>, "qwen_image_2.1_int8_convrot.safetensors"), id).toEqual({});
    }
  });
});

describe("Qwen Image 2.1's outpaint and Turbo face (card #286)", () => {
  it("outpaints as an edit of the padded picture: from noise beside a mask, each new side came out another place", () => {
    const g = built("qwen21.outpaint", { padLeft: 256, padRight: 256 }, { source: { width: 896, height: 1152 } });
    expect(of(g, "SetLatentNoiseMask")).toEqual([]);
    expect(of(g, "DifferentialDiffusion")).toEqual([]);
    const [readId, read] = of(g, "TextEncodeQwenImage21")[0]!;
    expect(of(g, "TextEncodeQwenImage21")).toHaveLength(1);
    // the picture to edit is the padded one at the drawing size, read at that size; the latent is the encoder's, of its size
    const [canvas] = read.inputs["images.image_1"] as [string, number];
    expect(g[canvas]!.class_type).toBe("ImageScale");
    expect(g[(g[canvas]!.inputs.image as [string, number])[0]]!.class_type).toBe("ImagePadForOutpaint");
    expect(read.inputs.resolution).toBe(0);
    expect(read.inputs.prompt).toMatch(/^The plain grey areas at the edges of <image1> are empty\..* stays exactly the same\. a$/);
    expect(read.inputs.prompt).not.toMatch(/\b(not|never|don't)\b/i);
    const [, sampler] = of(g, "KSampler")[0]!;
    expect(of(g, "KSampler")).toHaveLength(1);
    expect(sampler.inputs.latent_image).toEqual([readId, 2]);
    expect(sampler.inputs.denoise).toBe(1);
    // the picture is put back over the colours alone (the VAE decodes an alpha too)
    const [, paste] = of(g, "ImageCompositeMasked").at(-1)!;
    const [scaled] = paste.inputs.destination as [string, number];
    expect(g[(g[scaled]!.inputs.image as [string, number])[0]]!.class_type).toBe("SplitImageWithAlpha");
    // the other families keep their outpaint
    expect(of(built("zimage.outpaint", {}, { source: { width: 896, height: 1152 } }), "SetLatentNoiseMask").length).toBeGreaterThan(0);
  });

  it("the Turbo file's face pass keeps its own step spacing: 8 or 30 steps at 0.4 gave grainy skin", () => {
    const steps = (change: Record<string, unknown>) => (of(built("qwen21.fix-face", change), "FaceDetailer")[0]![1].inputs.steps as number);
    const turbo = "qwen_image_2.1_turbo_int8_convrot.safetensors";
    // 3 at the start (8 × 0.4): clean on the pod, where 4 left a faint grain
    expect(steps({ model: turbo, steps: 8, strength: 0.4 })).toBe(3);
    expect(steps({ model: turbo, steps: 8, strength: 0.5 })).toBe(4);
    expect(steps({ model: turbo, steps: 30, strength: 0.4 })).toBe(12);
    expect(steps({ model: turbo, steps: 8, strength: 0.1 })).toBe(2);
    // the full model as before: the form's steps, 8 to 30
    expect(steps({ steps: 40, strength: 0.4 })).toBe(30);
    expect(steps({ model: "qwen_image_2.1_int8_convrot.safetensors", steps: 4, strength: 0.4 })).toBe(8);
  });
});

describe("one rule for every form of Qwen Image 2.1 (card #303)", () => {
  const turbo = "qwen_image_2.1_turbo_int8_convrot.safetensors";

  it("txt2img's Detail face keeps the Turbo file's step spacing, as Face refine does", () => {
    const g = built("qwen21.text-to-picture", { model: turbo, steps: 8, detailFace: true, detailFaceDenoise: 0.4 }, undefined, DETECTOR_FILES);
    expect(of(g, "DetailerForEach")[0]![1].inputs.steps).toBe(3);
    // the full model as before: the form's steps, 8 to 30
    expect(of(built("qwen21.text-to-picture", { steps: 40, detailFace: true }, undefined, DETECTOR_FILES), "DetailerForEach")[0]![1].inputs.steps).toBe(30);
  });

  it("txt2img's Detail rows are given the colours alone: its VAE decodes an alpha, which the Impact Pack's detailer refused", () => {
    // the pod test of 2026-11-05: "DetailerForEach: 'Tensor' object has no attribute 'copy'" on the decode's fourth channel
    for (const [change, last] of [[{}, "VAEDecode"], [{ hires: true, hiresScale: 3, hiresUpscaler: "u.pth", tiles: "Tiles" }, "ImageMergeTileList"]] as const) {
      const g = built("qwen21.text-to-picture", { model: turbo, ...ALL_DETAIL, ...change }, undefined, DETECTOR_FILES);
      const detailers = of(g, "DetailerForEach");
      expect(detailers, last).toHaveLength(3);
      const [first] = detailers[0]![1].inputs.image as [string, number];
      expect(g[first]!.class_type, last).toBe("SplitImageWithAlpha");
      expect(g[(g[first]!.inputs.image as [string, number])[0]]!.class_type, last).toBe(last);
      // split once: the next rows take the detailer's picture before them
      expect(of(g, "SplitImageWithAlpha"), last).toHaveLength(1);
    }
    // without a Detail row, or on a family whose VAE gives colours alone, the graph is as it was
    expect(of(built("qwen21.text-to-picture", { model: turbo }), "SplitImageWithAlpha")).toEqual([]);
    expect(of(built("zimage.text-to-picture", { detailFace: true }, undefined, DETECTOR_FILES), "SplitImageWithAlpha")).toEqual([]);
  });

  it("Edit, the motion picture and Edit in box start the Turbo file on 8 steps too: at 40 it came out overcooked", () => {
    for (const id of ["qwen21.edit", "qwen21.motion-picture", "qwen21.edit-in-box"]) {
      expect(recipeById(id), id).toBeTruthy();
      expect(startsOn(recipeById(id) as Recipe<any>, turbo), id).toMatchObject({ steps: 8 });
      expect(startsOn(recipeById(id) as Recipe<any>, "qwen_image_2.1_int8_convrot.safetensors"), id).toEqual({});
    }
  });

  it("asks outpaint with the words Klein's outpaint asks, the picture named as each reads it", () => {
    const qwen = of(built("qwen21.outpaint", { padLeft: 256 }, { source: { width: 896, height: 1152 } }), "TextEncodeQwenImage21")[0]![1].inputs.prompt as string;
    const k = recipeById("klein.change-shape") as Recipe<any>;
    const v = k.variants[0]!;
    const g = k.build(parseInput(k, { ...v.input, prompt: "a" }), dryContext({ slots: v.slots ?? {}, uploads: v.uploads ?? {}, media: (v.media ?? {}) as Record<string, any>, has: () => true })).graph as Graph;
    const klein = Object.values(g).map((n) => n.inputs.text ?? n.inputs.prompt).find((t) => typeof t === "string" && t.startsWith("The plain grey")) as string;
    expect(klein).toContain("the same style and the same camera");
    expect(klein.replace(/this picture|the picture/g, "<image1>")).toBe(qwen);
  });
});
