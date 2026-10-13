import { z } from "zod";
import { endsIn, MODEL_EXTS } from "./modelFiles";

/**
 * The closed vocabulary of controls. A recipe declares its inputs as a list of these; the composer
 * renders them and the server validates against them. Adding a recipe never adds a control type.
 */

/** Show this input only when another one is on (a toggle) or has one of these values. */
type ShowWhen = string | { input: string; in: unknown[] };

interface Base {
  id: string;
  label: string;
  /** One short line under or beside the control. */
  note?: string;
  showWhen?: ShowWhen;
  /** Folded into "All settings" rather than shown up front. */
  advanced?: boolean;
  /**
   * What suits this input depends on the model file in use (sampler, steps, CFG, quality tags…). The
   * user can save a value per model; it then replaces the default whenever that model is picked.
   */
  perModel?: boolean;
  /**
   * Where the form shows it: "out" with what comes out (the size, the length); among the settings,
   * "speed" (steps, CFG, sampling), "file" (frames a second, saving) or "rare". Left out: the form
   * reads it from the input's name.
   */
  section?: "out" | "speed" | "file" | "rare";
  /** A chapter of the recipe's own (an imported workflow's sections): shown there, in the recipe's order, instead of by kind. */
  chapter?: string;
}

interface PromptInput extends Base {
  type: "prompt";
  /** How this family reads text: comma-separated tags, or plain sentences. */
  style: "tags" | "sentences";
  placeholder?: string;
  default?: string;
  optional?: boolean;
  /**
   * "subject": this text says how the people in it look. A recipe that follows reference pictures has
   * such a place; the words of the cast go there instead of in front of the main text.
   */
  holds?: "subject";
  /**
   * The default is somebody else's text (the prompt an imported workflow was saved with): a form starts
   * empty, shows it greyed as an example, and asks for a prompt before anything is made.
   */
  example?: boolean;
  /**
   * False when the model does not read `(words:1.2)` as a weight (a text that goes to a model of its own
   * kind, not through ComfyUI's text encoders): the form then offers no key to write one.
   */
  weights?: boolean;
}
interface ModelInput extends Base {
  type: "model";
  /** ComfyUI model folder the file is picked from ("checkpoints", "diffusion_models", …). */
  folder: string;
  /**
   * The family's slot this picks a file for (its usual model, found by name): the form starts on that
   * file, and an input left out means that file. Without it the input is required.
   */
  slot?: string;
  /**
   * Regex sources for the names of the files made for this recipe, when the folder also holds models of
   * other kinds: those are listed first, apart from the rest. Nothing is hidden: a fine-tune can be named anything.
   */
  match?: string[];
  /** The file to start on, when there is no slot: an imported workflow's own. Left out, it means this file. */
  default?: string;
}
interface LorasInput extends Base {
  type: "loras";
  max: number;
  /** The LoRAs the list starts with (the ones an imported workflow came with). */
  default?: LoraValue[];
}
interface SizeInput extends Base {
  type: "size";
  shapes: Array<{ id: string; label: string; width: number; height: number }>;
  default: string;
  /** Both edges are multiples of this. */
  grid: number;
  min: number;
  max: number;
  /**
   * The recipe only takes the proportions from it, and another input says how large (H3's "size of the
   * short side"). The form then offers shapes, not pixels to type.
   */
  ratioOnly?: boolean;
  /** With `ratioOnly`: the number input that gives the short side, and the most pixels the frame may have, so the form can say what frame comes out (see frameOf). */
  short?: string;
  maxPixels?: number;
  /** Inputs that decide the shape when they hold something (a start image, a clip joined): the shape then does nothing, and says so. */
  decidedBy?: string[];
  /** A pass that enlarges what comes out: the toggle that turns it on and the number it multiplies by, so the form can say the final frame. */
  scaledBy?: { on: string; by: string };
}
interface NumberInput extends Base {
  type: "number";
  min: number;
  max: number;
  step: number;
  default: number;
  unit?: string;
  /** Values offered as one click under the slider (the usual resolutions), the number staying typeable. */
  picks?: number[];
}
interface ToggleInput extends Base {
  type: "toggle";
  default: boolean;
  /** When the switch is a choice between two named things rather than on and off. */
  captions?: { on: string; off: string };
  /**
   * Other settings that start elsewhere while the switch is on, as `whenChosen` does for a choice: Turbo moves the
   * shift to what the turbo LoRA was trained at. A setting changed on purpose keeps its value.
   */
  whenOn?: Record<string, unknown>;
}
export interface ChoiceInput extends Base {
  type: "choice";
  /** Fixed options, or the options a ComfyUI node offers for one of its inputs (read from the node catalog). */
  options: string[] | { node: string; input: string };
  /** Options put in front of the ones read from ComfyUI (e.g. "latent" before the upscale model files). */
  extra?: string[];
  /** Values an older form saved, read as the option that replaced them (never shown): { Latent: "Auto" }. */
  renamed?: Record<string, string>;
  default: string;
  /**
   * For options read from ComfyUI, when the default is not among them: regex sources tried in order,
   * the first option one matches is the starting value (else the first option there is).
   */
  prefer?: string[];
  /**
   * Other settings that start elsewhere while certain options are chosen: regex sources tried on the value, case
   * ignored; the first that matches gives the starting values of those settings (by input id). Only the starting
   * values move: a setting changed on purpose keeps its value, and choosing another option brings the usual ones
   * back. A face detailer's detection model switched to a hand detector starts its denoise, crop and prompt on hands.
   */
  whenChosen?: Array<{ match: string; values: Record<string, unknown> }>;
}
interface SeedInput extends Base {
  type: "seed";
}
interface ImageInput extends Base {
  type: "image";
  /** "mid": a picture the clip passes through, at the moment the number input named by `at` says. "guide": one the result follows the shapes of (a ControlNet's), not one it is made from. */
  role: "source" | "start" | "end" | "mid" | "mask" | "guide";
  optional?: boolean;
  /** Of a "mid" picture: the id of the number input that holds its moment, in seconds from the start of the clip. */
  at?: string;
  /** Of a "mask": the id of the picture input it is painted over. White = the part to redo, the same size as that picture. */
  of?: string;
  /** Uploaded to ComfyUI's input folder, not its temp folder: for a node that reads only from there. */
  folder?: "input";
}

