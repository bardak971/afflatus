import { chosenDefaults, frameOf, fuzzyScore, isShown, latentUpscaleSize, megapixels, pickChoice, RANDOM_SEED, secondsInput, type InputSpec, type LoraValue, type ReferenceValue, type SizeValue } from "@afflatus/core";
import type { ModelSettings, RecipeInfo } from "./api";
import { fileLabel, plural } from "./format";

/**
 * The inputs chosen that the Inputs part's folded line shows as small pictures: the frames and clips, by their library
 * item. A sound the result is made from (a lip sync's recording) has no picture: its name in the line says it is there.
 */
export function thumbsOf(chosen: InputSpec[], values: Record<string, unknown>): Array<{ key: string; id: string; label: string }> {
  return chosen.flatMap((i) => {
    if (i.type !== "image" && i.type !== "clip") return [];
    const v = values[i.id];
    const id = typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { asset?: unknown }).asset === "string" ? (v as { asset: string }).asset : null;
    return id ? [{ key: i.id, id, label: i.label }] : [];
  });
}

/** The value an input starts with, given what this ComfyUI offers for it. */
function defaultOf(spec: InputSpec, options: string[] | undefined): unknown {
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
  }
}

export const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const baseName = (f: string) => (f.split(/[\\/]/).pop() ?? f).toLowerCase();

/**
 * A preset's model files, as this ComfyUI names them: a preset made elsewhere says "model.safetensors",
 * ComfyUI here may keep it as "High\\model.safetensors". The same file by name is taken for the same file.
 */
