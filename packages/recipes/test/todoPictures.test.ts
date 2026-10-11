import { describe, expect, it } from "vitest";
import { dryContext, parseInput, type Recipe } from "@afflatus/core";
import { recipeById } from "../src";

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
type Built = { graph: Graph };
const nodesOf = (b: Built, cls: string) => Object.entries(b.graph).filter(([, n]) => n.class_type === cls);
const one = (b: Built, cls: string) => {
  const found = nodesOf(b, cls);
  expect(found, cls).toHaveLength(1);
  return found[0]!;
};
const ref = (v: unknown) => (v as [string, number])[0];

/** A recipe built from its first variant's files with these inputs changed, against a ComfyUI that has every node, or not `missing`. */
function built(id: string, change: Record<string, unknown>, opts: { missing?: string[]; media?: Record<string, unknown> } = {}): Built {
  const recipe = recipeById(id) as Recipe<any>;
  const v = recipe.variants[0]!;
  const input = parseInput(recipe, { ...v.input, ...change });
  const ctx = dryContext({ slots: v.slots ?? {}, uploads: v.uploads ?? {}, media: { ...(v.media ?? {}), ...(opts.media ?? {}) } as Record<string, any>, has: (n: string) => !opts.missing?.includes(n) });
  return recipe.build(input as never, ctx) as Built;
}

describe("SDXL inpaint: the union ControlNet's repaint mode guides the masked part", () => {
  const box = { x: 200, y: 300, width: 320, height: 400 };
  const media = { source: { width: 832, height: 1216 }, mask: { width: 832, height: 1216, box } };

  it("on by default: the hint is the scaled crop with the hard mask, blacked out for xinsir's, and it feeds the KSampler", () => {
    const b = built("sdxl.paint-over", {}, { media });
    const [, pre] = one(b, "InpaintPreprocessor");
    expect(pre.inputs.black_pixel_for_xinsir_cn).toBe(true);
    // the picture the model works on: the crop scaled to the work size, never the hint scaled after
    const image = b.graph[ref(pre.inputs.image)]!;
    expect(image.class_type).toBe("ImageScale");
    expect(b.graph[ref(image.inputs.image)]!.class_type).toBe("ImageCrop");
    // the hard mask at the work size, the same one the soft one is not
    const [, noise] = one(b, "SetLatentNoiseMask");
    expect(ref(pre.inputs.mask)).not.toBe(ref(noise.inputs.mask));
    expect(b.graph[ref(pre.inputs.mask)]!.class_type).toBe("ImageToMask");
    const [, type] = one(b, "SetUnionControlNetType");
    expect(type.inputs.type).toBe("repaint");
    const [applyId, apply] = one(b, "ControlNetApplyAdvanced");
    expect([apply.inputs.strength, apply.inputs.start_percent, apply.inputs.end_percent]).toEqual([1, 0, 1]);
    expect(apply.inputs.vae).toBeDefined();
    const [, k] = one(b, "KSampler");
    expect(k.inputs.positive).toEqual([applyId, 0]);
    expect(k.inputs.negative).toEqual([applyId, 1]);
    // the rest is as it was: Differential Diffusion over the soft latent mask, composited back
    expect(b.graph[ref(k.inputs.model)]!.class_type).toBe("DifferentialDiffusion");
    expect(ref(k.inputs.latent_image)).toBe(nodesOf(b, "SetLatentNoiseMask")[0]![0]);
    one(b, "ImageCompositeMasked");
  });

  it("the ControlNet is loaded once, and named among what the render loads", () => {
    const recipe = recipeById("sdxl.paint-over") as Recipe<any>;
    const v = recipe.variants[0]!;
    const out = recipe.build(parseInput(recipe, v.input) as never, dryContext({ uploads: v.uploads ?? {}, media }));
    expect(out.loads).toContain("controlnet/controlnet-union-sdxl-1.0-promax.safetensors");
  });

  it("off, with a ControlNet that is not a union one, or without the aux pack: the checkpoint alone, as before", () => {
    for (const b of [
      built("sdxl.paint-over", { repaint: false }, { media }),
      built("sdxl.paint-over", { repaintModel: "control-lora-canny.safetensors" }, { media }),
      built("sdxl.paint-over", {}, { media, missing: ["InpaintPreprocessor"] }),
      built("sdxl.paint-over", {}, { media, missing: ["SetUnionControlNetType"] }),
    ]) {
      expect(nodesOf(b, "ControlNetLoader")).toHaveLength(0);
      expect(nodesOf(b, "InpaintPreprocessor")).toHaveLength(0);
      const [, k] = one(b, "KSampler");
      expect(b.graph[ref(k.inputs.positive)]!.class_type).toBe("CLIPTextEncode");
      one(b, "DifferentialDiffusion");
    }
  });

  it("outpaint still guides its new part the same way, through the shared helper", () => {
    const b = built("sdxl.outpaint", {});
    const [, pre] = one(b, "InpaintPreprocessor");
    expect(pre.inputs.black_pixel_for_xinsir_cn).toBe(true);
    expect(one(b, "SetUnionControlNetType")[1].inputs.type).toBe("repaint");
    expect(nodesOf(built("sdxl.outpaint", { repaint: false }), "ControlNetApplyAdvanced")).toHaveLength(0);
  });
});

describe("Upscale 2x: the light pass is colour matched back to the enlarged picture", () => {
  const families = ["sdxl.sharper", "flux.sharper", "qwen.sharper", "krea2.sharper", "zimage.sharper", "klein.sharper"];

  for (const id of families) {
    it(`${id}: ColorTransfer after the pass, against the upscaled source, Reinhard in Lab, at full strength`, () => {
      const b = built(id, {});
      const [ctId, ct] = one(b, "ColorTransfer");
      expect([ct.inputs.method, ct.inputs.source_stats, ct.inputs.strength]).toEqual(["reinhard_lab", "uniform", 1]);
      // the reference is the ImageScale of the upscale model's output: the original's colours at the result's size
      const reference = b.graph[ref(ct.inputs.image_ref)]!;
      expect(reference.class_type).toBe("ImageScale");
      expect(b.graph[ref(reference.inputs.image)]!.class_type).toBe("ImageUpscaleWithModel");
      expect(b.graph[ref(ct.inputs.image_target)]!.class_type).toBe("VAEDecode");
      expect(one(b, "PreviewImage")[1].inputs.images).toEqual([ctId, 0]);
    });

    it(`${id}: in tiles, the stitched result is matched`, () => {
      const b = built(id, { tiles: "Tiles" });
      const [, ct] = one(b, "ColorTransfer");
      expect(b.graph[ref(ct.inputs.image_ref)]!.class_type).toBe("ImageScale");
      expect(b.graph[ref(ct.inputs.image_target)]!.class_type).not.toBe("ImageScale");
    });

    it(`${id}: none when it is off, when there is no pass, or when this ComfyUI has no ColorTransfer`, () => {
      expect(nodesOf(built(id, { colourMatch: false }), "ColorTransfer")).toHaveLength(0);
      expect(nodesOf(built(id, { refine: false }), "ColorTransfer")).toHaveLength(0);
      expect(nodesOf(built(id, {}, { missing: ["ColorTransfer"] }), "ColorTransfer")).toHaveLength(0);
    });
  }

  it("the toggle is on by default, under the output settings, shown with the pass", () => {
    for (const id of families) {
      const input = (recipeById(id) as Recipe<any>).inputs.find((i) => i.id === "colourMatch") as { default?: unknown; section?: string; showWhen?: unknown } | undefined;
      expect(input, id).toMatchObject({ default: true, section: "out", showWhen: "refine" });
    }
  });
});
