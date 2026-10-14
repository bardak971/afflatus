import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ModelInfo } from "@afflatus/core";
import { civitaiGet, findOnCivitai } from "./civitai";
import { now, type Db } from "./db";
import { httpError } from "./errors";
import { findOnHuggingFace } from "./huggingface";
import type { Services } from "./services";
import { readSettings } from "./settings";

/**
 * The page of a model file (a LoRA, a checkpoint) on the site it came from. A file does not say where
 * it is from, so its page is looked for by its name: a model that has a file of exactly that name is
 * taken as its page and remembered; otherwise the closest ones are offered and the one the user picks
 * is remembered. A file is known by its name alone, so that moving it to another sub-folder keeps it.
 */

export interface ModelPage {
  url: string;
  /** What the page is called there ("Soft light · v2"). */
  title: string;
}

/** A page that may be the file's: shown to choose from. */
export interface PageCandidate extends ModelPage {
  site: string;
  /** What kind of thing it is there, and the model it is for ("LORA · SDXL"). */
  about: string;
}

const FOLDER = /^[\w-]{1,64}$/;
const nameOf = (file: string) => (file.split(/[\\/]/).pop() ?? file).toLowerCase();
/** A page's address: http or https only, since it becomes a link the browser opens (a javascript: one would run). */
export const webUrl = z.string().max(2000).refine((u) => /^https?:\/\/[^\s]+$/i.test(u), "that is not a web address");

/** A model folder's name, as a route is given it: a word, else a 400. */
const folderOf = (folder: string) => {
  if (!FOLDER.test(folder)) throw httpError("there is no such model folder");
  return folder;
};
/**
 * A lookup that found no page is kept a day as a row with no address: the searches, set lists and pods ask for the same
 * files over and over, and asking both sites each time for a file they do not have is slow and wears the user's allowance.
 */
const MISS_MS = 24 * 60 * 60_000;
/** The file's page, when one is known (a row with an address: the others are misses). */
const known = async (db: Db, folder: string, name: string): Promise<ModelPage | null> =>
  (await db.selectFrom("model_pages").select(["url", "title"]).where("folder", "=", folder).where("name", "=", name).where("url", "!=", "").executeTakeFirst()) ?? null;
/** The page known for a file, without asking any site. */
export const knownPage = (db: Db, folder: string, file: string) => known(db, folder, nameOf(file));
/** Whether the sites were asked for the file less than a day ago and had no page for it. */
const missed = async (db: Db, folder: string, name: string): Promise<boolean> => {
  const row = await db.selectFrom("model_pages").select("found_at").where("folder", "=", folder).where("name", "=", name).where("url", "=", "").executeTakeFirst();
  return Boolean(row && Date.now() - Date.parse(row.found_at) < MISS_MS);
};
const remember = async (db: Db, folder: string, name: string, page: ModelPage) => {
  await db
    .insertInto("model_pages")
    .values({ folder, name, url: page.url, title: page.title, found_at: now() })
    .onConflict((oc) => oc.columns(["folder", "name"]).doUpdateSet({ url: page.url, title: page.title, found_at: now() }))
    .execute();
};

/** What the file's header gave as its fingerprint, when it was read and has one. The file is found by its path, else by its name. */
const fingerprintOf = async (db: Db, folder: string, file: string): Promise<string | null> => {
  const rows = await db.selectFrom("model_info").select(["file", "info"]).where("folder", "=", folder).execute();
  const row = rows.find((r) => r.file === file) ?? rows.find((r) => nameOf(r.file) === nameOf(file));
  return row ? (JSON.parse(row.info) as ModelInfo).fingerprint ?? null : null;
};

/**
 * Look for a file's page. Known already: that one. Otherwise, when looking things up is turned on in Settings, Civitai by
 * the file's fingerprint (the same file under any name), then Civitai (both sites) and Hugging Face by its name: a model
 * with a file of exactly this name is its page and is remembered; the others found are offered. A page found by the name
 * is shown to the user as the file's, but a rented pod takes it as the file's source only when this computer has no copy,
 * or the site's file has this copy's very hash (podSources.ts): a name like pytorch_lora_weights.safetensors is many files.
 */
