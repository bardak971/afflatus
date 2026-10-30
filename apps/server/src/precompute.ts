import { type Media } from "./cut";
import { lookOf, takeMeasures, type Measure } from "./measure";
import { runUpBreak, runUpCut } from "./joinScore";
import type { Db } from "./db";
import { ffmpegPool } from "./pool";
import { keptKey, keptMotion, type TimelineMedia } from "./timelineMedia";

/**
 * What the timeline editor measures of its clips, worked out in the background before it is asked for: a take's motion
 * and loudness, its film strip and its colour along it once it is stored on a timeline, and the joins of the clips
 * around it once it plays there. A timeline opened for the first time then reads them off the disk instead of waiting
 * for ffmpeg (a 40-clip timeline waited ~13 s for its motion and up to a minute and a half for its joins).
 *
 * The work runs one unit at a time through the ffmpeg pool's last lane: what a screen asks for goes first and always
 * finds a place. Nothing runs while a render's result is being filed. Every unit only fills the caches the routes fill
 * themselves, so the queue is kept in memory only: a restart forgets it, and the editor measures what is missing on
 * demand as before. A video measured once is not measured again in this process.
 */

/** The pool's door, as the background uses it (the server's ffmpeg pool; a test hands its own). */
type Run = <T>(work: () => Promise<T>, opts: { last?: boolean }) => Promise<T>;

export interface PrecomputeOptions {
  /** How long a timeline's edits settle before its clips are read: a burst of edits makes one pass. */
  settleMs?: number;
  /** After start, when the timelines that lack what the editor reads are measured (slowly); null: never. */
  backfillAfterMs?: number | null;
  /** Backfill's pace: at most this many units a minute, and a rest after each at least as long as the unit took. */
  perMinute?: number;
  run?: Run;
}

interface Unit {
  work: () => Promise<void>;
  /** Backfill: rested after, so that it never takes more than about half a core. */
  slow: boolean;
}

/** The background measure of each database's server (one per createServices): what the hooks in the stores reach. */
const of = new WeakMap<object, Precompute>();

/** The background measure that works for this database, if one does (none in most tests). */
export const precomputeOf = (db: Db): Precompute | undefined => of.get(db);

export class Precompute {
  /** Waiting units by what they make, in order: what was just stored, then the backfill. */
  private readonly soon = new Map<string, Unit>();
  private readonly later = new Map<string, Unit>();
  /** The videos measured in this process (or found measured): not looked at again. */
  private readonly done = new Set<string>();
  private readonly settling = new Map<string, NodeJS.Timeout>();
  /** The backfill's start and its rests, each with what it does when it is due (done at once on stop). */
  private readonly timers = new Map<NodeJS.Timeout, () => void>();
  private holds = 0;
  private released: Array<() => void> = [];
  private working: Promise<void> | null = null;
  private stopped = false;
  private readonly opts: { settleMs: number; backfillAfterMs: number | null; perMinute: number; run: Run };

  constructor(
    private readonly db: Db,
    private readonly media: Pick<TimelineMedia, "motion" | "strip" | "means" | "joins" | "missing" | "measureTogether"> & Partial<Pick<TimelineMedia, "runUpCut">>,
    opts: PrecomputeOptions = {},
  ) {
    this.opts = { settleMs: opts.settleMs ?? 3_000, backfillAfterMs: opts.backfillAfterMs === undefined ? 60_000 : opts.backfillAfterMs, perMinute: opts.perMinute ?? 30, run: opts.run ?? ffmpegPool };
    of.set(db, this);
    if (this.opts.backfillAfterMs !== null) this.after(this.opts.backfillAfterMs, () => void this.backfill().catch(() => {}));
  }

  /** A video (or a sound) is stored where the editor will read it: its motion, film strip and colour, once. */
  video(assetId: string, slow = false): void {
    if (this.done.has(assetId)) return;
    this.add(`video:${assetId}`, { slow, work: () => this.measureVideo(assetId, slow) });
  }

  /** Something was placed on a timeline, or its clips changed: once the edits settle, what its editor reads is measured. */
  timeline(timelineId: string): void {
    if (this.stopped) return;
    clearTimeout(this.settling.get(timelineId));
    const timer = setTimeout(() => {
      this.settling.delete(timelineId);
      this.add(`timeline:${timelineId}`, { slow: false, work: () => this.readTimeline(timelineId, false) });
    }, this.opts.settleMs);
    timer.unref();
    this.settling.set(timelineId, timer);
  }

