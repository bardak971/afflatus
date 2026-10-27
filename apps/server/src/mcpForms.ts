import { formDefaults, madeAroundRecording, plural, sentForm, type InputSpec, type Recipe } from "@afflatus/core";
import type { RecipeStatus, Scan } from "@afflatus/comfy";
import { z } from "zod";
import { OWNER } from "./db";
import { builtInGuide, guideOf, guidedFamily } from "./designerPrompt";
import { findDraft } from "./drafts";
import { httpError } from "./errors";
import { familyOn, mergeScans } from "./machineScans";
import { quoted, tool, type ToolCtx } from "./mcpTool";
import { refusal } from "./mcpTokens";
import { dollars } from "./notifyWords";
import type { Services } from "./services";
import { readSettings, type Machine } from "./settings";

/**
 * The forms, from outside (MCP): every form the user can use and how each is filled, generated from the recipes'
 * own InputSpec (labels, "?" notes, options, ranges, presets), so that a form added later is in the MCP the day it
 * ships, in its own words; and what a form as it stands would take (estimate). The draft tools (mcpDrafts.ts) and the
 * render (mcpRender.ts) read the forms through the helpers here.
 */

const HOUR = 3_600_000;
/** The files listed of one input on one machine, at most: a LoRA folder can hold thousands. */
const FILES_SHOWN = 80;

/** What the machines offer, read once per call: each machine with its scan (null: it did not answer), and every one's together as the form reads it. */
export interface Seen {
  machines: Array<{ machine: Machine; scan: Scan | null }>;
  /** What every machine together offers each form (the web's /api/setup without a machine). */
  merged: Scan | null;
  settings: Awaited<ReturnType<typeof readSettings>>;
}

export async function seen(s: Services): Promise<Seen> {
  const [all, settings] = await Promise.all([s.machines(), readSettings(s.db)]);
  const machines = await Promise.all(all.map(async ({ machine, comfy }) => ({ machine, scan: await comfy.scan(false).catch(() => null) })));
  const scans = machines.filter((m): m is { machine: Machine; scan: Scan } => m.scan !== null);
  const merged = scans.length ? mergeScans(scans, settings, (id) => s.registry.recipe(id)?.family) : null;
  return { machines, merged, settings };
}

/** A form's status where it is filled: what each input offers on the machines, and the files its family uses. */
export const statusOf = (seen: Seen, recipe: string): RecipeStatus | undefined => seen.merged?.recipes.find((r) => r.id === recipe);

/** Whether a form's family is on: on at least one machine, as the page's lists offer it (web data.ts useFamilies). */
export function familyIsOn(s: Services, seen: Seen, family: string): boolean {
  const found = (scan: Scan | null) => Boolean(scan?.recipes.some((r) => r.ready && s.registry.recipe(r.id)?.family === family));
  if (!seen.machines.length) return seen.settings.families[family] ?? true;
  return seen.machines.some((m) => familyOn(seen.settings, m.machine, family, found(m.scan)));
}

/** A form by its id, as the tools take it: refused with where to find the ids when there is none. */
export function formOf(s: Services, id: string): Recipe<any> {
  const recipe = s.registry.recipe(id);
  if (!recipe) throw httpError(`There is no form called ${id}: list_forms gives the ids.`, 404);
  return recipe;
}

/** The inputs a form shows: the ones the app sets itself are left out. */
export const shownInputs = (recipe: Recipe<any>): InputSpec[] => (recipe.inputs as InputSpec[]).filter((i) => !i.internal);

/** What a value of an input is, in a few words, for an agent filling it. */
function valueOf(spec: InputSpec): string {
  switch (spec.type) {
    case "prompt": return "text";
    case "model": return "a file name as listed in models";
    case "loras": return "[{ file, weight }] with file as listed in models";
    case "size": return "{ width, height } in pixels";
    case "number": return "a number";
    case "toggle": return "true or false";
    case "choice": return "one of the options";
    case "seed": return "a whole number; -1 draws a new seed for every render";
    case "image": return "a library item id (a picture)";
    case "clip": return "{ asset: a library item id (a video), at?: ms }";
    case "references": return `[{ asset: a library item id${spec.media === "video" ? " (a video)" : " (a picture)"}, role }]`;
    case "audio": return "a library item id (a sound, or a video with sound)";
    case "cues": return "[{ asset, start, seconds, at }] in seconds";
  }
}

