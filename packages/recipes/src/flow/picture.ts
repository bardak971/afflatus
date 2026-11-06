import { defineRecipe, GraphBuilder, regionsOf, roundTo, type Recipe, type Ref, type RegionValue, type SizeValue } from "@afflatus/core";
import { dropsFor, pictureForm } from "../shared/pictureForm";
import { hiresInputs, hiresPass, type HiresPass } from "../shared/hires";
import { asDaemon, DAEMON_DETAIL_INPUTS, DETAIL_INPUTS, DETAIL_OPTIONAL, detailNodes, fullPassNodes, withoutDaemon, type DetailSettings } from "../shared/detail";
import { tileNodes, tilesOf, inTiles, type TileSettings } from "../shared/tiles";
import { ADETAIL_OPTIONAL, adetailInputs, adetailNeeds, ALL_DETAIL, DETECTOR_FILES, type AdetailSettings } from "../shared/adetail";
import { hiresFix, pictureOut, type PictureSampler } from "../shared/passes";
import { applyGuide, FOLLOW_MAP, guideInputs, guideNeeds, guideNodes, type GuideSettings } from "../shared/guide";
import { REDUX_NODES, reduxInputs, reduxNeeds, withRedux, type ReferenceSettings } from "../shared/references";
import { MOSS_LAYOUT_NODES, mossLayout, mossLayoutText, regionsInput, withRegionLoras } from "../shared/regions";
import type { FlowBase, FlowKit, FlowSpec } from "./kit";

export interface FlowPicture extends FlowBase, HiresPass, DetailSettings, TileSettings, AdetailSettings, GuideSettings, ReferenceSettings {
  prompt: string;
  size: SizeValue;
  regions?: RegionValue[];
  hires: boolean;
  hiresScale: number;
  hiresUpscaler: string;
  hiresDenoise: number;
  hiresSteps: number;
}

