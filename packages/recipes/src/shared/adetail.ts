import { wanted, type BuildContext, type GraphBuilder, type InputSpec, type Ref } from "@afflatus/core";
import { faceStepsFor } from "./face";
import { DETECTOR_SLOTS, HAND_THRESHOLD, HAND_VALUES } from "./detector";

/**
 * ADetailer inside txt2img (card #272): after the picture (and its hires fix), the faces, hands or people a YOLOv8 detector
 * finds are cropped, redrawn larger by the render's own model and pasted back with a soft edge, in the same job. A quality
 * fix in the pipeline rather than a Face refine the user must remember to run after (the owner's rule). The passes are the
 * Impact Pack's detailer, as Krea 2's Face refine runs it (klein/facePass.ts), each found area kept or dropped by its height
 * first: a face already large has pixels enough of its own, and Krea 2's pod test found the redraw made close-ups worse.
 */

/**
 * The tallest face redrawn, in pixels of the picture as it is drawn (before a hires fix): between the gain and the rest (Krea 2's
 * pod test, klein/facePass.ts). Detail's face and Face refine's FLUX.2 Klein pass both stop there.
 */
export const SMALL_FACE_PX = 150;

/** What each detector redraws: its word, its family slot, how much around it is redrawn and where it starts. */
interface Kind {
  /** The rows' ids: detail<Key>, detail<Key>Prompt, detail<Key>Denoise, detail<Key>Under. */
  key: "Person" | "Hands" | "Face";
  word: string;
  /** One of them: "hand" for hands. */
  one: string;
  slot: string;
  /** A segmentation model: the person is redrawn inside their outline, not the box around them. */
  segm: boolean;
  /** The crop around what is found, in its sizes (the crop factor). */
  crop: number;
  denoise: number;
  /** The tallest one redrawn, in pixels of the picture as drawn (before a hires fix); 0, any size. */
  under: number;
  /** Only this many are redrawn, the largest first; 0, all of them. */
  most: number;
  prompt: string;
  /** Why the size gate is where it is, for the "?". */
  gate: string;
}

/**
 * In the order they run: a person first (the largest area), their hands, their face last, so that a redrawn person's face is
 * gone over after them, as ADetailer's person-then-face setups do it.
 */
const KINDS: Kind[] = [
  {
    // a person whose crop is redrawn at the guide size only gains where they are small: past half a 1024 picture's height
    // the crop is redrawn at its own size or smaller, which only softens it. The two largest only: on a street, every
    // passer-by was redrawn at 1024, 139 s against 7 s for almost nothing seen (the pod test, card #280)
    key: "Person", word: "person", one: "person", slot: "personDetector", segm: true, crop: 1.2, denoise: 0.35, under: 512, most: 2, prompt: "",
    gate: "a person taller than that is redrawn at about their own size, which adds no detail",
  },
  {
    // the owner's hand test (HAND_VALUES): a lighter denoise, a tighter crop, words about hands. Broken fingers are not a
    // matter of size, so hands of any size are gone over; the four largest only, two people's, not a crowd's
    key: "Hands", word: "hands", one: "hand", slot: "handDetector", segm: false, crop: HAND_VALUES.faceCrop, denoise: HAND_VALUES.strength, under: 0, most: 4, prompt: HAND_VALUES.prompt,
    gate: "0 goes over hands of any size: broken fingers are not a matter of size",
  },
  {
    key: "Face", word: "face", one: "face", slot: "faceDetector", segm: false, crop: 3, denoise: 0.4, under: SMALL_FACE_PX, most: 0, prompt: "",
    gate: `Krea 2's pod test (card #217): faces of 120–130 px gained, those of 200–300 px stayed where they were, close-ups came out worse`,
  },
];

/** The crop is redrawn at this size (FACE_INPUTS' guide size: what the models draw best), brought down to the max when larger. */
const GUIDE = 1024;
const MAX = 1280;
/** The found area grown by this much and blended back this softly, in pixels of the drawn size (FACE_INPUTS' defaults). */
const GROW = 10;
const FEATHER = 5;
const THRESHOLD = 0.5;

