import type { Kysely } from "kysely";
import { UNKEPT_MS } from "@afflatus/core";
import { now, type Db, type Tables } from "./db";
import type { Storage } from "./storage";
import { SCRATCH_MS } from "./library";
import { smallThumbKey } from "./thumbs";
import { derivedKeys } from "./timelineModel";

// the day an unkept result has is core's (the library's tiles count down to it); the tests read it from here, beside BIN_MS
export { UNKEPT_MS };
export const BIN_MS = 7 * 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** How long the two rules wait, from the settings (unkeptDays, binDays); null: that rule does not run. */
export interface Keep {
  unkeptMs: number | null;
  binMs: number | null;
}
/** What the settings say, as the sweep takes it: 0 days is never. */
export const keepOf = (s: { unkeptDays: number; binDays: number }): Keep => ({ unkeptMs: s.unkeptDays ? s.unkeptDays * DAY_MS : null, binMs: s.binDays ? s.binDays * DAY_MS : null });

/** How many Undo snapshots inUse reads at once. */
const SNAPSHOT_PAGE = 100;

/** An asset id as it is written inside a JSON document (a person's pictures, a preset's form, a job's inputs). */
const ID_IN_JSON = /"([0-9a-f]{32})"/g;
/** The same, also inside JSON kept as a string within JSON (an Undo snapshot's clip inputs and source), its quotes escaped. */
export const ID_IN_NESTED_JSON = /"([0-9a-f]{32})\\*"/g;

/**
 * The assets something still needs, each with what needs it (for saying so): the take that plays in a clip,
 * a take another take was finished from or carries on from, a clip's still, its sound and the pictures its
 * form names, a timeline's music, the pictures and voices of people, places, styles and presets, the pictures
 * a draft's forms and look name, and the inputs of a job that is still to run (and what
 * it was sent with: the neighbour video or the opening frame picked when it was submitted). Unkept, binned or
 * erased, any of these would leave a clip, a person, a draft or a job pointing at nothing: the sweep, the bin
 * and the library leave them alone. `takes: false`: all of it but the takes, for what works out on its own which
 * takes are needed (timelineUnused.ts). `jobs: false`: all of it but the jobs, for a job asking about its own inputs.
 * `undo: true`: also what a timeline's Undo and Redo would put back, for what erases (the sweep, a linked file forgotten);
 * not for the bin and Unkeep, which a restore undoes (TimelineHistory.restore takes back out of the bin what it puts back).
 */
