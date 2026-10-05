import type { BuiltGraph } from "./graph";
import { schemaFor, type InputSpec } from "./inputs";
import { folderOfFileInput } from "./models";

/** A file a family needs, wherever the user keeps it: found by pattern, overridable on the setup page. */
export interface ModelSlot {
  id: string;
  label: string;
  /** ComfyUI model folder ("diffusion_models", "text_encoders", "vae", …). */
  folder: string;
  /** Regex sources tried in order against the folder's files (case-insensitive). */
  detect: string[];
  /** Shown when nothing matches: what to download and where to put it. */
  hint: string;
  optional?: boolean;
  /**
   * Another slot of the family whose file makes this one unneeded: a model that comes either as one
   * file or as several has a slot for each way, and is ready with either.
   */
  unless?: string;
  /** Where its usual file can be had, when that is known: the name to save it under and its address. */
  get?: { file: string; url: string };
}

/** One model architecture: what its files are and how its prompts are written. */
export interface Family {
  id: string;
  name: string;
  summary: string;
  promptStyle: "tags" | "sentences" | "sections";
  /** Files every recipe of this family loads (a model the user picks per generation is an input instead). */
  slots: ModelSlot[];
  /** Regex sources matched against a LoRA's architecture metadata and path: which LoRAs fit this family. */
  loraMatch: string[];
  /** How this family's prompts are written, in words for the prompt designer's language model. */
  guide?: string;
}

/** What a video recipe can do for a timeline. The timeline never asks which model it is. */
export interface VideoTraits {
  startFrame: boolean;
  endFrame: boolean;
  /** Mid-clip pictures (a strong hint, not a lock). */
  midFrames: boolean;
  /** "clip": from the previous clip's last frames (motion carries over); "frame": from its last frame only. */
  continues: "clip" | "frame" | false;
  /** A redo can be made to end where the next clip begins. */
  endAnchor: boolean;
  sound: boolean;
  fps: number;
  /** Valid frame counts: frames = step * k + offset. */
  frameGrid: { step: number; offset: number };
}

/** What is known about a picture or a clip that was handed to a recipe. */
export interface MediaFacts {
  width: number;
  height: number;
  /** Of a clip: how many frames were handed over, at what speed, and whether they come with sound. */
  frames?: number;
  fps?: number;
  hasSound?: boolean;
  /** Of a clip that is continued or landed on: how many frames its saved latent holds, when it has one (uploaded as "<input>.latent"). */
  latentFrames?: number;
  /** Of a clip landed on: the frame of its latent where its playing part starts (its own overlap with the clip it extended comes before). */
  latentAt?: number;
  /** Of a mask: the part that was painted, with room around it, in pixels of the picture it is painted over. */
  box?: { x: number; y: number; width: number; height: number };
}

/** What a recipe gets besides the user's inputs. Everything in it was resolved by the server beforehand. */
export interface BuildContext {
  /** The seed to use; never RANDOM_SEED. */
  seed: number;
  /** Family slot id → the file ComfyUI knows. */
  slots: Record<string, string>;
  /** Image / video / audio input id → the name it was uploaded to ComfyUI under. */
  uploads: Record<string, string>;
  /** Image / clip input id → what was uploaded for it. */
  media: Record<string, MediaFacts>;
  /** The frame the result has to fit (a timeline's). When given, it wins over the shape the recipe would pick. */
  canvas?: { width: number; height: number };
  /** Whether this ComfyUI has a node class (for optional speed-ups that switch off when missing). */
  has(nodeClass: string): boolean;
}

export interface Variant<In> {
  name: string;
  /** Merged over the recipe's defaults. */
  input: Partial<In>;
  slots?: Record<string, string>;
  uploads?: Record<string, string>;
  media?: Record<string, MediaFacts>;
  canvas?: { width: number; height: number };
  /** Which node classes "its" ComfyUI has, when the variant is about doing without one (every node, left out). */
  has?(node: string): boolean;
}

export interface Recipe<In = Record<string, unknown>> {
  /** "<family>.<what it does>", stable: stored with every generation. */
  id: string;
  family: string;
  /** Bumped when the graph changes in a way that changes results for the same inputs. */
  version: number;
  title: string;
  summary: string;
  output: "image" | "video" | "audio";
  inputs: InputSpec[];
  traits?: VideoTraits;
  /**
   * Files this recipe names itself (an imported workflow's models): each must be among the choices
   * ComfyUI offers for that input of that node class. Files the user picks on the form are not listed here.
   */
  files?: Array<{ classType: string; input: string; file: string; /** Where its author says it can be had. */ url?: string }>;
  /**
   * Slots of its family this recipe cannot run without, although the family can (an "Edit" that needs
   * the model that edits): it is not ready while their files are missing.
   */
  needs?: string[];
  /** Node classes this particular input needs (checked against ComfyUI before queueing). */
  nodes(input: In): string[];
  /** Node classes build() uses only when this ComfyUI has them (ctx.has): speed-ups and finishing touches. */
  optionalNodes?: string[];
  build(input: In, ctx: BuildContext): BuiltGraph;
  /**
   * What is heavy for the card it will run on, said next to the choice that makes it so. Never a limit:
   * every option stays available. `vramGb` is the memory of the card ComfyUI runs on.
   */
  advice?(input: In, card: { vramGb: number }): Advice[];
  /** Sample inputs the graph checker builds without a GPU. Cover every branch of build(). */
  variants: Variant<In>[];
  /**
   * What a model file starts on the first time it is used, before anything is saved for it: the settings
   * its line's authors recommend (Pony's score tags and CFG 7, Krea's guidance 4.5). The first whose
   * pattern matches the file's name wins; a value saved for the file always wins over it.
   */
  presets?: Preset[];
}

/** Settings for the models whose file name matches `match` (a regular expression, case-insensitive). */
export interface Preset {
  match: string;
  values: Record<string, unknown>;
  /** Said under the form the first time: where the values come from. */
  note?: string;
}

/** A word about one choice: it is slow, or probably too much, on this card. */
export interface Advice {
  /** The input it is about. */
  input: string;
  level: "slow" | "heavy";
  text: string;
}

export const defineFamily = (f: Family): Family => f;
export const defineRecipe = <In>(r: Recipe<In>): Recipe<In> => r;

/** Raw inputs (from the browser, a draft, a variant) → validated values with defaults filled in. */
export function parseInput<In>(recipe: Recipe<In>, raw: unknown): In {
  return schemaFor(recipe.inputs).parse(raw) as In;
}

/** A context for building without a ComfyUI: every optional node is "installed", nothing was uploaded. */
export function dryContext(over: Partial<BuildContext> = {}): BuildContext {
  return { seed: 1, slots: {}, uploads: {}, media: {}, has: () => true, ...over };
}

/** What the browser needs to render a recipe's form. */
export function describeRecipe(r: Recipe<any>) {
  return {
    id: r.id, family: r.family, version: r.version, title: r.title, summary: r.summary, output: r.output,
    inputs: r.inputs, traits: r.traits ?? null, presets: r.presets ?? [],
    // the model files it names itself (an imported workflow's): what its LoRAs are sorted for
    models: (r.files ?? []).filter((f) => ["checkpoints", "diffusion_models"].includes(folderOfFileInput(f.classType, f.input) ?? "")).map((f) => f.file),
  };
}