const capital = (word: string) => word[0]!.toUpperCase() + word.slice(1);
const fileOf = (k: Kind) => DETECTOR_SLOTS.find((s) => s.id === k.slot)!.get.file;

/** The detectors' files, as a machine with all three has them (the checker's variants). */
export const DETECTOR_FILES = Object.fromEntries(KINDS.map((k) => [k.slot, fileOf(k)]));
/** Every Detail row on, a prompt of its own for the face (the checker's variants). */
export const ALL_DETAIL: Partial<AdetailSettings> = { detailFace: true, detailHands: true, detailPerson: true, detailFacePrompt: "green eyes" };

/** What the Detail rows hold, by id. */
export interface AdetailSettings {
  detailPerson: boolean;
  detailPersonPrompt: string;
  detailPersonDenoise: number;
  detailPersonUnder: number;
  detailHands: boolean;
  detailHandsPrompt: string;
  detailHandsDenoise: number;
  detailHandsUnder: number;
  detailFace: boolean;
  detailFacePrompt: string;
  detailFaceDenoise: number;
  detailFaceUnder: number;
}

/**
 * SDXL's face redrawn at 0.4 came out a smoother, younger, other person on the pod test (a 100–120 px face, card #280), where
 * Z-Image's stayed the same woman with cleaner eyes: SDXL's face pass starts lighter. At 0.3 it still narrowed and smoothed
 * the face, and 0.25 nearly as much; 0.2 kept the draft's face shape and jaw and still evened out its eyes (card #281).
 */
export const SDXL_FACE_DENOISE = 0.2;

/**
 * The Detail rows: a switch on the Output shelf for each, its prompt (under the main one) and denoise while it is on, its size
 * gate under All settings. `style`: how the family reads text. `faceNote`: what the family's face pass does beside it (a
 * person reference's face redrawn from their picture). `faceDenoise`: the family's own start for the face's denoise.
 */
export function adetailInputs(style: "tags" | "sentences", faceNote = "", faceDenoise?: number): InputSpec[] {
  return KINDS.slice().reverse().flatMap((k): InputSpec[] => {
    const id = `detail${k.key}`;
    const Word = capital(k.word);
    const gate = k.under ? `only ${k.word === "hands" ? "hands" : `a ${k.word}`} under ${k.under} px tall at the drawn size` : `${k.word} of any size`;
    const most = k.most ? `, and only the ${k.most} largest (a crowd's others are left as drawn)` : "";
    return [
      {
        id, type: "toggle", label: `Detail: ${k.word}`, default: false, section: "out",
        note: `ADetailer inside the render: after the picture and its hires fix, each ${k.one} the YOLOv8 ${k.one} detector finds is cropped, redrawn larger by this model and pasted back with a soft edge, in the same job; ${gate} (the size gate under All settings)${most}. Needs the Impact Pack and its Subpack, and ${fileOf(k)} in models/ultralytics (Settings › Models): without them the picture is made without the pass, and its job says so${k.key === "Face" && faceNote ? `. ${faceNote}` : ""}`,
      },
      {
        id: `${id}Prompt`, type: "prompt", label: `${Word} detail prompt`, style, optional: true, default: k.prompt, showWhen: id,
        note: `what the ${k.word} is redrawn from. Empty: the picture's own prompt, as ADetailer does`,
      },
      { id: `${id}Denoise`, type: "number", label: `${Word} detail denoise`, note: `how much of the ${k.word} is redrawn: 0.3 cleans it, 0.6 can make another one`, min: 0.1, max: 0.8, step: 0.05, default: (k.key === "Face" && faceDenoise) || k.denoise, showWhen: id, section: "out" },
      {
        id: `${id}Under`, type: "number", label: `${Word} detail: only under`, min: 0, max: 2048, step: 16, default: k.under, unit: " px", showWhen: id, advanced: true, section: "out",
        note: `the tallest ${k.word} redrawn, at the size the picture is drawn at (before the hires fix); 0, any size. ${capital(k.gate)}`,
      },
    ];
  });
}

