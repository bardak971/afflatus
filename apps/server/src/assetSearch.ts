import type { FastifyInstance } from "fastify";
import { sql, type Expression, type SqlBool } from "kysely";
import { z } from "zod";
import { describeRecipe, fuzzyFilter } from "@afflatus/core";
import { draftLabel, promptOf, recipeWords, shownNames } from "./autoName";
import type { Tables } from "./db";
import { assetView } from "./media";
import { folderIdsOf, NOT_IN_LIBRARY } from "./library";
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


/**
 * How many items a search reads whole, at most, where there is no index of the library's words (Postgres): the most recent
 * ones (as they are, accents and all), and as many again of the older ones its words could match (wordsSieve), so that an
 * old item is found by its name too.
 */
const SEARCHED = 4000;
/** What a search reads of each item: enough to match it and say when its countdown started; a page's items are read whole after. */
const SEARCH_COLUMNS = ["id", "name", "generation_id", "created_at", "countdown_from"] as const;
/** The fewest letters the index looks a word up by (its trigrams); a shorter word is read letter by letter. */
const TRIGRAM = 3;

/**
 * The letters a word's accented forms are written with (é, ç, ñ, ř…): in a LIKE pattern they stand for any one letter, since
 * the search ignores accents and SQL's lower() does not (SQLite's leaves "É" as it is).
 */
const ACCENTED = new Set([..."acegilnorsuyz"]);
/** `%`, `_` and the escape itself taken as themselves in a LIKE pattern. */
const likeLiteral = (c: string) => (c === "%" || c === "_" || c === "\\" ? `\\${c}` : c);
/** A letter of a word in a LIKE pattern: itself, or any one letter when it may carry an accent or is not plain ASCII. */
const likeLetter = (c: string) => (ACCENTED.has(c) || !/^[\x21-\x7e]$/.test(c) ? "_" : likeLiteral(c));
/** A text as the forgiving match reads it (fuzzy.ts): accents off, lower case. */
const plain = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
/** The words of a search, as the forgiving match reads them. */
const wordsOf = (q: string) => plain(q).split(/\s+/).filter(Boolean);

/**
 * The SQL sieve of a search by words: what lets through every item `fuzzyScore` could take for them (each word's letters
 * in order, somewhere in `text`: the name and the form it was made with), so that the forgiving match runs over those alone,
 * from the whole library rather than only its newest items. A letter that may carry an accent, or is not plain ASCII, is any
 * one letter here: the sieve lets more through than matches, never less (the form's JSON holds its texts in order, as the
 * words fuzzyFilter reads).
 */
