import type { FrameGrid } from "./frameGrid";
import type { LintInput, PromptLine } from "./promptLint";
import type { BuiltGraph } from "./graph";
import { chosenDefaults, schemaFor, withoutOldZeros, type InputSpec, type StartRule } from "./inputs";
import { folderOfFileInput } from "./models";

/** A file a family needs, wherever the user keeps it: found by pattern, overridable on the setup page. */
interface ModelSlot {
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
  /**
   * The recipes that alone use it. While every one of them is hidden, it is not offered for download (Settings › Models
   * showed Swap's two files, the reference model twice, for a recipe nobody could open).
   */
  onlyFor?: string[];
}

/** One model architecture: what its files are and how its prompts are written. */
export interface Family {
  id: string;
  name: string;
  summary: string;
  /**
   * What the "?" beside the model says (the form, the model list, Settings › Models): what it makes, what it is best and
   * weak at, in plain words. Measured by Afflatus's own tests or said by the model's authors; nothing that reads as an
   * invitation to misuse (an edit "guided by reference pictures", not who it can put where).
   */
  help?: { what: string; best: string; weak: string };
  promptStyle: "tags" | "sentences" | "sections";
  /** The family of workflows the user imported (Workflows) under one model name, not a built-in one. */
  imported?: true;
  /** Files every recipe of this family loads (a model the user picks per generation is an input instead). */
  slots: ModelSlot[];
  /** Regex sources matched against a LoRA's architecture metadata and path: which LoRAs fit this family. */
  loraMatch: string[];
  /** How this family's prompts are written, in words for the prompt designer's language model. */
  guide?: string;
  /**
   * What the designer wrote, held against this family's own rules, after the fact (the server's outputChecks.ts):
   * one plain line per miss, by part. The text is never changed; the user decides.
   */
  lint?(written: LintInput): PromptLine[];
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
  /** Valid frame counts: frames = step * k + offset; the grid its kept latents are cut and landed on too (frameGrid.ts). */
  frameGrid: FrameGrid;
  /**
   * Of a recipe that continues in a kept latent: the node class that cuts that latent short, so that a clip handed
   * over before its end is continued from there (on the grid), in the latent. Left out, it is continued only from its end.
   */
  latentTrim?: string;
  /**
   * The node classes a join in a kept latent takes (Afflatus's node pack): a timeline clip of such a recipe is planned on a
   * machine that has them while any has, since a clip made elsewhere saves no latent and the clip after it joins on frames.
   */
  latentNodes?: string[];
  /**
   * A recipe that makes a long source window by window (Motion transfer on a timeline's source lane): the most and fewest
   * frames a job takes, and the frames of the clip before a window carries on from (sourceWindows.ts).
   */
  windows?: {
    most: number;
    least: number;
    carried: number;
    /**
     * The input that sets the frames carried (H3's "Frames from the clip before"), and the counts it takes: a source's
     * windows are cut for the count its form has (windowShapeOf), `carried` when it has none.
     */
    runUp?: { input: string; counts: number[] };
    /**
     * The inputs each window keeps its own (its prompt: clip 6 of a source can show something else than clip 2): a change
     * made on one clip stays there unless given to all, and the source's form gives them only to the windows it makes.
     */
    own?: string[];
  };
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
  /** Of a clip continued from before its end (it was handed over before a frozen tail): its latent is cut to this many first frames. */
  latentCut?: number;
  /** Of the clip before, in a latent re-sample finish: the size of its own re-sampled latent, when it was finished that way (uploaded as "<input>.fine"). */
  fine?: { width: number; height: number };
  /** Of a sound: how long the part handed over is, in seconds (shorter than asked when the sound ends first). */
  seconds?: number;
  /** Of a sound: how many seconds of it were handed over after the part (the window's `after`). */
  after?: number;
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
  /**
   * The node an option the user turned on asks for (`wanted`), or null: the build then does without it. Unlike `has`, what
   * an option asks for is a need, its pack installed where the job runs (jobPacks.ts): the queue looks ahead with one that
   * says yes to everything, and records what was asked. Left out: the first of the nodes this ComfyUI has (`has`).
   */
  wants?(w: Wanted): string | null;
  /** The files a node's input offers on this ComfyUI (an upscale model to fall back on); left out: not known. */
  options?(node: string, input: string): string[] | null;
}