/** The Detail rows switched on, in the order they run. */
const on = (input: Partial<AdetailSettings>, skip: Partial<Record<Kind["key"], boolean>> = {}) =>
  KINDS.filter((k) => (input as Record<string, unknown>)[`detail${k.key}`] && !skip[k.key]);

/** Whether any Detail pass runs. */
export const adetailOn = (input: Partial<AdetailSettings>, skip: Partial<Record<Kind["key"], boolean>> = {}) => on(input, skip).length > 0;

/**
 * The detectors a job with Detail on asks for (Recipe.needsWith): a pod is sent them; a machine of the user's own that has
 * not got one makes the picture without that pass rather than wait for it (`where.own`), as Krea 2's Face refine does.
 */
export function adetailNeeds(input: Partial<AdetailSettings>, slots?: Record<string, string>, where?: { own?: boolean }, skip: Partial<Record<Kind["key"], boolean>> = {}): string[] {
  return on(input, skip).map((k) => k.slot).filter((id) => !where?.own || slots?.[id]);
}

/** The Impact Pack's nodes (and its Subpack's detector): optional, a pass done without when they are missing, the job saying so. */
export const ADETAIL_OPTIONAL = ["UltralyticsDetectorProvider", "BboxDetectorSEGS", "SegmDetectorSEGS", "ImpactSEGSRangeFilter", "ImpactSEGSOrderedFilter", "DetailerForEach"];

/** What the render redraws with: its model and how it samples, and its texts (null: the render's own prompt). */
export interface DetailWith {
  /** Made only once a pass runs (a shift for the crop's size is a node of its own). */
  model: () => Ref;
  clip: Ref;
  vae: Ref;
  cond: (text: string | null, kind: Kind["key"]) => { positive: Ref; negative: Ref };
  /** The form's steps: each crop is redrawn in faceStepsFor of them (every face pass's rule). */
  steps: number;
  /** A model file distilled to a few steps (FlowSpec.distilled): its crops keep the spacing of its steps, as its Face refine does. */
  distilled?: boolean;
  cfg: number;
  sampler: string;
  scheduler: string;
  seed: number;
  /** How much larger the picture is than as it was drawn (a hires fix): the size gate and the edges are read at that size. */
  scale: number;
  /** A pass the family does otherwise (Krea 2's person face, from their picture). */
  skip?: Partial<Record<Kind["key"], boolean>>;
  /** Its VAE decodes an alpha too (FlowSpec.alpha): the detailer is given the colours alone. */
  alpha?: boolean;
}

/** What the passes made: the picture, a pass of the job's progress for each, the detectors loaded, what the job says. */
export interface AdetailPassed {
  image: Ref;
  passes: Array<{ node: string; steps: number; pixels: number; unsampled: string }>;
  loads: string[];
  warnings: string[];
}

/**
 * Each pass's canvas, where the passes before the Detail ones did not say theirs: with one pass at the guide size among them,
 * the forecast prices each at its own size only when all say it (forecast.ts), else every step at the picture's largest.
 */
export const sized = <P extends { pixels?: number }>(passes: P[], pixels: number[]): P[] => passes.map((p, i) => (p.pixels ? p : { ...p, pixels: pixels[Math.min(i, pixels.length - 1)]! }));

