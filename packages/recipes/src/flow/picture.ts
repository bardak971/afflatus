import { defineRecipe, GraphBuilder, roundTo, type Recipe, type Ref, type SizeValue } from "@afflatus/core";
import { dropsFor, pictureForm } from "../shared/pictureForm";
import { HIRES_PASS_INPUTS, hiresPass, UPSCALER_PREFER, type HiresPass } from "../sdxl/common";
import { DETAIL_INPUTS, DETAIL_OPTIONAL, detailNodes, fullPassNodes, withoutDaemon, type DetailSettings } from "../shared/detail";
import { redrawInTiles, tileInputs, tileNodes, tilePass, inTiles, type TileSettings } from "../shared/tiles";
import { adetail, ADETAIL_OPTIONAL, adetailInputs, adetailNeeds, ALL_DETAIL, DETECTOR_FILES, sized, type AdetailSettings } from "../shared/adetail";
import { applyGuide, FOLLOW_MAP, guideInputs, guideNeeds, guideNodes, type GuideSettings } from "../shared/guide";
import { REDUX_NODES, reduxInputs, reduxNeeds, withRedux, type ReferenceSettings } from "../shared/references";
import type { FlowBase, FlowKit, FlowSpec } from "./kit";

export interface FlowPicture extends FlowBase, HiresPass, DetailSettings, TileSettings, AdetailSettings, GuideSettings, ReferenceSettings {
  prompt: string;
  size: SizeValue;
  hires: boolean;
  hiresScale: number;
  hiresUpscaler: string;
  hiresDenoise: number;
  hiresSteps: number;
}

