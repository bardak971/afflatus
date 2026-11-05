import { defineRecipe, GraphBuilder, type Recipe } from "@afflatus/core";
import { dropsFor, pictureForm, SOURCE_INPUT, strengthInput } from "../shared/pictureForm";
import { applyGuide, guideInputs, guideNeeds, guideNodes, type GuideSettings } from "../shared/guide";
import { REDUX_NODES, reduxInputs, reduxNeeds, withRedux, type ReferenceSettings } from "../shared/references";
import { sigmaWords } from "../shared/sigmaWords";
import type { FlowBase, FlowKit, FlowSpec } from "./kit";

export interface FlowRedraw extends FlowBase, GuideSettings, ReferenceSettings { source: string; prompt: string; strength: number }

/** img2img: a picture you have, drawn again from a prompt, a little (the same picture, cleaner) or a lot (the same layout, a new picture). */
export function flowRedraw(spec: FlowSpec, kit: FlowKit): Recipe<FlowRedraw> {
  const { inputs, loadNodes, SOMETIMES, load, shifted, cond, sample, sizeOf, tuned, startSigma } = kit;
  const files = spec.files;
  // the "?": the real noise the field starts from (card #146). On Z-Image, a face redrawn from 0.40 of it was the same person,
  // from 0.56 it drifted, and from the default's 0.80 it was another person
  const [d55, d30, d20] = [0.55, 0.3, 0.2].map((d) => startSigma(d, spec.sampling.steps, { width: 1024, height: 1024 }));
  const strengthNote = d55 == null
    ? "0.3 keeps it close, 0.7 only keeps the layout"
    : `denoise at the model's shift: at 1 MP, 0.55 starts from ${sigmaWords(d55)} of real noise, 0.3 from ${sigmaWords(d30!)}, 0.2 from ${sigmaWords(d20!)}. A face stays the same person up to about 0.4 of real noise`;
  return pictureForm("img2img", defineRecipe<FlowRedraw>({
    id: `${spec.family}.redraw`,
    family: spec.family,
    version: 1,
    title: "img2img",
    summary: "Image to image: an image redrawn from a prompt. The denoising strength says how far it may go from the original.",
    output: "image",
    // reference images ask for Redux and its vision model, a guide picture for its ControlNet (as txt2img's)
    ...(spec.references || spec.guide ? { needsWith: (input: FlowRedraw) => [...(spec.references ? reduxNeeds(input) : []), ...(spec.guide ? guideNeeds(input, spec.guide) : [])] } : {}),
    inputs: [
      spec.model,
      SOURCE_INPUT,
      { id: "prompt", type: "prompt", label: "Prompt", style: "sentences", placeholder: "what the picture shows, as it should come out" },
      strengthInput({ default: 0.55, note: strengthNote }),
      ...(spec.references ? reduxInputs() : []),
      ...(spec.guide ? guideInputs(spec.guide) : []),
      ...inputs,
    ],
    ...(spec.presets ? { presets: spec.presets } : {}),
    nodes: (input) => [
      ...loadNodes(input), "LoadImage", "ImageScale", "VAEEncode",
      ...(spec.references && input.references.length ? REDUX_NODES : []), ...(spec.guide ? guideNodes(input, spec.guide) : []),
    ],
    ...(SOMETIMES.length ? { optionalNodes: SOMETIMES } : {}),
    build(input, ctx) {
      const g = new GraphBuilder();
      const k = load(g, input, ctx);
      const size = sizeOf(ctx.media.source);
      const source = g.out("LoadImage", { image: ctx.uploads.source });
      const sized = g.out("ImageScale", { image: source, upscale_method: "lanczos", width: size.width, height: size.height, crop: "disabled" });
      let c = cond(g, k, input, input.prompt);
      const loads = [...k.loads];
      if (spec.references) {
        const r = withRedux(g, ctx, c.positive, input);
        c = { ...c, positive: r.positive };
        loads.push(...r.loads);
      }
      // the guide picture at the size the picture is redrawn at: the redraw keeps its shapes as well as the picture's own
      const guided = spec.guide ? applyGuide(g, ctx, spec.guide, { model: k.model, ...c }, k.vae, size, input) : { model: k.model, ...c, loads: [] };
      loads.push(...guided.loads);
      g.phase("sampling");
      const { latent, pass } = sample(g, k, input, shifted(g, guided.model, input, size), guided, g.out("VAEEncode", { pixels: sized, vae: k.vae }), ctx.seed, { denoise: input.strength });
      g.phase("decoding");
      const out = g.add("PreviewImage", { images: g.out("VAEDecode", { samples: latent, vae: k.vae }) });
      return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: pass.steps, passes: [pass], loads };
    },
    variants: [
      { name: "plain", input: { source: "p", prompt: "a" } as Partial<FlowRedraw>, slots: files, uploads: { source: "s.png" }, media: { source: { width: 896, height: 1152 } } },
      { name: "a large picture, a fine-tune, a LoRA, strong", input: { source: "p", prompt: "a", strength: 0.8, ...tuned } as Partial<FlowRedraw>, slots: files, uploads: { source: "s.png" }, media: { source: { width: 3000, height: 2000 } } },
      // Turbo's branch: the LoRA put on, its steps at CFG 1 (the operations' other variants have no turbo file)
      ...(spec.references
        ? [{
          name: "a reference image (Redux)", input: { source: "p", prompt: "a", references: [{ asset: "a", role: "style" }] } as Partial<FlowRedraw>,
          slots: { ...files, redux: "flux1-redux-dev.safetensors", vision: "sigclip_vision_patch14_384.safetensors" }, uploads: { source: "s.png", "references.0": "a.png" }, media: { source: { width: 896, height: 1152 } },
        }]
        : []),
      ...(spec.guide
        ? [{
          name: "a guide picture's depth (ControlNet)", input: { source: "p", prompt: "a", strength: 0.8, guide: "g1", guideFollows: "Depth" } as Partial<FlowRedraw>,
          slots: { ...files, [spec.guide.slot]: spec.guide.file }, uploads: { source: "s.png", guide: "g.png" }, media: { source: { width: 896, height: 1152 } },
        }]
        : []),
      ...(kit.turboFiles ? [{ name: "Turbo with its LoRA", input: { source: "p", prompt: "a", fast: true, turboSteps: 6 } as Partial<FlowRedraw>, slots: kit.turboFiles, uploads: { source: "s.png" }, media: { source: { width: 896, height: 1152 } } }] : []),
    ],
  }), dropsFor("img2img", spec.drops));
}
