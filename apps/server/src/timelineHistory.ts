import { newId, now, type Db } from "./db";
import { httpError } from "./errors";
import { KeyedLock } from "./keyedLock";
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
export const takeColumns = (t: TakeRow): TakeRow => Object.fromEntries(Object.entries(t).filter(([k]) => k in TAKE_COLUMNS)) as TakeRow;
/** The columns a clip has now, likewise: a clip kept whole before a column went (in a snapshot, or set aside by a trim) still carries it. */
const CLIP_COLUMNS: Record<keyof ClipRow, true> = {
  id: true, timeline_id: true, position: true, take_id: true, joined: true, recipe_id: true, inputs: true, kind: true, still_asset_id: true, still_ms: true, sound: true,
  sound_asset_id: true, volume: true, fill: true, fit_next: true, look: true, chat: true, designer: true, music: true, pin_mirror: true, transition: true, created_at: true, updated_at: true,
};
export const clipColumns = (c: ClipRow): ClipRow => Object.fromEntries(Object.entries(c).filter(([k]) => k in CLIP_COLUMNS)) as ClipRow;

export class TimelineHistory {
  constructor(
    private readonly db: Db,
    private readonly row: (id: string) => Promise<TimelineRow>,
    private readonly changed: () => void,
  ) {}

  /** What runs one at a time, by key (keyedLock.ts). */
  private readonly turns = new KeyedLock();

  /**
   * Work done one at a time per key, in the order asked: Undo, Redo and the steps they keep, per timeline (two undos at once
   * restored the same step; two steps kept at once could share a number), a take landing on a clip and the edits of
   * several statements (an Undo between them put back half of one), and a timeline's export check and queueing. Work
   * asked for from inside a turn of the same key (a take landing keeps its own step) runs in that turn: waiting for
   * the turn it is part of would wait forever.
   */
  oneAtATime<T>(key: string, work: () => Promise<T>): Promise<T> {
    return this.turns.run(key, work);
  }


  /** What the timeline looks like now, as one piece: the row, its clips, their takes. `db`: the transaction it is read in. */
  private async stateOf(timelineId: string, db: Db): Promise<Kept> {
    const timeline = db === this.db ? await this.row(timelineId) : await db.selectFrom("timelines").selectAll().where("id", "=", timelineId).executeTakeFirstOrThrow();
    const clips = await db.selectFrom("clips").selectAll().where("timeline_id", "=", timelineId).execute();
    const takes = clips.length ? await db.selectFrom("takes").selectAll().where("clip_id", "in", clips.map((c) => c.id)).execute() : [];
    return { timeline, clips, takes };
  }

  /** Keep the state in the history (before a change) or in the future (before an undo), with its label and the takes the change adds. */
  private async snapshot(where: "timeline_history" | "timeline_future", timelineId: string, label: string, added?: string[], db: Db = this.db) {
    const state = JSON.stringify({ ...(await this.stateOf(timelineId, db)), ...(added?.length ? { added } : {}) });
    const row = { id: newId(), timeline_id: timelineId, label, snapshot: state, created_at: now() };
    const last = await db.selectFrom(where).select("seq").where("timeline_id", "=", timelineId).orderBy("seq", "desc").executeTakeFirst();
    const seq = (last?.seq ?? 0) + 1;
    await db.insertInto(where).values({ ...row, seq }).execute();
    await db.deleteFrom(where).where("timeline_id", "=", timelineId).where("seq", "<=", seq - HISTORY).execute();
    return seq;
  }

  /**
   * Keep what the timeline looks like now, before a change. `label` says what the change is, for the Undo button; `added`
   * names the take the change adds, which Undo takes back with it. A change forgets what could be redone. `db`: the
   * transaction the change is made in, so that the step and the change land together; given only from inside the
   * timeline's turn (a transaction waiting for a turn would hold the database from the work that has the turn).
   */
  remember(timelineId: string, label: string, added?: string, db: Db = this.db): Promise<number> {
    return this.oneAtATime(timelineId, async () => {
      const seq = await this.snapshot("timeline_history", timelineId, label, added ? [added] : undefined, db);
      await db.deleteFrom("timeline_future").where("timeline_id", "=", timelineId).execute();
      return seq;
    });
  }

  /**
   * Put a kept state back. What was rendered since is not lost: a take made after that state stays on its clip, and
   * stays the one that plays if it was; not the take the change itself added (Undo of "the finished take" takes it back).
   */
  private async restore(timelineId: string, was: Kept) {
    // what is there now is read in the same transaction that replaces it: a take landing between the reading and the
    // writing was put back without playing, or deleted with its clip's row
    await this.db.transaction().execute(async (tx) => {
      const nowClips = await tx.selectFrom("clips").selectAll().where("timeline_id", "=", timelineId).execute();
      const nowTakes = nowClips.length ? await tx.selectFrom("takes").selectAll().where("clip_id", "in", nowClips.map((c) => c.id)).execute() : [];
      const known = new Set(was.takes.map((t) => t.id));
      const back = new Set(was.clips.map((c) => c.id));
      const undone = new Set(was.added ?? []);
      const newer = nowTakes.filter((t) => !known.has(t.id) && back.has(t.clip_id) && !undone.has(t.id));
      const takes = [...was.takes, ...newer];
      const present = takes.length ? new Set((await tx.selectFrom("assets").select("id").where("id", "in", takes.map((t) => t.asset_id)).execute()).map((a) => a.id)) : new Set<string>();
      const kept = takes.filter((t) => present.has(t.asset_id));
      const w = was.timeline;
      // its project and folder as they were, unless they have gone since (a project removed sends its timelines to the Inbox)
      const project = w.project_id && (await tx.selectFrom("projects").select("id").where("id", "=", w.project_id).executeTakeFirst()) ? w.project_id : null;
      const folder = w.folder_id && (await tx.selectFrom("folders").select("id").where("id", "=", w.folder_id).executeTakeFirst()) ? w.folder_id : null;
      await tx.deleteFrom("clips").where("timeline_id", "=", timelineId).execute();
      for (const c of was.clips) {
        const there = nowClips.find((x) => x.id === c.id);
        // a take made since the change keeps playing
        const current = there?.take_id;
        const playing = current && newer.some((t) => t.id === current) ? current : c.take_id;
        // what was said to the designer, and with which model, is no step of the timeline (it is saved without one): a clip
        // still there keeps its conversation as it is now, whatever the step put back
        const talk = there ? { chat: there.chat, designer: there.designer } : {};
        await tx.insertInto("clips").values({ ...clipColumns(c), ...talk, take_id: playing && kept.some((t) => t.id === playing) ? playing : null }).execute();
      }
      for (const t of kept) await tx.insertInto("takes").values(takeColumns(t)).execute();
      await tx
        .updateTable("timelines")
        .set({
          name: w.name, width: w.width, height: w.height, music_asset_id: w.music_asset_id, music_volume: w.music_volume,
          music_fade_in_ms: w.music_fade_in_ms, music_fade_out_ms: w.music_fade_out_ms, music_duck: w.music_duck, music_duck_db: w.music_duck_db ?? 10,
          music_from_ms: w.music_from_ms ?? 0, music_start_clip_id: w.music_start_clip_id ?? null, look: w.look ?? null, mood: w.mood ?? null, source: w.source ?? null, recordings: w.recordings ?? null,
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
