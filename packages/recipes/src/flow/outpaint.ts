import { defineRecipe, GraphBuilder, type Recipe } from "@afflatus/core";
import { OUTPAINT_INPUTS, OUTPAINT_NODES, outpaintLatent, type OutpaintSettings } from "../sdxl/common";
import { photo, type FlowBase, type FlowKit, type FlowSpec } from "./kit";

export interface FlowOutpaint extends FlowBase, OutpaintSettings { source: string; prompt: string }

/** Outpaint: a picture extended beyond its edges, the sides chosen painted in from the prompt, the picture itself kept. */
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
      { id: "source", type: "image", role: "source", label: "Image" },
      { id: "prompt", type: "prompt", label: "Prompt", note: "the whole scene, as it should look once wider", style: "sentences", placeholder: "A wide shot of the terrace at sunset, the sea behind the railing, warm light." },
      ...OUTPAINT_INPUTS,
      ...inputs,
    ],
    ...(spec.presets ? { presets: spec.presets } : {}),
    nodes: (input) => [...loadNodes(input).filter((n) => n !== "VAEDecode" && n !== "PreviewImage"), ...OUTPAINT_NODES],
    ...(SOMETIMES.length ? { optionalNodes: SOMETIMES } : {}),
    build(input, ctx) {
      if (input.padLeft + input.padRight + input.padTop + input.padBottom === 0) throw new Error("Nothing to extend: set how far the picture grows on at least one side.");
      const g = new GraphBuilder();
      const k = load(g, input, ctx);
      const from = ctx.media.source?.width ? ctx.media.source : { width: 1024, height: 1024 };
      const whole = { width: from.width + input.padLeft + input.padRight, height: from.height + input.padTop + input.padBottom };
      const size = sizeOf(whole);
      const source = g.out("LoadImage", { image: ctx.uploads.source });
      const { latent: padded } = outpaintLatent(g, source, from, input, size, k.vae);
      const c = cond(g, k, input, input.prompt);
      g.phase("sampling");
      const { latent, pass } = sample(g, k, input, shifted(g, k.model, input, size), c, padded, ctx.seed);
      g.phase("decoding");
      const drawn = g.out("VAEDecode", { samples: latent, vae: k.vae });
      const out = g.add("PreviewImage", { images: g.out("ImageScale", { image: drawn, upscale_method: "lanczos", width: whole.width, height: whole.height, crop: "disabled" }) });
      return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: pass.steps, passes: [pass], loads: k.loads };
    },
    variants: [
      { name: "wider on both sides", input: { source: "p", prompt: "a" } as Partial<FlowOutpaint>, slots: files, uploads: { source: "s.png" }, media: { source: { width: 896, height: 1152 } } },
      { name: "taller, a fine-tune with a LoRA", input: { source: "p", prompt: "a", padLeft: 0, padRight: 0, padTop: 256, padBottom: 0, ...tuned } as Partial<FlowOutpaint>, slots: files, uploads: { source: "s.png" }, media: { source: photo } },
    ],
  });
}