/**
 * A video from the library that the new clip joins onto. The recipe is not handed the whole video: it gets
 * a few frames at `fps`, with their sound. For "previous" they are the last ones before the chosen moment
 * (the new clip carries on from there); for "next" the first ones from it (the new clip arrives there).
 */
interface ClipInput extends Base {
  type: "clip";
  /** "source": a video the recipe works on (an upscale, a video-to-video), taken whole: no moment, no join. */
  role: "previous" | "next" | "source";
  /** How many frames the recipe takes, best first: it is handed the first count the video is long enough for. */
  frames: number[];
  /** An input (a choice of numbers) that says how many frames are wanted first; `frames` below it are the fallbacks for a short clip. */
  framesFrom?: string;
  fps: number;
  optional?: boolean;
  /**
   * The recipe takes the whole video, as a file, not a few frames of it: an imported workflow whose own
   * loader node reads the video (`frames` and `fps` are then not used). A moment in `ClipValue` cuts it:
   * "previous" is handed the video up to it, "next" the video from it.
   */
  whole?: boolean;
}

/** What a reference picture shows. */
export const REFERENCE_ROLES = ["person", "place", "clothing", "object", "style"] as const;
export type ReferenceRole = (typeof REFERENCE_ROLES)[number];

/**
 * Several pictures the result has to follow without them being frames of it: who is in it, where it
 * is, what is worn. Each says what it shows; the recipe says which of those it can use.
 */
interface ReferencesInput extends Base {
  type: "references";
  max: number;
  roles: ReferenceRole[];
  /** They are videos from the library, not pictures: a short clip of each is what the model is given. */
  media?: "video";
}
export interface ReferenceValue {
  /** The picture's id in the library. */
  asset: string;
  role: ReferenceRole;
}