/**
 * A node an option asks for, as a build says it (BuildContext.wants): the input that asks, the nodes that do (any one of
 * them: NVIDIA's RTX node or DaSiWa's; the one whose pack is installed for it last), and in a few words what the render
 * is without it, for its job's warning and the Queue's "Run without" ("Veda").
 */
export interface Wanted {
  input: string;
  nodes: readonly string[];
  without: string;
  /** What is done instead, when it is more than leaving it out ("upscaled with 4xNomosUni instead"). */
  instead?: string;
}

/** The node an option asks for that this ComfyUI has (ctx.wants), else null. */
export const wanted = (ctx: Pick<BuildContext, "has" | "wants">, w: Wanted): string | null =>
  ctx.wants ? ctx.wants(w) : (w.nodes.find((n) => ctx.has(n)) ?? null);

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

/** A chapter of a form arranged by the recipe: its title, and the toggle input at its head when it has one (off, the chapter folds). */
export interface Chapter {
  id: string;
  label: string;
  toggle?: string;
  /** What it is for, in the author's words: shown behind a ? beside the title. */
  help?: string;
}

export interface Recipe<In = Record<string, unknown>> {
  /** "<family>.<what it does>", stable: stored with every generation. */
  id: string;
  family: string;
  /** Made from a workflow the user imported (Workflows), not built in: what is wrong with it is put right there, with Edit. */
  imported?: true;
  /**
   * Not offered for now (no Create entry, no timeline model, no Ctrl+K row): kept so that it can come back, and so that a
   * draft, clip or job already made with it still opens, renders and plays.
   */
  hidden?: true;
  /** Bumped when the graph changes in a way that changes results for the same inputs. */
  version: number;
  title: string;
  summary: string;
  output: "image" | "video" | "audio";
  inputs: InputSpec[];
  /** Chapters of the form the recipe arranges itself (an imported workflow's sections), in order; the inputs name theirs with `chapter`. */
  chapters?: Chapter[];
  /** The form's cards drawn first, in this order, by id (model, takes, a chapter's id); the others follow as the form has them. */
  first?: string[];
  /**
   * How this form's prompt is written, for the designer's language model, over its family's guide: a form whose prompt
   * follows rules of its own (a swap: the Character-Swap LoRA's sentence, the person named by what is visible).
   */
  guide?: string;
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
  /**
   * Slots of its family this particular input cannot do what it asks without (Wan's Turbo: the lightx2v LoRAs, unless the
   * model is made for a few steps). A machine without their files does not take the job, and a rented pod is sent them:
   * the recipe left alone would render without them, the full steps where Turbo was asked. `slots`: the family's files
   * found on that machine (slot id → file), which the build loads for a model left out of the form (a distilled one needs
   * no turbo LoRA); left out, only the form's own pick is read.
   */
  needsWith?(input: In, slots?: Record<string, string>): string[];
  /**
   * Of a recipe made window by window: what a window that carries on is made with in place of the source's form, from that
   * form (Swap motion: a prompt that describes the person as clip 1's does, without the swap's <Video 1>).
   */
  windowCarryOn?(form: Record<string, unknown>): Record<string, unknown>;
  /** Node classes this particular input needs (checked against ComfyUI before queueing). */
  nodes(input: In): string[];
  /** Node classes build() uses only when this ComfyUI has them (ctx.has): speed-ups and finishing touches. */
  optionalNodes?: string[];
  build(input: In, ctx: BuildContext): BuiltGraph;
  /**
   * What a finish made with this form (a timeline clip's draft rendered again, larger) needs of the draft it
   * finishes: `latent: "own"` is the draft's own kept latent, handed over as the upload "self.latent" (H3's latent
   * re-sample samples it again as it is). Null, or left out: nothing beyond the form.
   */
  finishing?(input: In): { latent: "own" } | null;
  /** Sample inputs the graph checker builds without a GPU. Cover every branch of build(). */
  variants: Variant<In>[];
  /**
   * What a model file starts on the first time it is used, before anything is saved for it: the settings
   * its line's authors recommend (Pony's score tags and CFG 7, Krea's guidance 4.5). Every preset whose
   * pattern matches the file's name counts, each setting from the first that has it (a few-step entry
   * before a lineage's); a value saved for the file always wins over them.
   */
  presets?: Preset[];
  /**
   * Settings whose right start depends on the files its family finds as well as on the form (a turbo LoRA made for
   * other steps): the form starts them there, so that what it shows is what the render runs.
   */
  starts?: StartRule[];
}

