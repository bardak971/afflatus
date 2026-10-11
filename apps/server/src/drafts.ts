import { chatJson } from "./llm";
import type { Recipe } from "@afflatus/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { NOT_IN_LIBRARY } from "./library";
import { httpError } from "./errors";
import { oneAtATime } from "./keyedLock";
import { newId, now, OWNER, type Db, type Tables } from "./db";
import { emptyLook, lookSchema, type Look } from "./entities";
import type { Services } from "./services";
import { unwrittenOf } from "./unwrittenDrafts";

/**
 * Drafts: unfinished work, kept on the server so that it is there after a reload, a restart, or from
 * another device. A draft is not validated against its recipe: it may be half written.
 */

const forms = z.record(z.string(), z.record(z.string(), z.unknown()));
const createBody = z.strictObject({
  recipe: z.string().min(1),
  forms: forms.default({}),
  count: z.number().int().min(1).max(8).default(1),
  target: z.string().max(100).default("new"),
  look: lookSchema.nullable().optional(),
  /** The project it is made in; null or left out: the Inbox. */
  project: z.string().nullable().optional(),
  /** A name of its own from the start (a duplicate's "… copy"). */
  name: z.string().max(80).optional(),
});
const saveBody = z.strictObject({
  recipe: z.string().min(1).optional(),
  forms: forms.optional(),
  count: z.number().int().min(1).max(8).optional(),
  look: lookSchema.nullable().optional(),
  project: z.string().nullable().optional(),
  /** The conversation with the designer about this draft: kept as it is, the server does not read it. */
  chat: z.array(z.unknown()).max(200).optional(),
  /** The language model and the instructions its conversation with the designer is held with; null = the usual ones. */
  designer: z.strictObject({ llm: z.string().max(40).optional(), instruction: z.string().max(40).optional() }).nullable().optional(),
  /** A name of one's own for it; an empty one goes back to the start of what was written. */
  name: z.string().max(80).optional(),
});

/** A draft is a few fields of text; anything much larger is a mistake. */
const MAX_BYTES = 256 * 1024;
/**
 * A look with only what is still in the kit: a tab that still holds a person, place, style or snippet deleted since
 * never writes it back into a draft, nor makes the draft count as holding something because of it.
 */
async function liveLook(db: Db, look: Look | null | undefined): Promise<Look | null> {
  if (!look || emptyLook(look)) return look ?? null;
  const ids = [...look.cast.map((c) => c.id), ...(look.style ? [look.style] : []), ...look.snippets];
  const there = new Set((await db.selectFrom("entities").select("id").where("id", "in", ids).execute()).map((e) => e.id));
  return { ...look, cast: look.cast.filter((c) => there.has(c.id)), style: look.style && there.has(look.style) ? look.style : null, snippets: look.snippets.filter((x) => there.has(x)) };
}

/** Drafts are kept until deleted, but the list shows the recent ones. */
const LIST_LIMIT = 30;

/** The start of what was written in the recipe's first text input. */
function titleOf(recipe: Recipe<any> | undefined, all: Record<string, Record<string, unknown>>): string {
  const recipeId = recipe?.id ?? "";
  const values = all[recipeId] ?? {};
  for (const input of recipe?.inputs ?? []) {
    const text = input.type === "prompt" && !input.optional ? values[input.id] : undefined;
    if (typeof text === "string" && text.trim()) return text.trim().replace(/\s+/g, " ").slice(0, 60);
  }
  return "";
}

/** Nothing was done in it: no value set in any form, nobody in it, no conversation, no name. */
function holdsNothing(d: Tables["drafts"]): boolean {
  if (d.name || (d.chat && d.chat !== "[]")) return false;
  if (!emptyLook(d.look ? (JSON.parse(d.look) as Look) : null)) return false;
  return Object.values(JSON.parse(d.forms) as Record<string, Record<string, unknown>>).every((form) => Object.keys(form).length === 0);
}

/** The inputs that are a form's content (what it is about); the others are its settings (model, size, steps, seed...). */
const CONTENT = new Set(["prompt", "image", "clip", "references", "audio"]);
const filled = (v: unknown) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0);

/**
 * Worth keeping: a name, a conversation, someone or a style from the kit, or content in a form (something written,
 * a picture, a clip, a sound). Settings alone are not: they are remembered per model anyway. A form of a recipe that
 * is not known (any more) counts as content when it holds anything.
 */