export async function lookUpPage(db: Db, folder: string, file: string, o: { fresh?: boolean } = {}): Promise<{ page: ModelPage | null; candidates: PageCandidate[]; lookups: boolean }> {
  const name = nameOf(file);
  const page = await known(db, folder, name);
  if (page) return { page, candidates: [], lookups: true };
  const settings = await readSettings(db);
  if (!settings.civitaiLookups) return { page: null, candidates: [], lookups: false };
  // asked a moment ago and found nowhere: not asked again for a day, unless the user asks (fresh: the page's own search)
  if (!o.fresh && (await missed(db, folder, name))) return { page: null, candidates: [], lookups: true };

  // by its fingerprint first: the same file under any name is the same version there
  const print = await fingerprintOf(db, folder, file);
  if (print) {
    const v = await civitaiGet<{ id: number; name?: string; modelId?: number; model?: { name?: string } }>(`/api/v1/model-versions/by-hash/${print}`, settings.civitaiKey).catch(() => null);
    if (v?.modelId) {
      const found = { url: `https://civitai.com/models/${v.modelId}?modelVersionId=${v.id}`, title: [v.model?.name, v.name].filter(Boolean).join(" · ") || "On Civitai" };
      await remember(db, folder, name, found);
      return { page: found, candidates: [], lookups: true };
    }
  }

  const [hf, civitai] = await Promise.all([
    findOnHuggingFace(name).catch(() => ({ items: [], answered: false })),
    findOnCivitai(name, folder, settings.civitaiKey).catch(() => ({ items: [], asked: [] as string[], silent: [] as string[] })),
  ]);
  const candidates: PageCandidate[] = [
    ...civitai.items.map((i) => ({
      url: i.versionId ? `${i.url}?modelVersionId=${i.versionId}` : i.url, title: [i.name, i.version].filter(Boolean).join(" · "),
      site: i.site, about: [i.kind, i.base].filter(Boolean).join(" · "),
    })),
    ...hf.items.map((i) => ({ url: `${i.page}/blob/main/${i.path.split("/").map(encodeURIComponent).join("/")}`, title: i.repo, site: "huggingface.co", about: "has a file of this name" })),
  ];
  // a file of exactly this name: on Civitai that is the model it came from; Hugging Face only ever returns such files
  const exact = civitai.items.findIndex((i) => i.exact);
  const sure = exact >= 0 ? candidates[exact]! : !civitai.items.length && hf.items.length === 1 ? candidates[0]! : null;
  if (sure) await remember(db, folder, name, { url: sure.url, title: sure.title });
  // nothing sure, and both sites answered: a miss kept for a day (a site that did not answer says nothing, asked next time)
  else if (hf.answered && civitai.asked.length && !civitai.silent.length) await remember(db, folder, name, { url: "", title: "" });
  return { page: sure ? { url: sure.url, title: sure.title } : null, candidates: sure ? [] : candidates.slice(0, 8), lookups: true };
}

/** A file's page: the one known, looked for, or the one the user says. The words that call it up are registerModelWords. */
export function registerModelPages(app: FastifyInstance, s: Services): void {
  registerModelWords(app, s);

  /** Every page known for the files of a folder, by file name (lower case, without its sub-folder). */
  app.get<{ Params: { folder: string } }>("/api/models/:folder/pages", async (req) => {
    const rows = await s.db.selectFrom("model_pages").select(["name", "url", "title"]).where("folder", "=", folderOf(req.params.folder)).where("url", "!=", "").execute();
    return { items: Object.fromEntries(rows.map((r) => [r.name, { url: r.url, title: r.title }])) };
  });

  /**
   * Look for a file's page. Known already: that one. Otherwise Civitai (both sites) and Hugging Face
   * are asked, when looking things up is turned on in Settings: a model with a file of exactly this name
   * is its page and is remembered; the others found are offered.
   */
  app.post<{ Params: { folder: string } }>("/api/models/:folder/page", async (req) => {
    const folder = folderOf(req.params.folder);
    const { file } = z.strictObject({ file: z.string().min(1).max(500) }).parse(req.body);
    return lookUpPage(s.db, folder, file, { fresh: true });
  });

  /** The page the user says is the file's (one of those offered, or an address of their own); null forgets it. */
  app.put<{ Params: { folder: string } }>("/api/models/:folder/page", async (req) => {
    const folder = folderOf(req.params.folder);
    const b = z.strictObject({ file: z.string().min(1).max(500), url: webUrl.nullable(), title: z.string().max(300).default("") }).parse(req.body);
    const name = nameOf(b.file);
    if (b.url === null) {
      await s.db.deleteFrom("model_pages").where("folder", "=", folder).where("name", "=", name).execute();
      return { page: null };
    }
    const page = { url: b.url, title: b.title.trim() || new URL(b.url).hostname };
    await remember(s.db, folder, name, page);
    return { page };
  });
}

