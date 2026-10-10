import type { FastifyInstance } from "fastify";
import { sql, type Expression, type SqlBool } from "kysely";
import type { InputSpec } from "@afflatus/core";
import { z } from "zod";
import { NOT_IN_LIBRARY } from "./library";
import { OWNER, type Db, type Tables } from "./db";
import { httpError } from "./errors";
import { promptHistory } from "./promptHistory";
import type { Services } from "./services";
import { unusedSize, unusedTakes } from "./timelineUnused";
import { findDraft } from "./drafts";
import { formFilled } from "./timelineModel";

/**
 * The command bar's side of the server (docs/command-bar.md): everything the bar can find in one small answer, a render
 * estimate for what the bar is about to send, and the prompts that were rendered. The bar matches in the browser, over
 * labels it keeps in memory: the index is read once and again on the live events, never per keystroke. The library's
 * items are the exception, as they are too many to send whole (5 000 items made 1.5 MB): the index holds the newest few and
 * those the bar names, and what is typed is looked for among all of them by `commandItems`.
 */

export type CommandEntry =
  | { kind: "timeline"; id: string; label: string; project: string | null; folder: string | null; updatedAt: string; clips: number; durationMs: number; plannedMs: number; exported: boolean; unusedTakes: number; unusedBytes: number }
  /** `prompt`: the start of what was written, when a name of its own is the label (two drafts of one name are told apart by it). */
  | { kind: "draft"; id: string; label: string; project: string | null; updatedAt: string; createdAt: string; recipe: string; renders: number; prompt?: string }
  /** `inBin`: in the bin (found, to be put back), counted in no folder or project. */
  | { kind: "asset"; id: string; label: string; project: string | null; folder: string | null; updatedAt: string; assetKind: "image" | "video" | "audio"; width: number | null; height: number | null; durationMs: number | null; bytes: number; hasThumb: boolean; inBin?: true }
  | { kind: "project"; id: string; label: string; updatedAt: string; archived: boolean; timelines: number; items: number; bytes: number }
  | { kind: "folder"; id: string; label: string; project: string | null; parent: string | null; updatedAt: string; items: number; linked: boolean }
  | { kind: "workflow"; id: string; label: string; updatedAt: string; output: "image" | "video" | "audio"; problem: boolean }
  | { kind: "kit"; id: string; label: string; updatedAt: string; entity: "person" | "place" | "style" | "preset" | "snippet"; shipped: boolean };

/** What an item of the library is called when it has no name of its own. */
const UNNAMED = { image: "Image", video: "Video", audio: "Sound" } as const;
/** The newest items of the library the index holds: what the bar's Recent falls back on when it has learned nothing yet. */
const NEWEST = 30;
/** The items the bar can name for the index to hold (those it used lately), at most. */
const NAMED = 100;
/** The items a search of the bar answers with, at most: it shows 50, the best of them. */
const FOUND = 200;
/** The columns of an item the bar shows. */
const ITEM = ["id", "name", "kind", "folder_id", "width", "height", "duration_ms", "bytes", "thumb_key", "created_at", "deleted_at"] as const;
type ItemRow = Pick<Tables["assets"], (typeof ITEM)[number]>;

/**
 * Where the library's things are, as the bar says it: the projects that exist, and the folders. A project's root folder is
 * not a folder of its own (the project stands for it, as in the projects tree).
 */
