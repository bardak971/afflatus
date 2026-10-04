import { chatJson } from "./designer";
import { createHash } from "node:crypto";
import type { EventEmitter } from "node:events";
import { secondsInput, type Recipe, type InputSpec } from "@afflatus/core";
import { BLEND_MS, CutError, type ExportMusic, type ExportPart, filmStrip, frameAt, frozenTailAt, joinJump, joinVideos, measureOf, MOTION_RATE, peekAt, rangeKeep, slowMotion } from "./cut";
import { newId, now, OWNER, type Db, type Tables } from "./db";
import { rootFolderOf } from "./projects";
import type { Look } from "./entities";
import { assetView, extOf, pngSize } from "./media";
import type { Registry } from "./registry";
import type { Storage } from "./storage";
import { makeThumb, thumbKey } from "./thumbs";
import { readVideo } from "./video";

/**
 * Timelines: clips played one after the other. A clip is a place on the timeline with a form (what to
 * render there); each render of it is a take, and one take plays. A clip can carry on from the clip
 * before it: the take then remembers which take it carried on from, so that when that one changes the
 * join is known to be stale. A clip can also be a picture held on screen (a still). Nothing here knows
 * which model a clip is made with: it reads the recipe's inputs (a clip to carry on from, a clip to
 * arrive at, an opening picture) and fills them in.
 */

type TimelineRow = Tables["timelines"];
type ClipRow = Tables["clips"];
type TakeRow = Tables["takes"];
type AssetRow = Tables["assets"];

const missing = (what: string) => Object.assign(new Error(`${what} was not found`), { statusCode: 404 });
const refused = (why: string) => Object.assign(new Error(why), { statusCode: 400 });

/** Two moments are the same when they are within about a frame of each other. */
const near = (a: number | null, b: number) => a !== null && Math.abs(a - b) <= 45;

/**
 * What stands for the opening picture of a clip that picks up from the last frame of the clip before it,
 * until that frame exists (the clip before may still be rendering when the job is queued).
 */
export const FROM_PREVIOUS = "the-clip-before";

