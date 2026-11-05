import { formModelInput, isModelFile, type InputSpec, type Recipe } from "@afflatus/core";
import { stemOf, type FoundSettings, type OwnForm } from "./embedded";

/**
 * Settings read from a picture, worked into the form of a recipe: any recipe that makes a picture from
 * a prompt, built in or imported. Which recipe is not assumed: the one that uses the model the picture
 * was made with comes first, and the user can pick another.
 */

type Options = Record<string, string[]>;

/** A model named in a picture and a file on disk are the same model: the same name, or one is the other with something added ("_fp8"). */
export function sameModel(name: string, file: string): boolean {
  const a = stemOf(name).toLowerCase();
  const b = stemOf(file).toLowerCase();
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 10 && long.startsWith(short);
}
const fileFor = (name: string | undefined, list: string[] | undefined) =>
  name ? (list ?? []).find((o) => stemOf(o).toLowerCase() === stemOf(name).toLowerCase()) ?? (list ?? []).find((o) => sameModel(name, o)) : undefined;

/** A recipe a picture's settings can go into: it makes a picture from a prompt, and needs no picture to start from. */
const takesSettings = (r: Recipe<any>) =>
  r.output === "image" && r.inputs.some((i) => i.type === "prompt" && !i.optional || i.id === "prompt") && !r.inputs.some((i) => (i.type === "image" && !i.optional) || (i.type === "image" && i.role === "mask"));

/**
 * A form a picture itself can go into with its settings (img2img, inpaint, upscale, a face pass): it makes a picture and
 * starts from one. The picture is put in its source slot by the page, once it is in the library.
 */
export const takesPicture = (r: Recipe<any>) => r.output === "image" && r.inputs.some((i) => i.type === "image" && i.role === "source" && !i.optional);

export interface Target {
  id: string;
  /** Why it is offered first, when there is a reason. */
  why?: string;
}

