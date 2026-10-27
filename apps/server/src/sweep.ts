import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sql, type Kysely } from "kysely";
import { UNKEPT_MS } from "@afflatus/core";
import { now, toRun, type Db, type Tables } from "./db";
import { onPostgres } from "./migrations/dialect";
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
/**
 * How many undoNamed reads before it lets the server answer something else: up to 280 KB each (a 150-clip timeline), so
 * that each page holds the event loop for a few ms, not the whole read's 100 ms.
 */
const AHEAD_PAGE = 20;

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
 * `undo` given as what undoNamed read ahead: those ids, and only the steps kept since are read here.
 */
export async function inUse(db: Kysely<Tables>, opts: { takes?: boolean; jobs?: boolean; undo?: boolean | UndoNamed } = {}): Promise<Map<string, string>> {
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
    const jobs = await db.selectFrom("jobs").select(["inputs", "resume"]).where(toRun).execute();
    scan(jobs.flatMap((j) => [j.inputs, j.resume]), "a job still to run");
  }
  // what a timeline's Undo and Redo would put back (at most HISTORY steps each way), read last so that what uses it now
  // says so: erased, an Undo brought its clip back without its take (the take of a window a trim out had dropped among
  // them). Only for erasing: refused a Bin or an Unkeep, an item named only there stayed for as long as the timeline was
  // left alone, with advice that could not be followed. Read a page at a time: every snapshot of every timeline at once
  // held hundreds of MB inside the sweep's transaction
  if (opts.undo === true) {
    for (const table of UNDO_TABLES) {
      for (let after = ""; ;) {
        const page = await db.selectFrom(table).select(["id", "snapshot"]).where("id", ">", after).orderBy("id").limit(SNAPSHOT_PAGE).execute();
        scan(page.map((r) => r.snapshot), "a timeline's Undo", ID_IN_NESTED_JSON);
        if (page.length < SNAPSHOT_PAGE) break;
        after = page.at(-1)!.id;
      }
    }
  } else if (opts.undo) {
    const ahead = opts.undo;
    add([...ahead.ids], "a timeline's Undo");
    // a step kept since the read ahead (an edit made meanwhile) is read here, in the transaction: its ids alone are listed,
    // from the key's index, without the snapshots
    for (const table of UNDO_TABLES) {
      const since = (await db.selectFrom(table).select("id").execute()).map((r) => r.id).filter((id) => !ahead.read.has(id));
      for (let i = 0; i < since.length; i += 500) {
        scan((await db.selectFrom(table).select("snapshot").where("id", "in", since.slice(i, i + 500)).execute()).map((r) => r.snapshot), "a timeline's Undo", ID_IN_NESTED_JSON);
      }
    }
  }
  return used;
}

const UNDO_TABLES = ["timeline_history", "timeline_future"] as const;

/** The tables inUse reads: what names an item. */
const NAMING_TABLES = ["clips", "takes", "timelines", "entities", "drafts", "jobs", ...UNDO_TABLES] as const;
/**
 * How long a change made with withUseHeld waits for a lock on Postgres before it gives up and starts again: under
 * Postgres's deadlock_timeout (a second unless set otherwise), so that in a deadlock with a save it is this side that
 * gives way, and the save that goes through.
 */
const HELD_LOCK_WAIT = "500ms";
/** How many times it starts again before the error is the caller's. */
const HELD_TRIES = 5;

/**
 * `work` in a transaction where what names an item (inUse) holds still between the read and the change made from it: a
 * bin, an unkeep, an erase. On SQLite, the one connection does that already: the transaction has it to itself. On Postgres
 * (a pool, READ COMMITTED), a draft saved or a clip placed between the read and the change was not seen, and the item went
 * all the same: the tables inUse reads are locked first in SHARE mode, which waits for a save under way and holds the next
 * until the commit (the library's own changes, to the assets, go on). A save that took the item's row first and then waits
 * here would deadlock with the change: this side gives up first (HELD_LOCK_WAIT) and starts again, `work` and all.
 */
