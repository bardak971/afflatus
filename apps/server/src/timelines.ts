import { chatJson } from "./designer";
import type { EventEmitter } from "node:events";
import type { InputSpec } from "@afflatus/core";
import { newId, now, OWNER, type Db } from "./db";
import { httpError, notFound } from "./errors";
import { rootFolderOf } from "./projects";
import { timelineMediaFollows } from "./timelineFolder";
import type { Look } from "./entities";
import { assetView } from "./media";
import type { Registry } from "./registry";
import type { Storage } from "./storage";
import { TimelineExport } from "./timelineExport";
import { TimelineMedia } from "./timelineMedia";
import { TimelineHistory } from "./timelineHistory";
import { TimelineRange, type RangeContext } from "./timelineRange";
import { takeView, TimelineViews } from "./timelineViews";
import { recipeWithStart, settingsOf, TimelinePlan, type ClipPlan, type TakeLinks } from "./timelinePlan";
import { TimelineTakes } from "./timelineTakes";
import { clockOf, FROM_PREVIOUS, lengthOf, markJoins, STILL_MS, stillRef, takeFollows, takeLandsOn, trimsOf, type AssetRow, type ClipRow, type Placed, type TakeRow, type Taken, type TimelineCore, type TimelineRow } from "./timelineModel";

/**
 * Timelines: clips played one after the other. A clip is a place on the timeline with a form (what to
 * render there); each render of it is a take, and one take plays. A clip can carry on from the clip
 * before it: the take then remembers which take it carried on from, so that when that one changes the
 * join is known to be stale. A clip can also be a picture held on screen (a still). Nothing here knows
 * which model a clip is made with: it reads the recipe's inputs (a clip to carry on from, a clip to
 * arrive at, an opening picture) and fills them in.
 */

// the parts of the model other modules name: the opening-picture placeholder and the clock (timelineModel.ts), how a regenerated clip meets its neighbours (timelineRange.ts), a clip's plan (timelinePlan.ts)
export { clockOf, FROM_PREVIOUS };
export type { RangeContext, ClipPlan, TakeLinks };

/** How many frames the trim bar asks for in a video's film strip: one a second, from sixteen up to a hundred and twenty (see Trim.tsx). */
const TRIM_STRIP_FRAMES = (durationMs: number) => Math.min(120, Math.max(16, Math.round(durationMs / 1000)));

/**
 * The keys of what the timeline works out of a video and keeps beside it: its film strip (the track's,
 * and the trim bar's when its length is known), its motion and loudness, its scene cuts, its colour along it. They go when
 * the video goes, or when the file behind it changes (a linked folder's file written again).
 */
export function derivedKeys(asset: { id: string; duration_ms: number | null }): string[] {
  const dir = asset.id.slice(0, 2);
  return [
    `strips/${dir}/${asset.id}.jpg`,
    ...(asset.duration_ms ? [`strips/${dir}/${asset.id}-${TRIM_STRIP_FRAMES(asset.duration_ms)}x48.jpg`] : []),
    `motion/${dir}/${asset.id}.json`,
    `scenes/${dir}/${asset.id}.json`,
    `means/${dir}/${asset.id}.json`,
  ];
}

/** The recipe id of a job that keeps a range of a video as new videos, instead of rendering something. */
export const CUT_JOB = "afflatus.cut";
export interface CutOptions {
  asset: string;
  startMs: number;
  endMs: number;
  /**
   * "slow": the range slowed down by `factor`, as a new video (and, with `clip`, as a take of that clip).
   * "finish": the whole video brought to its final quality by an upscale route, as a new video and, with
   * `clip`, as a take of that clip marked as the finished version of `finishedFrom`.
   */
  action: "copy" | "split" | "remove" | "slow" | "finish";
  crf?: number;
  factor?: 2 | 4;
  /** How the frames in between are made: RIFE on the GPU through ComfyUI, or ffmpeg on the processor. */
  engine?: "rife" | "ffmpeg";
  clip?: string;
  /** "finish": the route, how much larger, SeedVR2's colour match, the pixel route's model. */
  route?: "seedvr" | "rtx" | "model";
  by?: number;
  colour?: string;
  upscaleModel?: string;
  /** "finish" with SeedVR2: frames restored together, 0 = by the frame's size. */
  seedvrFrames?: number;
  /** "finish": the start of the video that is never seen (a continuation's hidden run-up, hiddenRunUp): enlarged plainly, not restored. */
  hiddenMs?: number;
  finishedFrom?: string;
  /** The timeline it is cut in, without a clip: its folder is where the new videos land (folderForMade). */
  timeline?: string;
}

/** The recipe id of a job that exports a timeline instead of rendering something. */
export const EXPORT_JOB = "afflatus.export";
export interface ExportOptions {
  timeline: string;
  /** Enlarge every frame at the end: 1 (as rendered), 1.5 or 2. */
  scale: number;
  music: boolean;
  /** Smooth motion: 48 pictures a second, worked out by ffmpeg from the pictures there are. */
  smooth?: boolean;
  /** Only this part of the timeline, on its clock: a range copied to the library. Without the music. */
  range?: { inMs: number; outMs: number };
  /** Crossfade a clip that extends the one before over the frames they share (on unless said otherwise). */
  blend?: boolean;
  /** Nudge each clip's brightness and tint to the clip before at the join (on unless said otherwise). */
  match?: boolean;
  /** "largest": the frame of the largest take (the finished ones), the timeline's shape kept; else the timeline's own frame. */
  fit?: "timeline" | "largest";
}

