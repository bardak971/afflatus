import { defineRecipe, GraphBuilder, type Recipe, type Ref } from "@afflatus/core";
import { dropsFor, pictureForm, SOURCE_INPUT } from "../shared/pictureForm";
import { OUTPAINT_INPUTS, OUTPAINT_NODES, outpaintPad, outpaintPlan, PASTE_BACK_NODES, pasteBack, stretchedFill, type OutpaintSettings } from "../shared/outpaint";
import { INPAINT_PATCH_NODES, inpaintPatched, inpaintPatchNeeds, photo, type FlowBase, type FlowKit, type FlowSpec } from "./kit";

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
  return pictureForm("outpaint", defineRecipe<FlowOutpaint>({
    id: `${spec.family}.outpaint`,
    family: spec.family,
    version: 1,
    title: "Outpaint",
    summary: "Extends an image beyond its edges: the sides you choose are painted in from the prompt, the picture itself stays.",
    output: "image",
    inputs: [
      spec.model,
      SOURCE_INPUT,
      { id: "prompt", type: "prompt", label: "Prompt", note: "the whole scene, as it should look once wider", style: "sentences", placeholder: "A wide shot of the terrace at sunset, the sea behind the railing, warm light." },
      ...OUTPAINT_INPUTS,
      ...inputs,
    ],
    ...(spec.presets ? { presets: spec.presets } : {}),
    nodes: (input) => spec.extend
      ? [...loadNodes(input), ...spec.extend.nodes, "LoadImage", "ImagePadForOutpaint", "ImageScale", "SplitImageWithAlpha", ...PASTE_BACK_NODES, "GrowMask", "MaskToImage", "ImageToMask"]
      : [...loadNodes(input).filter((n) => n !== "VAEDecode" && n !== "PreviewImage"), ...OUTPAINT_NODES, ...PASTE_BACK_NODES, "GrowMask", "VAEEncode", "SetLatentNoiseMask", ...(spec.hardInpaint ? [] : ["DifferentialDiffusion"])],
    ...(spec.inpaintPatch ? { needsWith: inpaintPatchNeeds(spec) } : {}),
    ...(SOMETIMES.length || spec.inpaintPatch ? { optionalNodes: [...SOMETIMES, ...(spec.inpaintPatch ? INPAINT_PATCH_NODES : [])] } : {}),
    build(form, ctx) {
      const { input, from, whole } = outpaintPlan(form, ctx.media.source);
      const g = new GraphBuilder();
      const k = load(g, input, ctx);
      const size = sizeOf(whole);
      const source = g.out("LoadImage", { image: ctx.uploads.source });
      if (spec.extend) return extended(g, k, input, ctx.seed, source, from, whole, size, spec.extend);
      const { padded, pixels: grey, mask } = outpaintPad(g, source, input, size);
      const c = cond(g, k, input, input.prompt);
      // a family that inpaints with the mask as it is (hardInpaint, Krea 2's) outpaints so too
      const soft = (m: Ref) => (spec.hardInpaint ? m : g.out("DifferentialDiffusion", { model: m }));
      const model = shifted(g, soft(k.model), input, size);
      const start = g.out("SetLatentNoiseMask", { samples: g.out("VAEEncode", { pixels: stretchedFill(g, source, input, whole, size), vae: k.vae }), mask });
      g.phase("sampling");
      // the inpaint guide, when the family has one, on the first pass only: it is given the padding, which the seam pass's band is not
      const guided = inpaintPatched(g, ctx, spec, k.model, k.vae, grey, mask);
      const first = sample(g, k, input, guided.loads.length ? shifted(g, soft(guided.model), input, size) : model, c, start, ctx.seed);
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
      ...(spec.extend ? [{ name: "to 16:9 by its edit mode, a fine-tune with a LoRA", input: { source: "p", prompt: "a", shape: "Widescreen 16:9", ...tuned } as Partial<FlowOutpaint>, slots: files, uploads: { source: "s.png" }, media: { source: photo } }] : []),
      { name: "wider on both sides", input: { source: "p", prompt: "a" } as Partial<FlowOutpaint>, slots: files, uploads: { source: "s.png" }, media: { source: { width: 896, height: 1152 } } },
      { name: "to 16:9, the picture in the middle", input: { source: "p", prompt: "a", shape: "Widescreen 16:9" } as Partial<FlowOutpaint>, slots: files, uploads: { source: "s.png" }, media: { source: photo } },
      { name: "taller, a fine-tune with a LoRA", input: { source: "p", prompt: "a", padLeft: 0, padRight: 0, padTop: 256, padBottom: 0, ...tuned } as Partial<FlowOutpaint>, slots: files, uploads: { source: "s.png" }, media: { source: photo } },
      // Turbo's branch: the LoRA put on, its steps at CFG 1 (the operations' other variants have no turbo file)
      ...(kit.turboFiles ? [{ name: "Turbo with its LoRA", input: { source: "p", prompt: "a", fast: true, turboSteps: 6 } as Partial<FlowOutpaint>, slots: kit.turboFiles, uploads: { source: "s.png" }, media: { source: { width: 896, height: 1152 } } }] : []),
    ],
  }), dropsFor("outpaint", spec.drops));

  /**
   * Outpaint by the family's edit mode (FlowSpec.extend): the picture padded with grey at the drawing size is the picture
   * edited, the whole frame is drawn from the empty latent the reading gives, and the picture is put back over the result,
   * faded in from a band inside its edge (the seam pass's paste), since the model's version of it is never quite as light.
   */
  function extended(g: GraphBuilder, k: ReturnType<FlowKit["load"]>, input: FlowOutpaint, seed: number, source: Ref, from: { width: number; height: number }, whole: { width: number; height: number }, size: { width: number; height: number }, extend: NonNullable<FlowSpec["extend"]>) {
    const padded = g.add("ImagePadForOutpaint", { image: source, left: input.padLeft, top: input.padTop, right: input.padRight, bottom: input.padBottom, feathering: input.feathering });
    const canvas = g.out("ImageScale", { image: [padded, 0], upscale_method: "lanczos", width: size.width, height: size.height, crop: "disabled" });
    const read = extend.read(g, k, input.prompt, input.negative, canvas);
    g.phase("sampling");
    const drawn = sample(g, k, input, shifted(g, k.model, input, size), read, read.latent, seed);
    g.phase("decoding");
    // the colours alone: Qwen Image 2.1's VAE decodes an alpha too, which the paste back has no use for
    const rgb = g.out("SplitImageWithAlpha", { image: g.out("VAEDecode", { samples: drawn.latent, vae: k.vae }) });
    const atWhole = g.out("ImageScale", { image: rgb, upscale_method: "lanczos", width: whole.width, height: whole.height, crop: "disabled" });
    const out = g.add("PreviewImage", { images: pasteBack(g, atWhole, source, padded, from, input, SEAM_BAND) });
    return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image" as const, role: "result" as const }], totalSteps: drawn.pass.steps, passes: [drawn.pass], loads: k.loads };
  }
}
