import { newId, now, type Db } from "./db";
import { httpError } from "./errors";
import type { ClipRow, TakeRow, TimelineRow } from "./timelineModel";

/**
 * Undo and Redo of a timeline: a state kept before each change (the history) and before each undo (the future), as
 * snapshots of its row, its clips and their takes. What was rendered since a state is not lost by going back to it.
 */

/** How many changes Undo can go back. */
const HISTORY = 40;

/** A state of a timeline as Undo keeps it; `added`: the takes the change itself added (a finished or slowed take), which Undo takes back. */
export interface Kept {
  timeline: TimelineRow;
  clips: ClipRow[];
  takes: TakeRow[];
  added?: string[];
}

/** The columns a take has now (every one, or this does not compile): a snapshot kept before a column went (lead_ms, 0042) still carries it. */
const TAKE_COLUMNS: Record<keyof TakeRow, true> = {
  id: true, clip_id: true, asset_id: true, head_ms: true, tail_ms: true, trim_start_ms: true, trim_end_ms: true,
  prev_take_id: true, prev_at_ms: true, next_take_id: true, next_at_ms: true, finished_from: true, join_kind: true, created_at: true,
};
const takeColumns = (t: TakeRow): TakeRow => Object.fromEntries(Object.entries(t).filter(([k]) => k in TAKE_COLUMNS)) as TakeRow;

export class TimelineHistory {
  constructor(
    private readonly db: Db,
    private readonly row: (id: string) => Promise<TimelineRow>,
    private readonly changed: () => void,
  ) {}

  /** What runs one at a time, by key: the work waiting last for each. */
  private readonly turns = new Map<string, Promise<unknown>>();

  /**
   * Work done one at a time per key, in the order asked: Undo, Redo and the steps they keep, per timeline (two undos at once
   * restored the same step; two steps kept at once could share a number), and a timeline's export check and queueing.
   */
  oneAtATime<T>(key: string, work: () => Promise<T>): Promise<T> {
    const mine = (this.turns.get(key) ?? Promise.resolve()).then(work);
    const settled = mine.then(() => {}, () => {});
    this.turns.set(key, settled);
    void settled.then(() => {
      if (this.turns.get(key) === settled) this.turns.delete(key);
    });
    return mine;
  }


  /** What the timeline looks like now, as one piece: the row, its clips, their takes. */
  private async stateOf(timelineId: string): Promise<Kept> {
    const timeline = await this.row(timelineId);
    const clips = await this.db.selectFrom("clips").selectAll().where("timeline_id", "=", timelineId).execute();
    const takes = clips.length ? await this.db.selectFrom("takes").selectAll().where("clip_id", "in", clips.map((c) => c.id)).execute() : [];
    return { timeline, clips, takes };
  }

  /** Keep the state in the history (before a change) or in the future (before an undo), with its label and the takes the change adds. */
  private async snapshot(where: "timeline_history" | "timeline_future", timelineId: string, label: string, added?: string[]) {
    const state = JSON.stringify({ ...(await this.stateOf(timelineId)), ...(added?.length ? { added } : {}) });
    const row = { id: newId(), timeline_id: timelineId, label, snapshot: state, created_at: now() };
    const last = await this.db.selectFrom(where).select("seq").where("timeline_id", "=", timelineId).orderBy("seq", "desc").executeTakeFirst();
    const seq = (last?.seq ?? 0) + 1;
    await this.db.insertInto(where).values({ ...row, seq }).execute();
    await this.db.deleteFrom(where).where("timeline_id", "=", timelineId).where("seq", "<=", seq - HISTORY).execute();
    return seq;
  }

  /**
   * Keep what the timeline looks like now, before a change. `label` says what the change is, for the Undo button; `added`
   * names the take the change adds, which Undo takes back with it. A change forgets what could be redone.
   */
  remember(timelineId: string, label: string, added?: string): Promise<number> {
    return this.oneAtATime(timelineId, async () => {
      const seq = await this.snapshot("timeline_history", timelineId, label, added ? [added] : undefined);
      await this.db.deleteFrom("timeline_future").where("timeline_id", "=", timelineId).execute();
      return seq;
    });
  }