/** A sound from the library (or a video that has sound): a voice to speak with, a sound to follow. */
interface AudioInput extends Base {
  type: "audio";
  role: "voice" | "sound";
  optional?: boolean;
  /**
   * Only a part of the sound is used: the ids of the two number inputs that say where it starts and how
   * long it is, in seconds. The recipe is handed that part alone. The form shows them with the sound.
   * `even`: the id of a toggle that evens out the part's loudness as it is cut (a quiet take guides a model weakly).
   */
  window?: { start: string; seconds: string; even?: string };
}

export type InputSpec =
  | PromptInput | ModelInput | LorasInput | SizeInput | NumberInput | ToggleInput | ChoiceInput | SeedInput | ImageInput | ClipInput | ReferencesInput | AudioInput;

export interface ClipValue {
  /** The video's id in the library. */
  asset: string;
  /** The moment in it, in milliseconds. Left out: its end for "previous", its start for "next". */
  at?: number;
}

export interface LoraValue {
  file: string;
  weight: number;
}
export interface SizeValue {
  width: number;
  height: number;
}
/** -1 = draw a new seed for every render. */
export const RANDOM_SEED = -1;

const multipleOf = (n: number, grid: number) => Math.round(n / grid) * grid;

function schemaOf(spec: InputSpec): z.ZodType {
  switch (spec.type) {
    case "prompt": {
      const s = z.string().max(20_000);
      return spec.optional ? s.default(spec.default ?? "") : spec.default !== undefined ? s.default(spec.default) : s.min(1);
    }
    case "model":
      // with a slot behind it, leaving it out means the slot's file
      return spec.slot ? z.string().min(1).optional() : spec.default ? z.string().min(1).default(spec.default) : z.string().min(1);
    case "loras":
      return z
        .array(z.object({ file: z.string().min(1), weight: z.number().min(-4).max(4) }))
        .max(spec.max)
        .default(spec.default ?? []);
    case "size": {
      const shape = spec.shapes.find((s) => s.id === spec.default) ?? spec.shapes[0]!;
      const edge = z.number().min(spec.min).max(spec.max).transform((n) => multipleOf(n, spec.grid));
      return z.object({ width: edge, height: edge }).default({ width: shape.width, height: shape.height });
    }
    case "number": {
      // a whole step from a whole start (steps, frames, a resolution): what takes it is an INT, which refuses 7.5
      const whole = [spec.step, spec.min, spec.default].every(Number.isInteger);
      return (whole ? z.number().int() : z.number()).min(spec.min).max(spec.max).default(spec.default);
    }
    case "toggle":
      return z.boolean().default(spec.default);
    case "choice":
      // options read from ComfyUI are checked against the node catalog, not here
      return Array.isArray(spec.options)
        ? z.preprocess((v) => { const k = typeof v === "number" || typeof v === "boolean" ? String(v) : v; return typeof k === "string" && spec.renamed?.[k] ? spec.renamed[k] : v; }, z.enum([...(spec.extra ?? []), ...spec.options] as [string, ...string[]]).default(spec.default))
        : z.string().min(1).default(spec.default);
    case "seed":
      return z.number().int().min(RANDOM_SEED).max(2 ** 32 - 1).default(RANDOM_SEED);
    case "image":
      return spec.optional ? z.string().min(1).optional() : z.string().min(1);
    case "clip": {
      const clip = z.strictObject({ asset: z.string().min(1), at: z.number().min(0).optional() });
      return spec.optional ? clip.optional() : clip;
    }
    case "references":
      return z.array(z.strictObject({ asset: z.string().min(1), role: z.enum(spec.roles as [ReferenceRole, ...ReferenceRole[]]) })).max(spec.max).default([]);
    case "audio":
      return spec.optional ? z.string().min(1).optional() : z.string().min(1);
  }
}

/** The zod object a recipe's raw inputs are parsed with: defaults filled in, unknown keys rejected. */
export function schemaFor(specs: InputSpec[]) {
  return z.strictObject(Object.fromEntries(specs.map((s) => [s.id, schemaOf(s)])));
}

