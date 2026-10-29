import { matchFiles, ownValues, plural, schemaFor, type InputSpec, type Recipe } from "@afflatus/core";
import { z } from "zod";
import { createBody, createDraft, deleteDraft, draftsList, draftView, findDraft, saveDraft, type DraftView, type saveBody } from "./drafts";
import { emptyLook, lookSchema, type Look } from "./entities";
import { httpError } from "./errors";
import { formOf, kitPresets, seen, shownInputs, statusOf, wholeOf, type Seen } from "./mcpForms";
import { tool, type ToolCtx } from "./mcpTool";
import { refusal } from "./mcpTokens";
import type { Services } from "./services";

/**
 * The drafts, from outside (MCP): listed, read, made, edited and given a preset, through the drafts' own save
 * (drafts.ts saveDraft, the page's autosave path) and validated as the form validates them. Each change an agent makes
 * goes out as a "draft" live event (DraftEdit), so that a page with that draft open shows it at once, rings the fields
 * that changed with the token's name, and offers Undo (the web's agentEdits.ts).
 */

/** One field an agent changed in a draft's form: what it held before (`had` false: nothing, the form's start) and holds now (`gone`: taken out). */
export interface FieldEdit { form: string; input: string; had: boolean; was?: unknown; now?: unknown; gone?: true }

/**
 * What a "draft" live event says (events.ts relays it whole): the draft, the token behind it, the fields it changed with
 * their values before and after, and the form, cast, batch or name when those changed. The page lays `now` over what it
 * shows and puts `was` back on Undo. `made`: a draft just made (the lists read again; nothing is open on it yet).
 */