async function placesOf(db: Db) {
  const [projects, folders] = await Promise.all([
    db.selectFrom("projects").select(["id", "name", "folder_id", "archived_at", "created_at", "updated_at"]).where("owner_id", "=", OWNER).execute(),
    db.selectFrom("folders").select(["id", "parent_id", "name", "path", "project_id", "created_at"]).where("owner_id", "=", OWNER).execute(),
  ]);
  const known = new Set(projects.map((p) => p.id));
  const projectOf = (id: string | null) => (id && known.has(id) ? id : null);
  const folderById = new Map(folders.map((f) => [f.id, f]));
  // the roots that still exist: the project stands for them
  const roots = new Set(projects.flatMap((p) => (p.folder_id && folderById.has(p.folder_id) ? [p.folder_id] : [])));
  const folderOf = (id: string | null) => (id && folderById.has(id) && !roots.has(id) ? id : null);
  const projectOfFolder = (id: string | null) => (id ? projectOf(folderById.get(id)?.project_id ?? null) : null);
  /** An item as the bar lists it; one in the bin is found (to be put back), marked. */
  const itemEntry = (a: ItemRow): Extract<CommandEntry, { kind: "asset" }> => ({
    kind: "asset", id: a.id, label: a.name.trim() || UNNAMED[a.kind], project: projectOfFolder(a.folder_id), folder: folderOf(a.folder_id), updatedAt: a.deleted_at ?? a.created_at,
    assetKind: a.kind, width: a.width, height: a.height, durationMs: a.duration_ms, bytes: Number(a.bytes), hasThumb: a.thumb_key !== null, ...(a.deleted_at ? { inBin: true as const } : {}),
  });
  return { projects, folders, projectOf, roots, folderOf, projectOfFolder, itemEntry };
}

/**
 * Every timeline, draft, project, folder, imported workflow and entry of the Prompt kit (the presets that ship with Afflatus
 * included), as small rows; of the library's items (no mask or kit picture), the NEWEST and those `items` names (the bin's
 * too, marked), and how many items each project and folder holds (`inboxItems`: those in no project). A handful of grouped
 * queries for all of it, only the columns the bar shows. A project's root folder is not a folder of its own here: what is
 * in it says `folder: null` with its project, as what is loose in the Inbox does with none.
 */
