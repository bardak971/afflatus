import { defineRecipe, GraphBuilder, type Recipe } from "@afflatus/core";
import type { FlowBase, FlowKit, FlowSpec } from "./kit";

export interface FlowRedraw extends FlowBase { source: string; prompt: string; strength: number }

/** img2img: a picture you have, drawn again from a prompt, a little (the same picture, cleaner) or a lot (the same layout, a new picture). */
export function flowRedraw(spec: FlowSpec, kit: FlowKit): Recipe<FlowRedraw> {
  const { inputs, loadNodes, SOMETIMES, load, shifted, cond, sample, sizeOf, tuned } = kit;
  const files = spec.files;
  return defineRecipe<FlowRedraw>({
    id: `${spec.family}.redraw`,
    family: spec.family,
    version: 1,
    title: "img2img",
    summary: "Image to image: an image redrawn from a prompt. The denoising strength says how far it may go from the original.",
    output: "image",
    inputs: [
      spec.model,
      { id: "source", type: "image", role: "source", label: "Image", note: "the picture it works on" },
      { id: "prompt", type: "prompt", label: "Prompt", style: "sentences", placeholder: "what the picture shows, as it should come out" },
      { id: "strength", type: "number", label: "Denoising strength", note: "0.3 keeps it close, 0.7 only keeps the layout", min: 0.05, max: 1, step: 0.05, default: 0.55 },
      ...inputs,
    ],
    ...(spec.presets ? { presets: spec.presets } : {}),
    nodes: (input) => [...loadNodes(input), "LoadImage", "ImageScale", "VAEEncode"],
    ...(SOMETIMES.length ? { optionalNodes: SOMETIMES } : {}),
    build(input, ctx) {
      const g = new GraphBuilder();
      const k = load(g, input, ctx);
      const size = sizeOf(ctx.media.source);
      const source = g.out("LoadImage", { image: ctx.uploads.source });
      const sized = g.out("ImageScale", { image: source, upscale_method: "lanczos", width: size.width, height: size.height, crop: "disabled" });
      const c = cond(g, k, input, input.prompt);
      g.phase("sampling");
      const { latent, pass } = sample(g, k, input, shifted(g, k.model, input, size), c, g.out("VAEEncode", { pixels: sized, vae: k.vae }), ctx.seed, { denoise: input.strength });
      g.phase("decoding");
      const out = g.add("PreviewImage", { images: g.out("VAEDecode", { samples: latent, vae: k.vae }) });
      return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: pass.steps, passes: [pass], loads: k.loads };
    },
    variants: [
      { name: "plain", input: { source: "p", prompt: "a" } as Partial<FlowRedraw>, slots: files, uploads: { source: "s.png" }, media: { source: { width: 896, height: 1152 } } },
      { name: "a large picture, a fine-tune, a LoRA, strong", input: { source: "p", prompt: "a", strength: 0.8, ...tuned } as Partial<FlowRedraw>, slots: files, uploads: { source: "s.png" }, media: { source: { width: 3000, height: 2000 } } },
    ],
  });
}
