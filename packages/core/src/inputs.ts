import { z } from "zod";
import { endsIn, MODEL_EXTS } from "./modelFiles";
import { withinPixels } from "./frame";
import { gridAtOrBefore, type FrameGrid } from "./frameGrid";
import { sigmaOfOldDenoise } from "./sigmas";
import { plural, verb } from "./text";

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
  /** Set by the app itself, never shown in a form (a swap asked for its mask alone, Show the mask). */
  internal?: boolean;
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
  /**
   * The file or the weight of a LoRA the recipe adds itself (AddedLora), drawn as that LoRA's row in this LoRA list (its id)
   * rather than as a field of its own.
   */
  inList?: string;
}

interface PromptInput extends Base {
  type: "prompt";
  /** How this family reads text: comma-separated tags, or plain sentences. */
  style: "tags" | "sentences";
  /** A few words on one line, not a text (a swap's Track: what SAM 3 looks for). */
  line?: boolean;
  placeholder?: string;
  default?: string;
  optional?: boolean;
  /**
   * "subject": this text says how the people in it look. A recipe that follows reference pictures has
   * such a place; the words of the cast go there instead of in front of the main text.
   */
  holds?: "subject";
  /**
   * The form's main text: the box that heads its Prompt card, with the Designer and Snippets, where a LoRA's trigger words go.
   * Left out on every text of a recipe, the one that must be written is, else its first text (form.ts mainTextOf).
   */
  main?: boolean;
  /** The cast's words are never added to it: a few words the recipe builds its own prompt from (a swap's "who to replace"). */
  noCast?: boolean;
  /** With noCast: the Designer still writes it (a Motion transfer's description of its picture), where a swap's few words are the user's own. */
  designed?: boolean;
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
  /**
   * The input offers OWN_MODEL first, before the files: no file of its own, the model the clip itself is made with (Face
   * refine run on the clip's model, nothing more loaded). Its list is then every file of the folder, the family's other
   * slots' included: each is a model the pass may run on.
   */
  own?: true;
  /**
   * Left empty, the recipe takes the file of the first of its slots that suits the clip (AddedLora.slots: H3's reference
   * turbo LoRA for a reference clip, the usual one otherwise): the form starts empty. Its list is the files named for that use
   * first (`match`), then every other file of the folder: any may be put in its place.
   */
  blank?: true;
}
interface LorasInput extends Base {
  type: "loras";
  max: number;
  /** The LoRAs the list starts with (the ones an imported workflow came with). */
  default?: LoraValue[];
  /** The LoRAs the recipe adds itself (Turbo's, a distilled LoRA), each drawn as a row of its own at the top of the list. */
  added?: AddedLora[];
}

/**
 * A LoRA a recipe puts on the model itself, by a toggle (Turbo) or because the model needs it (LTX's distilled LoRA on a
 * model that is not distilled): shown as a row of a LoRA list, with its file and its weight, which are inputs of their own
 * (marked `inList`). A row of the same file added by hand is folded into it: one loader, at the weight typed (addedLora).
 */
export interface AddedLora {
  /** What the row is marked with ("Turbo", "Needed"). */
  label: string;
  /** The "?" of the row: what the LoRA does and where its file comes from (the Settings › Models slot). */
  note: string;
  /** The toggle that adds it: removing the row turns it off. Left out, the model needs it and the row cannot be removed. */
  toggle?: string;
  /** The model input (blank) that picks its file. */
  file: string;
  /** The number input that is its weight. */
  weight: string;
  /** Where the file comes from while none is picked: the first slot whose condition holds and that has a file. */
  slots: Array<{ slot: string; when?: StartCondition }>;
  /** When the recipe really adds it, the toggle on: not on a model made for a few steps as it is. Left out, always. */
  when?: StartCondition;
}

/** One LoRA the recipe adds itself, as it will be put on: its row, its file, its weight, and the hand row of the same file folded into it. */
export interface AddedRow {
  added: AddedLora;
  file: string;
  weight: number;
  /** The index in the list of a row of the same file added by hand: its weight is the one used (one loader). */
  hand: number;
}

