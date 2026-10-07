import { chatJson } from "./designer";
import type { EventEmitter } from "node:events";
import { joinKindOf, type Recipe, type InputSpec } from "@afflatus/core";
import { frozenTailAt, type Measure } from "./cut";
import { newId, now, OWNER, type Db } from "./db";
import { httpError, notFound } from "./errors";
import { rootFolderOf } from "./projects";
import type { Look } from "./entities";
import { assetView } from "./media";
import type { Registry } from "./registry";
import type { Storage } from "./storage";
import { TimelineExport } from "./timelineExport";
import { TimelineMedia } from "./timelineMedia";
import { TimelineRange, type RangeContext } from "./timelineRange";
import { clockOf, FROM_PREVIOUS, leadFor, leadOf, LEAD_MS, lengthOf, lengthOnGrid, near, plays, STILL_MS, stillRef, visible, type AssetRow, type ClipRow, type Placed, type TakeRow, type Taken, type TimelineCore, type TimelineRow } from "./timelineModel";

/**
 * Timelines: clips played one after the other. A clip is a place on the timeline with a form (what to
 * render there); each render of it is a take, and one take plays. A clip can carry on from the clip
 * before it: the take then remembers which take it carried on from, so that when that one changes the
 * join is known to be stale. A clip can also be a picture held on screen (a still). Nothing here knows
 * which model a clip is made with: it reads the recipe's inputs (a clip to carry on from, a clip to
 * arrive at, an opening picture) and fills them in.
 */

// the parts of the model other modules name: the opening-picture placeholder and the clock (timelineModel.ts), how a regenerated clip meets its neighbours (timelineRange.ts)
export { clockOf, FROM_PREVIOUS };
export type { RangeContext };

/** How many frames the trim bar asks for in a video's film strip: one a second, from sixteen up to a hundred and twenty (see Trim.tsx). */
const TRIM_STRIP_FRAMES = (durationMs: number) => Math.min(120, Math.max(16, Math.round(durationMs / 1000)));

/**
 * The keys of what the timeline works out of a video and keeps beside it: its film strip (the track's,
 * and the trim bar's when its length is known), its motion and loudness, its scene cuts. They go when
 * the video goes, or when the file behind it changes (a linked folder's file written again).
 */