  /** While what is answered is held (a render's result being filed), no unit starts. Call what is answered when done. */
  hold(): () => void {
    this.holds++;
    let once = false;
    return () => {
      if (once) return;
      once = true;
      if (--this.holds === 0) for (const go of this.released.splice(0)) go();
    };
  }

  /** Every timeline, newest first, at the backfill's pace: what each lacks is measured, what it has is passed over. */
  async backfill(): Promise<void> {
    if (this.stopped) return;
    const timelines = await this.db.selectFrom("timelines").select("id").orderBy("updated_at", "desc").execute();
    for (const t of timelines) this.add(`timeline:${t.id}`, { slow: true, work: () => this.readTimeline(t.id, true) });
    // the takes that carry on, measured before a cut after their run-up was looked for (card #161): each one looked at
    const media = this.media;
    if (!media.runUpCut) return;
    const runUps = await this.db
      .selectFrom("takes")
      .innerJoin("assets", "assets.id", "takes.asset_id")
      .innerJoin("generations", "generations.id", "assets.generation_id")
      .select("takes.asset_id as asset")
      .where("takes.head_ms", ">", 0)
      .where("generations.measure", "is not", null)
      .where("generations.measure", "not like", '%"runUpCut"%')
      .orderBy("takes.created_at", "desc")
      .execute();
    for (const r of runUps) this.add(`runup:${r.asset}`, { slow: true, work: () => this.opts.run(() => media.runUpCut!(r.asset).then(() => {}), { last: true }).catch(() => {}) });
  }

  /** How many units wait (for tests and the log). */
  get waiting(): number {
    return this.soon.size + this.later.size;
  }

  /** Resolves once nothing waits and nothing runs (for tests). */
  async settled(): Promise<void> {
    while (this.working || this.settling.size) await (this.working ?? new Promise((r) => setTimeout(r, 10)));
  }

  /** No more units: the one under way finishes; what waits is forgotten (the editor measures it on demand). */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.settling.values()) clearTimeout(t);
    this.settling.clear();
    const due = [...this.timers];
    this.timers.clear();
    for (const [t, work] of due) {
      clearTimeout(t);
      work();
    }
    this.soon.clear();
    this.later.clear();
    for (const go of this.released.splice(0)) go();
    await this.working;
    if (of.get(this.db) === this) of.delete(this.db);
  }

  // ---------------------------------------------------------------- the units

  private async measureVideo(assetId: string, slow: boolean): Promise<void> {
    const asset = await this.db.selectFrom("assets").selectAll().where("id", "=", assetId).executeTakeFirst();
    this.done.add(assetId);
    if (!asset || (asset.kind !== "video" && asset.kind !== "audio")) return;
    const missing = await this.media.missing(asset);
    // two or more of a video's: one decode for all of them, in one place in the pool
    if (asset.kind === "video" && missing.length > 1) {
      await this.ready();
      if (this.stopped) return;
      const started = Date.now();
      const done = await this.opts.run(() => this.media.measureTogether(asset, missing), { last: true }).catch(() => false);
      if (slow) await this.rest(Date.now() - started);
      if (done) return;
    }
    // else each its own place in the pool: what a screen asks for meanwhile goes between them
    for (const what of missing) {
      await this.ready();
      if (this.stopped) return;
      const started = Date.now();
      await this.opts
        .run<unknown>(() => (what === "motion" ? this.media.motion(asset.id) : what === "strip" ? this.media.strip(asset.id) : this.media.means(asset)), { last: true })
        .catch(() => {});
      if (slow) await this.rest(Date.now() - started);
    }
  }

  /** What a timeline's editor asks for as it opens: the playing takes' videos, the clips' sound files and the music, then the joins of the clips that flow on. */
  private async readTimeline(timelineId: string, slow: boolean): Promise<void> {
    const t = await this.db.selectFrom("timelines").select("music_asset_id").where("id", "=", timelineId).executeTakeFirst();
    if (!t) return;
    const clips = await this.db
      .selectFrom("clips")
      .leftJoin("takes", "takes.id", "clips.take_id")
      .select(["clips.id as id", "clips.kind as kind", "clips.joined as joined", "clips.sound as sound", "clips.sound_asset_id as sound_asset_id", "takes.asset_id as asset_id"])
      .where("clips.timeline_id", "=", timelineId)
      .orderBy("clips.position")
      .execute();
    for (const c of clips) {
      if (c.kind === "video" && c.asset_id) this.video(c.asset_id, slow);
      if (c.sound === "file" && c.sound_asset_id) this.video(c.sound_asset_id, slow);
    }
    if (t.music_asset_id) this.video(t.music_asset_id, slow);
    // a flowing clip's joins, as the editor's Needs attention asks for them: kept on the disk, so a pass over a timeline
    // measured already only reads them back
    clips.forEach((c, i) => {
      if (i > 0 && c.kind === "video" && c.joined === "continue" && c.asset_id) {
        this.add(`joins:${c.id}`, { slow, work: () => this.opts.run(() => this.media.joins(c.id, 1).then(() => {}), { last: true }).catch(() => {}) });
      }
    });
  }

  // ---------------------------------------------------------------- the worker

  private add(key: string, unit: Unit): void {
    if (this.stopped) return;
    // asked for soon after being asked for slowly: it moves up
    if (!unit.slow) this.later.delete(key);
    else if (this.soon.has(key)) return;
    const lane = unit.slow ? this.later : this.soon;
    if (!lane.has(key)) lane.set(key, unit);
    this.kick();
  }

  private kick(): void {
    if (this.working || this.stopped || !this.waiting) return;
    this.working = this.loop().finally(() => {
      this.working = null;
      this.kick();
    });
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      await this.ready();
      const lane = this.soon.size ? this.soon : this.later;
      const next = lane.entries().next().value;
      if (!next) return;
      const [key, unit] = next;
      lane.delete(key);
      const started = Date.now();
      // what fails is left to the editor, which measures it on demand and says so
      await unit.work().catch(() => {});
      // a video unit rests between its own parts
      if (unit.slow && !key.startsWith("video:")) await this.rest(Date.now() - started);
    }
  }

  /** Waits while a result is being filed. */
  private async ready(): Promise<void> {
    while (this.holds > 0 && !this.stopped) await new Promise<void>((go) => this.released.push(go));
  }

  /**
   * The backfill's pause after a unit: as long as it took, and never more than `perMinute` units a minute. A unit that
   * only read what was kept (a few milliseconds) is not rested after: a timeline measured already is passed over at once.
   */
  private rest(tookMs: number): Promise<void> {
    if (this.stopped || tookMs < 50) return Promise.resolve();
    return new Promise((go) => this.after(Math.max(tookMs, 60_000 / this.opts.perMinute - tookMs), go));
  }

  private after(ms: number, work: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      work();
    }, ms);
    timer.unref();
    this.timers.set(timer, work);
  }
}