/** The same LoRA file, wherever the folder it is in and whichever slash: two loaders of it would put it on twice. */
export const sameLora = (a: string, b: string) => (a.split(/[\\/]/).pop() ?? a).toLowerCase() === (b.split(/[\\/]/).pop() ?? b).toLowerCase();

/**
 * The LoRAs a list's recipe adds itself with these values and the files its family uses, as the render puts them on: the
 * toggle on, the condition holding, and a file there (picked, else its slot's). A row of the same file in the list gives
 * the weight (an older draft with Turbo on and the turbo LoRA added by hand too, card #160); one at 0 is not folded, as the
 * render does not (addedLora): it stays a row of the list at 0, and this row keeps its own weight.
 */
export function addedRows(spec: InputSpec, values: Record<string, unknown>, slots: Record<string, string>): AddedRow[] {
  if (spec.type !== "loras" || !spec.added) return [];
  const list = Array.isArray(values[spec.id]) ? (values[spec.id] as LoraValue[]) : [];
  return spec.added.flatMap((added) => {
    if (added.toggle && !values[added.toggle]) return [];
    if (added.when && !conditionHolds(added.when, values, slots)) return [];
    const picked = pickedFile(values[added.file]);
    const file = picked ?? added.slots.map((s) => (!s.when || conditionHolds(s.when, values, slots) ? slots[s.slot] : undefined)).find(Boolean);
    if (!file) return [];
    const hand = list.findIndex((l) => l.weight !== 0 && sameLora(l.file, file));
    const typed = Number(values[added.weight]);
    return [{ added, file, weight: hand >= 0 ? list[hand]!.weight : values[added.weight] !== undefined && Number.isFinite(typed) ? typed : 1, hand }];
  });
}

/**
 * How many LoRAs a list puts on, against its `max`: the rows added by hand, and each row the recipe adds itself (a Turbo row
 * takes a place of the list's six, card #160); a hand row folded into one of those is that row, counted once. The form's
 * "n of 6" and the server's refusal (lorasOverSaid) both count this way.
 */
export const lorasCounted = (list: readonly LoraValue[], rows: readonly AddedRow[]) =>
  list.length - new Set(rows.map((r) => r.hand).filter((i) => i >= 0)).size + rows.length;

