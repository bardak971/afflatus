import type { EventEmitter } from "node:events";
import { toRun, type Db } from "./db";
import { readJson, type Lane } from "./queueModel";

/**
 * Work from outside Afflatus on a machine's ComfyUI (queue.ts): prompts queued from its own page or another tool, read from
 * its queue less the prompts that are Afflatus's own. A machine with any takes no new job, and a rented pod's time at that
 * work is told (onOutside).
 */

/**
 * How often an open page's poll reads a machine's ComfyUI queue (lookOutside) while its socket says it has prompts: each
 * entry carries its whole graph. A change its socket hears is read at once.
 */
const OUTSIDE_EVERY_MS = 10_000;
/** How long after its job ended a prompt is still known as Afflatus's: one stopped leaves ComfyUI's queue a moment after. */
const OWN_KEPT_MS = 2 * 60_000;

/** Whether a machine's ComfyUI has work from outside Afflatus (its own page, another tool), running or waiting, as last read. */
export function outsideBusy(lane: Lane | undefined): boolean {
  const o = lane?.outside;
  return Boolean(o && o.running + o.pending > 0);
}

/** What reading the outside work takes of the queue. */
interface OutsideDeps {
  db: Db;
  events: EventEmitter;
  machineLanes(): Lane[];
  /** The prompts a machine may still render for jobs gone elsewhere (queue.ts `stale`): Afflatus's own all the same. */
  stale(machine: string): ReadonlySet<string> | undefined;
  /** The prompts failed as stuck there that may still run in it (queue.ts stuckOn): Afflatus's own too. */
  stuck(machine: string): Iterable<string> | undefined;
  stopped(): boolean;
  onOutside(machine: string, outside: Lane["outside"]): void;
  pump(): void;
}

export class Outside {
  constructor(private readonly d: OutsideDeps) {}

  /**
   * Every machine's work from outside Afflatus, looked at by an open page's poll (events.ts): read when its socket says its
   * ComfyUI has prompts (or cannot say), at most every OUTSIDE_EVERY_MS; none when it says it has none. A status message
   * missed is caught here.
   */
  async lookOutside(): Promise<void> {
    await Promise.all(this.d.machineLanes().map(async (l) => {
      if (l.reachable === false) return;
      if (l.comfy?.monitor?.queueRemaining === 0) return this.noteOutside(l, { running: 0, pending: 0 });
      if (Date.now() - l.outsideAt >= OUTSIDE_EVERY_MS) await this.readOutside(l);
    }));
  }

  /** Before a free machine is given a job: its work from outside Afflatus, read unless its socket says its ComfyUI has none. */
  async freshOutside(lane: Lane): Promise<void> {
    // opened, its socket says each change from then on, and the next pass needs no read
    lane.comfy?.monitor?.ensure();
    if (lane.comfy?.monitor?.queueRemaining === 0) this.noteOutside(lane, { running: 0, pending: 0 });
    else await this.readOutside(lane);
  }

  /**
   * The prompts that are Afflatus's own on a machine: the jobs running (their prompt id is saved before it is sent, and kept
   * across a restart of Afflatus, whose client id is then another), the jobs queued again with the prompt their machine may
   * still have (sent without an answer, lost from sight, a finish stopped by a restart: the next attempt asks for it and
   * follows it), the ones that ended a moment ago (a stopped prompt leaves ComfyUI's queue just after), the prompts dropped
   * there for a job gone elsewhere, the ones failed as stuck that may still run there, and what this client sent. Taken for
   * work from outside Afflatus, such a prompt held its own machine as busy: the job waiting to follow it was never started
   * there, and the pod's idle time counted it as used.
   */
  async ownPrompts(lane: Lane): Promise<(promptId: string) => boolean> {
    const ids = new Set<string>([...(this.d.stale(lane.id) ?? []), ...(this.d.stuck(lane.id) ?? [])]);
    if (lane.running?.promptId) ids.add(lane.running.promptId);
    const since = new Date(Date.now() - OWN_KEPT_MS).toISOString();
    // asked as two reads, each through its own index (jobs_to_run, jobs_by_finish): asked as one, with an `or`, SQLite read
    // the whole jobs table at every ComfyUI queue event
    const kept = this.d.db.selectFrom("jobs").select("resume").where("resume", "is not", null);
    const rows = [...await kept.where(toRun).execute(), ...await kept.where("finished_at", ">=", since).execute()];
    for (const r of rows) {
      const id = readJson<{ promptId?: unknown }>(r.resume, {}).promptId;
      if (typeof id === "string") ids.add(id);
    }
    const client = lane.comfy?.client;
    return (promptId) => ids.has(promptId) || client?.classesOf?.(promptId) !== undefined;
  }

  /** A machine's ComfyUI queue read for work from outside Afflatus; one read at a time, and one more after it when asked meanwhile. */
  readOutside(lane: Lane): Promise<void> {
    if (lane.outsideRead) {
      lane.outsideAgain = true;
      return lane.outsideRead;
    }
    lane.outsideRead = (async () => {
      do {
        lane.outsideAgain = false;
        lane.outsideAt = Date.now();
        const comfy = lane.comfy;
        // stopped (shutting down): its database may be closed already, and what it would find is not shown anywhere
        if (!comfy?.client.queue || this.d.stopped()) return;
        const q = await comfy.client.queue().catch(() => null);
        if (!q) {
          // not known while its ComfyUI does not answer: it reads as away, not as busy
          this.noteOutside(lane, null);
          continue;
        }
        // a read that fails (the database closing) leaves what was known: it is read again at the next change
        const own = this.d.stopped() ? null : await this.ownPrompts(lane).catch(() => null);
        if (!own) return;
        this.noteOutside(lane, { running: q.running.filter((e) => !own(e.promptId)).length, pending: q.pending.filter((e) => !own(e.promptId)).length });
      } while (lane.outsideAgain);
    })().finally(() => {
      lane.outsideRead = null;
    });
    return lane.outsideRead;
  }

  /** A machine's work from outside Afflatus as just found: the screens told when it changed, and the line read again once it is done. */
  noteOutside(lane: Lane, next: Lane["outside"]): void {
    // a render of Afflatus's waiting in ComfyUI behind it moves by nothing meanwhile: its silence counts from when it is done
    if (next?.running && lane.running) lane.running.movedAt = Date.now();
    this.d.onOutside(lane.id, next);
    const was = lane.outside;
    lane.outside = next;
    if (was?.running === next?.running && was?.pending === next?.pending) return;
    this.d.events.emit("queue");
    if (was && was.running + was.pending > 0 && !outsideBusy(lane)) this.d.pump();
  }
}