  /**
   * Put a kept state back. What was rendered since is not lost: a take made after that state stays on its clip, and
   * stays the one that plays if it was; not the take the change itself added (Undo of "the finished take" takes it back).
   */
  private async restore(timelineId: string, was: Kept) {
    const nowClips = await this.db.selectFrom("clips").selectAll().where("timeline_id", "=", timelineId).execute();
    const nowTakes = nowClips.length ? await this.db.selectFrom("takes").selectAll().where("clip_id", "in", nowClips.map((c) => c.id)).execute() : [];
    const known = new Set(was.takes.map((t) => t.id));
    const back = new Set(was.clips.map((c) => c.id));
    const undone = new Set(was.added ?? []);
    const newer = nowTakes.filter((t) => !known.has(t.id) && back.has(t.clip_id) && !undone.has(t.id));
    const takes = [...was.takes, ...newer];
    const present = takes.length ? new Set((await this.db.selectFrom("assets").select("id").where("id", "in", takes.map((t) => t.asset_id)).execute()).map((a) => a.id)) : new Set<string>();
    const kept = takes.filter((t) => present.has(t.asset_id));
    const w = was.timeline;
    // its project and folder as they were, unless they have gone since (a project removed sends its timelines to the Inbox)
    const project = w.project_id && (await this.db.selectFrom("projects").select("id").where("id", "=", w.project_id).executeTakeFirst()) ? w.project_id : null;
    const folder = w.folder_id && (await this.db.selectFrom("folders").select("id").where("id", "=", w.folder_id).executeTakeFirst()) ? w.folder_id : null;
    await this.db.transaction().execute(async (tx) => {
      await tx.deleteFrom("clips").where("timeline_id", "=", timelineId).execute();
      for (const c of was.clips) {
        // a take made since the change keeps playing
        const current = nowClips.find((x) => x.id === c.id)?.take_id;
        const playing = current && newer.some((t) => t.id === current) ? current : c.take_id;
        await tx.insertInto("clips").values({ ...c, take_id: playing && kept.some((t) => t.id === playing) ? playing : null }).execute();
      }
      for (const t of kept) await tx.insertInto("takes").values(takeColumns(t)).execute();
      await tx
        .updateTable("timelines")
        .set({
          name: w.name, width: w.width, height: w.height, music_asset_id: w.music_asset_id, music_volume: w.music_volume,
          music_fade_in_ms: w.music_fade_in_ms, music_fade_out_ms: w.music_fade_out_ms, music_duck: w.music_duck, music_duck_db: w.music_duck_db ?? 10, look: w.look ?? null, mood: w.mood ?? null,
          project_id: project, folder_id: folder, folder_chosen: w.folder_chosen ?? 0, updated_at: now(),
        })
        .where("id", "=", timelineId)
        .execute();
      // a take that is back has its video back: removing it had sent the video to the bin
      if (kept.length) await tx.updateTable("assets").set({ deleted_at: null }).where("id", "in", kept.map((t) => t.asset_id)).where("deleted_at", "is not", null).execute();
    });
    this.changed();
  }

  /** Take the last change back. What it took back can be done again, until the next change. */
  undo(timelineId: string): Promise<string> {
    return this.oneAtATime(timelineId, async () => {
      const last = await this.db.selectFrom("timeline_history").selectAll().where("timeline_id", "=", timelineId).orderBy("seq", "desc").executeTakeFirst();
      if (!last) throw httpError("There is nothing to undo.");
      const was = JSON.parse(last.snapshot) as Kept;
      await this.snapshot("timeline_future", timelineId, last.label, was.added);
      await this.restore(timelineId, was);
      await this.db.deleteFrom("timeline_history").where("id", "=", last.id).execute();
      return last.label;
    });
  }

  /** Do again what Undo took back. */
  redo(timelineId: string): Promise<string> {
    return this.oneAtATime(timelineId, async () => {
      const next = await this.db.selectFrom("timeline_future").selectAll().where("timeline_id", "=", timelineId).orderBy("seq", "desc").executeTakeFirst();
      if (!next) throw httpError("There is nothing to redo.");
      const was = JSON.parse(next.snapshot) as Kept;
      await this.snapshot("timeline_history", timelineId, next.label, was.added);
      await this.restore(timelineId, was);
      await this.db.deleteFrom("timeline_future").where("id", "=", next.id).execute();
      return next.label;
    });
  }
}
