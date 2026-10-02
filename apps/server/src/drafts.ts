import { chatJson } from "./designer";
import type { Recipe } from "@studai/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { newId, now, OWNER, type Tables } from "./db";
import { lookSchema, type Look } from "./entities";
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
});
const saveBody = z.strictObject({
  recipe: z.string().min(1).optional(),
  forms: forms.optional(),
  count: z.number().int().min(1).max(8).optional(),
  look: lookSchema.nullable().optional(),
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
  const look = d.look ? (JSON.parse(d.look) as Look) : null;
  if (look && (look.cast.length || look.style || look.snippets?.length)) return false;
  return Object.values(JSON.parse(d.forms) as Record<string, Record<string, unknown>>).every((form) => Object.keys(form).length === 0);
}

const brief = (d: Tables["drafts"]) => ({ id: d.id, recipe: d.recipe_id, title: d.title, name: d.name, target: d.target, updatedAt: d.updated_at, empty: holdsNothing(d) });
const full = (d: Tables["drafts"]) => ({
  ...brief(d), forms: JSON.parse(d.forms) as Record<string, Record<string, unknown>>, count: d.count, look: d.look ? (JSON.parse(d.look) as Look) : null,
  chat: d.chat ? (JSON.parse(d.chat) as unknown[]) : [],
  designer: d.designer ? (JSON.parse(d.designer) as { llm?: string; instruction?: string }) : null,
});

export function registerDrafts(app: FastifyInstance, s: Services): void {
  const notFound = () => Object.assign(new Error("this draft was not found"), { statusCode: 404 });
  const tooBig = () => Object.assign(new Error("this draft is too large to save"), { statusCode: 413 });
  const get = async (id: string) => {
    const d = await s.db.selectFrom("drafts").selectAll().where("id", "=", id).executeTakeFirst();
    if (!d) throw notFound();
    return d;
  };

  app.get("/api/drafts", async () => {
    const rows = await s.db.selectFrom("drafts").selectAll().orderBy("updated_at", "desc").limit(LIST_LIMIT).execute();
    return { items: rows.map(brief) };
  });

  app.post("/api/drafts", async (req) => {
    const body = createBody.parse(req.body);
    const json = JSON.stringify(body.forms);
    if (json.length > MAX_BYTES) throw tooBig();
    const at = now();
    const row: Tables["drafts"] = {
      id: newId(), owner_id: OWNER, target: body.target, recipe_id: body.recipe, title: titleOf(s.registry.recipe(body.recipe), body.forms),
      name: null, forms: json, count: body.count, chat: null, look: body.look ? JSON.stringify(body.look) : null, created_at: at, updated_at: at,
    };
    await s.db.insertInto("drafts").values(row).execute();
    return full(row);
  });

  app.get<{ Params: { id: string } }>("/api/drafts/:id", async (req) => full(await get(req.params.id)));

  /** Saved while typing: only what is sent changes. */
  app.put<{ Params: { id: string } }>("/api/drafts/:id", async (req) => {
    const body = saveBody.parse(req.body);
    const current = await get(req.params.id);
    const recipe = body.recipe ?? current.recipe_id;
    const all = body.forms ?? (JSON.parse(current.forms) as Record<string, Record<string, unknown>>);
    const json = JSON.stringify(all);
    if (json.length > MAX_BYTES) throw tooBig();
    const next = {
      recipe_id: recipe, forms: json, count: body.count ?? current.count, title: titleOf(s.registry.recipe(recipe), all), updated_at: now(),
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
