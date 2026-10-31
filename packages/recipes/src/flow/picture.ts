import { defineRecipe, GraphBuilder, roundTo, type InputSpec, type Recipe, type Ref, type SizeValue } from "@afflatus/core";
import { HIRES_PASS_INPUTS, hiresPass, UPSCALER_PREFER, type HiresPass } from "../sdxl/common";
import { DETAIL_INPUTS, DETAIL_OPTIONAL, detailNodes, fullPassNodes, withoutDaemon, type DetailSettings } from "../shared/detail";
import { redrawInTiles, tileInputs, tileNodes, tilePass, inTiles, type TileSettings } from "../shared/tiles";
import { PASS_NOISE, PASS_NOISE_INPUT, type PassNoise } from "../shared/passNoise";
import type { FlowBase, FlowKit, FlowSpec } from "./kit";

export interface FlowPicture extends FlowBase, HiresPass, DetailSettings, TileSettings {
  prompt: string;
  look?: string;
  lookStrength: number;
  size: SizeValue;
  hires: boolean;
  hiresScale: number;
  hiresUpscaler: string;
  hiresDenoise: number;
  hiresSteps: number;
  passNoise?: PassNoise;
}

const LOOK_NODES = ["LoadImage", "CLIPVisionLoader", "CLIPVisionEncode", "StyleModelLoader", "StyleModelApply"];
const LOOK_NEEDED = "The look of a picture needs FLUX.1 Redux and its vision model: flux1-redux-dev.safetensors in ComfyUI's models/style_models folder and sigclip_vision_patch14_384.safetensors in models/clip_vision (both are listed in Settings).";