async function commandIndex(s: Services, opts: { items?: string[] } = {}): Promise<{ entries: CommandEntry[]; inboxItems: number }> {
  const db = s.db;
  const named = [...new Set(opts.items ?? [])].slice(0, NAMED);
  const [places, sums, newest, asked, drafts, renders, leaves, unused, workflows, kit] = await Promise.all([
    placesOf(db),
    // the library's items (not in the bin, as the library counts them) by folder; the loose ones under null
    db.selectFrom("assets").select((eb) => ["folder_id", eb.fn.countAll().as("n"), eb.fn.sum<number>("bytes").as("b")])
      .where("deleted_at", "is", null).where("origin", "not in", NOT_IN_LIBRARY).groupBy("folder_id").execute(),
    db.selectFrom("assets").select(ITEM).where("deleted_at", "is", null).where("origin", "not in", NOT_IN_LIBRARY).orderBy("created_at", "desc").orderBy("id", "desc").limit(NEWEST).execute(),
    named.length ? db.selectFrom("assets").select(ITEM).where("id", "in", named).where("origin", "not in", NOT_IN_LIBRARY).execute() : Promise.resolve([]),
    // a clip's own draft belongs to its timeline, not to the Studio's list
    db.selectFrom("drafts").select(["id", "name", "title", "recipe_id", "project_id", "created_at", "updated_at"]).where("owner_id", "=", OWNER).where("target", "not like", "clip:%").orderBy("updated_at", "desc").execute(),
    db.selectFrom("generations").select((eb) => ["draft_id", eb.fn.countAll().as("n")]).where("draft_id", "is not", null).groupBy("draft_id").execute(),
    // its figures (clips, lengths, exported) need only the takes that play
    s.timelines.leaves({ playingOnly: true }),
    unusedTakes(db),
    db.selectFrom("workflows").select(["id", "created_at", "updated_at"]).where("owner_id", "=", OWNER).execute(),
    db.selectFrom("entities").select(["id", "kind", "name", "created_at", "updated_at"]).where("owner_id", "=", OWNER).orderBy("name").execute(),
  ]);
  const { projects, folders, projectOf, roots, folderOf, projectOfFolder, itemEntry } = places;

  const entries: CommandEntry[] = [];
  const byFolder = new Map<string, { n: number; b: number }>();
  const byProject = new Map<string, { n: number; b: number; timelines: number }>();
  const projectSum = (id: string | null) => {
    if (!id) return null;
    let p = byProject.get(id);
    if (!p) byProject.set(id, (p = { n: 0, b: 0, timelines: 0 }));
    return p;
  };

  // an item in the bin is in no folder's or project's count (as the library shows them)
  let inboxItems = 0;
  for (const r of sums) {
    const n = Number(r.n);
    const b = Number(r.b ?? 0);
    if (r.folder_id) byFolder.set(r.folder_id, { n, b });
    const p = projectSum(projectOfFolder(r.folder_id));
    if (p) {
      p.n += n;
      p.b += b;
    } else inboxItems += n;
  }
  const seen = new Set<string>();
  for (const a of [...newest, ...asked]) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    entries.push(itemEntry(a));
  }

  for (const t of leaves) {
    const project = projectOf(t.projectId);
    const p = projectSum(project);
    if (p) p.timelines += 1;
    entries.push({
      kind: "timeline", id: t.id, label: t.name, project, folder: folderOf(t.folderId), updatedAt: t.updatedAt || t.createdAt,
      clips: t.clips, durationMs: t.durationMs, plannedMs: t.plannedMs, exported: t.exported, ...unusedSize(unused.get(t.id)),
    });
  }

  const rendered = new Map(renders.map((r) => [r.draft_id, Number(r.n)]));
  for (const d of drafts) {
    entries.push({
      kind: "draft", id: d.id, label: d.name?.trim() || d.title.trim() || "No prompt yet", project: projectOf(d.project_id), updatedAt: d.updated_at || d.created_at,
      createdAt: d.created_at, recipe: d.recipe_id, renders: rendered.get(d.id) ?? 0, ...(d.name?.trim() && d.title.trim() ? { prompt: d.title.trim() } : {}),
    });
  }

  for (const f of folders) {
    if (roots.has(f.id)) continue;
    entries.push({
      kind: "folder", id: f.id, label: f.name, project: projectOf(f.project_id), parent: folderOf(f.parent_id), updatedAt: f.created_at,
      items: byFolder.get(f.id)?.n ?? 0, linked: Boolean(f.path),
    });
  }

  for (const p of projects) {
    const sum = byProject.get(p.id);
    entries.push({ kind: "project", id: p.id, label: p.name, updatedAt: p.updated_at || p.created_at, archived: Boolean(p.archived_at), timelines: sum?.timelines ?? 0, items: sum?.n ?? 0, bytes: sum?.b ?? 0 });
  }

  // the workflows as the registry holds them (one that cannot be built is listed too, as on the Workflows screen)
  const changed = new Map(workflows.map((w) => [w.id, w.updated_at || w.created_at]));
  for (const d of s.registry.workflows()) {
    entries.push({ kind: "workflow", id: d.id, label: d.title, updatedAt: changed.get(d.id) ?? "", output: d.bindings.result.kind, problem: Boolean(s.registry.problem(d.id)) });
  }

  for (const e of kit) entries.push({ kind: "kit", id: e.id, label: e.name, updatedAt: e.updated_at || e.created_at, entity: e.kind, shipped: false });
  // the presets that ship with Afflatus, after the user's own, as the Prompt kit lists them
  for (const p of s.shippedPresets.list()) {
    const e = s.shippedPresets.entity(p);
    entries.push({ kind: "kit", id: e.id, label: e.name, updatedAt: "", entity: "preset", shipped: true });
  }
  return { entries, inboxItems };
}

const itemsQuery = z.object({ q: z.string().max(200), limit: z.coerce.number().int().min(1).max(FOUND).default(FOUND) });

/** `%`, `_` and the escape itself taken as themselves in a LIKE pattern. */
const literal = (c: string) => (c === "%" || c === "_" || c === "\\" ? `\\${c}` : c);
/**
 * A letter of what is typed in a LIKE pattern over a lower-cased label: itself when SQL lower-cases it as the browser does
 * (plain ASCII), else any one letter (SQLite's lower() leaves "É" as it is). A pattern is only a first sieve: the bar
 * matches again over what comes back.
 */
const letter = (c: string) => (/^[\x20-\x7e]$/.test(c) ? literal(c) : "_");

/**
 * The SQL test that lets through every item whose label the bar's matching could take for `q` (apps/web/src/bar/match.ts):
 * the letters typed in order (which a match from the start, inside, or on the words' initials also is), or each word typed
 * somewhere in it. Over the label as the bar has it: the name, or "Image", "Video", "Sound" for an item with none.
 * `inside`: the label holds what is typed as it is, the bar's best matches.
 */