/** One input as describe_form says it: its words and its range, from its InputSpec. */
export function inputSaid(spec: InputSpec, options?: string[]) {
  const common = {
    id: spec.id, type: spec.type, label: spec.label, value: valueOf(spec),
    ...(spec.note ? { note: spec.note } : {}),
    ...(spec.advanced ? { advanced: true } : {}),
    ...(spec.chapter ? { chapter: spec.chapter } : {}),
    ...(spec.perModel ? { perModel: true } : {}),
    ...(spec.showWhen ? { showWhen: spec.showWhen } : {}),
  };
  switch (spec.type) {
    case "prompt":
      return { ...common, style: spec.style, ...(spec.optional ? { optional: true } : {}), ...(spec.line ? { line: true } : {}), ...(spec.example ? { example: spec.default } : spec.default ? { default: spec.default } : {}), ...(spec.weights === false ? { weights: false } : {}) };
    case "model":
      return { ...common, folder: spec.folder, ...(spec.slot ? { optional: true, leftOut: "the family's usual file" } : {}), ...(spec.default ? { default: spec.default } : {}) };
    case "loras":
      return { ...common, max: spec.max, ...(spec.default?.length ? { default: spec.default } : {}) };
    case "size":
      return { ...common, shapes: spec.shapes, default: spec.default, grid: spec.grid, min: spec.min, max: spec.max, ...(spec.ratioOnly ? { ratioOnly: true } : {}), ...(spec.maxPixels ? { maxPixels: spec.maxPixels } : {}) };
    case "number":
      return { ...common, min: spec.min, max: spec.max, step: spec.step, default: spec.default, ...(spec.unit ? { unit: spec.unit } : {}), ...(spec.picks ? { picks: spec.picks } : {}), ...(spec.auto ? { zero: spec.auto } : {}) };
    case "toggle":
      return { ...common, default: spec.default, ...(spec.captions ? { captions: spec.captions } : {}) };
    case "choice":
      return { ...common, options: Array.isArray(spec.options) ? [...(spec.extra ?? []), ...spec.options] : (options ?? []).slice(0, FILES_SHOWN), default: spec.default };
    case "seed":
      return { ...common, default: -1 };
    case "image":
      return { ...common, role: spec.role, ...(spec.optional || spec.opensOnly ? { optional: true } : {}) };
    case "clip":
      return { ...common, role: spec.role, ...(spec.optional ? { optional: true } : {}) };
    case "references":
      return { ...common, max: spec.max, roles: spec.roles };
    case "audio":
      return { ...common, role: spec.role, ...(spec.optional ? { optional: true } : {}), ...(spec.window ? { part: { start: spec.window.start, seconds: spec.window.seconds } } : {}) };
    case "cues":
      return { ...common, max: spec.max };
  }
}

/** The Prompt kit's presets: the user's own, then the ones that ship with Afflatus (read-only). */
export async function kitPresets(s: Services): Promise<Array<{ id: string; name: string; recipe?: string; inputs: Record<string, unknown>; look: unknown; shipped: boolean }>> {
  const rows = await s.db.selectFrom("entities").select(["id", "name", "def"]).where("owner_id", "=", OWNER).where("kind", "=", "preset").orderBy("name").execute();
  const own = rows.map((r) => {
    const def = JSON.parse(r.def) as { recipe?: string; inputs?: Record<string, unknown>; look?: unknown };
    return { id: r.id, name: r.name, recipe: def.recipe, inputs: def.inputs ?? {}, look: def.look ?? null, shipped: false };
  });
  const shipped = s.shippedPresets.list().map((p) => {
    const e = s.shippedPresets.entity(p) as { id: string; name: string; def: { recipe?: string; inputs?: Record<string, unknown>; look?: unknown } };
    return { id: e.id, name: e.name, recipe: e.def.recipe, inputs: e.def.inputs ?? {}, look: e.def.look ?? null, shipped: true };
  });
  return [...own, ...shipped];
}