/** txt2img, with hires fix: an upscale, then a second pass over the larger picture (in tiles past about twice the model's size each side). */
export function flowPicture(spec: FlowSpec, kit: FlowKit): Recipe<FlowPicture> {
  const { inputs, loadNodes, SOMETIMES, load, shifted, cond, sample, tuned, noiseWords, secondPass } = kit;
  const files = spec.files;
  /** The area the model draws at, and the size a hires pass enlarges to. */
  const AREA = spec.megapixels * 1024 * 1024;
  const largeOf = (input: FlowPicture) => ({ width: roundTo(roundTo(input.size.width, 16) * input.hiresScale, 16), height: roundTo(roundTo(input.size.height, 16) * input.hiresScale, 16) });
  // the hires pass's "?": the real noise its default starts from, on the form's first shape at its default scale (card #146)
  const shape = spec.shapes.find((s) => s.id === "tall") ?? spec.shapes[0]!;
  const hiresDefault = { scale: spec.hires?.scale ?? 1.25, denoise: spec.hires?.denoise ?? 0.4, steps: spec.hires?.steps ?? Math.max(4, Math.round(spec.sampling.steps / 2)) };
  const hiresAt = { width: roundTo(shape.width * hiresDefault.scale, 16), height: roundTo(shape.height * hiresDefault.scale, 16) };
  const hiresNoise = noiseWords(hiresDefault.denoise, hiresDefault.steps, [{ size: hiresAt, where: `at ${hiresAt.width}×${hiresAt.height}` }]);
  return defineRecipe<FlowPicture>({
    id: `${spec.family}.text-to-picture`,
    family: spec.family,
    version: 1,
    title: "txt2img",
    summary: "Text to image, from a natural-language prompt, with optional hires fix.",
    output: "image",
    inputs: [
      spec.model,
      { id: "prompt", type: "prompt", label: "Prompt", style: "sentences", placeholder: spec.placeholder },
      { id: "size", type: "size", label: "Size", default: "tall", grid: 16, min: 256, max: 2048, shapes: spec.shapes, ...(spec.maxPixels ? { maxPixels: spec.maxPixels } : {}) },
      ...(spec.look
        ? ([
          { id: "look", type: "image", role: "guide", label: "Redux image", optional: true, note: "its style, colours and subject are added to the prompt (Redux): the new picture is like it, not a copy" },
          { id: "lookStrength", type: "number", label: "Redux strength", note: "1 follows the picture closely and the prompt little; 0.3 to 0.6 keeps the prompt in charge", min: 0.05, max: 1.5, step: 0.05, default: 0.5, showWhen: "look" },
        ] satisfies InputSpec[])
        : []),
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
      PASS_NOISE_INPUT,
      inputs.at(-1)!,
    ],
    ...(spec.presets ? { presets: spec.presets } : {}),
    nodes: (input) => [
      ...loadNodes(input).filter((n) => n !== "KSampler"), "EmptySD3LatentImage", ...detailNodes(input),
      ...fullPassNodes(input, spec.turbo && input.fast ? input.turboSteps ?? input.steps : input.steps), ...(input.hires ? ["KSampler"] : []),
      ...(spec.look && input.look ? LOOK_NODES : []),
      ...(input.hires ? ["UpscaleModelLoader", "ImageUpscaleWithModel", "ImageScale", "VAEEncode"] : []),
      ...tileNodes(input.hires && inTiles(input, largeOf(input), AREA)),
    ],
    optionalNodes: [...SOMETIMES, ...DETAIL_OPTIONAL],
    build(input, ctx) {
      const g = new GraphBuilder();
      const k = load(g, input, ctx);
      const size = { width: roundTo(input.size.width, 16), height: roundTo(input.size.height, 16) };
      let c = cond(g, k, input, input.prompt);
      if (spec.look && input.look) {
        if (!ctx.slots.redux || !ctx.slots.vision) throw new Error(LOOK_NEEDED);
        const seen = g.out("CLIPVisionEncode", { clip_vision: g.out("CLIPVisionLoader", { clip_name: ctx.slots.vision }), image: g.out("LoadImage", { image: ctx.uploads.look }), crop: "center" });
        c = { ...c, positive: g.out("StyleModelApply", { conditioning: c.positive, style_model: g.out("StyleModelLoader", { style_model_name: ctx.slots.redux }), clip_vision_output: seen, strength: input.lookStrength, strength_type: "multiply" }) };
      }
      const empty = g.out("EmptySD3LatentImage", { width: size.width, height: size.height, batch_size: 1 });
      g.phase("sampling");
      const detail = { input, ctx };
      const first = sample(g, k, input, shifted(g, k.model, input, size), c, empty, ctx.seed, {}, detail);
      let latent = first.latent;
      const passes: Array<typeof first.pass & { pixels?: number }> = [first.pass];
      const loads = [...k.loads];
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
        const steps = k.turbo ? Math.min(input.hiresSteps, k.steps) : input.hiresSteps;
        const pass = { steps, ...hiresPass(input) };
        if (inTiles(input, large, AREA)) {
          // each tile is a picture the model's size to it: the shift for that size
          const tile = Math.min(input.tileSize, Math.max(large.width, large.height));
          const tiled = secondPass(g, k.model, input, { width: tile, height: tile }, steps, input.hiresDenoise);
          image = redrawInTiles(g, ctx, scaled, k.vae, large, input, (l) => {
            const second = sample(g, k, input, tiled.model, c, l, ctx.seed, { ...pass, denoise: tiled.denoise }, detail);
            passes.push(tilePass(second.pass, large, input));
            return second.latent;
          });
          // each pass at its own size: the first at the picture's first, the tiles at a tile's
          passes[0] = { ...passes[0]!, pixels: size.width * size.height };
        } else {
          const whole = secondPass(g, k.model, input, large, steps, input.hiresDenoise);
          const second = sample(g, k, input, whole.model, c, g.out("VAEEncode", { pixels: scaled, vae: k.vae }), ctx.seed, { ...pass, denoise: whole.denoise }, detail);
          latent = second.latent;
          passes.push(second.pass);
        }
        loads.push(`upscale_models/${input.hiresUpscaler}`);
      }
      g.phase("decoding");
      const out = g.add("PreviewImage", { images: image ?? g.out("VAEDecode", { samples: latent, vae: k.vae }) });
      return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: passes.reduce((n, p) => n + p.steps, 0), passes, loads };
    },
    variants: [
      { name: "from words, as ComfyUI's template", input: { prompt: "a" } as Partial<FlowPicture>, slots: files },
      ...(spec.look ? [{ name: "the look of a picture (Redux)", input: { prompt: "a", look: "l1" } as Partial<FlowPicture>, slots: { ...files, redux: "flux1-redux-dev.safetensors", vision: "sigclip_vision_patch14_384.safetensors" }, uploads: { look: "l.png" } }] : []),
      { name: "detail boost, hires fix 3× in tiles", input: { prompt: "a", detail: true, hires: true, hiresScale: 3, hiresUpscaler: "u.pth" } as Partial<FlowPicture>, slots: files, has: withoutDaemon },
      { name: "a GGUF model, in fp8 asked for (no effect on it)", input: { prompt: "a", model: `${spec.family}-Q4_K_M.gguf`, precision: "fp8_e4m3fn" } as Partial<FlowPicture>, slots: files },
      { name: "a fine-tune with a shift, a LoRA, a negative prompt and hires fix", input: { prompt: "a", ...tuned, hires: true, hiresUpscaler: "u.pth", size: { width: 1152, height: 1536 } } as Partial<FlowPicture>, slots: files },
      // card #146's two other readings of the denoise, for side-by-sides
      { name: "hires fix at the 1 MP shift", input: { prompt: "a", hires: true, hiresUpscaler: "u.pth", passNoise: PASS_NOISE.oneMp } as Partial<FlowPicture>, slots: files },
      { name: "hires fix from the real σ", input: { prompt: "a", hires: true, hiresUpscaler: "u.pth", passNoise: PASS_NOISE.real } as Partial<FlowPicture>, slots: files },
      ...(spec.turbo
        ? [
          { name: "Turbo with its LoRA", input: { prompt: "a", fast: true } as Partial<FlowPicture>, slots: { ...files, [spec.turbo.slot]: "turbo.safetensors" } },
          { name: "Turbo without its LoRA: the full steps", input: { prompt: "a", fast: true } as Partial<FlowPicture>, slots: files },
        ]
        : []),
    ],
  });
}
