import { defineRecipe, GraphBuilder, type Recipe } from "@afflatus/core";
import { boxOf, MASK_INPUTS, MASK_NODES, maskParts, type MaskSettings } from "../sdxl/common";
import { photo, type FlowBase, type FlowKit, type FlowSpec } from "./kit";

export interface FlowPaintOver extends FlowBase, MaskSettings { source: string; mask: string; prompt: string; strength: number }

/**
 * Inpaint: only the painted part is redone. It is cut out with room around it, redrawn at a size the model
 * draws well, and put back into the untouched picture through a soft edge.
 */
export function flowPaintOver(spec: FlowSpec, kit: FlowKit): Recipe<FlowPaintOver> {
  const { inputs, loadNodes, SOMETIMES, load, shifted, cond, sample, sizeOf, tuned } = kit;
  const files = spec.files;
  return defineRecipe<FlowPaintOver>({
    id: `${spec.family}.paint-over`,
    family: spec.family,
    version: 1,
    title: "Inpaint",
    summary: "Paint a mask over a part of an image and prompt what goes there. Only the masked part is redrawn.",
    output: "image",
    inputs: [
      spec.model,
      { id: "source", type: "image", role: "source", label: "Image" },
      { id: "mask", type: "image", role: "mask", of: "source", label: "Mask" },
      { id: "prompt", type: "prompt", label: "Prompt", note: "the masked part with what is around it, as it should come out", style: "sentences", placeholder: "A woman's hand holding a glass of orange juice, on a terrace table in morning light." },
      { id: "strength", type: "number", label: "Denoising strength", note: "1 ignores what was there", min: 0.05, max: 1, step: 0.05, default: 0.8 },
      ...MASK_INPUTS,
      ...inputs,
    ],
    ...(spec.presets ? { presets: spec.presets } : {}),
    nodes: (input) => [...loadNodes(input), "LoadImage", "VAEEncode", ...(spec.hardInpaint ? [] : ["DifferentialDiffusion"]), ...MASK_NODES],
    ...(SOMETIMES.length ? { optionalNodes: SOMETIMES } : {}),
    build(input, ctx) {
      const g = new GraphBuilder();
      const k = load(g, input, ctx);
      const box = boxOf(ctx.media.source, ctx.media.mask);
      const size = sizeOf(box, 1.2, 0.8);
      const source = g.out("LoadImage", { image: ctx.uploads.source });
      const part = g.out("ImageCrop", { image: source, width: box.width, height: box.height, x: box.x, y: box.y });
      const sized = g.out("ImageScale", { image: part, upscale_method: "lanczos", width: size.width, height: size.height, crop: "disabled" });
      const masks = maskParts(g, ctx.uploads.mask!, box, size, input);
      const c = cond(g, k, input, input.prompt);
      // soft inpainting: the model fades the new part in by the soft edge (Differential Diffusion) instead of a hard mask and a halo;
      // a family that inpaints with the mask as it is (hardInpaint) gets the plain one
      const masked = g.out("SetLatentNoiseMask", { samples: g.out("VAEEncode", { pixels: sized, vae: k.vae }), mask: spec.hardInpaint ? masks.forLatent : masks.softForLatent });
      g.phase("sampling");
      const model = spec.hardInpaint ? shifted(g, k.model, input, size) : g.out("DifferentialDiffusion", { model: shifted(g, k.model, input, size) });
      const { latent, pass } = sample(g, k, input, model, c, masked, ctx.seed, { denoise: input.strength });
      g.phase("decoding");
      const drawn = g.out("VAEDecode", { samples: latent, vae: k.vae });
      const back = g.out("ImageScale", { image: drawn, upscale_method: "lanczos", width: box.width, height: box.height, crop: "disabled" });
      const whole = g.out("ImageCompositeMasked", { destination: source, source: back, x: box.x, y: box.y, resize_source: false, mask: masks.soft });
      const out = g.add("PreviewImage", { images: whole });
      return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: pass.steps, passes: [pass], loads: k.loads };
    },
    variants: [
      {
        name: "a part of the picture",
        input: { source: "p", mask: "m", prompt: "a" } as Partial<FlowPaintOver>,
        slots: files, uploads: { source: "s.png", mask: "m.png" }, media: { source: photo, mask: { ...photo, box: { x: 300, y: 500, width: 600, height: 500 } } },
      },
      {
        name: "nothing known about the mask: the whole picture, a fine-tune",
        input: { source: "p", mask: "m", prompt: "a", strength: 1, ...tuned } as Partial<FlowPaintOver>,
        slots: files, uploads: { source: "s.png", mask: "m.png" }, media: { source: photo },
      },
    ],
  });
}