/** Settings for the models whose file name matches `match` (a regular expression, case-insensitive). */
export interface Preset {
  match: string;
  values: Record<string, unknown>;
  /** Said under the form the first time: where the values come from. */
  note?: string;
}

export const defineFamily = (f: Family): Family => f;
export const defineRecipe = <In>(r: Recipe<In>): Recipe<In> => r;

/** Raw inputs (from the browser, a draft, a variant) → validated values with defaults filled in. */
export function parseInput<In>(recipe: Recipe<In>, raw: unknown): In {
  const parsed = schemaFor(recipe.inputs).parse(raw) as Record<string, unknown>;
  // what was left out starts where the choices made move it, as the form starts it (Turbo on: the turbo LoRA's shifts);
  // an older draft's 0 for "the recipe picks it" counts as left out
  const given = raw && typeof raw === "object" ? withoutOldZeros(recipe.inputs, raw as Record<string, unknown>) : {};
  const moved = Object.entries(chosenDefaults(recipe.inputs, parsed)).filter(([id]) => given[id] === undefined);
  return { ...parsed, ...Object.fromEntries(moved) } as In;
}

/** A context for building without a ComfyUI: every optional node is "installed", nothing was uploaded. */
export function dryContext(over: Partial<BuildContext> = {}): BuildContext {
  return { seed: 1, slots: {}, uploads: {}, media: {}, has: () => true, ...over };
}

/** What the browser needs to render a recipe's form. */
export function describeRecipe(r: Recipe<any>) {
  return {
    id: r.id, family: r.family, ...(r.imported ? { imported: true as const } : {}), ...(r.hidden ? { hidden: true as const } : {}), version: r.version, title: r.title, summary: r.summary, output: r.output,
    inputs: r.inputs, traits: r.traits ?? null, presets: r.presets ?? [], starts: r.starts ?? [],
    ...(r.chapters?.length ? { chapters: r.chapters } : {}),
    ...(r.first?.length ? { first: r.first } : {}),
    // the family's optional files it cannot run without (Edit's Kontext model): Settings › Models says which operations use each file
    ...(r.needs?.length ? { needs: r.needs } : {}),
    // the model files it names itself (an imported workflow's): what its LoRAs are sorted for
    models: (r.files ?? []).filter((f) => ["checkpoints", "diffusion_models"].includes(folderOfFileInput(f.classType, f.input) ?? "")).map((f) => f.file),
  };
}

/**
 * Built-in recipes Afflatus had and took out, by id, with the name they were shown under: a draft, a clip or a job made
 * with one still opens, and says so (removedSaid) rather than "imported video" or an unknown id. Wan Animate 2 went in
 * 0.5.0 (the owner's call: it never worked well, its renders took too long).
 */
export const REMOVED_RECIPES: Readonly<Record<string, string>> = { "wananimate.motion": "Wan Animate 2" };

/** What is said of a recipe taken out of Afflatus ("Wan Animate 2, removed from Afflatus"); null for any other id. */
export const removedSaid = (id: string | null | undefined): string | null => (id && REMOVED_RECIPES[id] ? `${REMOVED_RECIPES[id]}, removed from Afflatus` : null);

/** A recipe taken out of Afflatus where its model's name stands ("Wan Animate 2 (removed)"), never its id; null for any other id. */
export const removedName = (id: string | null | undefined): string | null => (id && REMOVED_RECIPES[id] ? `${REMOVED_RECIPES[id]} (removed)` : null);

/** The Image tools' family (an upscale, a background removal): no model of its own, no prompt. Named here for the screens that leave it out. */
export const TOOLS_FAMILY = "tools";
/** The background remover: a tool, where every other operation on a picture is a model's own recipe. */
export const REMOVE_BACKGROUND = "tools.remove-background";

/** The upscale route that samples a video's own latent again, larger (H3's): kept in the recipe, not run as a tool. */
export const LATENT_RESAMPLE = "Latent: re-sampled";

/** A recipe whose form offers the latent re-sample as an upscale route: its clips can be finished that way. */
export function resamplesLatent(recipe: { inputs: InputSpec[] } | undefined): boolean {
  return Boolean(recipe?.inputs.some((i) => i.id === "upscale" && i.type === "choice" && Array.isArray(i.options) && i.options.includes(LATENT_RESAMPLE)));
}
