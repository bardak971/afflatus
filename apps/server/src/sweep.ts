import type { Kysely } from "kysely";
import { now, type Db, type Tables } from "./db";
import type { Storage } from "./storage";
import { derivedKeys } from "./timelineModel";

export const UNKEPT_MS = 24 * 60 * 60_000;
export const BIN_MS = 7 * 24 * 60 * 60_000;

/** An asset id as it is written inside a JSON document (a person's pictures, a preset's form, a job's inputs). */
const ID_IN_JSON = /"([0-9a-f]{32})"/g;

/**
 * The assets something still needs, each with what needs it (for saying so): the take that plays in a clip,
 * a take another take was finished from or carries on from, a clip's still, its sound and the pictures its
 * form names, a timeline's music, the pictures and voices of people, places, styles and presets, the pictures
 * a draft's forms and look name and the item it edits, and the inputs of a job that is still to run (and what
 * it was sent with: the neighbour video or the opening frame picked when it was submitted). Unkept, binned or
 * erased, any of these would leave a clip, a person, a draft or a job pointing at nothing: the sweep, the bin
 * and the library leave them alone. `takes: false`: all of it but the takes, for what works out on its own which
 * takes are needed (timelineUnused.ts). `jobs: false`: all of it but the jobs, for a job asking about its own inputs.
 */
export async function inUse(db: Kysely<Tables>, opts: { takes?: boolean; jobs?: boolean } = {}): Promise<Map<string, string>> {
  const used = new Map<string, string>();
  const add = (ids: Array<string | null>, what: string) => {
    for (const id of ids) if (id && !used.has(id)) used.set(id, what);
  };
  const scan = (texts: Array<string | null>, what: string) => {
    for (const text of texts) for (const m of (text ?? "").matchAll(ID_IN_JSON)) if (!used.has(m[1]!)) used.set(m[1]!, what);
  };
  if (opts.takes !== false) {
    add((await db.selectFrom("clips").innerJoin("takes", "takes.id", "clips.take_id").select("takes.asset_id").execute()).map((r) => r.asset_id), "a timeline");
    const named = await db
      .selectFrom("takes")
      .select("asset_id")
      .where((eb) => eb.or([
        eb("id", "in", eb.selectFrom("takes as t").select("t.finished_from").where("t.finished_from", "is not", null)),
        eb("id", "in", eb.selectFrom("takes as t").select("t.prev_take_id").where("t.prev_take_id", "is not", null)),
      ]))
      .execute();
    add(named.map((r) => r.asset_id), "a timeline");
  }
  const clips = await db.selectFrom("clips").select(["still_asset_id", "sound_asset_id", "inputs"]).execute();
  add(clips.flatMap((c) => [c.still_asset_id, c.sound_asset_id]), "a timeline");
  scan(clips.map((c) => c.inputs), "a timeline");
  add((await db.selectFrom("timelines").select("music_asset_id").execute()).map((t) => t.music_asset_id), "a timeline");
  scan((await db.selectFrom("entities").select("def").execute()).map((e) => e.def), "a person, a place, a style or a preset");
  const drafts = await db.selectFrom("drafts").select(["forms", "look", "target"]).execute();
  scan(drafts.flatMap((d) => [d.forms, d.look]), "a draft");
  add(drafts.map((d) => /^asset:([0-9a-f]{32})$/.exec(d.target)?.[1] ?? null), "a draft");
  if (opts.jobs !== false) {
    const jobs = await db.selectFrom("jobs").select(["inputs", "resume"]).where("status", "in", ["queued", "running"]).execute();
    scan(jobs.flatMap((j) => [j.inputs, j.resume]), "a job still to run");
  }
  return used;
}

/** Erase an asset for good: its row first (nothing can name a file that is about to go), then its files and what was derived from them. */
export async function eraseAsset(db: Db, storage: Storage, a: Pick<Tables["assets"], "id" | "file_key" | "thumb_key" | "raw_key" | "latent_key" | "fine_latent_key" | "duration_ms">): Promise<void> {
  await db.deleteFrom("assets").where("id", "=", a.id).execute();
  for (const key of [a.file_key, a.thumb_key, a.raw_key, a.latent_key, a.fine_latent_key]) if (key) await storage.delete(key).catch(() => {});
  // what the timeline worked out of it (its film strip, its motion, its scene cuts) goes with it
  for (const key of derivedKeys(a)) await storage.delete(key).catch(() => {});
}