/** txt2img, with hires fix: an upscale, then a second pass over the larger picture (in tiles past about twice the model's size each side). */
export function flowPicture(spec: FlowSpec, kit: FlowKit): Recipe<FlowPicture> {
  const { inputs, loadNodes, SOMETIMES, load, shifted, cond, sample, tuned, noiseWords } = kit;
  const files = spec.files;
  /** The area the model draws at, and the size a hires pass enlarges to. */
  const AREA = spec.megapixels * 1024 * 1024;
  const grid = spec.grid ?? 16;
  const largeOf = (input: FlowPicture) => ({ width: roundTo(roundTo(input.size.width, grid) * input.hiresScale, grid), height: roundTo(roundTo(input.size.height, grid) * input.hiresScale, grid) });
  const emptyLatent = spec.latent ?? "EmptySD3LatentImage";
  // the hires pass's "?": the real noise its default starts from, on the form's first shape at its default scale (card #146)
  const shape = spec.shapes.find((s) => s.id === "tall") ?? spec.shapes[0]!;
  const hiresDefault = { scale: spec.hires?.scale ?? 1.25, denoise: spec.hires?.denoise ?? 0.4, steps: spec.hires?.steps ?? Math.max(4, Math.round(spec.sampling.steps / 2)) };
  const hiresAt = { width: roundTo(shape.width * hiresDefault.scale, grid), height: roundTo(shape.height * hiresDefault.scale, grid) };
  const hiresNoise = noiseWords(hiresDefault.denoise, hiresDefault.steps, [{ size: hiresAt, where: `at ${hiresAt.width}×${hiresAt.height}` }]);
  return pictureForm("txt2img", defineRecipe<FlowPicture>({
    id: `${spec.family}.text-to-picture`,
    family: spec.family,
    version: 1,
    title: "txt2img",
    summary: spec.pictureSummary ?? "Text to image, from a natural-language prompt, with optional hires fix.",
    output: "image",
    // reference images ask for Redux and its vision model, which the build refuses them without (card #226); a guide picture
    // for its ControlNet; the Detail rows for their detectors
    needsWith: (input: FlowPicture, slots, where) => [
      ...(spec.references ? reduxNeeds(input) : []), ...(spec.guide ? guideNeeds(input, spec.guide) : []), ...adetailNeeds(input, slots, where),
    ],
    inputs: [
      spec.model,
      { id: "prompt", type: "prompt", label: "Prompt", style: "sentences", placeholder: spec.placeholder },
      // FLUX.1's single Redux image (look, lookStrength) before card #277: a saved draft's is read as its first reference
      ...(spec.references ? reduxInputs({ image: "look", strength: "lookStrength" }) : []),
      ...(spec.guide ? guideInputs(spec.guide) : []),
      { id: "size", type: "size", label: "Size", default: "tall", grid, min: 256, max: spec.maxSize ?? 2048, perModel: true, shapes: spec.shapes, ...(spec.maxPixels ? { maxPixels: spec.maxPixels } : {}) },
      ...adetailInputs("sentences"),
      ...DETAIL_INPUTS,
      ...inputs.slice(0, -1),
      { id: "hires", type: "toggle", label: "Hires fix", note: "upscale, then a second pass over the larger picture", default: false, advanced: true, perModel: true },
      { id: "hiresScale", type: "number", label: "Upscale by", note: "past 2×, the second pass is redrawn in tiles (see Redraw)", min: 1.1, max: 4, step: 0.05, default: spec.hires?.scale ?? 1.25, unit: "×", showWhen: "hires", advanced: true, perModel: true },
      {
        id: "hiresUpscaler", type: "choice", label: "Upscaler", note: "from your upscale models", showWhen: "hires", advanced: true, perModel: true,
        options: { node: "UpscaleModelLoader", input: "model_name" }, default: "RealESRGAN_x4plus.pth", prefer: UPSCALER_PREFER,
      },
      { id: "hiresDenoise", type: "number", label: "Denoising strength", note: ["how much the second pass may redraw", hiresNoise].filter(Boolean).join("; "), min: 0.05, max: 0.9, step: 0.05, default: hiresDefault.denoise, showWhen: "hires", advanced: true, perModel: true },
      { id: "hiresSteps", type: "number", label: "Hires steps", min: 1, max: 60, step: 1, default: hiresDefault.steps, showWhen: "hires", advanced: true, perModel: true },
      ...HIRES_PASS_INPUTS,
      ...tileInputs("hires"),
      inputs.at(-1)!,
    ],
    ...(spec.presets ? { presets: spec.presets } : {}),
    nodes: (input) => [
      ...loadNodes(input).filter((n) => n !== "KSampler"), emptyLatent, ...detailNodes(input),
      ...fullPassNodes(input, spec.turbo && input.fast ? input.turboSteps ?? input.steps : input.steps), ...(input.hires ? ["KSampler"] : []),
      ...(spec.references && input.references.length ? REDUX_NODES : []),
      ...(spec.guide ? guideNodes(input, spec.guide) : []),
      ...(input.hires ? ["UpscaleModelLoader", "ImageUpscaleWithModel", "ImageScale", "VAEEncode"] : []),
      ...tileNodes(input.hires && inTiles(input, largeOf(input), AREA)),
    ],
    optionalNodes: [...SOMETIMES, ...DETAIL_OPTIONAL, ...ADETAIL_OPTIONAL],
    build(input, ctx) {
      const g = new GraphBuilder();
      const k = load(g, input, ctx);
      const size = { width: roundTo(input.size.width, grid), height: roundTo(input.size.height, grid) };
      let c = cond(g, k, input, input.prompt);
      const loads = [...k.loads];
      if (spec.references) {
        const r = withRedux(g, ctx, c.positive, input);
        c = { ...c, positive: r.positive };
        loads.push(...r.loads);
      }
      // the guide picture holds the shapes of the first pass, drawn whole at its size; the hires pass and the Detail rows
      // redraw from the text alone, as SDXL's tiles do
      const guided = spec.guide ? applyGuide(g, ctx, spec.guide, { model: k.model, ...c }, k.vae, size, input) : { model: k.model, ...c, loads: [] };
      loads.push(...guided.loads);
      const empty = g.out(emptyLatent, { width: size.width, height: size.height, batch_size: 1 });
      g.phase("sampling");
      const detail = { input, ctx };
      const first = sample(g, k, input, shifted(g, guided.model, input, size), guided, empty, ctx.seed, {}, detail);
      let latent = first.latent;
      const passes: Array<typeof first.pass & { pixels?: number }> = [first.pass];
      let image: Ref | null = null;
      if (input.hires) {
        const large = largeOf(input);
        g.phase("upscaling");
        // upscale models enlarge by their own factor (usually 4×): the result is scaled to the size asked for
        const pixels = g.out("VAEDecode", { samples: latent, vae: k.vae });
        const big = g.out("ImageUpscaleWithModel", { upscale_model: g.out("UpscaleModelLoader", { model_name: input.hiresUpscaler }), image: pixels });
        const scaled = g.out("ImageScale", { image: big, upscale_method: "lanczos", width: large.width, height: large.height, crop: "disabled" });
        g.phase("refining");
        // a model run for a few steps (Turbo, or a file made for it) redraws in as many as it was made for at most:
        // the full model's half (25 steps for Qwen Image) is not what it was distilled for, and takes six times as long
        const pass = { steps: k.turbo ? Math.min(input.hiresSteps, k.steps) : input.hiresSteps, denoise: input.hiresDenoise, ...hiresPass(input) };
        if (inTiles(input, large, AREA)) {
          // each tile is a picture the model's size to it: the shift for that size
          const tile = Math.min(input.tileSize, Math.max(large.width, large.height));
          const tiled = shifted(g, k.model, input, { width: tile, height: tile });
          image = redrawInTiles(g, ctx, scaled, k.vae, large, input, (l) => {
            const second = sample(g, k, input, tiled, c, l, ctx.seed, pass, detail);
            passes.push(tilePass(second.pass, large, input));
            return second.latent;
          });
          // each pass at its own size: the first at the picture's first, the tiles at a tile's
          passes[0] = { ...passes[0]!, pixels: size.width * size.height };
        } else {
          const second = sample(g, k, input, shifted(g, k.model, input, large), c, g.out("VAEEncode", { pixels: scaled, vae: k.vae }), ctx.seed, pass, detail);
          latent = second.latent;
          passes.push(second.pass);
        }
        loads.push(`upscale_models/${input.hiresUpscaler}`);
      }
      g.phase("decoding");
      const drawn = image ?? g.out("VAEDecode", { samples: latent, vae: k.vae });
      // the Detail rows: faces, hands, people redrawn by the same model, each crop at the size it draws best
      const d = adetail(g, ctx, input, drawn, {
        model: () => shifted(g, k.model, input, { width: 1024, height: 1024 }), clip: k.clip, vae: k.vae, cond: (text) => (text ? cond(g, k, input, text) : c),
        steps: k.steps, cfg: k.cfg, sampler: input.sampler, scheduler: input.scheduler, seed: ctx.seed, scale: input.hires ? input.hiresScale : 1,
      });
      const out = g.add("PreviewImage", { images: d.image });
      const all = d.passes.length ? [...sized(passes, [size.width * size.height, largeOf(input).width * largeOf(input).height]), ...d.passes] : passes;
      return {
        graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: all.reduce((n, p) => n + p.steps, 0), passes: all, loads: [...loads, ...d.loads],
        ...(d.warnings.length ? { warnings: d.warnings } : {}),
      };
    },
    variants: [
      { name: "from words, as ComfyUI's template", input: { prompt: "a" } as Partial<FlowPicture>, slots: files },
      ...(spec.references
        ? [{
          name: "two reference images (Redux)", input: { prompt: "a", references: [{ asset: "a", role: "style" }, { asset: "b", role: "object" }] } as Partial<FlowPicture>,
          slots: { ...files, redux: "flux1-redux-dev.safetensors", vision: "sigclip_vision_patch14_384.safetensors" }, uploads: { "references.0": "a.png", "references.1": "b.png" },
        }]
        : []),
      ...(spec.guide
        ? [
          { name: "a guide picture's edges (ControlNet)", input: { prompt: "a", guide: "g1" } as Partial<FlowPicture>, slots: { ...files, [spec.guide.slot]: spec.guide.file }, uploads: { guide: "g.png" } },
          { name: "a guide picture's pose, with hires fix", input: { prompt: "a", guide: "g1", guideFollows: "Pose", hires: true, hiresUpscaler: "u.pth" } as Partial<FlowPicture>, slots: { ...files, [spec.guide.slot]: spec.guide.file }, uploads: { guide: "g.png" } },
          { name: "a guide map of the user's own ControlNet", input: { prompt: "a", guide: "g1", guideFollows: FOLLOW_MAP, guideModel: "mine.safetensors" } as Partial<FlowPicture>, slots: files, uploads: { guide: "g.png" } },
        ]
        : []),
      { name: "Detail: face, hands and person", input: { prompt: "a", ...ALL_DETAIL } as Partial<FlowPicture>, slots: { ...files, ...DETECTOR_FILES } },
      { name: "Detail: face after a hires fix", input: { prompt: "a", detailFace: true, hires: true, hiresUpscaler: "u.pth" } as Partial<FlowPicture>, slots: { ...files, ...DETECTOR_FILES } },
      { name: "detail boost, hires fix 3× in tiles", input: { prompt: "a", detail: true, hires: true, hiresScale: 3, hiresUpscaler: "u.pth" } as Partial<FlowPicture>, slots: files, has: withoutDaemon },
      { name: "a GGUF model, in fp8 asked for (no effect on it)", input: { prompt: "a", model: `${spec.family}-Q4_K_M.gguf`, precision: "fp8_e4m3fn" } as Partial<FlowPicture>, slots: files },
      { name: "a fine-tune with a shift, a LoRA, a negative prompt and hires fix", input: { prompt: "a", ...tuned, hires: true, hiresUpscaler: "u.pth", size: { width: 1152, height: 1536 } } as Partial<FlowPicture>, slots: files },
      ...(spec.turbo
        ? [
          { name: "Turbo with its LoRA", input: { prompt: "a", fast: true } as Partial<FlowPicture>, slots: { ...files, [spec.turbo.slot]: "turbo.safetensors" } },
          { name: "Turbo without its LoRA: the full steps", input: { prompt: "a", fast: true } as Partial<FlowPicture>, slots: files },
        ]
        : []),
    ],
  }), dropsFor("txt2img", spec.drops));
}