function holdsSomething(registry: Services["registry"], d: Tables["drafts"]): boolean {
  if (d.name || (d.chat && d.chat !== "[]")) return true;
  if (!emptyLook(d.look ? (JSON.parse(d.look) as Look) : null)) return true;
  return Object.entries(JSON.parse(d.forms) as Record<string, Record<string, unknown>>).some(([recipeId, values]) => {
    const inputs = registry.recipe(recipeId)?.inputs as Array<{ id: string; type: string }> | undefined;
    return Object.entries(values).some(([id, v]) => filled(v) && (!inputs || CONTENT.has(inputs.find((x) => x.id === id)?.type ?? "")));
  });
}

/** More than any number of tabs would leave open; the oldest go first. */
const UNWRITTEN_MAX = 200;

/** A draft by id, written or not yet; undefined when there is none. */
export async function findDraft(db: Db, id: string): Promise<Tables["drafts"] | undefined> {
  return (await db.selectFrom("drafts").selectAll().where("id", "=", id).executeTakeFirst()) ?? unwrittenOf(db).get(id);
}

/**
 * A render is sent from a draft not written yet: it is written now, so that what comes out is filed under it. In the
 * draft's turn, as its saves are; a save that wrote it first is kept as it is.
 */
export function writeDraft(db: Db, id: string): Promise<void> {
  return oneAtATime(db, `draft:${id}`, async () => {
    const m = unwrittenOf(db);
    const d = m.get(id);
    if (!d) return;
    m.delete(id);
    await db.insertInto("drafts").values({ ...d, updated_at: now() }).onConflict((oc) => oc.column("id").doNothing()).execute();
  });
}

/**
 * A draft that holds nothing worth keeping, left alone this long, is thrown away: written ones from before drafts
 * waited to hold something, or emptied since, when nothing was ever made from them; and the unwritten ones. By its
 * age alone: a draft just opened in another tab or on another device is never taken.
 */
export const IDLE_DRAFT_MS = 30 * 60_000;

/** The drafts not worth keeping and nobody touched for `IDLE_DRAFT_MS`, deleted. Run by the hourly sweep (services.ts): a listing only reads. */
export async function sweepIdleDrafts(db: Db, registry: Services["registry"], at = Date.now()): Promise<number> {
  const before = new Date(at - IDLE_DRAFT_MS).toISOString();
  const m = unwrittenOf(db);
  for (const [id, d] of m) if (d.updated_at < before) m.delete(id);
  const old = (await db.selectFrom("drafts").selectAll().where("target", "=", "new").where("name", "is", null).where("updated_at", "<", before).execute()).filter((d) => !holdsSomething(registry, d));
  if (!old.length) return 0;
  const made = new Set((await db.selectFrom("generations").select("draft_id").where("draft_id", "in", old.map((d) => d.id)).execute()).map((g) => g.draft_id));
  const idle = old.filter((d) => !made.has(d.id)).map((d) => d.id);
  if (idle.length) await db.deleteFrom("drafts").where("id", "in", idle).execute();
  return idle.length;
}

/** The drafts of a project ("none": the Inbox; left out: all). */
const inProject = (db: Db, project: string | undefined) => {
  let q = db.selectFrom("drafts").selectAll();
  if (project === "none") q = q.where("project_id", "is", null);
  else if (project) q = q.where("project_id", "=", project);
  return q;
};
/** Drafts with no prompt, no name, no conversation and nothing ever made from them: settings picked and left. `keep`: never that one. */
export async function unusedDrafts(db: Db, project?: string, keep?: string): Promise<Array<Tables["drafts"]>> {
  const bare = (await inProject(db, project).where("title", "=", "").where("name", "is", null).execute()).filter((d) => d.id !== keep && (!d.chat || d.chat === "[]"));
  if (!bare.length) return [];
  const made = new Set((await db.selectFrom("generations").select("draft_id").where("draft_id", "in", bare.map((d) => d.id)).execute()).map((g) => g.draft_id));
  return bare.filter((d) => !made.has(d.id));
}