export interface ClipPatch {
  recipe?: string;
  inputs?: Record<string, unknown>;
  joined?: ClipRow["joined"];
  take?: string;
  trimStartMs?: number;
  trimEndMs?: number;
  /**
   * Trimmed to what is to be seen, in its video's own time (as its take's `startMs` and `endMs` say): the moment it is to
   * start being seen, the moment it is to stop. Worked out here into trims (see trimsOf), whatever the joins move.
   */
  shownFromMs?: number;
  shownToMs?: number;
  /** Move it: after this clip, or first when null. */
  after?: string | null;
  sound?: ClipRow["sound"];
  /** The sound file heard instead of the clip's own sound. */
  soundAsset?: string | null;
  volume?: number;
  fill?: boolean;
  /** Of a still: how long it is held. */
  stillMs?: number;
  /** Of a still: make it a clip to render, opening on the picture. */
  animate?: boolean;
  /** Its own cast, places and style; null = the timeline's again. */
  look?: Look | null;
  /** The conversation with the designer about this clip: kept as it is. */
  chat?: unknown[];
  designer?: { llm?: string; instruction?: string } | null;
}
export interface TimelinePatch {
  name?: string;
  width?: number | null;
  height?: number | null;
  music?: { asset?: string | null; volume?: number; fadeInMs?: number; fadeOutMs?: number; duck?: boolean };
  /** Who is in the video and how it looks: used by every clip that has no cast of its own. */
  look?: Look | null;
  /** The look and mood of the whole video, in words. */
  mood?: string;
  /** The project it belongs to (null: the Inbox), and the folder its renders land in (null: the project's root). */
  project?: string | null;
  folder?: string | null;
}

/** A library video's place on a timeline: see Timelines.clipOf. */
export interface ClipOf {
  timeline: string;
  timelineName: string;
  clip: number;
  take: number;
  takes: number;
  playing: boolean;
  /** Of a take that is the finished version of another: how many times bigger (1 when the same size); null for the others. */
  upscaledBy: number | null;
}

export class Timelines {
  /** Cuts and ranges, what the videos give, the export, Undo and Redo: the model's heavier work, each in its own module. */
  readonly range: TimelineRange;
  readonly media: TimelineMedia;
  readonly exporter: TimelineExport;
  readonly history: TimelineHistory;
  /** Takes placed on their clips (a job done, a tool's video), and what a clip is made from (a new clip's form, a job's neighbours). */
  readonly takes: TimelineTakes;
  readonly planner: TimelinePlan;
  /** The parts of a timeline's view besides its clips: its takes' records, its jobs, its header. */
  private readonly views: TimelineViews;

  constructor(
    private readonly db: Db,
    private readonly storage: Storage,
    private readonly registry: Registry,
    private readonly events: EventEmitter,
  ) {
    // the door the modules reach the model through (timelineModel.ts); a frame of a video is the media module's, reached the same way
    const core: TimelineCore = {
      db, storage, registry, events,
      row: (id) => this.row(id), clipRow: (id) => this.clipRow(id), assetRow: (id) => this.assetRow(id), placed: (id) => this.placed(id),
      remember: (id, label, added) => this.remember(id, label, added), touch: (id) => this.touch(id), keep: (id, db) => this.keep(id, db), renumber: (id, order, db) => this.renumber(id, order, db),
      settingsOf, frame: (video, atMs, once, timeline) => this.media.frame(video, atMs, once, timeline),
    };
    this.range = new TimelineRange(core);
    this.media = new TimelineMedia(core);
    this.exporter = new TimelineExport(core);
    this.takes = new TimelineTakes(core);
    this.planner = new TimelinePlan(core, this.takes, this.media);
    this.history = new TimelineHistory(db, (id) => this.row(id), () => this.changed());
    this.views = new TimelineViews(db);
  }

  /** Keep what the timeline looks like now, before a change (see TimelineHistory.remember). */
  private remember(timelineId: string, label: string, added?: string): Promise<number> {
    return this.history.remember(timelineId, label, added);
  }

  private changed(): void {
    this.events.emit("timeline");
  }

  /** The last step each timeline remembered for a clip's form being changed: more changes soon after are the same step. */
  private readonly writing = new Map<string, { clip: string; seq: number; at: number }>();

  // ---------------------------------------------------------------- reading

  private async row(id: string) {
    const t = await this.db.selectFrom("timelines").selectAll().where("id", "=", id).executeTakeFirst();
    if (!t) throw notFound("this timeline");
    return t;
  }

  private async clipRow(id: string) {
    const c = await this.db.selectFrom("clips").selectAll().where("id", "=", id).executeTakeFirst();
    if (!c) throw notFound("this clip");
    return c;
  }

  private async assetRow(id: string | null) {
    return id ? await this.db.selectFrom("assets").selectAll().where("id", "=", id).executeTakeFirst() : undefined;
  }

  /** The clips of a timeline in order, each with its takes (those whose video still exists). */
  private async placed(timelineId: string): Promise<Placed[]> {
    return (await this.placedOf([timelineId])).get(timelineId) ?? [];
  }

