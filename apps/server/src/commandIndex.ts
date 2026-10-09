import type { FastifyInstance } from "fastify";
import type { InputSpec } from "@afflatus/core";
import { z } from "zod";
import { NOT_IN_LIBRARY } from "./assetSearch";
import { OWNER } from "./db";
import { httpError } from "./errors";
import { promptHistory } from "./promptHistory";
import type { Services } from "./services";
import { unusedSize, unusedTakes } from "./timelineUnused";
import { findDraft } from "./drafts";

/**
 * The command bar's side of the server (docs/command-bar.md): everything the bar can find in one small answer, a render
 * estimate for what the bar is about to send, and the prompts that were rendered. The bar matches in the browser, over
 * labels it keeps in memory: the index is read once and again on the live events, never per keystroke.
 */

export type CommandEntry =
  | { kind: "timeline"; id: string; label: string; project: string | null; folder: string | null; updatedAt: string; clips: number; durationMs: number; plannedMs: number; exported: boolean; unusedTakes: number; unusedBytes: number }
  | { kind: "draft"; id: string; label: string; project: string | null; updatedAt: string; recipe: string; renders: number }
  | { kind: "asset"; id: string; label: string; project: string | null; folder: string | null; updatedAt: string; assetKind: "image" | "video" | "audio"; width: number | null; height: number | null; durationMs: number | null; bytes: number; hasThumb: boolean }
  | { kind: "project"; id: string; label: string; updatedAt: string; archived: boolean; timelines: number; items: number; bytes: number }
  | { kind: "folder"; id: string; label: string; project: string | null; parent: string | null; updatedAt: string; items: number; linked: boolean };

/** What an item of the library is called when it has no name of its own. */
const UNNAMED = { image: "Image", video: "Video", audio: "Sound" } as const;

/**
 * Every timeline, draft, item of the library (not in the bin, no mask or kit picture), project and folder, as small rows. A
 * handful of grouped queries for all of it, only the columns the bar shows: a library of 10 000 items answers in tens of ms.
 * A project's root folder is not a folder of its own here (the project stands for it, as in the projects tree): what is in
 * it says `folder: null` with its project, as what is loose in the Inbox does with none.
 */
