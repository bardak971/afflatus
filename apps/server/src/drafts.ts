import { chatJson } from "./designer";
import type { Recipe } from "@afflatus/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { NOT_IN_LIBRARY } from "./assetSearch";
import { httpError } from "./errors";
import { newId, now, OWNER, type Db, type Tables } from "./db";
import { emptyLook, lookSchema, type Look } from "./entities";
import type { Services } from "./services";

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

/**
 * A draft nothing was done in, left alone this long, is thrown away: a "New draft" that was left at once.
 * By its age alone, on the server: a draft just opened in another tab or on another device is never taken.
 */
export const IDLE_DRAFT_MS = 30 * 60_000;

/** The drafts nothing was done in and nobody touched for `IDLE_DRAFT_MS`, deleted. */
export async function sweepIdleDrafts(db: Db, at = Date.now()): Promise<number> {
  const before = new Date(at - IDLE_DRAFT_MS).toISOString();
  const old = await db.selectFrom("drafts").selectAll().where("target", "=", "new").where("name", "is", null).where("updated_at", "<", before).execute();
  const idle = old.filter(holdsNothing).map((d) => d.id);
  if (idle.length) await db.deleteFrom("drafts").where("id", "in", idle).execute();
  return idle.length;
}

const brief = (d: Tables["drafts"]) => ({ id: d.id, recipe: d.recipe_id, title: d.title, name: d.name, target: d.target, createdAt: d.created_at, updatedAt: d.updated_at, empty: holdsNothing(d), projectId: d.project_id });
const full = (d: Tables["drafts"]) => ({
  ...brief(d), forms: JSON.parse(d.forms) as Record<string, Record<string, unknown>>, count: d.count, look: d.look ? (JSON.parse(d.look) as Look) : null,
  chat: d.chat ? (JSON.parse(d.chat) as unknown[]) : [],
  designer: d.designer ? (JSON.parse(d.designer) as { llm?: string; instruction?: string }) : null,
});

