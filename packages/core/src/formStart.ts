import { chosenDefaults, pickChoice, RANDOM_SEED, ruledDefaults, withoutOldZeros, type InputSpec, type StartRule } from "./inputs";
import { modelStart, type Preset } from "./recipe";

/**
 * What a form starts on, the page's and the server's alike: the web form shows it and renders it (web form.ts), and an
 * MCP render of a draft is sent from it (the server's mcpRender.ts), so that a draft rendered from outside renders what
 * the form on screen would have.
 */

/** The value an input starts with, given what this ComfyUI offers for it. */
export function defaultOf(spec: InputSpec, options: string[] | undefined): unknown {
  switch (spec.type) {
    // an example is shown, not filled in
    case "prompt": return spec.example ? "" : spec.default ?? "";
    case "model": return spec.default ?? options?.[0] ?? "";
    case "loras": return spec.default ?? [];
    case "size": {
      const s = spec.shapes.find((x) => x.id === spec.default) ?? spec.shapes[0]!;
      return { width: s.width, height: s.height };
    }
    case "number":
    case "toggle": return spec.default;
    // a file choice starts on a file this ComfyUI has
    case "choice": return pickChoice(spec, options);
    case "seed": return RANDOM_SEED;
    case "image": return undefined;
    case "clip": return undefined;
    case "references": return [];
    case "audio": return undefined;
    case "cues": return [];
  }
}

/** A form's recipe, as far as its start needs it. */
export interface FormRecipe { family: string; inputs: InputSpec[]; presets?: readonly Preset[]; starts?: readonly StartRule[] }

/** What a form is worked out with of its recipe's status here: what each input offers, and the files its family uses. */
export type FormSetup = { options?: Record<string, string[]>; slots?: Record<string, string> } | undefined;

/** What a draft holds, without the 0s older drafts saved for "the recipe picks it": those settings follow the form. */
export const ownValues = (recipe: Pick<FormRecipe, "inputs">, stored: Record<string, unknown> | undefined): Record<string, unknown> =>
  stored ? withoutOldZeros(recipe.inputs, stored) : {};

/**
 * Starting values for a form, with the per-model settings of its model file laid over the recipe's defaults (the values
 * saved for it, else its line's presets), then what the choices made move, then what this setup makes right.
 */
export function formDefaults(
  recipe: FormRecipe,
  status: FormSetup,
  settings: ReadonlyArray<{ family: string; file: string; values: Record<string, unknown> }>,
  given: Record<string, unknown> | undefined,
) {
  const options = status?.options;
  const stored = ownValues(recipe, given);
  const base = Object.fromEntries(recipe.inputs.map((i) => [i.id, defaultOf(i, options?.[i.id])]));
  const modelInput = recipe.inputs.find((i) => i.type === "model");
  const file = modelInput ? String(stored?.[modelInput.id] ?? base[modelInput.id] ?? "") : "";
  // what was saved for this file, else what its line's authors recommend, read from its name (Pony, NoobAI v-pred, Krea…):
  // every preset that matches counts, each setting from the first that has it (an Illustrious DMD2 merge takes the
  // few-step sampling and Illustrious's quality tags)
  const { lined, perModel, hasSaved, notes } = modelStart(recipe, file, settings.find((s) => s.family === recipe.family && s.file === file)?.values ?? {});
  const layered = { ...base, ...lined, ...perModel };
  // last, what the choices made move (a hand detector picked: the denoise, crop and prompt start on hands); what the
  // draft holds is its own and stays, so only the settings still at their starting values follow the choice. What the
  // model's line or the values saved for it set stays too: a distilled H3 file's own shifts, not Turbo's usual ones
  const moved = Object.fromEntries(Object.entries(chosenDefaults(recipe.inputs, { ...layered, ...stored })).filter(([id]) => !(id in lined) && !(id in perModel)));
  // and what this setup makes right (Recipe.starts): with MiniMax's 4-step reference LoRA a reference clip's Turbo runs
  // 4 steps at its shifts, whatever the model's line or the values saved for the usual model say
  const ruled = ruledDefaults(recipe.starts, { ...layered, ...moved, ...stored }, status?.slots ?? {});
  return { defaults: { ...layered, ...moved, ...ruled }, file, hasSaved, preset: notes.length ? notes.join(" · ") : undefined, fromLine: Object.keys(lined) };
}

/** The form as it is sent: what it starts on, with what is stored over it, only the inputs the recipe has (a draft outlives a workflow changed since). */
export function sentForm(recipe: Pick<FormRecipe, "inputs">, defaults: Record<string, unknown>, stored: Record<string, unknown> | undefined): Record<string, unknown> {
  const input: Record<string, unknown> = { ...defaults, ...stored };
  const has = new Set(recipe.inputs.map((i) => i.id));
  for (const id of Object.keys(input)) if (input[id] === undefined || !has.has(id)) delete input[id];
  return input;
}

/**
 * What stops a form from being sent, in the user's words, or null: a picture, a clip or a sound it must have and has not
 * (by its label), or a prompt that only shows an example (nothing is made from somebody else's text by accident).
 * Reference lists may stay empty.
 */
export function notFilled(recipe: Pick<FormRecipe, "inputs">, input: Record<string, unknown>): string | null {
  const empty = (v: unknown) => v === undefined || v === null || v === "";
  const media = recipe.inputs.find((i) => (i.type === "image" || i.type === "clip" || i.type === "audio") && !i.optional && empty(input[i.id]));
  if (media) return `Select the ${media.label.toLowerCase()} first.`;
  const unwritten = recipe.inputs.find((i) => i.type === "prompt" && i.example && !String(input[i.id] ?? "").trim());
  if (unwritten) return `Fill in the ${unwritten.label.toLowerCase()} first.`;
  return null;
}

const baseName = (f: string) => (f.split(/[\\/]/).pop() ?? f).toLowerCase();

/**
 * A preset's model files, as this ComfyUI names them: a preset made elsewhere says "model.safetensors",
 * ComfyUI here may keep it as "High\\model.safetensors". The same file by name is taken for the same file.
 */
export function matchFiles(recipe: Pick<FormRecipe, "inputs">, options: Record<string, string[]> | undefined, inputs: Record<string, unknown>): Record<string, unknown> {
  const out = { ...inputs };
  for (const i of recipe.inputs) {
    if (i.type !== "model" || typeof out[i.id] !== "string") continue;
    const list = options?.[i.id] ?? [];
    const value = out[i.id] as string;
    if (!list.includes(value)) {
      const same = list.find((o) => baseName(o) === baseName(value));
      if (same) out[i.id] = same;
    }
  }
  return out;
}
