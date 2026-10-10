import { joinKindOf } from "@afflatus/core";
import { nameTake } from "./autoName";
import { newId, now, type Db } from "./db";
import { precomputeOf } from "./precompute";
import { lengthOnGrid, type AssetRow, type ClipRow, type TimelineCore } from "./timelineModel";
import type { TakeLinks } from "./timelinePlan";

/**
 * Takes placed on their clips: a render's video when its job is done (and the trims of the clips it joins), a video a
 * slow-motion or finish job hands back, a take a new clip comes with.
 */

type Overlap = { headMs: number; tailMs: number; latent?: boolean; frames?: boolean };

export class TimelineTakes {
  constructor(private readonly core: TimelineCore) {}

  /** What a video's render shared with its neighbours (its overlap), from its record; nothing for a video not rendered here. */
  private async overlapOf(assetId: string, db: Db = this.core.db): Promise<(Overlap & { seam?: boolean }) | undefined> {
    const asset = await db.selectFrom("assets").select("generation_id").where("id", "=", assetId).executeTakeFirst();
    const g = asset?.generation_id ? await db.selectFrom("generations").select("resolved").where("id", "=", asset.generation_id).executeTakeFirst() : undefined;
    return g ? (JSON.parse(g.resolved) as { overlap?: Overlap & { seam?: boolean } }).overlap : undefined;
  }

  /** The video as a take of the clip, which plays it. The first video of a timeline decides its frame. */
  async add(clipId: string, asset: AssetRow, overlap: Overlap, links: TakeLinks, finishedFrom: string | null = null, db: Db = this.core.db, id = newId()) {
    // the finished version of a take keeps that take's overlaps and trims: it plays the same part, larger
    const from = finishedFrom ? await db.selectFrom("takes").selectAll().where("id", "=", finishedFrom).executeTakeFirst() : undefined;
    // a finish whose draft was removed meanwhile: what the draft shared with its neighbours is read from the draft's video, so
    // that the finish does not play its hidden run-up (a finish made from frames is the draft's frames, enlarged)
    const drafted = finishedFrom && !from && overlap.headMs <= 0 && asset.source_id ? await this.overlapOf(asset.source_id, db) : undefined;
    const own = drafted ?? overlap;
    await db
      .insertInto("takes")
      .values({
        id, clip_id: clipId, asset_id: asset.id, head_ms: from?.head_ms ?? own.headMs, tail_ms: from?.tail_ms ?? own.tailMs, trim_start_ms: from?.trim_start_ms ?? 0, trim_end_ms: from?.trim_end_ms ?? 0,
        // a finish made from frames joins as its draft did; one rendered again (H3's latent re-sample) as its own render says:
        // seamless only when its join was decoded as one piece with the clip before's re-sampled latent
        join_kind: from && overlap.headMs <= 0 ? from.join_kind : joinKindOf(own),
        prev_take_id: links.prev?.take ?? from?.prev_take_id ?? null, prev_at_ms: links.prev?.at ?? from?.prev_at_ms ?? null, next_take_id: links.next?.take ?? from?.next_take_id ?? null, next_at_ms: links.next?.at ?? from?.next_at_ms ?? null,
        finished_from: from ? from.id : null, created_at: now(),
      })
      .execute();
    const clip = await db.updateTable("clips").set({ take_id: id, updated_at: now() }).where("id", "=", clipId).returning("timeline_id").executeTakeFirst();
    await this.core.keep(asset.id, db);
    // a render that has no name yet is called after its timeline, clip and take (a name given by hand stays)
    await nameTake(db, id);
    // what the editor reads of it, measured in the background once the timeline's edits settle
    if (clip) precomputeOf(this.core.db)?.timeline(clip.timeline_id);
    // the first video of a timeline decides its frame
    if (clip && asset.width && asset.height) {
      await db.updateTable("timelines").set({ width: asset.width, height: asset.height }).where("id", "=", clip.timeline_id).where("width", "is", null).execute();
    }
    return id;
  }