export function registerDrafts(app: FastifyInstance, s: Services): void {
  const notFound = () => httpError("this draft was not found", 404);
  const tooBig = () => httpError("this draft is too large to save", 413);
  const get = async (id: string) => {
    const d = await s.db.selectFrom("drafts").selectAll().where("id", "=", id).executeTakeFirst();
    if (!d) throw notFound();
    return d;
  };

  /** The drafts of a project ("none": the Inbox; left out: all), newest first. */
  const inProject = (project: string | undefined) => {
    let q = s.db.selectFrom("drafts").selectAll();
    if (project === "none") q = q.where("project_id", "is", null);
    else if (project) q = q.where("project_id", "=", project);
    return q;
  };
  /** Drafts with no prompt, no name, no conversation and nothing ever made from them: settings picked and left. */
  const unusedOf = async (project: string | undefined, keep?: string) => {
    const bare = (await inProject(project).where("title", "=", "").where("name", "is", null).execute()).filter((d) => d.id !== keep && (!d.chat || d.chat === "[]"));
    if (!bare.length) return [];
    const made = new Set((await s.db.selectFrom("generations").select("draft_id").where("draft_id", "in", bare.map((d) => d.id)).execute()).map((g) => g.draft_id));
    return bare.filter((d) => !made.has(d.id));
  };

  /**
   * `project`: only the drafts of that project; "none": the Inbox; left out: all. Each with its newest output (the
   * cover) and how many it has in the library, read in one query; and how many drafts are unused (see unusedOf).
   */
  app.get("/api/drafts", async (req) => {
    const { project } = z.object({ project: z.string().optional() }).parse(req.query);
    await sweepIdleDrafts(s.db);
    const rows = await inProject(project).orderBy("updated_at", "desc").limit(LIST_LIMIT).execute();
    const outputs = rows.length
      ? await s.db.selectFrom("assets").innerJoin("generations", "generations.id", "assets.generation_id")
        .select(["generations.draft_id as draft", "assets.id as id", "assets.kind as kind"])
        .where("generations.draft_id", "in", rows.map((d) => d.id)).where("assets.deleted_at", "is", null).where("assets.origin", "not in", NOT_IN_LIBRARY)
        .orderBy("assets.created_at", "desc").execute()
      : [];
    const made = new Map<string, { cover: string; coverKind: "image" | "video" | "audio"; outputs: number }>();
    for (const o of outputs) {
      if (!o.draft) continue;
      const m = made.get(o.draft);
      if (m) m.outputs++;
      else made.set(o.draft, { cover: o.id, coverKind: o.kind, outputs: 1 });
    }
    return {
      items: rows.map((d) => ({ ...brief(d), cover: made.get(d.id)?.cover ?? null, coverKind: made.get(d.id)?.coverKind ?? null, outputs: made.get(d.id)?.outputs ?? 0 })),
      unused: (await unusedOf(project)).length,
    };
  });

  /** The unused drafts deleted (see unusedOf), but the one open (`keep`). */
  app.post("/api/drafts/clear-unused", async (req) => {
    const { project, keep } = z.strictObject({ project: z.string().optional(), keep: z.string().optional() }).parse(req.body ?? {});
    const gone = (await unusedOf(project, keep)).map((d) => d.id);
    if (gone.length) await s.db.deleteFrom("drafts").where("id", "in", gone).execute();
    return { deleted: gone.length };
  });

  app.post("/api/drafts", async (req) => {
    const body = createBody.parse(req.body);
    const json = JSON.stringify(body.forms);
    if (json.length > MAX_BYTES) throw tooBig();
    const at = now();
    const row: Tables["drafts"] = {
      id: newId(), owner_id: OWNER, target: body.target, recipe_id: body.recipe, title: titleOf(s.registry.recipe(body.recipe), body.forms),
      name: null, forms: json, count: body.count, chat: null, look: body.look ? JSON.stringify(body.look) : null, project_id: body.project ?? null, created_at: at, updated_at: at,
    };
    await s.db.insertInto("drafts").values(row).execute();
    return full(row);
  });

  app.get<{ Params: { id: string } }>("/api/drafts/:id", async (req) => full(await get(req.params.id)));

  /** Saved while typing: only what is sent changes. */
  app.put<{ Params: { id: string } }>("/api/drafts/:id", async (req) => {
    const body = saveBody.parse(req.body);
    const current = await get(req.params.id);
    // moved to another project (or the Inbox, null): it alone moves
    if (body.project && !(await s.db.selectFrom("projects").select("id").where("id", "=", body.project).executeTakeFirst())) throw httpError("this project was not found", 404);
    const recipe = body.recipe ?? current.recipe_id;
    const all = body.forms ?? (JSON.parse(current.forms) as Record<string, Record<string, unknown>>);
    const json = JSON.stringify(all);
    if (json.length > MAX_BYTES) throw tooBig();
    const next = {
      recipe_id: recipe, forms: json, count: body.count ?? current.count, title: titleOf(s.registry.recipe(recipe), all), updated_at: now(),
      ...(body.project !== undefined ? { project_id: body.project } : {}),
      ...(body.look !== undefined ? { look: body.look ? JSON.stringify(body.look) : null } : {}),
      ...(body.chat !== undefined ? { chat: chatJson(body.chat, MAX_BYTES) } : {}),
      ...(body.designer !== undefined ? { designer: body.designer ? JSON.stringify(body.designer) : null } : {}),
      ...(body.name !== undefined ? { name: body.name.trim() || null } : {}),
    };
    await s.db.updateTable("drafts").set(next).where("id", "=", current.id).execute();
    return full({ ...current, ...next });
  });

  app.delete<{ Params: { id: string } }>("/api/drafts/:id", async (req) => {
    await get(req.params.id);
    await s.db.deleteFrom("drafts").where("id", "=", req.params.id).execute();
    return { ok: true };
  });
}