export async function commandIndex(s: Services): Promise<{ entries: CommandEntry[] }> {
  const db = s.db;
  const [projects, folders, assets, drafts, renders, leaves, unused] = await Promise.all([
    db.selectFrom("projects").select(["id", "name", "folder_id", "archived_at", "created_at", "updated_at"]).where("owner_id", "=", OWNER).execute(),
    db.selectFrom("folders").select(["id", "parent_id", "name", "path", "project_id", "created_at"]).where("owner_id", "=", OWNER).execute(),
    db.selectFrom("assets")
      .select(["id", "name", "kind", "folder_id", "width", "height", "duration_ms", "bytes", "thumb_key", "created_at"])
      .where("deleted_at", "is", null).where("origin", "not in", NOT_IN_LIBRARY)
      .orderBy("created_at", "desc").execute(),
    // a clip's own draft belongs to its timeline, not to the Studio's list
    db.selectFrom("drafts").select(["id", "name", "title", "recipe_id", "project_id", "created_at", "updated_at"]).where("owner_id", "=", OWNER).where("target", "not like", "clip:%").orderBy("updated_at", "desc").execute(),
    db.selectFrom("generations").select((eb) => ["draft_id", eb.fn.countAll().as("n")]).where("draft_id", "is not", null).groupBy("draft_id").execute(),
    s.timelines.leaves(),
    unusedTakes(db),
  ]);

  const known = new Set(projects.map((p) => p.id));
  const projectOf = (id: string | null) => (id && known.has(id) ? id : null);
  const folderById = new Map(folders.map((f) => [f.id, f]));
  // the roots that still exist: the project stands for them
  const roots = new Set(projects.flatMap((p) => (p.folder_id && folderById.has(p.folder_id) ? [p.folder_id] : [])));
  const folderOf = (id: string | null) => (id && folderById.has(id) && !roots.has(id) ? id : null);
  const projectOfFolder = (id: string | null) => (id ? projectOf(folderById.get(id)?.project_id ?? null) : null);

  const entries: CommandEntry[] = [];
  const byFolder = new Map<string, { n: number; b: number }>();
  const byProject = new Map<string, { n: number; b: number; timelines: number }>();
  const projectSum = (id: string | null) => {
    if (!id) return null;
    let p = byProject.get(id);
    if (!p) byProject.set(id, (p = { n: 0, b: 0, timelines: 0 }));
    return p;
  };

  for (const a of assets) {
    const bytes = Number(a.bytes);
    const project = projectOfFolder(a.folder_id);
    if (a.folder_id) {
      const f = byFolder.get(a.folder_id) ?? { n: 0, b: 0 };
      f.n += 1;
      f.b += bytes;
      byFolder.set(a.folder_id, f);
    }
    const p = projectSum(project);
    if (p) {
      p.n += 1;
      p.b += bytes;
    }
    entries.push({
      kind: "asset", id: a.id, label: a.name.trim() || UNNAMED[a.kind], project, folder: folderOf(a.folder_id), updatedAt: a.created_at,
      assetKind: a.kind, width: a.width, height: a.height, durationMs: a.duration_ms, bytes, hasThumb: a.thumb_key !== null,
    });
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
      recipe: d.recipe_id, renders: rendered.get(d.id) ?? 0,
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
  return { entries };
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
 * forecast (queue.forecast, the same as the form's own estimate) added up. Nothing is assumed about the card: one
 * part with no learned figure makes the whole null rather than a sum that leaves it out.
 */
export async function commandEstimate(s: Services, raw: unknown): Promise<CommandEstimate> {
  const q = estimateQuery.parse(raw);
  const forms: Array<{ recipe: string; input: Record<string, unknown>; times: number }> = [];
  if (q.timeline) {
    const t = await s.db.selectFrom("timelines").select("id").where("id", "=", q.timeline).executeTakeFirst();
    if (!t) throw httpError("this timeline was not found", 404);
    const clips = await s.db.selectFrom("clips").select(["recipe_id", "inputs", "kind", "take_id"]).where("timeline_id", "=", t.id).orderBy("position").orderBy("created_at").execute();
    const asked = q.clips ? new Set(q.clips.split(",").map(Number)) : null;
    for (const [i, c] of clips.entries()) {
      if (c.kind !== "video" || !c.recipe_id) continue;
      if (asked ? !asked.has(i + 1) : c.take_id !== null) continue;
      const recipe = s.registry.recipe(c.recipe_id);
      if (!recipe) continue;
      // what a timeline fills in itself (the clip it carries on from) is not the form's to say, as when it is rendered
      const own = new Set((recipe.inputs as InputSpec[]).filter((x) => x.type !== "clip").map((x) => x.id));
      const input = Object.fromEntries(Object.entries(JSON.parse(c.inputs) as Record<string, unknown>).filter(([k]) => own.has(k)));
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
  // the same form twice (clips left on the same settings) is worked out once
  const seen = new Map<string, Promise<Awaited<ReturnType<Services["queue"]["forecast"]>>>>();
  let ms = 0;
  let basis = Infinity;
  for (const f of forms) {
    const key = `${f.recipe}\n${JSON.stringify(f.input)}`;
    if (!seen.has(key)) seen.set(key, s.queue.forecast(f.recipe, f.input).catch(() => null));
    const got = await seen.get(key)!;
    if (!got) return { ms: null, basis: 0, ahead };
    ms += got.forecast.ms * f.times;
    basis = Math.min(basis, got.forecast.samples);
  }
  return { ms, basis, ahead };
}

export function registerCommandBar(app: FastifyInstance, s: Services): void {
  /** Everything the command bar can find (commandIndex). */
  app.get("/api/command-index", async () => commandIndex(s));
  /** What the bar's command would take to render (commandEstimate). */
  app.get("/api/command-estimate", async (req) => commandEstimate(s, req.query));
  /** The prompts that were rendered, newest first (promptHistory.ts). */
  app.get("/api/prompt-history", async (req) => promptHistory(s, req.query));
}