/** The per-model settings saved in Settings › Models (model_settings), as formDefaults reads them. */
export async function savedPerModel(s: Services, family: string): Promise<Array<{ family: string; file: string; values: Record<string, unknown> }>> {
  const rows = await s.db.selectFrom("model_settings").select(["family", "file", "values"]).where("owner_id", "=", OWNER).where("family", "=", family).execute();
  return rows.map((r) => ({ family: r.family, file: r.file, values: JSON.parse(r.values) as Record<string, unknown> }));
}

/** A form as it would be sent: what it starts on here (as the form on screen starts it), with what is stored over it. */
export async function wholeOf(s: Services, seen: Seen, recipe: Recipe<any>, stored: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
  const status = statusOf(seen, recipe.id);
  const { defaults } = formDefaults(recipe, status, await savedPerModel(s, recipe.family), stored);
  return sentForm(recipe, defaults, stored);
}

/** Whether the token may use rented pods: Spend ticked. */
export const spends = (ctx: ToolCtx) => ctx.token.scopes.includes("spend");

/** A machine by id or name, as the tools take it: refused with the ids there are when there is none. */
export function machineOf(seen: Seen, asked: string): Machine {
  const m = seen.machines.find((x) => x.machine.id === asked) ?? seen.machines.find((x) => x.machine.name.toLowerCase() === asked.toLowerCase());
  if (!m) throw httpError(`There is no machine called ${asked}: ${seen.machines.length ? `the machines are ${seen.machines.map((x) => `${x.machine.id} (${machineName(x.machine)})`).join(", ")}` : "no machine is set up"}.`, 404);
  return m.machine;
}

/** A machine's name as the app says it: its own, else this PC's ComfyUI. */
export const machineName = (m: Machine) => m.name || (m.rented ? "a rented pod" : "this PC's ComfyUI");

/**
 * What a form as it stands would take, as Generate says it: its time from the user's own renders (render_stats), on each
 * machine that can take it, and what it costs on a rented pod (its length at the pod's rate). `machine`: pinned there; left
 * out, the queue picks among the machines this token may use (a token without Spend: the user's own only). Null figures
 * when nothing like it was rendered here yet.
 */
export async function estimateOf(s: Services, seen: Seen, ctx: ToolCtx, recipe: Recipe<any>, input: Record<string, unknown>, takes: number, machine?: Machine) {
  const got = await s.queue.forecast(recipe.id, input).catch(() => null);
  const rates = new Map(seen.machines.flatMap(({ machine: m }) => (m.rented ? [[m.id, s.rented.view(m)?.rate ?? null] as const] : [])));
  const allowed = seen.machines.map((m) => m.machine).filter((m) => (machine ? m.id === machine.id : spends(ctx) || !m.rented));
  const onEach = allowed.map((m) => {
    const f = got?.on?.[m.id] ?? (seen.machines.length < 2 && got ? got.forecast : undefined);
    const ms = f ? f.ms + f.loadMs : null;
    const rate = m.rented ? rates.get(m.id) ?? null : null;
    return { id: m.id, name: machineName(m), rented: Boolean(m.rented), msEach: ms, ...(m.rented ? { usdPerHour: rate, usdEach: ms !== null && rate !== null ? Math.round((ms / HOUR) * rate * 1000) / 1000 : null } : {}) };
  });
  const soonest = onEach.filter((m) => m.msEach !== null).sort((a, b) => a.msEach! - b.msEach!)[0];
  // the load counted once for the batch, as Generate's "about" counts it
  const loadMs = got?.forecast.loadMs ?? 0;
  const total = soonest?.msEach != null ? soonest.msEach * takes - loadMs * (takes - 1) : null;
  const findings = await s.queue.setCheck(recipe.id, input).catch(() => []);
  return {
    takes,
    time: total !== null ? { totalMs: Math.round(total), eachMs: soonest!.msEach, on: soonest!.name, from: `${plural(got?.forecast.samples ?? 0, "render")} like it here` } : null,
    machines: onEach,
    rentedCost: onEach.some((m) => m.rented) ? onEach.filter((m) => m.rented).map((m) => ({ machine: m.name, usd: "usdEach" in m && m.usdEach != null ? dollars(m.usdEach * takes) : "not known yet" })) : null,
    modelSet: findings.length ? findings : "the files go together",
    refused: findings.some((f) => (f as { black?: boolean }).black) ? "Render would refuse this mix of files (it gives black frames)." : null,
  };
}

