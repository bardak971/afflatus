import { plural, type InputSpec, type ReferenceValue } from "@afflatus/core";
import type { ClipPatch, RecipeInfo, Take, TakeMade } from "../api";
import { mainTextOf } from "../form";
import { PIN_WORDS, pinInputs, type PinWhere } from "./model";

/**
 * What a take was made with, against the clip's form as it stands (card #89): the form is the next render's settings, and
 * picking another take never changes it. Each take says what it was made with, read from its own render (`Take.made`), and
 * how that differs from the form, so that nobody takes a take for what the form shows.
 */

/** The parts of a form a take's line names one by one: its pinned frames, references, sounds; the rest is counted. */
type Kind = "pin" | "references" | "sound" | "prompt" | "setting";

/** What a take was made with, as its card shows it: its pinned frames, references, voice or sound, and the prompt it was sent. */
export interface MadeShown {
  pins: Array<{ where: PinWhere; word: string; asset: string | null; mirrored: boolean }>;
  references: ReferenceValue[];
  sounds: Array<{ word: string; asset: string; part: { start: number; seconds: number } | null }>;
  prompt: string | null;
}

/** How a take differs from the form: the form it was made with when another, else the parts that differ. Empty: the same. */
export interface MadeDiff {
  /** The take was made with another form (its title): nothing else is compared. */
  otherForm: string | null;
  /** The parts named one by one: "first frame", "1 reference", "voice sample". */
  parts: string[];
  /** Its prompts that differ, by their words ("prompt", "negative prompt"). */
  prompts: string[];
  /** The other settings that differ, by their labels. */
  settings: string[];
}

