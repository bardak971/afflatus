import { describe, expect, it } from "vitest";
import { dryContext, parseInput, type Recipe } from "@afflatus/core";
import { recipeById } from "../src";

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
const of = (g: Graph, cls: string) => Object.entries(g).filter(([, n]) => n.class_type === cls);

/** A recipe built from its first variant with these inputs changed, on a ComfyUI that has every node. */
function built(id: string, change: Record<string, unknown>, media?: Record<string, unknown>): Graph {
  const recipe = recipeById(id) as Recipe<any>;
  const v = recipe.variants[0]!;
  const input = parseInput(recipe, { ...v.input, ...change });
  const ctx = dryContext({ slots: v.slots ?? {}, uploads: v.uploads ?? {}, media: { ...(v.media ?? {}), ...(media ?? {}) } as Record<string, any>, has: () => true });
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