const listForms = tool({
  name: "list_forms",
  scope: "look",
  title: "Forms",
  description: "Every form the user can use in Studio › Create, by model family: its id (what the other tools take), its title, what it makes (image, video, audio) and whether its files are ready on a machine. Families switched off in Settings › Models are named apart.",
  async run(_args, ctx) {
    const { s } = ctx;
    const at = await seen(s);
    const recipes = s.registry.recipes().filter((r) => !r.hidden);
    const out = s.registry.families().map((f) => ({
      family: f.id, name: f.name, summary: f.summary, on: familyIsOn(s, at, f.id), ...(f.imported ? { imported: true } : {}),
      forms: recipes.filter((r) => r.family === f.id).map((r) => ({
        id: r.id, title: r.title, summary: r.summary, makes: r.output,
        ready: at.machines.some((m) => m.scan?.recipes.find((x) => x.id === r.id)?.ready),
      })),
    })).filter((f) => f.forms.length);
    const on = out.filter((f) => f.on);
    ctx.said(`Listed the forms: ${plural(on.reduce((n, f) => n + f.forms.length, 0), "form")} in ${plural(on.length, "family", "families")}`);
    return { families: on, off: out.filter((f) => !f.on).map((f) => f.name) };
  },
});

const describeForm = tool({
  name: "describe_form",
  scope: "look",
  title: "Describe a form",
  description: "One form in full, as Create shows it: each input (id, type, label, its \"?\" note, options, range, default, optional, advanced, chapter); its presets (the model's line presets by file name, and the Prompt kit's presets for it); the prompt guide Afflatus's designer writes this form's prompt by (the form's own, the recording guide, the family's, or the user's own from Settings); and the model files and LoRAs each machine has for it.",
  input: { form: z.string().min(1).describe("The form's id, from list_forms (\"sdxl.text-to-picture\").") },
  async run({ form }, ctx) {
    const { s } = ctx;
    const recipe = formOf(s, form);
    const at = await seen(s);
    const family = s.registry.family(recipe.family);
    const guided = guidedFamily(family, at.settings);
    const own = Boolean(family && at.settings.designerGuides[family.id]?.trim());
    const status = statusOf(at, recipe.id);
    const presets = (await kitPresets(s)).filter((p) => !p.recipe || p.recipe === recipe.id);
    const fileInputs = shownInputs(recipe).filter((i) => i.type === "model" || i.type === "loras");
    ctx.said(`Described ${quoted(recipe.title)}`);
    return {
      id: recipe.id, title: recipe.title, summary: recipe.summary, makes: recipe.output, family: family ? { id: family.id, name: family.name, promptStyle: family.promptStyle, ...(family.help ? { help: family.help } : {}) } : recipe.family,
      inputs: shownInputs(recipe).map((i) => inputSaid(i, status?.options[i.id])),
      ...(recipe.chapters?.length ? { chapters: recipe.chapters } : {}),
      presets: {
        byModel: (recipe.presets ?? []).map((p) => ({ fileMatches: p.match, values: p.values, ...(p.note ? { note: p.note } : {}) })),
        kit: presets.map((p) => ({ id: p.id, name: p.name, sets: Object.keys(p.inputs), ...(p.recipe ? {} : { anyForm: true }), ...(p.shipped ? { shipped: true } : {}) })),
      },
      prompt: {
        guide: guideOf(recipe, guided, madeAroundRecording(recipe.inputs as InputSpec[]) ? "lipSync" : undefined),
        from: recipe.guide ? "the form's own guide" : own ? "the user's own guide (Settings › Designer)" : family?.guide ? "the family's guide" : "the generic guide",
        ...(family?.recordingGuide ? { underRecording: { lipSync: family.recordingGuide.lipSync, over: family.recordingGuide.over } } : {}),
        ...(own && family ? { builtIn: builtInGuide(family) } : {}),
      },
      machines: at.machines.map(({ machine, scan }) => {
        const st = scan?.recipes.find((r) => r.id === recipe.id);
        return {
          id: machine.id, name: machineName(machine), rented: Boolean(machine.rented), online: Boolean(scan?.comfy.online), ready: Boolean(st?.ready),
          ...(st && !st.ready ? { missing: [...st.missingSlots, ...st.missingFiles, ...st.missingNodes] } : {}),
          models: Object.fromEntries(fileInputs.map((i) => {
            const list = st?.options[i.id] ?? [];
            return [i.id, list.length > FILES_SHOWN ? { files: list.slice(0, FILES_SHOWN), more: list.length - FILES_SHOWN } : list];
          })),
        };
      }),
    };
  },
});

