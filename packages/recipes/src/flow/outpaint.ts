import { defineRecipe, GraphBuilder, type Recipe, type Ref } from "@afflatus/core";
import { OUTPAINT_INPUTS, OUTPAINT_NODES, outpaintLatent, PASTE_BACK_NODES, pasteBack, stretchedFill, type OutpaintSettings } from "../sdxl/common";
import { INPAINT_PATCH_NODES, inpaintPatched, photo, type FlowBase, type FlowKit, type FlowSpec } from "./kit";

export interface FlowOutpaint extends FlowBase, OutpaintSettings { source: string; prompt: string }

/** How far into the picture the seam pass reaches, and the pasted-back picture stops short of its edge. */
const SEAM_BAND = 48;
/** How much the seam pass may redraw: enough to blend the join, not to change what is there. */
const SEAM_DENOISE = 0.35;

/**
 * Outpaint: a picture extended beyond its edges, the sides chosen painted in from the prompt, the picture itself kept.
 * The new part starts from the picture stretched and blurred and is redrawn through a soft mask; a light seam pass
 * then goes over the join and a band into the picture, and the picture is put back inside that band. Tried on a
 * real ComfyUI with Z-Image: in one pass the model drew a faint line where the new part met the picture, which no
 * width of blending hid.
 */
export function flowOutpaint(spec: FlowSpec, kit: FlowKit): Recipe<FlowOutpaint> {
  const { inputs, loadNodes, SOMETIMES, load, shifted, cond, sample, sizeOf, tuned } = kit;
  const files = spec.files;
  return defineRecipe<FlowOutpaint>({
    id: `${spec.family}.outpaint`,
    family: spec.family,
    version: 1,
    title: "Outpaint",
    summary: "Extends an image beyond its edges: the sides you choose are painted in from the prompt, the picture itself stays.",
    output: "image",
    inputs: [
      spec.model,
      { id: "source", type: "image", role: "source", label: "Image", note: "the picture it works on" },
      { id: "prompt", type: "prompt", label: "Prompt", note: "the whole scene, as it should look once wider", style: "sentences", placeholder: "A wide shot of the terrace at sunset, the sea behind the railing, warm light." },
      ...OUTPAINT_INPUTS,
      ...inputs,
    ],
    ...(spec.presets ? { presets: spec.presets } : {}),
    nodes: (input) => [...loadNodes(input).filter((n) => n !== "VAEDecode" && n !== "PreviewImage"), ...OUTPAINT_NODES, ...PASTE_BACK_NODES, "GrowMask", "VAEEncode", "SetLatentNoiseMask", "DifferentialDiffusion"],
    ...(SOMETIMES.length || spec.inpaintPatch ? { optionalNodes: [...SOMETIMES, ...(spec.inpaintPatch ? INPAINT_PATCH_NODES : [])] } : {}),
    build(input, ctx) {
      if (input.padLeft + input.padRight + input.padTop + input.padBottom === 0) throw new Error("Nothing to extend: set how far the picture grows on at least one side.");
      const g = new GraphBuilder();
      const k = load(g, input, ctx);
      const from = ctx.media.source?.width ? ctx.media.source : { width: 1024, height: 1024 };
      const whole = { width: from.width + input.padLeft + input.padRight, height: from.height + input.padTop + input.padBottom };
      const size = sizeOf(whole);
      const source = g.out("LoadImage", { image: ctx.uploads.source });
      const { padded, pixels: grey, mask } = outpaintLatent(g, source, from, input, size, k.vae);
      const c = cond(g, k, input, input.prompt);
      const model = shifted(g, g.out("DifferentialDiffusion", { model: k.model }), input, size);
      const start = g.out("SetLatentNoiseMask", { samples: g.out("VAEEncode", { pixels: stretchedFill(g, source, input, whole, size), vae: k.vae }), mask });
      g.phase("sampling");
      // the inpaint guide, when the family has one, on the first pass only: it is given the padding, which the seam pass's band is not
      const guided = inpaintPatched(g, ctx, spec, k.model, k.vae, grey, mask);
      const first = sample(g, k, input, guided.loads.length ? shifted(g, g.out("DifferentialDiffusion", { model: guided.model }), input, size) : model, c, start, ctx.seed);
      const atSize = (image: Ref, to: { width: number; height: number }) => g.out("ImageScale", { image, upscale_method: "lanczos", width: to.width, height: to.height, crop: "disabled" });
      const drawn = pasteBack(g, atSize(g.out("VAEDecode", { samples: first.latent, vae: k.vae }), whole), source, padded, from, input);
      // the seam pass: the new part and a band into the picture, redrawn lightly
      g.phase("refining");
      const band = g.out("ImageToMask", { image: atSize(g.out("MaskToImage", { mask: g.out("GrowMask", { mask: [padded, 1], expand: SEAM_BAND, tapered_corners: true }) }), size), channel: "red" });
      const seam = sample(g, k, input, model, c, g.out("SetLatentNoiseMask", { samples: g.out("VAEEncode", { pixels: atSize(drawn, size), vae: k.vae }), mask: band }), ctx.seed + 1, { denoise: SEAM_DENOISE });
      g.phase("decoding");
      const out = g.add("PreviewImage", { images: pasteBack(g, atSize(g.out("VAEDecode", { samples: seam.latent, vae: k.vae }), whole), source, padded, from, input, SEAM_BAND * 2) });
      const passes = [first.pass, { ...seam.pass, steps: Math.max(1, Math.round(seam.pass.steps * SEAM_DENOISE)) }];
      return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: passes.reduce((n, p) => n + p.steps, 0), passes, loads: [...k.loads, ...guided.loads] };
    },
    variants: [
      { name: "wider on both sides", input: { source: "p", prompt: "a" } as Partial<FlowOutpaint>, slots: files, uploads: { source: "s.png" }, media: { source: { width: 896, height: 1152 } } },
      { name: "taller, a fine-tune with a LoRA", input: { source: "p", prompt: "a", padLeft: 0, padRight: 0, padTop: 256, padBottom: 0, ...tuned } as Partial<FlowOutpaint>, slots: files, uploads: { source: "s.png" }, media: { source: photo } },
    ],
  });
}