function labelMatches(q: string): { test: Expression<SqlBool>; inside: Expression<SqlBool> } | null {
  const typed = q.trim().toLowerCase();
  if (!typed) return null;
  const label = sql<string>`(case when trim(name) = '' then (case kind when 'image' then 'image' when 'video' then 'video' else 'sound' end) else lower(name) end)`;
  const like = (pattern: string) => sql<SqlBool>`${label} like ${pattern} escape '\\'`;
  const letters = [...typed.replace(/\s+/g, "")].map(letter);
  const words = typed.split(/\s+/).filter(Boolean);
  const inOrder = like(`%${letters.join("%")}%`);
  const each = words.length > 1 ? sql<SqlBool>`(${sql.join(words.map((w) => like(`%${[...w].map(letter).join("")}%`)), sql` and `)})` : null;
  return { test: each ? sql<SqlBool>`(${inOrder} or ${each})` : inOrder, inside: like(`%${[...typed].map(letter).join("")}%`) };
}

/**
 * The library's items whose label could match what is typed in the bar, over the whole library and the bin (marked): those
 * that hold it as typed first, the shorter names first (the bar's best matches), then the newest. The bar ranks them with the
 * rest of its index.
 */
async function commandItems(s: Services, raw: unknown): Promise<{ entries: CommandEntry[] }> {
  const { q, limit } = itemsQuery.parse(raw);
  const match = labelMatches(q);
  if (!match) return { entries: [] };
  const [places, rows] = await Promise.all([
    placesOf(s.db),
    s.db.selectFrom("assets").select(ITEM).where("origin", "not in", NOT_IN_LIBRARY).where(match.test)
      .orderBy(sql`case when ${match.inside} then 0 else 1 end`).orderBy(sql`length(name)`).orderBy("created_at", "desc").orderBy("id", "desc").limit(limit).execute(),
  ]);
  return { entries: rows.map(places.itemEntry) };
}

export interface CommandEstimate {
  /** How long it would take, learned from render_stats (forecast.ts); null when nothing like it was rendered here yet. */
  ms: number | null;
  /** How many past renders the estimate rests on: the fewest behind any of its parts. */
  basis: number;
  /** The jobs in the queue before it: waiting or running. */
  ahead: number;
}

const estimateQuery = z.object({
  timeline: z.string().min(1).max(64).optional(),
  /** The clips as the timeline numbers them (1 is the first), "3,4,5"; left out: the clips with nothing rendered yet. */
  clips: z.string().regex(/^\d{1,4}(,\d{1,4}){0,199}$/).optional(),
  draft: z.string().min(1).max(64).optional(),
}).refine((q) => Boolean(q.timeline) !== Boolean(q.draft), { message: "say a timeline or a draft" });

/**
 * What rendering some of a timeline's clips, or a draft's next render (its count of jobs), would take: each form's
 * forecast (queue.forecast, the one figure the form, its Generate button and the queue say too) added up. Nothing is assumed about the card: one
 * part with no learned figure makes the whole null rather than a sum that leaves it out.
 */