export async function withUseHeld<T>(db: Db, work: (tx: Db) => Promise<T>): Promise<T> {
  if (!onPostgres(db)) return db.transaction().execute(work);
  for (let tries = 1; ; tries++) {
    try {
      return await db.transaction().execute(async (tx) => {
        await sql`set local lock_timeout = ${sql.lit(HELD_LOCK_WAIT)}`.execute(tx);
        await sql`lock table ${sql.join(NAMING_TABLES.map((t) => sql.table(t)))} in share mode`.execute(tx);
        return work(tx);
      });
    } catch (err) {
      // 55P03: a lock not had in time; 40P01: a deadlock Postgres broke on this side
      const code = (err as { code?: string }).code;
      if (tries >= HELD_TRIES || (code !== "55P03" && code !== "40P01")) throw err;
      await new Promise((r) => setTimeout(r, 50 * tries));
    }
  }
}

/** What every timeline's Undo and Redo would put back (undoNamed): the ids, and the steps they were read from. */
export interface UndoNamed {
  ids: Set<string>;
  read: Set<string>;
}

/**
 * The ids every kept Undo and Redo step names, read once for a whole sweep and outside its transactions, a few pages at a
 * time with the server let in between. Read in each of the sweep's two transactions, the scan of every snapshot (33 MB at
 * a heavy user's scale) held the server twice, 216 ms in one block. A step dropped meanwhile (past the 40 kept) still keeps
 * what it named until the next sweep, which only waits longer; one kept meanwhile is read by inUse in the transaction.
 */