/** txt2img, with hires fix: an upscale, then a second pass over the larger picture (in tiles past about twice the model's size each side). */
export function flowPicture(spec: FlowSpec, kit: FlowKit): Recipe<FlowPicture> {
  const { inputs, loadNodes, SOMETIMES, load, shifted, cond, sample, tuned, noiseWords, distilledFile } = kit;
  const files = spec.files;
  /** The area the model draws at, and the size a hires pass enlarges to. */
  const AREA = spec.megapixels * 1024 * 1024;
  const grid = spec.grid ?? 16;
  const largeOf = (input: FlowPicture) => ({ width: roundTo(roundTo(input.size.width, grid) * input.hiresScale, grid), height: roundTo(roundTo(input.size.height, grid) * input.hiresScale, grid) });
  const emptyLatent = spec.latent ?? "EmptySD3LatentImage";
  // the detail boost as it samples: Lying sigma alone on a model the built-in sharpen breaks (Qwen Image 2.1's)
  const detailOf = (input: FlowPicture): FlowPicture => (spec.detail === "daemon" ? asDaemon(input) : input);
  // the hires pass's "?": the real noise its default starts from, on the form's first shape at its default scale (card #146)
  const shape = spec.shapes.find((s) => s.id === "tall") ?? spec.shapes[0]!;
  const hiresDefault = { scale: spec.hires?.scale ?? 1.25, denoise: spec.hires?.denoise ?? 0.4, steps: spec.hires?.steps ?? Math.max(4, Math.round(spec.sampling.steps / 2)) };
  const hiresAt = { width: roundTo(shape.width * hiresDefault.scale, grid), height: roundTo(shape.height * hiresDefault.scale, grid) };
  const hiresNoise = noiseWords(hiresDefault.denoise, hiresDefault.steps, [{ size: hiresAt, where: `at ${hiresAt.width}×${hiresAt.height}` }]);
  // the regions written as one layout (MOSS-Image): every box in one text, so their LoRAs go on the whole picture
  const layout = spec.layout;
  const regionsIn = (input: FlowPicture) => (layout ? regionsOf(input.regions) : []);
  const withRegions = (input: FlowPicture): FlowPicture => (layout ? { ...input, loras: withRegionLoras(input.loras, regionsIn(input)) } : input);
  const sizeOf = (input: FlowPicture) => ({ width: roundTo(input.size.width, grid), height: roundTo(input.size.height, grid) });
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
      ...(layout ? [regionsInput({ lora: "global", kinds: true, how: layout.how })] : []),
      ...adetailInputs("sentences"),
      ...(spec.detail === "daemon" ? DAEMON_DETAIL_INPUTS : DETAIL_INPUTS),
      // the seed among them, which pictureForm puts last
      ...inputs,
      ...hiresInputs({ scale: hiresDefault.scale, denoise: hiresDefault.denoise, denoiseNote: ["how much the second pass may redraw", hiresNoise].filter(Boolean).join("; "), steps: hiresDefault.steps }),
    ],
    ...(spec.presets ? { presets: spec.presets } : {}),
    ...(layout ? { layoutOf: (input: FlowPicture) => (regionsIn(input).length ? mossLayout(input.prompt, regionsIn(input), sizeOf(input)) : null) } : {}),
    nodes: (asked) => {
      // the regions' LoRAs are on the model as the form's are (MOSS-Image's layout puts them on the whole picture)
      const input = withRegions(asked);
      return [
      ...loadNodes(input).filter((n) => n !== "KSampler"), emptyLatent, ...detailNodes(detailOf(input)),
      ...fullPassNodes(detailOf(input), spec.turbo && input.fast ? input.turboSteps ?? input.steps : input.steps), ...(input.hires ? ["KSampler"] : []),
      ...(spec.references && input.references.length ? REDUX_NODES : []),
      ...(spec.guide ? guideNodes(input, spec.guide) : []),
      ...(input.hires ? ["UpscaleModelLoader", "ImageUpscaleWithModel", "ImageScale", "VAEEncode"] : []),
      ...tileNodes(input.hires && inTiles(input, largeOf(input), AREA)),
      ...(regionsIn(input).length ? [...MOSS_LAYOUT_NODES, "SkipLayerGuidanceDiTSimple"] : []),
      ];
    },
    optionalNodes: [...SOMETIMES, ...DETAIL_OPTIONAL, ...ADETAIL_OPTIONAL, ...(spec.alpha ? ["SplitImageWithAlpha", "JoinImageWithAlpha"] : [])],
    build(asked, ctx) {
      const g = new GraphBuilder();
      const input = withRegions(asked);
      const regions = regionsIn(input);
      const loaded = load(g, input, ctx);
      // with regions, the skip-layer guidance the layout template samples with (its negative side skips a layer)
      const k = regions.length && layout ? { ...loaded, model: g.out("SkipLayerGuidanceDiTSimple", { model: loaded.model, double_layers: "", single_layers: layout.guidance.single, start_percent: 0, end_percent: layout.guidance.end }) } : loaded;
      const size = sizeOf(input);
      const loads = [...k.loads];
      // the text as read, with the reference images' Redux over it (its files counted once)
      const read = (text: string | Ref) => {
        const c = cond(g, k, input, text);
        if (!spec.references) return c;
        const r = withRedux(g, ctx, c.positive, input);
        for (const l of r.loads) if (!loads.includes(l)) loads.push(l);
        return { ...c, positive: r.positive };
      };
      const c = read(regions.length ? mossLayoutText(g, input.prompt, regions, size) : input.prompt);
      // what a part of the picture is redrawn from (a hires tile, a Detail crop): the prompt alone, on the model as without
      // regions. The layout says where every box lies in the whole frame, which a tile or a 1024² face crop is not: read
      // there, each crop was asked to lay out all the boxes again (card #296). Read once, by the first pass that needs it
      let plain: typeof c | null = null;
      const part = { model: regions.length ? loaded.model : k.model, c: () => (regions.length ? (plain ??= read(input.prompt)) : c) };
      // the guide picture holds the shapes of the first pass, drawn whole at its size; the hires pass and the Detail rows
      // redraw from the text alone, as SDXL's tiles do
      const guided = spec.guide ? applyGuide(g, ctx, spec.guide, { model: k.model, ...c }, k.vae, size, input) : { model: k.model, ...c, loads: [] };
      loads.push(...guided.loads);
      const empty = g.out(emptyLatent, { width: size.width, height: size.height, batch_size: 1 });
      g.phase("sampling");
      const detail = { input: detailOf(input), ctx };
      const first = sample(g, k, input, shifted(g, guided.model, input, size), guided, empty, ctx.seed, {}, detail);
      // a model run for a few steps (Turbo, or a file made for it) redraws in as many as it was made for at most: the full
      // model's half (25 steps for Qwen Image) is not what it was distilled for, and takes six times as long
      const pass = { steps: k.turbo ? Math.min(input.hiresSteps, k.steps) : input.hiresSteps, denoise: input.hiresDenoise, ...hiresPass(input) };
      const sampler: PictureSampler = {
        vae: k.vae, area: AREA,
        // the whole frame again, larger: its layout said at that size, as the boxes' edges are in its pixels
        whole: (scaled, large) => {
          const whole = regions.length ? read(mossLayoutText(g, input.prompt, regions, large)) : c;
          return sample(g, k, input, shifted(g, k.model, input, large), whole, g.out("VAEEncode", { pixels: scaled, vae: k.vae }), ctx.seed, pass, detail);
        },
        // each tile is a picture the model's size to it: the shift for that size
        tiles: (large) => {
          const { tile } = tilesOf(large, input);
          const tiled = shifted(g, part.model, input, { width: tile, height: tile });
          return (l) => sample(g, k, input, tiled, part.c(), l, ctx.seed, pass, detail);
        },
      };
      const large = largeOf(input);
      const hired = hiresFix(g, ctx, input, sampler, first, size, large);
      loads.push(...hired.loads);
      // the Detail rows: faces, hands, people redrawn by the same model, each crop at the size it draws best
      return pictureOut(g, ctx, input, sampler, hired, { size, large }, {
        model: () => shifted(g, part.model, input, { width: 1024, height: 1024 }), clip: k.clip, vae: k.vae, cond: (text) => (text ? cond(g, k, input, text) : part.c()),
        steps: k.steps, distilled: distilledFile(input, ctx.slots), cfg: k.cfg, sampler: input.sampler, scheduler: input.scheduler, seed: ctx.seed,
        alpha: spec.alpha,
      }, loads);
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
      // (Lying sigma alone is not in the graph checker's catalog: a family that has only it is checked without the boost)
      { name: spec.detail === "daemon" ? "hires fix 3× in tiles" : "detail boost, hires fix 3× in tiles", input: { prompt: "a", detail: spec.detail !== "daemon", hires: true, hiresScale: 3, hiresUpscaler: "u.pth" } as Partial<FlowPicture>, slots: files, has: withoutDaemon },
      { name: "a GGUF model, in fp8 asked for (no effect on it)", input: { prompt: "a", model: `${spec.family}-Q4_K_M.gguf`, precision: "fp8_e4m3fn" } as Partial<FlowPicture>, slots: files },
      { name: "a fine-tune with a shift, a LoRA, a negative prompt and hires fix", input: { prompt: "a", ...tuned, hires: true, hiresUpscaler: "u.pth", size: { width: 1152, height: 1536 } } as Partial<FlowPicture>, slots: files },
      ...(spec.extras ?? []).map((e) => ({ name: `${e.toggle.label} with its LoRA, beside one of the user's`, input: { prompt: "a", [e.toggle.id]: true, loras: [{ file: "l.safetensors", weight: 0.8 }] } as Partial<FlowPicture>, slots: { ...files, [e.row.file.slot]: `${e.toggle.id}.safetensors` } })),
      ...(layout
        ? [
          { name: "regions: two objects and a text", input: { prompt: "a", regions: [{ id: "a", box: { x: 0, y: 0.3, w: 0.5, h: 0.7 }, prompt: "a red fox" }, { id: "b", box: { x: 0.5, y: 0.3, w: 0.5, h: 0.7 }, prompt: "a grey owl" }, { id: "c", box: { x: 0.1, y: 0, w: 0.8, h: 0.25 }, prompt: "big cream serif capitals", kind: "text", text: "FOREST" }] } as Partial<FlowPicture>, slots: files },
          {
            name: "regions: a cast person with their LoRA, a region LoRA, Detail: face, hires fix",
            input: {
              prompt: "a", detailFace: true, hires: true, hiresUpscaler: "u.pth",
              regions: [{ id: "a", box: { x: 0, y: 0, w: 0.5, h: 1 }, prompt: "a woman in a red coat", cast: "p1", castLora: { file: "mira.safetensors", weight: 0.8 } }, { id: "b", box: { x: 0.5, y: 0, w: 0.5, h: 1 }, prompt: "a man in a blue coat", lora: { file: "coat.safetensors", weight: 0.6 } }],
            } as Partial<FlowPicture>,
            slots: { ...files, ...DETECTOR_FILES },
          },
        ]
        : []),
      ...(spec.turbo
        ? [
          { name: "Turbo with its LoRA", input: { prompt: "a", fast: true } as Partial<FlowPicture>, slots: { ...files, [spec.turbo.slot]: "turbo.safetensors" } },
          { name: "Turbo without its LoRA: the full steps", input: { prompt: "a", fast: true } as Partial<FlowPicture>, slots: files },
        ]
        : []),
    ],
  }), dropsFor("txt2img", spec.drops));
}
