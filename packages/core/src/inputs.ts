import { z } from "zod";

/**
 * The closed vocabulary of controls. A recipe declares its inputs as a list of these; the composer
 * renders them and the server validates against them. Adding a recipe never adds a control type.
 */

/** Show this input only when another one is on (a toggle) or has one of these values. */
export type ShowWhen = string | { input: string; in: unknown[] };

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
}

export interface PromptInput extends Base {
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
export interface ModelInput extends Base {
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
}
export interface LorasInput extends Base {
  type: "loras";
  max: number;
  /** The LoRAs the list starts with (the ones an imported workflow came with). */
  default?: LoraValue[];
}
export interface SizeInput extends Base {
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
}
export interface NumberInput extends Base {
  type: "number";
  min: number;
  max: number;
  step: number;
  default: number;
  unit?: string;
}
export interface ToggleInput extends Base {
  type: "toggle";
  default: boolean;
  /** When the switch is a choice between two named things rather than on and off. */
  captions?: { on: string; off: string };
}
export interface ChoiceInput extends Base {
  type: "choice";
  /** Fixed options, or the options a ComfyUI node offers for one of its inputs (read from the node catalog). */
  options: string[] | { node: string; input: string };
  /** Options put in front of the ones read from ComfyUI (e.g. "latent" before the upscale model files). */
  extra?: string[];
  default: string;
  /**
   * For options read from ComfyUI, when the default is not among them: regex sources tried in order,
   * the first option one matches is the starting value (else the first option there is).
   */
  prefer?: string[];
}
export interface SeedInput extends Base {
  type: "seed";
}
export interface ImageInput extends Base {
  type: "image";
  /** "mid": a picture the clip passes through, at the moment the number input named by `at` says. */
  role: "source" | "start" | "end" | "mid" | "mask";
  optional?: boolean;
  /** Of a "mid" picture: the id of the number input that holds its moment, in seconds from the start of the clip. */
  at?: string;
  /** Of a "mask": the id of the picture input it is painted over. White = the part to redo, the same size as that picture. */
  of?: string;
}

/**
 * A video from the library that the new clip joins onto. The recipe is not handed the whole video: it gets
 * a few frames at `fps`, with their sound. For "previous" they are the last ones before the chosen moment
 * (the new clip carries on from there); for "next" the first ones from it (the new clip arrives there).
 */
export interface ClipInput extends Base {
  type: "clip";
  role: "previous" | "next";
  /** How many frames the recipe takes, best first: it is handed the first count the video is long enough for. */
  frames: number[];
  fps: number;
  optional?: boolean;
}

/** What a reference picture shows. */
export const REFERENCE_ROLES = ["person", "place", "clothing", "object", "style"] as const;
export type ReferenceRole = (typeof REFERENCE_ROLES)[number];

/**
 * Several pictures the result has to follow without them being frames of it: who is in it, where it
 * is, what is worn. Each says what it shows; the recipe says which of those it can use.
 */
export interface ReferencesInput extends Base {
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
export interface AudioInput extends Base {
  type: "audio";
  role: "voice" | "sound";
  optional?: boolean;
  /**
   * Only a part of the sound is used: the ids of the two number inputs that say where it starts and how
   * long it is, in seconds. The recipe is handed that part alone. The form shows them with the sound.
   */
  window?: { start: string; seconds: string };
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
      return spec.slot ? z.string().min(1).optional() : z.string().min(1);
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
    case "number":
      return z.number().min(spec.min).max(spec.max).default(spec.default);
    case "toggle":
      return z.boolean().default(spec.default);
    case "choice":
      // options read from ComfyUI are checked against the node catalog, not here
      return Array.isArray(spec.options)
        ? z.enum([...(spec.extra ?? []), ...spec.options] as [string, ...string[]]).default(spec.default)
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

/** The value a choice starts with, given what ComfyUI offers for it: its default when that is there, else the best match. */
export function pickChoice(spec: ChoiceInput, offered: string[] | undefined): string {
  if (Array.isArray(spec.options) || !offered?.length || offered.includes(spec.default)) return spec.default;
  for (const source of spec.prefer ?? []) {
    const hit = offered.find((o) => new RegExp(source, "i").test(o));
    if (hit) return hit;
  }
  return offered[0]!;
}

/** Whether an input is in play, given the values of the others. */
export function isShown(spec: InputSpec, values: Record<string, unknown>): boolean {
  const w = spec.showWhen;
  if (!w) return true;
  // a list that is empty is "off", like a switch
  const on = (v: unknown) => (Array.isArray(v) ? v.length > 0 : Boolean(v));
  return typeof w === "string" ? on(values[w]) : w.in.includes(values[w.input]);
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