/**
 * A take's measures as it lands, from one decode of it (takeMeasures): its look, kept with the render (and, for a
 * continuation, the step where its run-up ends, runUpBreak), and what the timeline editor reads of it, put where the
 * editor and the background find them done (its motion, its film strip, its frame means). Eight decodes before, three of
 * them made again by the background once the take was placed. `put` stores a file (the caller's: a failed landing removes
 * what it put). When the one run fails, the look is measured a pass at a time as before and the rest left to the
 * background. `fromMs`: where the take's own part starts (a continuation's run-up before it).
 */
export async function measureLanded(
  put: (key: string, bytes: Uint8Array) => Promise<void>, assetId: string, source: Media, ext: string,
  facts: { durationMs: number; hasSound: boolean }, fromMs = 0,
): Promise<Measure | null> {
  const all = await takeMeasures(source, ext, { fromMs, durationMs: facts.durationMs, hasSound: facts.hasSound }).catch(() => null);
  let look = all ? all.look : await lookOf(source, ext, fromMs).catch(() => null);
  if (all) {
    const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
    await put(keptKey.motion(assetId), json(keptMotion(all.motion)));
    if (all.strip) await put(keptKey.strip(assetId), all.strip);
    if (all.means.t.length) await put(keptKey.means(assetId), json(all.means));
  }
  // a continuation: the step where its run-up ends and its own frames begin, kept with the look. The join figures look at
  // the take-over point, which sits inside the run-up and copies the clip before whatever happens next; a model that steps
  // away from its guide cuts here, and only this figure says so
  if (look && fromMs > 0) {
    look = { ...look, handover: (await runUpBreak(source, ext, fromMs).catch(() => null)) ?? undefined };
    // and a hard cut a few frames on, which the step at the join alone does not see (card #161)
    const cut = await runUpCut(source, ext, fromMs).catch(() => undefined);
    if (cut !== undefined) look = { ...look, runUpCut: cut };
  }
  return look;
}