  /** The same for several timelines at once, by timeline: one query each for the clips, the takes and the files they show. */
  private async placedOf(timelineIds: string[]): Promise<Map<string, Placed[]>> {
    const out = new Map<string, Placed[]>(timelineIds.map((id) => [id, []]));
    if (!timelineIds.length) return out;
    const clips = await this.db.selectFrom("clips").selectAll().where("timeline_id", "in", timelineIds).orderBy("position").orderBy("created_at").execute();
    if (!clips.length) return out;
    const takes = await this.db.selectFrom("takes").selectAll().where("clip_id", "in", clips.map((c) => c.id)).orderBy("created_at").execute();
    const wanted = [
      ...takes.map((t) => t.asset_id),
      ...clips.flatMap((c) => [c.still_asset_id, c.sound_asset_id, ...this.pinned(c).map((p) => p.id)]).filter((x): x is string => Boolean(x)),
    ];
    const assets = wanted.length ? await this.db.selectFrom("assets").selectAll().where("id", "in", [...new Set(wanted)]).execute() : [];
    const byId = new Map(assets.map((a) => [a.id, a]));
    const takesOf = new Map<string, TakeRow[]>();
    for (const t of takes) takesOf.set(t.clip_id, [...(takesOf.get(t.clip_id) ?? []), t]);
    for (const clip of clips) {
      const own: Taken[] = (takesOf.get(clip.id) ?? []).filter((t) => byId.has(t.asset_id)).map((take) => ({ take, asset: byId.get(take.asset_id)! }));
      out.get(clip.timeline_id)!.push({
        clip, takes: own, active: own.find((t) => t.take.id === clip.take_id) ?? null,
        still: (clip.still_asset_id && byId.get(clip.still_asset_id)) || null,
        sound: (clip.sound_asset_id && byId.get(clip.sound_asset_id)) || null,
        pictures: this.pinned(clip).flatMap((p) => (byId.has(p.id) ? [{ input: p.input, role: p.role, asset: byId.get(p.id)! }] : [])),
      });
    }
    for (const placed of out.values()) markJoins(placed);
    return out;
  }

  /** The pictures pinned on a clip's form: the image inputs of its recipe that hold an item of the library. */
  private pinned(clip: ClipRow): Array<{ input: string; role: string; id: string }> {
    const recipe = clip.recipe_id ? this.registry.recipe(clip.recipe_id) : undefined;
    if (!recipe) return [];
    const inputs = JSON.parse(clip.inputs) as Record<string, unknown>;
    return (recipe.inputs as InputSpec[])
      .filter((i) => i.type === "image" && typeof inputs[i.id] === "string" && inputs[i.id] !== FROM_PREVIOUS)
      .map((i) => ({ input: i.id, role: (i as { role?: string }).role ?? "image", id: inputs[i.id] as string }));
  }

  /** Whether the clip at `i` still follows the one before it: "fresh", "stale", "cut" (it never did), or null (nothing to compare yet). */
  private joinState(all: Placed[], i: number): "fresh" | "stale" | "cut" | null {
    if (i === 0) return null;
    const a = all[i - 1]!;
    const b = all[i]!;
    if (b.clip.joined === "cut" || b.clip.kind === "still") return "cut";
    if (!b.active) return null;
    // after a picture: the clip follows it when it was made to open on that picture
    if (a.clip.kind === "still") return a.still && b.active.take.prev_take_id === stillRef(a.still.id) && b.active.take.trim_start_ms === 0 ? "fresh" : "stale";
    if (!a.active) return null;
    // a finished take stands for its draft: a clip rendered against the draft still follows it (links are copied to the finished take)
    return takeFollows(b.active.take, a.active) || takeLandsOn(a.active.take, b.active) ? "fresh" : "stale";
  }

  /**
   * Every timeline as the projects tree lists it, newest first: its clips, how long it plays, the size of its videos (its takes'
   * and its export, each once, none in the bin) and whether it has an export. A few queries for all of them.
   */
  async leaves() {
    const rows = await this.db.selectFrom("timelines").selectAll().where("owner_id", "=", OWNER).orderBy("updated_at", "desc").execute();
    const placed = await this.placedOf(rows.map((t) => t.id));
    const exports = rows.flatMap((t) => (t.export_asset_id ? [t.export_asset_id] : []));
    const live = new Map(exports.length ? (await this.db.selectFrom("assets").select(["id", "bytes"]).where("id", "in", exports).where("deleted_at", "is", null).execute()).map((a) => [a.id, Number(a.bytes)]) : []);
    return rows.map((t) => {
      const all = placed.get(t.id) ?? [];
      const sizes = new Map<string, number>();
      for (const p of all) for (const x of p.takes) if (!x.asset.deleted_at) sizes.set(x.asset.id, Number(x.asset.bytes));
      const exported = t.export_asset_id !== null && live.has(t.export_asset_id);
      if (exported) sizes.set(t.export_asset_id!, live.get(t.export_asset_id!)!);
      return {
        id: t.id, name: t.name, projectId: t.project_id, folderId: t.folder_id, clips: all.length, durationMs: all.reduce((sum, p) => sum + lengthOf(p), 0),
        bytes: [...sizes.values()].reduce((a, b) => a + b, 0), exported, updatedAt: t.updated_at,
      };
    });
  }