export async function undoNamed(db: Kysely<Tables>): Promise<UndoNamed> {
  const out: UndoNamed = { ids: new Set(), read: new Set() };
  for (const table of UNDO_TABLES) {
    for (let after = ""; ;) {
      const page = await db.selectFrom(table).select(["id", "snapshot"]).where("id", ">", after).orderBy("id").limit(AHEAD_PAGE).execute();
      for (const r of page) {
        out.read.add(r.id);
        for (const m of r.snapshot.matchAll(ID_IN_NESTED_JSON)) out.ids.add(m[1]!);
      }
      if (page.length < AHEAD_PAGE) break;
      after = page.at(-1)!.id;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  return out;
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
 * is). Returns how many `due` picked and the rows erased. `undo`: what the Undo steps name, when read ahead (undoNamed).
 */
export async function eraseUnused(db: Db, storage: Storage, due: (tx: Db) => Promise<Erased[]>, undo: true | UndoNamed = true): Promise<{ picked: number; erased: Erased[] }> {
  const { picked, erased } = await withUseHeld(db, async (tx) => {
    const used = await inUse(tx, { undo });
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
 * whatever the bin keeps: it is no item of the library. The files no item names go after a day too (sweepOrphans), but
 * never one a library set aside in `backups` names. Returns how many items each rule touched.
 */
export async function sweep(db: Db, storage: Storage, at = Date.now(), keep: Keep = { unkeptMs: UNKEPT_MS, binMs: BIN_MS }, backups: string | null = null): Promise<{ binned: number; erased: number }> {
  // what the Undo steps name, read once for both transactions below and outside them
  const undo = await undoNamed(db);
  // what is in use read in the same transaction as the binning: an item picked into a draft or kept in between stays out
  const binned = keep.unkeptMs === null ? 0 : await withUseHeld(db, async (tx) => {
    const unkeptBefore = new Date(at - keep.unkeptMs!).toISOString();
    const used = await inUse(tx, { undo });
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
  ], undo);
  await sweepOrphans(db, storage, at, backups).catch((err) => console.warn("[sweep] files with no item:", (err as Error).message));
  return { binned, erased: erased.length };
}

/** Where a library item's files are kept, each named after the item's id ("assets/ab/<id>.png", "thumbs/ab/<id>.webp"). */
const ITEM_DIRS = ["assets/", "thumbs/"];
/**
 * Where what the timeline works out of a video is kept, each named after the item's id too (timelineModel.ts derivedKeys):
 * its film strips at every size asked, its motion, scene cuts, pauses, colour, join scores, sound end (before 0.7.1's song track) and a recording's gain. Erasing an item takes the
 * ones derivedKeys names, but not a strip of a size asked once, nor anything of a linked file forgotten (linked.ts).
 */
const DERIVED_DIRS = ["strips/", "motion/", "scenes/", "pauses/", "means/", "joins/", "sounds/", "gains/"];
const ITEM_FILE = /^([0-9a-f]{32})[.-]/;
/** The columns of an item's row that name a file of the storage. */
const KEY_COLUMNS = ["file_key", "thumb_key", "raw_key", "latent_key", "fine_latent_key"] as const;

/** What a library names: its items' ids, and the files their rows name. A file of neither is an orphan to it. */
export interface Named {
  ids: Set<string>;
  keys: Set<string>;
}

const namedBy = (rows: Array<Record<string, unknown>>, into: Named = { ids: new Set(), keys: new Set() }): Named => {
  for (const r of rows) {
    if (typeof r.id === "string") into.ids.add(r.id);
    for (const c of KEY_COLUMNS) if (typeof r[c] === "string") into.keys.add(r[c]);
  }
  return into;
};

/**
 * What the library in a SQLite file names, read-only: a library set aside (backups/after-*.db) or the copy a Go back
 * restores. A copy from an older version may lack the newer key columns: only those it has are read.
 */
export function namedIn(file: string, into?: Named): Named {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const has = new Set((db.prepare("PRAGMA table_info(assets)").all() as Array<{ name: string }>).map((c) => c.name));
    if (!has.has("id")) throw new Error(`${file} has no library items table`);
    const columns = ["id", ...KEY_COLUMNS.filter((c) => has.has(c))];
    return namedBy(db.prepare(`SELECT ${columns.join(", ")} FROM assets`).all() as Array<Record<string, unknown>>, into);
  } finally {
    db.close();
  }
}

/**
 * The files in the folders the orphan sweep reads that `named` does not name: a file named after an item id it lacks, or
 * a ".part" file (`part`). A file not named after an item id is no orphan: it is left alone.
 */
export async function* unnamedFiles(storage: Storage, named: Named): AsyncGenerator<{ key: string; part: boolean; mtimeMs(): Promise<number | null> }> {
  if (!storage.list) return;
  for (const dir of [...ITEM_DIRS, ...DERIVED_DIRS]) {
    for await (const f of storage.list(dir)) {
      if (named.keys.has(f.key)) continue;
      const name = f.key.slice(f.key.lastIndexOf("/") + 1);
      const part = name.endsWith(".part");
      const id = ITEM_FILE.exec(name)?.[1];
      if (!part && (!id || named.ids.has(id))) continue;
      yield { key: f.key, part, mtimeMs: f.mtimeMs };
    }
  }
}

/**
 * What the libraries set aside in `backups` name (after-*.db: put aside by a Go back, updatesGoBack.ts, or by the
 * launcher when a new version did not start, launch.mjs): what was made after an update that was gone back on. Go back
 * moves those files out of the swept folders (set-aside/), but one left there is that library's, never an orphan.
 * Throws when one cannot be read: then nothing can be told an orphan.
 */
async function namedAside(backups: string, into: Named): Promise<void> {
  const names = await readdir(backups).catch(() => [] as string[]);
  for (const name of names) if (/^after-.+\.db$/.test(name)) namedIn(join(backups, name), into);
}

/**
 * The files of the library that no item names any more, erased: what was left when a server stopped between writing a
 * file and its row, or when a row went and its file could not be removed then, what was worked out of an item that is
 * gone, and the half-written ".part" files of a write that stopped (storage.ts). Careful by design: only in the folders
 * where items' files and what is derived from them are kept, only a file named after an item id that no row has and that
 * no row names (here or in a library set aside in `backups`), or a ".part" file, and only a day after it was last
 * written, so that a render or an upload writing its files now is never taken. The names are compared first and only
 * those few files' times read: read for every file, it was a stat per file of the library at every start and every
 * hour. Returns how many were erased.
 */
export async function sweepOrphans(db: Db, storage: Storage, at = Date.now(), backups: string | null = null): Promise<number> {
  if (!storage.list) return 0;
  const rows = await db.selectFrom("assets").select(["id", ...KEY_COLUMNS]).execute();
  const named = namedBy(rows);
  if (backups) {
    try {
      await namedAside(backups, named);
    } catch (err) {
      console.warn(`[sweep] a library set aside in backups/ could not be read (${(err as Error).message}): no file with no item erased`);
      return 0;
    }
  }
  const due: string[] = [];
  let items = 0;
  for await (const f of unnamedFiles(storage, named)) {
    const written = await f.mtimeMs();
    if (written === null || at - written < UNKEPT_MS) continue;
    due.push(f.key);
    if (!f.part) items++;
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