export async function inUse(db: Kysely<Tables>, opts: { takes?: boolean; jobs?: boolean; undo?: boolean } = {}): Promise<Map<string, string>> {
  const used = new Map<string, string>();
  const add = (ids: Array<string | null>, what: string) => {
    for (const id of ids) if (id && !used.has(id)) used.set(id, what);
  };
  const scan = (texts: Array<string | null>, what: string, ids = ID_IN_JSON) => {
    for (const text of texts) for (const m of (text ?? "").matchAll(ids)) if (!used.has(m[1]!)) used.set(m[1]!, what);
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
  // a timeline's music, its source video, and the takes of the windows and Lip sync clips a trim set aside (kept whole
  // in its source and recordings, out of the takes table): a trim out brings them back, playing those videos
  const timelines = await db.selectFrom("timelines").select(["music_asset_id", "source", "recordings"]).execute();
  add(timelines.map((t) => t.music_asset_id), "a timeline");
  scan(timelines.flatMap((t) => [t.source ?? null, t.recordings ?? null]), "a timeline");
  scan((await db.selectFrom("entities").select("def").execute()).map((e) => e.def), "a person, a place, a style or a preset");
  const drafts = await db.selectFrom("drafts").select(["forms", "look"]).execute();
  scan(drafts.flatMap((d) => [d.forms, d.look]), "a draft");
  if (opts.jobs !== false) {
    const jobs = await db.selectFrom("jobs").select(["inputs", "resume"]).where("status", "in", ["queued", "running"]).execute();
    scan(jobs.flatMap((j) => [j.inputs, j.resume]), "a job still to run");
  }
  // what a timeline's Undo and Redo would put back (at most HISTORY steps each way), read last so that what uses it now
  // says so: erased, an Undo brought its clip back without its take (the take of a window a trim out had dropped among
  // them). Only for erasing: refused a Bin or an Unkeep, an item named only there stayed for as long as the timeline was
  // left alone, with advice that could not be followed. Read a page at a time: every snapshot of every timeline at once
  // held hundreds of MB inside the sweep's transaction
  if (opts.undo) {
    for (const table of ["timeline_history", "timeline_future"] as const) {
      for (let after = ""; ;) {
        const page = await db.selectFrom(table).select(["id", "snapshot"]).where("id", ">", after).orderBy("id").limit(SNAPSHOT_PAGE).execute();
        scan(page.map((r) => r.snapshot), "a timeline's Undo", ID_IN_NESTED_JSON);
        if (page.length < SNAPSHOT_PAGE) break;
        after = page.at(-1)!.id;
      }
    }
  }
  return used;
}

type Erased = Pick<Tables["assets"], "id" | "file_key" | "thumb_key" | "raw_key" | "latent_key" | "fine_latent_key" | "duration_ms">;

/** Erase an asset for good: its row first (nothing can name a file that is about to go), then its files and what was derived from them. For the tests (the app erases through eraseUnused). @internal */
export async function eraseAsset(db: Db, storage: Storage, a: Erased): Promise<void> {
  await db.deleteFrom("assets").where("id", "=", a.id).execute();
  await eraseFiles(storage, a);
}

/** The files of an asset whose row is gone, and what was derived from them. */
async function eraseFiles(storage: Storage, a: Erased): Promise<void> {
  for (const key of [a.file_key, a.thumb_key, a.raw_key, a.latent_key, a.fine_latent_key]) if (key) await storage.delete(key).catch(() => {});
  // the small thumbnail, made on first ask and named in no row
  await storage.delete(smallThumbKey(a.id)).catch(() => {});
  // what the timeline worked out of it (its film strip, its motion, its scene cuts) goes with it
  for (const key of derivedKeys(a)) await storage.delete(key).catch(() => {});
}

/** The columns eraseAsset needs. */
export const ERASED = ["id", "file_key", "thumb_key", "raw_key", "latent_key", "fine_latent_key", "duration_ms"] as const;

/**
 * Erase for good what `due` picks, but what something uses (inUse): the check, the picking and the rows' deletion in one
 * transaction, then the files of the rows that went. Done item after item, an item put back from the bin or picked into
 * a draft meanwhile was erased all the same. A row is only deleted while it is in the bin (or a painted part, which never
 * is). Returns how many `due` picked and the rows erased.
 */
export async function eraseUnused(db: Db, storage: Storage, due: (tx: Db) => Promise<Erased[]>): Promise<{ picked: number; erased: Erased[] }> {
  const { picked, erased } = await db.transaction().execute(async (tx) => {
    const used = await inUse(tx, { undo: true });
    const all = await due(tx);
    const ids = all.filter((a) => !used.has(a.id)).map((a) => a.id);
    const out: Erased[] = [];
    // in slices: SQLite takes a limited number of values in one statement
    for (let i = 0; i < ids.length; i += 500) {
      out.push(...await tx.deleteFrom("assets").where("id", "in", ids.slice(i, i + 500))
        .where((eb) => eb.or([eb("deleted_at", "is not", null), eb("origin", "in", ["mask", "scratch"])]))
        .returning(ERASED).execute());
    }
    return { picked: all.length, erased: out };
  });
  for (const a of erased) await eraseFiles(storage, a);
  return { picked, erased };
}

/**
 * The one place the two expiry rules live, each waiting as long as the settings say (`keep`, a day and a week unless
 * told otherwise; null: the rule does not run):
 *  - a result nobody kept goes to the bin its time after it was made, or after its countdown was last started again
 *    (unkept after being kept, taken back from the bin: see assets.countdown_from);
 *  - what has been in the bin its time is erased, file and all.
 * What is still in use (see inUse) is neither binned nor erased. A painted part nothing was made with goes after a week
 * whatever the bin keeps: it is no item of the library. Returns how many items each rule touched.
 */
export async function sweep(db: Db, storage: Storage, at = Date.now(), keep: Keep = { unkeptMs: UNKEPT_MS, binMs: BIN_MS }): Promise<{ binned: number; erased: number }> {
  // what is in use read in the same transaction as the binning: an item picked into a draft or kept in between stays out
  const binned = keep.unkeptMs === null ? 0 : await db.transaction().execute(async (tx) => {
    const unkeptBefore = new Date(at - keep.unkeptMs!).toISOString();
    const used = await inUse(tx, { undo: true });
    const due = await tx
      .selectFrom("assets")
      .select("id")
      .where("deleted_at", "is", null)
      .where("kept_at", "is", null)
      .where("origin", "=", "generated")
      .where((eb) => eb(eb.fn.coalesce("countdown_from", "created_at"), "<", unkeptBefore))
      .execute();
    const bin = due.map((a) => a.id).filter((id) => !used.has(id));
    let n = 0;
    for (let i = 0; i < bin.length; i += 500) {
      const r = await tx.updateTable("assets").set({ deleted_at: now() }).where("id", "in", bin.slice(i, i + 500)).where("deleted_at", "is", null).where("kept_at", "is", null).executeTakeFirst();
      n += Number(r.numUpdatedRows);
    }
    return n;
  });

  const maskBefore = new Date(at - BIN_MS).toISOString();
  const scratchBefore = new Date(at - SCRATCH_MS).toISOString();
  const { erased } = await eraseUnused(db, storage, async (tx) => [
    ...(keep.binMs === null ? [] : await tx.selectFrom("assets").select(ERASED).where("deleted_at", "<", new Date(at - keep.binMs).toISOString()).execute()),
    // a painted part that nothing was made with is of no use to anyone after a week, whatever the bin keeps
    ...await tx
      .selectFrom("assets")
      .select(ERASED)
      .where("origin", "=", "mask")
      .where("created_at", "<", maskBefore)
      .where("id", "not in", tx.selectFrom("generation_inputs").select("asset_id"))
      .execute(),
    // a box's working picture (a frame read, a picture not picked) a day on: what is in use (a picked one put in a form,
    // a job still to run on it) stays, as everywhere
    ...await tx.selectFrom("assets").select(ERASED).where("origin", "=", "scratch").where("kept_at", "is", null).where("created_at", "<", scratchBefore).execute(),
  ]);
  await sweepOrphans(db, storage, at).catch((err) => console.warn("[sweep] files with no item:", (err as Error).message));
  return { binned, erased: erased.length };
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
  const due: string[] = [];
  let items = 0;
  for (const dir of ITEM_DIRS) {
    for await (const f of storage.list(dir)) {
      if (at - f.mtimeMs < UNKEPT_MS || named.has(f.key)) continue;
      const name = f.key.slice(f.key.lastIndexOf("/") + 1);
      const id = ITEM_FILE.exec(name)?.[1];
      if (!name.endsWith(".part") && (!id || ids.has(id))) continue;
      due.push(f.key);
      if (!name.endsWith(".part")) items++;
    }
  }
  // A database with no item at all beside a folder of items' files is not a library whose items all went: it is a
  // database that is not this folder's (a new one made where the library's went missing, a Go back stopped halfway).
  // Its files are the library, so nothing is erased until the database names them again.
  if (!rows.length && items > 0) {
    console.warn(`[sweep] the database has no item but the files folder has ${items} items' files: nothing erased (is afflatus.db the library's own?)`);
    return 0;
  }
  for (const key of due) await storage.delete(key).catch(() => {});
  return due.length;
}