export interface DraftEdit {
  id: string;
  by: string;
  token: string;
  at: string;
  fields: FieldEdit[];
  recipe?: { was: string; now: string };
  look?: { was: Look | null; now: Look | null };
  count?: { was: number; now: number };
  name?: { was: string | null; now: string | null };
  made?: true;
  /**
   * When the draft was saved with it (its updatedAt then): a save of the page's answered with a later one was written after
   * it, over it, and the page saves the edit again.
   */
  saved?: string;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What changed between a draft before and after an agent's save: the event the open pages get. */
export function editOf(before: DraftView, after: DraftView, ctx: Pick<ToolCtx, "token">): DraftEdit {
  const fields: FieldEdit[] = [];
  for (const form of new Set([...Object.keys(before.forms), ...Object.keys(after.forms)])) {
    const was = before.forms[form] ?? {};
    const now = after.forms[form] ?? {};
    for (const input of new Set([...Object.keys(was), ...Object.keys(now)])) {
      if (same(was[input], now[input])) continue;
      fields.push({ form, input, had: input in was, ...(input in was ? { was: was[input] } : {}), ...(input in now ? { now: now[input] } : { gone: true as const }) });
    }
  }
  return {
    id: after.id, by: ctx.token.name, token: ctx.token.id, at: new Date().toISOString(), fields, saved: after.updatedAt,
    ...(before.recipe !== after.recipe ? { recipe: { was: before.recipe, now: after.recipe } } : {}),
    ...(!same(before.look, after.look) ? { look: { was: before.look, now: after.look } } : {}),
    ...(before.count !== after.count ? { count: { was: before.count, now: after.count } } : {}),
    ...(before.name !== after.name ? { name: { was: before.name, now: after.name } } : {}),
  };
}

/** How many things an edit changed, as the page's toast counts them ("Claude Code changed 3 fields"). */
export const changedCount = (e: DraftEdit) => e.fields.length + (e.recipe ? 1 : 0) + (e.look ? 1 : 0) + (e.count ? 1 : 0) + (e.name ? 1 : 0);

/** A draft's name as the lists say it. */
const nameOf = (d: Pick<DraftView, "name" | "title">) => `“${d.name || d.title || "Untitled draft"}”`;

/** What a library item must be to go into an input: a picture, a video, a sound (a video with sound too). */
function kindsFor(spec: InputSpec): { kinds: string[]; sound?: boolean; what: string } | null {
  switch (spec.type) {
    case "image": return { kinds: ["image"], what: "a picture" };
    case "clip": return { kinds: ["video"], what: "a video" };
    case "references": return spec.media === "video" ? { kinds: ["video"], what: "a video" } : { kinds: ["image"], what: "a picture" };
    case "audio":
    case "cues": return { kinds: ["audio", "video"], sound: true, what: "a sound (or a video with sound)" };
    default: return null;
  }
}

/** The library items a value names (a picture's id, a clip's asset, each reference's or cue's). */
function itemsIn(spec: InputSpec, value: unknown): string[] {
  if (typeof value === "string") return spec.type === "image" || spec.type === "audio" ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((v) => (v && typeof v === "object" && typeof (v as { asset?: unknown }).asset === "string" ? [(v as { asset: string }).asset] : []));
  if (value && typeof value === "object" && typeof (value as { asset?: unknown }).asset === "string") return [(value as { asset: string }).asset];
  return [];
}

/** A file asked for an input, as the machines name it: the same name in another folder is the same file; null when no machine has it. */
function fileThere(list: string[], file: string): string | null {
  if (list.includes(file)) return file;
  const base = (f: string) => (f.split(/[\\/]/).pop() ?? f).toLowerCase();
  return list.find((o) => base(o) === base(file)) ?? null;
}

/**
 * A value for one input, checked as the form checks it: an input the form shows, the value its InputSpec takes (zod, as
 * the render parses it), library items that are there and of the right kind, model files and LoRAs a machine has (when
 * the machines could be read). Answers the value as kept (a size put on its grid, a file named as the machines name it).
 */
export async function checkedValue(s: Services, at: Seen, recipe: Recipe<any>, id: string, value: unknown): Promise<unknown> {
  const spec = shownInputs(recipe).find((i) => i.id === id);
  if (!spec) throw httpError(`${recipe.title} has no input ${id}: its inputs are ${shownInputs(recipe).map((i) => i.id).join(", ")} (describe_form).`);
  const shape = schemaFor(recipe.inputs as InputSpec[]).shape as Record<string, z.ZodType>;
  const parsed = shape[id]!.safeParse(value);
  if (!parsed.success) throw httpError(`${spec.label} (${id}): ${parsed.error.issues.map((i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`).join("; ")}`);
  let kept = parsed.data;
  const items = itemsIn(spec, kept);
  const want = kindsFor(spec);
  if (items.length && want) {
    const rows = await s.db.selectFrom("assets").select(["id", "kind", "has_sound", "deleted_at"]).where("id", "in", items).execute();
    for (const item of items) {
      const a = rows.find((r) => r.id === item);
      if (!a || a.deleted_at) throw httpError(`${spec.label}: there is no library item ${item}${a ? " outside the bin" : ""}.`);
      if (!want.kinds.includes(a.kind) || (want.sound && a.kind === "video" && !a.has_sound)) throw httpError(`${spec.label} takes ${want.what}: ${item} is ${a.kind === "image" ? "a picture" : a.kind === "audio" ? "a sound" : a.has_sound ? "a video" : "a video without sound"}.`);
    }
  }
  // what the machines offer, when they could be read: an empty list then means none of them has any
  const status = at.merged?.comfy.online ? statusOf(at, recipe.id) : undefined;
  const offered = status?.options[id] ?? [];
  if (spec.type === "model" && typeof kept === "string" && offered.length) {
    const there = fileThere(offered, kept);
    if (!there) throw httpError(`${spec.label}: no machine has ${kept}. Its files are listed by describe_form (machines › models › ${id}).`);
    kept = there;
  }
  if (spec.type === "loras" && Array.isArray(kept) && status) {
    kept = (kept as Array<{ file: string; weight: number }>).map((l) => {
      const there = fileThere(offered, l.file);
      if (!there) throw httpError(`${spec.label}: no machine has the LoRA ${l.file}. The LoRAs are listed by describe_form (machines › models › ${id}).`);
      return { ...l, file: there };
    });
  }
  if (spec.type === "choice" && !Array.isArray(spec.options) && typeof kept === "string" && offered.length && !offered.includes(kept) && !(spec.extra ?? []).includes(kept)) {
    throw httpError(`${spec.label}: ${kept} is not offered here; the options are ${offered.slice(0, 40).join(", ")}.`);
  }
  return kept;
}

/**
 * Several values checked at once (checkedValue each; null: the input taken out, so only its id is checked): every one that
 * is refused is said in one refusal, so that an agent mends them all in one go rather than one per call.
 */
export async function checkedValues(s: Services, at: Seen, recipe: Recipe<any>, values: Record<string, unknown>): Promise<Record<string, unknown>> {
  const kept: Record<string, unknown> = {};
  const refused: string[] = [];
  for (const [id, v] of Object.entries(values)) {
    try {
      if (v !== null) kept[id] = await checkedValue(s, at, recipe, id, v);
      else if (!(recipe.inputs as InputSpec[]).some((i) => i.id === id)) throw httpError(`${recipe.title} has no input ${id}.`);
      else kept[id] = null;
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === undefined) throw e;
      refused.push((e as Error).message);
    }
  }
  if (refused.length > 1) throw httpError(`${plural(refused.length, "value")} refused, nothing changed:\n- ${refused.join("\n- ")}`);
  if (refused.length) throw httpError(refused[0]!);
  return kept;
}

/** The cast asked by names ("@Nicolas", "Nicolas") or Prompt kit ids: the people of the kit, refused for a name that is no one's. */
export async function castOf(s: Services, asked: string[]): Promise<Look["cast"]> {
  const people = await s.db.selectFrom("entities").select(["id", "name"]).where("kind", "=", "person").execute();
  const key = (n: string) => n.toLowerCase().replace(/^@/, "").replace(/[^\p{L}\d]+/gu, "");
  return asked.map((a) => {
    const p = people.find((x) => x.id === a) ?? people.find((x) => key(x.name) === key(a));
    if (!p) throw httpError(`Nobody called ${a} is in the Prompt kit${people.length ? `: its people are ${people.map((x) => x.name).join(", ")}` : ""}.`);
    return { id: p.id };
  });
}

/** A draft by id, refused with where to find the ids. */
async function draftOf(s: Services, id: string) {
  const d = await findDraft(s.db, id);
  if (!d) throw httpError("There is no such draft: list_drafts gives the ids, whats_open the one open.", 404);
  return d;
}

/**
 * A draft changed by an agent: worked out in the draft's own save turn from what it holds then (the page may have saved
 * meanwhile), written through saveDraft, and said to the open pages as a "draft" event. Nothing is sent when nothing changed.
 */
export async function agentSave(s: Services, ctx: ToolCtx, id: string, change: (d: DraftView) => z.output<typeof saveBody> | Promise<z.output<typeof saveBody>>): Promise<{ draft: DraftView; edit: DraftEdit }> {
  let before: DraftView | null = null;
  const draft = await saveDraft(s, id, (d) => {
    before = d;
    return change(d);
  });
  const edit = editOf(before!, draft, ctx);
  if (changedCount(edit)) s.queue.events.emit("draft", edit);
  return { draft, edit };
}

/** A draft as read_draft gives it: its form's values as held, the whole form as it would render, its cast by name. */
async function draftSaid(s: Services, at: Seen, d: DraftView) {
  const recipe = s.registry.recipe(d.recipe);
  const people = d.look?.cast.length ? await s.db.selectFrom("entities").select(["id", "name"]).where("id", "in", d.look.cast.map((c) => c.id)).execute() : [];
  const own = recipe ? ownValues(recipe, d.forms[recipe.id]) : d.forms[d.recipe] ?? {};
  return {
    id: d.id, name: d.name, title: d.title, form: d.recipe, formTitle: recipe?.title ?? null, takes: d.count, project: d.projectId, updatedAt: d.updatedAt,
    values: own,
    whole: recipe ? await wholeOf(s, at, recipe, own) : null,
    cast: d.look ? { people: d.look.cast.map((c) => ({ id: c.id, name: people.find((p) => p.id === c.id)?.name ?? null, ...(c.outfit ? { outfit: c.outfit } : {}) })), style: d.look.style ?? null, snippets: d.look.snippets } : null,
    otherForms: Object.keys(d.forms).filter((f) => f !== d.recipe && Object.keys(d.forms[f] ?? {}).length),
  };
}

const listDrafts = tool({
  name: "list_drafts",
  scope: "look",
  title: "Drafts",
  description: "The drafts, the most recently saved first: id, name or the start of its prompt, its form, when it was saved, how many items it made. `project`: one project's (\"none\" for the Inbox).",
  input: { project: z.string().optional(), limit: z.number().int().min(1).max(200).optional() },
  async run({ project, limit }, ctx) {
    const list = await draftsList(ctx.s, project, limit);
    ctx.said(`Listed the drafts: ${plural(list.items.length, "draft")}`);
    return list.items.map((d) => ({ id: d.id, name: d.name || d.title || "Untitled draft", form: d.recipe, updatedAt: d.updatedAt, made: d.outputs, empty: d.empty, project: d.projectId }));
  },
});

const readDraft = tool({
  name: "read_draft",
  scope: "look",
  title: "Read a draft",
  description: "One draft: its form, the values it holds (`values`, what the user or an agent set) and the whole form as it would render (`whole`, with the form's starts filled in), its batch, its cast (Prompt kit people by name, style, snippets).",
  input: { draft: z.string().min(1) },
  async run({ draft }, ctx) {
    const d = await draftOf(ctx.s, draft);
    const view = draftView(d);
    ctx.said(`Read the draft ${nameOf(view)}`);
    return draftSaid(ctx.s, await seen(ctx.s), view);
  },
});

const newDraft = tool({
  name: "new_draft",
  scope: "make",
  title: "New draft",
  description: "A new draft on a form, optionally with a Prompt kit preset applied and values set (validated as the form does). It is not opened on the user's screen: say its id, or let the user open it from Studio.",
  input: {
    form: z.string().min(1).describe("The form's id (list_forms)."),
    preset: z.string().optional().describe("A Prompt kit preset's id or name (describe_form › presets › kit)."),
    values: z.record(z.string(), z.unknown()).optional().describe("Inputs by id, checked as edit_draft checks them."),
    name: z.string().max(80).optional(),
    project: z.string().optional().describe("A project's id; left out: the Inbox."),
  },
  async run(args, ctx) {
    const { s } = ctx;
    const recipe = formOf(s, args.form);
    const at = await seen(s);
    const values = await checkedValues(s, at, recipe, args.values ?? {});
    let d = await createDraft(s, createBody.parse({ recipe: recipe.id, forms: { [recipe.id]: values }, name: args.name, project: args.project }));
    if (args.preset) d = (await presetOnto(s, ctx, at, d.id, args.preset)).draft;
    s.queue.events.emit("draft", { id: d.id, by: ctx.token.name, token: ctx.token.id, at: new Date().toISOString(), fields: [], made: true } satisfies DraftEdit);
    ctx.said(`Made the draft ${nameOf(d)} on ${recipe.title}`);
    return draftSaid(s, at, d);
  },
});

const editDraft = tool({
  name: "edit_draft",
  scope: "make",
  title: "Edit a draft",
  description: "Change a draft as the form would: any input by id (`set`, null to take it out so it follows the form's start again), LoRAs, reference pictures, media slots by library item id, the cast by Prompt kit names (\"@Name\" in a prompt casts that person at render too), the batch, the name, or another form. Each value is checked as the form checks it. Saved through the drafts' autosave path; a page with the draft open shows the change at once, the fields ringed with this token's name, with Undo.",
  input: {
    draft: z.string().min(1),
    form: z.string().optional().describe("Move the draft to another form (its values for that form are kept apart, as Create keeps them)."),
    set: z.record(z.string(), z.unknown()).optional().describe("Inputs by id → value (describe_form says each one's value); null takes it out."),
    loras: z.array(z.object({ file: z.string().min(1), weight: z.number() })).optional().describe("The form's LoRA list, whole."),
    references: z.array(z.object({ asset: z.string().min(1), role: z.string() })).optional().describe("The form's reference pictures, whole."),
    cast: z.array(z.string()).optional().describe("The cast, whole: Prompt kit people by name or id ([] for nobody)."),
    takes: z.number().int().min(1).max(8).optional().describe("The batch: how many takes Render makes."),
    name: z.string().max(80).optional(),
  },
  async run(args, ctx) {
    const { s } = ctx;
    const at = await seen(s);
    await draftOf(s, args.draft);
    const cast = args.cast ? await castOf(s, args.cast) : undefined;
    // the form, and the values checked against it, picked in the draft's save turn: the user may have switched the draft
    // to another form meanwhile, and values checked against the one read before landed in a form that takes other inputs
    const { draft, edit } = await agentSave(s, ctx, args.draft, async (d) => {
      const recipe = formOf(s, args.form ?? d.recipe);
      const set: Record<string, unknown> = { ...(args.set ?? {}) };
      const listInput = (type: InputSpec["type"]) => shownInputs(recipe).find((i) => i.type === type)?.id;
      for (const [key, type] of [["loras", "loras"], ["references", "references"]] as const) {
        if (args[key] === undefined) continue;
        const id = listInput(type);
        if (!id) throw httpError(`${recipe.title} takes no ${key === "loras" ? "LoRAs" : "reference pictures"}.`);
        set[id] = args[key];
      }
      const checked = await checkedValues(s, at, recipe, set);
      const form = Object.fromEntries(Object.entries({ ...d.forms[recipe.id], ...checked }).filter(([, v]) => v !== null));
      return {
        forms: { ...d.forms, [recipe.id]: form },
        ...(args.form ? { recipe: recipe.id } : {}),
        ...(cast ? { look: { cast, style: d.look?.style ?? null, snippets: d.look?.snippets ?? [] } } : {}),
        ...(args.takes ? { count: args.takes } : {}),
        ...(args.name !== undefined ? { name: args.name } : {}),
      };
    });
    const n = changedCount(edit);
    ctx.said(n ? `Changed ${plural(n, "field")} of ${nameOf(draft)}` : `Left ${nameOf(draft)} as it was`);
    return { changed: [...edit.fields.map((f) => f.input), ...(edit.recipe ? ["form"] : []), ...(edit.look ? ["cast"] : []), ...(edit.count ? ["takes"] : []), ...(edit.name ? ["name"] : [])], draft: await draftSaid(s, at, draft) };
  },
});

/** A Prompt kit preset laid over a draft, as Create applies one (web CreatePanel applyPreset): its form when it names one, what it sets, who is in it. */
async function presetOnto(s: Services, ctx: ToolCtx, at: Seen, draftId: string, asked: string) {
  const all = await kitPresets(s);
  const p = all.find((x) => x.id === asked) ?? all.find((x) => x.name.toLowerCase() === asked.toLowerCase());
  if (!p) throw httpError(`There is no preset called ${asked} in the Prompt kit${all.length ? `: its presets are ${all.map((x) => x.name).join(", ")}` : ""}.`, 404);
  if (p.recipe && !s.registry.recipe(p.recipe)) throw refusal(`${p.name} is made for a model that is not installed here (${p.recipe}).`);
  const look = lookSchema.nullable().catch(null).parse(p.look);
  const saved = await agentSave(s, ctx, draftId, (d) => {
    const target = p.recipe ?? d.recipe;
    const recipe = s.registry.recipe(target);
    const values = recipe ? matchFiles(recipe, statusOf(at, target)?.options, p.inputs) : p.inputs;
    return { recipe: target, forms: { ...d.forms, [target]: { ...d.forms[target], ...values } }, ...(look && !emptyLook(look) ? { look } : {}) };
  });
  return { ...saved, preset: p };
}

const applyPreset = tool({
  name: "apply_preset",
  scope: "make",
  title: "Apply a preset",
  description: "A Prompt kit preset (the user's own or a shipped one) laid over a draft, as Create's preset menu does it: its form when it names one, the values it sets (the rest of the form kept), and its cast when it has one. Shows in an open page with Undo, as edit_draft does.",
  input: { draft: z.string().min(1), preset: z.string().min(1).describe("The preset's id or name (describe_form › presets › kit).") },
  async run(args, ctx) {
    const { s } = ctx;
    const at = await seen(s);
    await draftOf(s, args.draft);
    const { draft, edit, preset } = await presetOnto(s, ctx, at, args.draft, args.preset);
    ctx.said(`Applied ${preset.name} to ${nameOf(draft)}: ${plural(changedCount(edit), "field")}`);
    return { applied: preset.name, changed: edit.fields.map((f) => f.input), draft: await draftSaid(s, at, draft) };
  },
});

const removeDraft = tool({
  name: "delete_draft",
  scope: "make",
  title: "Delete a draft",
  description: "Delete a draft that nothing was made from (made: 0 in list_drafts, nothing queued): a try that led nowhere, or one made to test. It is gone for good (drafts have no bin): a draft something was made from is refused, the user deletes it in Studio.",
  input: { draft: z.string().min(1) },
  async run({ draft }, ctx) {
    const d = draftView(await draftOf(ctx.s, draft));
    await deleteDraft(ctx.s, d.id, true);
    ctx.said(`Deleted the draft ${nameOf(d)}`);
    return { deleted: d.id, name: d.name || d.title || "Untitled draft" };
  },
});

export const DRAFT_TOOLS = [listDrafts, readDraft, newDraft, editDraft, applyPreset, removeDraft];
