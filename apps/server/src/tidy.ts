import { setImmediate as turn } from "node:timers/promises";
import { SqliteAdapter, sql } from "kysely";
import type { Db } from "./db";
import { readJson } from "./queueModel";
import { dropGoneMachines } from "./settings";

/**
 * How long a finished job keeps the whole of what it was sent with (jobs.resume: its outputs, phases, passes, loads, timing,
 * the inputs as sent; 1.5 KB on average, 42 % of a row). Only a few keys of it are read once it has ended, and a day is far
 * past the longest of those reads (queueOutside.ts OWN_KEPT_MS, two minutes).
 */
export const RESUME_KEPT_MS = 24 * 60 * 60_000;

/**
 * What of a finished job's resume is still read, or may be: `promptId` (ComfyUI's queue tells Afflatus's own prompts by it,
 * queueOutside ownPrompts), `overlap` (the join a job's row shows, queueView.ts joinOf, for the last finished jobs too), and,
 * small and kept all the same, `seed` (a running job's card, queueView.ts card) and `made` (queueTools madeBefore, for a job
 * run again in place, which a finished one never is). Nothing else reads a finished job's resume: the history leaves it out.
 */
const STILL_READ = ["promptId", "seed", "overlap", "made"] as const;

/** A resume this long or shorter holds no more than STILL_READ: left as it is. */
const SLIM_BYTES = 400;
/** How many jobs are read, and cut, at once: a page holds the event loop for some 40 ms on a first pass over a year of jobs. */
const PAGE = 200;

/** Where the last pass stopped, per database: the jobs that ended before it were cut then, or needed nothing. */
const slimmedTo = new WeakMap<Db, string>();

/**
 * The resume of each job finished more than RESUME_KEPT_MS ago cut down to what is still read of it: kept whole, it was
 * 115 to 140 MB a year at the owner's rate, read by nothing. The rows stay (no job is deleted: how long to keep them is the
 * owner's call). Each pass reads only the jobs finished since the one before (jobs_by_finish), a page at a time, giving the
 * event loop back between pages. Returns how many were cut.
 */
export async function slimFinished(db: Db, at = Date.now()): Promise<number> {
  const before = new Date(at - RESUME_KEPT_MS).toISOString();
  // the page after the last one read, by its end and its id: a page of jobs that all ended in the same millisecond moves on
  let after = { finished: slimmedTo.get(db) ?? "", id: "" };
  let n = 0;
  for (;;) {
    const page = await db.selectFrom("jobs").select(["id", "resume", "finished_at"])
      .where("finished_at", ">=", after.finished).where("finished_at", "<", before)
      .where((eb) => eb.or([eb("finished_at", ">", after.finished), eb("id", ">", after.id)]))
      .where("status", "in", ["done", "failed", "cancelled"])
      .where("resume", "is not", null).where(sql<number>`length(resume)`, ">", SLIM_BYTES)
      .orderBy("finished_at").orderBy("id").limit(PAGE).execute();
    const slimmed = page.flatMap((r) => {
      const whole = readJson<Record<string, unknown> | null>(r.resume, null);
      if (!whole || typeof whole !== "object") return [];
      const slim = JSON.stringify(Object.fromEntries(STILL_READ.filter((k) => whole[k] !== undefined).map((k) => [k, whole[k]])));
      return slim.length < r.resume!.length ? [{ id: r.id, was: r.resume!, slim }] : [];
    });
    // a page in one commit: one each was a sync of the disk per job, minutes on a first pass over a year of jobs
    if (slimmed.length) {
      await db.transaction().execute(async (tx) => {
        for (const s of slimmed) await tx.updateTable("jobs").set({ resume: s.slim }).where("id", "=", s.id).where("resume", "=", s.was).execute();
      });
    }
    n += slimmed.length;
    if (page.length < PAGE) break;
    after = { finished: page.at(-1)!.finished_at!, id: page.at(-1)!.id };
    await turn();
  }
  slimmedTo.set(db, before);
  return n;
}

/**
 * The library's word index (migration 0052) merged back into one segment: each change of an item adds a small one, and
 * the owner's had grown to 528 of them, 2.2 MB for 0.47 MB of words. Only SQLite has it. Done on an index already merged,
 * it costs 0.1 ms and writes nothing; after an hour of changes, some 35 ms.
 */
export async function optimizeSearch(db: Db): Promise<void> {
  if (!(db.getExecutor().adapter instanceof SqliteAdapter)) return;
  await sql`insert into asset_words_index (asset_words_index) values ('optimize')`.execute(db);
}

/** The database's own tidying, after each sweep (services.ts): old jobs' resumes, the word index, gone machines' notes. */
export async function tidyDb(db: Db, at = Date.now()): Promise<void> {
  await slimFinished(db, at);
  await optimizeSearch(db);
  await dropGoneMachines(db);
}
