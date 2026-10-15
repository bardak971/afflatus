import { now, type Db } from "./db";
import { readJson, type QueueCore, type Resume } from "./queueModel";

/** Many jobs in one request: finished ones taken off the list or queued again, waiting ones cancelled (the Queue screen's bulk actions). */

/** Whether one of these jobs is a clip's render, a cut or an export: only those change a timeline (a dependent failed with them says so itself, through finish). */
export async function ofTimeline(db: Db, ids: readonly string[]): Promise<boolean> {
  if (!ids.length) return false;
  const one = await db.selectFrom("jobs").select("id").where("id", "in", [...ids]).where((eb) => eb.or([eb("clip_id", "is not", null), eb("timeline_id", "is not", null)])).executeTakeFirst();
  return Boolean(one);
}

/** Take several finished jobs off the list in one go (one event for all); how many went. Jobs not finished stay. */
export async function dismissAll(core: QueueCore, ids: readonly string[]): Promise<number> {
  if (!ids.length) return 0;
  const finished = core.db.selectFrom("jobs").where("id", "in", [...ids]).where("status", "in", ["done", "failed", "cancelled"]);
  // a clip's job, a cut or an export is seen on its timeline too
  const timeline = await finished.select("id").where((eb) => eb.or([eb("clip_id", "is not", null), eb("timeline_id", "is not", null)])).executeTakeFirst();
  const r = await core.db.deleteFrom("jobs").where("id", "in", [...ids]).where("status", "in", ["done", "failed", "cancelled"]).executeTakeFirst();
  core.events.emit("queue");
  if (timeline) core.events.emit("timeline");
  return Number(r.numDeletedRows);
}

/**
 * Several finished jobs again, in the order given (a "Retry all failed"): one request, each queued as `again` (the
 * queue's) does it. With `dismiss`, the ones queued again leave the history in the same go. A job not finished is left
 * alone; one that cannot be queued again (its workflow was deleted) is counted, not thrown.
 */
export async function againAll(core: QueueCore, again: (id: string) => Promise<string>, ids: readonly string[], opts: { dismiss?: boolean } = {}): Promise<{ ids: string[]; failed: number }> {
  if (!ids.length) return { ids: [], failed: 0 };
  const finished = new Set((await core.db.selectFrom("jobs").select("id").where("id", "in", [...ids]).where("status", "in", ["done", "failed", "cancelled"]).execute()).map((r) => r.id));
  const queued: string[] = [];
  const retried: string[] = [];
  let failed = 0;
  for (const id of ids) {
    if (!finished.has(id)) continue;
    try {
      queued.push(await again(id));
      retried.push(id);
    } catch {
      failed++;
    }
  }
  if (opts.dismiss && retried.length) await dismissAll(core, retried);
  return { ids: queued, failed };
}

/**
 * Every waiting job cancelled in one statement (or, with `ids`, those of them that still wait: what the page showed
 * when it was asked); how many were. What continues from one of them fails (`failDependents`, the queue's), as with a
 * single cancel, and a prompt one of them still had on a ComfyUI (queued again after it was lost from sight) is stopped
 * there (`interrupt`). The running job goes on.
 */
export async function cancelWaiting(core: QueueCore, failDependents: (id: string) => Promise<void>, interrupt: (machine: string | null, promptId: string) => void, ids?: readonly string[]): Promise<number> {
  // the ones cancelled are the ones this statement changed: a job a pass started between a read and the write runs on, and
  // what continues from it is not failed
  let cancel = core.db.updateTable("jobs").set({ status: "cancelled", error: "stopped by you", finished_at: now(), updated_at: now() }).where("status", "=", "queued");
  if (ids) cancel = cancel.where("id", "in", ids.length ? [...ids] : [""]);
  const cancelled = await cancel.returning(["id", "resume", "machine_id"]).execute();
  if (!cancelled.length) return 0;
  for (const r of cancelled) {
    const sent = readJson<Partial<Resume>>(r.resume, {}).promptId;
    if (sent) interrupt(r.machine_id ?? null, sent);
  }
  // one left out of `ids` may continue one cancelled now: it can never run
  for (const r of cancelled) await failDependents(r.id);
  core.events.emit("queue");
  if (await ofTimeline(core.db, cancelled.map((r) => r.id))) core.events.emit("timeline");
  return cancelled.length;
}