  /** `project`: only the timelines of that project; "none": the Inbox; left out: all. */
  async list(project?: string) {
    let q = this.db.selectFrom("timelines").selectAll().where("owner_id", "=", OWNER);
    if (project === "none") q = q.where("project_id", "is", null);
    else if (project) q = q.where("project_id", "=", project);
    const rows = await q.orderBy("updated_at", "desc").execute();
    const placed = await this.placedOf(rows.map((t) => t.id));
    const items = rows.map((t) => {
      const all = placed.get(t.id) ?? [];
      const first = all.find((p) => p.active || p.still);
      return {
        id: t.id, name: t.name, width: t.width, height: t.height, updatedAt: t.updated_at, clips: all.length, projectId: t.project_id, folderId: t.folder_id, folderChosen: Boolean(t.folder_chosen),
        durationMs: all.reduce((sum, p) => sum + lengthOf(p), 0),
        cover: first?.active?.asset.id ?? first?.still?.id ?? null,
        // a frame per clip (its playing take, or its picture), for the card's film strip
        strip: all.slice(0, 12).map((p) => p.active?.asset.id ?? p.still?.id ?? null),
        // clips with nothing to play yet, and joins that no longer follow on
        toRender: all.filter((p) => p.clip.kind !== "still" && !p.active).length,
        staleJoins: all.filter((_, i) => this.joinState(all, i) === "stale").length,
      };
    });
    return { items };
  }

  async view(id: string) {
    const t = await this.row(id);
    const all = await this.placed(id);
    const { live, last } = await this.views.jobsOf(all.map((p) => p.clip.id));
    const rendered = await this.views.renderedOf(all);
    const viewOf = (x: Taken) => takeView(x, x.asset.generation_id ? rendered.get(x.asset.generation_id) : undefined);
    let at = 0;
    const clips = all.map((p, i) => {
      const length = lengthOf(p);
      const job = live.get(p.clip.id);
      const ended = last.get(p.clip.id);
      const view = {
        id: p.clip.id, kind: p.clip.kind, joined: p.clip.joined, join: this.joinState(all, i), recipe: p.clip.recipe_id,
        inputs: JSON.parse(p.clip.inputs) as Record<string, unknown>,
        take: p.active ? viewOf(p.active) : null,
        takes: p.takes.map(viewOf),
        still: p.still ? assetView(p.still) : null,
        /** The pictures pinned on its form: first frame, last frame, keyframe. */
        pictures: p.pictures.map((x) => ({ input: x.input, role: x.role, asset: assetView(x.asset) })),
        sound: p.clip.sound, soundAsset: p.sound ? assetView(p.sound) : null, volume: p.clip.volume, fill: Boolean(p.clip.fill),
        /** Its own cast and style; null = the timeline's. */
        look: p.clip.look ? (JSON.parse(p.clip.look) as Look) : null,
        chat: p.clip.chat ? (JSON.parse(p.clip.chat) as unknown[]) : [],
        designer: p.clip.designer ? (JSON.parse(p.clip.designer) as { llm?: string; instruction?: string }) : null,
        /** Where it starts on the timeline, and how long it plays. */
        atMs: at, lengthMs: length,
        job: job ? { id: job.id, status: job.status } : null,
        /** Why the last render gave nothing, until another one is asked for. */
        failed: !job && ended?.status === "failed" ? ended.error : null,
      };
      at += length;
      return view;
    });
    return { ...(await this.views.headOf(t)), durationMs: at, clips };
  }

  // ---------------------------------------------------------------- editing

  async create(name: string | undefined, project?: string | null, folder?: string | null) {
    const id = newId();
    const at = now();
    // numbered within its project (or the Inbox): each is its own workspace
    const count = Number((await this.db.selectFrom("timelines").select((eb) => eb.fn.countAll().as("n")).where("project_id", project ? "=" : "is", project ?? null).executeTakeFirst())?.n ?? 0);
    await this.db
      .insertInto("timelines")
      .values({
        id, owner_id: OWNER, name: name?.trim() || `Timeline ${count + 1}`, width: null, height: null, project_id: project ?? null, folder_id: folder ?? null, folder_chosen: 0,
        music_asset_id: null, music_volume: 60, music_fade_in_ms: 1000, music_fade_out_ms: 3000, music_duck: 1, export_asset_id: null, look: null, mood: null,
        created_at: at, updated_at: at,
      })
      .execute();
    this.changed();
    return this.view(id);
  }

