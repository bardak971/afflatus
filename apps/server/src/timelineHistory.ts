import { newId, now, type Db } from "./db";
import { httpError } from "./errors";
import { KeyedLock } from "./keyedLock";
import { ID_IN_NESTED_JSON } from "./sweep";
import type { ClipRow, TakeRow, TimelineRow } from "./timelineModel";

/**
 * Undo and Redo of a timeline: a state kept before each change (the history) and before each undo (the future), as
 * snapshots of its row, its clips and their takes. What was rendered since a state is not lost by going back to it, and
 * no step goes back over a clip in the queue (restore).
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
    /** The inputs that say a clip's part of a source or recording (its media, start and length), by its recipe. */
    private readonly partKeys: (recipeId: string | null) => string[] = () => [],
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
   * Put a kept state back, in the transaction of the step that does it (`tx`). Refused (409) when a clip in the queue
   * would go, or its part of a source or recording change: an Undo of a trim set aside, removed or resized a clip while
   * its render ran, a render paid for on a rented GPU landing on no clip, or on one of another length (the trims refuse
   * the same: refuseBusy). What was
   * rendered since is not lost: a take made after that state (not one the change itself added: Undo of "the finished
   * take" takes it back) stays on its clip, and stays the one that plays if it was, when that clip is back as it was
   * rendered, placed or among those a trim set aside. A take whose clip is not (gone at that step, or back with another
   * part of its source or recording than its render had) is not put on it: its video stays in the library, kept, and the
   * step the other way puts it back. Returns what to tell the user of those, if any.
   */
  private async restore(tx: Db, timelineId: string, was: Kept, step: "Undo" | "Redo"): Promise<string | undefined> {
    // what is there now is read in the same transaction that replaces it: a take landing between the reading and the
    // writing was put back without playing, or deleted with its clip's row
    const nowClips = await tx.selectFrom("clips").selectAll().where("timeline_id", "=", timelineId).orderBy("position").execute();
    const nowTakes = nowClips.length ? await tx.selectFrom("takes").selectAll().where("clip_id", "in", nowClips.map((c) => c.id)).execute() : [];
    const placedNow = new Map(nowClips.map((c) => [c.id, c]));
    const number = (id: string) => nowClips.findIndex((c) => c.id === id) + 1;
    const backAs = new Map(was.clips.map((c) => [c.id, c]));
    const busy = nowClips.length ? await tx.selectFrom("jobs").select("clip_id").where("clip_id", "in", nowClips.map((c) => c.id)).where("status", "in", ["queued", "running"]).execute() : [];
    for (const { clip_id: id } of busy) {
      if (!id) continue;
      const back = backAs.get(id);
      if (!back) throw httpError(`Clip ${number(id)} is rendering or in the queue, and this ${step} would take it off the timeline: its render would land on no clip. Let it end, or stop it, first.`, 409);
      if (this.shapeOf(back) !== this.shapeOf(placedNow.get(id)!)) throw httpError(`Clip ${number(id)} is rendering or in the queue, and this ${step} would change its part of the source or recording: its render would not fit it. Let it end, or stop it, first.`, 409);
    }
    const undone = new Set(was.added ?? []);
    const w = was.timeline;
    // the clips a trim had set aside at that step, whole (the source's windows, each recording's clips), written back
    // with the takes that fit them
    const source = parse(w.source) as { parked?: Parked[] } | null;
    const recordings = parse(w.recordings) as Record<string, unknown> | null;
    const aside = [...(source?.parked ?? []), ...Object.values(recordings ?? {}).flatMap((v) => (Array.isArray(v) ? (v as Parked[]) : []))].filter((r) => r && typeof r.clip === "object" && Array.isArray(r.takes));
    // the takes the state has, placed or set aside with their clip: none of them is one made since
    const known = new Set([...was.takes.map((t) => t.id), ...aside.flatMap((r) => r.takes.map((t) => String(t.id)))]);
    const newer: TakeRow[] = [];
    const left: TakeRow[] = [];
    let asideChanged = false;
    for (const t of nowTakes) {
      if (known.has(t.id) || undone.has(t.id)) continue;
      const shape = this.shapeOf(placedNow.get(t.clip_id)!);
      const placed = backAs.get(t.clip_id);
      const row = placed ? undefined : aside.find((r) => r.clip.id === t.clip_id);
      if (placed && this.shapeOf(placed) === shape) newer.push(t);
      else if (row && this.shapeOf(row.clip as unknown as ClipRow) === shape) {
        row.takes.push(t as unknown as Record<string, unknown>);
        if (placedNow.get(t.clip_id)!.take_id === t.id) row.clip = { ...row.clip, take_id: t.id };
        asideChanged = true;
      } else left.push(t);
    }
    const takes = [...was.takes, ...newer];
    const present = takes.length ? new Set((await tx.selectFrom("assets").select("id").where("id", "in", takes.map((t) => t.asset_id)).execute()).map((a) => a.id)) : new Set<string>();
    const kept = takes.filter((t) => present.has(t.asset_id));
    // its project and folder as they were, unless they have gone since (a project removed sends its timelines to the Inbox)
    const project = w.project_id && (await tx.selectFrom("projects").select("id").where("id", "=", w.project_id).executeTakeFirst()) ? w.project_id : null;
    const folder = w.folder_id && (await tx.selectFrom("folders").select("id").where("id", "=", w.folder_id).executeTakeFirst()) ? w.folder_id : null;
    await tx.deleteFrom("clips").where("timeline_id", "=", timelineId).execute();
    for (const c of was.clips) {
      const there = placedNow.get(c.id);
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
        music_from_ms: w.music_from_ms ?? 0, music_start_clip_id: w.music_start_clip_id ?? null, look: w.look ?? null, mood: w.mood ?? null,
        source: asideChanged && source ? JSON.stringify(source) : (w.source ?? null), recordings: asideChanged && recordings ? JSON.stringify(recordings) : (w.recordings ?? null),
        project_id: project, folder_id: folder, folder_chosen: w.folder_chosen ?? 0, updated_at: now(),
      })
      .where("id", "=", timelineId)
      .execute();
    // what the step puts back has its pictures and videos back out of the bin: a take removed had sent its video there,
    // and an item named only in Undo or Redo may be binned from the library meanwhile (nothing erases it while a step
    // names it: inUse's `undo`)
    const named = [...new Set([...JSON.stringify([was, source, recordings]).matchAll(ID_IN_NESTED_JSON)].map((m) => m[1]!))];
    for (let i = 0; i < named.length; i += 500) await tx.updateTable("assets").set({ deleted_at: null }).where("id", "in", named.slice(i, i + 500)).where("deleted_at", "is not", null).execute();
    if (!left.length) return undefined;
    // a take left out is on no timeline now: its video kept, else it went to the bin in a day as a result nobody kept
    await tx.updateTable("assets").set({ kept_at: now() }).where("id", "in", left.map((t) => t.asset_id)).where("kept_at", "is", null).execute();
    const other = step === "Undo" ? "Redo" : "Undo";
    return left.length === 1
      ? `The take rendered since on clip ${number(left[0]!.clip_id)} does not fit that clip at this step: its video stays kept in the library, and ${other} puts it back.`
      : `${left.length} takes rendered since do not fit their clips at this step: their videos stay kept in the library, and ${other} puts them back.`;
  }

  /**
   * What a take of the clip has to match: its kind, and its part of a source or recording (where it starts, how long it
   * is). Not its form, its model or its join: a take rendered after such a change goes on playing when it is undone.
   */
  private shapeOf(c: ClipRow): string {
    const inputs = (parse(c.inputs) ?? {}) as Record<string, unknown>;
    return JSON.stringify([c.kind, ...this.partKeys(c.recipe_id).map((k) => inputs[k] ?? null)]);
  }

  /**
   * One step, Undo (`from` the history) or Redo (from the future): the state now kept on the other side, the one taken put
   * back, in one transaction. Refused, nothing of it is written: a state kept on the other side first was one too many.
   */
  private step(timelineId: string, from: "timeline_history" | "timeline_future"): Promise<{ label: string; said?: string }> {
    const undo = from === "timeline_history";
    return this.oneAtATime(timelineId, async () => {
      const last = await this.db.selectFrom(from).selectAll().where("timeline_id", "=", timelineId).orderBy("seq", "desc").executeTakeFirst();
      if (!last) throw httpError(undo ? "There is nothing to undo." : "There is nothing to redo.");
      const was = JSON.parse(last.snapshot) as Kept;
      const said = await this.db.transaction().execute(async (tx) => {
        await this.snapshot(undo ? "timeline_future" : "timeline_history", timelineId, last.label, was.added, tx);
        const said = await this.restore(tx, timelineId, was, undo ? "Undo" : "Redo");
        await tx.deleteFrom(from).where("id", "=", last.id).execute();
        return said;
      });
      this.changed();
      return { label: last.label, ...(said ? { said } : {}) };
    });
  }

  /** Take the last change back. What it took back can be done again, until the next change. */
  undo(timelineId: string): Promise<{ label: string; said?: string }> {
    return this.step(timelineId, "timeline_history");
  }

  /** Do again what Undo took back. */
  redo(timelineId: string): Promise<{ label: string; said?: string }> {
    return this.step(timelineId, "timeline_future");
  }
}

/** A clip a trim set aside, as a timeline's source and recordings keep it (Timelines.trimSource). */
type Parked = { clip: Record<string, unknown>; takes: Array<Record<string, unknown>> };

const parse = (text: string | null | undefined): unknown => {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};