// ---------------------------------------------------------------- the words that call a model up

type Words = { own: string | null; found: string | null };

/** The words that call a model up, beyond what its file says: the user's own, and those Civitai gave. */
function registerModelWords(app: FastifyInstance, s: Services): void {
  const wordsOf = async (folder: string, names?: string[]): Promise<Record<string, Words>> => {
    let q = s.db.selectFrom("model_words").select(["name", "own", "found"]).where("folder", "=", folder);
    if (names) q = q.where("name", "in", names.length ? names : [""]);
    return Object.fromEntries((await q.execute()).map((r) => [r.name, { own: r.own, found: r.found }]));
  };

  /** The words known for the files of a folder beyond what the files say, by file name (lower case, without its sub-folder). */
  app.get<{ Params: { folder: string } }>("/api/models/:folder/words", async (req) => ({ items: await wordsOf(folderOf(req.params.folder)) }));

  /** The user's own words for a file: they come before any others. Empty takes them away again. */
  app.put<{ Params: { folder: string } }>("/api/models/:folder/words", async (req) => {
    const folder = folderOf(req.params.folder);
    const b = z.strictObject({ file: z.string().min(1).max(500), words: z.string().max(600).nullable() }).parse(req.body);
    const name = nameOf(b.file);
    const own = b.words?.trim() || null;
    await s.db
      .insertInto("model_words")
      .values({ folder, name, own, found: null, asked_at: null })
      .onConflict((oc) => oc.columns(["folder", "name"]).doUpdateSet({ own }))
      .execute();
    return { items: await wordsOf(folder, [name]) };
  });

  /**
   * Ask Civitai for the trigger words of files that say none themselves, each by its fingerprint (never by
   * its name), once: what it answers is kept, and so is the page it gave. Nothing is asked when looking
   * things up is off in Settings, or for a file whose header was not read yet.
   */
  app.post<{ Params: { folder: string } }>("/api/models/:folder/words/find", async (req) => {
    const folder = folderOf(req.params.folder);
    const { files } = z.strictObject({ files: z.array(z.string().min(1).max(500)).max(12) }).parse(req.body);
    const settings = await readSettings(s.db);
    const names = [...new Set(files.map(nameOf))];
    if (!settings.civitaiLookups) return { items: await wordsOf(folder, names), lookups: false };
    const asked = new Set((await s.db.selectFrom("model_words").select("name").where("folder", "=", folder).where("asked_at", "is not", null).execute()).map((r) => r.name));
    const info = await s.db.selectFrom("model_info").select(["file", "info"]).where("folder", "=", folder).execute();
    for (const file of files) {
      const name = nameOf(file);
      if (asked.has(name)) continue;
      const row = info.find((r) => r.file === file) ?? info.find((r) => nameOf(r.file) === name);
      // not read yet: its fingerprint is not known, it is asked the next time
      if (!row) continue;
      asked.add(name);
      const print = (JSON.parse(row.info) as ModelInfo).fingerprint;
      let found: string | null = null;
      if (print) {
        let v: { id: number; name?: string; modelId?: number; trainedWords?: string[]; model?: { name?: string } } | null;
        try {
          v = await civitaiGet(`/api/v1/model-versions/by-hash/${print}`, settings.civitaiKey);
        } catch {
          // Civitai is away: it is asked again another time
          asked.delete(name);
          continue;
        }
        if (v?.modelId) {
          found = (v.trainedWords ?? []).map((w) => w.trim()).filter(Boolean).slice(0, 20).join(", ");
          if (!(await known(s.db, folder, name))) await remember(s.db, folder, name, { url: `https://civitai.com/models/${v.modelId}?modelVersionId=${v.id}`, title: [v.model?.name, v.name].filter(Boolean).join(" · ") || "On Civitai" });
        }
      }
      await s.db
        .insertInto("model_words")
        .values({ folder, name, own: null, found, asked_at: now() })
        .onConflict((oc) => oc.columns(["folder", "name"]).doUpdateSet({ found, asked_at: now() }))
        .execute();
    }
    return { items: await wordsOf(folder, names), lookups: true };
  });
}