/** A draft or a form with values, as estimate and render take them. */
export const formArgs = {
  draft: z.string().min(1).optional().describe("A draft's id (list_drafts, whats_open): its form as it stands."),
  form: z.string().min(1).optional().describe("Or a form's id, with values."),
  values: z.record(z.string(), z.unknown()).optional().describe("With form: the inputs by id (describe_form); the rest start as the form starts them."),
};

const estimate = tool({
  name: "estimate",
  scope: "look",
  title: "Estimate",
  description: "What rendering a draft as it stands (or a form with values) would take, as Generate says it: the time from the user's own past renders on each machine this token may use, what it would cost on a rented pod, and the model set check (files that do not go together; a mix that gives black frames is refused at Render). Null times: nothing like it was rendered here yet.",
  input: { ...formArgs, takes: z.number().int().min(1).max(8).optional().describe("How many takes (1–8); a draft's own batch when left out."), machine: z.string().optional().describe("A machine's id (overview); left out, the queue picks.") },
  async run(args, ctx) {
    const { s } = ctx;
    const at = await seen(s);
    const { recipe, stored, count, name } = await formAsked(s, args);
    const input = await wholeOf(s, at, recipe, stored);
    const machine = args.machine ? machineOf(at, args.machine) : undefined;
    const takes = args.takes ?? count;
    const got = await estimateOf(s, at, ctx, recipe, input, takes, machine);
    ctx.said(`Estimated ${plural(takes, "take")} of ${quoted(name)}`);
    return got;
  },
});

/** The form a call names: a draft's (its form, values and batch), or a form with values. */
export async function formAsked(s: Services, args: { draft?: string; form?: string; values?: Record<string, unknown> }): Promise<{ recipe: Recipe<any>; stored: Record<string, unknown>; count: number; name: string; draft?: { id: string; look: unknown } }> {
  if (args.draft) {
    const d = await findDraft(s.db, args.draft);
    if (!d) throw httpError("There is no such draft: list_drafts gives the ids.", 404);
    const recipe = formOf(s, d.recipe_id);
    const forms = JSON.parse(d.forms) as Record<string, Record<string, unknown>>;
    return { recipe, stored: { ...forms[recipe.id], ...(args.values ?? {}) }, count: d.count, name: `“${d.name || d.title || "Untitled draft"}”`, draft: { id: d.id, look: d.look ? JSON.parse(d.look) : null } };
  }
  if (!args.form) throw refusal("Name a draft, or a form with its values.");
  const recipe = formOf(s, args.form);
  return { recipe, stored: args.values ?? {}, count: 1, name: recipe.title };
}

export const FORM_TOOLS = [listForms, describeForm, estimate];