export function derivedKeys(asset: { id: string; duration_ms: number | null }): string[] {
  const dir = asset.id.slice(0, 2);
  return [
    `strips/${dir}/${asset.id}.jpg`,
    ...(asset.duration_ms ? [`strips/${dir}/${asset.id}-${TRIM_STRIP_FRAMES(asset.duration_ms)}x48.jpg`] : []),
    `motion/${dir}/${asset.id}.json`,
    `scenes/${dir}/${asset.id}.json`,
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
  finishedFrom?: string;
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

/** How many changes Undo can go back. */
const HISTORY = 40;

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
  /** Cuts and ranges, what the videos give, and the export: the model's heavier work, each in its own module behind thin methods here. */
  private readonly range: TimelineRange;
  private readonly media: TimelineMedia;
  private readonly exporter: TimelineExport;

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
      remember: (id, label) => this.remember(id, label), touch: (id) => this.touch(id), renumber: (id, order, db) => this.renumber(id, order, db),
      settingsOf: (recipe, all, index) => this.settingsOf(recipe, all, index), frame: (video, atMs, once) => this.media.frame(video, atMs, once),
    };
    this.range = new TimelineRange(core);
    this.media = new TimelineMedia(core);
    this.exporter = new TimelineExport(core);
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
    const takesOf = new Map<string, TakeRow[]>();
    for (const t of takes) takesOf.set(t.clip_id, [...(takesOf.get(t.clip_id) ?? []), t]);
    for (const clip of clips) {
      const own: Taken[] = (takesOf.get(clip.id) ?? []).filter((t) => byId.has(t.asset_id)).map((take) => ({ take, asset: byId.get(take.asset_id)! }));
      out.get(clip.timeline_id)!.push({
        clip, takes: own, active: own.find((t) => t.take.id === clip.take_id) ?? null,
        still: (clip.still_asset_id && byId.get(clip.still_asset_id)) || null,
        sound: (clip.sound_asset_id && byId.get(clip.sound_asset_id)) || null,
        pictures: pinned(clip).flatMap((p) => (byId.has(p.id) ? [{ input: p.input, role: p.role, asset: byId.get(p.id)! }] : [])),
      });
    }
    // a clip followed by a continuation with a take-over point gives it those last frames: they show the same moments.
    // A clip that lands on the clip after (its tail was guided by that take's frames) does the opposite: it plays on
    // into its guided tail, four frames, and the clip after starts as much later. Cut where it is guided, the landing
    // does not step; cut before, in the frames the model drew freely, it did (×5 the motion, measured 2026-10-07)
    for (const placed of out.values()) {
      for (let i = 0; i < placed.length - 1; i++) {
        const next = placed[i + 1]!;
        const mine = placed[i]!.active;
        if (mine && next.active && mine.take.next_take_id === next.active.take.id && mine.take.tail_ms >= 2 * LEAD_MS) {
          mine.give = -LEAD_MS;
          next.active.landed = LEAD_MS;
          continue;
        }
        const give = next.clip.kind === "video" && next.clip.joined === "continue" && next.active ? next.active.take.lead_ms ?? 0 : 0;
        if (give > 0) for (const t of placed[i]!.takes) t.give = give;
      }
    }
    return out;
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
    const jobs = all.length
      ? await this.db.selectFrom("jobs").select(["id", "clip_id", "status", "error", "finished_at"]).where("clip_id", "in", all.map((p) => p.clip.id)).orderBy("created_at").execute()
      : [];
    // how long each take's render took, from the record of renders (a finish made by a cut has none)
    const made = [...new Set(all.flatMap((p) => p.takes.map((x) => x.asset.generation_id)).filter((g): g is string => Boolean(g)))];
    const records = made.length ? await this.db.selectFrom("generations").select(["id", "gen_ms", "resolved"]).where("id", "in", made).execute() : [];
    const tookMs = new Map(records.map((g) => [g.id, g.gen_ms]));
    // how each render's own part looks (mean luma, sharpness), measured on its frames when it was stored
    const looks = new Map(records.map((g) => [g.id, (JSON.parse(g.resolved) as { measure?: Measure }).measure ?? null]));
    const takeView = (x: Taken) => ({
      id: x.take.id, asset: assetView(x.asset), headMs: x.take.head_ms, tailMs: x.take.tail_ms,
      trimStartMs: x.take.trim_start_ms, trimEndMs: x.take.trim_end_ms, startMs: visible(x).start, endMs: visible(x).end, createdAt: x.take.created_at,
      /** Its take-over point: it starts to play this many ms before its shared frames end, and the clip before stops as much earlier (0: at its first own frame). */
      leadMs: leadOf(x),
      ...(x.landed !== undefined ? { landedMs: x.landed } : {}),
      finishedFrom: x.take.finished_from,
      /** How its start joins the clip before: in the latent (the clip before's own tokens continued), or pinned frames; null when it does not continue a clip. */
      joinKind: x.take.join_kind ?? null,
      /** How long its render took, when it was rendered here and measured; null otherwise. */
      renderMs: (x.asset.generation_id && tookMs.get(x.asset.generation_id)) || null,
      /** How its own part looks: mean luma (0–255) and a sharpness figure, measured on its frames when it was rendered here; null otherwise. */
      measure: (x.asset.generation_id && looks.get(x.asset.generation_id)) || null,
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
    // its export under way (the newest when several wait), else its last export, whatever the other timelines exported since
    const ownExports = () => this.db.selectFrom("jobs").select(["id", "status", "error"]).where("recipe_id", "=", EXPORT_JOB).where("timeline_id", "=", id).orderBy("created_at", "desc");
    const exporting = await ownExports().where("status", "in", ["queued", "running"]).executeTakeFirst();
    const lastExport = exporting ? undefined : await ownExports().executeTakeFirst();
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
      exportFailed: lastExport?.status === "failed" ? lastExport.error : null,
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
    if (!last) throw httpError("There is nothing to undo.");
    await this.snapshot("timeline_future", timelineId, last.label);
    await this.restore(timelineId, JSON.parse(last.snapshot) as { timeline: TimelineRow; clips: ClipRow[]; takes: TakeRow[] });
    await this.db.deleteFrom("timeline_history").where("id", "=", last.id).execute();
    return last.label;
  }

  /** Do again what Undo took back. */
  async redo(timelineId: string): Promise<string> {
    const next = await this.db.selectFrom("timeline_future").selectAll().where("timeline_id", "=", timelineId).orderBy("seq", "desc").executeTakeFirst();
    if (!next) throw httpError("There is nothing to redo.");
    await this.snapshot("timeline_history", timelineId, next.label);
    await this.restore(timelineId, JSON.parse(next.snapshot) as { timeline: TimelineRow; clips: ClipRow[]; takes: TakeRow[] });
    await this.db.deleteFrom("timeline_future").where("id", "=", next.id).execute();
    return next.label;
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
    await this.row(id);
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
    let take: { asset: AssetRow; head: number; tail: number; latent?: boolean; frames?: boolean } | null = null;

    const asset = await this.assetRow(opts.asset ?? null);
    if (opts.asset && !asset) throw notFound("this item");
    const made = asset?.generation_id ? await this.db.selectFrom("generations").selectAll().where("id", "=", asset.generation_id).executeTakeFirst() : undefined;

    if (asset?.kind === "video") {
      // what it was made with comes along, so that another take can be made of it
      const recipe = made ? this.registry.recipe(made.recipe_id) : undefined;
      if (made && recipe) {
        recipeId = recipe.id;
        inputs = this.ownInputs(recipe, JSON.parse(made.inputs) as Record<string, unknown>);
      } else recipeId = null;
      const overlap = made ? (JSON.parse(made.resolved) as { overlap?: { headMs: number; tailMs: number; latent?: boolean; frames?: boolean } }).overlap : undefined;
      take = { asset, head: overlap?.headMs ?? 0, tail: overlap?.tailMs ?? 0, latent: overlap?.latent, frames: overlap?.frames };
      // a video brought in starts on its own: it was not made to follow what is before it
      joined = "cut";
    } else if (asset?.kind === "image" && opts.as === "clip") {
      const recipe = this.recipeWithStart(recipeId);
      if (!recipe) throw httpError("None of your video models takes a first frame (i2v).");
      recipeId = recipe.id;
      inputs = { ...this.settingsOf(recipe, all, index), [recipe.inputs.find((i) => i.type === "image" && i.role === "start")!.id]: asset.id };
      joined = "cut";
    } else if (asset?.kind === "image") {
      kind = "still";
      still = asset.id;
      recipeId = null;
      joined = "cut";
    } else if (asset) {
      throw httpError("Only videos and images go on the video track. Audio goes on a clip, or on the music track.");
    } else {
      const recipe = recipeId ? this.registry.recipe(recipeId) : undefined;
      if (recipe) inputs = this.settingsOf(recipe, all, index);
    }

    await this.remember(timelineId, kind === "still" ? "the image added" : "the clip added");
    const order = all.map((p) => p.clip.id);
    order.splice(index, 0, id);
    // the clip, its place among the others and its take land together, or not at all
    await this.db.transaction().execute(async (tx) => {
      await tx
        .insertInto("clips")
        .values({
          id, timeline_id: timelineId, position: index, take_id: null, joined, recipe_id: recipeId, inputs: JSON.stringify(inputs),
          kind, still_asset_id: still, still_ms: 3000, sound: "own", sound_asset_id: null, volume: 100, fill: 0, look: null, chat: null, created_at: at, updated_at: at,
        })
        .execute();
      await this.renumber(timelineId, order, tx);
      if (take) await this.addTake(id, take.asset, { headMs: take.head, tailMs: take.tail, latent: take.latent, frames: take.frames }, {}, null, tx);
      if (still) await this.keep(still, tx);
    });
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
    if (patch.animate && !animate) throw httpError("None of your video models takes a first frame (i2v).");
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
      if (!takeId) throw httpError("There is nothing to trim yet: this clip has no take.");
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

  private async addTake(clipId: string, asset: AssetRow, overlap: { headMs: number; tailMs: number; latent?: boolean; frames?: boolean }, links: TakeLinks, finishedFrom: string | null = null, db: Db = this.db) {
    const id = newId();
    // the finished version of a take keeps that take's overlaps and trims: it plays the same part, larger
    const from = finishedFrom ? await db.selectFrom("takes").selectAll().where("id", "=", finishedFrom).executeTakeFirst() : undefined;
    await db
      .insertInto("takes")
      .values({
        id, clip_id: clipId, asset_id: asset.id, head_ms: from?.head_ms ?? overlap.headMs, tail_ms: from?.tail_ms ?? overlap.tailMs, trim_start_ms: from?.trim_start_ms ?? 0, trim_end_ms: from?.trim_end_ms ?? 0,
        join_kind: from ? from.join_kind : joinKindOf(overlap),
        lead_ms: from ? from.lead_ms : leadFor(joinKindOf(overlap), overlap.headMs),
        prev_take_id: links.prev?.take ?? from?.prev_take_id ?? null, prev_at_ms: links.prev?.at ?? from?.prev_at_ms ?? null, next_take_id: links.next?.take ?? from?.next_take_id ?? null, next_at_ms: links.next?.at ?? from?.next_at_ms ?? null,
        finished_from: from ? from.id : null, created_at: now(),
      })
      .execute();
    const clip = await db.updateTable("clips").set({ take_id: id, updated_at: now() }).where("id", "=", clipId).returning("timeline_id").executeTakeFirst();
    await this.keep(asset.id, db);
    // the first video of a timeline decides its frame
    if (clip && asset.width && asset.height) {
      await db.updateTable("timelines").set({ width: asset.width, height: asset.height }).where("id", "=", clip.timeline_id).where("width", "is", null).execute();
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
          // on the model's frame grid: the frames handed over are whole frames of it, and the clip before stops on one
          if (lively !== null && lively < at - 40) {
            const frame = Math.round((lively * 24) / 1000);
            // a clip whose latent was kept hands over on its latent's grid (17k + 5 frames, at or before the frozen tail):
            // the join is then made in the latent, cut there, rather than from frames
            const grid = before.asset.latent_frames ? Math.floor((frame - 5) / 17) * 17 + 5 : frame;
            const usable = grid >= 22 ? grid : frame;
            at = Math.round(usable * (1000 / 24));
          }
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
      throw httpError("This clip extends the previous clip from its last frame, and that clip has no take yet.");
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
  async finished(clipId: string, generationId: string, overlap: { headMs: number; tailMs: number; latent?: boolean; frames?: boolean } | undefined, links: TakeLinks, finishedFrom: string | null = null): Promise<void> {
    const clip = await this.db.selectFrom("clips").selectAll().where("id", "=", clipId).executeTakeFirst();
    // the clip was removed while it rendered: the video is in the library all the same
    if (!clip) return;
    const asset = await this.db.selectFrom("assets").selectAll().where("generation_id", "=", generationId).where("kind", "=", "video").executeTakeFirst();
    if (!asset) return;
    // placed already: the queue found the job again after a crash between placing the take and closing the job
    if (await this.db.selectFrom("takes").select("id").where("clip_id", "=", clipId).where("asset_id", "=", asset.id).executeTakeFirst()) return;
    if (finishedFrom) await this.remember(clip.timeline_id, "the finished take");
    await this.addTake(clipId, asset, overlap ?? { headMs: 0, tailMs: 0 }, links, finishedFrom);
    // the take carried on from before the clip before's frozen tail: that clip now stops where the take picks up
    if (links.prev && !finishedFrom) {
      const prev = await this.db.selectFrom("takes").innerJoin("assets", "assets.id", "takes.asset_id").select(["takes.id as id", "takes.tail_ms as tail_ms", "takes.trim_end_ms as trim_end_ms", "assets.duration_ms as duration_ms", "assets.latent_frames as latent_frames"]).where("takes.id", "=", links.prev.take).executeTakeFirst();
      if (prev?.duration_ms) {
        const length = lengthOnGrid(prev as unknown as AssetRow);
        const end = length - prev.tail_ms - prev.trim_end_ms;
        if (links.prev.at < end - 40) {
          await this.remember(clip.timeline_id, "the hand-over before the frozen tail");
          await this.db.updateTable("takes").set({ trim_end_ms: Math.round(length - prev.tail_ms - links.prev.at) }).where("id", "=", prev.id).execute();
        }
      }
    }
    await this.touch(clip.timeline_id);
  }

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
   * again): its film strips, motion and scene cuts in storage, and the join scores and colour means of the
   * takes that play it. They are made again when next looked at. To be called while the row still says how
   * long the old file was, so that the trim bar's strip of it is found.
   */
  async forgetDerived(assetId: string): Promise<void> {
    const asset = await this.db.selectFrom("assets").select(["id", "duration_ms"]).where("id", "=", assetId).executeTakeFirst();
    for (const key of derivedKeys(asset ?? { id: assetId, duration_ms: null })) await this.storage.delete(key).catch(() => {});
    const takes = (await this.db.selectFrom("takes").select("id").where("asset_id", "=", assetId).execute()).map((t) => t.id);
    if (!takes.length) return;
    this.media.forgetTakes(takes);
  }

  /** A clip's timeline as it is on screen, and the clip's place in it. */
  async whereIs(clipId: string) {
    const clip = await this.clipRow(clipId);
    const view = await this.view(clip.timeline_id);
    return { view, index: view.clips.findIndex((c) => c.id === clipId) };
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

  // ---------------------------------------------------------------- what the videos give (timelineMedia.ts)

  /** One frame of a video as a picture in the library; `once`: the same frame asked for again is the same picture. */
  frame(video: AssetRow, atMs: number, once = false): Promise<AssetRow> { return this.media.frame(video, atMs, once); }
  /** Frames of a video side by side in one picture, for the timeline and the trim bar. */
  strip(assetId: string, opts: { frames?: number; height?: number; fromMs?: number; toMs?: number } = {}): Promise<Uint8Array> { return this.media.strip(assetId, opts); }
  /** How much moves along a video and how loud it is, ten samples a second. */
  motion(assetId: string): Promise<{ rate: number; values: number[]; sound: number[] | null }> { return this.media.motion(assetId); }
  /** Where a video cuts between shots. */
  scenes(assetId: string): Promise<{ cuts: number[] }> { return this.media.scenes(assetId); }
  /** The colour nudge each clip gets in the player. */
  matches(timelineId: string): ReturnType<TimelineMedia["matches"]> { return this.media.matches(timelineId); }
  /** How smoothly each take of a clip meets its neighbours. */
  joins(clipId: string): Promise<Array<{ take: string; in: number | null; out: number | null }>> { return this.media.joins(clipId); }
  /** One small picture of a moment of a video, for a hover over the trim bar. */
  peek(assetId: string, atMs: number, height?: number): Promise<Uint8Array> { return this.media.peek(assetId, atMs, height); }

  // ---------------------------------------------------------------- cuts and ranges (timelineRange.ts)

  /** A range of a video kept as new videos of the library: a copy, a split or the video without it. */
  cutRange(video: AssetRow, startMs: number, endMs: number, action: "copy" | "split" | "remove", opts: { crf?: number; signal?: AbortSignal } = {}): Promise<AssetRow[]> { return this.range.cutRange(video, startMs, endMs, action, opts); }
  /** A clip's take that plays, with its video and where the clip stands. */
  takeOf(clipId: string): Promise<{ clip: ClipRow; take: TakeRow; asset: AssetRow; index: number; timelineId: string }> { return this.range.takeOf(clipId); }
  /** One clip becomes two at a moment of its take. */
  splitClip(clipId: string, atMs: number): Promise<string> { return this.range.splitClip(clipId, atMs); }
  /** A copy of the clip right after it, its takes again. */
  duplicateClip(clipId: string): Promise<string> { return this.range.duplicateClip(clipId); }
  /** The clips under In and under Out each become two there. */
  splitRange(timelineId: string, inMs: number, outMs: number): Promise<void> { return this.range.splitRange(timelineId, inMs, outMs); }
  /** What plays between In and Out goes. */
  removeRange(timelineId: string, inMs: number, outMs: number): Promise<void> { return this.range.removeRange(timelineId, inMs, outMs); }
  /** What plays between In and Out is replaced by a new clip to render, pinned to the frames around it. */
  regenerateRange(timelineId: string, inMs: number, outMs: number): Promise<{ clip: string; context: RangeContext }> { return this.range.regenerateRange(timelineId, inMs, outMs); }
  /** A clip added after Out that brings the picture back to the frame at In. */
  loopRange(timelineId: string, inMs: number, outMs: number): Promise<{ clip: string; context: RangeContext; arrive: string }> { return this.range.loopRange(timelineId, inMs, outMs); }
  /** The range of a video as one small file to hand to ComfyUI. */
  rangeSlice(video: AssetRow, startMs: number, endMs: number): Promise<{ bytes: Uint8Array; fps: number }> { return this.range.rangeSlice(video, startMs, endMs); }
  /** A video made from a range of another, filed in the library next to it. */
  keepCut(original: AssetRow, out: Uint8Array, name: string, startMs: number, endMs: number): Promise<AssetRow> { return this.range.keepCut(original, out, name, startMs, endMs); }
  /** The name a slowed range is filed under. */
  slowName(video: AssetRow, startMs: number, endMs: number, factor: number): string { return this.range.slowName(video, startMs, endMs, factor); }
  /** The range slowed by ffmpeg, filed in the library. */
  slowRange(video: AssetRow, startMs: number, endMs: number, factor: 2 | 4, opts: { crf?: number; signal?: AbortSignal } = {}): Promise<AssetRow> { return this.range.slowRange(video, startMs, endMs, factor, opts); }
  /** The range made clips of their own, for slow motion: the parts of their videos to slow, a job each. */
  slowRangeOf(timelineId: string, inMs: number, outMs: number, factor: 2 | 4): Promise<Array<{ clip: string; asset: AssetRow; startMs: number; endMs: number }>> { return this.range.slowRangeOf(timelineId, inMs, outMs, factor); }

  // ---------------------------------------------------------------- export (timelineExport.ts)

  /** The timeline as one video in the library; with a range, only that part. */
  export(id: string, opts: { scale?: number; music?: boolean; smooth?: boolean; range?: { inMs: number; outMs: number }; blend?: boolean; match?: boolean; fit?: "timeline" | "largest"; signal?: AbortSignal } = {}) { return this.exporter.export(id, opts); }
}
