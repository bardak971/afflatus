import { frameOf, fuzzyScore, isShown, latentUpscaleSize, megapixels, RANDOM_SEED, secondsInput, formDefaults, ownValues, type FormSetup, type InputSpec, type LoraValue, type ReferenceValue, type SizeValue } from "@afflatus/core";
import type { ModelSettings, RecipeInfo } from "./api";

// what a form starts on is the server's too (an MCP render of a draft): kept in core (formStart.ts)
export { formDefaults, matchFiles, notFilled, ownValues, sentForm, type FormSetup } from "@afflatus/core";
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

export const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The whole form: what it starts from (`formDefaults`), with what is stored over it. What a render or a load is sent from. */
export function wholeForm(
  recipe: RecipeInfo,
  status: FormSetup,
  settings: ModelSettings[],
  stored: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return { ...formDefaults(recipe, status, settings, stored).defaults, ...ownValues(recipe, stored) };
}

/**
 * What saving a model's defaults keeps of a whole form: its per-model settings that differ from what the file starts on
 * with nothing saved, so that the ones left alone follow the recipe when its defaults change (Wan's Hybrid turbo stayed on
 * for every model saved while it was the default, card #109). What the file's line sets is kept even when unchanged: once
 * something is saved the line no longer applies, and its values would go. Empty when nothing differs: the file starts on
 * the same values with nothing saved.
 */
