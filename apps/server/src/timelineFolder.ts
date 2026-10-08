import type { Db } from "./db";
import { isLinked } from "./linked";
import { rootFolderOf } from "./projects";

/**
 * The timeline folder rule: what is made inside a timeline (its renders, finishes, slow motion, cuts, frames, its export)
 * lands in the timeline's folder: its own, else its project's root, else none (the Inbox). And when the timeline moves,
 * what it made follows it there.
 */

/** Where what a timeline makes lands: its own folder (while it exists), else its project's root, else none. */
export async function folderOfTimeline(db: Db, t: { folder_id: string | null; project_id: string | null }): Promise<string | null> {
  if (t.folder_id && (await db.selectFrom("folders").select("id").where("id", "=", t.folder_id).executeTakeFirst())) return t.folder_id;
  return rootFolderOf(db, t.project_id);
}

/**
 * Where something made out of a video lands (a frame, a cut, a slowed or finished copy): the folder of the timeline it was
 * made in. Not said: the timeline whose takes play this video, when only one does; else beside the video.
 */
export async function folderForMade(db: Db, video: { id: string; folder_id: string | null }, timeline?: string | null): Promise<string | null> {
  const ids = timeline
    ? [timeline]
    : (await db.selectFrom("takes").innerJoin("clips", "clips.id", "takes.clip_id").select("clips.timeline_id as id").where("takes.asset_id", "=", video.id).distinct().execute()).map((r) => r.id);
  if (ids.length !== 1) return video.folder_id;
  const t = await db.selectFrom("timelines").select(["folder_id", "project_id"]).where("id", "=", ids[0]!).executeTakeFirst();
  return t ? folderOfTimeline(db, t) : video.folder_id;
}

/** The timeline a clip is on, or null. */
export async function timelineOfClip(db: Db, clip: string | null | undefined): Promise<string | null> {
  if (!clip) return null;
  return (await db.selectFrom("clips").select("timeline_id").where("id", "=", clip).executeTakeFirst())?.timeline_id ?? null;
}

/**
 * What a timeline made, moved to its folder (folderOfTimeline): the videos of its clips' takes, its export, and the frames and
 * cuts taken out of those videos. Not one another timeline plays too (a take, a still), a file of a linked folder, or one in the bin.
 * Nothing moves into a linked folder (a directory of the disk: filing there is a copy, see linked.ts). `db`: the transaction.
 */
export async function timelineMediaFollows(db: Db, timelineId: string): Promise<number> {
  const t = await db.selectFrom("timelines").select(["folder_id", "project_id", "export_asset_id"]).where("id", "=", timelineId).executeTakeFirst();
  if (!t) return 0;
  const folder = await folderOfTimeline(db, t);
  if (folder && (await db.selectFrom("folders").select("path").where("id", "=", folder).executeTakeFirst())?.path) return 0;
  const takes = (await db.selectFrom("takes").innerJoin("clips", "clips.id", "takes.clip_id").select("takes.asset_id as id").where("clips.timeline_id", "=", timelineId).distinct().execute()).map((r) => r.id);
  const made = takes.length
    ? (await db.selectFrom("assets").select("id").where("origin", "in", ["frame", "cut"]).where("source_id", "in", takes).execute()).map((r) => r.id)
    : [];
  const ids = [...new Set([...takes, ...made, ...(t.export_asset_id ? [t.export_asset_id] : [])])];
  if (!ids.length) return 0;
  // played by another timeline too (a take, or a picture held): it stays where it is
  const shared = new Set([
    ...(await db.selectFrom("takes").innerJoin("clips", "clips.id", "takes.clip_id").select("takes.asset_id as id").where("takes.asset_id", "in", ids).where("clips.timeline_id", "!=", timelineId).distinct().execute()).map((r) => r.id),
    ...(await db.selectFrom("clips").select("still_asset_id as id").where("still_asset_id", "in", ids).where("timeline_id", "!=", timelineId).distinct().execute()).map((r) => r.id),
  ]);
  const rows = await db.selectFrom("assets").select(["id", "file_key", "folder_id"]).where("id", "in", ids).where("deleted_at", "is", null).execute();
  const moving = rows.filter((a) => !shared.has(a.id) && !isLinked(a.file_key) && a.folder_id !== folder).map((a) => a.id);
  if (moving.length) await db.updateTable("assets").set({ folder_id: folder }).where("id", "in", moving).execute();
  return moving.length;
}