/** The first LoRA list of a form holding more than it takes, said as a refusal; null when each is within its `max`. */
export function lorasOverSaid(specs: readonly InputSpec[], values: Record<string, unknown>, slots: Record<string, string>): string | null {
  for (const spec of specs) {
    if (spec.type !== "loras") continue;
    const list = Array.isArray(values[spec.id]) ? (values[spec.id] as LoraValue[]) : [];
    const rows = addedRows(spec, values, slots);
    const count = lorasCounted(list, rows);
    if (count > spec.max) {
      const own = rows.map((r) => r.added.label);
      return `${spec.label}: ${plural(count, "LoRA")}, ${spec.max} at most${own.length ? ` (${own.join(" and ")} ${verb(own.length, "takes a place", "take a place each")}, as ${verb(own.length, "its row is", "their rows are")} put on too)` : ""}`;
    }
  }
  return null;
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
  /**
   * With `ratioOnly`: the number input that gives the short side, and the most pixels the frame may have, so the form can say
   * what frame comes out (see frameOf). Without it, `maxPixels` holds a size typed in pixels within what the model takes
   * (see withinPixels): each edge alone within `max` still let a FLUX.1 picture be 2048 × 2048, twice what it draws.
   */
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
  /**
   * 0 was once how this setting said "the recipe picks it", before the form showed the value it uses: a 0 an older
   * draft or saved setting holds is read as left alone (the default, or where a choice moves it), never as 0.
   */
  oldZero?: true;
  /**
   * The σ a re-sample starts at, once saved under another id as BasicScheduler's denoise (a share of a "simple" schedule's
   * steps, much more noise than it said at a shift): an older value is read as the σ it really started at, worked out
   * with the steps and video shift saved beside it (the shift input's default when none is). The pair the form used to
   * start on (`oldDefault`) was never a choice: it is left out, and the new defaults apply (card #141).
   */
  fromDenoise?: { id: string; steps: string; shift: string; oldDefault: { denoise: number; steps: number } };
  /**
   * 0 is taken too, below `min`, and means the recipe picks the value (said as this word): the steps then count from
   * `min`, so that a grid like SeedVR2's 1, 5, 9 … 49 is what the arrows give, with 0 for "by the frame's size".
   */
  auto?: string;
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
  /**
   * How an option is said on screen when its value, saved in drafts and jobs and compared by the recipe, says it otherwise:
   * the upscale routes' "Pixel: upscale model" is shown "Upscale model", the name Finish gives the same route (card #172).
   */
  labels?: Record<string, string>;
  /** A line under an option in its list: what it does, to choose between them. */
  details?: Record<string, string>;
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
  /**
   * "mid": a picture the clip passes through, at the moment the number input named by `at` says. "guide": one the result follows
   * the shapes of (a ControlNet's), not one it is made from. "face": the cast person's picture the face along the take is scored
   * against (internal: the cast fills it, the render never sees it), on a model that takes no reference pictures.
   */
  role: "source" | "start" | "end" | "mid" | "mask" | "guide" | "face";
  optional?: boolean;
  /**
   * Needed by a clip that opens, not by one that carries on from the clip before (Motion transfer's Picture: a window
   * after a swap has none of its own, card #42). Parsed as optional, never filled in for it; a form on its own asks for it.
   */
  opensOnly?: boolean;
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
  /**
   * A source video of which only a part is worked on (a swap): the ids of the number inputs that say where it starts and
   * how long it is, in seconds. It is handed over cut to that part, at `fps`. `fits`: how much of it one clip holds.
   */
  window?: { start: string; seconds: string; fits?: PartFit };
  /**
   * "previous": its last frame as it was filed (finished: matched, softened, grained) goes up too, as "<id>.look". The frames
   * handed over are the model's own when they were kept, which do not show how the clip looked (Motion transfer's colour match).
   * "matched": only when that clip's chain was colour-matched to its first frame (H3: the match carried on, see colourCarried).
   */
  look?: boolean | "matched";
  /** Its latent is never sent: the recipe meets that clip on its frames only, whatever was kept of it (LTX's landing). */
  framesOnly?: boolean;
  /** "source": a person in it can be clicked on its first frame (a swap's who is replaced), kept as the value's `pick`. */
  pick?: boolean;
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
  /**
   * Each picture is a subject of its own, not one more view of the same one (LTX 2.5's MSR LoRA gives each its own slot):
   * a person gets one picture and the place one, the people are still described in words (the LoRA's authors ask for each
   * picture to be described), the voice's owner comes first (a voice goes with the first picture), and a last frame stays.
   */
  subjects?: true;
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
   * `even`: the id of a toggle that evens out the sound's loudness as the part is cut, one gain for the whole sound (a quiet
   * take guides a model weakly; the parts of one sound stay as loud as each other).
   * `after`: seconds of the sound handed over after the part, for a clip that outlasts the part to end on: the sound's
   * own pause when there is one, else the part's end faded out in 0.15 s, then silence (the server's soundPart).
   * `goesOn`: the id of an internal toggle a timeline sets when the next clip's part carries on where this one's ends: the
   * `after` seconds are then the sound itself, not faded, and that next clip starts its part where this clip's sound stops
   * playing (TimelinePlan.recordingRun).
   * `leadIn`: the id of an internal toggle a timeline sets when the clip before sang the sound right up to this part (its
   * `goesOn`): a few seconds of the sound before the part are handed over too (MediaFacts `before`), for the clip's head, the
   * frames it shares with the clip before, to sound of them rather than of the model's guess at them.
   * `fits`: how much of the sound one clip can hold (see PartFit); without it, the length input's own max.
   */
  window?: { start: string; seconds: string; even?: string; after?: number; goesOn?: string; leadIn?: string; fits?: PartFit };
}

/**
 * Sounds that land at moments of the clip (a door slam, a clap, a music hit): each one a part of a sound from the library
 * and the moment it lands, in seconds of the clip's own time (after the frames it shares with the clip before). The model
 * hears it there; the recipe says whether the take's file carries it (its own choice input).
 */