export function modelSaved(recipe: RecipeInfo, status: FormSetup, values: Record<string, unknown>): Record<string, unknown> {
  const { defaults, fromLine } = formDefaults(recipe, status, [], values);
  const line = new Set(fromLine);
  return Object.fromEntries(recipe.inputs.filter((i) => i.perModel && (line.has(i.id) || !sameValue(values[i.id], defaults[i.id]))).map((i) => [i.id, values[i.id]]));
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

/** The two numbers that say which part of a sound (or of a source video) is used: drawn with it, not as fields of their own. */
export const tuckedOf = (recipe: RecipeInfo): Set<string> =>
  new Set(recipe.inputs.flatMap((i) => ((i.type === "audio" || i.type === "clip") && i.window ? [i.window.start, i.window.seconds] : [])));

/**
 * Which input goes in which part of a form, with `q` (the search, trimmed) applied: the model and its
 * operation's own settings, the prompt and the other texts, the frames and the references, what comes out,
 * the settings by what they are about, the chapters an imported workflow arranges itself, and the
 * settings another setting hides that the search still finds. `seen` is what decides which settings show:
 * the values, plus what the screen fills in itself. `keepEmpty`: the recipe's chapters that hold nothing yet
 * stay (the import screen's preview, while sections are arranged).
 */
export function layoutOf(recipe: RecipeInfo, seen: Record<string, unknown>, q: string, keepEmpty = false) {
  const tucked = tuckedOf(recipe);
  const shown = recipe.inputs.filter((i) => isShown(i, seen, recipe.inputs) && !tucked.has(i.id));
  // the chapters the recipe arranges itself (an imported workflow's sections): their inputs show there and nowhere else
  const chapters = (recipe.chapters ?? []).map((ch) => ({ ...ch, items: shown.filter((i) => i.chapter === ch.id) })).filter((ch) => ch.items.length || keepEmpty || ch.id === "advanced" || ch.id === "prompt");
  const rest = shown.filter((i) => !i.chapter);
  // where a LoRA's trigger words go, and the one text that is always open
  const mainText = mainTextOf(recipe);
  const hit = (i: InputSpec) => matchesQuery(i, q);
  const sought = <T extends InputSpec>(list: T[]): T[] => (q ? list.filter(hit) : list);
  // every other text sits under the prompt in a form that has one, wherever its recipe filed it: the negative prompt, a
  // checkpoint's quality tags (put in front of the prompt, and filed as encoding by their name before, under a picture's
  // "Encode" heading), an instruction (a form with no prompt of its own keeps them with its other settings)
  const underPrompt = (i: InputSpec) => i.type === "prompt" && i.id !== mainText?.id && Boolean(mainText);
  const length = secondsInput(recipe.inputs);
  // a recipe can file a size or a seed under Advanced on purpose (an imported workflow leaves the shelves to its importer)
  const isOut = (i: InputSpec) => i.section !== "rare" && (i.section === "out" || i.type === "size" || i.type === "seed" || (i.type === "number" && (i.id === length?.id || i.unit?.trim() === "p")));
  const isMedia = (i: InputSpec) => i.type === "image" || i.type === "clip" || i.type === "references" || i.type === "audio" || i.type === "cues";
  const front = rest.filter((i) => !i.advanced || underPrompt(i) || isMedia(i));
  // a setting up front that only shows with a picture (how a guide picture is followed) sits under that picture
  const mediaIds = new Set(rest.filter(isMedia).map((i) => i.id));
  const withMedia = (i: InputSpec) => !i.advanced && typeof i.showWhen === "string" && mediaIds.has(i.showWhen);
  // a sound the result is made from (a lip sync's recording, an imported workflow's sound) is an input like a frame, not
  // a reference: it sits first with them, and a missing one opens the part. A voice sample stays with the references
  const builtOn = (i: InputSpec): i is Extract<InputSpec, { type: "image" | "clip" | "audio" | "cues" }> => i.type === "image" || i.type === "clip" || i.type === "cues" || (i.type === "audio" && i.role === "sound");
  const pictures = rest.filter(builtOn);
  // an advanced setting filed under Output (a pass's denoise, a colour match) goes to the Output chapter's upscale
  // group by groupOf; only the shapes, the seed and the length stay out of the groups, on the Output shelf
  const tunable = rest.filter((i) => i.advanced && !underPrompt(i) && !isMedia(i) && (!isOut(i) || i.section === "out"));
  const tuning = sought(tunable);
  const rare = tuning.filter((i) => groupOf(i) === "rare");
  // A picture's upscale pass is a second sampling pass (A1111's hires fix): it shows in Sampling, after the sampler, where
  // it is looked for. A video's stays in Output (the pass after the clip, the colour match, Face refine), and so does a
  // picture's when the form has no sampling of its own (an upscale tool's colour). Decided on the whole form, not on
  // what the search leaves, so that a setting found does not change part as the search is typed.
  const passInSampling = recipe.output === "image" && tunable.some((i) => groupOf(i) === "speed");
  const pass = tuning.filter((i) => groupOf(i) === "upscale");
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
    /** A picture's upscale pass (hires fix), drawn in Sampling after the sampler rows. */
    afterSampling: passInSampling ? pass : [],
    upscaling: passInSampling ? [] : pass,
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
export function summariesOf(recipe: RecipeInfo, layout: FormLayout, values: Record<string, unknown>, extra: { madeSummary?: string; lookSummary?: string; frameSummary?: string; off?: Record<string, string | { why: string; value: string }> }) {
  const { knobs, loras, frames, pictures, refs, out, sampling, afterSampling } = layout;
  const said = (i: InputSpec): string => {
    const v = values[i.id];
    if (i.type === "model") return fileLabel(String(v ?? ""));
    if (i.type === "number") return `${i.label.toLowerCase()} ${v}${i.unit ?? ""}`;
    if (i.type === "toggle") return v ? i.label.toLowerCase() : "";
    if (i.type === "choice") return fileLabel(String(v ?? ""));
    return "";
  };
  const loraCount = loras.reduce((n, i) => n + ((values[i.id] as LoraValue[] | undefined)?.length ?? 0), 0);
  const framesChosen = pictures.filter((i) => holds(values[i.id]));
  // (sound cues are a list, empty or not: never missing)
  const missing = pictures.some((i) => i.type !== "cues" && !i.optional && !values[i.id]);
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
    // set where the form is rather than by it (a clip under a recording: Duration, by its part): what stands for it
    const standIn = extra.off?.[i.id];
    if (standIn && typeof standIn !== "string") return standIn.value;
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
  // a picture's upscale pass, when it is on: "hires 1.5×", as A1111 says it
  const passOn = afterSampling.find((i) => i.type === "toggle" && Boolean(values[i.id]));
  const passBy = passOn && afterSampling.find((i) => i.type === "number" && i.unit?.trim() === "×" && i.showWhen === passOn.id);
  const passSaid = passOn ? [/^hires/i.test(passOn.id) ? "hires" : passOn.label.toLowerCase(), passBy ? `${values[passBy.id]}×` : ""].filter(Boolean).join(" ") : "";
  const samplingSaid = [
    key("steps") ? `${values.steps} steps` : key("turboSteps") && values.fast ? `${values.turboSteps} steps` : "",
    key("fast") && values.fast ? "Turbo" : "",
    key("cfg") ? `CFG ${values.cfg}` : "",
    // a sampler left to the recipe says so: "Auto" alone would say nothing
    key("sampler") ? (values.sampler === "Auto" ? "sampler: auto" : fileLabel(String(values.sampler ?? ""))) : "",
    passSaid,
  ].filter(Boolean).join(" · ") || plural(sampling.length + afterSampling.length, "setting");
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

/**
 * Whether a setting can be pinned to the top of its form (Pinned fields): what is set from one render to the next (a number,
 * a switch, a choice, the model, its LoRAs, the size, the seed). The texts have the prompt's card, the pictures, clips and
 * sounds the Inputs card; what the form never draws (an internal input) is not a setting of its own.
 */
export const pinnable = (i: InputSpec): boolean =>
  !i.internal && (i.type === "number" || i.type === "toggle" || i.type === "choice" || i.type === "model" || i.type === "loras" || i.type === "size" || i.type === "seed");

/**
 * Why a setting is not shown now, in a few words: the setting that hides it and what it is ("Hires fix is off", "Upscale is
 * None"), the first one up the chain of what shows it. Empty when it is shown, or hidden for no reason a value gives.
 */
export function whyHidden(spec: InputSpec, values: Record<string, unknown>, specs: readonly InputSpec[], seen: ReadonlySet<string> = new Set()): string {
  const w = spec.showWhen;
  if (!w || seen.has(spec.id)) return "";
  const id = typeof w === "string" ? w : w.input;
  const parent = specs.find((s) => s.id === id);
  const label = parent?.label ?? id;
  const v = values[id];
  const on = typeof w === "string" ? holds(v) : w.in.includes(v);
  if (!on) {
    if (v === true || v === false || parent?.type === "toggle") return `${label} is ${v ? "on" : "off"}`;
    if (typeof w === "string") return `${label} is not set`;
    return `${label} is ${fileLabel(String(v ?? ""))}`;
  }
  return parent ? whyHidden(parent, values, specs, new Set([...seen, spec.id])) : "";
}

/**
 * The section each setting is drawn in, by its input id, as the form names it in its strip: what a pinned copy says it is
 * a copy of ("· Sampling"). From the layout drawn without a search.
 */
export function sectionsOf(layout: FormLayout): Map<string, string> {
  const at = new Map<string, string>();
  const put = (list: InputSpec[], label: string) => { for (const i of list) if (!at.has(i.id)) at.set(i.id, label); };
  for (const ch of layout.chapters) put(ch.items, ch.label);
  put([...layout.knobs, ...layout.loras], "Model");
  put(layout.texts, "Prompt");
  put([...layout.frames, ...layout.refs], "Inputs");
  put([...layout.sampling, ...layout.afterSampling], "Sampling");
  put([...layout.out, ...layout.upscaling, ...layout.encoding], "Output");
  put(layout.rare, "Advanced");
  return at;
}

/** A pinned setting's value in a few words, for the Pinned card's folded line: "CFG scale 5", "Hires fix on". */
export function pinSaid(i: InputSpec, v: unknown): string {
  switch (i.type) {
    case "number": return `${i.label} ${Number(v ?? i.default)}${i.unit ?? ""}`;
    case "toggle": return `${i.label} ${v ? "on" : "off"}`;
    case "choice":
    case "model": return `${i.label} ${fileLabel(String(v ?? "")) || "none"}`;
    case "seed": return Number(v ?? RANDOM_SEED) === RANDOM_SEED ? `${i.label} random` : `${i.label} ${v}`;
    case "size": {
      const s = v as SizeValue | undefined;
      return s ? `${i.label} ${s.width} × ${s.height}` : i.label;
    }
    case "loras": return plural(Array.isArray(v) ? v.length : 0, "LoRA");
    default: return i.label;
  }
}