export function matchFiles(recipe: RecipeInfo, options: Record<string, string[]> | undefined, inputs: Record<string, unknown>): Record<string, unknown> {
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

/**
 * What stops a form from being sent, in the user's words, or null: a picture, a clip or a sound it must
 * have and has not (by its label), or a prompt that only shows an example (nothing is made from somebody
 * else's text by accident). Reference lists may stay empty.
 */
export function notFilled(recipe: RecipeInfo, input: Record<string, unknown>): string | null {
  const empty = (v: unknown) => v === undefined || v === null || v === "";
  const media = recipe.inputs.find((i) => (i.type === "image" || i.type === "clip" || i.type === "audio") && !i.optional && empty(input[i.id]));
  if (media) return `Select the ${media.label.toLowerCase()} first.`;
  const unwritten = recipe.inputs.find((i) => i.type === "prompt" && i.example && !String(input[i.id] ?? "").trim());
  if (unwritten) return `Fill in the ${unwritten.label.toLowerCase()} first.`;
  return null;
}

/** The whole form as it is sent: the starting values for what was never touched, plus what the draft holds, less what the recipe no longer has. */
export function sentForm(recipe: RecipeInfo, defaults: Record<string, unknown>, stored: Record<string, unknown> | undefined): Record<string, unknown> {
  const input: Record<string, unknown> = { ...defaults, ...stored };
  // a draft outlives a workflow whose settings were changed since
  const has = new Set(recipe.inputs.map((i) => i.id));
  for (const id of Object.keys(input)) if (input[id] === undefined || !has.has(id)) delete input[id];
  return input;
}

/** The whole form: what it starts from (`formDefaults`), with what is stored over it. What a render or a load is sent from. */
export function wholeForm(
  recipe: RecipeInfo,
  options: Record<string, string[]> | undefined,
  settings: ModelSettings[],
  stored: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return { ...formDefaults(recipe, options, settings, stored).defaults, ...stored };
}

/**
 * What a form starts from, in two layers: the recipe's own defaults, then what was saved for the model
 * file that is picked. A draft holds only what differs from this, so a draft follows its model's
 * settings until something is changed on purpose.
 */
export function formDefaults(
  recipe: RecipeInfo,
  options: Record<string, string[]> | undefined,
  settings: ModelSettings[],
  stored: Record<string, unknown> | undefined,
) {
  const base = Object.fromEntries(recipe.inputs.map((i) => [i.id, defaultOf(i, options?.[i.id])]));
  const modelInput = recipe.inputs.find((i) => i.type === "model");
  const file = modelInput ? String(stored?.[modelInput.id] ?? base[modelInput.id] ?? "") : "";
  const saved = settings.find((s) => s.family === recipe.family && s.file === file)?.values ?? {};
  const hasSaved = Object.keys(saved).length > 0;
  // nothing saved for this file yet: what its line's authors recommend, read from its name (Pony, NoobAI v-pred, Krea…)
  const name = file.split(/[\\/]/).pop() ?? "";
  // Every preset that matches counts, each setting from the first that has it: an Illustrious DMD2 merge
  // takes the few-step sampling and Illustrious's quality tags.
  const matched = !hasSaved && name ? (recipe.presets ?? []).filter((p) => new RegExp(p.match, "i").test(name)) : [];
  const values: Record<string, unknown> = Object.assign({}, ...[...matched].reverse().map((p) => p.values));
  const lined = Object.fromEntries(recipe.inputs.filter((i) => i.id in values).map((i) => [i.id, values[i.id]]));
  const perModel = Object.fromEntries(recipe.inputs.filter((i) => i.perModel && i.id in saved).map((i) => [i.id, saved[i.id]]));
  const notes = matched.map((p) => p.note).filter(Boolean);
  const layered = { ...base, ...lined, ...perModel };
  // last, what the choices made move (a hand detector picked: the denoise, crop and prompt start on hands); what the
  // draft holds is its own and stays, so only the settings still at their starting values follow the choice. What the
  // model's line or the values saved for it set stays too: a distilled H3 file's own shifts, not Turbo's usual ones
  const moved = Object.entries(chosenDefaults(recipe.inputs, { ...layered, ...stored })).filter(([id]) => !(id in lined) && !(id in perModel));
  return { defaults: { ...layered, ...Object.fromEntries(moved) }, file, hasSaved, preset: notes.length ? notes.join(" · ") : undefined };
}

/**
 * What a form asks the server what it will take with: its settings, never its texts (typing asks nothing),
 * and only the inputs the recipe has (a draft can hold values of inputs a workflow no longer has, which
 * the server would refuse, and the estimate would vanish).
 */
export function settingsOnly(recipe: RecipeInfo, values: Record<string, unknown>): Record<string, unknown> {
  const kept = new Set(recipe.inputs.filter((i) => i.type !== "prompt").map((i) => i.id));
  return Object.fromEntries(Object.entries(values).filter(([k, v]) => kept.has(k) && v !== undefined));
}

/**
 * The frame a pass that enlarges ends at: the frame times the factor, on the 32-pixel grid the latent
 * upscale works on (and never under 64). The same rounding as the H3 latent re-sample's own.
 */
export const upscaledFrame = latentUpscaleSize;

/** The factor a size's enlarging pass is set to, or 0 while the pass is off. */
export const scaleOf = (spec: Extract<InputSpec, { type: "size" }>, values: Record<string, unknown> | undefined): number =>
  spec.scaledBy && values?.[spec.scaledBy.on] && values[spec.scaledBy.on] !== "Off" ? Number(values[spec.scaledBy.by] ?? 2) : 0;

/**
 * The text a form is about: the one that must be written, else its first text. A negative prompt is
 * never that: a tool whose only text is one (an upscale) has no main text, and no help to write it.
 */
export const mainTextOf = (recipe: RecipeInfo): InputSpec | undefined =>
  recipe.inputs.find((i) => i.type === "prompt" && !i.optional) ?? recipe.inputs.find((i) => i.type === "prompt" && i.id !== "negative");

/** The groups the settings are shown in, in order, and what each is about. */
type Group = "speed" | "upscale" | "file" | "rare";
/** Where a setting goes: what its recipe says, else what its name says. */
function groupOf(i: InputSpec): Group {
  if (i.section === "speed" || i.section === "file" || i.section === "rare") return i.section;
  if (i.section === "out") return "upscale";
  const id = i.id;
  if (/^upscale|^hires/i.test(id)) return "upscale";
  if (/fps|crf|smooth|encod|format|quality$|frame.?rate/i.test(id)) return "file";
  if (/preview|quick|^tile|loraStrength|sharpRefs|attention|offload|device|precision|cache(Threshold|Start|End|Steps)/i.test(id)) return "rare";
  return "speed";
}

/**
 * Whether a setting matches what is typed in the form's search. Forgiving on the name: a word as typed,
 * or its letters in order from the start of a word ("stps" finds Steps; "tile" does not find Dis-til-led);
 * the explanation, long, only counts when it says the words typed. Nothing typed: everything matches.
 */
export function matchesQuery(i: InputSpec, q: string): boolean {
  if (!q) return true;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return matchesText(`${i.label} ${i.id}${i.type === "number" ? ` ${i.unit ?? ""}` : ""}`, q) || (Boolean(i.note) && words.every((w) => i.note!.toLowerCase().includes(w)));
}

/**
 * The same forgiving match on a name, for what the form's search finds besides settings: the tools a screen adds
 * (Snippets, the Designer, Presets, the cast), each known by a few words.
 */
export function matchesText(text: string, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = text.toLowerCase();
  return words.every((w) => hay.includes(w) || [...hay.matchAll(/(?:^|[\s_\-./()[\]:·,])(\S)/g)].some((m) => m[1] === w[0] && fuzzyScore(w, hay.slice(m.index + m[0].length - 1)) !== null));
}

/**
 * Which input goes in which part of a form, with `q` (the search, trimmed) applied: the model and its
 * operation's own settings, the prompt and the other texts, the frames and the references, what comes out,
 * the settings by what they are about, the chapters an imported workflow arranges itself, and the
 * settings another setting hides that the search still finds. `seen` is what decides which settings show:
 * the values, plus what the screen fills in itself. `keepEmpty`: the recipe's chapters that hold nothing yet
 * stay (the import screen's preview, while sections are arranged).
 */
export function layoutOf(recipe: RecipeInfo, seen: Record<string, unknown>, q: string, keepEmpty = false) {
  // the two numbers that say which part of a sound is used are drawn with the sound, not as fields of their own
  const tucked = new Set(recipe.inputs.flatMap((i) => (i.type === "audio" && i.window ? [i.window.start, i.window.seconds] : [])));
  const shown = recipe.inputs.filter((i) => isShown(i, seen, recipe.inputs) && !tucked.has(i.id));
  // the chapters the recipe arranges itself (an imported workflow's sections): their inputs show there and nowhere else
  const chapters = (recipe.chapters ?? []).map((ch) => ({ ...ch, items: shown.filter((i) => i.chapter === ch.id) })).filter((ch) => ch.items.length || keepEmpty || ch.id === "advanced" || ch.id === "prompt");
  const rest = shown.filter((i) => !i.chapter);
  // where a LoRA's trigger words go, and the one text that is always open
  const mainText = mainTextOf(recipe);
  const hit = (i: InputSpec) => matchesQuery(i, q);
  const sought = <T extends InputSpec>(list: T[]): T[] => (q ? list.filter(hit) : list);
  // the negative prompt sits under the prompt in every form that has one, wherever its recipe filed it
  // (a form with no prompt of its own keeps it with its other settings)
  const underPrompt = (i: InputSpec) => i.type === "prompt" && i.id === "negative" && Boolean(mainText);
  const length = secondsInput(recipe.inputs);
  // a recipe can file a size or a seed under Advanced on purpose (an imported workflow leaves the shelves to its importer)
  const isOut = (i: InputSpec) => i.section !== "rare" && (i.section === "out" || i.type === "size" || i.type === "seed" || (i.type === "number" && (i.id === length?.id || i.unit?.trim() === "p")));
  const isMedia = (i: InputSpec) => i.type === "image" || i.type === "clip" || i.type === "references" || i.type === "audio";
  const front = rest.filter((i) => !i.advanced || underPrompt(i) || isMedia(i));
  // a setting up front that only shows with a picture (how a guide picture is followed) sits under that picture
  const mediaIds = new Set(rest.filter(isMedia).map((i) => i.id));
  const withMedia = (i: InputSpec) => !i.advanced && typeof i.showWhen === "string" && mediaIds.has(i.showWhen);
  // a sound the result is made from (a lip sync's recording, an imported workflow's sound) is an input like a frame, not
  // a reference: it sits first with them, and a missing one opens the part. A voice sample stays with the references
  const builtOn = (i: InputSpec): i is Extract<InputSpec, { type: "image" | "clip" | "audio" }> => i.type === "image" || i.type === "clip" || (i.type === "audio" && i.role === "sound");
  const pictures = rest.filter(builtOn);
  // an advanced setting filed under Output (a pass's denoise, a colour match) goes to the Output chapter's upscale
  // group by groupOf; only the shapes, the seed and the length stay out of the groups, on the Output shelf
  const tuning = sought(rest.filter((i) => i.advanced && !underPrompt(i) && !isMedia(i) && (!isOut(i) || i.section === "out")));
  const rare = tuning.filter((i) => groupOf(i) === "rare");
  return {
    chapters,
    // the recipe may say where Advanced and the prompt go among its chapters; without a word, Advanced is last and the prompt first
    advancedMoved: chapters.some((ch) => ch.id === "advanced"),
    promptMoved: chapters.some((ch) => ch.id === "prompt"),
    mainText,
    hit,
    sought,
    texts: sought(front.filter((i): i is Extract<InputSpec, { type: "prompt" }> => i.type === "prompt" && i.id !== mainText?.id)),
    // the inputs: the frames the clip is built on, and what it is shown
    frames: sought(pictures.flatMap((i) => [i, ...rest.filter((o) => withMedia(o) && o.showWhen === i.id)])),
    /** The picture and clip slots alone, without the settings that sit under them. */
    pictures: sought(pictures),
    refs: sought(rest.filter((i) => i.type === "references" || (i.type === "audio" && !builtOn(i)))),
    loras: sought(front.filter((i) => i.type === "loras")),
    out: sought(front.filter(isOut)),
    // the model's file and the operation's own settings (how much an img2img may redraw, which upscaler)
    knobs: sought(front.filter((i) => i.type === "model" || ((i.type === "number" || i.type === "toggle" || i.type === "choice") && !isOut(i) && !withMedia(i)))),
    // the settings, by what they are about
    sampling: tuning.filter((i) => groupOf(i) === "speed"),
    upscaling: tuning.filter((i) => groupOf(i) === "upscale"),
    encoding: tuning.filter((i) => groupOf(i) === "file"),
    rare,
    // the settings another setting hides (the upscale factor while the upscale is off): found too, with what shows them
    hidden: q ? recipe.inputs.filter((i) => !isShown(i, seen, recipe.inputs) && !tucked.has(i.id) && hit(i)) : [],
  };
}
export type FormLayout = ReturnType<typeof layoutOf>;

const holds = (x: unknown) => (Array.isArray(x) ? x.length > 0 : Boolean(x));

/**
 * What each part of a form holds, in a few words, for its folded line: the model, the inputs, what comes
 * out, how it samples. `madeSummary`, `lookSummary` and `frameSummary` are what the screen adds itself.
 */
export function summariesOf(recipe: RecipeInfo, layout: FormLayout, values: Record<string, unknown>, extra: { madeSummary?: string; lookSummary?: string; frameSummary?: string }) {
  const { knobs, loras, frames, pictures, refs, out, sampling } = layout;
  const said = (i: InputSpec): string => {
    const v = values[i.id];
    if (i.type === "model") return fileLabel(String(v ?? ""));
    if (i.type === "number") return `${i.label.toLowerCase()} ${v}${i.unit ?? ""}`;
    if (i.type === "toggle") return v ? i.label.toLowerCase() : "";
    if (i.type === "choice") return fileLabel(String(v ?? ""));
    return "";
  };
  const loraCount = loras.reduce((n, i) => n + ((values[i.id] as LoraValue[] | undefined)?.length ?? 0), 0);
  const framesChosen = pictures.filter((i) => values[i.id]);
  const missing = pictures.some((i) => !i.optional && !values[i.id]);
  const refsSaid = [
    extra.lookSummary,
    ...refs.map((i) => {
      const v = values[i.id];
      if (i.type === "references") return Array.isArray(v) && v.length ? plural((v as ReferenceValue[]).length, i.media === "video" ? "reference video" : "reference image") : "";
      return v ? i.label.toLowerCase() : "";
    }),
  ].filter(Boolean);
  const kind = recipe.output === "video" ? "vid" : recipe.output === "image" ? "img" : "audio";
  // "txt2vid" only when the render starts from words alone: with references or a cast it is made from those too
  const framesSaid = framesChosen.length ? framesChosen.map((i) => i.label.toLowerCase()).join(", ") : missing ? "nothing chosen yet" : frames.length && !refsSaid.length ? `txt2${kind}` : "";
  const outSaid = out.map((i) => {
    const v = values[i.id];
    if (i.type === "size") {
      const s = v as SizeValue | undefined;
      const shape = i.shapes.find((x) => x.width === s?.width && x.height === s?.height);
      if (!i.ratioOnly) return `${shape ? `${shape.label} ` : ""}${s?.width} × ${s?.height}`;
      // what the short side and the proportions give: a picture or a clip in the form decides instead
      const decided = (i.decidedBy ?? []).some((id) => holds(values[id]));
      const short = i.short ? Number(values[i.short]) : NaN;
      const frame = !decided && s && Number.isFinite(short) && short > 0 ? frameOf(s, short, { grid: i.grid, maxPixels: i.maxPixels ?? Infinity }) : null;
      const ratio = shape?.label ?? `${s?.width} : ${s?.height}`;
      const by = scaleOf(i, values);
      const big = frame && by ? upscaledFrame(frame, by) : null;
      const up = big ? ` → ${big.width} × ${big.height} · ${megapixels(big.width, big.height)}` : "";
      return frame ? `${ratio} · ${frame.width} × ${frame.height} · ${megapixels(frame.width, frame.height)}${up}` : decided ? "size of the input image" : ratio;
    }
    if (i.type === "seed") return Number(v ?? RANDOM_SEED) === RANDOM_SEED ? "seed: random" : `seed ${v}`;
    // a pass that enlarges: said with the frame, not on its own
    if (out.some((o) => o.type === "size" && (o.scaledBy?.on === i.id || o.scaledBy?.by === i.id))) return "";
    if (i.type === "toggle") return v ? i.label.toLowerCase() : "";
    if (i.type === "number") {
      // the short side is already in the frame said for the shape, unless a picture decides the shape
      const sizeOf = out.find((o): o is Extract<InputSpec, { type: "size" }> => o.type === "size" && o.short === i.id);
      const decided = (sizeOf?.decidedBy ?? []).some((id) => holds(values[id]));
      if (sizeOf && !decided) return "";
      return `${v}${i.unit ?? ""}`;
    }
    return "";
  }).filter(Boolean).join(" · ");
  const key = (id: string) => sampling.find((i) => i.id === id);
  const samplingSaid = [
    key("steps") ? `${values.steps} steps` : key("turboSteps") && values.fast ? `${values.turboSteps} steps` : "",
    key("fast") && values.fast ? "Turbo" : "",
    key("cfg") ? `CFG ${values.cfg}` : "",
    // a sampler left to the recipe says so: "Auto" alone would say nothing
    key("sampler") ? (values.sampler === "Auto" ? "sampler: auto" : fileLabel(String(values.sampler ?? ""))) : "",
  ].filter(Boolean).join(" · ") || plural(sampling.length, "setting");
  return {
    modelSaid: [extra.madeSummary, ...knobs.map(said), loraCount ? plural(loraCount, "LoRA") : ""].filter(Boolean).join(" · "),
    framesChosen,
    missing,
    refsCount: refsSaid.length,
    inputsSaid: [extra.frameSummary, framesSaid, ...refsSaid].filter(Boolean).join(" · ") || "none",
    outSaid,
    samplingSaid,
  };
}

/** The inputs of a list that differ from what the form starts from. */
export const changedIn = (list: InputSpec[], values: Record<string, unknown>, defaults: Record<string, unknown>) => list.filter((i) => !sameValue(values[i.id], defaults[i.id]));