function wordsSieve(words: string[], text: Expression<string>) {
  const pattern = (w: string) => `%${[...w].map(likeLetter).join("%")}%`;
  return sql<SqlBool>`(${sql.join(words.map((w) => sql`${text} like ${pattern(w)} escape '\\'`), sql` and `)})`;
}
/** A word looked up in the index (asset_words_index): its letters in this order, anywhere, as an FTS5 phrase. */
const phrase = (w: string) => `"${w.replaceAll('"', '""')}"`;
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

  /** Only what was made with the model file and the LoRA asked for, by the readings of the rows' generations. */
  const byFiles = async <R extends { generation_id: string | null }>(rows: R[], q: ListQuery): Promise<R[]> => {
    if (!q.model && !q.lora) return rows;
    await readAll(rows);
    return rows.filter((r) => {
      const w = r.generation_id ? readings.get(r.generation_id) : undefined;
      return w && (!q.model || w.models.includes(q.model)) && (!q.lora || w.loras.includes(q.lora));
    });
  };
  /** The readings of the rows' generations: only the generations not read before are fetched. */
  const readAll = async (rows: ReadonlyArray<{ generation_id: string | null }>) => {
    const ids = [...new Set(rows.map((r) => r.generation_id).filter((x): x is string => Boolean(x)))];
    const unread = ids.filter((id) => !readings.has(id));
    for (let i = 0; i < unread.length; i += 500) {
      for (const g of await s.db.selectFrom("generations").select(["id", "recipe_id", "inputs", "resolved"]).where("id", "in", unread.slice(i, i + 500)).execute()) readingOf(g);
    }
  };

  /**
   * What a search finds among the rows the filters let through, best match first: by words through the index of the
   * library's words where there is one (SQLite), else by reading the library (a search by files alone, or on Postgres).
   */
  const searched = (filtered: Filtered, q: ListQuery) => {
    const words = wordsOf(q.q ?? "");
    return words.length && s.dbKind === "sqlite" ? byIndex(filtered, q, words) : byReading(filtered, q);
  };

  /**
   * A search by words through the index of the library's words (migration 0052), over the whole library: the items that hold
   * every word as typed (accents and case aside), each word of three letters or more looked up by its trigrams and a shorter
   * one read in the rows they leave, ranked by fuzzyFilter as before. Those are the top of its ranking, above any item whose
   * texts only hold a word's letters in order, which is left out; unless no item holds the words (a typo, letters left
   * out): then every item whose texts hold each word's letters in order (wordsSieve) is ranked, as the forgiving match takes it.
   */
  const byIndex = async (filtered: Filtered, q: ListQuery, words: string[]) => {
    // an item's words are its name and every text of the form it was made with, as `${name} ${texts}`
    let query = filtered.innerJoin("asset_words", "asset_words.asset_id", "assets.id").select([...SEARCH_COLUMNS, "asset_words.words"]);
    if (q.model || q.lora) query = query.where("generation_id", "is not", null);
    const ordered = async (narrowed: typeof query) => byFiles(await narrowed.orderBy("created_at", "desc").orderBy("id", "desc").execute(), q);
    // by the ids of the items the index finds: asked by their doc, SQLite would look each item up among all of them
    let held = query;
    const long = words.filter((w) => [...w].length >= TRIGRAM);
    if (long.length) held = held.where(sql<SqlBool>`assets.id in (select w.asset_id from asset_words w where w.doc in (select rowid from asset_words_index where asset_words_index match ${long.map(phrase).join(" AND ")}))`);
    const short = words.filter((w) => [...w].length < TRIGRAM).map((w) => sql<SqlBool>`w.words like ${`%${[...w].map(likeLetter).join("")}%`} escape '\\'`);
    if (short.length) held = held.where(sql<SqlBool>`assets.id in (select w.asset_id from asset_words w where ${sql.join(short, sql` and `)})`);
    // what SQL lets through holds the words but for an accent or a letter's case that the forgiving match may read otherwise
    const found = (await ordered(held)).filter((r) => {
      const text = plain(r.words);
      return words.every((w) => text.includes(w));
    });
    // the sieve reads every item's words once, on their own: joined, SQLite would read the library's rows too
    const rows = found.length ? found : await ordered(query.where(sql<SqlBool>`assets.id in (select w.asset_id from asset_words w where ${wordsSieve(words, sql.ref("w.words"))})`));
    return fuzzyFilter(rows, q.q!, (a) => a.words);
  };

  /**
   * What a search by words or files finds by reading the library, best match first: among the most recent SEARCHED, and the
   * older ones the words' sieve lets through (as many more at most).
   */
  const byReading = async (filtered: Filtered, q: ListQuery) => {
    // found by its name and by every text of the form it was made with; and by the files it was made with
    let query = filtered.select(SEARCH_COLUMNS);
    if (q.model || q.lora) query = query.where("generation_id", "is not", null);
    let rows = await query.orderBy("created_at", "desc").orderBy("id", "desc").limit(SEARCHED).execute();
    const words = wordsOf(q.q ?? "");
    const text = sql<string>`(lower(name) || ' ' || lower(coalesce((select g.inputs from generations g where g.id = assets.generation_id), '')))`;
    const last = rows.at(-1);
    if (words.length && last && rows.length === SEARCHED) {
      const older = await query
        .where(wordsSieve(words, text))
        .where((eb) => eb.or([eb("created_at", "<", last.created_at), eb.and([eb("created_at", "=", last.created_at), eb("id", "<", last.id)])]))
        .orderBy("created_at", "desc").orderBy("id", "desc").limit(SEARCHED).execute();
      rows = [...rows, ...older];
    }
    await readAll(rows);
    rows = await byFiles(rows, q);
    return words.length ? fuzzyFilter(rows, q.q!, (a) => `${a.name} ${(a.generation_id && readings.get(a.generation_id)?.words) || ""}`) : rows;
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
    const withIds = z.object({ ids: z.string().optional() }).parse(req.query).ids === "1";
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
    // and the model family it was made with: the stage groups a draft's results by it, Compare says it of each side
    const families = new Map<string, string>();
    if (gens.length) {
      const found = await s.db.selectFrom("generations").leftJoin("drafts", "drafts.id", "generations.draft_id")
        .select(["generations.id as gen", "generations.draft_id as draft", "generations.recipe_id as recipe", "generations.family as family", "generations.inputs as inputs", "drafts.name as name", "drafts.title as title"])
        .where("generations.id", "in", gens).execute();
      // a draft with no name nor title is called after the start of the prompt it was sent with, as its results are (autoName.ts)
      for (const g of found) {
        if (g.family) families.set(g.gen, g.family);
        if (g.draft) drafts.set(g.gen, { id: g.draft, name: draftLabel({ name: g.name, title: g.title, prompt: promptOf(readJson<Record<string, unknown>>(g.inputs, {})), recipe: s.registry.recipe(g.recipe)?.title ?? recipeWords(g.recipe) }) });
      }
    }
    const shown = await shownNames(s.db, rows, (id) => s.registry.recipe(id)?.title);
    return rows.map((r) => ({ ...assetView(r), ...(shown.has(r.id) ? { shownName: shown.get(r.id)! } : {}), clipOf: placed.get(r.id) ?? null, draftOf: (r.generation_id && drafts.get(r.generation_id)) || null, family: (r.generation_id && families.get(r.generation_id)) || null }));
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