/** The inputs a take's form is compared on and given back with: what a person sets on the clip's form. */
function formSpecs(recipe: RecipeInfo): InputSpec[] {
  // a source's part is its cut's (the windows around it join there), as the server's madeOf leaves it out
  const sourcePart = recipe.inputs.flatMap((i) => (i.type === "clip" && i.role === "source" && i.window ? [i.window.start, i.window.seconds] : []));
  return recipe.inputs.filter((i) => !i.internal && !(i.type === "clip" && i.role !== "source") && !(i.type === "image" && i.role === "face") && !sourcePart.includes(i.id));
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The number inputs that place a voice or a sound in its recording (its part): they are that sound's, not settings of their own. */
function soundParts(recipe: RecipeInfo): Map<string, string> {
  const of = new Map<string, string>();
  for (const i of recipe.inputs) if (i.type === "audio" && i.window) for (const id of [i.window.start, i.window.seconds]) of.set(id, i.id);
  return of;
}

function kindOf(spec: InputSpec, recipe: RecipeInfo, pins: ReturnType<typeof pinInputs>): Kind {
  if (spec.id === pins.start || spec.id === pins.end || spec.id === pins.mid || spec.id === pins.midAt) return "pin";
  if (spec.type === "references") return "references";
  if (spec.type === "audio" || spec.type === "cues" || soundParts(recipe).has(spec.id)) return "sound";
  if (spec.type === "prompt") return "prompt";
  return "setting";
}

/** The word of a sound input, as the take's line says it. */
const soundWord = (spec: InputSpec | undefined) => (spec?.type === "audio" ? (spec.role === "voice" ? "voice sample" : "sound") : spec?.type === "cues" ? "sound cues" : "sound");

/** What a take was made with, to show: from its own render, never from the clip's form. */
export function madeShown(made: TakeMade, recipe: RecipeInfo): MadeShown {
  const pins = pinInputs(recipe);
  const f = made.form;
  const shownPins = (["start", "mid", "end"] as const).flatMap((where): MadeShown["pins"] => {
    const id = pins[where];
    if (!id) return [];
    if (where === "start" && made.carried) return [{ where, word: "first frame: the clip before's", asset: null, mirrored: false }];
    const asset = f[id];
    return typeof asset === "string" && asset ? [{ where, word: PIN_WORDS[where], asset, mirrored: made.mirror.includes(id) }] : [];
  });
  // its pictures, and its videos where the model takes those too (H3's)
  const references = recipe.inputs.flatMap((i) => (i.type === "references" && Array.isArray(f[i.id]) ? (f[i.id] as ReferenceValue[]) : []));
  const sounds = recipe.inputs.flatMap((i) => {
    if (i.type !== "audio" || typeof f[i.id] !== "string" || !f[i.id]) return [];
    const part = i.window && typeof f[i.window.start] === "number" && typeof f[i.window.seconds] === "number" ? { start: f[i.window.start] as number, seconds: f[i.window.seconds] as number } : null;
    return [{ word: soundWord(i), asset: f[i.id] as string, part }];
  });
  const main = mainTextOf(recipe);
  const prompt = main && typeof f[main.id] === "string" && (f[main.id] as string).trim() ? (f[main.id] as string) : null;
  return { pins: shownPins, references, sounds, prompt };
}

/**
 * How a take differs from the clip's form as it stands. `whole`: the form with its defaults, as a render would send it;
 * `carries`: the clip carries on from the clip before (its first frame is that clip's). The seed is not compared: a form
 * that draws one, or moves it on after each render, would make every take differ.
 */
export function madeDiff(made: TakeMade, form: { recipe: RecipeInfo | undefined; whole: Record<string, unknown>; carries: boolean }, recipes: RecipeInfo[]): MadeDiff {
  const none: MadeDiff = { otherForm: null, parts: [], prompts: [], settings: [] };
  if (made.recipe !== form.recipe?.id) return { ...none, otherForm: recipes.find((r) => r.id === made.recipe)?.title ?? made.recipe };
  const recipe = form.recipe;
  const pins = pinInputs(recipe);
  const parts = soundParts(recipe);
  const pinsDiffer = new Set<PinWhere>();
  let refs = 0;
  const sounds = new Set<string>();
  const prompts: string[] = [];
  const settings: string[] = [];
  const main = mainTextOf(recipe);
  for (const spec of formSpecs(recipe)) {
    if (spec.type === "seed") continue;
    const kind = kindOf(spec, recipe, pins);
    if (kind === "pin") {
      const where: PinWhere = spec.id === pins.start ? "start" : spec.id === pins.end ? "end" : "mid";
      // a first frame carried on from the clip before is no picture of the form's, on either side
      const take = where === "start" && made.carried ? null : made.form[spec.id];
      const now = where === "start" && form.carries ? null : form.whole[spec.id];
      // a keyframe's moment is the keyframe's: only said when a keyframe is pinned on either side
      if (spec.id === pins.midAt) {
        if (pins.mid && (made.form[pins.mid] || form.whole[pins.mid]) && spec.id in made.form && !same(take, now)) pinsDiffer.add("mid");
      } else if (!same(take || null, now || null)) pinsDiffer.add(where);
      continue;
    }
    // an input the take's render did not have (added to the model since) says nothing of it
    if (!(spec.id in made.form)) continue;
    if (same(made.form[spec.id], form.whole[spec.id])) continue;
    if (kind === "references") {
      const key = (r: ReferenceValue) => `${r.asset}:${r.role}`;
      const was = (Array.isArray(made.form[spec.id]) ? (made.form[spec.id] as ReferenceValue[]) : []).map(key);
      const now = (Array.isArray(form.whole[spec.id]) ? (form.whole[spec.id] as ReferenceValue[]) : []).map(key);
      // pictures swapped, added or taken out, a role changed: the most of either side not found in the other; the same set in another order, 1
      refs += Math.max(was.filter((k) => !now.includes(k)).length, now.filter((k) => !was.includes(k)).length) || 1;
    } else if (kind === "sound") sounds.add(soundWord(recipe.inputs.find((i) => i.id === (parts.get(spec.id) ?? spec.id))));
    else if (kind === "prompt") prompts.push(spec.id === main?.id ? "prompt" : spec.label.toLowerCase());
    else settings.push(spec.label);
  }
  const pinWords = (["start", "mid", "end"] as const).filter((w) => pinsDiffer.has(w)).map((w) => PIN_WORDS[w]);
  return { otherForm: null, parts: [...pinWords, ...(refs ? [plural(refs, "reference")] : []), ...sounds], prompts, settings };
}

export const differs = (d: MadeDiff) => Boolean(d.otherForm || d.parts.length || d.prompts.length || d.settings.length);

/** "a, b and c" */
const listed = (words: string[]) => (words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : words[0] ?? "");

/** How a take differs from the form, in a short line ("first frame and 1 reference differ · prompt changed"); null when it does not. */
export function diffWords(d: MadeDiff): string | null {
  if (d.otherForm) return `made with ${d.otherForm}`;
  // one part differs, else they differ: "2 references" is several
  const verb = (words: string[]) => (words.length === 1 && !/^([2-9]|\d\d+) /.test(words[0]!) ? "differs" : "differ");
  const said = [
    d.parts.length ? `${listed(d.parts)} ${verb(d.parts)}` : null,
    d.prompts.length ? `${listed(d.prompts)} changed` : null,
    d.settings.length ? `${plural(d.settings.length, "setting")} ${d.settings.length === 1 ? "differs" : "differ"}` : null,
  ].filter(Boolean);
  return said.length ? said.join(" · ") : null;
}

/**
 * The patch that puts a take's settings back into its clip's form (Use this take's settings), one Undo step: its form,
 * its seed, its pinned frames and their Mirror. What the form holds that the take's form does not say (a source's part,
 * what the timeline fills in) stays as it is; a pinned frame, reference or setting the take did not have is taken out.
 */
export function settingsPatch(take: Take & { made: TakeMade }, recipe: RecipeInfo, stored: Record<string, unknown>, carries: boolean): ClipPatch {
  const made = take.made;
  const own = new Set(formSpecs(recipe).map((i) => i.id));
  const pins = pinInputs(recipe);
  const inputs: Record<string, unknown> = Object.fromEntries(Object.entries(stored).filter(([id]) => !own.has(id) && recipe.inputs.some((i) => i.id === id)));
  for (const [id, value] of Object.entries(made.form)) if (own.has(id)) inputs[id] = value;
  // a take whose first frame was the clip before's: the form pins none, as a clip that carries on has none (and a take that
  // opened on a picture of its own, on a clip that carries on now, keeps it: it is the form's to say)
  if (made.carried && pins.start) delete inputs[pins.start];
  const pinMirror = Object.fromEntries([pins.start, pins.mid, pins.end].filter((id): id is string => Boolean(id)).map((id) => [id, made.mirror.includes(id) && typeof inputs[id] === "string" && !(id === pins.start && carries)]));
  return { recipe: made.recipe, inputs, pinMirror, settingsOf: take.id };
}