/** The picture with the Detail passes switched on gone over it, in their order; as it was with none on. */
export function adetail(g: GraphBuilder, ctx: BuildContext, input: AdetailSettings, image: Ref, w: DetailWith): AdetailPassed {
  const made: AdetailPassed = { image, passes: [], loads: [], warnings: [] };
  const values = input as unknown as Record<string, unknown>;
  const detectors = new Map<string, string>();
  let model: Ref | null = null;
  let alpha: Ref | null = null;
  for (const k of on(input, w.skip)) {
    const id = `detail${k.key}`;
    const file = ctx.slots[k.slot];
    if (!file) {
      made.warnings.push(`Not detailed (${k.word}): no ${k.one} detector on this ComfyUI (${fileOf(k)} in models/ultralytics; Settings › Models has it).`);
      continue;
    }
    // the detailer and the detector are two packs: either missing, the pass is left out and the job says which
    if (!wanted(ctx, { input: id, nodes: ["DetailerForEach"], without: `Detail: ${k.word}` })) continue;
    if (!wanted(ctx, { input: id, nodes: ["UltralyticsDetectorProvider"], without: `Detail: ${k.word}` })) continue;
    if (!made.passes.length) g.phase("detailing");
    // the Impact Pack's detailer takes three channels: Qwen Image 2.1's fourth failed it on a pod ("'Tensor' object has no
    // attribute 'copy'", 2026-11-05). Split once, before the first pass; the next ones take the picture it gives back, and
    // the alpha is joined again after the last (a transparent background came out opaque, card #326)
    if (!made.passes.length && w.alpha) {
      const split = g.add("SplitImageWithAlpha", { image: made.image });
      made.image = [split, 0];
      alpha = [split, 1];
    }
    let detector = detectors.get(file);
    if (!detector) {
      detector = g.add("UltralyticsDetectorProvider", { model_name: file });
      detectors.set(file, detector);
      made.loads.push(`ultralytics/${file}`);
    }
    const crop = { threshold: k.key === "Hands" ? HAND_THRESHOLD : THRESHOLD, dilation: Math.round(GROW * w.scale), crop_factor: k.crop, drop_size: 10, labels: "all" };
    let segs: Ref = k.segm
      ? g.out("SegmDetectorSEGS", { segm_detector: [detector, 1], image: made.image, ...crop })
      : g.out("BboxDetectorSEGS", { bbox_detector: [detector, 0], image: made.image, ...crop });
    const under = Number(values[`${id}Under`] ?? 0);
    // Impact's range filter reads the crop, which is the area's height times the crop factor
    if (under > 0) segs = g.out("ImpactSEGSRangeFilter", { segs, target: "height", mode: true, min_value: 0, max_value: Math.round(under * w.scale * k.crop) });
    // the largest of those left, by their crop's area: each one found is a crop redrawn at the guide size
    if (k.most) segs = g.out("ImpactSEGSOrderedFilter", { segs, target: "area(=w*h)", order: true, take_start: 0, take_count: k.most });
    const text = String(values[`${id}Prompt`] ?? "").trim();
    const c = w.cond(text || null, k.key);
    const denoise = Number(values[`${id}Denoise`] ?? k.denoise);
    const steps = faceStepsFor(w.steps, denoise, Boolean(w.distilled));
    const redraw = (found: Ref, positive: Ref, unsampled: string) => {
      const node = g.add("DetailerForEach", {
        image: made.image, segs: found, model: (model ??= w.model()), clip: w.clip, vae: w.vae, positive, negative: c.negative,
        // the crop redrawn at the guide size (ADetailer's way), as every Face refine does
        guide_size: GUIDE, guide_size_for: false, max_size: MAX, seed: w.seed, steps, cfg: w.cfg, sampler_name: w.sampler, scheduler: w.scheduler,
        denoise, feather: Math.round(FEATHER * w.scale), noise_mask: true, force_inpaint: true, wildcard: "", cycle: 1,
      });
      made.image = [node, 0];
      // a crop is redrawn at the guide size whatever the picture's: what a step samples. One of each is counted (how many
      // there are is known only once found), and one too large, or none, samples nothing, which its job says
      made.passes.push({ node, steps, pixels: GUIDE * GUIDE, unsampled });
    };
    const none = under > 0 ? `Detail: ${k.word} left the picture as drawn: it redraws ${k.word === "hands" ? "hands" : `a ${k.word}`} under ${under} px tall, and found none.` : `Detail: ${k.word} found no ${k.word}: the picture is as drawn.`;
    redraw(segs, c.positive, none);
  }
  // the detailer pastes each crop back at the picture's size: the alpha split off before the first pass fits it still
  if (alpha) made.image = g.out("JoinImageWithAlpha", { image: made.image, alpha });
  return made;
}