const brief = (d: Tables["drafts"]) => ({ id: d.id, recipe: d.recipe_id, title: d.title, name: d.name, target: d.target, createdAt: d.created_at, updatedAt: d.updated_at, empty: holdsNothing(d), projectId: d.project_id });
const full = (d: Tables["drafts"]) => ({
  ...brief(d), forms: JSON.parse(d.forms) as Record<string, Record<string, unknown>>, count: d.count, look: d.look ? (JSON.parse(d.look) as Look) : null,
  chat: d.chat ? (JSON.parse(d.chat) as unknown[]) : [],
  designer: d.designer ? (JSON.parse(d.designer) as { llm?: string; instruction?: string }) : null,
});
/** A draft as GET /api/drafts/:id answers it: what the web's types are held against (test/apiTypes.test.ts). @internal */
export type DraftView = ReturnType<typeof full>;

export function registerDrafts(app: FastifyInstance, s: Services): void {
  const notFound = () => httpError("this draft was not found", 404);
  const tooBig = () => httpError("this draft is too large to save", 413);
  const get = async (id: string) => {
    const d = await findDraft(s.db, id);
    if (!d) throw notFound();
    return d;
  };
  const pending = unwrittenOf(s.db);

  /**
   * `project`: only the drafts of that project; "none": the Inbox; left out: all. Each with its newest output (the
   * cover), how many it has in the library and their size, read in one query, and whether it is unused (see unusedDrafts);
   * and how many drafts are unused. `limit`: more than the recent ones (the projects panel lists all of a project's).
   */
  app.get("/api/drafts", async (req) => {
    const { project, limit } = z.object({ project: z.string().optional(), limit: z.coerce.number().int().min(1).max(1000).optional() }).parse(req.query);
    const rows = await inProject(s.db, project).orderBy("updated_at", "desc").limit(limit ?? LIST_LIMIT).execute();
    // Both reads start from the drafts' generations: SQLite keeps a CROSS JOIN's left table outermost, where an inner join
    // let it start from every live item in the library (assets_by_bin) and look each one's generation up: 18 ms instead of 0.3 ms at
    // scale. Postgres plans a cross join with a join condition like an inner join.
    const outputs = rows.length
      ? await s.db.selectFrom("generations").crossJoin("assets").whereRef("assets.generation_id", "=", "generations.id")
        .select(["generations.draft_id as draft", "assets.id as id", "assets.kind as kind", "assets.bytes as bytes"])
        .where("generations.draft_id", "in", rows.map((d) => d.id)).where("assets.deleted_at", "is", null).where("assets.origin", "not in", NOT_IN_LIBRARY)
        .orderBy("assets.created_at", "desc").execute()
      : [];
    // the families its outputs were made with, newest first, with how many each made: a draft is an idea tried on models
    const families = new Map<string, Map<string, number>>();
    if (rows.length) {
      const tries = await s.db.selectFrom("generations").crossJoin("assets").whereRef("assets.generation_id", "=", "generations.id")
        .select(["generations.draft_id as draft", "generations.family as family"]).select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.max("assets.created_at").as("last")])
        .where("generations.draft_id", "in", rows.map((d) => d.id)).where("assets.deleted_at", "is", null).where("assets.origin", "not in", NOT_IN_LIBRARY)
        .groupBy(["generations.draft_id", "generations.family"]).orderBy("last", "desc").execute();
      for (const t of tries) {
        if (!t.draft) continue;
        const m = families.get(t.draft) ?? new Map<string, number>();
        m.set(t.family, Number(t.n));
        families.set(t.draft, m);
      }
    }
    const made = new Map<string, { cover: string; coverKind: "image" | "video" | "audio"; outputs: number; bytes: number }>();
    for (const o of outputs) {
      if (!o.draft) continue;
      const m = made.get(o.draft);
      if (m) {
        m.outputs++;
        m.bytes += o.bytes;
      } else made.set(o.draft, { cover: o.id, coverKind: o.kind, outputs: 1, bytes: o.bytes });
    }
    const unused = await unusedDrafts(s.db, project);
    const idle = new Set(unused.map((d) => d.id));
    return {
      items: rows.map((d) => ({ ...brief(d), cover: made.get(d.id)?.cover ?? null, coverKind: made.get(d.id)?.coverKind ?? null, outputs: made.get(d.id)?.outputs ?? 0, bytes: made.get(d.id)?.bytes ?? 0, unused: idle.has(d.id), models: [...(families.get(d.id) ?? [])].map(([family, outputs]) => ({ family, outputs })) })),
      unused: unused.length,
    };
  });

  /** The unused drafts deleted (see unusedDrafts) of a project ("none": the Inbox; left out: all), but the one open (`keep`). */
  app.post("/api/drafts/clear-unused", async (req) => {
    const { project, keep } = z.strictObject({ project: z.string().optional(), keep: z.string().optional() }).parse(req.body ?? {});
    const gone = (await unusedDrafts(s.db, project, keep)).map((d) => d.id);
    if (gone.length) await s.db.deleteFrom("drafts").where("id", "in", gone).execute();
    return { deleted: gone.length };
  });

  app.post("/api/drafts", async (req) => {
    const body = createBody.parse(req.body);
    const json = JSON.stringify(body.forms);
    if (json.length > MAX_BYTES) throw tooBig();
    const look = await liveLook(s.db, body.look);
    const at = now();
    const row: Tables["drafts"] = {
      id: newId(), owner_id: OWNER, target: body.target, recipe_id: body.recipe, title: titleOf(s.registry.recipe(body.recipe), body.forms),
      name: body.name?.trim() || null, forms: json, count: body.count, chat: null, look: look ? JSON.stringify(look) : null, project_id: body.project ?? null, created_at: at, updated_at: at,
    };
    if (holdsSomething(s.registry, row)) await s.db.insertInto("drafts").values(row).execute();
    else {
      pending.set(row.id, row);
      if (pending.size > UNWRITTEN_MAX) pending.delete(pending.keys().next().value!);
    }
    return full(row);
  });

  app.get<{ Params: { id: string } }>("/api/drafts/:id", async (req) => full(await get(req.params.id)));

  /**
   * Saved while typing: only what is sent changes. One save of a draft at a time: each reads the draft and writes it
   * whole, so two at once (the form and the name, two tabs) had the second put back what the first had changed, or,
   * on a draft not written yet, answer 404 while the first was writing it. A look sent is also saved in the kit's turn
   * (entities.ts): someone deleted between its check and its writing would stay in it.
   */
  app.put<{ Params: { id: string } }>("/api/drafts/:id", async (req) => {
    const body = saveBody.parse(req.body);
    const save = () => oneAtATime(s.db, `draft:${req.params.id}`, () => saved(req.params.id, body));
    return body.look === undefined ? save() : oneAtATime(s.db, "kit", save);
  });
  const saved = async (id: string, body: z.infer<typeof saveBody>) => {
    const current = await get(id);
    // moved to another project (or the Inbox, null): it alone moves
    if (body.project && !(await s.db.selectFrom("projects").select("id").where("id", "=", body.project).executeTakeFirst())) throw httpError("this project was not found", 404);
    const recipe = body.recipe ?? current.recipe_id;
    const all = body.forms ?? (JSON.parse(current.forms) as Record<string, Record<string, unknown>>);
    const json = JSON.stringify(all);
    if (json.length > MAX_BYTES) throw tooBig();
    const look = body.look === undefined ? undefined : await liveLook(s.db, body.look);
    const next = {
      recipe_id: recipe, forms: json, count: body.count ?? current.count, title: titleOf(s.registry.recipe(recipe), all), updated_at: now(),
      ...(body.project !== undefined ? { project_id: body.project } : {}),
      ...(look !== undefined ? { look: look ? JSON.stringify(look) : null } : {}),
      ...(body.chat !== undefined ? { chat: chatJson(body.chat, MAX_BYTES) } : {}),
      ...(body.designer !== undefined ? { designer: body.designer ? JSON.stringify(body.designer) : null } : {}),
      ...(body.name !== undefined ? { name: body.name.trim() || null } : {}),
    };
    const after = { ...current, ...next };
    if (!pending.has(current.id)) await s.db.updateTable("drafts").set(next).where("id", "=", current.id).execute();
    else if (holdsSomething(s.registry, after)) {
      pending.delete(current.id);
      await s.db.insertInto("drafts").values(after).onConflict((oc) => oc.column("id").doUpdateSet(next)).execute();
    } else pending.set(current.id, after);
    return full(after);
  };

  app.delete<{ Params: { id: string } }>("/api/drafts/:id", async (req) => oneAtATime(s.db, `draft:${req.params.id}`, async () => {
    await get(req.params.id);
    pending.delete(req.params.id);
    await s.db.deleteFrom("drafts").where("id", "=", req.params.id).execute();
    return { ok: true };
  }));
}