/** The recipes the settings can fill, the likeliest first: the one that loads the picture's model, then the ones that have it to pick. */
export function targetsFor(found: FoundSettings, recipes: Recipe<any>[], optionsOf: (id: string) => Options, own?: OwnForm): Target[] {
  const able = recipes.filter(takesSettings);
  const rank = (r: Recipe<any>): { score: number; why?: string } => {
    // a picture downloaded from Afflatus names the form it was made with: that one, filled exactly
    if (own?.recipe === r.id) return { score: 4, why: "it was made with it" };
    if (!found.checkpoint) return { score: 0 };
    if ((r.files ?? []).some((f) => sameModel(found.checkpoint!, f.file))) return { score: 3, why: "it uses this model" };
    const model = formModelInput(r);
    if (model && fileFor(found.checkpoint, optionsOf(r.id)[model.id])) return { score: 2, why: "it can load this model" };
    return { score: 0 };
  };
  return able
    .map((r, at) => ({ r, at, ...rank(r) }))
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .map(({ r, why }) => ({ id: r.id, ...(why ? { why } : {}) }));
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const named = (i: InputSpec, id: string, label: RegExp) => i.id === id || label.test(i.label);

/**
 * The form of a recipe, filled with what the picture says: each setting goes to the input that holds
 * it there (by what the input is, then by its name), within that input's range. What has no place in
 * this recipe, or is not on this ComfyUI, is said in the notes instead of being forced in. A form that starts from a
 * picture (takesPicture) takes the img2img strength rather than a size. `made`: the form the picture was made with in
 * Afflatus, which fills its own recipe exactly (ownInto).
 */
export function fill(found: FoundSettings, recipe: Recipe<any>, options: Options, online: boolean, made?: OwnForm) {
  const input: Record<string, unknown> = {};
  const fromPicture = takesPicture(recipe);
  // the picture itself goes in this time: that it was an img2img is no news
  const notes = found.notes.filter((n) => !(fromPicture && /img2img/.test(n)));
  const missing: Array<{ file: string; folder: string; civitai?: number }> = [];
  const number = (i: Extract<InputSpec, { type: "number" }>, value: number) => (input[i.id] = clamp(i.step >= 1 ? Math.round(value) : value, i.min, i.max));

  const prompts = recipe.inputs.filter((i): i is Extract<InputSpec, { type: "prompt" }> => i.type === "prompt");
  const prompt = prompts.find((i) => i.id === "prompt") ?? prompts.find((i) => !i.optional) ?? prompts[0];
  if (prompt) input[prompt.id] = found.prompt;
  const negative = prompts.find((i) => i !== prompt && named(i, "negative", /negative/i));
  if (negative) input[negative.id] = found.negative;
  else if (found.negative.trim()) notes.push("This form has no negative prompt: the picture's is left out.");
  const quality = prompts.find((i) => i.id === "quality");
  if (quality) input[quality.id] = "";

  // the model: picked in the form when the recipe has it to pick; an imported workflow loads its own
  const model = formModelInput(recipe);
  const own = (recipe.files ?? []).find((f) => found.checkpoint && sameModel(found.checkpoint, f.file));
  const picked = model ? fileFor(found.checkpoint, options[model.id]) : undefined;
  if (model && picked) input[model.id] = picked;
  const modelFound = Boolean(picked || own);
  if (found.checkpoint && !modelFound && online) {
    if (model) missing.push({ file: `${found.checkpoint}.safetensors`, folder: "checkpoints", ...(found.checkpointCivitai ? { civitai: found.checkpointCivitai } : {}) });
    else notes.push(`This workflow loads its own model, not ${found.checkpoint}: the result will differ.`);
  }

  const lorasInput = recipe.inputs.find((i): i is Extract<InputSpec, { type: "loras" }> => i.type === "loras");
  const loras = found.loras.map((l) => ({ ...l, file: lorasInput ? fileFor(l.name, options[lorasInput.id]) : undefined }));
  if (lorasInput) input[lorasInput.id] = loras.filter((l) => l.file).slice(0, lorasInput.max).map((l) => ({ file: l.file, weight: clamp(l.weight, -4, 4) }));
  for (const l of loras) if (!l.file && online && lorasInput) missing.push({ file: `${l.name}.safetensors`, folder: "loras", ...(l.civitai ? { civitai: l.civitai } : {}) });
  if (!lorasInput && found.loras.length) notes.push("This form takes no LoRAs: the picture's are left out.");
  if (!online) notes.push("ComfyUI is not answering, so its model and LoRAs could not be looked up: the form keeps the ones it has.");

  const size = recipe.inputs.find((i): i is Extract<InputSpec, { type: "size" }> => i.type === "size");
  if (size && found.width && found.height && !fromPicture) {
    const edge = (n: number) => Math.round(clamp(n, size.min, size.max) / size.grid) * size.grid;
    input[size.id] = { width: edge(found.width), height: edge(found.height) };
  }
  const seed = recipe.inputs.find((i) => i.type === "seed");
  // a pass on the picture itself rolls its own seed, as one from the library does (the web's carried)
  if (seed && !fromPicture && found.seed !== undefined && found.seed >= 0 && found.seed < 2 ** 32) input[seed.id] = Math.floor(found.seed);

  // the settings of the first pass: under their own names in a built-in form, under the node's names in an imported one
  const numbers = recipe.inputs.filter((i): i is Extract<InputSpec, { type: "number" }> => i.type === "number");
  const steps = numbers.find((i) => named(i, "steps", /^steps( · first pass)?$/i));
  if (steps && found.steps) number(steps, found.steps);
  const cfg = numbers.find((i) => named(i, "cfg", /^cfg( scale)?( · first pass)?$/i));
  if (cfg && found.cfg) number(cfg, found.cfg);
  const strength = numbers.find((i) => !i.id.startsWith("hires") && named(i, "strength", /^denois(e|ing strength)$/i));
  if (strength && fromPicture && found.denoise) number(strength, found.denoise);
  const clipSkip = numbers.find((i) => i.id === "clipSkip");
  if (clipSkip && found.clipSkip) number(clipSkip, found.clipSkip);
  const choices = recipe.inputs.filter((i): i is Extract<InputSpec, { type: "choice" }> => i.type === "choice");
  const offered = (i: Extract<InputSpec, { type: "choice" }>) => (Array.isArray(i.options) ? i.options : options[i.id] ?? []);
  const sampler = choices.find((i) => named(i, "sampler", /^sampler( name)?( · first pass)?$/i));
  const scheduler = choices.find((i) => named(i, "scheduler", /^scheduler( · first pass)?$/i));
  if (sampler && found.sampler) {
    if (!offered(sampler).length || offered(sampler).includes(found.sampler)) input[sampler.id] = found.sampler;
    else notes.push(`Its sampler (${found.sampler}) is not one ComfyUI has: the form keeps its own.`);
  }
  if (scheduler && found.scheduler && (!offered(scheduler).length || offered(scheduler).includes(found.scheduler))) input[scheduler.id] = found.scheduler;

  // hires fix, where the form has A1111's own (the built-in txt2img)
  if (recipe.inputs.some((i) => i.id === "hires" && i.type === "toggle")) {
    input.hires = Boolean(found.hires);
    if (found.hires) {
      // the upscale model it names when this ComfyUI has it; else a latent upscale where the form has one, else the form's own
      const upscaler = recipe.inputs.find((i) => i.id === "hiresUpscaler");
      const has = fileFor(found.hires.upscaler, options.hiresUpscaler) ?? (upscaler?.type === "choice" && upscaler.extra?.includes("latent") ? "latent" : undefined);
      if (has) input.hiresUpscaler = has;
      if (found.hires.scale) input.hiresScale = clamp(found.hires.scale, 1.1, 2);
      if (found.hires.denoise) input.hiresDenoise = clamp(found.hires.denoise, 0.05, 0.9);
      if (found.hires.steps) input.hiresSteps = clamp(Math.round(found.hires.steps), 1, 60);
    }
  }

  if (made?.recipe === recipe.id) ownInto(recipe, made.input, input, options);

  return {
    recipe: recipe.id, input, source: found.source, notes, missing,
    /** What was read, to show before anything is done with it. */
    model: found.checkpoint ? { name: found.checkpoint, found: modelFound } : null,
    loras: loras.map((l) => ({ name: l.name, weight: l.weight, found: Boolean(l.file) })),
  };
}

/** The inputs that hold the library's pictures, sounds and clips: a file from elsewhere names none of this library's. */
const MEDIA_TYPES = new Set(["image", "audio", "clip", "references", "cues", "video"]);
const bare = (v: string) => v.replace(/^.*[\\/]/, "");

/**
 * Afflatus's own form, read from a picture it gave out (pngInfo.ts), over what the A1111 text filled: every setting as it
 * was, but the model and the LoRAs, which the text's names already matched to this ComfyUI's files (sameModel), and the
 * pictures. A file the form names (an upscaler) went out by its name alone: it is this ComfyUI's file of that name, else
 * the form keeps its own.
 */
function ownInto(recipe: Recipe<any>, own: Record<string, unknown>, input: Record<string, unknown>, options: Options): void {
  // a form that starts from the picture rolls its own seed and keeps the picture's size, as fill does
  const fromPicture = takesPicture(recipe);
  for (const spec of recipe.inputs as InputSpec[]) {
    const v = own[spec.id];
    if (v === undefined || MEDIA_TYPES.has(spec.type) || spec.type === "loras" || spec === formModelInput(recipe)) continue;
    if (fromPicture && (spec.type === "seed" || spec.type === "size")) continue;
    if (typeof v === "string" && isModelFile(v)) {
      const offered = spec.type === "choice" && Array.isArray(spec.options) ? spec.options : options[spec.id] ?? [];
      const file = offered.find((o) => o === v) ?? offered.find((o) => bare(o).toLowerCase() === v.toLowerCase());
      if (file) input[spec.id] = file;
      else if (!offered.length) input[spec.id] = v;
      continue;
    }
    input[spec.id] = v;
  }
}