interface CuesInput extends Base {
  type: "cues";
  max: number;
}
export interface CueValue {
  /** The sound's id in the library (or a video that has sound). */
  asset: string;
  /** The part of it used: where it starts in the file and how long it lasts, in seconds. */
  start: number;
  seconds: number;
  /** When it lands, in seconds of the clip's own time. */
  at: number;
}
/** The longest part of a sound a cue takes, in seconds: a clip lasts 15 at most. */
export const CUE_MAX_SECONDS = 15;

/**
 * How long a part of a sound (or of a source video) one clip can hold: the clip's most frames at `fps`, less the frames of the clips it
 * joins (each clip input that is set: its count from its `framesFrom` input, else its first), less `pad` seconds
 * after the part, less the seconds of the `less` number inputs (a moment before the words). The clip's own part
 * lasts the sound's part plus those, `min` seconds at least: what the form says the part makes.
 */
export interface PartFit {
  frames: number;
  fps: number;
  pad: number;
  min: number;
  less?: string[];
  /** The clip's frame counts (a swap's 17k + 5): what one clip holds and what a part makes are floored to it, not to a tenth of a second. */
  grid?: FrameGrid;
}

/**
 * The input a recipe takes a recording on, part by part (an audio input of role "sound" with a window): Lip sync's, made
 * around it, and the internal one of a form a recording plays over (Video with audio, card #72). The same ids on every form
 * that has it, so that a clip keeps its part and its place in the recording whichever of them it is in.
 */
export const recordingSpecOf = (inputs: readonly InputSpec[]) =>
  inputs.find((i): i is AudioInput & { window: NonNullable<AudioInput["window"]> } => i.type === "audio" && i.role === "sound" && Boolean(i.window));

/**
 * The inputs that say a clip's place in a recording: the recording, its part, and the two a timeline sets for a song carried
 * across clips. A recording's cut sets them; a new clip never takes them from the clip before (card #88): copied, a clip
 * added past the recording's end was one of its clips, the same part laid over it again.
 */
export const recordingPlaceOf = (inputs: readonly InputSpec[]): string[] => {
  const spec = recordingSpecOf(inputs);
  return spec ? [spec.id, spec.window.start, spec.window.seconds, ...(spec.window.goesOn ? [spec.window.goesOn] : []), ...(spec.window.leadIn ? [spec.window.leadIn] : [])] : [];
};

/** Whether a recipe is made around a recording (Lip sync: the mouth follows it), not only played over by one: its recording is a field of its form. */
export const madeAroundRecording = (inputs: readonly InputSpec[]) => {
  const spec = recordingSpecOf(inputs);
  return Boolean(spec && !spec.internal);
};

/**
 * Whether a render sounds of a recording laid on it after its head, not of the model's own sound: its head, the frames
 * shared with the clip before, is the model's guess at it. Every render of a form made around a recording (Lip sync); one
 * of a form a recording plays over (Video with audio) when it was sent one (`made`: its recording set, card #72).
 */
export const laysSound = (inputs: readonly InputSpec[], made?: Record<string, unknown>) => {
  const spec = recordingSpecOf(inputs);
  return Boolean(spec && (!spec.internal || made?.[spec.id]));
};

/**
 * Whether a render of such a recipe had its head filed with the recording itself (its window's `leadIn` set in what it was
 * sent, `made`): the clip before sang it up to the part, and the head sounds of those moments, not of the model's guess.
 */
export const sungHead = (inputs: readonly InputSpec[], made: Record<string, unknown>) => {
  const spec = recordingSpecOf(inputs);
  return Boolean(spec?.window.leadIn && made[spec.window.leadIn]);
};

/** What a part makes with the form's values: the longest part one clip holds, and the clip's own length for a part of `seconds`. */
export function partFit(fit: PartFit, specs: InputSpec[], values: Record<string, unknown>): { most: number; clip(seconds: number): number } {
  let frames = fit.frames;
  for (const spec of specs) {
    if (spec.type !== "clip" || spec.role === "source" || !values[spec.id]) continue;
    const wanted = spec.framesFrom ? Number(values[spec.framesFrom]) : NaN;
    frames -= Number.isFinite(wanted) && wanted > 0 ? wanted : spec.frames[0] ?? 0;
  }
  const before = (fit.less ?? []).reduce((sum, id) => sum + (Number(values[id]) || 0), 0);
  const grid = fit.grid;
  if (grid) {
    const most = Math.max(0, gridAtOrBefore(frames, grid) / fit.fps - fit.pad - before);
    return { most, clip: (seconds) => Math.max(fit.min, gridAtOrBefore(Math.round((before + seconds + fit.pad) * fit.fps), grid) / fit.fps) };
  }
  const most = Math.max(0, Math.floor((frames / fit.fps - fit.pad - before) * 10) / 10);
  return { most, clip: (seconds) => Math.max(fit.min, before + seconds + fit.pad) };
}

