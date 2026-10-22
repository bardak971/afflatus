import { setImmediate as turn } from "node:timers/promises";
import { SqliteAdapter, sql, type ExpressionBuilder } from "kysely";
import type { Db, Tables } from "./db";
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

const DAY_MS = 24 * 60 * 60_000;
/**
 * How many old jobs are read at once when finished jobs are deleted, and how many are deleted per statement: a delete is
 * slow per row (its pages and indexes rewritten, up to 100 ms for 100 rows on a year of jobs), a read of the kept ones is
 * not, and the kept ones are read again every hour (1.9 s an hour in pages of 50 on a year of jobs, against 0.3 s).
 */
const PRUNE_PAGE = 500;
const PRUNE_DELETE = 50;

/**
 * A finished job nothing still reads by it: no render row is named after it (render_stats.id, which Costs and the Render
 * times read, a job's draft, timeline and project with it), no job waits on it (depends_on), nothing it made is still in
 * the library (autoName takes its label, a take's check asks whether it was a clip's render), it is on no clip
 * still there (the clip's last status and its finish's key are read from its jobs), no timeline still there exports from
 * it, and it finished no take still there. A job a removed clip, timeline or asset named has nothing left to show it by.
 */
function unnamed(eb: ExpressionBuilder<Tables, "jobs">) {
  return eb.and([
    eb.not(eb.exists(eb.selectFrom("render_stats").select("render_stats.id").whereRef("render_stats.id", "=", "jobs.id"))),
    eb.not(eb.exists(eb.selectFrom("jobs as later").select("later.id").whereRef("later.depends_on", "=", "jobs.id"))),
    eb.or([eb("jobs.generation_id", "is", null), eb.not(eb.exists(eb.selectFrom("assets").select("assets.id").whereRef("assets.generation_id", "=", "jobs.generation_id")))]),
    eb.or([eb("jobs.clip_id", "is", null), eb.not(eb.exists(eb.selectFrom("clips").select("clips.id").whereRef("clips.id", "=", "jobs.clip_id")))]),
    eb.or([eb("jobs.timeline_id", "is", null), eb.not(eb.exists(eb.selectFrom("timelines").select("timelines.id").whereRef("timelines.id", "=", "jobs.timeline_id")))]),
    eb.or([eb("jobs.finished_from", "is", null), eb.not(eb.exists(eb.selectFrom("takes").select("takes.id").whereRef("takes.id", "=", "jobs.finished_from")))]),
  ]);
}

/**
 * The finished jobs (done, failed or cancelled) that ended more than `days` ago and that nothing still names (`unnamed`),
 * deleted: only Dismiss deleted jobs before, and a warm job, hidden from the history, could never be dismissed, so the
 * table only grew (some 100 jobs a day at the owner's rate). The prompt history is the generations, which stay. 0 keeps
 * every job. Kept whatever their age, beside what `unnamed` keeps:
 * - a failed or stopped render with no render row, while the Render times still count it (rendersRead.ts notRendered,
 *   over `renderDays`, 0 for good): the Queue and the charts then count the same failures;
 * - a job that ended while a rented pod still runs: the pod's last work (rentedFollow busySince) and the batch's cost
 *   (notify.ts, from the job before it) are read from those jobs' ends.
 * The old jobs are gone through a page at a time by their end (jobs_by_finish): those of a page that may go are read,
 * then deleted a few at a time by statements that check every rule again, giving the event loop back between them.
 * Returns how many were deleted.
 */
export async function pruneJobs(db: Db, days: number, renderDays: number, at = Date.now()): Promise<number> {
  if (!(days > 0)) return 0;
  let before = new Date(at - days * DAY_MS).toISOString();
  const open = await db.selectFrom("rent_sessions").select((eb) => eb.fn.min("started_at").as("from")).where("ended_at", "is", null).executeTakeFirst();
  if (open?.from && open.from < before) before = open.from;
  // the day the Render times count failures from, a whole day earlier to be safe of its rounding to midnight; null: from always
  const countedFrom = renderDays > 0 ? new Date(at - (renderDays + 1) * DAY_MS).toISOString() : null;
  // the same rules for the read and for the delete: a job named in between (queued after, its item restored) stays
  const mayGo = (eb: ExpressionBuilder<Tables, "jobs">) => eb.and([
    eb("status", "in", ["done", "failed", "cancelled"]),
    eb("finished_at", "<", before),
    countedFrom === null ? eb.or([eb("status", "=", "done"), eb("warm", "=", 1)]) : eb.or([eb("status", "=", "done"), eb("warm", "=", 1), eb("finished_at", "<", countedFrom)]),
    unnamed(eb),
  ]);
  let after = { finished: "", id: "" };
  let n = 0;
  for (;;) {
    const page = await db.selectFrom("jobs").select(["id", "finished_at"])
      .where("finished_at", ">=", after.finished).where("finished_at", "<", before)
      .where((eb) => eb.or([eb("finished_at", ">", after.finished), eb("id", ">", after.id)]))
      .orderBy("finished_at").orderBy("id").limit(PRUNE_PAGE).execute();
    if (!page.length) break;
    const ids = (await db.selectFrom("jobs").select("id").where("id", "in", page.map((r) => r.id)).where(mayGo).execute()).map((r) => r.id);
    for (let i = 0; i < ids.length; i += PRUNE_DELETE) {
      if (i) await turn();
      const gone = await db.deleteFrom("jobs").where("id", "in", ids.slice(i, i + PRUNE_DELETE)).where(mayGo).executeTakeFirst();
      n += Number(gone.numDeletedRows);
    }
    if (page.length < PRUNE_PAGE) break;
    after = { finished: page.at(-1)!.finished_at!, id: page.at(-1)!.id };
    await turn();
  }
  return n;
}

/** How long finished jobs are kept (Settings › Storage): `jobHistoryDays`, and the Render times' own days, which keep their failures. */
export interface TidyKeep { jobDays: number; renderDays: number }

/**
 * The database's own tidying, after each sweep (services.ts): old finished jobs nothing names, old jobs' resumes, the word
 * index, gone machines' notes. Returns how many jobs were deleted (the Queue's history is told).
 */
export async function tidyDb(db: Db, keep: TidyKeep, at = Date.now()): Promise<number> {
  // deleted first: a job deleted is one less resume to cut
  const pruned = await pruneJobs(db, keep.jobDays, keep.renderDays, at);
  await slimFinished(db, at);
  await optimizeSearch(db);
  await dropGoneMachines(db);
  return pruned;
}
