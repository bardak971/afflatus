import type { Measure } from "./cut";
import type { Db } from "./db";
import type { Look } from "./entities";
import { assetView } from "./media";
import { EXPORT_JOB } from "./timelines";
import { lengthOnGrid, seamless, visible, type Placed, type Taken, type TimelineRow } from "./timelineModel";

/** What a timeline's view is made of besides its clips' order and lengths: its takes as the browser gets them, its jobs, its header. */

/** What the record of renders says of a take's video: how long its render took, and how its own part looks. */
export interface Rendered {
  genMs: number | null;
  measure: Measure | null;
}

/** A take as the browser gets it. */
export function takeView(x: Taken, rendered: Rendered | undefined) {
  const shown = visible(x);
  return {
    id: x.take.id, asset: assetView(x.asset), headMs: x.take.head_ms, tailMs: x.take.tail_ms,
    trimStartMs: x.take.trim_start_ms, trimEndMs: x.take.trim_end_ms, startMs: shown.start, endMs: shown.end, createdAt: x.take.created_at,
    /** How much of it can play at most: its video on the model's frame grid, without the parts it shares with its neighbours. */
    roomMs: Math.max(0, lengthOnGrid(x.asset) - x.take.head_ms - x.take.tail_ms),
    // decoded as one piece with the clip before it, which is still the take it was made from: the join is a plain cut
    seamless: seamless(x),
    ...(x.landed !== undefined ? { landedMs: x.landed } : {}),
    finishedFrom: x.take.finished_from,
    /** How its start joins the clip before: in the latent (the clip before's own tokens continued), or pinned frames; null when it does not continue a clip. */
    joinKind: x.take.join_kind ?? null,
    /** How long its render took, when it was rendered here and measured; null otherwise. */
    renderMs: rendered?.genMs || null,
    /** How its own part looks: mean luma (0–255) and a sharpness figure, measured on its frames when it was rendered here; null otherwise. */
    measure: rendered?.measure ?? null,
  };
}

export class TimelineViews {
  constructor(private readonly db: Db) {}

  private async assetRow(id: string | null) {
    return id ? await this.db.selectFrom("assets").selectAll().where("id", "=", id).executeTakeFirst() : undefined;
  }

  /** What a timeline's view says besides its clips: its frame, place, look, music, what Undo and Redo would do, its export. */
  async headOf(t: TimelineRow) {
    const music = await this.assetRow(t.music_asset_id);
    const undo = await this.db.selectFrom("timeline_history").select("label").where("timeline_id", "=", t.id).orderBy("seq", "desc").executeTakeFirst();
    const redo = await this.db.selectFrom("timeline_future").select("label").where("timeline_id", "=", t.id).orderBy("seq", "desc").executeTakeFirst();
    // its export under way (the newest when several wait), else its last export, whatever the other timelines exported since
    const ownExports = () => this.db.selectFrom("jobs").select(["id", "status", "error"]).where("recipe_id", "=", EXPORT_JOB).where("timeline_id", "=", t.id).orderBy("created_at", "desc");
    const exporting = await ownExports().where("status", "in", ["queued", "running"]).executeTakeFirst();
    const lastExport = exporting ? undefined : await ownExports().executeTakeFirst();
    const exported = await this.assetRow(t.export_asset_id);
    return {
      id: t.id, name: t.name, width: t.width, height: t.height, updatedAt: t.updated_at,
      /** The project it belongs to, and the folder its renders land in (null: the project's root, or none). */
      projectId: t.project_id, folderId: t.folder_id, folderChosen: Boolean(t.folder_chosen),
      look: t.look ? (JSON.parse(t.look) as Look) : null,
      mood: t.mood ?? "",
      music: music ? { asset: assetView(music), volume: t.music_volume, fadeInMs: t.music_fade_in_ms, fadeOutMs: t.music_fade_out_ms, duck: Boolean(t.music_duck) } : null,
      /** What Undo would take back, in a few words; null when there is nothing to undo. The same for Redo. */
      undo: undo?.label ?? null,
      redo: redo?.label ?? null,
      exporting: exporting ? { id: exporting.id, status: exporting.status } : null,
      exported: exported && !exported.deleted_at ? assetView(exported) : null,
      exportFailed: lastExport?.status === "failed" ? lastExport.error : null,
    };
  }

  /**
   * The jobs a timeline's clips show: the one under way (or waiting) for each, and the last one asked for, whose failure is
   * said until another is asked for. Not every job ever run for them: that list only grows.
   */
  async jobsOf(clipIds: string[]) {
    const live = new Map<string, { id: string; status: "queued" | "running" }>();
    const last = new Map<string, { status: string; error: string | null }>();
    if (!clipIds.length) return { live, last };
    const going = await this.db.selectFrom("jobs").select(["id", "clip_id", "status"]).where("clip_id", "in", clipIds).where("status", "in", ["queued", "running"]).orderBy("created_at").execute();
    for (const j of going) if (j.clip_id && !live.has(j.clip_id)) live.set(j.clip_id, { id: j.id, status: j.status as "queued" | "running" });
    const newest = this.db.selectFrom("jobs").select((eb) => ["clip_id", eb.fn.max("created_at").as("at")]).where("clip_id", "in", clipIds).groupBy("clip_id").as("newest");
    const ended = await this.db
      .selectFrom("jobs")
      .innerJoin(newest, (j) => j.onRef("jobs.clip_id", "=", "newest.clip_id").onRef("jobs.created_at", "=", "newest.at"))
      .select(["jobs.clip_id as clip_id", "jobs.status as status", "jobs.error as error"])
      .execute();
    for (const j of ended) if (j.clip_id) last.set(j.clip_id, { status: j.status, error: j.error });
    return { live, last };
  }


  /** How long each take's render took and how its own part looks, by generation (a finish made by a cut has none). */
  async renderedOf(all: Placed[]): Promise<Map<string, Rendered>> {
    const made = [...new Set(all.flatMap((p) => p.takes.map((x) => x.asset.generation_id)).filter((g): g is string => Boolean(g)))];
    const records = made.length ? await this.db.selectFrom("generations").select(["id", "gen_ms", "measure"]).where("id", "in", made).execute() : [];
    // how each render's own part looks (mean luma, sharpness), measured on its frames when it was stored
    return new Map(records.map((g) => [g.id, { genMs: g.gen_ms, measure: g.measure ? (JSON.parse(g.measure) as Measure) : null }]));
  }
}
