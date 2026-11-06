import { defineRecipe, GraphBuilder, type Recipe } from "@afflatus/core";
import { dropsFor, pictureForm, SOURCE_INPUT, strengthInput } from "../shared/pictureForm";
import { boxOf, MASK_INPUTS, MASK_NODES, maskParts, type MaskSettings } from "../shared/mask";
import { INPAINT_PATCH_NODES, inpaintPatched, inpaintPatchNeeds, photo, type FlowBase, type FlowKit, type FlowSpec } from "./kit";

export interface FlowPaintOver extends FlowBase, MaskSettings { source: string; mask: string; prompt: string; strength: number }

/**
 * Inpaint: only the painted part is redone. It is cut out with room around it, redrawn at a size the model
 * draws well, and put back into the untouched picture through a soft edge.
 */
export function flowPaintOver(spec: FlowSpec, kit: FlowKit): Recipe<FlowPaintOver> {
  const { inputs, loadNodes, SOMETIMES, load, shifted, cond, sample, sizeOf, tuned, noiseWords } = kit;
  // the "?": the real noise the default starts from (card #146)
  const noise = noiseWords(0.8, spec.sampling.steps, [{ size: { width: 1024, height: 1024 }, where: "at 1 MP" }]);
  const files = spec.files;
  return pictureForm("inpaint", defineRecipe<FlowPaintOver>({
    id: `${spec.family}.paint-over`,
    family: spec.family,
    version: 1,
    title: "Inpaint",
    summary: "Paint a mask over a part of an image and prompt what goes there. Only the masked part is redrawn.",
    output: "image",
    inputs: [
      spec.model,
      SOURCE_INPUT,
      { id: "mask", type: "image", role: "mask", of: "source", label: "Inpaint mask", note: "the part to redo, painted over the picture" },
      { id: "prompt", type: "prompt", label: "Prompt", note: "the masked part with what is around it, as it should come out", style: "sentences", placeholder: "A woman's hand holding a glass of orange juice, on a terrace table in morning light." },
      strengthInput({ default: 0.8, note: ["1 ignores what was there", noise].filter(Boolean).join("; ") }),
      ...MASK_INPUTS,
      ...inputs,
    ],
    ...(spec.presets ? { presets: spec.presets } : {}),
    // with an inpaint patch, Differential Diffusion is used only where the patch's file is not there
    nodes: (input) => [...loadNodes(input), "LoadImage", "VAEEncode", ...(spec.hardInpaint || spec.inpaintPatch ? [] : ["DifferentialDiffusion"]), ...MASK_NODES],
    ...(spec.inpaintPatch ? { needsWith: inpaintPatchNeeds(spec) } : {}),
    ...(SOMETIMES.length || spec.inpaintPatch ? { optionalNodes: [...SOMETIMES, ...(spec.inpaintPatch ? [...INPAINT_PATCH_NODES, "DifferentialDiffusion"] : [])] } : {}),
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
      g.phase("sampling");
      const guided = inpaintPatched(g, ctx, spec, shifted(g, k.model, input, size), k.vae, sized, masks.forLatent);
      // soft inpainting: the model fades the new part in by the soft edge (Differential Diffusion) instead of a hard mask and a
      // halo; a family that inpaints with the mask as it is (hardInpaint) gets the plain one. So does one guided by its inpaint
      // patch, which fits the part to the picture itself: with the soft edge on top, the old thing held in the edge's ring
      // through most steps and Z-Image redrew it, the prompt followed on 1 seed of 4 at denoise 1; with the hard mask, 4 of 4
      // (the black basket asked to be "a wicker basket full of sunflowers", card #281's pod test)
      const hard = spec.hardInpaint || guided.loads.length > 0;
      const masked = g.out("SetLatentNoiseMask", { samples: g.out("VAEEncode", { pixels: sized, vae: k.vae }), mask: hard ? masks.forLatent : masks.softForLatent });
      const model = hard ? guided.model : g.out("DifferentialDiffusion", { model: guided.model });
      const { latent, pass } = sample(g, k, input, model, c, masked, ctx.seed, { denoise: input.strength });
      g.phase("decoding");
      const drawn = g.out("VAEDecode", { samples: latent, vae: k.vae });
      const back = g.out("ImageScale", { image: drawn, upscale_method: "lanczos", width: box.width, height: box.height, crop: "disabled" });
      const whole = g.out("ImageCompositeMasked", { destination: source, source: back, x: box.x, y: box.y, resize_source: false, mask: masks.soft });
      const out = g.add("PreviewImage", { images: whole });
      return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: pass.steps, passes: [pass], loads: [...k.loads, ...guided.loads] };
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
      // Turbo's branch: the LoRA put on, its steps at CFG 1 (the operations' other variants have no turbo file)
      ...(kit.turboFiles ? [{
        name: "Turbo with its LoRA", input: { source: "p", mask: "m", prompt: "a", fast: true, turboSteps: 6 } as Partial<FlowPaintOver>,
        slots: kit.turboFiles, uploads: { source: "s.png", mask: "m.png" }, media: { source: photo, mask: { ...photo, box: { x: 300, y: 500, width: 600, height: 500 } } },
      }] : []),
    ],
  }), dropsFor("inpaint", spec.drops));
}