const MODEL_OR_MEDIA = endsIn([...MODEL_EXTS, "png", "jpe?g", "webp", "mp4", "wav", "mp3"]);
/** Whether a list of choices is a list of files (models, pictures, sounds), not of settings. An empty one may be either. */
export const looksLikeFiles = (choices: string[]) =>
  !choices.length || choices.some((c) => MODEL_OR_MEDIA.test(c));

/**
 * The value a choice starts with, given what ComfyUI offers for it: its default when that is there, else the best
 * match. A file this ComfyUI lacks is never stood in for by some other file unless the input says which ones will
 * do (prefer): it stays, and is said to be missing (an imported workflow's VAE swapped for another model's breaks
 * the render, or quietly changes it: an x2 upscaler for an x1.5 one).
 */
export function pickChoice(spec: ChoiceInput, offered: string[] | undefined): string {
  if (Array.isArray(spec.options) || !offered?.length || offered.includes(spec.default)) return spec.default;
  // the same file kept in another folder ("MiniMaxH3/x.safetensors" saved, "x.safetensors" here): that one, before
  // any other (the first of the list would be some other model's file: an LTX audio VAE for H3's)
  const name = (path: string) => path.split(/[\\/]/).pop()!.toLowerCase();
  const same = offered.find((o) => name(o) === name(spec.default));
  if (same) return same;
  for (const source of spec.prefer ?? []) {
    const hit = offered.find((o) => new RegExp(source, "i").test(o));
    if (hit) return hit;
  }
  // a list of files is known by its files, or by the default being one (a VAE list with only "pixel_space" on it)
  return looksLikeFiles([spec.default, ...offered]) && !spec.prefer ? spec.default : offered[0]!;
}

/**
 * The starting values the choices made move (`whenChosen`, a switch's `whenOn`), for the inputs of the list only: of
 * each choice, the first entry whose pattern matches the value it holds.
 */
export function chosenDefaults(specs: readonly InputSpec[], values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of specs) {
    const value = values[spec.id];
    if (spec.type === "toggle" && spec.whenOn && value === true) Object.assign(out, spec.whenOn);
    if (spec.type !== "choice" || !spec.whenChosen || typeof value !== "string") continue;
    const hit = spec.whenChosen.find((w) => new RegExp(w.match, "i").test(value));
    if (hit) Object.assign(out, hit.values);
  }
  const has = new Set(specs.map((s) => s.id));
  return Object.fromEntries(Object.entries(out).filter(([id]) => has.has(id)));
}

/**
 * Whether an input is in play, given the values of the others. With the recipe's inputs, the input it depends on must
 * be in play too: the edge thresholds follow "Follow", which itself shows only with a guide picture, and its default
 * ("Edges") must not bring them on screen without one.
 */
export function isShown(spec: InputSpec, values: Record<string, unknown>, specs?: readonly InputSpec[], seen: ReadonlySet<string> = new Set()): boolean {
  const w = spec.showWhen;
  if (!w) return true;
  // a list that is empty is "off", like a switch
  const on = (v: unknown) => (Array.isArray(v) ? v.length > 0 : Boolean(v));
  const id = typeof w === "string" ? w : w.input;
  if (!(typeof w === "string" ? on(values[id]) : w.in.includes(values[id]))) return false;
  const parent = specs?.find((s) => s.id === id);
  // a loop in a recipe's conditions stops here rather than recursing for ever
  if (!parent || seen.has(parent.id)) return true;
  return isShown(parent, values, specs, new Set([...seen, spec.id]));
}

/** The input that says how long a video is, in seconds, when a recipe has one. */
export function secondsInput(specs: InputSpec[]): NumberInput | undefined {
  return specs.find((i): i is NumberInput => i.type === "number" && (i.id === "seconds" || /^(length|seconds|duration)$/i.test(i.label)));
}

/** How many seconds of video these values ask for; null when the recipe has no length to set. */
export function secondsOf(specs: InputSpec[], values: Record<string, unknown>): number | null {
  const spec = secondsInput(specs);
  if (!spec) return null;
  const n = Number(values[spec.id] ?? spec.default);
  return Number.isFinite(n) && n > 0 ? n : null;
}