  /**
   * Work on a clip's timeline in its turn, in one transaction: an Undo landing between a take's statements put it back not
   * playing, or deleted it with its clip's row (and a failure half way left half a landing). False when the clip is gone.
   */
  private async onClip(clipId: string, work: (tx: Db, clip: ClipRow) => Promise<void>): Promise<boolean> {
    const { db } = this.core;
    const timeline = (await db.selectFrom("clips").select("timeline_id").where("id", "=", clipId).executeTakeFirst())?.timeline_id;
    if (!timeline) return false;
    return this.core.oneAtATime(timeline, () => db.transaction().execute(async (tx) => {
      // read again in the turn: the clip may have gone while the turn was waited for
      const clip = await tx.selectFrom("clips").selectAll().where("id", "=", clipId).executeTakeFirst();
      if (!clip) return false;
      await work(tx, clip);
      return true;
    }));
  }

  /** A clip's job is done: its video becomes a take, and plays. The first take of a timeline decides its frame. */
  async finished(clipId: string, generationId: string, overlap: Overlap | undefined, links: TakeLinks, finishedFrom: string | null = null): Promise<void> {
    let timeline: string | null = null;
    // the clip was removed while it rendered: the video is in the library all the same
    await this.onClip(clipId, async (db, clip) => {
      const asset = await db.selectFrom("assets").selectAll().where("generation_id", "=", generationId).where("kind", "=", "video").executeTakeFirst();
      if (!asset) return;
      // placed already: the queue found the job again after a crash between placing the take and closing the job
      if (await db.selectFrom("takes").select("id").where("clip_id", "=", clipId).where("asset_id", "=", asset.id).executeTakeFirst()) return;
      timeline = clip.timeline_id;
      const id = newId();
      // a finished take is a step of its own, which Undo takes back with the take (a render's new take is no step: Undo keeps it)
      if (finishedFrom) await this.core.remember(clip.timeline_id, "the finished take", id, db);
      await this.add(clipId, asset, overlap ?? { headMs: 0, tailMs: 0 }, links, finishedFrom, db, id);
      // the take lands on the clip after a little further in than it played (on a chunk of its latent): that clip now starts there
      if (links.next && !finishedFrom) {
        const next = await db.selectFrom("takes").select(["id", "head_ms", "trim_start_ms"]).where("id", "=", links.next.take).executeTakeFirst();
        if (next && links.next.at > next.head_ms + next.trim_start_ms + 20) {
          await this.core.remember(clip.timeline_id, "the landing on the clip after", undefined, db);
          await db.updateTable("takes").set({ trim_start_ms: Math.round(links.next.at - next.head_ms) }).where("id", "=", next.id).execute();
        }
      }
      // the take carried on from before the clip before's frozen tail: that clip now stops where the take picks up
      if (links.prev && !finishedFrom) {
        const prev = await db.selectFrom("takes").innerJoin("assets", "assets.id", "takes.asset_id").select(["takes.id as id", "takes.tail_ms as tail_ms", "takes.trim_end_ms as trim_end_ms", "assets.duration_ms as duration_ms", "assets.latent_frames as latent_frames"]).where("takes.id", "=", links.prev.take).executeTakeFirst();
        if (prev?.duration_ms) {
          const length = lengthOnGrid(prev as unknown as AssetRow);
          const end = length - prev.tail_ms - prev.trim_end_ms;
          if (links.prev.at < end - 40) {
            await this.core.remember(clip.timeline_id, "the hand-over before the frozen tail", undefined, db);
            await db.updateTable("takes").set({ trim_end_ms: Math.round(length - prev.tail_ms - links.prev.at) }).where("id", "=", prev.id).execute();
          }
        }
      }
    });
    if (timeline) await this.core.touch(timeline);
  }

  /**
   * A video becomes a take of a clip, and plays (what a slow-motion or finish job hands back). One step to undo, which takes
   * the take back. A video placed on the clip already is not placed again.
   */
  async takeFrom(clipId: string, asset: AssetRow, label = "the slow-motion take", finishedFrom: string | null = null): Promise<void> {
    let timeline: string | null = null;
    // the clip was removed while the job ran: the video is in the library all the same
    await this.onClip(clipId, async (db, clip) => {
      if (await db.selectFrom("takes").select("id").where("clip_id", "=", clipId).where("asset_id", "=", asset.id).executeTakeFirst()) return;
      timeline = clip.timeline_id;
      const id = newId();
      await this.core.remember(clip.timeline_id, label, id, db);
      await this.add(clipId, asset, { headMs: 0, tailMs: 0 }, {}, finishedFrom, db, id);
    });
    if (timeline) await this.core.touch(timeline);
  }
}