/** The columns eraseAsset needs. */
export const ERASED = ["id", "file_key", "thumb_key", "raw_key", "latent_key", "fine_latent_key", "duration_ms"] as const;

/**
 * The one place the two expiry rules live:
 *  - a result nobody kept goes to the bin a day after it was made, or a day after its countdown was last
 *    started again (unkept after being kept, taken back from the bin: see assets.countdown_from);
 *  - what has been in the bin for a week is erased, file and all.
 * What is still in use (see inUse) is neither binned nor erased. Returns how many items each rule touched.
 */
export async function sweep(db: Db, storage: Storage, at = Date.now()): Promise<{ binned: number; erased: number }> {
  const used = await inUse(db);
  const due = await db
    .selectFrom("assets")
    .select("id")
    .where("deleted_at", "is", null)
    .where("kept_at", "is", null)
    .where("origin", "=", "generated")
    .where((eb) => eb(eb.fn.coalesce("countdown_from", "created_at"), "<", new Date(at - UNKEPT_MS).toISOString()))
    .execute();
  const bin = due.map((a) => a.id).filter((id) => !used.has(id));
  let binned = 0;
  for (let i = 0; i < bin.length; i += 500) {
    const r = await db.updateTable("assets").set({ deleted_at: now() }).where("id", "in", bin.slice(i, i + 500)).where("deleted_at", "is", null).executeTakeFirst();
    binned += Number(r.numUpdatedRows);
  }

  const old = await db.selectFrom("assets").select(ERASED).where("deleted_at", "<", new Date(at - BIN_MS).toISOString()).execute();
  // a painted part that nothing was made with is of no use to anyone after a week
  const masks = await db
    .selectFrom("assets")
    .select(ERASED)
    .where("origin", "=", "mask")
    .where("created_at", "<", new Date(at - BIN_MS).toISOString())
    .where("id", "not in", db.selectFrom("generation_inputs").select("asset_id"))
    .execute();
  const gone = [...old, ...masks].filter((a) => !used.has(a.id));
  for (const a of gone) await eraseAsset(db, storage, a);
  await sweepOrphans(db, storage, at).catch((err) => console.warn("[sweep] files with no item:", (err as Error).message));
  return { binned, erased: gone.length };
}

/** Where a library item's files are kept, each named after the item's id ("assets/ab/<id>.png", "thumbs/ab/<id>.webp"). */
const ITEM_DIRS = ["assets/", "thumbs/"];
const ITEM_FILE = /^([0-9a-f]{32})[.-]/;

/**
 * The files of the library that no item names any more, erased: what was left when a server stopped between writing a
 * file and its row, or when a row went and its file could not be removed then, and the half-written ".part" files of a
 * write that stopped (storage.ts). Careful by design: only in the folders where items' files are kept, only a file named
 * after an item id that no row has and that no row names, or a ".part" file, and only a day after it was last written,
 * so that a render or an upload writing its files now is never taken. Returns how many were erased.
 */
export async function sweepOrphans(db: Db, storage: Storage, at = Date.now()): Promise<number> {
  if (!storage.list) return 0;
  const rows = await db.selectFrom("assets").select(["id", "file_key", "thumb_key", "raw_key", "latent_key", "fine_latent_key"]).execute();
  const ids = new Set(rows.map((r) => r.id));
  const named = new Set(rows.flatMap((r) => [r.file_key, r.thumb_key, r.raw_key, r.latent_key, r.fine_latent_key]));
  let erased = 0;
  for (const dir of ITEM_DIRS) {
    for await (const f of storage.list(dir)) {
      if (at - f.mtimeMs < UNKEPT_MS || named.has(f.key)) continue;
      const name = f.key.slice(f.key.lastIndexOf("/") + 1);
      const id = ITEM_FILE.exec(name)?.[1];
      if (!name.endsWith(".part") && (!id || ids.has(id))) continue;
      await storage.delete(f.key).catch(() => {});
      erased++;
    }
  }
  return erased;
}
