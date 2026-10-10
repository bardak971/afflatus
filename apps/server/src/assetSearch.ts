import type { FastifyInstance } from "fastify";
import { sql, type SqlBool } from "kysely";
import { z } from "zod";
import { describeRecipe, fuzzyFilter } from "@afflatus/core";
import { draftLabel, promptOf, recipeWords, shownNames } from "./autoName";
import type { Tables } from "./db";
import { assetView } from "./media";
import { folderIdsOf } from "./projects";
import { readJson } from "./queueModel";
import type { Services } from "./services";

/** The library listed and searched: a page at a time, by kind, folder, project, model, LoRA, draft and words; and the filters' choices. */

const listQuery = z.object({
  kind: z.enum(["image", "video", "audio"]).optional(),
  bin: z.string().optional(),
  /** A folder id, or "none" for what is in no folder. */
  folder: z.string().optional(),
  /** A project id: what is in its folders; "none": the Inbox (in no folder, or in a folder of no project). */
  project: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(60),
  /** The `next` value of the previous page. */
  after: z.string().optional(),
  /** The `prev` value of the page below: the page just above it, in the same order. */
  before: z.string().optional(),
  /** Words to find, in the name or in what was written to make it. Forgiving: typos and letters left out. */
  q: z.string().max(200).optional(),
  /** Only what was made with this model family. */
  family: z.string().optional(),
  /** Only what was kept ("1"); "0": only what was not. */
  kept: z.string().optional(),
  /** Only what was made with this model file (a checkpoint, a diffusion model), or with this LoRA. */
  model: z.string().max(500).optional(),
  lora: z.string().max(500).optional(),
  /** Only what this draft made. */
  draft: z.string().max(64).optional(),
  /** Only what was made since this moment (ISO). */
  since: z.string().max(40).optional(),
  /**
   * The order: newest first (the default), oldest first, by name (A to Z), by size (largest first); `dir` turns name and size
   * around. Newest and oldest page by cursor; name and size by offset (`next` and `prev` are then positions). Not with words.
   */
  sort: z.enum(["new", "old", "name", "size"]).optional(),
  dir: z.enum(["asc", "desc"]).optional(),
});

type ListQuery = z.infer<typeof listQuery>;

/** The library by a list's filters (bin, kind, folder or project, kept, since, family, draft), before any order, page or search. */
async function filterAssets(s: Services, q: ListQuery) {
  let query = s.db.selectFrom("assets").where("deleted_at", q.bin ? "is not" : "is", null).where("origin", "not in", NOT_IN_LIBRARY);
  if (q.kind) query = query.where("kind", "=", q.kind);
  if (q.folder === "none") query = query.where("folder_id", "is", null);
  else if (q.folder) query = query.where("folder_id", "=", q.folder);
  else if (q.project === "none") {
    const inbox = await folderIdsOf(s.db, "none");
    query = query.where((eb) => (inbox.length ? eb.or([eb("folder_id", "is", null), eb("folder_id", "in", inbox)]) : eb("folder_id", "is", null)));
  } else if (q.project) {
    const own = await folderIdsOf(s.db, q.project);
    query = own.length ? query.where("folder_id", "in", own) : query.where("folder_id", "=", "-");
  }
  if (q.kept === "0") query = query.where("kept_at", "is", null);
  else if (q.kept) query = query.where("kept_at", "is not", null);
  if (q.since) query = query.where("created_at", ">=", q.since);
  if (q.family) query = query.where("generation_id", "in", s.db.selectFrom("generations").select("id").where("family", "=", q.family));
  if (q.draft) query = query.where("generation_id", "in", s.db.selectFrom("generations").select("id").where("draft_id", "=", q.draft));
  return query;
}
type Filtered = Awaited<ReturnType<typeof filterAssets>>;

/** What is kept but not shown in the library: a painted mask, a picture uploaded for the Prompt kit. */
export const NOT_IN_LIBRARY = ["mask", "kit"] as const;

/**
 * How many items a search reads whole, at most: the most recent ones (as they are, accents and all), and as many again of the
 * older ones its words could match (wordsSieve), so that an old item is found by its name too.
 */
const SEARCHED = 4000;
/** What a search reads of each item: enough to match it and say when its countdown started; a page's items are read whole after. */
const SEARCH_COLUMNS = ["id", "name", "generation_id", "created_at", "countdown_from"] as const;

/**
 * The letters a word's accented forms are written with (é, ç, ñ, ř…): in a LIKE pattern they stand for any one letter, since
 * the search ignores accents and SQL's lower() does not (SQLite's leaves "É" as it is).
 */
const ACCENTED = new Set([..."acegilnorsuyz"]);
/** `%`, `_` and the escape itself taken as themselves in a LIKE pattern. */
const likeLiteral = (c: string) => (c === "%" || c === "_" || c === "\\" ? `\\${c}` : c);