  async edit(id: string, patch: TimelinePatch) {
    const before = await this.row(id);
    if (patch.project && !(await this.db.selectFrom("projects").select("id").where("id", "=", patch.project).executeTakeFirst())) throw notFound("this project");
    // the frame is one thing: a width without a height (or the other way round) would be set to nothing at all
    if ((patch.width === undefined) !== (patch.height === undefined)) throw httpError("The width and the height go together: send both, or null for both to let the first clip rendered decide.");
    const m = patch.music;
    if (m?.asset) {
      const sound = await this.assetRow(m.asset);
      if (!sound || (sound.kind !== "audio" && !(sound.kind === "video" && sound.has_sound))) throw httpError("The music has to be an audio file, or a video with audio.");
    }
    await this.remember(
      id,
      patch.name !== undefined ? "the new name" : patch.width !== undefined ? "the new aspect ratio" : patch.look !== undefined ? "the change of characters" : patch.mood !== undefined ? "the look and mood" : patch.project !== undefined ? "the project" : patch.folder !== undefined ? "the folder" : m?.asset === null ? "the music removed" : m?.asset ? "the new music" : "the music's settings",
    );
    const within = (n: number, least: number, most: number) => Math.max(least, Math.min(most, Math.round(n)));
    // to another project without a folder said: a folder of the project it leaves gives way to the new one's root
    const project = patch.project !== undefined ? patch.project : before.project_id;
    const leftBehind = patch.folder === undefined && project !== before.project_id && before.folder_id
      && (await this.db.selectFrom("folders").select("project_id").where("id", "=", before.folder_id).executeTakeFirst())?.project_id !== project;
    const folder = patch.folder !== undefined ? { folder_id: patch.folder, folder_chosen: 1 } : leftBehind ? { folder_id: await rootFolderOf(this.db, project), folder_chosen: 0 } : {};
    const moved = project !== before.project_id || ("folder_id" in folder && folder.folder_id !== before.folder_id);
    await this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("timelines")
        .set({
          ...(patch.name !== undefined ? { name: patch.name.trim() || "Untitled" } : {}),
          ...(patch.project !== undefined ? { project_id: patch.project } : {}),
          ...folder,
          ...(patch.width !== undefined && patch.height !== undefined ? { width: patch.width, height: patch.height } : {}),
          ...(m?.asset !== undefined ? { music_asset_id: m.asset } : {}),
          ...(m?.volume !== undefined ? { music_volume: within(m.volume, 0, 100) } : {}),
          ...(m?.fadeInMs !== undefined ? { music_fade_in_ms: within(m.fadeInMs, 0, 20_000) } : {}),
          ...(m?.fadeOutMs !== undefined ? { music_fade_out_ms: within(m.fadeOutMs, 0, 20_000) } : {}),
          ...(m?.duck !== undefined ? { music_duck: m.duck ? 1 : 0 } : {}),
          ...(patch.look !== undefined ? { look: patch.look ? JSON.stringify(patch.look) : null } : {}),
          ...(patch.mood !== undefined ? { mood: patch.mood.trim() || null } : {}),
          updated_at: now(),
        })
        .where("id", "=", id)
        .execute();
      // what it made follows it to its new folder
      if (moved) await timelineMediaFollows(tx, id);
    });
    if (moved) this.events.emit("library");
    if (m?.asset) await this.keep(m.asset);
    this.changed();
    return this.view(id);
  }

  /** The timeline goes, with what Undo and Redo remembered of it; the videos of its takes stay in the library. */
  async remove(id: string) {
    await this.row(id);
    await this.db.transaction().execute(async (tx) => {
      // the clips, takes and undo history go with the row; the redo snapshots have no such tie to it
      await tx.deleteFrom("timeline_future").where("timeline_id", "=", id).execute();
      await tx.deleteFrom("timelines").where("id", "=", id).execute();
    });
    this.writing.delete(id);
    this.changed();
  }

  private async touch(timelineId: string) {
    await this.db.updateTable("timelines").set({ updated_at: now() }).where("id", "=", timelineId).execute();
    this.changed();
  }

  /** The video was rendered as a clip's take, as opposed to made in Create or brought in from the computer. */
  private async madeForATimeline(assetId: string): Promise<boolean> {
    const asset = await this.db.selectFrom("assets").select("generation_id").where("id", "=", assetId).executeTakeFirst();
    if (!asset?.generation_id) return false;
    return Boolean(await this.db.selectFrom("jobs").select("id").where("generation_id", "=", asset.generation_id).where("clip_id", "is not", null).executeTakeFirst());
  }

  /** Something on a timeline still plays or uses it: another take, a clip's sound or still, a timeline's music. */
  private async stillUsed(assetId: string): Promise<boolean> {
    if (await this.db.selectFrom("takes").select("id").where("asset_id", "=", assetId).executeTakeFirst()) return true;
    if (await this.db.selectFrom("clips").select("id").where((eb) => eb.or([eb("sound_asset_id", "=", assetId), eb("still_asset_id", "=", assetId)])).executeTakeFirst()) return true;
    return Boolean(await this.db.selectFrom("timelines").select("id").where("music_asset_id", "=", assetId).executeTakeFirst());
  }

  /** What is on a timeline is wanted: it never goes to the bin on its own. `db`: the transaction this is part of, when it is part of one. */
  private async keep(assetId: string, db: Db = this.db) {
    await db.updateTable("assets").set({ kept_at: now() }).where("id", "=", assetId).where("kept_at", "is", null).execute();
  }

  private async renumber(timelineId: string, order: string[], db: Db = this.db) {
    for (const [i, id] of order.entries()) await db.updateTable("clips").set({ position: i }).where("id", "=", id).where("timeline_id", "=", timelineId).execute();
  }

  /** Where a clip put after `after` goes (`self`, a clip that moves, left out): first for null, last when left out; a clip not on the timeline is refused. */
  private indexAfter(all: Placed[], after: string | null | undefined, self?: string): number {
    const others = all.filter((p) => p.clip.id !== self);
    if (after === undefined) return others.length;
    if (after === null) return 0;
    const at = others.findIndex((p) => p.clip.id === after);
    if (at < 0) throw notFound("the clip to put it after");
    return at + 1;
  }

  /**
   * A new clip: empty (to render), a video from the library (it plays as it is; one Afflatus made can be
   * rendered again), or a picture: held on screen as a still, or (`as: "clip"`) the opening picture of a
   * clip to render. It goes after `after`, or at the end. `stopAtMs`: the clip it goes after first stops being
   * seen there (a moment of its video, as its take's `startMs` and `endMs` say), in the same step: "Extend from this frame".
   */
  async addClip(timelineId: string, opts: { after?: string | null; asset?: string; recipe?: string; as?: "still" | "clip"; stopAtMs?: number }) {
    const t = await this.row(timelineId);
    const all = await this.placed(timelineId);
    const index = this.indexAfter(all, opts.after);
    const made = await this.planner.newClip(all, index, opts);
    const stopping = opts.stopAtMs !== undefined ? all[index - 1]?.active : undefined;
    const trims = stopping ? trimsOf(stopping, { shownToMs: opts.stopAtMs }) : null;
    await this.remember(timelineId, made.kind === "still" ? "the image added" : "the clip added");
    // the clip, its place among the others and its take land together, or not at all
    const id = await this.db.transaction().execute(async (tx) => {
      if (stopping && trims) await tx.updateTable("takes").set({ trim_end_ms: trims.end }).where("id", "=", stopping.take.id).execute();
      return this.planner.insertClip(timelineId, all, index, made, tx);
    });
    if (made.asset) await this.adoptFolder(t, made.asset, all);
    await this.touch(timelineId);
    return id;
  }

  /**
   * A video made of the material of one folder lands there: the timeline takes the folder of what is put
   * on it (a picture or video dropped on the track, a picture pinned on a clip), as long as its folder is
   * still the default (none, or the project's root), none was chosen for it and nothing was rendered on it yet.
   * Called once the step that puts the material there is remembered: Undo puts the folder back with it.
   */
  private async adoptFolder(t: TimelineRow, asset: AssetRow, all: Placed[]) {
    if (!asset.folder_id || asset.folder_id === t.folder_id || t.folder_chosen) return;
    if (all.some((p) => p.takes.some((x) => x.asset.generation_id))) return;
    const root = await rootFolderOf(this.db, t.project_id);
    if (t.folder_id === null || t.folder_id === root) await this.db.updateTable("timelines").set({ folder_id: asset.folder_id }).where("id", "=", t.id).execute();
  }

  /**
   * A change to a clip, checked whole before anything is kept or written: a refused change leaves no empty step, keeps
   * what Redo could do, and writes nothing. The clip and its take change together, or not at all.
   */
  async editClip(id: string, patch: ClipPatch) {
    const clip = await this.clipRow(id);
    const keys = Object.keys(patch).filter((k) => patch[k as keyof ClipPatch] !== undefined);
    if (keys.length && keys.every((k) => k === "chat" || k === "designer")) {
      // what was said to the designer, and with which language model, is not a change to the timeline: nothing to undo, nothing to redraw
      await this.db.updateTable("clips").set({
        ...(patch.chat !== undefined ? { chat: chatJson(patch.chat) } : {}),
        ...(patch.designer !== undefined ? { designer: patch.designer ? JSON.stringify(patch.designer) : null } : {}),
      }).where("id", "=", id).execute();
      return;
    }
    const all = await this.placed(clip.timeline_id);
    const checked = await this.checkClipPatch(clip, patch, all);
    if (keys.length === 1 && keys[0] === "inputs") await this.rememberWriting(clip, all);
    else if (keys.length) await this.remember(clip.timeline_id, labelOf(patch));

    const { animate, trims, order } = checked;
    await this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("clips")
        .set({
          ...(patch.recipe !== undefined ? { recipe_id: patch.recipe } : {}),
          ...(patch.inputs !== undefined ? { inputs: JSON.stringify(patch.inputs) } : {}),
          ...(patch.joined !== undefined ? { joined: patch.joined } : {}),
          ...(patch.take !== undefined ? { take_id: patch.take } : {}),
          ...(patch.soundAsset !== undefined ? { sound_asset_id: patch.soundAsset, sound: patch.sound ?? (patch.soundAsset ? "file" : "own") } : patch.sound !== undefined ? { sound: patch.sound } : {}),
          ...(patch.volume !== undefined ? { volume: Math.max(0, Math.min(100, Math.round(patch.volume))) } : {}),
          ...(patch.fill !== undefined ? { fill: patch.fill ? 1 : 0 } : {}),
          ...(patch.look !== undefined ? { look: patch.look ? JSON.stringify(patch.look) : null } : {}),
          ...(patch.stillMs !== undefined ? { still_ms: Math.max(STILL_MS.least, Math.min(STILL_MS.most, Math.round(patch.stillMs))) } : {}),
          ...(animate
            ? { kind: "video" as const, still_asset_id: null, recipe_id: animate.id, joined: "cut" as const, inputs: JSON.stringify({ [animate.inputs.find((i) => i.type === "image" && i.role === "start")!.id]: clip.still_asset_id }) }
            : {}),
          updated_at: now(),
        })
        .where("id", "=", id)
        .execute();
      if (trims) await tx.updateTable("takes").set({ trim_start_ms: trims.start, trim_end_ms: trims.end }).where("id", "=", trims.take).execute();
      if (order) await this.renumber(clip.timeline_id, order, tx);
      if (patch.soundAsset) await this.keep(patch.soundAsset, tx);
    });
    // a picture pinned on the clip: the timeline takes its folder, as a drop would (within the step just kept)
    if (checked.pinnedNow) {
      const picture = await this.assetRow(checked.pinnedNow);
      if (picture) await this.adoptFolder(await this.row(clip.timeline_id), picture, all);
    }
    await this.touch(clip.timeline_id);
  }

  /** A clip's form is saved as it is typed: everything written in one go is one step to undo, not one per save. */
  private async rememberWriting(clip: ClipRow, all: Placed[]) {
    const top = await this.db.selectFrom("timeline_history").select("seq").where("timeline_id", "=", clip.timeline_id).orderBy("seq", "desc").executeTakeFirst();
    const going = this.writing.get(clip.timeline_id);
    if (going && going.clip === clip.id && going.seq === top?.seq && Date.now() - going.at < 60_000) {
      going.at = Date.now();
      return;
    }
    const n = all.findIndex((p) => p.clip.id === clip.id) + 1;
    const seq = await this.remember(clip.timeline_id, `the parameters of clip ${n}`);
    this.writing.set(clip.timeline_id, { clip: clip.id, seq, at: Date.now() });
  }

  /** Everything a clip's change needs, worked out before any of it is written: refused here, nothing was. */
  private async checkClipPatch(clip: ClipRow, patch: ClipPatch, all: Placed[]) {
    const id = clip.id;
    if (patch.recipe !== undefined && !this.registry.recipe(patch.recipe)) throw httpError(`there is no model or operation called ${patch.recipe}`);
    if (patch.take !== undefined) {
      const take = await this.db.selectFrom("takes").select("id").where("id", "=", patch.take).where("clip_id", "=", id).executeTakeFirst();
      if (!take) throw notFound("this take");
    }
    if (patch.soundAsset) {
      const sound = await this.assetRow(patch.soundAsset);
      if (!sound || (sound.kind !== "audio" && !(sound.kind === "video" && sound.has_sound))) throw httpError("That is not an audio file, nor a video with audio.");
    }
    if (patch.sound === "file" && !(patch.soundAsset ?? clip.sound_asset_id)) throw httpError("Choose the audio file first.");
    if ((patch.stillMs !== undefined || patch.animate) && clip.kind !== "still") throw httpError("This clip is not a still image.");
    const animate = patch.animate ? recipeWithStart(this.registry, null) : undefined;
    if (patch.animate && !animate) throw httpError("None of your video models takes a first frame (i2v).");
    // the trims: worked out from what is seen when asked that way, never leaving less than a tenth of a second to play
    let trims: { take: string; start: number; end: number } | null = null;
    if ([patch.trimStartMs, patch.trimEndMs, patch.shownFromMs, patch.shownToMs].some((v) => v !== undefined)) {
      const takeId = patch.take ?? clip.take_id;
      const x = all.find((p) => p.clip.id === id)?.takes.find((t) => t.take.id === takeId);
      if (!takeId || !x) throw httpError("There is nothing to trim yet: this clip has no take.");
      trims = { take: takeId, ...trimsOf(x, patch) };
    }
    let order: string[] | null = null;
    if (patch.after !== undefined) {
      order = all.map((p) => p.clip.id).filter((x) => x !== id);
      order.splice(this.indexAfter(all, patch.after, id), 0, id);
    }
    // the picture newly pinned on its form, if any
    const recipe = patch.inputs ? this.registry.recipe(patch.recipe ?? clip.recipe_id ?? "") : undefined;
    const was = JSON.parse(clip.inputs) as Record<string, unknown>;
    const pinned = recipe ? (recipe.inputs as InputSpec[]).find((i) => i.type === "image" && typeof patch.inputs![i.id] === "string" && patch.inputs![i.id] !== was[i.id]) : undefined;
    return { animate, trims, order, pinnedNow: pinned ? (patch.inputs![pinned.id] as string) : null };
  }

  async removeClip(id: string) {
    const clip = await this.clipRow(id);
    await this.remember(clip.timeline_id, clip.kind === "still" ? "the image removed" : "the clip removed");
    await this.db.deleteFrom("clips").where("id", "=", id).execute();
    await this.renumber(clip.timeline_id, (await this.placed(clip.timeline_id)).map((p) => p.clip.id));
    await this.touch(clip.timeline_id);
  }

  /**
   * A take goes, and the video that was rendered for it goes to the bin with it (it comes back with
   * Undo, or from the bin for a week). A video that was brought in from the library stays there, and so
   * does one that something else still uses. The newest of the other takes plays instead.
   */
  async removeTake(id: string) {
    const take = await this.db.selectFrom("takes").selectAll().where("id", "=", id).executeTakeFirst();
    if (!take) throw notFound("this take");
    const clip = await this.clipRow(take.clip_id);
    await this.remember(clip.timeline_id, "the take removed");
    await this.db.deleteFrom("takes").where("id", "=", id).execute();
    if ((await this.madeForATimeline(take.asset_id)) && !(await this.stillUsed(take.asset_id))) {
      await this.db.updateTable("assets").set({ deleted_at: now() }).where("id", "=", take.asset_id).where("deleted_at", "is", null).execute();
      this.events.emit("library");
    }
    if (clip.take_id === id) {
      const left = await this.db.selectFrom("takes").select("id").where("clip_id", "=", clip.id).orderBy("created_at", "desc").executeTakeFirst();
      await this.db.updateTable("clips").set({ take_id: left?.id ?? null }).where("id", "=", clip.id).execute();
    }
    await this.touch(clip.timeline_id);
  }

  // ---------------------------------------------------------------- for the queue

  /** Just before a clip's job is sent: its inputs with its neighbours filled in (TimelinePlan.plan). */
  plan(...args: Parameters<TimelinePlan["plan"]>): Promise<ClipPlan> { return this.planner.plan(...args); }
  /** A clip's job is done: its video becomes a take, and plays (TimelineTakes.finished). */
  finished(...args: Parameters<TimelineTakes["finished"]>): Promise<void> { return this.takes.finished(...args); }

  /**
   * Which timeline clip each of these videos is a take of, for the library: the timeline, the clip's number,
   * the take's number among the clip's takes, whether it is the one playing, and how much bigger it is than
   * the take it is the finished version of (null for a take that is not one).
   */
  async clipOf(assetIds: string[]): Promise<Map<string, ClipOf>> {
    const out = new Map<string, ClipOf>();
    if (!assetIds.length) return out;
    const takes = await this.db.selectFrom("takes").selectAll().where("asset_id", "in", assetIds).execute();
    if (!takes.length) return out;
    const clipIds = [...new Set(takes.map((t) => t.clip_id))];
    const clips = await this.db.selectFrom("clips").select(["id", "timeline_id", "take_id"]).where("id", "in", clipIds).execute();
    const timelineIds = [...new Set(clips.map((c) => c.timeline_id))];
    const [timelines, placed, siblings] = await Promise.all([
      this.db.selectFrom("timelines").select(["id", "name"]).where("id", "in", timelineIds).execute(),
      this.db.selectFrom("clips").select(["id", "timeline_id"]).where("timeline_id", "in", timelineIds).orderBy("position").orderBy("created_at").execute(),
      this.db.selectFrom("takes").select(["id", "clip_id", "asset_id", "finished_from"]).where("clip_id", "in", clipIds).orderBy("created_at").execute(),
    ]);
    const nameOf = new Map(timelines.map((t) => [t.id, t.name]));
    const widths = new Map(
      (await this.db.selectFrom("assets").select(["id", "width"]).where("id", "in", [...new Set(siblings.map((s) => s.asset_id))]).execute()).map((a) => [a.id, a.width]),
    );
    for (const take of takes) {
      const clip = clips.find((c) => c.id === take.clip_id);
      if (!clip) continue;
      const own = siblings.filter((s) => s.clip_id === clip.id);
      const draft = take.finished_from ? own.find((s) => s.id === take.finished_from) : undefined;
      const by = draft && widths.get(draft.asset_id) && widths.get(take.asset_id) ? Math.round((widths.get(take.asset_id)! / widths.get(draft.asset_id)!) * 10) / 10 : null;
      out.set(take.asset_id, {
        timeline: clip.timeline_id, timelineName: nameOf.get(clip.timeline_id) ?? "Timeline",
        clip: placed.filter((p) => p.timeline_id === clip.timeline_id).findIndex((p) => p.id === clip.id) + 1,
        take: own.findIndex((s) => s.id === take.id) + 1, takes: own.length,
        playing: clip.take_id === take.id,
        upscaledBy: take.finished_from ? by ?? 1 : null,
      });
    }
    return out;
  }

  /** What a take was rendered with, to render it again the same: its form and its seed. Null for a video that was not rendered here. */
  async generationOf(assetId: string): Promise<{ recipe: string; inputs: Record<string, unknown>; seed: number } | null> {
    const asset = await this.db.selectFrom("assets").select("generation_id").where("id", "=", assetId).executeTakeFirst();
    if (!asset?.generation_id) return null;
    const g = await this.db.selectFrom("generations").select(["recipe_id", "inputs", "resolved"]).where("id", "=", asset.generation_id).executeTakeFirst();
    if (!g) return null;
    const seed = (JSON.parse(g.resolved) as { seed?: number }).seed;
    return typeof seed === "number" ? { recipe: g.recipe_id, inputs: JSON.parse(g.inputs) as Record<string, unknown>, seed } : null;
  }

  /** The name of a video finished by an upscale route, after the video it was made from. */
  finishName(video: AssetRow, route: string, by: number): string {
    const base = (video.name || "video").replace(/\.[a-z0-9]+$/i, "").replace(/ · finished ×[\d.]+ \([^)]*\)$/, "");
    const how = route === "seedvr" ? "SeedVR2" : route === "rtx" ? "RTX VSR" : "upscale model";
    return `${base} · finished ×${by} (${how})`;
  }

  /**
   * Forget what was worked out of a video, because the file behind it changed (a linked folder's file written
   * again): its film strips, motion, scene cuts and colour along it in storage, and the join scores and colour means
   * of the takes that play it. They are made again when next looked at. To be called while the row still says how
   * long the old file was, so that the trim bar's strip of it is found.
   */
  async forgetDerived(assetId: string): Promise<void> {
    const asset = await this.db.selectFrom("assets").select(["id", "duration_ms"]).where("id", "=", assetId).executeTakeFirst();
    for (const key of derivedKeys(asset ?? { id: assetId, duration_ms: null })) await this.storage.delete(key).catch(() => {});
    const takes = (await this.db.selectFrom("takes").select("id").where("asset_id", "=", assetId).execute()).map((t) => t.id);
    this.media.forget(assetId, takes);
  }

  /** A clip's timeline as it is on screen, and the clip's place in it. */
  async whereIs(clipId: string) {
    const clip = await this.clipRow(clipId);
    const view = await this.view(clip.timeline_id);
    return { view, index: view.clips.findIndex((c) => c.id === clipId) };
  }
}

/** What a change to a clip is, in a few words, for the Undo button. */
function labelOf(patch: ClipPatch): string {
  return patch.after !== undefined ? "the clip moved"
    : patch.take !== undefined ? "the other take"
    : [patch.trimStartMs, patch.trimEndMs, patch.shownFromMs, patch.shownToMs, patch.stillMs].some((v) => v !== undefined) ? "the new duration"
    : patch.joined !== undefined ? (patch.joined === "cut" ? "the cut" : "the join")
    : patch.animate ? "the image animated (i2v)"
    : patch.sound !== undefined || patch.soundAsset !== undefined || patch.volume !== undefined ? "the audio change"
    : patch.fill !== undefined ? "the fit in the frame"
    : patch.look !== undefined ? "the change of characters"
    : "the change of model";
}