/** The recipe id of a job that exports a timeline instead of rendering something. */
/** "0:04", "0:04.5": a moment, for a cut's name (tenths only when they matter). */
const clockOf = (ms: number) => {
  const tenths = Math.max(0, Math.round(ms / 100));
  const sec = Math.floor(tenths / 10);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}${tenths % 10 ? `.${tenths % 10}` : ""}`;
};

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
  finishedFrom?: string;
}

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

/** How many changes Undo can go back. */
const HISTORY = 40;
const STILL_MS = { least: 500, most: 60_000 };

/** What a clip's job needs to know about its neighbours, worked out just before it is sent. */
export interface ClipPlan {
  input: Record<string, unknown>;
  canvas?: { width: number; height: number };
  /** What it was made from besides its own inputs, for the lineage. */
  sources: Array<{ asset: string; role: string }>;
  links: TakeLinks;
}
export interface TakeLinks {
  prev?: { take: string; at: number };
  next?: { take: string; at: number };
}

interface Placed {
  clip: ClipRow;
  takes: Array<{ take: TakeRow; asset: AssetRow }>;
  active: { take: TakeRow; asset: AssetRow } | null;
  /** Of a still: its picture. Of a clip with a sound file: that file. */
  still: AssetRow | null;
  sound: AssetRow | null;
  /** The pictures pinned on the clip's form: its first frame, last frame, keyframe (the input's id, and the picture). */
  pictures: Array<{ input: string; role: string; asset: AssetRow }>;
}

/** How a clip regenerated in a range meets its neighbours: with their video as context, on a frame, or nothing there. */
export interface RangeContext {
  start: "clip" | "frame" | "none";
  end: "clip" | "frame" | "none";
}

/** A clip that plays, on the timeline's clock: where it starts and how long. */
interface Laid {
  p: Placed;
  /** Its place among all the clips, the ones with nothing to play included. */
  index: number;
  atMs: number;
  lengthMs: number;
}

/** The part of a take that plays, in its video's own time. */
const plays = (t: { take: TakeRow; asset: AssetRow }) => {
  const start = t.take.head_ms + t.take.trim_start_ms;
  const end = Math.max(start, (t.asset.duration_ms ?? 0) - t.take.tail_ms - t.take.trim_end_ms);
  return { start, end };
};
/** How long a clip plays: its take's playing part, a still's time on screen, nothing when there is nothing to show. */
const lengthOf = (p: Placed) => (p.clip.kind === "still" ? (p.still ? p.clip.still_ms : 0) : p.active ? plays(p.active).end - plays(p.active).start : 0);
/** What a take that opens on a still says it carried on from. */
const stillRef = (assetId: string) => `still:${assetId}`;

export interface ClipPatch {
  recipe?: string;
  inputs?: Record<string, unknown>;
  joined?: ClipRow["joined"];
  take?: string;
  trimStartMs?: number;
  trimEndMs?: number;
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
  constructor(
    private readonly db: Db,
    private readonly storage: Storage,
    private readonly registry: Registry,
    private readonly events: EventEmitter,
  ) {}

  private changed(): void {
    this.events.emit("timeline");
  }

  /** The last step each timeline remembered for a clip's form being changed: more changes soon after are the same step. */
  private readonly writing = new Map<string, { clip: string; seq: number; at: number }>();

  // ---------------------------------------------------------------- reading

  private async row(id: string) {
    const t = await this.db.selectFrom("timelines").selectAll().where("id", "=", id).executeTakeFirst();
    if (!t) throw missing("this timeline");
    return t;
  }

  private async clipRow(id: string) {
    const c = await this.db.selectFrom("clips").selectAll().where("id", "=", id).executeTakeFirst();
    if (!c) throw missing("this clip");
    return c;
  }

  private async assetRow(id: string | null) {
    return id ? await this.db.selectFrom("assets").selectAll().where("id", "=", id).executeTakeFirst() : undefined;
  }

  /** The clips of a timeline in order, each with its takes (those whose video still exists). */
  private async placed(timelineId: string): Promise<Placed[]> {
    const clips = await this.db.selectFrom("clips").selectAll().where("timeline_id", "=", timelineId).orderBy("position").orderBy("created_at").execute();
    if (!clips.length) return [];
    const takes = await this.db.selectFrom("takes").selectAll().where("clip_id", "in", clips.map((c) => c.id)).orderBy("created_at").execute();
    // the pictures pinned on each clip's form: the image inputs of its recipe that hold an item of the library
    const pinned = (clip: ClipRow): Array<{ input: string; role: string; id: string }> => {
      const recipe = clip.recipe_id ? this.registry.recipe(clip.recipe_id) : undefined;
      if (!recipe) return [];
      const inputs = JSON.parse(clip.inputs) as Record<string, unknown>;
      return (recipe.inputs as InputSpec[])
        .filter((i) => i.type === "image" && typeof inputs[i.id] === "string" && inputs[i.id] !== FROM_PREVIOUS)
        .map((i) => ({ input: i.id, role: (i as { role?: string }).role ?? "image", id: inputs[i.id] as string }));
    };
    const wanted = [
      ...takes.map((t) => t.asset_id),
      ...clips.flatMap((c) => [c.still_asset_id, c.sound_asset_id, ...pinned(c).map((p) => p.id)]).filter((x): x is string => Boolean(x)),
    ];
    const assets = wanted.length ? await this.db.selectFrom("assets").selectAll().where("id", "in", [...new Set(wanted)]).execute() : [];
    const byId = new Map(assets.map((a) => [a.id, a]));
    return clips.map((clip) => {
      const own = takes.filter((t) => t.clip_id === clip.id && byId.has(t.asset_id)).map((take) => ({ take, asset: byId.get(take.asset_id)! }));
      return {
        clip, takes: own, active: own.find((t) => t.take.id === clip.take_id) ?? null,
        still: (clip.still_asset_id && byId.get(clip.still_asset_id)) || null,
        sound: (clip.sound_asset_id && byId.get(clip.sound_asset_id)) || null,
        pictures: pinned(clip).flatMap((p) => (byId.has(p.id) ? [{ input: p.input, role: p.role, asset: byId.get(p.id)! }] : [])),
      };
    });
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
    const same = (id: string | null, t: TakeRow) => id !== null && (id === t.id || id === t.finished_from);
    const followed = same(b.active.take.prev_take_id, a.active.take) && near(b.active.take.prev_at_ms, plays(a.active).end) && b.active.take.trim_start_ms === 0;
    const landed = same(a.active.take.next_take_id, b.active.take) && near(a.active.take.next_at_ms, plays(b.active).start) && a.active.take.trim_end_ms === 0;
    return followed || landed ? "fresh" : "stale";
  }

  /** `project`: only the timelines of that project; "none": the Inbox; left out: all. */
  async list(project?: string) {
    let q = this.db.selectFrom("timelines").selectAll().where("owner_id", "=", OWNER);
    if (project === "none") q = q.where("project_id", "is", null);
    else if (project) q = q.where("project_id", "=", project);
    const rows = await q.orderBy("updated_at", "desc").execute();
    const items = [];
    for (const t of rows) {
      const all = await this.placed(t.id);
      const first = all.find((p) => p.active || p.still);
      items.push({
        id: t.id, name: t.name, width: t.width, height: t.height, updatedAt: t.updated_at, clips: all.length, projectId: t.project_id, folderId: t.folder_id, folderChosen: Boolean(t.folder_chosen),
        durationMs: all.reduce((sum, p) => sum + lengthOf(p), 0),
        cover: first?.active?.asset.id ?? first?.still?.id ?? null,
      });
    }
    return { items };
  }

  async view(id: string) {
    const t = await this.row(id);
    const all = await this.placed(id);
    const jobs = all.length
      ? await this.db.selectFrom("jobs").select(["id", "clip_id", "status", "error", "finished_at"]).where("clip_id", "in", all.map((p) => p.clip.id)).orderBy("created_at").execute()
      : [];
    // how long each take's render took, from the record of renders (a finish made by a cut has none)
    const made = [...new Set(all.flatMap((p) => p.takes.map((x) => x.asset.generation_id)).filter((g): g is string => Boolean(g)))];
    const tookMs = new Map(
      (made.length ? await this.db.selectFrom("generations").select(["id", "gen_ms"]).where("id", "in", made).execute() : []).map((g) => [g.id, g.gen_ms]),
    );
    const takeView = (x: { take: TakeRow; asset: AssetRow }) => ({
      id: x.take.id, asset: assetView(x.asset), headMs: x.take.head_ms, tailMs: x.take.tail_ms,
      trimStartMs: x.take.trim_start_ms, trimEndMs: x.take.trim_end_ms, startMs: plays(x).start, endMs: plays(x).end, createdAt: x.take.created_at,
      finishedFrom: x.take.finished_from,
      /** How its start joins the clip before: in the latent (the clip before's own tokens continued), or pinned frames; null when it does not continue a clip. */
      joinKind: x.take.join_kind ?? null,
      /** How long its render took, when it was rendered here and measured; null otherwise. */
      renderMs: (x.asset.generation_id && tookMs.get(x.asset.generation_id)) || null,
    });
    let at = 0;
    const clips = all.map((p, i) => {
      const length = lengthOf(p);
      const mine = jobs.filter((j) => j.clip_id === p.clip.id);
      const live = mine.find((j) => j.status === "queued" || j.status === "running");
      const last = mine.at(-1);
      const view = {
        id: p.clip.id, kind: p.clip.kind, joined: p.clip.joined, join: this.joinState(all, i), recipe: p.clip.recipe_id,
        inputs: JSON.parse(p.clip.inputs) as Record<string, unknown>,
        take: p.active ? takeView(p.active) : null,
        takes: p.takes.map(takeView),
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
        job: live ? { id: live.id, status: live.status } : null,
        /** Why the last render gave nothing, until another one is asked for. */
        failed: !live && last?.status === "failed" ? last.error : null,
      };
      at += length;
      return view;
    });
    const music = await this.assetRow(t.music_asset_id);
    const undo = await this.db.selectFrom("timeline_history").select("label").where("timeline_id", "=", id).orderBy("seq", "desc").executeTakeFirst();
    const redo = await this.db.selectFrom("timeline_future").select("label").where("timeline_id", "=", id).orderBy("seq", "desc").executeTakeFirst();
    const exports = (await this.db.selectFrom("jobs").select(["id", "status", "inputs", "error"]).where("recipe_id", "=", EXPORT_JOB).orderBy("created_at", "desc").limit(30).execute())
      .filter((j) => (JSON.parse(j.inputs) as ExportOptions).timeline === id);
    const exporting = exports.find((j) => j.status === "queued" || j.status === "running");
    const exported = await this.assetRow(t.export_asset_id);
    return {
      id: t.id, name: t.name, width: t.width, height: t.height, updatedAt: t.updated_at, durationMs: at, clips,
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
      exportFailed: !exporting && exports[0]?.status === "failed" ? exports[0].error : null,
    };
  }

  // ---------------------------------------------------------------- undo

  /** What the timeline looks like now, as one piece: the row, its clips, their takes. */
  private async stateOf(timelineId: string) {
    const timeline = await this.row(timelineId);
    const clips = await this.db.selectFrom("clips").selectAll().where("timeline_id", "=", timelineId).execute();
    const takes = clips.length ? await this.db.selectFrom("takes").selectAll().where("clip_id", "in", clips.map((c) => c.id)).execute() : [];
    return { timeline, clips, takes };
  }

  /** Keep the state in the history (before a change) or in the future (before an undo), with its label. */
  private async snapshot(where: "timeline_history" | "timeline_future", timelineId: string, label: string) {
    const state = JSON.stringify(await this.stateOf(timelineId));
    const row = { id: newId(), timeline_id: timelineId, label, snapshot: state, created_at: now() };
    if (where === "timeline_history") {
      const last = await this.db.selectFrom("timeline_history").select("seq").where("timeline_id", "=", timelineId).orderBy("seq", "desc").executeTakeFirst();
      const seq = (last?.seq ?? 0) + 1;
      await this.db.insertInto("timeline_history").values({ ...row, seq }).execute();
      await this.db.deleteFrom("timeline_history").where("timeline_id", "=", timelineId).where("seq", "<=", seq - HISTORY).execute();
      return seq;
    }
    const last = await this.db.selectFrom("timeline_future").select("seq").where("timeline_id", "=", timelineId).orderBy("seq", "desc").executeTakeFirst();
    const seq = (last?.seq ?? 0) + 1;
    await this.db.insertInto("timeline_future").values({ ...row, seq }).execute();
    await this.db.deleteFrom("timeline_future").where("timeline_id", "=", timelineId).where("seq", "<=", seq - HISTORY).execute();
    return seq;
  }

  /** Keep what the timeline looks like now, before a change. `label` says what the change is, for the Undo button. A change forgets what could be redone. */
  private async remember(timelineId: string, label: string) {
    const seq = await this.snapshot("timeline_history", timelineId, label);
    await this.db.deleteFrom("timeline_future").where("timeline_id", "=", timelineId).execute();
    return seq;
  }

  /**
   * Put a kept state back. What was rendered since is not lost: a take made after that state stays on its
   * clip, and stays the one that plays if it was.
   */
  private async restore(timelineId: string, was: { timeline: TimelineRow; clips: ClipRow[]; takes: TakeRow[] }) {
    const nowClips = await this.db.selectFrom("clips").selectAll().where("timeline_id", "=", timelineId).execute();
    const nowTakes = nowClips.length ? await this.db.selectFrom("takes").selectAll().where("clip_id", "in", nowClips.map((c) => c.id)).execute() : [];
    const known = new Set(was.takes.map((t) => t.id));
    const back = new Set(was.clips.map((c) => c.id));
    const newer = nowTakes.filter((t) => !known.has(t.id) && back.has(t.clip_id));
    const takes = [...was.takes, ...newer];
    const present = takes.length ? new Set((await this.db.selectFrom("assets").select("id").where("id", "in", takes.map((t) => t.asset_id)).execute()).map((a) => a.id)) : new Set<string>();
    const kept = takes.filter((t) => present.has(t.asset_id));
    await this.db.transaction().execute(async (tx) => {
      await tx.deleteFrom("clips").where("timeline_id", "=", timelineId).execute();
      for (const c of was.clips) {
        // a take made since the change keeps playing
        const current = nowClips.find((x) => x.id === c.id)?.take_id;
        const playing = current && newer.some((t) => t.id === current) ? current : c.take_id;
        await tx.insertInto("clips").values({ ...c, take_id: playing && kept.some((t) => t.id === playing) ? playing : null }).execute();
      }
      for (const t of kept) await tx.insertInto("takes").values(t).execute();
      const w = was.timeline;
      await tx
        .updateTable("timelines")
        .set({
          name: w.name, width: w.width, height: w.height, music_asset_id: w.music_asset_id, music_volume: w.music_volume,
          music_fade_in_ms: w.music_fade_in_ms, music_fade_out_ms: w.music_fade_out_ms, music_duck: w.music_duck, look: w.look ?? null, mood: w.mood ?? null, updated_at: now(),
        })
        .where("id", "=", timelineId)
        .execute();
      // a take that is back has its video back: removing it had sent the video to the bin
      if (kept.length) await tx.updateTable("assets").set({ deleted_at: null }).where("id", "in", kept.map((t) => t.asset_id)).where("deleted_at", "is not", null).execute();
    });
    this.changed();
  }

  /** Take the last change back. What it took back can be done again, until the next change. */
  async undo(timelineId: string): Promise<string> {
    const last = await this.db.selectFrom("timeline_history").selectAll().where("timeline_id", "=", timelineId).orderBy("seq", "desc").executeTakeFirst();
    if (!last) throw refused("There is nothing to undo.");
    await this.snapshot("timeline_future", timelineId, last.label);
    await this.restore(timelineId, JSON.parse(last.snapshot) as { timeline: TimelineRow; clips: ClipRow[]; takes: TakeRow[] });
    await this.db.deleteFrom("timeline_history").where("id", "=", last.id).execute();
    return last.label;
  }

  /** Do again what Undo took back. */
  async redo(timelineId: string): Promise<string> {
    const next = await this.db.selectFrom("timeline_future").selectAll().where("timeline_id", "=", timelineId).orderBy("seq", "desc").executeTakeFirst();
    if (!next) throw refused("There is nothing to redo.");
    await this.snapshot("timeline_history", timelineId, next.label);
    await this.restore(timelineId, JSON.parse(next.snapshot) as { timeline: TimelineRow; clips: ClipRow[]; takes: TakeRow[] });
    await this.db.deleteFrom("timeline_future").where("id", "=", next.id).execute();
    return next.label;
  }

  // ---------------------------------------------------------------- editing

  async create(name: string | undefined, project?: string | null, folder?: string | null) {
    const id = newId();
    const at = now();
    const count = Number((await this.db.selectFrom("timelines").select((eb) => eb.fn.countAll().as("n")).executeTakeFirst())?.n ?? 0);
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
    await this.row(id);
    const m = patch.music;
    if (m?.asset) {
      const sound = await this.assetRow(m.asset);
      if (!sound || (sound.kind !== "audio" && !(sound.kind === "video" && sound.has_sound))) throw refused("The music has to be an audio file, or a video with audio.");
    }
    await this.remember(
      id,
      patch.name !== undefined ? "the new name" : patch.width !== undefined ? "the new aspect ratio" : patch.look !== undefined ? "the change of characters" : patch.mood !== undefined ? "the look and mood" : patch.project !== undefined ? "the project" : patch.folder !== undefined ? "the folder" : m?.asset === null ? "the music removed" : m?.asset ? "the new music" : "the music's settings",
    );
    const within = (n: number, least: number, most: number) => Math.max(least, Math.min(most, Math.round(n)));
    await this.db
      .updateTable("timelines")
      .set({
        ...(patch.name !== undefined ? { name: patch.name.trim() || "Untitled" } : {}),
        ...(patch.project !== undefined ? { project_id: patch.project } : {}),
        ...(patch.folder !== undefined ? { folder_id: patch.folder, folder_chosen: 1 } : {}),
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
    if (m?.asset) await this.keep(m.asset);
    this.changed();
    return this.view(id);
  }

  /** The timeline goes; the videos of its takes stay in the library. */
  async remove(id: string) {
    await this.row(id);
    await this.db.deleteFrom("timelines").where("id", "=", id).execute();
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

  /** What is on a timeline is wanted: it never goes to the bin on its own. */
  private async keep(assetId: string) {
    await this.db.updateTable("assets").set({ kept_at: now() }).where("id", "=", assetId).where("kept_at", "is", null).execute();
  }

  private async renumber(timelineId: string, order: string[]) {
    for (const [i, id] of order.entries()) await this.db.updateTable("clips").set({ position: i }).where("id", "=", id).where("timeline_id", "=", timelineId).execute();
  }

  /**
   * A new clip: empty (to render), a video from the library (it plays as it is; one Afflatus made can be
   * rendered again), or a picture: held on screen as a still, or (`as: "clip"`) the opening picture of a
   * clip to render. It goes after `after`, or at the end.
   */
  async addClip(timelineId: string, opts: { after?: string | null; asset?: string; recipe?: string; as?: "still" | "clip" }) {
    const t = await this.row(timelineId);
    const all = await this.placed(timelineId);
    const index = opts.after === null ? 0 : opts.after ? all.findIndex((p) => p.clip.id === opts.after) + 1 : all.length;
    const id = newId();
    const at = now();

    // a new clip is made the way the last rendered clip before it was
    const lastRecipe = all.slice(0, index).reverse().find((p) => p.clip.recipe_id)?.clip.recipe_id ?? null;
    let recipeId = opts.recipe ?? lastRecipe;
    let inputs: Record<string, unknown> = {};
    let joined: ClipRow["joined"] = "continue";
    let kind: ClipRow["kind"] = "video";
    let still: string | null = null;
    let take: { asset: AssetRow; head: number; tail: number } | null = null;

    const asset = await this.assetRow(opts.asset ?? null);
    if (opts.asset && !asset) throw missing("this item");
    const made = asset?.generation_id ? await this.db.selectFrom("generations").selectAll().where("id", "=", asset.generation_id).executeTakeFirst() : undefined;

    if (asset?.kind === "video") {
      // what it was made with comes along, so that another take can be made of it
      const recipe = made ? this.registry.recipe(made.recipe_id) : undefined;
      if (made && recipe) {
        recipeId = recipe.id;
        inputs = this.ownInputs(recipe, JSON.parse(made.inputs) as Record<string, unknown>);
      } else recipeId = null;
      const overlap = made ? (JSON.parse(made.resolved) as { overlap?: { headMs: number; tailMs: number; latent?: boolean } }).overlap : undefined;
      take = { asset, head: overlap?.headMs ?? 0, tail: overlap?.tailMs ?? 0 };
      // a video brought in starts on its own: it was not made to follow what is before it
      joined = "cut";
    } else if (asset?.kind === "image" && opts.as === "clip") {
      const recipe = this.recipeWithStart(recipeId);
      if (!recipe) throw refused("None of your video models takes a first frame (i2v).");
      recipeId = recipe.id;
      inputs = { ...this.settingsOf(recipe, all, index), [recipe.inputs.find((i) => i.type === "image" && i.role === "start")!.id]: asset.id };
      joined = "cut";
    } else if (asset?.kind === "image") {
      kind = "still";
      still = asset.id;
      recipeId = null;
      joined = "cut";
    } else if (asset) {
      throw refused("Only videos and images go on the video track. Audio goes on a clip, or on the music track.");
    } else {
      const recipe = recipeId ? this.registry.recipe(recipeId) : undefined;
      if (recipe) inputs = this.settingsOf(recipe, all, index);
    }

    await this.remember(timelineId, kind === "still" ? "the image added" : "the clip added");
    await this.db
      .insertInto("clips")
      .values({
        id, timeline_id: timelineId, position: index, take_id: null, joined, recipe_id: recipeId, inputs: JSON.stringify(inputs),
        kind, still_asset_id: still, still_ms: 3000, sound: "own", sound_asset_id: null, volume: 100, fill: 0, look: null, chat: null, created_at: at, updated_at: at,
      })
      .execute();
    const order = all.map((p) => p.clip.id);
    order.splice(index, 0, id);
    await this.renumber(timelineId, order);
    if (take) await this.addTake(id, take.asset, { headMs: take.head, tailMs: take.tail }, {});
    if (still) await this.keep(still);
    if (asset) await this.adoptFolder(t, asset, all);
    await this.touch(timelineId);
    return id;
  }

  /**
   * A video made of the material of one folder lands there: the timeline takes the folder of what is put
   * on it (a picture or video dropped on the track, a picture pinned on a clip), as long as its folder is
   * still the default (none, or the project's root), none was chosen for it and nothing was rendered on it yet.
   */
  private async adoptFolder(t: TimelineRow, asset: AssetRow, all: Placed[]) {
    if (!asset.folder_id || asset.folder_id === t.folder_id || t.folder_chosen) return;
    if (all.some((p) => p.takes.some((x) => x.asset.generation_id))) return;
    const root = await rootFolderOf(this.db, t.project_id);
    if (t.folder_id === null || t.folder_id === root) await this.db.updateTable("timelines").set({ folder_id: asset.folder_id }).where("id", "=", t.id).execute();
  }

  /** A recipe's inputs without the ones a timeline fills in itself. */
  private ownInputs(recipe: Recipe<any>, input: Record<string, unknown>): Record<string, unknown> {
    const ids = new Set(recipe.inputs.filter((i) => i.type !== "clip").map((i) => i.id));
    return Object.fromEntries(Object.entries(input).filter(([id]) => ids.has(id)));
  }

  /** What a new clip takes over from the nearest clip before it made with the same recipe: its settings, not its story or its pictures. */
  private settingsOf(recipe: Recipe<any>, all: Placed[], index: number): Record<string, unknown> {
    const before = all.slice(0, index).reverse().find((p) => p.clip.recipe_id === recipe.id);
    if (!before) return {};
    const keep = new Set(recipe.inputs.filter((i) => !["prompt", "image", "clip", "seed"].includes(i.type)).map((i) => i.id));
    return Object.fromEntries(Object.entries(JSON.parse(before.clip.inputs) as Record<string, unknown>).filter(([id]) => keep.has(id)));
  }

  private recipeWithStart(preferred: string | null): Recipe<any> | undefined {
    const opens = (r: Recipe<any> | undefined) => r?.output === "video" && r.inputs.some((i) => i.type === "image" && i.role === "start");
    const own = preferred ? this.registry.recipe(preferred) : undefined;
    return opens(own) ? own : this.registry.recipes().find(opens);
  }

  async editClip(id: string, patch: ClipPatch) {
    const clip = await this.clipRow(id);
    if (patch.recipe !== undefined && !this.registry.recipe(patch.recipe)) throw refused(`there is no model or operation called ${patch.recipe}`);
    if (patch.take !== undefined) {
      const take = await this.db.selectFrom("takes").select("id").where("id", "=", patch.take).where("clip_id", "=", id).executeTakeFirst();
      if (!take) throw missing("this take");
    }
    if (patch.soundAsset) {
      const sound = await this.assetRow(patch.soundAsset);
      if (!sound || (sound.kind !== "audio" && !(sound.kind === "video" && sound.has_sound))) throw refused("That is not an audio file, nor a video with audio.");
    }
    if (patch.sound === "file" && !(patch.soundAsset ?? clip.sound_asset_id)) throw refused("Choose the audio file first.");
    if ((patch.stillMs !== undefined || patch.animate) && clip.kind !== "still") throw refused("This clip is not a still image.");

    const keys = Object.keys(patch).filter((k) => patch[k as keyof ClipPatch] !== undefined);
    if (keys.length && keys.every((k) => k === "chat" || k === "designer")) {
      // what was said to the designer, and with which language model, is not a change to the timeline: nothing to undo, nothing to redraw
      await this.db.updateTable("clips").set({
        ...(patch.chat !== undefined ? { chat: chatJson(patch.chat) } : {}),
        ...(patch.designer !== undefined ? { designer: patch.designer ? JSON.stringify(patch.designer) : null } : {}),
      }).where("id", "=", id).execute();
      return;
    }
    if (keys.length === 1 && keys[0] === "inputs") {
      // a clip's form is saved as it is typed: everything written in one go is one step to undo, not one per save
      const top = await this.db.selectFrom("timeline_history").select("seq").where("timeline_id", "=", clip.timeline_id).orderBy("seq", "desc").executeTakeFirst();
      const going = this.writing.get(clip.timeline_id);
      if (!(going && going.clip === id && going.seq === top?.seq && Date.now() - going.at < 60_000)) {
        const n = (await this.db.selectFrom("clips").select("id").where("timeline_id", "=", clip.timeline_id).orderBy("position").execute()).findIndex((c) => c.id === id) + 1;
        const seq = await this.remember(clip.timeline_id, `the parameters of clip ${n}`);
        this.writing.set(clip.timeline_id, { clip: id, seq, at: Date.now() });
      } else going.at = Date.now();
    } else if (keys.length) {
      await this.remember(
        clip.timeline_id,
        patch.after !== undefined ? "the clip moved"
          : patch.take !== undefined ? "the other take"
          : patch.trimStartMs !== undefined || patch.trimEndMs !== undefined || patch.stillMs !== undefined ? "the new duration"
          : patch.joined !== undefined ? (patch.joined === "cut" ? "the cut" : "the join")
          : patch.animate ? "the image animated (i2v)"
          : patch.sound !== undefined || patch.soundAsset !== undefined || patch.volume !== undefined ? "the audio change"
          : patch.fill !== undefined ? "the fit in the frame"
          : patch.look !== undefined ? "the change of characters"
          : "the change of model",
      );
    }

    const animate = patch.animate ? this.recipeWithStart(null) : undefined;
    if (patch.animate && !animate) throw refused("None of your video models takes a first frame (i2v).");
    await this.db
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
    if (patch.soundAsset) await this.keep(patch.soundAsset);
    // a picture pinned on the clip: the timeline takes its folder, as a drop would
    if (patch.inputs) {
      const recipe = this.registry.recipe(patch.recipe ?? clip.recipe_id ?? "");
      const was = JSON.parse(clip.inputs) as Record<string, unknown>;
      const pinnedNow = recipe ? (recipe.inputs as InputSpec[]).filter((i) => i.type === "image" && typeof patch.inputs![i.id] === "string" && patch.inputs![i.id] !== was[i.id]).map((i) => patch.inputs![i.id] as string) : [];
      if (pinnedNow.length) {
        const t = await this.row(clip.timeline_id);
        const picture = await this.assetRow(pinnedNow[0]!);
        if (picture) await this.adoptFolder(t, picture, await this.placed(clip.timeline_id));
      }
    }
    if (patch.trimStartMs !== undefined || patch.trimEndMs !== undefined) {
      const takeId = patch.take ?? clip.take_id;
      if (!takeId) throw refused("There is nothing to trim yet: this clip has no take.");
      await this.db
        .updateTable("takes")
        .set({
          ...(patch.trimStartMs !== undefined ? { trim_start_ms: Math.max(0, Math.round(patch.trimStartMs)) } : {}),
          ...(patch.trimEndMs !== undefined ? { trim_end_ms: Math.max(0, Math.round(patch.trimEndMs)) } : {}),
        })
        .where("id", "=", takeId)
        .execute();
    }
    if (patch.after !== undefined) {
      const order = (await this.placed(clip.timeline_id)).map((p) => p.clip.id).filter((x) => x !== id);
      const index = patch.after === null ? 0 : order.indexOf(patch.after) + 1;
      order.splice(index, 0, id);
      await this.renumber(clip.timeline_id, order);
    }
    await this.touch(clip.timeline_id);
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
    if (!take) throw missing("this take");
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

  private async addTake(clipId: string, asset: AssetRow, overlap: { headMs: number; tailMs: number; latent?: boolean }, links: TakeLinks, finishedFrom: string | null = null) {
    const id = newId();
    // the finished version of a take keeps that take's overlaps and trims: it plays the same part, larger
    const from = finishedFrom ? await this.db.selectFrom("takes").selectAll().where("id", "=", finishedFrom).executeTakeFirst() : undefined;
    await this.db
      .insertInto("takes")
      .values({
        id, clip_id: clipId, asset_id: asset.id, head_ms: from?.head_ms ?? overlap.headMs, tail_ms: from?.tail_ms ?? overlap.tailMs, trim_start_ms: from?.trim_start_ms ?? 0, trim_end_ms: from?.trim_end_ms ?? 0,
        join_kind: from ? from.join_kind : overlap.headMs > 0 ? (overlap.latent ? "latent" : "pixels") : null,
        prev_take_id: links.prev?.take ?? from?.prev_take_id ?? null, prev_at_ms: links.prev?.at ?? from?.prev_at_ms ?? null, next_take_id: links.next?.take ?? from?.next_take_id ?? null, next_at_ms: links.next?.at ?? from?.next_at_ms ?? null,
        finished_from: from ? from.id : null, created_at: now(),
      })
      .execute();
    const clip = await this.db.updateTable("clips").set({ take_id: id, updated_at: now() }).where("id", "=", clipId).returning("timeline_id").executeTakeFirst();
    await this.keep(asset.id);
    // the first video of a timeline decides its frame
    if (clip && asset.width && asset.height) {
      await this.db.updateTable("timelines").set({ width: asset.width, height: asset.height }).where("id", "=", clip.timeline_id).where("width", "is", null).execute();
    }
    return id;
  }

  // ---------------------------------------------------------------- for the queue

  /**
   * Just before a clip's job is sent: its inputs with its neighbours filled in. A clip that carries on
   * from the one before is given that clip's video and the moment it stops playing (after a still: the
   * picture, to open on); a take made to fit is given the next clip's video and the moment it starts playing.
   */
  async plan(clipId: string, recipe: Recipe<any>, raw: Record<string, unknown>, fit: boolean): Promise<ClipPlan> {
    const clip = await this.clipRow(clipId);
    const t = await this.row(clip.timeline_id);
    const all = await this.placed(clip.timeline_id);
    const i = all.findIndex((p) => p.clip.id === clipId);
    const prevSpec = recipe.inputs.find((s) => s.type === "clip" && s.role === "previous");
    const nextSpec = recipe.inputs.find((s) => s.type === "clip" && s.role === "next");
    const startSpec = recipe.inputs.find((s) => s.type === "image" && s.role === "start");
    const plan: ClipPlan = { input: this.ownInputs(recipe, raw), sources: [], links: {} };
    if (t.width && t.height) plan.canvas = { width: t.width, height: t.height };

    const prior = i > 0 ? all[i - 1]! : null;
    const before = prior?.active ?? null;
    if (clip.joined === "continue" && prior?.clip.kind === "still" && prior.still && startSpec) {
      plan.input[startSpec.id] = prior.still.id;
      plan.links.prev = { take: stillRef(prior.still.id), at: 0 };
    } else if (clip.joined === "continue" && before) {
      let at = plays(before).end;
      if (prevSpec) {
        // the clip before ends frozen: hand over where it still moved, unless the form says not to
        if (raw.handover !== false) {
          const lively = await this.handoverAt(before).catch(() => null);
          if (lively !== null && lively < at - 40) at = lively;
        }
        plan.input[prevSpec.id] = { asset: before.asset.id, at };
        plan.links.prev = { take: before.take.id, at };
      } else if (startSpec && recipe.traits?.continues === "frame") {
        // a recipe that opens on a picture picks up from the last frame that plays
        plan.input[startSpec.id] = (await this.frame(before.asset, Math.max(0, at - 40), true)).id;
        plan.sources.push({ asset: before.asset.id, role: "previous" });
        plan.links.prev = { take: before.take.id, at };
      }
    }
    if (startSpec && plan.input[startSpec.id] === FROM_PREVIOUS) {
      throw refused("This clip extends the previous clip from its last frame, and that clip has no take yet.");
    }
    const after = i < all.length - 1 ? all[i + 1]! : null;
    if (fit && nextSpec && after?.active && after.clip.joined === "continue") {
      const at = plays(after.active).start;
      plan.input[nextSpec.id] = { asset: after.active.asset.id, at };
      plan.links.next = { take: after.active.take.id, at };
    }
    return plan;
  }

  /** The moment the clip before should hand over: before its frozen tail when it has one, else null. */
  private async handoverAt(before: { take: TakeRow; asset: AssetRow }): Promise<number | null> {
    const { rate, values } = await this.motion(before.asset.id);
    const { start, end } = plays(before);
    return frozenTailAt(values, rate, start, end);
  }

  /** A clip's job is done: its video becomes a take, and plays. The first take of a timeline decides its frame. */
  async finished(clipId: string, generationId: string, overlap: { headMs: number; tailMs: number; latent?: boolean } | undefined, links: TakeLinks, finishedFrom: string | null = null): Promise<void> {
    const clip = await this.db.selectFrom("clips").selectAll().where("id", "=", clipId).executeTakeFirst();
    // the clip was removed while it rendered: the video is in the library all the same
    if (!clip) return;
    const asset = await this.db.selectFrom("assets").selectAll().where("generation_id", "=", generationId).where("kind", "=", "video").executeTakeFirst();
    if (!asset) return;
    if (finishedFrom) await this.remember(clip.timeline_id, "the finished take");
    await this.addTake(clipId, asset, overlap ?? { headMs: 0, tailMs: 0 }, links, finishedFrom);
    // the take carried on from before the clip before's frozen tail: that clip now stops where the take picks up
    if (links.prev && !finishedFrom) {
      const prev = await this.db.selectFrom("takes").innerJoin("assets", "assets.id", "takes.asset_id").select(["takes.id as id", "takes.tail_ms as tail_ms", "takes.trim_end_ms as trim_end_ms", "assets.duration_ms as duration_ms"]).where("takes.id", "=", links.prev.take).executeTakeFirst();
      if (prev?.duration_ms) {
        const end = prev.duration_ms - prev.tail_ms - prev.trim_end_ms;
        if (links.prev.at < end - 40) {
          await this.remember(clip.timeline_id, "the hand-over before the frozen tail");
          await this.db.updateTable("takes").set({ trim_end_ms: prev.duration_ms - prev.tail_ms - links.prev.at }).where("id", "=", prev.id).execute();
        }
      }
    }
    await this.touch(clip.timeline_id);
  }

  /** What a take was rendered with, to render it again the same: its form and its seed. Null for a video that was not rendered here. */
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
   * One frame of a video as a picture in the library. `once`: the same frame asked for again is the same
   * picture (a clip rendered several times from the same last frame does not fill the library with copies).
   */
  async frame(video: AssetRow, atMs: number, once = false): Promise<AssetRow> {
    const id = once ? createHash("sha1").update(`frame:${video.id}:${Math.round(atMs)}`).digest("hex").slice(0, 32) : newId();
    const have = once ? await this.db.selectFrom("assets").selectAll().where("id", "=", id).executeTakeFirst() : undefined;
    if (have) {
      if (have.deleted_at) await this.db.updateTable("assets").set({ deleted_at: null }).where("id", "=", id).execute();
      return have;
    }
    const bytes = await frameAt(await this.storage.get(video.file_key), extOf(video.mime), atMs, video.duration_ms ?? undefined);
    const key = `assets/${id.slice(0, 2)}/${id}.png`;
    await this.storage.put(key, bytes);
    const thumb = await makeThumb(bytes);
    if (thumb) await this.storage.put(thumbKey(id), thumb);
    const size = pngSize(bytes);
    const at = now();
    await this.db
      .insertInto("assets")
      .values({
        id, owner_id: OWNER, kind: "image", origin: "frame", name: video.name ? `${video.name}, a frame` : "", file_key: key,
        thumb_key: thumb ? thumbKey(id) : null, mime: "image/png", bytes: bytes.length, width: size?.width ?? video.width, height: size?.height ?? video.height,
        duration_ms: null, fps: null, has_sound: 0, folder_id: video.folder_id, generation_id: null, source_id: video.id, kept_at: at, deleted_at: null, created_at: at,
      })
      .execute();
    this.events.emit("library");
    return this.db.selectFrom("assets").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
  }

  /** Frames of a video side by side in one picture, for the timeline (and, at a size asked for, the trim bar). Made once per video and size, then kept. */
  async strip(assetId: string, opts: { frames?: number; height?: number; fromMs?: number; toMs?: number } = {}): Promise<Uint8Array> {
    const video = await this.assetRow(assetId);
    if (!video || video.kind !== "video") throw missing("this video");
    const windowed = opts.fromMs !== undefined || opts.toMs !== undefined;
    const sized = opts.frames || opts.height;
    const key = sized ? `strips/${video.id.slice(0, 2)}/${video.id}-${opts.frames ?? 0}x${opts.height ?? 0}.jpg` : `strips/${video.id.slice(0, 2)}/${video.id}.jpg`;
    const have = windowed ? null : await this.storage.get(key).catch(() => null);
    if (have) return have;
    const bytes = await this.storage.get(video.file_key);
    const length = video.duration_ms ?? (await readVideo(bytes, extOf(video.mime))).facts?.durationMs;
    if (!length) throw new CutError("This video could not be read.");
    const strip = await filmStrip(bytes, extOf(video.mime), length, opts);
    // a strip of a part is asked for while zooming: made each time, not kept
    if (!windowed) await this.storage.put(key, strip);
    return strip;
  }

  /** How much moves along a video and how loud it is, ten samples a second (see measureOf). Measured once, then kept. A sound file gives loudness only. */
  async motion(assetId: string): Promise<{ rate: number; values: number[]; sound: number[] | null }> {
    const asset = await this.assetRow(assetId);
    if (!asset || (asset.kind !== "video" && asset.kind !== "audio")) throw missing("this video");
    const key = `motion/${asset.id.slice(0, 2)}/${asset.id}.json`;
    const have = await this.storage.get(key).catch(() => null);
    if (have) {
      const kept = JSON.parse(Buffer.from(have).toString("utf8")) as { rate: number; values: number[]; sound?: number[] | null };
      if (kept.sound !== undefined) return { rate: kept.rate, values: kept.values, sound: kept.sound };
    }
    const { motion, sound } = await measureOf(await this.storage.get(asset.file_key), extOf(asset.mime));
    const made = { rate: MOTION_RATE, values: motion.map((v) => Math.round(v * 10) / 10), sound };
    await this.storage.put(key, new TextEncoder().encode(JSON.stringify(made)));
    return made;
  }

  /** The jump across a join, per take, kept once worked out (a take and its neighbours' frames do not change). */
  private joinScores = new Map<string, { in: number | null; out: number | null }>();

  /**
   * How smoothly each take of a clip meets its neighbours: at In, the clip before's last frame against
   * the take's first frame that plays; at Out, the take's last frame against the clip after's first.
   * ×1 = the join moves like the clip itself, higher = a catch. For picking among takes.
   */
  async joins(clipId: string): Promise<Array<{ take: string; in: number | null; out: number | null }>> {
    const clip = await this.clipRow(clipId);
    const all = await this.placed(clip.timeline_id);
    const i = all.findIndex((p) => p.clip.id === clipId);
    const me = all[i]!;
    const edge = (p: Placed | undefined, side: "end" | "start") => {
      if (!p) return null;
      if (p.clip.kind === "still") return p.still ? { asset: p.still, atMs: 0, key: `still:${p.still.id}` } : null;
      if (!p.active) return null;
      const { start, end } = plays(p.active);
      return { asset: p.active.asset, atMs: side === "end" ? Math.max(start, end - 20) : start, key: `${p.active.take.id}:${side === "end" ? end : start}` };
    };
    const prev = edge(all[i - 1], "end");
    const next = edge(all[i + 1], "start");
    if (!prev && !next) return me.takes.map((t) => ({ take: t.take.id, in: null, out: null }));
    const bytes = new Map<string, Uint8Array>();
    const load = async (a: AssetRow) => {
      const have = bytes.get(a.id);
      if (have) return have;
      const got = await this.storage.get(a.file_key);
      bytes.set(a.id, got);
      return got;
    };
    const out: Array<{ take: string; in: number | null; out: number | null }> = [];
    for (const t of me.takes) {
      const { start, end } = plays(t);
      const key = `${t.take.id}:${start}:${end}:${prev?.key ?? "-"}:${next?.key ?? "-"}`;
      let score = this.joinScores.get(key);
      if (!score) {
        const fps = t.asset.fps ?? 24;
        score = {
          in: prev ? await joinJump({ bytes: await load(prev.asset), ext: extOf(prev.asset.mime), atMs: prev.atMs }, { bytes: await load(t.asset), ext: extOf(t.asset.mime), atMs: start, fps }) : null,
          out: next ? await joinJump({ bytes: await load(t.asset), ext: extOf(t.asset.mime), atMs: Math.max(start, end - 20) }, { bytes: await load(next.asset), ext: extOf(next.asset.mime), atMs: next.atMs, fps: next.asset.fps ?? fps }) : null,
        };
        this.joinScores.set(key, score);
      }
      out.push({ take: t.take.id, ...score });
    }
    return out;
  }

  /** One small picture of a moment of a video, for a hover over the trim bar. Not kept. */
  async peek(assetId: string, atMs: number, height?: number): Promise<Uint8Array> {
    const video = await this.assetRow(assetId);
    if (!video || video.kind !== "video") throw missing("this video");
    return peekAt(await this.storage.get(video.file_key), extOf(video.mime), atMs, height);
  }

  /**
   * A range of a video, kept as new videos of the library: `copy` = the range as one video (the source
   * stays); `split` = before, range, after as three (the source goes to the bin); `remove` = one video
   * without the range (the source goes to the bin). Each new video remembers its source and its range.
   */
  async cutRange(video: AssetRow, startMs: number, endMs: number, action: "copy" | "split" | "remove", opts: { crf?: number; signal?: AbortSignal } = {}): Promise<AssetRow[]> {
    const bytes = await this.storage.get(video.file_key);
    const ext = extOf(video.mime);
    const read = video.duration_ms && video.fps ? null : await readVideo(bytes, ext);
    const total = video.duration_ms ?? read?.facts?.durationMs ?? 0;
    if (!total) throw new CutError("This video could not be read.");
    const a = Math.max(0, Math.min(startMs, endMs));
    const b = Math.min(total, Math.max(startMs, endMs));
    if (b - a < 20) throw new CutError("That range is too short: pick at least one frame.");
    if (a <= 0 && b >= total - 2) throw new CutError("That is the whole video: there is nothing to cut.");
    const facts = { durationMs: total, hasSound: Boolean(video.has_sound) };
    const pieces: Array<{ keep: Array<[number, number]>; said: string; range: string }> =
      action === "copy" ? [{ keep: [[a, b]], said: `${clockOf(a)}–${clockOf(b)}`, range: `${a}-${b}` }]
      : action === "remove" ? [{ keep: [[0, a], [b, total]], said: `without ${clockOf(a)}–${clockOf(b)}`, range: `${a}-${b}` }]
      : [
        ...(a >= 20 ? [{ keep: [[0, a]] as Array<[number, number]>, said: `${clockOf(0)}–${clockOf(a)}`, range: `0-${a}` }] : []),
        { keep: [[a, b]], said: `${clockOf(a)}–${clockOf(b)}`, range: `${a}-${b}` },
        ...(total - b >= 20 ? [{ keep: [[b, total]] as Array<[number, number]>, said: `${clockOf(b)}–${clockOf(total)}`, range: `${b}-${total}` }] : []),
      ];
    const made: AssetRow[] = [];
    for (const piece of pieces) {
      const out = await rangeKeep(bytes, ext, facts, piece.keep, opts);
      const seen = await readVideo(out, "mp4");
      const id = newId();
      const key = `assets/${id.slice(0, 2)}/${id}.mp4`;
      await this.storage.put(key, out);
      const thumb = seen.frame ? await makeThumb(seen.frame) : null;
      if (thumb) await this.storage.put(thumbKey(id), thumb);
      const at = now();
      const base = (video.name || "video").replace(/\.[a-z0-9]+$/i, "");
      await this.db
        .insertInto("assets")
        .values({
          id, owner_id: OWNER, kind: "video", origin: "cut", name: `${base} · ${piece.said}`, file_key: key,
          thumb_key: thumb ? thumbKey(id) : null, mime: "video/mp4", bytes: out.length,
          width: seen.facts?.width ?? video.width, height: seen.facts?.height ?? video.height,
          duration_ms: seen.facts?.durationMs ?? null, fps: seen.facts?.fps ?? video.fps, has_sound: seen.facts?.hasSound ? 1 : 0,
          folder_id: video.folder_id, generation_id: null, source_id: video.id, source_range: piece.range, kept_at: at, deleted_at: null, created_at: at,
        })
        .execute();
      made.push(await this.db.selectFrom("assets").selectAll().where("id", "=", id).executeTakeFirstOrThrow());
    }
    // the source goes to the bin when it was taken apart: a day to change one's mind
    if (action !== "copy") await this.db.updateTable("assets").set({ deleted_at: now() }).where("id", "=", video.id).execute();
    this.events.emit("library");
    return made;
  }

  /** A clip's take that plays, with its video and where the clip stands. */
  /** A clip's timeline as it is on screen, and the clip's place in it. */
  async whereIs(clipId: string) {
    const clip = await this.clipRow(clipId);
    const view = await this.view(clip.timeline_id);
    return { view, index: view.clips.findIndex((c) => c.id === clipId) };
  }

  async takeOf(clipId: string): Promise<{ clip: ClipRow; take: TakeRow; asset: AssetRow; index: number; timelineId: string }> {
    const clip = await this.clipRow(clipId);
    const all = await this.placed(clip.timeline_id);
    const p = all.find((x) => x.clip.id === clipId);
    if (!p?.active) throw refused("This clip has no take yet: render it first.");
    return { clip, take: p.active.take, asset: p.active.asset, index: all.indexOf(p), timelineId: clip.timeline_id };
  }

  /**
   * One clip becomes two at a moment of its take (in the video's own time): the first plays up to it,
   * the second from it on, both from the same video; the second takes the clip's model, form, sound and
   * look along, and starts as a cut. Undo takes it back.
   */
  async splitClip(clipId: string, atMs: number): Promise<string> {
    const { take, asset, index, timelineId } = await this.takeOf(clipId);
    const { start, end } = plays({ take, asset });
    if (atMs < start + 40 || atMs > end - 40) throw refused("Put the playhead inside the part that plays, at least a frame from its ends.");
    await this.remember(timelineId, "the split");
    const p = (await this.placed(timelineId))[index]!;
    const id = await this.splitAt(timelineId, p, atMs - start);
    await this.touch(timelineId);
    return id;
  }

  /** A copy of the clip right after it: the same form, look and sound, its takes again (the same videos), the same one playing. It starts as a cut. */
  async duplicateClip(clipId: string): Promise<string> {
    const clip = await this.clipRow(clipId);
    const all = await this.placed(clip.timeline_id);
    const index = all.findIndex((p) => p.clip.id === clipId);
    const takes = await this.db.selectFrom("takes").selectAll().where("clip_id", "=", clipId).orderBy("created_at").execute();
    await this.remember(clip.timeline_id, "the duplicate");
    const id = newId();
    const at = now();
    const ids = new Map(takes.map((t) => [t.id, newId()]));
    await this.db
      .insertInto("clips")
      .values({ ...clip, id, position: index + 1, take_id: clip.take_id ? ids.get(clip.take_id) ?? null : null, joined: "cut", chat: null, created_at: at, updated_at: at })
      .execute();
    for (const t of takes) await this.db.insertInto("takes").values({ ...t, id: ids.get(t.id)!, clip_id: id, prev_take_id: null, prev_at_ms: null, next_take_id: null, next_at_ms: null, created_at: at }).execute();
    const order = all.map((p) => p.clip.id);
    order.splice(index + 1, 0, id);
    await this.renumber(clip.timeline_id, order);
    await this.touch(clip.timeline_id);
    return id;
  }

  /**
   * The split itself: `localMs` after the moment the clip starts playing. A still becomes two stills.
   * The second clip takes the first's model, form, sound and look, and starts as a cut.
   */
  private async splitAt(timelineId: string, p: Placed, localMs: number): Promise<string> {
    const all = await this.placed(timelineId);
    const index = all.findIndex((x) => x.clip.id === p.clip.id);
    const clip = p.clip;
    const id = newId();
    const at = now();
    const still = clip.kind === "still";
    await this.db
      .insertInto("clips")
      .values({
        id, timeline_id: timelineId, position: index + 1, take_id: null, joined: "cut", recipe_id: still ? null : clip.recipe_id, inputs: still ? "{}" : clip.inputs,
        kind: clip.kind, still_asset_id: still ? clip.still_asset_id : null, still_ms: still ? Math.max(STILL_MS.least, Math.round(clip.still_ms - localMs)) : 3000,
        sound: clip.sound, sound_asset_id: clip.sound_asset_id, volume: clip.volume, fill: clip.fill, look: clip.look, chat: null, created_at: at, updated_at: at,
      })
      .execute();
    const order = all.map((x) => x.clip.id);
    order.splice(index + 1, 0, id);
    await this.renumber(timelineId, order);
    if (still) {
      await this.db.updateTable("clips").set({ still_ms: Math.max(STILL_MS.least, Math.round(localMs)), updated_at: at }).where("id", "=", clip.id).execute();
      return id;
    }
    const { take, asset } = p.active!;
    const atMs = plays(p.active!).start + localMs;
    // the second half: the same video, trimmed to start where the first stops
    const second = newId();
    await this.db
      .insertInto("takes")
      .values({
        id: second, clip_id: id, asset_id: asset.id, head_ms: take.head_ms, tail_ms: take.tail_ms, trim_start_ms: Math.max(0, Math.round(atMs - take.head_ms)), trim_end_ms: take.trim_end_ms,
        prev_take_id: null, prev_at_ms: null, next_take_id: null, next_at_ms: null, created_at: at,
      })
      .execute();
    await this.db.updateTable("clips").set({ take_id: second, updated_at: at }).where("id", "=", id).execute();
    // the first half stops at the moment
    await this.db.updateTable("takes").set({ trim_end_ms: Math.max(0, Math.round((asset.duration_ms ?? 0) - take.tail_ms - atMs)) }).where("id", "=", take.id).execute();
    return id;
  }

  // ---------------------------------------------------------------- a range of the timeline

  /** The clips that play, on the timeline's clock. */
  private laid(all: Placed[]): Laid[] {
    let at = 0;
    const out: Laid[] = [];
    all.forEach((p, index) => {
      const lengthMs = lengthOf(p);
      if (lengthMs > 0) out.push({ p, index, atMs: at, lengthMs });
      at += lengthMs;
    });
    return out;
  }

  /** In and Out, in order and within what plays; refused when nothing plays yet. */
  private async window(timelineId: string, inMs: number, outMs: number) {
    await this.row(timelineId);
    const laid = this.laid(await this.placed(timelineId));
    const total = laid.length ? laid.at(-1)!.atMs + laid.at(-1)!.lengthMs : 0;
    if (!total) throw refused("Nothing plays yet: render a clip, or add a video or a picture first.");
    const a = Math.max(0, Math.min(total, Math.min(inMs, outMs)));
    const b = Math.max(0, Math.min(total, Math.max(inMs, outMs)));
    return { laid, total, a, b };
  }

  /** The clip that plays just before a moment (the one a cut at that moment ends), and the one that plays it. */
  private before(laid: Laid[], ms: number) { return laid.find((l) => l.atMs < ms && ms <= l.atMs + l.lengthMs); }
  private at(laid: Laid[], ms: number) { return laid.find((l) => l.atMs <= ms && ms < l.atMs + l.lengthMs); }

  /** A clip plays only its first `keepMs`. */
  private async endAt(p: Placed, keepMs: number) {
    if (p.clip.kind === "still") return void (await this.db.updateTable("clips").set({ still_ms: Math.max(STILL_MS.least, Math.round(keepMs)), updated_at: now() }).where("id", "=", p.clip.id).execute());
    const x = p.active!;
    const total = x.asset.duration_ms ?? 0;
    await this.db.updateTable("takes").set({ trim_end_ms: Math.max(0, Math.round(total - x.take.tail_ms - (plays(x).start + keepMs))) }).where("id", "=", x.take.id).execute();
  }

  /** A clip plays from `fromMs` into what it played. It no longer starts where the clip before stopped: a cut. */
  private async startAt(p: Placed, fromMs: number) {
    if (p.clip.kind === "still") return void (await this.db.updateTable("clips").set({ still_ms: Math.max(STILL_MS.least, Math.round(p.clip.still_ms - fromMs)), updated_at: now() }).where("id", "=", p.clip.id).execute());
    const x = p.active!;
    await this.db.updateTable("takes").set({ trim_start_ms: Math.max(0, Math.round(x.take.trim_start_ms + fromMs)) }).where("id", "=", x.take.id).execute();
    if (p.clip.joined === "continue") await this.db.updateTable("clips").set({ joined: "cut", updated_at: now() }).where("id", "=", p.clip.id).execute();
  }

  /**
   * What plays between In and Out goes: the clips inside, and the parts of the clips at the edges (a
   * clip with less than a tenth of a second left goes too). The clips after close the gap.
   */
  private async cutOut(timelineId: string, a: number, b: number): Promise<void> {
    const EDGE = 100;
    let laid = this.laid(await this.placed(timelineId));
    // the range inside one clip: that clip is split at Out first, so that what is after the range stays a clip
    const both = laid.find((l) => l.atMs < a && l.atMs + l.lengthMs > b);
    if (both) {
      await this.splitAt(timelineId, both.p, b - both.atMs);
      laid = this.laid(await this.placed(timelineId));
    }
    const gone: string[] = [];
    for (const l of laid) {
      const start = l.atMs;
      const end = l.atMs + l.lengthMs;
      if (start >= a - 1 && end <= b + 1) gone.push(l.p.clip.id);
      else if (start < a && end > a) {
        if (a - start < EDGE) gone.push(l.p.clip.id);
        else await this.endAt(l.p, a - start);
      } else if (start < b && end > b) {
        if (end - b < EDGE) gone.push(l.p.clip.id);
        else await this.startAt(l.p, b - start);
      }
    }
    if (gone.length) await this.db.deleteFrom("clips").where("id", "in", gone).execute();
    await this.renumber(timelineId, (await this.placed(timelineId)).map((p) => p.clip.id));
  }

  /** The clips under In and under Out each become two there. Both moments on cuts already: nothing to do. */
  async splitRange(timelineId: string, inMs: number, outMs: number): Promise<void> {
    const { laid, a, b } = await this.window(timelineId, inMs, outMs);
    const inside = (ms: number) => laid.find((l) => l.atMs + 40 <= ms && ms <= l.atMs + l.lengthMs - 40);
    const marks = [...new Set([b, a])].filter((ms) => inside(ms));
    if (!marks.length) throw refused("In and Out are both on cuts already: there is nothing to split.");
    await this.remember(timelineId, marks.length === 2 ? "the split at In and Out" : "the split");
    // Out first: the clips before it keep their places
    for (const ms of marks) {
      const l = inside(ms);
      if (l) await this.splitAt(timelineId, (await this.placed(timelineId)).find((p) => p.clip.id === l.p.clip.id)!, ms - l.atMs);
    }
    await this.touch(timelineId);
  }

  /** What plays between In and Out goes; the clips after close the gap. Undo brings it back. */
  async removeRange(timelineId: string, inMs: number, outMs: number): Promise<void> {
    const { a, b } = await this.window(timelineId, inMs, outMs);
    if (b - a < 40) throw refused("Set In and Out apart: there is nothing between them.");
    await this.remember(timelineId, "the range removed");
    await this.cutOut(timelineId, a, b);
    await this.touch(timelineId);
  }

  /** The picture at a moment of a clip (`localMs` after it starts playing): a still itself, a frame of a take. */
  private async pictureAt(l: Laid, localMs: number, edge: "start" | "end"): Promise<AssetRow> {
    if (l.p.clip.kind === "still") return l.p.still!;
    const x = l.p.active!;
    const { start, end } = plays(x);
    // the last frame that plays is a little before the moment the clip stops
    const ms = edge === "end" ? Math.max(start, Math.min(end - 20, start + localMs)) : Math.max(start, Math.min(end - 20, start + localMs));
    return this.frame(x.asset, ms, true);
  }

  /**
   * What plays between In and Out is replaced by a new clip to render, pinned to the frame just before In
   * and the frame at Out (whichever exist: at the very start or end of the timeline there is only one),
   * as long as the range on a model that takes those frames: the clip's at In when it does, else the
   * first that does. It starts from that clip's words and settings. In = Out on a cut: a clip between
   * the two, nothing removed. The clip is not rendered here: it is selected, and its form is yours first.
   */
  async regenerateRange(timelineId: string, inMs: number, outMs: number): Promise<{ clip: string; context: RangeContext }> {
    const { laid, total, a, b } = await this.window(timelineId, inMs, outMs);
    const before = a > 0 ? this.before(laid, a) : undefined;
    const after = b < total ? this.at(laid, b) : undefined;
    if (!before && !after) throw refused("The range covers everything: there is no frame to pin the new clip to. Add a clip instead.");
    const takes = (r: Recipe<any>, role: "start" | "end") => r.output === "video" && r.inputs.some((i) => i.type === "image" && i.role === role);
    const carries = (r: Recipe<any>, role: "previous" | "next") => r.output === "video" && r.inputs.some((i) => i.type === "clip" && i.role === role);
    /**
     * How the new clip meets each neighbour: a model that takes the clip before as context extends it
     * (the motion carries across), else it opens on the frame before In; the same at Out with the clip
     * after (a still is a picture either way).
     */
    const startBy = (r: Recipe<any>): "clip" | "frame" | null => (!before ? null : before.p.clip.kind === "video" && carries(r, "previous") ? "clip" : takes(r, "start") ? "frame" : null);
    const endBy = (r: Recipe<any>): "clip" | "frame" | null => (!after ? null : after.p.clip.kind === "video" && carries(r, "next") ? "clip" : takes(r, "end") ? "frame" : null);
    const fits = (r: Recipe<any> | undefined): r is Recipe<any> => Boolean(r && (!before || startBy(r)) && (!after || endBy(r)));
    const source = before ?? after!;
    const own = source.p.clip.recipe_id ? this.registry.recipe(source.p.clip.recipe_id) : undefined;
    const recipe = fits(own) ? own : this.registry.recipes().find(fits);
    if (!recipe) {
      throw refused(before && after ? "None of your video models takes a first and a last frame: nothing can be rendered between the clips." : before ? "None of your video models takes a first frame (i2v)." : "None of your video models takes a last frame.");
    }
    const context: RangeContext = { start: before ? startBy(recipe)! : "none", end: after ? endBy(recipe)! : "none" };
    const first = context.start === "frame" ? await this.pictureAt(before!, a - before!.atMs, "end") : null;
    const last = context.end === "frame" ? await this.pictureAt(after!, b - after!.atMs, "start") : null;
    await this.remember(timelineId, b - a >= 40 ? "the regenerated range" : "the clip added between");
    if (b - a >= 40) await this.cutOut(timelineId, a, b);
    // where it goes: after the last clip that stops by In
    const all = await this.placed(timelineId);
    const anchor = [...this.laid(all)].reverse().find((l) => l.atMs + l.lengthMs <= a + 50);
    const index = anchor ? anchor.index + 1 : 0;
    // its form: the source clip's own settings on the same model, else what a new clip there would get; its words when both models have them
    const srcInputs = JSON.parse(source.p.clip.inputs) as Record<string, unknown>;
    const inputs: Record<string, unknown> = own?.id === recipe.id
      ? Object.fromEntries(Object.entries(srcInputs).filter(([id]) => recipe.inputs.some((i) => i.id === id && !["prompt", "image", "clip", "seed"].includes(i.type))))
      : this.settingsOf(recipe, all, index);
    const mainOf = (r: Recipe<any>) => r.inputs.find((i) => i.type === "prompt" && !i.optional) ?? r.inputs.find((i) => i.type === "prompt" && i.id !== "negative");
    const from = own ? mainOf(own) : undefined;
    const to = mainOf(recipe);
    if (from && to && typeof srcInputs[from.id] === "string") inputs[to.id] = srcInputs[from.id];
    if (first) inputs[recipe.inputs.find((i) => i.type === "image" && i.role === "start")!.id] = first.id;
    if (last) inputs[recipe.inputs.find((i) => i.type === "image" && i.role === "end")!.id] = last.id;
    const seconds = secondsInput(recipe.inputs);
    if (seconds && b - a >= 40) inputs[seconds.id] = Number(Math.max(seconds.min, Math.min(seconds.max, Math.round((b - a) / 1000 / seconds.step) * seconds.step)).toFixed(3));
    const id = newId();
    const at = now();
    await this.db
      .insertInto("clips")
      .values({
        // extending the clip before: the render is given that clip's video up to In
        id, timeline_id: timelineId, position: index, take_id: null, joined: context.start === "clip" ? "continue" : "cut", recipe_id: recipe.id, inputs: JSON.stringify(inputs),
        kind: "video", still_asset_id: null, still_ms: 3000, sound: "own", sound_asset_id: null, volume: 100, fill: 0, look: source.p.clip.look, chat: null, created_at: at, updated_at: at,
      })
      .execute();
    const order = all.map((p) => p.clip.id);
    order.splice(index, 0, id);
    await this.renumber(timelineId, order);
    // the clip after: it follows the new clip when the model can end where it begins (the render is given its video from Out), else it is a cut
    const next = all[index];
    const nextJoined = context.end === "clip" ? "continue" : "cut";
    if (next && next.clip.joined !== nextJoined) await this.db.updateTable("clips").set({ joined: nextJoined, updated_at: at }).where("id", "=", next.clip.id).execute();
    await this.touch(timelineId);
    return { clip: id, context };
  }

  /**
   * A clip added after Out that brings the picture back to the frame at In, so that the range plays round:
   * it extends the clip at Out (or opens on its last frame) and ends on the frame at In, on a model that
   * takes a last frame. Out inside a clip: that clip is split there first. The clip after, if any, follows
   * as a cut. Short by default (a second and a half, or the least the model allows). Not rendered here: it
   * is selected, and its form is yours first. `arrive` is the clip under In, for the designer.
   */
  async loopRange(timelineId: string, inMs: number, outMs: number): Promise<{ clip: string; context: RangeContext; arrive: string }> {
    const { laid, a, b } = await this.window(timelineId, inMs, outMs);
    if (b - a < 40) throw refused("Set In and Out apart: a loop needs something to play round.");
    const source = this.before(laid, b)!;
    const target = this.at(laid, a) ?? this.before(laid, a)!;
    const takes = (r: Recipe<any>, role: "start" | "end") => r.output === "video" && r.inputs.some((i) => i.type === "image" && i.role === role);
    const carries = (r: Recipe<any>) => r.output === "video" && r.inputs.some((i) => i.type === "clip" && i.role === "previous");
    const startBy = (r: Recipe<any>): "clip" | "frame" | null => (source.p.clip.kind === "video" && carries(r) ? "clip" : takes(r, "start") ? "frame" : null);
    const fits = (r: Recipe<any> | undefined): r is Recipe<any> => Boolean(r && startBy(r) && takes(r, "end"));
    const own = source.p.clip.recipe_id ? this.registry.recipe(source.p.clip.recipe_id) : undefined;
    const recipe = fits(own) ? own : this.registry.recipes().find(fits);
    if (!recipe) throw refused("None of your video models takes a last frame: nothing can bring the range back to its start.");
    const context: RangeContext = { start: startBy(recipe)!, end: "frame" };
    const first = context.start === "frame" ? await this.pictureAt(source, b - source.atMs, "end") : null;
    const last = await this.pictureAt(target, a - target.atMs, "start");
    await this.remember(timelineId, "the loop clip");
    // Out inside a clip: split there, so that the loop clip comes right after what plays in the range
    if (b < source.atMs + source.lengthMs - 40) await this.splitAt(timelineId, source.p, b - source.atMs);
    const all = await this.placed(timelineId);
    const anchor = [...this.laid(all)].reverse().find((l) => l.atMs + l.lengthMs <= b + 50);
    const index = anchor ? anchor.index + 1 : 0;
    const srcInputs = JSON.parse(source.p.clip.inputs) as Record<string, unknown>;
    const inputs: Record<string, unknown> = own?.id === recipe.id
      ? Object.fromEntries(Object.entries(srcInputs).filter(([id]) => recipe.inputs.some((i) => i.id === id && !["prompt", "image", "clip", "seed"].includes(i.type))))
      : this.settingsOf(recipe, all, index);
    const mainOf = (r: Recipe<any>) => r.inputs.find((i) => i.type === "prompt" && !i.optional) ?? r.inputs.find((i) => i.type === "prompt" && i.id !== "negative");
    const from = own ? mainOf(own) : undefined;
    const to = mainOf(recipe);
    if (from && to && typeof srcInputs[from.id] === "string") inputs[to.id] = srcInputs[from.id];
    if (first) inputs[recipe.inputs.find((i) => i.type === "image" && i.role === "start")!.id] = first.id;
    inputs[recipe.inputs.find((i) => i.type === "image" && i.role === "end")!.id] = last.id;
    const seconds = secondsInput(recipe.inputs);
    if (seconds) inputs[seconds.id] = Number(Math.max(seconds.min, Math.min(seconds.max, Math.round(1.5 / seconds.step) * seconds.step)).toFixed(3));
    const id = newId();
    const at = now();
    await this.db
      .insertInto("clips")
      .values({
        id, timeline_id: timelineId, position: index, take_id: null, joined: context.start === "clip" ? "continue" : "cut", recipe_id: recipe.id, inputs: JSON.stringify(inputs),
        kind: "video", still_asset_id: null, still_ms: 3000, sound: "own", sound_asset_id: null, volume: 100, fill: 0, look: source.p.clip.look, chat: null, created_at: at, updated_at: at,
      })
      .execute();
    const order = all.map((p) => p.clip.id);
    order.splice(index, 0, id);
    await this.renumber(timelineId, order);
    // what came after Out does not follow the loop clip: it ends on In's frame, not on that clip
    const next = all[index];
    if (next && next.clip.joined !== "cut") await this.db.updateTable("clips").set({ joined: "cut", updated_at: at }).where("id", "=", next.clip.id).execute();
    await this.touch(timelineId);
    return { clip: id, context, arrive: target.p.clip.id };
  }

  // ---------------------------------------------------------------- slow motion

  /** The range of a video as one small file to hand to ComfyUI: cut to the frame, at its own frame rate. */
  async rangeSlice(video: AssetRow, startMs: number, endMs: number): Promise<{ bytes: Uint8Array; fps: number }> {
    const bytes = await this.storage.get(video.file_key);
    const ext = extOf(video.mime);
    const read = video.duration_ms && video.fps ? null : await readVideo(bytes, ext);
    const total = video.duration_ms ?? read?.facts?.durationMs ?? 0;
    const fps = video.fps ?? read?.facts?.fps ?? 24;
    if (!total) throw new CutError("This video could not be read.");
    const a = Math.max(0, Math.min(startMs, endMs));
    const b = Math.min(total, Math.max(startMs, endMs));
    return { bytes: await rangeKeep(bytes, ext, { durationMs: total, hasSound: Boolean(video.has_sound) }, [[a, b]], { crf: 10 }), fps };
  }

  /** A video made from a range of another, filed in the library next to it with its source and range. */
  async keepCut(original: AssetRow, out: Uint8Array, name: string, startMs: number, endMs: number): Promise<AssetRow> {
    const seen = await readVideo(out, "mp4");
    const id = newId();
    const key = `assets/${id.slice(0, 2)}/${id}.mp4`;
    await this.storage.put(key, out);
    const thumb = seen.frame ? await makeThumb(seen.frame) : null;
    if (thumb) await this.storage.put(thumbKey(id), thumb);
    const at = now();
    await this.db
      .insertInto("assets")
      .values({
        id, owner_id: OWNER, kind: "video", origin: "cut", name, file_key: key, thumb_key: thumb ? thumbKey(id) : null, mime: "video/mp4", bytes: out.length,
        width: seen.facts?.width ?? original.width, height: seen.facts?.height ?? original.height,
        duration_ms: seen.facts?.durationMs ?? null, fps: seen.facts?.fps ?? original.fps, has_sound: seen.facts?.hasSound ? 1 : 0,
        folder_id: original.folder_id, generation_id: null, source_id: original.id, source_range: `${Math.round(startMs)}-${Math.round(endMs)}`, kept_at: at, deleted_at: null, created_at: at,
      })
      .execute();
    this.events.emit("library");
    return this.db.selectFrom("assets").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
  }

  /** The name a slowed range is filed under. */
  slowName(video: AssetRow, startMs: number, endMs: number, factor: number): string {
    const base = (video.name || "video").replace(/\.[a-z0-9]+$/i, "");
    return `${base} · slow ×${factor} ${clockOf(startMs)}–${clockOf(endMs)}`;
  }

  /** The range slowed by ffmpeg (no GPU), filed in the library. */
  async slowRange(video: AssetRow, startMs: number, endMs: number, factor: 2 | 4, opts: { crf?: number; signal?: AbortSignal } = {}): Promise<AssetRow> {
    const bytes = await this.storage.get(video.file_key);
    const ext = extOf(video.mime);
    const read = video.duration_ms && video.fps ? null : await readVideo(bytes, ext);
    const total = video.duration_ms ?? read?.facts?.durationMs ?? 0;
    if (!total) throw new CutError("This video could not be read.");
    const out = await slowMotion(bytes, ext, { durationMs: total, fps: video.fps ?? read?.facts?.fps ?? null, hasSound: Boolean(video.has_sound) }, startMs, endMs, factor, opts);
    return this.keepCut(video, out, this.slowName(video, startMs, endMs, factor), startMs, endMs);
  }

  /** A video becomes a take of a clip, and plays (what a slow-motion job hands back). One step to undo. */
  async takeFrom(clipId: string, asset: AssetRow, label = "the slow-motion take", finishedFrom: string | null = null): Promise<void> {
    const clip = await this.db.selectFrom("clips").selectAll().where("id", "=", clipId).executeTakeFirst();
    // the clip was removed while the job ran: the video is in the library all the same
    if (!clip) return;
    await this.remember(clip.timeline_id, label);
    await this.addTake(clipId, asset, { headMs: 0, tailMs: 0 }, {}, finishedFrom);
    await this.touch(clip.timeline_id);
  }

  /**
   * The range made clips of their own, for slow motion: the clips under In and Out are split there, so
   * that what lies between is whole clips. Stills among them are simply held `factor` times longer. The
   * video clips come back with the part of their video to slow (a job each, whose video becomes their
   * take). The clips that followed one of them no longer do: they become cuts. One step to undo, with the
   * takes that follow.
   */
  async slowRangeOf(timelineId: string, inMs: number, outMs: number, factor: 2 | 4): Promise<Array<{ clip: string; asset: AssetRow; startMs: number; endMs: number }>> {
    const { laid, a, b } = await this.window(timelineId, inMs, outMs);
    if (b - a < 40) throw refused("Set In and Out apart: there is nothing to slow down.");
    if (!laid.some((l) => l.p.clip.kind === "video" && l.p.active && l.atMs < b && l.atMs + l.lengthMs > a)) throw refused("Nothing in the range plays a video: there is nothing to slow down.");
    await this.remember(timelineId, "the split for slow motion");
    // Out first, then In: the clips before keep their places
    for (const ms of [b, a]) {
      const l = this.laid(await this.placed(timelineId)).find((x) => x.atMs + 40 <= ms && ms <= x.atMs + x.lengthMs - 40);
      if (l) await this.splitAt(timelineId, (await this.placed(timelineId)).find((p) => p.clip.id === l.p.clip.id)!, ms - l.atMs);
    }
    const all = await this.placed(timelineId);
    const parts = this.laid(all).filter((l) => l.atMs >= a - 1 && l.atMs + l.lengthMs <= b + 1);
    const jobs: Array<{ clip: string; asset: AssetRow; startMs: number; endMs: number }> = [];
    const at = now();
    for (const l of parts) {
      if (l.p.clip.kind === "still") {
        await this.db.updateTable("clips").set({ still_ms: Math.min(STILL_MS.most, Math.round(l.p.clip.still_ms * factor)), updated_at: at }).where("id", "=", l.p.clip.id).execute();
      } else if (l.p.active) {
        const { start, end } = plays(l.p.active);
        jobs.push({ clip: l.p.clip.id, asset: l.p.active.asset, startMs: start, endMs: end });
      }
      // a clip that followed what is now slowed down no longer does
      const next = all[l.index + 1];
      if (next?.clip.joined === "continue") await this.db.updateTable("clips").set({ joined: "cut", updated_at: at }).where("id", "=", next.clip.id).execute();
    }
    const first = parts[0];
    if (first?.p.clip.joined === "continue") await this.db.updateTable("clips").set({ joined: "cut", updated_at: at }).where("id", "=", first.p.clip.id).execute();
    await this.touch(timelineId);
    return jobs;
  }

  // ---------------------------------------------------------------- export

  /**
   * The timeline as one video in the library: what plays, start to end, with its sounds and its music.
   * With a range: only that part, as a copy in the library (the music is left out).
   */
  async export(id: string, opts: { scale?: number; music?: boolean; smooth?: boolean; range?: { inMs: number; outMs: number }; blend?: boolean; match?: boolean; fit?: "timeline" | "largest"; signal?: AbortSignal } = {}) {
    const t = await this.row(id);
    const laid = this.laid(await this.placed(id));
    const total = laid.length ? laid.at(-1)!.atMs + laid.at(-1)!.lengthMs : 0;
    const win = opts.range ? { a: Math.max(0, Math.min(opts.range.inMs, opts.range.outMs)), b: Math.min(total, Math.max(opts.range.inMs, opts.range.outMs)) } : null;
    if (win && win.b - win.a < 40) throw new CutError("Set In and Out apart: there is nothing between them.");
    const shown = win ? laid.filter((l) => l.atMs < win.b && l.atMs + l.lengthMs > win.a) : laid;
    const all = shown.map((l) => l.p);
    if (!all.length) throw new CutError("There is nothing to export yet: no clip of this timeline has a take.");
    const first = all[0]!.active?.asset ?? all[0]!.still;
    let frame = t.width && t.height ? { width: t.width, height: t.height } : { width: first?.width ?? 576, height: first?.height ?? 1024 };
    // at the finished size: the timeline's shape, with as many pixels as its largest take (the drafts are enlarged to it)
    if (opts.fit === "largest") {
      const most = Math.max(0, ...all.map((p) => (p.active?.asset.width ?? 0) * (p.active?.asset.height ?? 0)));
      const k = Math.sqrt(most / (frame.width * frame.height));
      if (k > 1.05) frame = { width: Math.round((frame.width * k) / 8) * 8, height: Math.round((frame.height * k) / 8) * 8 };
    }
    const fps = Math.round(Math.max(...all.map((p) => p.active?.asset.fps ?? 24), 1));
    const parts: ExportPart[] = [];
    for (const [i, l] of shown.entries()) {
      const p = l.p;
      const soundFile = p.clip.sound === "file" && p.sound ? { bytes: await this.storage.get(p.sound.file_key), ext: extOf(p.sound.mime) } : undefined;
      const heard = { sound: p.clip.sound, soundFile, volume: p.clip.volume / 100, fill: Boolean(p.clip.fill) };
      // within the window: the part of the clip that falls in it
      const from = win ? Math.max(0, win.a - l.atMs) : 0;
      const to = win ? Math.min(l.lengthMs, win.b - l.atMs) : l.lengthMs;
      if (p.clip.kind === "still") {
        parts.push({ kind: "still", bytes: await this.storage.get(p.still!.file_key), ext: extOf(p.still!.mime), startMs: from, endMs: to, hasSound: false, ...heard });
      } else {
        const x = p.active!;
        // a clip rendered as the continuation of the one before (it replayed the frames they share) starts its
        // own part exactly where that one stops: the model restarts beside the pinned frames, and the first
        // generated frames may step away from them. The export softens that step: the part before holds its
        // last frame for a few frames while this one fades in over its first generated frames
        const before = parts[i - 1];
        const shared = x.take.head_ms - x.take.trim_start_ms;
        // a join made in the latent continues the clip before's own tokens: its shared frames and the clip
        // before's last frames show the same moments, so the fade runs over them with both sides moving. A
        // pixel join restarts beside pinned frames: the clip before holds its last frame while this one fades in
        const latent = x.take.join_kind === "latent";
        const blend = opts.blend !== false && before && before.kind === "video" && from === 0 && shared >= 80
          ? Math.min(BLEND_MS, to - 40, ...(latent ? [shared, before.endMs - before.startMs - 40] : []))
          : 0;
        parts.push({
          kind: "video", bytes: await this.storage.get(x.asset.file_key), ext: extOf(x.asset.mime),
          startMs: plays(x).start + from - (blend >= 80 && latent ? blend : 0), endMs: plays(x).start + to, hasSound: Boolean(x.asset.has_sound), ...heard,
          ...(blend >= 80 ? { blendMs: blend, blendMode: latent ? ("overlap" as const) : ("hold" as const) } : {}),
        });
      }
    }
    const track = opts.music === false || win ? undefined : await this.assetRow(t.music_asset_id);
    const music: ExportMusic | undefined = track
      ? {
          bytes: await this.storage.get(track.file_key), ext: extOf(track.mime), durationMs: track.duration_ms ?? 0,
          volume: t.music_volume / 100, fadeInMs: t.music_fade_in_ms, fadeOutMs: t.music_fade_out_ms, duck: Boolean(t.music_duck),
        }
      : undefined;
    const bytes = await joinVideos(parts, frame, fps, { scale: opts.scale ?? 1, music, smoothTo: opts.smooth ? 48 : undefined, match: opts.match !== false, signal: opts.signal });
    const assetId = newId();
    const key = `assets/${assetId.slice(0, 2)}/${assetId}.mp4`;
    await this.storage.put(key, bytes);
    const video = await readVideo(bytes, "mp4");
    const thumb = video.frame ? await makeThumb(video.frame) : null;
    if (thumb) await this.storage.put(thumbKey(assetId), thumb);
    const at = now();
    await this.db
      .insertInto("assets")
      .values({
        id: assetId, owner_id: OWNER, kind: "video", origin: "exported", name: win ? `${t.name} · ${clockOf(win.a)}–${clockOf(win.b)}` : t.name, file_key: key, thumb_key: thumb ? thumbKey(assetId) : null,
        mime: "video/mp4", bytes: bytes.length, width: video.facts?.width ?? frame.width, height: video.facts?.height ?? frame.height,
        duration_ms: video.facts?.durationMs ?? null, fps: video.facts?.fps ?? fps, has_sound: 1, folder_id: t.folder_id, generation_id: null,
        kept_at: at, deleted_at: null, created_at: at,
      })
      .execute();
    await this.db.updateTable("timelines").set({ export_asset_id: assetId }).where("id", "=", id).execute();
    this.events.emit("library");
    this.changed();
    return assetView(await this.db.selectFrom("assets").selectAll().where("id", "=", assetId).executeTakeFirstOrThrow());
  }
}