/**
 * The SQL sieve of a search by words: what lets through every item `fuzzyScore` could take for them (each word's letters
 * in order, somewhere in the name or in the form it was made with), so that the forgiving match runs over those alone, from
 * the whole library rather than only its newest items. A letter that may carry an accent, or is not plain ASCII, is any one
 * letter here: the sieve lets more through than matches, never less (the form's JSON holds its texts in order, as the
 * words fuzzyFilter reads).
 */
function wordsSieve(q: string) {
  const words = q.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const text = sql<string>`(lower(name) || ' ' || lower(coalesce((select g.inputs from generations g where g.id = assets.generation_id), '')))`;
  const pattern = (w: string) => `%${[...w].map((c) => (ACCENTED.has(c) || !/^[\x21-\x7e]$/.test(c) ? "_" : likeLiteral(c))).join("%")}%`;
  return sql<SqlBool>`(${sql.join(words.map((w) => sql`${text} like ${pattern(w)} escape '\\'`), sql` and `)})`;
}
/** How many generations' readings are kept: the most recent ones. A generation never changes, so neither does what is read off it. */
const KEPT = 20_000;

type Generation = { id: string; recipe_id: string; inputs: string; resolved: string };

/** What is read off one generation for searching it: the model files and LoRAs it was made with, and the words of its form. */
interface Reading {
  models: string[];
  loras: string[];
  words: string;
}