export type InputSpec =
  | PromptInput | ModelInput | LorasInput | SizeInput | NumberInput | ToggleInput | ChoiceInput | SeedInput | ImageInput | ClipInput | ReferencesInput | AudioInput | CuesInput;

export interface ClipValue {
  /** The video's id in the library. */
  asset: string;
  /** The moment in it, in milliseconds. Left out: its end for "previous", its start for "next". */
  at?: number;
  /** A point clicked on the first frame of the part worked on, as shares of its width and height (a swap's person). */
  pick?: { x: number; y: number };
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

/** A model input's value for "the clip's own model" (ModelInput.own): a choice, never a file to find, fetch or count. */
export const OWN_MODEL = "Clip's own model";
/** The file a model input's value names: none for an empty one or OWN_MODEL. */
export const pickedFile = (value: unknown): string | null => (typeof value === "string" && value && value !== OWN_MODEL ? value : null);

const multipleOf = (n: number, grid: number) => Math.round(n / grid) * grid;

function schemaOf(spec: InputSpec): z.ZodType {
  switch (spec.type) {
    case "prompt": {
      const s = z.string().max(20_000);
      return spec.optional ? s.default(spec.default ?? "") : spec.default !== undefined ? s.default(spec.default) : s.min(1);
    }
    case "model": {
      // with a slot behind it, leaving it out means the slot's file; so does an empty pick (the form's, its folder holding
      // nothing yet): a Swap motion's first window was refused for the ControlNet only its later windows take
      const s: z.ZodType = spec.slot ? z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional()) : spec.default ? z.string().min(1).default(spec.default) : z.string().min(1);
      // OWN_MODEL only where the input offers it: elsewhere it is no file, and reached the loader to fail the job at its
      // submit (a pod's boot paid), as SeedVR2's or the latent upscaler's set to it by an agent
      return spec.own ? s : s.refine((v) => v !== OWN_MODEL, { message: `"${OWN_MODEL}" is not offered here: this input takes a model file` });
    }
    case "loras":
      return z
        .array(z.object({ file: z.string().min(1), weight: z.number().min(-4).max(4) }))
        .max(spec.max)
        .default(spec.default ?? []);
    case "size": {
      const shape = spec.shapes.find((s) => s.id === spec.default) ?? spec.shapes[0]!;
      const edge = z.number().min(spec.min).max(spec.max).transform((n) => multipleOf(n, spec.grid));
      const size = z.object({ width: edge, height: edge });
      const most = !spec.ratioOnly ? spec.maxPixels : undefined;
      return (most ? size.transform((v) => withinPixels(v, { grid: spec.grid, maxPixels: most, min: spec.min })) : size).default({ width: shape.width, height: shape.height });
    }
    case "number": {
      // a whole step from a whole start (steps, frames, a resolution): what takes it is an INT, which refuses 7.5
      const whole = [spec.step, spec.min, spec.default].every(Number.isInteger);
      const base = whole ? z.number().int() : z.number();
      if (spec.auto) return base.max(spec.max).refine((v) => v === 0 || v >= spec.min, { message: `0 (${spec.auto}) or at least ${spec.min}` }).default(spec.default);
      const n = base.min(spec.min).max(spec.max).default(spec.default);
      return spec.oldZero ? z.preprocess((v) => (v === 0 ? undefined : v), n) : n;
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
      return spec.optional || spec.opensOnly ? z.string().min(1).optional() : z.string().min(1);
    case "clip": {
      const clip = z.strictObject({
        asset: z.string().min(1), at: z.number().min(0).optional(),
        pick: z.strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional(),
      });
      return spec.optional ? clip.optional() : clip;
    }
    case "references":
      return z.array(z.strictObject({ asset: z.string().min(1), role: z.enum(spec.roles as [ReferenceRole, ...ReferenceRole[]]) })).max(spec.max).default([]);
    case "audio":
      return spec.optional ? z.string().min(1).optional() : z.string().min(1);
    case "cues":
      return z.array(z.strictObject({
        asset: z.string().min(1), start: z.number().min(0), seconds: z.number().positive().max(CUE_MAX_SECONDS), at: z.number().min(0),
      })).max(spec.max).default([]);
  }
}

const buildSchema = (specs: readonly InputSpec[]) => z.strictObject(Object.fromEntries(specs.map((s) => [s.id, schemaOf(s)])));
/**
 * Each recipe's schema, kept by its list of inputs: building one costs about three times the parse it is used for, and the
 * machine check parses every variant of every recipe. A list that grew since it was kept (an imported workflow's inputs are
 * pushed while it is read) gets a new one.
 */
const schemas = new WeakMap<readonly InputSpec[], { length: number; schema: ReturnType<typeof buildSchema> }>();

/**
 * A form refused by its schema, said by its fields' labels ("What happens is empty") rather than zod's own words
 * ("description: Too small: expected string to have >=1 characters"), which the Studio showed under Render (card #165).
 */
export function saidRefusal(specs: readonly InputSpec[], issues: readonly z.core.$ZodIssue[], raw: unknown): string {
  const given = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const said = issues.map((issue) => {
    const [id, ...rest] = issue.path;
    const spec = specs.find((s) => s.id === id);
    if (!spec) return issue.code === "unrecognized_keys" ? `the form has no ${plainList(issue.keys)}` : issue.message;
    const left = given[spec.id] === undefined || given[spec.id] === null || given[spec.id] === "";
    if (!rest.length && (left || (issue.code === "too_small" && spec.type === "prompt"))) return spec.type === "prompt" ? `${spec.label} is empty` : `${spec.label} is missing`;
    return `${spec.label}: ${issue.message.charAt(0).toLowerCase()}${issue.message.slice(1)}`;
  });
  return [...new Set(said)].join("; ");
}
const plainList = (keys: readonly string[]) => keys.map((k) => `"${k}"`).join(", ");

/** The zod object a recipe's raw inputs are parsed with: defaults filled in, unknown keys rejected. */
export function schemaFor(specs: InputSpec[]) {
  const kept = schemas.get(specs);
  if (kept && kept.length === specs.length) return kept.schema;
  const schema = buildSchema(specs);
  schemas.set(specs, { length: specs.length, schema });
  return schema;
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
/** A choice's option as it is said on screen (its `labels`), else its value as it is. */
export const choiceSaid = (spec: ChoiceInput, value: string): string => spec.labels?.[value] ?? value;

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
 * The files a form's model inputs pick, those in play only: a model input another one shows (Face refine's model, SeedVR2's)
 * holds its file while that is off, and loads nothing then. Never OWN_MODEL, which names no file.
 */
export function pickedFiles(specs: readonly InputSpec[], values: Record<string, unknown>): Array<{ input: string; file: string; folder: string }> {
  return specs.flatMap((spec) => {
    const file = spec.type === "model" ? pickedFile(values[spec.id]) : null;
    return spec.type === "model" && file && isShown(spec, values, specs) ? [{ input: spec.id, file, folder: spec.folder }] : [];
  });
}

/**
 * Whether an input is in play, given the values of the others. With the recipe's inputs, the input it depends on must
 * be in play too: the edge thresholds follow "Follow", which itself shows only with a guide picture, and its default
 * ("Edges") must not bring them on screen without one.
 */
export function isShown(spec: InputSpec, values: Record<string, unknown>, specs?: readonly InputSpec[], seen: ReadonlySet<string> = new Set()): boolean {
  if (spec.internal) return false;
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

/**
 * How long a clip of this form will be before it is rendered, in seconds: its length input, else the part of a video or a
 * sound it is made from (a Motion transfer window's driving video, a Lip sync clip's recording), which sets its length.
 * Null when neither says. A window carrying on from the clip before plays a few frames less than its part; close enough
 * to place a clip not made yet.
 */
export function plannedSeconds(specs: InputSpec[], values: Record<string, unknown>): number | null {
  // under a recording it plays over (card #72), the part sets the clip's length, whatever its own Duration says
  const recording = recordingSpecOf(specs);
  const part = recording && values[recording.id] ? Number(values[recording.window.seconds]) : NaN;
  if (Number.isFinite(part) && part > 0) return part;
  const own = secondsOf(specs, values);
  if (own !== null) return own;
  for (const i of specs) {
    const part = (i.type === "clip" || i.type === "audio") && i.window ? Number(values[i.window.seconds]) : NaN;
    if (Number.isFinite(part) && part > 0) return part;
  }
  return null;
}

/**
 * A form's saved values as they read today: without the 0s older drafts saved for "the recipe picks it" (`oldZero`), those
 * settings left alone, and with an older denoise read as the σ it started at (`fromDenoise`).
 */
export function withoutOldZeros(specs: readonly InputSpec[], values: Record<string, unknown>): Record<string, unknown> {
  const old = new Set(specs.filter((s) => s.type === "number" && s.oldZero).map((s) => s.id));
  return fromOldDenoise(specs, Object.fromEntries(Object.entries(values).filter(([id, v]) => !(old.has(id) && v === 0))));
}

function fromOldDenoise(specs: readonly InputSpec[], values: Record<string, unknown>): Record<string, unknown> {
  const out = { ...values };
  for (const spec of specs) {
    const was = spec.type === "number" ? spec.fromDenoise : undefined;
    if (spec.type !== "number" || !was || !(was.id in out)) continue;
    const denoise = out[was.id];
    delete out[was.id];
    // a value saved under the new id is the one that counts
    if (spec.id in out || typeof denoise !== "number" || !(denoise > 0)) continue;
    const steps = typeof out[was.steps] === "number" ? (out[was.steps] as number) : was.oldDefault.steps;
    const shiftSpec = specs.find((s) => s.id === was.shift);
    const savedShift = out[was.shift];
    const shift = typeof savedShift === "number" && savedShift > 0 ? savedShift : shiftSpec?.type === "number" ? shiftSpec.default : 1;
    const sigma = sigmaOfOldDenoise({ denoise, steps, shift }, was.oldDefault);
    // the pair the form started on: both left out, the form's new ones apply
    if (sigma === null) delete out[was.steps];
    else out[spec.id] = Math.min(spec.max, Math.max(spec.min, sigma));
  }
  return out;
}

/**
 * A condition on a form's values and on the files its family uses (slot id → file name), for settings whose right
 * starting value depends on both. `name`: the file a model input picks, else the slot's, its name matched (case ignored).
 */
export type StartCondition =
  | { all: StartCondition[] }
  | { any: StartCondition[] }
  | { not: StartCondition }
  | { input: string; is: unknown }
  | { input: string; filled: true }
  | { name: { input?: string; slot?: string }; match: string };

/** Settings that start elsewhere while a condition holds: what the render runs with the setup it finds. */
export interface StartRule {
  when: StartCondition;
  values: Record<string, unknown>;
}

export function conditionHolds(c: StartCondition, values: Record<string, unknown>, slots: Record<string, string>): boolean {
  if ("all" in c) return c.all.every((x) => conditionHolds(x, values, slots));
  if ("any" in c) return c.any.some((x) => conditionHolds(x, values, slots));
  if ("not" in c) return !conditionHolds(c.not, values, slots);
  if ("name" in c) {
    const picked = c.name.input ? values[c.name.input] : undefined;
    const file = (typeof picked === "string" && picked) || (c.name.slot ? slots[c.name.slot] : "") || "";
    return new RegExp(c.match, "i").test(file.split(/[\\/]/).pop() ?? "");
  }
  const v = values[c.input];
  if ("filled" in c) return Array.isArray(v) ? v.length > 0 : typeof v === "string" ? v.trim() !== "" : Boolean(v);
  return v === c.is;
}

/** The starting values the rules whose condition holds give, the first rule first for a setting two give. */
export function ruledDefaults(rules: readonly StartRule[] | undefined, values: Record<string, unknown>, slots: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of rules ?? []) if (conditionHolds(r.when, values, slots)) for (const [k, v] of Object.entries(r.values)) if (!(k in out)) out[k] = v;
  return out;
}
