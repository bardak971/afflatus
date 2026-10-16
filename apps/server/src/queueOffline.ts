import type { EventEmitter } from "node:events";
import { usesGpu } from "./queueTools";
import { CUT_JOB, EXPORT_JOB } from "./timelineModel";
import type { JobRow, QueueOptions, Running } from "./queueModel";

/** ComfyUI away and back: since when it has not answered, and what becomes of the jobs that wait for it meanwhile. */

/** Whether a job needs ComfyUI: a render, a finish and a RIFE slow-motion do; an export and a cut by ffmpeg do not. */
export const needsComfy = (r: JobRow) => r.recipe_id !== EXPORT_JOB && (r.recipe_id !== CUT_JOB || usesGpu(r));

/** What the queue lends the watch on ComfyUI: its events and options, the running job, and the few steps it takes. */
export interface OfflineQueue {
  events: EventEmitter;
  opts: QueueOptions;
  running(): Running | null;
  /** What ComfyUI had loaded is not known any more (started again, it holds nothing). */
  forget(): Promise<void>;
  /** The line read again. */
  pump(): void;
  /** The line read again after a while (the options' offlineRetryMs). */
  retryLater(): void;
  /** A job given up on, when it is still in the state it was read in. */
  fail(r: JobRow, error: string): Promise<void>;
  /** Whether a job waits for a machine paused by hand or by a GPU hunt (pinned there, or held for it): for its Resume, not for ComfyUI. */
  pausedFor(r: JobRow): boolean;
}

export class Offline {
  /** Since when ComfyUI has not answered; null while it does. */
  since: number | null = null;
  /** The page's status polls in a row that found no answer (noteReachable). */
  private unanswered = 0;

  constructor(private readonly q: OfflineQueue) {}

  /**
   * What the page's status poll (events.ts) found of ComfyUI. The line asks ComfyUI only when a job needs it, so an idle
   * queue kept saying it was online, with the model it had last loaded, while ComfyUI was off. Twice without an answer
   * is away (one slow answer is not), never while a job runs (its own connection says); back, the line is read again.
   */
  noteReachable(ok: boolean): void {
    if (ok) {
      this.unanswered = 0;
      if (this.since === null) return;
      this.since = null;
      this.q.events.emit("queue");
      this.q.pump();
      return;
    }
    if (this.q.running() || ++this.unanswered < 2 || this.since !== null) return;
    this.went();
  }

  /** ComfyUI answered the worker's own pass: when it was away, it is back. */
  answered(): void {
    if (this.since === null) return;
    this.since = null;
    this.unanswered = 0;
    this.q.events.emit("queue");
  }

  /** ComfyUI stopped answering: since when, and what it had loaded is not known any more (started again, it holds nothing). */
  private went(): void {
    this.since = Date.now();
    void this.q.forget().finally(() => this.q.events.emit("queue"));
  }

  /** ComfyUI is away: the jobs that need it wait, and are given up once it has been away too long (a job it had before a restart too). */
  async whileOffline(active: JobRow[]): Promise<void> {
    if (this.since === null) this.went();
    const since = this.since!;
    for (const r of active) {
      // how long each job has waited for it: one queued after ComfyUI had long been away gets its full wait
      if (Date.now() - Math.max(since, Date.parse(r.created_at) || 0) > this.q.opts.offlineExpiryMs) {
        if (!needsComfy(r) || this.q.running()?.id === r.id || this.q.pausedFor(r)) continue;
        await this.q.fail(r, "ComfyUI stayed offline. Try again when it is back.");
      }
    }
    this.q.retryLater();
  }
}