export function registerAssetSearch(app: FastifyInstance, s: Services): void {
  const readings = new Map<string, Reading>();
  /** A generation's reading, worked out once and kept: a search per keystroke parses no form it parsed before. */
  const readingOf = (g: Generation): Reading => {
    const kept = readings.get(g.id);
    if (kept) return kept;
    const r = read(g);
    if (readings.size >= KEPT) readings.delete(readings.keys().next().value!);
    readings.set(g.id, r);
    return r;
  };
  const read = (g: Generation): Reading => {
    const inputs = readJson<Record<string, unknown>>(g.inputs, {});
    const loads = readJson<{ loads?: string[] }>(g.resolved, {}).loads ?? [];
    const loras = Object.values(inputs)
      .filter((v): v is Array<{ file: string; weight: number }> => Array.isArray(v) && v.every((x) => x && typeof x === "object" && typeof (x as { file?: unknown }).file === "string" && typeof (x as { weight?: unknown }).weight === "number"))
      .flat().filter((l) => l.weight !== 0).map((l) => l.file);
    const recipe = s.registry.recipe(g.recipe_id);
    const models = new Set(loads.filter((f) => /^(checkpoints|diffusion_models)\//.test(f)).map((f) => f.replace(/^[^/]+\//, "")));
    for (const spec of recipe?.inputs ?? []) if (spec.type === "model" && typeof inputs[spec.id] === "string") models.add(inputs[spec.id] as string);
    // an imported workflow names its model itself
    if (!models.size && recipe) for (const f of describeRecipe(recipe).models) models.add(f);
    const words = Object.values(inputs).filter((v): v is string => typeof v === "string").join(" ");
    return { models: [...models], loras: [...new Set(loras)], words };
  };

  /**
   * What a search by words or files finds among the rows the filters let through, best match first: among the most recent
   * SEARCHED, and the older ones the words' sieve lets through (as many more at most).
   */
  const searched = async (filtered: Filtered, q: ListQuery) => {
    // found by its name and by every text of the form it was made with; and by the files it was made with
    let query = filtered.select(SEARCH_COLUMNS);
    if (q.model || q.lora) query = query.where("generation_id", "is not", null);
    let rows = await query.orderBy("created_at", "desc").orderBy("id", "desc").limit(SEARCHED).execute();
    const sieve = q.q ? wordsSieve(q.q) : null;
    const last = rows.at(-1);
    if (sieve && last && rows.length === SEARCHED) {
      const older = await query
        .where(sieve)
        .where((eb) => eb.or([eb("created_at", "<", last.created_at), eb.and([eb("created_at", "=", last.created_at), eb("id", "<", last.id)])]))
        .orderBy("created_at", "desc").orderBy("id", "desc").limit(SEARCHED).execute();
      rows = [...rows, ...older];
    }
    const ids = [...new Set(rows.map((r) => r.generation_id).filter((x): x is string => Boolean(x)))];
    // only the generations not read before are fetched
    const unread = ids.filter((id) => !readings.has(id));
    for (let i = 0; i < unread.length; i += 500) {
      for (const g of await s.db.selectFrom("generations").select(["id", "recipe_id", "inputs", "resolved"]).where("id", "in", unread.slice(i, i + 500)).execute()) readingOf(g);
    }
    const reading = (id: string | null) => (id ? readings.get(id) : undefined);
    if (q.model || q.lora) rows = rows.filter((r) => {
      const w = reading(r.generation_id);
      return w && (!q.model || w.models.includes(q.model)) && (!q.lora || w.loras.includes(q.lora));
    });
    return q.q?.trim() ? fuzzyFilter(rows, q.q, (a) => `${a.name} ${reading(a.generation_id)?.words ?? ""}`) : rows;
  };
  const searching = (q: ListQuery) => Boolean(q.q?.trim() || q.model || q.lora);

  app.get("/api/assets", async (req) => {
    const q = listQuery.parse(req.query);
    const filtered = await filterAssets(s, q);
    let query = filtered.selectAll();
    if (searching(q)) {
      const found = await searched(filtered, q);
      // a search pages by offset: `before` is where the page below starts
      const end = q.before !== undefined ? Math.min(Number(q.before) || 0, found.length) : undefined;
      const from = end !== undefined ? Math.max(0, end - q.limit) : Number(q.after) || 0;
      const to = end ?? from + q.limit;
      return { items: await placedViews(await whole(found.slice(from, to))), next: to < found.length ? String(to) : null, prev: from > 0 ? String(from) : null };
    }
    if (q.sort === "name" || q.sort === "size") {
      // by name or size: by offset, the id settling ties
      const dir = q.dir ?? (q.sort === "name" ? "asc" : "desc");
      const end = q.before !== undefined ? Math.max(0, Number(q.before) || 0) : undefined;
      const from = end !== undefined ? Math.max(0, end - q.limit) : Number(q.after) || 0;
      const count = end !== undefined ? end - from : q.limit;
      const sorted = q.sort === "name" ? query.orderBy(sql`lower(name)`, dir).orderBy("id", dir) : query.orderBy("bytes", dir).orderBy("id", dir);
      const rows = await sorted.limit(count + 1).offset(from).execute();
      const page = rows.slice(0, count);
      return { items: await placedViews(page), next: rows.length > count || end !== undefined ? String(from + page.length) : null, prev: from > 0 ? String(from) : null };
    }
    const cursor = (r: Tables["assets"]) => `${r.created_at}|${r.id}`;
    // oldest first: the same cursors, read the other way
    const old = q.sort === "old";
    const [down, up, ahead, back] = old ? (["asc", "desc", ">", "<"] as const) : (["desc", "asc", "<", ">"] as const);
    if (q.before) {
      // the page just above: read upwards from the cursor, then put back in the list's order
      const [at = "", id = ""] = q.before.split("|");
      const rows = await query
        .where((eb) => eb.or([eb("created_at", back, at), eb.and([eb("created_at", "=", at), eb("id", back, id)])]))
        .orderBy("created_at", up).orderBy("id", up).limit(q.limit + 1).execute();
      const page = rows.slice(0, q.limit).reverse();
      // the cursor's own item is below it, so there is more below whenever the page has anything
      return { items: await placedViews(page), next: page.length ? cursor(page.at(-1)!) : null, prev: rows.length > q.limit ? cursor(page[0]!) : null };
    }
    if (q.after) {
      const [at = "", id = ""] = q.after.split("|");
      query = query.where((eb) => eb.or([eb("created_at", ahead, at), eb.and([eb("created_at", "=", at), eb("id", ahead, id)])]));
    }
    const rows = await query.orderBy("created_at", down).orderBy("id", down).limit(q.limit + 1).execute();
    const page = rows.slice(0, q.limit);
    const tail = page.at(-1);
    // a page after a cursor has that cursor's item (and what is above it) above
    return { items: await placedViews(page), next: rows.length > q.limit && tail ? cursor(tail) : null, prev: q.after && page[0] ? cursor(page[0]) : null };
  });
  /**
   * The items not kept of a view (the list's filters; kept and bin are set here): how many, when the countdown of the
   * first and of the last of them started (`from`, `to`: they go to the bin a day after), and their ids when asked (`ids=1`, for Keep all).
   */
  app.get("/api/assets/unkept", async (req) => {
    const q = { ...listQuery.parse(req.query), bin: undefined, kept: "0" };
    const withIds = (req.query as { ids?: string }).ids === "1";
    const filtered = await filterAssets(s, q);
    if (searching(q)) {
      const rows = await searched(filtered, q);
      const starts = rows.map((r) => r.countdown_from ?? r.created_at).sort();
      return { count: rows.length, from: starts[0] ?? null, to: starts.at(-1) ?? null, ...(withIds ? { ids: rows.map((r) => r.id) } : {}) };
    }
    const start = sql<string>`coalesce(countdown_from, created_at)`;
    const sum = await filtered.select((eb) => [eb.fn.countAll().as("count"), eb.fn.min(start).as("from"), eb.fn.max(start).as("to")]).executeTakeFirst();
    const ids = withIds ? (await filtered.select("id").orderBy("created_at", "desc").execute()).map((r) => r.id) : undefined;
    return { count: Number(sum?.count ?? 0), from: sum?.from ?? null, to: sum?.to ?? null, ...(ids ? { ids } : {}) };
  });

  /** A page of found items read whole, in the order found. */
  async function whole(found: ReadonlyArray<{ id: string }>): Promise<Tables["assets"][]> {
    if (!found.length) return [];
    const rows = new Map((await s.db.selectFrom("assets").selectAll().where("id", "in", found.map((f) => f.id)).execute()).map((r) => [r.id, r]));
    return found.flatMap((f) => rows.get(f.id) ?? []);
  }

  /** The listed items; a video that is a take of a timeline clip says which (`clipOf`). */
  async function placedViews(rows: Tables["assets"][]) {
    const videos = rows.filter((r) => r.kind === "video").map((r) => r.id);
    const placed = videos.length ? await s.timelines.clipOf(videos) : new Map();
    // what made it in Create: the draft of its generation, by name (for grouping the grid by draft)
    const gens = rows.map((r) => r.generation_id).filter((g): g is string => Boolean(g));
    const drafts = new Map<string, { id: string; name: string }>();
    if (gens.length) {
      const found = await s.db.selectFrom("generations").leftJoin("drafts", "drafts.id", "generations.draft_id")
        .select(["generations.id as gen", "generations.draft_id as draft", "generations.recipe_id as recipe", "generations.inputs as inputs", "drafts.name as name", "drafts.title as title"])
        .where("generations.id", "in", gens).where("generations.draft_id", "is not", null).execute();
      // a draft with no name nor title is called after the start of the prompt it was sent with, as its results are (autoName.ts)
      for (const g of found) if (g.draft) drafts.set(g.gen, { id: g.draft, name: draftLabel({ name: g.name, title: g.title, prompt: promptOf(readJson<Record<string, unknown>>(g.inputs, {})), recipe: s.registry.recipe(g.recipe)?.title ?? recipeWords(g.recipe) }) });
    }
    const shown = await shownNames(s.db, rows, (id) => s.registry.recipe(id)?.title);
    return rows.map((r) => ({ ...assetView(r), ...(shown.has(r.id) ? { shownName: shown.get(r.id)! } : {}), clipOf: placed.get(r.id) ?? null, draftOf: (r.generation_id && drafts.get(r.generation_id)) || null }));
  }

  /** The model families things in the library were made with, for the "Any model" filter. */
  app.get("/api/assets/families", async () => ({
    items: (
      await s.db.selectFrom("generations").innerJoin("assets", "assets.generation_id", "generations.id").select("generations.family").where("assets.deleted_at", "is", null).distinct().execute()
    ).map((r) => r.family),
  }));

  /**
   * The model files and the LoRAs things in the library were made with, the most used first, for the
   * filters. Worked out once and kept until the library changes: the filter opens often, the library less so.
   */
  const tallyModels = async () => {
    const rows = await s.db
      .selectFrom("generations").innerJoin("assets", "assets.generation_id", "generations.id")
      .select(["generations.id", "generations.recipe_id", "generations.inputs", "generations.resolved"])
      .where("assets.deleted_at", "is", null).where("assets.origin", "not in", NOT_IN_LIBRARY)
      .execute();
    const models = new Map<string, number>();
    const loras = new Map<string, number>();
    for (const g of rows) {
      // one generation can have made several things: each counts
      const w = readingOf(g);
      for (const f of w.models) models.set(f, (models.get(f) ?? 0) + 1);
      for (const f of w.loras) loras.set(f, (loras.get(f) ?? 0) + 1);
    }
    const sorted = (m: Map<string, number>) => [...m.entries()].map(([file, count]) => ({ file, count })).sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
    return { models: sorted(models), loras: sorted(loras) };
  };
  let modelTally: Promise<Awaited<ReturnType<typeof tallyModels>>> | null = null;
  s.queue.events.on("library", () => {
    modelTally = null;
  });
  app.get("/api/assets/models", async () => {
    if (!modelTally) {
      modelTally = tallyModels();
      modelTally.catch(() => {
        modelTally = null;
      });
    }
    return modelTally;
  });
}

/**
 * The name an item is shown under when its own says nothing (none, or one older code gave after a nameless video): worked
 * out from where it came from (autoName.ts shownNames). Nothing when its own name holds, or there is nothing to go on.
 */
export async function withShownName(s: Services, row: Tables["assets"]): Promise<{ shownName?: string }> {
  const name = (await shownNames(s.db, [row], (id) => s.registry.recipe(id)?.title)).get(row.id);
  return name ? { shownName: name } : {};
}
