import { randomUUID } from "node:crypto";
import type { Db } from "./db";

/**
 * The time a rented pod's ComfyUI ran work from outside Afflatus (its own page, another tool), kept by session (pod_outside,
 * 0077) for the Costs tab: billed, and not idle. Told each read of that machine's queue (queue.ts noteOutside, the poll of
 * an open page and rented.ts's own); only a prompt running counts, one waiting there holds no GPU. A machine with no open
 * rent session (this PC's own, a pod not billed) is not timed.
 *
 * Conservative where nothing is known: a stretch starts at the read that first found the work running, and one whose end
 * was not read soon after its last sight (its ComfyUI gone, no read for long, Afflatus restarted) ends at that last sight.
 */

/** A read that found the work over this soon after its last sight ends the stretch then; later, at the last sight. */
export const OUTSIDE_STALE_MS = 90_000;
/** How often an open stretch's last sight is written while it runs: what a restart of Afflatus closes it at. */
const SEEN_EVERY_MS = 15_000;

interface Open {
  id: string;
  /** The rent session it was opened under. */
  session: string;
  from: number;
  seen: number;
  kept: number;
}

export class PodOutside {
  private readonly open = new Map<string, Open>();
  /** The writes in order, the first one closing what a run before left open. */
  private work: Promise<void>;

  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {
    this.work = this.closeLeft().catch((err) => console.warn("[pod outside]", (err as Error).message));
  }

  /** The stretches a run before left open (Afflatus stopped or restarted): closed at their last sight, all that is known. */
  private async closeLeft(): Promise<void> {
    const left = await this.db.selectFrom("pod_outside").select(["id", "seen_at"]).where("ended_at", "is", null).execute();
    for (const r of left) await this.db.updateTable("pod_outside").set({ ended_at: r.seen_at }).where("id", "=", r.id).execute();
  }

  /** Whether a stretch of outside work is timed on this machine now: its queue is read at every pass of rented.ts then. */
  timing(machine: string): boolean {
    return this.open.has(machine);
  }

  /** A read of a machine's queue: its prompts not Afflatus's, running and waiting; null when it could not be read. */
  note(machine: string, outside: { running: number; pending: number } | null): void {
    const at = this.now();
    this.work = this.work.then(() => this.step(machine, outside, at)).catch((err) => console.warn("[pod outside]", (err as Error).message));
  }

  /** Every write told so far done (the tests, and the server's close). */
  settled(): Promise<void> {
    return this.work;
  }

  private async step(machine: string, outside: { running: number; pending: number } | null, at: number): Promise<void> {
    let o = this.open.get(machine);
    if (outside && outside.running > 0) {
      // a pod's open session only: a home machine, or a pod not billed now, has no time to split
      const session = await this.db.selectFrom("rent_sessions").select(["id", "started_at"]).where("machine_id", "=", machine).where("ended_at", "is", null).executeTakeFirst();
      // its session is no longer open (its pod stopped while the work ran, and its ComfyUI was not read again until a later
      // run): it ended at its last sight, as far as is known. Carried on, the next run's outside time would be counted under
      // the old session, and the new one's said idle
      if (o && o.session !== session?.id) {
        this.open.delete(machine);
        await this.db.updateTable("pod_outside").set({ seen_at: iso(o.seen), ended_at: iso(o.seen) }).where("id", "=", o.id).execute();
        o = undefined;
      }
      if (o) {
        o.seen = Math.max(o.seen, at);
        if (o.seen - o.kept < SEEN_EVERY_MS) return;
        o.kept = o.seen;
        await this.db.updateTable("pod_outside").set({ seen_at: iso(o.seen) }).where("id", "=", o.id).execute();
        return;
      }
      if (!session) return;
      const from = Math.max(at, Date.parse(session.started_at));
      const id = randomUUID();
      await this.db.insertInto("pod_outside").values({ id, session_id: session.id, machine_id: machine, started_at: iso(from), seen_at: iso(from), ended_at: null }).execute();
      this.open.set(machine, { id, session: session.id, from, seen: from, kept: from });
      return;
    }
    if (!o) return;
    this.open.delete(machine);
    // read over soon after its last sight: it ran until about then. Its ComfyUI not read (null), or read only long after: it
    // ran until its last sight, as far as is known
    const end = Math.max(o.from, outside && at - o.seen <= OUTSIDE_STALE_MS ? at : o.seen);
    await this.db.updateTable("pod_outside").set({ seen_at: iso(Math.max(o.seen, end)), ended_at: iso(end) }).where("id", "=", o.id).execute();
  }
}

/**
 * A stretch of a pod installing node packs for its jobs, up to its ComfyUI's restart to load them (podPacks.ts packsTime),
 * kept under its open session for Costs (pod_packs, 0089): billed, and no job could start there meanwhile. A machine with no
 * open rent session (this PC's own, a pod not billed) is not timed.
 */
export async function keepPacksTime(db: Db, machine: string, from: number, to: number): Promise<void> {
  const session = await db.selectFrom("rent_sessions").select(["id", "started_at"]).where("machine_id", "=", machine).where("ended_at", "is", null).executeTakeFirst();
  if (!session) return;
  const start = Math.max(from, Date.parse(session.started_at));
  if (!(to > start)) return;
  await db.insertInto("pod_packs").values({ id: randomUUID(), session_id: session.id, machine_id: machine, started_at: iso(start), ended_at: iso(to) }).execute();
}

const iso = (ms: number) => new Date(ms).toISOString();