async function commandEstimate(s: Services, raw: unknown): Promise<CommandEstimate> {
  const q = estimateQuery.parse(raw);
  const forms: Array<{ recipe: string; input: Record<string, unknown>; times: number }> = [];
  if (q.timeline) {
    const t = await s.db.selectFrom("timelines").select("id").where("id", "=", q.timeline).executeTakeFirst();
    if (!t) throw httpError("this timeline was not found", 404);
    const clips = await s.db.selectFrom("clips").select(["recipe_id", "inputs", "kind", "take_id", "joined"]).where("timeline_id", "=", t.id).orderBy("position").orderBy("created_at").execute();
    const asked = q.clips ? new Set(q.clips.split(",").map(Number)) : null;
    for (const [i, c] of clips.entries()) {
      if (c.kind !== "video" || !c.recipe_id) continue;
      if (asked ? !asked.has(i + 1) : c.take_id !== null) continue;
      const recipe = s.registry.recipe(c.recipe_id);
      if (!recipe) continue;
      const stored = JSON.parse(c.inputs) as Record<string, unknown>;
      // left out, the clips the card counts: those that can render (their form filled), as the timelines list's toRender
      if (!asked && !formFilled(recipe, stored, { carries: i > 0 && c.joined === "continue", afterStill: clips[i - 1]?.kind === "still" })) continue;
      // what a timeline fills in itself (the clip it carries on from) is not the form's to say, as when it is rendered
      const own = new Set((recipe.inputs as InputSpec[]).filter((x) => x.type !== "clip").map((x) => x.id));
      const input = Object.fromEntries(Object.entries(stored).filter(([k]) => own.has(k)));
      forms.push({ recipe: recipe.id, input, times: 1 });
    }
  } else {
    const d = await findDraft(s.db, q.draft!);
    if (!d) throw httpError("this draft was not found", 404);
    const all = JSON.parse(d.forms) as Record<string, Record<string, unknown>>;
    forms.push({ recipe: d.recipe_id, input: all[d.recipe_id] ?? {}, times: Math.max(1, d.count) });
  }

  const ahead = Number((await s.db.selectFrom("jobs").select((eb) => eb.fn.countAll().as("n")).where("status", "in", ["queued", "running"]).executeTakeFirst())?.n ?? 0);
  if (!forms.length) return { ms: null, basis: 0, ahead };
  let ms = 0;
  let basis = Infinity;
  for (const got of await forecastsOf(s, forms)) {
    if (!got) return { ms: null, basis: 0, ahead };
    ms += got.ms;
    basis = Math.min(basis, got.samples);
  }
  return { ms, basis, ahead };
}

/** Each form's forecast (queue.forecast), times its count; null for one with no learned figure. The same form twice is worked out once. */
async function forecastsOf(s: Services, forms: Array<{ recipe: string; input: Record<string, unknown>; times: number }>): Promise<Array<{ ms: number; samples: number } | null>> {
  const seen = new Map<string, Promise<Awaited<ReturnType<Services["queue"]["forecast"]>>>>();
  return Promise.all(forms.map(async (f) => {
    const key = `${f.recipe}\n${JSON.stringify(f.input)}`;
    if (!seen.has(key)) seen.set(key, s.queue.forecast(f.recipe, f.input).catch(() => null));
    const got = await seen.get(key)!;
    return got ? { ms: got.forecast.ms * f.times, samples: got.forecast.samples } : null;
  }));
}

const forecastsBody = z.strictObject({
  forms: z.array(z.strictObject({ recipe: z.string().min(1).max(200), input: z.record(z.string(), z.unknown()) })).max(400),
});

/**
 * What each of these forms would take to render once, as the timeline editor sends them (a clip's whole form, its texts
 * left out): the same forecast as the command bar's and the timeline card's, per form. Null where nothing like it was
 * rendered here yet.
 */
async function forecasts(s: Services, raw: unknown): Promise<{ ms: Array<number | null> }> {
  const b = forecastsBody.parse(raw);
  const got = await forecastsOf(s, b.forms.map((f) => ({ ...f, times: 1 })));
  return { ms: got.map((g) => g?.ms ?? null) };
}

export function registerCommandBar(app: FastifyInstance, s: Services): void {
  /** Everything the command bar can find (commandIndex); `items`: the ids of items of the library it wants held too ("a,b,c"). */
  app.get("/api/command-index", async (req) => {
    const { items } = z.object({ items: z.string().max(NAMED * 40).optional() }).parse(req.query);
    return commandIndex(s, { items: items?.split(",").filter(Boolean) });
  });
  /** The library's items whose name could match what is typed in the bar (commandItems). */
  app.get("/api/command-items", async (req) => commandItems(s, req.query));
  /** What the bar's command would take to render (commandEstimate). */
  app.get("/api/command-estimate", async (req) => commandEstimate(s, req.query));
  /** What each of the editor's clips would take to render (forecasts). */
  app.post("/api/forecasts", async (req) => forecasts(s, req.body));
  /** The prompts that were rendered, newest first (promptHistory.ts). */
  app.get("/api/prompt-history", async (req) => promptHistory(s, req.query));
}
