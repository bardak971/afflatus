import { chatJson } from "./llm";
import type { EventEmitter } from "node:events";
import { duckCurve, type DuckCurve } from "./duck";
import { carriedOf, joinWay, laysSound, musicPlan, sungHead, plural, recordingPart, sameWindowGrid, type CueValue, type ClipMusic, type InputSpec, type Transition } from "@afflatus/core";
import { newId, now, OWNER, toRun, type Db } from "./db";
import type { LibraryChange } from "./events";
import { httpError, notFound } from "./errors";
import { isLinked } from "./linked";
import { rootFolderOf } from "./projects";
import { timelineMediaFollows } from "./timelineFolder";
import type { Look } from "./entities";
import { assetView, spaceOf } from "./media";
import type { Registry } from "./registry";
import type { Storage } from "./storage";
import { TimelineExport } from "./timelineExport";
import { TimelineMedia } from "./timelineMedia";
import { clipColumns, takeColumns, TimelineHistory } from "./timelineHistory";
import { TimelineRange } from "./timelineRange";
import { atLengthBefore, cutOf, parkClips, parkedRecordings, recordingCuts, refuseBusy, removedRecordings, setParkedRecording, shortenedRecordings, TimelineRecording, unparkClip, type VoiceWindow } from "./timelineRecording";
import { madeOf, takeView, TimelineViews, type Made, type Rendered } from "./timelineViews";
import { draftOf, generationOfTake, recipeWithStart, settingsOf, TimelinePlan, type ClipPlan, type TakeLinks } from "./timelinePlan";
import { clipsOfSource, patchedSource, sourceOfRow, TimelineSource, windowRunUp, type SourcePatch, type SourcePlan } from "./timelineSource";
import { faceRoutes, spreadFace, type FaceRoute } from "./timelineFace";
import { TimelineTakes } from "./timelineTakes";
import { cueStretches, laidSong, soundPartsOf, type SoundPart } from "./timelineSong";
import { foldParts, removalOf, removedView, renderedSince, type Removal } from "./timelineRemoved";
import { unusedSize, unusedTakes } from "./timelineUnused";
import { clockOf, derivedKeys, formFilled, FROM_PREVIOUS, laidOut, lengthOf, markJoins, plannedLengthOf, setTrims, STILL_MS, stillRef, takeFollows, takeLandsOn, trimsOf, type AssetRow, type ClipRow, type Placed, type TakeRow, type Taken, type TimelineCore, type TimelineRow, type Tx, mirroredPins, mirrorJson, mirrorOfRow, musicBaseOf, musicClipsOf, musicJson, musicOfRow, transitionJson, transitionOfRow, visible, joinFade } from "./timelineModel";

/**
 * Timelines: clips played one after the other. A clip is a place on the timeline with a form (what to
 * render there); each render of it is a take, and one take plays. A clip can carry on from the clip
 * before it: the take then remembers which take it carried on from, so that when that one changes the
 * join is known to be stale. A clip can also be a picture held on screen (a still). Nothing here knows
 * which model a clip is made with: it reads the recipe's inputs (a clip to carry on from, a clip to
 * arrive at, an opening picture) and fills them in.
 */

// the parts of the model other modules name: the opening-picture placeholder and the clock (timelineModel.ts), a clip's plan (timelinePlan.ts)
export { clockOf, FROM_PREVIOUS };
export type { ClipPlan, TakeLinks };

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
  /** A sound's cut: its loudness evened out (EBU R128, -16 LUFS). */
  even?: boolean;
  factor?: 2 | 4;
  /** How the frames in between are made: RIFE on the GPU through ComfyUI, or ffmpeg on the processor. */
  engine?: "rife" | "ffmpeg";
  clip?: string;
  /**
   * "finish": the route, how much larger, SeedVR2's colour match, the pixel route's model. "face": Face refine on the take's
   * own frames, for a model that keeps no latent (SCAIL-2 at 24 fps); H3's is a render from its latent.
   */
  route?: "seedvr" | "rtx" | "model" | "face";
  /** "face": the denoise on the smallest faces, the picture of the person (an asset), the model family whose files it loads. */
  faceDenoise?: number;
  picture?: string;
  family?: string;
  /**
   * "face": the H3 model the faces are redrawn with, over the family's fused turbo (Finish › Face refine model, card #192, else the
   * clip's form's, card #204): a file, or OWN_MODEL, which on these clips is the fused turbo too (their model is not H3's) and said on the job.
   */
  faceModel?: string;
  /** "face": the steps the clip's form typed for its Face refine (none: by the model, 4 on a turbo, more on a full model). */
  faceSteps?: number;
  by?: number;
  colour?: string;
  upscaleModel?: string;
  /** "finish" with SeedVR2: frames restored together, 0 = by the frame's size. */
  seedvrFrames?: number;
  /** "finish" with SeedVR2: its model file, over the one Settings › Models has (card #159). */
  seedvrModel?: string;
  /** "finish": RCAS on the finished frames, 0 to 1; 0 or none = off. */
  sharpen?: number;
  /** "finish": the start of the video that is never seen (a continuation's hidden run-up, hiddenRunUp): enlarged plainly, not restored. */
  hiddenMs?: number;
  finishedFrom?: string;
  /**
   * The job whose video it works on, in place of `asset` (read when it runs): a finish after a Face refine of the same clip,
   * queued behind it (the rethink's Finish: Face refine first, then SeedVR2, RTX or a model).
   */
  fromJob?: string;
  /** Made after a Face refine of the same clip, at this denoise: part of what the finish was, for a redo to compare. */
  faceFirst?: number;
  /**
   * That Face refine's model, when the finish picked one over the clip's own form's (card #159): for a redo to compare too,
   * the cut itself loads no model. Left out when none was picked, so the finishes made before it keep their key (card #190).
   */
  faceFirstModel?: string;
  /** The timeline it is cut in, without a clip: its folder is where the new videos land (folderForMade). */
  timeline?: string;
}

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
  /** A copy for the web, under this many megabytes: its long edge at most 1280, 30 pictures a second (webCut in cut.ts). */
  webMb?: number;
}

export interface ClipPatch {
  recipe?: string;
  inputs?: Record<string, unknown>;
  joined?: ClipRow["joined"];
  /** The cut's transition into it; null = a plain cut. Given to a clip that extends (and no `joined`), it makes the join a cut. */
  transition?: Transition | null;
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
  /** Rendered to end where the next clip begins (see the clips' fit_next). */
  fitNext?: boolean;
  /** Of a still: how long it is held. */
  stillMs?: number;
  /** Of a still: make it a clip to render, opening on the picture. */
  animate?: boolean;
  /** Its own cast, places and style; null = the timeline's again. */
  look?: Look | null;
  /** The conversation with the designer about this clip: kept as it is. */
  chat?: unknown[];
  designer?: { llm?: string; instruction?: string } | null;
  /** What it asks of the music under it; null = as the rest of the video again. */
  music?: ClipMusic | null;
  /** Its pinned pictures flipped left to right at render time (Mirror), by input id: true flips one, false turns it back. The others stay as they are. */
  pinMirror?: Record<string, boolean>;
  /** The take whose settings `recipe`, `inputs` and `pinMirror` put back (Use this take's settings): one step for Undo, named after it. */
  settingsOf?: string;
  /**
   * Of a clip made from the source, how its settings go with the other clips' (sameForm). Left out, what changes in its
   * `inputs` is every clip's; "apart": this clip's own, the others keep theirs; "inLine": its own settings back to the
   * others'; "toAll": its own settings given to every clip.
   */
  share?: "apart" | "inLine" | "toAll";
}
export interface TimelinePatch {
  name?: string;
  width?: number | null;
  height?: number | null;
  /** `fromMs`: where in the song it plays from; `startClip`: the clip it starts with (null: the first). */
  music?: { asset?: string | null; volume?: number; fadeInMs?: number; fadeOutMs?: number; duck?: boolean; duckDb?: number; fromMs?: number; startClip?: string | null };
  /** Who is in the video and how it looks: used by every clip that has no cast of its own. */
  look?: Look | null;
  /** The look and mood of the whole video, in words. */
  mood?: string;
  /** The project it belongs to (null: the Inbox), and the folder its renders land in (null: the project's root). */
  project?: string | null;
  folder?: string | null;
  /** Its source lane: a new video, changes to the one there, or null to take it away (timelineSource.ts). */
  source?: SourcePatch;
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

/**
 * The number a new timeline is named with among its project's `names`: after the highest "Timeline N" there, and never below
 * how many there are (a project whose timelines were all renamed goes on from its count, as it did).
 */
function nextTimelineNumber(names: readonly string[]): number {
  const numbered = names.map((n) => /^Timeline (\d+)$/.exec(n.trim())?.[1]).filter((n): n is string => n !== undefined).map(Number);
  return Math.max(names.length, ...numbered) + 1;
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
  /** What each H3 clip does with its person's picture, and giving a changed one to the clips after it (timelineFace.ts, card #223). */
  /** A source's windows and a recording's Lip sync clips, made, trimmed and cut again (timelineSource.ts, timelineRecording.ts). */
  readonly source: TimelineSource;
  readonly recording: TimelineRecording;
  readonly face: { routes(timelineId: string): Promise<Record<string, FaceRoute>>; spread(clipId: string): Promise<{ from: number; to: number }> };
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
      row: (id) => this.row(id), clipRow: (id) => this.clipRow(id), assetRow: (id) => this.assetRow(id), placed: (id, db) => this.placed(id, db),
      remember: (id, label, added, db) => this.remember(id, label, added, db), oneAtATime: (key, work) => this.history.oneAtATime(key, work), touch: (id) => this.touch(id), keep: (id, db) => this.keep(id, db), renumber: (id, order, db) => this.renumber(id, order, db),
      settingsOf, frame: (video, atMs, once, timeline) => this.media.frame(video, atMs, once, timeline), motion: (id, row) => this.media.motion(id, row),
      cutRuns: (id, ids, tx) => this.cutRuns(id, ids, tx as Tx),
    };
    this.range = new TimelineRange(core);
    this.media = new TimelineMedia(core);
    this.exporter = new TimelineExport(core, (asset) => this.media.means(asset), (p, prior, next) => this.soundPartsFor(p, prior, next));
    this.takes = new TimelineTakes(core);
    this.planner = new TimelinePlan(core, this.takes, this.media);
    this.face = { routes: (id) => faceRoutes(core, id), spread: (clip) => spreadFace(core, clip) };
    this.history = new TimelineHistory(db, (id) => this.row(id), () => this.changed(), (id) => this.partKeys(id));
    this.views = new TimelineViews(db);
    this.source = new TimelineSource(core, this.planner, this.media, { busyOf: (ids, db) => this.busyOf(ids, db), runsOf: (t, all) => this.runsOf(t, all), edit: (id, patch) => this.edit(id, patch) });
    this.recording = new TimelineRecording(core, this.planner, this.media, { busyOf: (ids, db) => this.busyOf(ids, db) });
  }

  /** Keep what the timeline looks like now, before a change (see TimelineHistory.remember). */
  private remember(timelineId: string, label: string, added?: string, db?: Db): Promise<number> {
    return this.history.remember(timelineId, label, added, db);
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
  private async placed(timelineId: string, db: Db = this.db): Promise<Placed[]> {
    return (await this.placedOf([timelineId], db)).get(timelineId) ?? [];
  }

  /**
   * The same for several timelines at once, by timeline: one query each for the clips, the takes and the files they show.
   * `playing`: each clip with the take that plays only (its length and joins are the same; the other takes are not read).
   */
  private async placedOf(timelineIds: string[], db: Db = this.db, playing = false): Promise<Map<string, Placed[]>> {
    const out = new Map<string, Placed[]>(timelineIds.map((id) => [id, []]));
    if (!timelineIds.length) return out;
    const clips = await db.selectFrom("clips").selectAll().where("timeline_id", "in", timelineIds).orderBy("position").orderBy("created_at").execute();
    if (!clips.length) return out;
    const shown = playing ? clips.flatMap((c) => (c.take_id ? [c.take_id] : [])) : [];
    const takes = playing
      ? shown.length ? await db.selectFrom("takes").selectAll().where("id", "in", shown).orderBy("created_at").execute() : []
      : await db.selectFrom("takes").selectAll().where("clip_id", "in", clips.map((c) => c.id)).orderBy("created_at").execute();
    const wanted = [
      ...takes.map((t) => t.asset_id),
      ...clips.flatMap((c) => [c.still_asset_id, c.sound_asset_id, ...this.pinned(c).map((p) => p.id)]).filter((x): x is string => Boolean(x)),
    ];
    const assets = wanted.length ? await db.selectFrom("assets").selectAll().where("id", "in", [...new Set(wanted)]).execute() : [];
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

  /**
   * Whether the clip at `i` still follows the one before it: "fresh", "stale", "cut" (it never did), or null (nothing to
   * compare yet). `asSeamless`: as it would be made seamless again, its hard cut set aside: what the join panel says a
   * switch back does (fresh: no render, the take carries on as it was made; stale: it needs a new take).
   */
  private joinState(all: Placed[], i: number, asSeamless = false): "fresh" | "stale" | "cut" | null {
    if (i === 0) return null;
    const a = all[i - 1]!;
    const b = all[i]!;
    if ((b.clip.joined === "cut" && !asSeamless) || b.clip.kind === "still") return "cut";
    if (!b.active) return null;
    // after a picture: the clip follows it when it was made to open on that picture
    if (a.clip.kind === "still") return a.still && b.active.take.prev_take_id === stillRef(a.still.id) && b.active.take.trim_start_ms === 0 ? "fresh" : "stale";
    if (!a.active) return null;
    // a finished take stands for its draft: a clip rendered against the draft still follows it (links are copied to the finished take)
    return takeFollows(b.active.take, a.active) || takeLandsOn(a.active.take, b.active) ? "fresh" : "stale";
  }

  /**
   * Whether the take that plays was rendered with other flips than the clip's Mirror asks now (on its pinned pictures that a
   * render flips, see mirroredPins): a take that is not the clip's as it stands, to render again. A finished take answers for
   * its draft; a video not rendered here was flipped nowhere.
   */
  private mirrorChanged(all: Placed[], i: number, flipped: Map<string, string[]>): boolean {
    const p = all[i]!;
    const recipe = p.clip.kind === "video" && p.clip.recipe_id ? this.registry.recipe(p.clip.recipe_id) : undefined;
    if (!recipe || !p.active) return false;
    const asked = mirroredPins(recipe, JSON.parse(p.clip.inputs) as Record<string, unknown>, mirrorOfRow(p.clip), { carries: i > 0 && p.clip.joined === "continue" });
    const draft = p.active.take.finished_from ? p.takes.find((x) => x.take.id === p.active!.take.finished_from) ?? p.active : p.active;
    const made = (draft.asset.generation_id && flipped.get(draft.asset.generation_id)) || [];
    return asked.join() !== [...made].sort().join();
  }

  /** A video clip with a model here and its form filled, as the editor's ready() reads it (see formFilled). */
  renderable(all: Placed[], i: number): boolean {
    const p = all[i]!;
    const recipe = p.clip.kind === "video" && p.clip.recipe_id ? this.registry.recipe(p.clip.recipe_id) : undefined;
    if (!recipe) return false;
    return formFilled(recipe, JSON.parse(p.clip.inputs) as Record<string, unknown>, { carries: i > 0 && p.clip.joined === "continue", afterStill: all[i - 1]?.clip.kind === "still" });
  }

  /**
   * Every timeline as the projects tree lists it, newest first: its clips, how long it plays, the size of its videos (its takes'
   * and its export, each once, none in the bin) and whether it has an export. A few queries for all of them. `playingOnly`
   * (the command bar's index, which says no size): only the takes that play are read, a third of the rows, and `bytes`
   * counts those alone.
   */
  async leaves(opts: { playingOnly?: boolean } = {}) {
    const rows = await this.db.selectFrom("timelines").selectAll().where("owner_id", "=", OWNER).orderBy("updated_at", "desc").execute();
    const placed = await this.placedOf(rows.map((t) => t.id), this.db, opts.playingOnly);
    const exports = rows.flatMap((t) => (t.export_asset_id ? [t.export_asset_id] : []));
    const live = new Map(exports.length ? (await this.db.selectFrom("assets").select(["id", "bytes", "kept_bytes"]).where("id", "in", exports).where("deleted_at", "is", null).execute()).map((a) => [a.id, spaceOf(a)]) : []);
    return rows.map((t) => {
      const all = placed.get(t.id) ?? [];
      const sizes = new Map<string, number>();
      for (const p of all) for (const x of p.takes) if (!x.asset.deleted_at) sizes.set(x.asset.id, spaceOf(x.asset));
      const exported = t.export_asset_id !== null && live.has(t.export_asset_id);
      if (exported) sizes.set(t.export_asset_id!, live.get(t.export_asset_id!)!);
      return {
        id: t.id, name: t.name, projectId: t.project_id, folderId: t.folder_id, clips: all.length, durationMs: all.reduce((sum, p) => sum + lengthOf(p), 0),
        // what the editor's header says: the clips with nothing rendered yet at the length their form asks for
        plannedMs: all.reduce((sum, p) => sum + plannedLengthOf(p, p.clip.recipe_id ? this.registry.recipe(p.clip.recipe_id) : undefined, sourceOfRow(t.source)?.hidden?.[p.clip.id]), 0),
        bytes: [...sizes.values()].reduce((a, b) => a + b, 0), exported, createdAt: t.created_at, updatedAt: t.updated_at,
      };
    });
  }

  /** How long each clip of a timeline is drawn, by clip: what it plays, else the length its form asks for (plannedLengthOf, the editor's header's sum). */
  async plannedOf(id: string): Promise<Map<string, number>> {
    const t = await this.row(id);
    const hidden = sourceOfRow(t.source)?.hidden;
    return new Map((await this.placed(id)).map((p) => [p.clip.id, plannedLengthOf(p, p.clip.recipe_id ? this.registry.recipe(p.clip.recipe_id) : undefined, hidden?.[p.clip.id])]));
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
        // and how long each of them plays, so a frame is as wide as its clip is long
        lengths: all.slice(0, 12).map(lengthOf),
        // clips with nothing to play yet that can render (a model, the form filled: the editor's Render all), and joins that no longer follow on
        toRender: all.filter((p, i) => !p.active && this.renderable(all, i)).length,
        staleJoins: all.filter((_, i) => this.joinState(all, i) === "stale").length,
      };
    });
    return { items };
  }

  /**
   * A timeline as the editor and MCP read it. `made: false`: its takes' Made left out (null), as the browser gets them
   * (timelines-api.ts sent): read for one clip at a time (madeOfClip), they were a third of the answer (card #242).
   */
  async view(id: string, opts: { made?: boolean } = {}) {
    const t = await this.row(id);
    const all = await this.placed(id);
    const { live, last } = await this.views.jobsOf(all.map((p) => p.clip.id));
    const rendered = await this.views.renderedOf(all);
    const flipped = await this.views.mirrorsOf(all);
    const renderOf = (x: Taken, takes: Taken[]) => {
      const own = x.asset.generation_id ? rendered.get(x.asset.generation_id) : undefined;
      if (own?.measure || !x.take.finished_from) return own;
      // a finished take (an upscale, made by a cut) is not measured: it has the figures of the video it was cut from, the
      // same frames (a Face refine's, when the upscale came after one: its faces), else of the take it was finished from, so
      // that clips still compare like for like whether they play their finished take or not
      const cutFrom = x.asset.source_id ? takes.find((y) => y.asset.id === x.asset.source_id && y.asset.generation_id && rendered.get(y.asset.generation_id)?.measure) : undefined;
      const from = cutFrom ?? takes.find((y) => y.take.id === x.take.finished_from);
      const source = from?.asset.generation_id ? rendered.get(from.asset.generation_id) : undefined;
      return source?.measure ? { genMs: own?.genMs ?? null, measure: source.measure, recipe: own?.recipe ?? source.recipe, facePass: own?.facePass ?? false } : own;
    };
    // a take's sound laid from a recording (Lip sync, or a form it plays over): by the recipe it was rendered with, else its
    // clip's, and what that render was sent (a Video with audio take made under no recording keeps its own sound)
    const laid = (recipe: string | null | undefined, made: Record<string, unknown> | undefined) => {
      const inputs = this.registry.recipe(recipe ?? "")?.inputs ?? [];
      return { sound: laysSound(inputs, made), sung: sungHead(inputs, made ?? {}) };
    };
    const viewOf = (takes: Taken[], clipRecipe: string | null) => (x: Taken) => {
      const r = renderOf(x, takes);
      // its own render's form: a finish's, made from a draft, is the draft's frames and sound (a finish made by a cut, no
      // render of its own, reads the draft's: else its head was said guessed, and the sound no longer handed over into it)
      const made = generationOfTake(x, takes);
      const own = made ? rendered.get(made) : undefined;
      return takeView(x, r, laid(r?.recipe ?? clipRecipe, own?.inputs), opts.made === false ? null : this.madeOfTake(x, takes, rendered));
    };
    let at = 0;
    const hidden = sourceOfRow(t.source)?.hidden;
    const songParts = await Promise.all(all.map((p, i) => this.soundPartsFor(p, all[i - 1], all[i + 1])));
    const clips = all.map((p, i) => {
      const length = lengthOf(p);
      const job = live.get(p.clip.id);
      const ended = last.get(p.clip.id);
      const view = {
        id: p.clip.id, kind: p.clip.kind, joined: p.clip.joined, join: this.joinState(all, i), recipe: p.clip.recipe_id,
        /** A hard cut: how its join would be made seamless again (fresh: its take still carries on from the clip before's, no render). */
        ...(p.clip.joined === "cut" && i > 0 ? { joinIfSeamless: this.joinState(all, i, true) } : {}),
        inputs: JSON.parse(p.clip.inputs) as Record<string, unknown>,
        /** What its take will hide of its end (a window run past a part kept removed): drawn that much shorter until it plays. */
        ...(hidden?.[p.clip.id] ? { hiddenMs: hidden[p.clip.id] } : {}),
        take: p.active ? viewOf(p.takes, p.clip.recipe_id)(p.active) : null,
        takes: p.takes.map(viewOf(p.takes, p.clip.recipe_id)),
        still: p.still ? assetView(p.still) : null,
        /** The pictures pinned on its form: first frame, last frame, keyframe. */
        pictures: p.pictures.map((x) => ({ input: x.input, role: x.role, asset: assetView(x.asset) })),
        sound: p.clip.sound, soundAsset: p.sound ? assetView(p.sound) : null, volume: p.clip.volume, fill: Boolean(p.clip.fill),
        /** Rendered to end where the next clip begins: what a render that does not say goes by. */
        fitNext: p.clip.fit_next !== 0,
        /** Its own cast and style; null = the timeline's. */
        look: p.clip.look ? (JSON.parse(p.clip.look) as Look) : null,
        chat: p.clip.chat ? (JSON.parse(p.clip.chat) as unknown[]) : [],
        designer: p.clip.designer ? (JSON.parse(p.clip.designer) as { llm?: string; instruction?: string }) : null,
        /** What it asks of the music under it; null = as the rest. */
        music: musicOfRow(p.clip),
        /** The cut's transition into it, kept while it extends (it plays again once the join is a cut); null = none. */
        transition: transitionOfRow(p.clip),
        /** Its pinned pictures flipped left to right at render time (Mirror), by input id; and whether the take that plays was rendered otherwise. */
        pinMirror: mirrorOfRow(p.clip),
        mirrorChanged: this.mirrorChanged(all, i, flipped),
        /** Where it starts on the timeline, and how long it plays. */
        atMs: at, lengthMs: length,
        /** What is heard of it as parts: the song under it played from its recording, else its take's own (timelineSong.ts), the player's and the export's alike. */
        ...(songParts[i] ? { soundParts: songParts[i] } : {}),
        job: job ? { id: job.id, status: job.status } : null,
        /** Why the last render gave nothing, until another one is asked for. */
        failed: !job && ended?.status === "failed" ? ended.error : null,
      };
      at += length;
      return view;
    });
    // its voice recordings, each under its Lip sync clips on the Audio row, with what a trim set aside of it
    const head = await this.views.headOf(t);
    // the parts cut out of the source's middle by removing their windows, as the editor marks them (not their rows)
    const ofSource = this.runsOf(t, all).find((r) => r.kind === "source");
    const source = head.source && { ...head.source, removed: ofSource ? (head.source.removed ?? []).map((p) => removedView(p, (row) => ofSource.span(row.clip, false))) : [] };
    return { ...head, source, durationMs: at, clips, recordings: await this.recordingsView(t, all) };
  }

  /** What a take was made with: its draft's form, as what a finish added (its route, its upscale) is not the clip's to take back. */
  private madeOfTake(x: Taken, takes: Taken[], rendered: Map<string, Rendered>): Made | null {
    const draft = draftOf(x, takes);
    const drafted = rendered.get(generationOfTake(draft, takes) ?? "");
    return madeOf(this.registry.recipe(drafted?.recipe ?? ""), drafted, draft.take.prev_take_id);
  }

  /**
   * What each take of a clip was made with (Made, by take id): the take list and "Use this take's settings" read it for the
   * clip they show, rather than every take of the timeline coming with each read of it (card #242).
   */
  async madeOfClip(clipId: string): Promise<Record<string, Made | null>> {
    const c = await this.clipRow(clipId);
    const p = (await this.placed(c.timeline_id)).find((x) => x.clip.id === clipId);
    if (!p) throw notFound("this clip");
    const rendered = await this.views.renderedOf([p]);
    return Object.fromEntries(p.takes.map((x) => [x.take.id, this.madeOfTake(x, p.takes, rendered)]));
  }

  /** A clip's conversation with the designer, read when the designer opens on it (card #242: not with every read of the timeline). */
  async chatOf(clipId: string): Promise<unknown[]> {
    const c = await this.clipRow(clipId);
    return c.chat ? (JSON.parse(c.chat) as unknown[]) : [];
  }

  /**
   * What is heard of a clip, as parts (timelineSong.ts): its take's recording played from the recording itself, its own
   * sound where the file is not that recording (a cue, the model's moment before the words, a last clip's faded tail). Null
   * where its sound stays its take's own as before: not its own sound heard, no recording laid in it, a transition into it
   * or out of it (their sound fades), a fade from or to a landing or a dissolve, or the recording's gain unknown. The view
   * gives the player these parts and the export lays the same ones.
   */
  async soundPartsFor(p: Placed, prior: Placed | undefined, next: Placed | undefined): Promise<SoundPart[] | null> {
    const x = p.active;
    if (!x || p.clip.kind !== "video" || p.clip.sound !== "own" || !x.asset.has_sound) return null;
    if ((prior && transitionOfRow(p.clip)) || (next && transitionOfRow(next.clip))) return null;
    if (joinFade(x, p.clip.joined === "continue" && prior?.clip.kind === "video")) return null;
    if (next?.active && next.clip.kind === "video" && joinFade(next.active, next.clip.joined === "continue")) return null;
    const genId = generationOfTake(x, p.takes);
    const gen = genId ? await this.db.selectFrom("generations").select(["recipe_id", "inputs"]).where("id", "=", genId).executeTakeFirst() : undefined;
    const recipe = this.registry.recipe(gen?.recipe_id ?? p.clip.recipe_id ?? "");
    const made = gen ? (JSON.parse(gen.inputs) as Record<string, unknown>) : undefined;
    const song = laidSong(recipe?.inputs ?? [], made, x.take.head_ms);
    const recording = song ? await this.assetRow(song.asset) : undefined;
    if (!song || !recording) return null;
    const gainDb = song.even ? await this.media.songGain(recording) : 0;
    if (gainDb === null) return null;
    const cues = cueStretches(made?.cues as CueValue[] | undefined, x.take.head_ms, recipe?.traits?.fps ?? 24);
    return soundPartsOf({ song, take: x.asset.id, shown: visible(x), gainDb: Math.round(gainDb * 100) / 100, cues });
  }

  // ---------------------------------------------------------------- editing

  async create(name: string | undefined, project?: string | null, folder?: string | null, chosen = false) {
    const id = newId();
    const at = now();
    // numbered within its project (or the Inbox): each is its own workspace. Counted and written in the project's turn:
    // two made at once were given the same number. After the highest "Timeline N" there, not after how many there are: a
    // number came back after a deletion (card #225, two "Timeline 17" in one project)
    await this.history.oneAtATime(`new-timeline:${project ?? ""}`, async () => {
      const names = (await this.db.selectFrom("timelines").select("name").where("project_id", project ? "=" : "is", project ?? null).execute()).map((r) => r.name);
      await this.db
        .insertInto("timelines")
        .values({
          id, owner_id: OWNER, name: name?.trim() || `Timeline ${nextTimelineNumber(names)}`, width: null, height: null, project_id: project ?? null, folder_id: folder ?? null, folder_chosen: chosen ? 1 : 0,
          music_asset_id: null, music_volume: 60, music_fade_in_ms: 1000, music_fade_out_ms: 3000, music_duck: 1, music_duck_db: 10, music_from_ms: 0, music_start_clip_id: null, export_asset_id: null, look: null, mood: null,
          created_at: at, updated_at: at,
        })
        .execute();
    });
    this.changed();
    return this.view(id);
  }

  async edit(id: string, patch: TimelinePatch) {
    // in the timeline's turn, read and written as one: a source saved while a Split ran wrote back the start it had read
    // before the Split moved it, and the next Make covered the same seconds twice
    const { moved } = await this.history.oneAtATime(id, () => this.editInTurn(id, patch));
    // what it made followed it: which items, and from which folders, is not counted here
    if (moved) this.events.emit("library", { change: "moved" } satisfies LibraryChange);
    if (patch.music?.asset) await this.keep(patch.music.asset);
    if (patch.source?.asset) await this.keep(patch.source.asset);
    this.changed();
    return this.view(id);
  }

  /** A timeline's own settings changed (edit), in its turn. Whether it moved (another project or folder). */
  private async editInTurn(id: string, patch: TimelinePatch): Promise<{ moved: boolean }> {
    const before = await this.row(id);
    if (patch.project && !(await this.db.selectFrom("projects").select("id").where("id", "=", patch.project).executeTakeFirst())) throw notFound("this project");
    // the frame is one thing: a width without a height (or the other way round) would be set to nothing at all
    if ((patch.width === undefined) !== (patch.height === undefined)) throw httpError("The width and the height go together: send both, or null for both to let the first clip rendered decide.");
    const m = patch.music;
    if (m?.asset) {
      const sound = await this.assetRow(m.asset);
      if (!sound || (sound.kind !== "audio" && !(sound.kind === "video" && sound.has_sound))) throw httpError("The music has to be an audio file, or a video with audio.");
    }
    if (m?.startClip && !(await this.db.selectFrom("clips").select("id").where("id", "=", m.startClip).where("timeline_id", "=", id).executeTakeFirst())) throw notFound("this clip");
    // the part of the song: within it (another song starts from its beginning, unless said otherwise)
    // its source lane: a video, its stretch within it, and where its start sits (a new one: where the clips end now)
    let source: string | null | undefined;
    if (patch.source === null) source = null;
    else if (patch.source) {
      const video = await this.assetRow(patch.source.asset ?? sourceOfRow(before.source)?.asset ?? null);
      if (!video || video.kind !== "video") throw httpError("The source has to be a video of the library.");
      const all = await this.placed(id);
      const hidden = sourceOfRow(before.source)?.hidden;
      const end = all.reduce((sum, p) => sum + plannedLengthOf(p, p.clip.recipe_id ? this.registry.recipe(p.clip.recipe_id) : undefined, hidden?.[p.clip.id]), 0);
      source = JSON.stringify(patchedSource(sourceOfRow(before.source), patch.source, video, end));
    }
    // the source taken away takes the clips it made with it, rendered or not (Undo brings back the source, its clips and their takes)
    const gone = patch.source === null && sourceOfRow(before.source) ? clipsOfSource(sourceOfRow(before.source)!, (await this.placed(id)).map((p) => p.clip), (r) => this.registry.recipe(r)) : [];
    const songMs = m?.fromMs !== undefined ? (await this.assetRow(m.asset ?? before.music_asset_id))?.duration_ms ?? null : null;
    const fromMs = m?.fromMs !== undefined ? Math.max(0, Math.min(songMs ?? Infinity, Math.round(m.fromMs / 100) * 100)) : m?.asset ? 0 : undefined;
    await this.remember(
      id,
      patch.name !== undefined ? "the new name" : patch.width !== undefined ? "the new aspect ratio" : patch.look !== undefined ? "the change of characters" : patch.mood !== undefined ? "the look and mood" : patch.project !== undefined ? "the project" : patch.folder !== undefined ? "the folder" : patch.source === null ? (gone.length ? `the source and its ${plural(gone.length, "clip")} removed` : "the source removed") : patch.source?.asset ? "the new source" : patch.source ? "the source's settings" : m?.asset === null ? "the music removed" : m?.asset ? "the new music" : m?.fromMs !== undefined || m?.startClip !== undefined ? "the part of the song" : "the music's settings",
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
          ...(m?.duckDb !== undefined ? { music_duck_db: within(m.duckDb, 3, 30) } : {}),
          ...(fromMs !== undefined ? { music_from_ms: fromMs } : {}),
          ...(m?.startClip !== undefined ? { music_start_clip_id: m.startClip } : {}),
          ...(patch.look !== undefined ? { look: patch.look ? JSON.stringify(patch.look) : null } : {}),
          ...(patch.mood !== undefined ? { mood: patch.mood.trim() || null } : {}),
          ...(source !== undefined ? { source } : {}),
          updated_at: now(),
        })
        .where("id", "=", id)
        .execute();
      if (gone.length) {
        await tx.deleteFrom("clips").where("id", "in", gone).execute();
        await this.renumber(id, (await this.placed(id, tx)).map((p) => p.clip.id), tx);
      }
      if (patch.source?.inputs) await this.sameForm(id, null, patch.source.inputs, tx);
      // the person a swap replaces picked again once its clips are made: the first window takes the click, as Make gave it
      if (patch.source && "pick" in patch.source && source) await this.pickOnFirst(id, sourceOfRow(source)!, tx);
      // what it made follows it to its new folder
      if (moved) await timelineMediaFollows(tx, id);
    });
    return { moved };
  }

  /**
   * A source's windows are made with one form (the owner, 2026-10-18: one form, the clip's, no source form of its own). A
   * change on one of the clips made from the source, or given with the source's form (`inputs` of the source's own), is
   * set on the source and on every clip made from it: all of the form but each window's part of the driving video, the
   * clip it carries on from and its seed. A clip set apart on a setting keeps its own (`share`, SourcePlan.apart). A
   * Picture taken away is not taken from the others. A clip of another video, or of a model that cuts it otherwise, is
   * left alone. The windows may have forms of their own among one grid's (Swap character, Motion transfer: card #42): a
   * setting goes to every window, read by those whose form has it and kept unread by the others (it comes back with that
   * form). Its takes stay; its next take is made with the new form.
   */
  private async sameForm(timelineId: string, from: Pick<ClipRow, "id" | "recipe_id" | "inputs"> | null, inputs: Record<string, unknown>, tx: Db, share?: ClipPatch["share"]) {
    const t = await tx.selectFrom("timelines").select(["source"]).where("id", "=", timelineId).executeTakeFirst();
    const plan = sourceOfRow(t?.source);
    if (!plan?.recipe) return;
    const source = this.registry.recipe(plan.recipe);
    if (!source?.traits?.windows) return;
    // the forms a window of the source may have: the source's, and those that cut it alike (sameWindowGrid)
    const ofGrid = (id: string | null) => {
      const r = id ? this.registry.recipe(id) : undefined;
      const d = r?.inputs.find((i) => i.type === "clip" && i.role === "source" && i.window);
      return r && (r.id === source.id || sameWindowGrid(source, r)) && d?.type === "clip" && d.window ? { recipe: r, driving: d as typeof d & { window: NonNullable<typeof d.window> } } : undefined;
    };
    const bound = (form: NonNullable<ReturnType<typeof ofGrid>>, inp: Record<string, unknown>) => (inp[form.driving.id] as { asset?: string } | undefined)?.asset === plan.asset;
    const mineForm = ofGrid(from ? from.recipe_id : source.id);
    if (!mineForm || (from && !bound(mineForm, inputs))) return;
    const { recipe, driving } = mineForm;
    const pictures = new Set(recipe.inputs.filter((i) => i.type === "image").map((i) => i.id));
    const ids = recipe.inputs.filter((i) => i.type !== "clip" && i.id !== "seed" && i.id !== driving.window.start && i.id !== driving.window.seconds).map((i) => i.id);
    const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const was = from ? (JSON.parse(from.inputs) as Record<string, unknown>) : {};
    const clips = (await tx.selectFrom("clips").select(["id", "inputs", "recipe_id"]).where("timeline_id", "=", timelineId).execute())
      .map((c) => ({ id: c.id, inputs: JSON.parse(c.inputs) as Record<string, unknown>, form: ofGrid(c.recipe_id) }))
      .filter((c) => c.form && bound(c.form, c.inputs));
    // what each clip keeps its own, the ones gone forgotten
    const apart: Record<string, string[]> = Object.fromEntries(Object.entries(plan.apart ?? {}).filter(([id]) => clips.some((c) => c.id === id)));
    const mine = from ? apart[from.id] ?? [] : [];
    const changed = from ? ids.filter((k) => !same(was[k], inputs[k])) : ids.filter((k) => k in inputs);
    // what each window keeps its own (its prompt) goes to the others only when given to all; the run-up is the cut's, the
    // same in every window whatever is set apart (a window carrying on from another count would no longer meet its part)
    const ownIds = new Set([source, recipe, ...clips.map((c) => c.form!.recipe)].flatMap((r) => r.traits?.windows?.own ?? []));
    const runUp = recipe.traits?.windows?.runUp?.input;
    // the values every clip in line takes (undefined: back to the model's own), and whether they go over what others keep
    let spread: Record<string, unknown> = {};
    let over = false;
    if (from && share === "apart") {
      apart[from.id] = [...new Set([...mine, ...changed])].filter((k) => k !== runUp && !ownIds.has(k));
      if (runUp && changed.includes(runUp)) spread = { [runUp]: inputs[runUp] };
    }
    else if (from && share === "inLine") {
      // its own settings as the others have them: a clip in line on each, else the source's form
      const line = Object.fromEntries(mine.map((k) => {
        const other = clips.find((c) => c.id !== from.id && !(apart[c.id] ?? []).includes(k));
        return [k, other ? other.inputs[k] : plan.inputs[k]];
      }));
      const next = { ...inputs };
      for (const [k, v] of Object.entries(line)) if (v === undefined) delete next[k]; else next[k] = v;
      await tx.updateTable("clips").set({ inputs: JSON.stringify(next), updated_at: now() }).where("id", "=", from.id).execute();
      delete apart[from.id];
    } else if (from && share === "toAll") {
      // given to all: what it keeps apart, what changed, and what each window keeps its own (its prompt) as this one has it
      spread = Object.fromEntries([...new Set([...mine, ...changed, ...ids.filter((k) => ownIds.has(k) && k in inputs)])].map((k) => [k, inputs[k]]));
      over = true;
      delete apart[from.id];
    } else {
      // a Picture taken away is this clip's: the others keep theirs
      spread = Object.fromEntries(changed.filter((k) => !ownIds.has(k) && !(pictures.has(k) && typeof inputs[k] !== "string")).map((k) => [k, inputs[k]]));
      if (from) apart[from.id] = mine.filter((k) => !(k in spread));
    }
    const keys = Object.keys(spread);
    for (const c of keys.length ? clips : []) {
      if (from && c.id === from.id) continue;
      const own = apart[c.id] ?? [];
      const taken = over ? keys : keys.filter((k) => !own.includes(k));
      if (over) apart[c.id] = own.filter((k) => !keys.includes(k));
      if (taken.every((k) => same(c.inputs[k], spread[k]))) continue;
      const next = { ...c.inputs };
      for (const k of taken) if (spread[k] === undefined) delete next[k]; else next[k] = spread[k];
      await tx.updateTable("clips").set({ inputs: JSON.stringify(next), updated_at: now() }).where("id", "=", c.id).execute();
    }
    // the source's form follows (what the next Make takes), and what each clip keeps
    const form = { ...plan.inputs };
    if (from) for (const k of keys) if (spread[k] === undefined) delete form[k]; else form[k] = spread[k];
    const kept = Object.fromEntries(Object.entries(apart).filter(([, v]) => v.length));
    const { apart: _before, ...rest } = plan;
    const next = { ...rest, inputs: form, ...(Object.keys(kept).length ? { apart: kept } : {}) };
    if (!same(next, plan)) await tx.updateTable("timelines").set({ source: JSON.stringify(next) }).where("id", "=", timelineId).execute();
    for (const k of keys) if (pictures.has(k) && typeof spread[k] === "string") await this.keep(spread[k] as string, tx);
  }

  /** The clips of these that have a render or a finish queued or under way. */
  private async busyOf(ids: string[], db: Db = this.db): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await db.selectFrom("jobs").select("clip_id").where("clip_id", "in", ids).where("status", "in", ["queued", "running"]).execute();
    return new Set(rows.flatMap((j) => (j.clip_id ? [j.clip_id] : [])));
  }

  /** The click on the source's first frame (or none) given to the first clip made from it, the one whose window starts there. */
  private async pickOnFirst(timelineId: string, plan: SourcePlan, tx: Db) {
    const placed = await this.placed(timelineId, tx);
    const made = clipsOfSource(plan, placed.map((p) => p.clip), (r) => this.registry.recipe(r));
    const first = placed.find((p) => made.includes(p.clip.id))?.clip;
    const recipe = first?.recipe_id ? this.registry.recipe(first.recipe_id) : undefined;
    const driving = recipe?.inputs.find((i) => i.type === "clip" && i.role === "source" && i.window);
    if (!first || !driving || driving.type !== "clip" || !driving.pick) return;
    const inputs = JSON.parse(first.inputs) as Record<string, unknown>;
    const { pick: _was, ...value } = (inputs[driving.id] ?? {}) as { asset?: string; pick?: unknown };
    const next = { ...inputs, [driving.id]: { ...value, ...(plan.pick ? { pick: plan.pick } : {}) } };
    if (JSON.stringify(next) !== JSON.stringify(inputs)) await tx.updateTable("clips").set({ inputs: JSON.stringify(next), updated_at: now() }).where("id", "=", first.id).execute();
  }

  /**
   * A timeline's recordings and what of each a trim set aside (`parkedTakes`: of those, the rendered), as the editor draws
   * them on the Audio row; and how each is cut into clips (about `seconds`, ± `window`), as its panel shows it.
   */
  private async recordingsView(t: TimelineRow, all: Placed[]) {
    let spanOf: ReturnType<TimelineRecording["recordingSpan"]>;
    try {
      spanOf = this.recording.recordingSpan();
    } catch {
      return [];
    }
    const parked = parkedRecordings(t);
    const cuts = recordingCuts(t);
    const used = all.map((p) => this.recording.recordingUnder(p.clip));
    const ids = [...new Set([...used, ...Object.keys(parked)].filter((x): x is string => typeof x === "string" && Boolean(x)))];
    const rows = ids.length ? await this.db.selectFrom("assets").selectAll().where("id", "in", ids).execute() : [];
    const removed = removedRecordings(t);
    return rows.filter((a) => used.includes(a.id)).map((a) => ({
      asset: assetView(a), parked: parked[a.id]?.length ?? 0, parkedTakes: (parked[a.id] ?? []).filter((row) => row.clip.take_id).length, ...cutOf(cuts, a.id),
      // the parts cut out of its middle by removing their clips, each by the clip after it
      removed: (removed[a.id] ?? []).map((p) => removedView(p, spanOf)),
    }));
  }

  /**
   * A clip's part of a source or recording: the inputs that may not change under a render in the queue, by its form's
   * save as by Undo and Redo (its render would not fit the clip).
   */
  private partKeys(recipeId: string | null): string[] {
    return (recipeId ? this.registry.recipe(recipeId)?.inputs.flatMap((i) => ("window" in i && i.window ? [i.id, i.window.start, i.window.seconds] : [])) : undefined) ?? [];
  }

  /**
   * A voice given to a clip by its form (the recording dropped on its Audio cell, chosen from its menu or opened from a
   * file, or set in its Recording field): the part of it the clip is to take, still to be worked out. A new voice, its part
   * not changed with it, starts at 0; a voice with no length set (a clip given one before this was worked out here) keeps
   * its start. Null when the form leaves nothing to work out.
   */
  private voiceAsked(recipeId: string | null, was: Record<string, unknown>, next: Record<string, unknown>): VoiceAsk | null {
    const recipe = recipeId ? this.registry.recipe(recipeId) : undefined;
    const spec = recipe?.inputs.find((i) => i.type === "audio" && i.role === "sound" && i.window);
    if (!spec || spec.type !== "audio" || !spec.window) return null;
    const w = spec.window;
    const asset = next[spec.id];
    if (typeof asset !== "string" || !asset) return null;
    const seconds = Number(next[w.seconds]);
    const fresh = asset !== was[spec.id] && next[w.start] === was[w.start] && next[w.seconds] === was[w.seconds];
    if (!fresh && Number.isFinite(seconds) && seconds > 0) return null;
    const start = Number(next[w.start]);
    return { asset, window: w, fromS: !fresh && Number.isFinite(start) && start > 0 ? start : 0 };
  }

  /**
   * The part of a recording a clip given it as its voice takes: the whole of it from `fromS`, as much as one clip holds,
   * ended in the pause nearest that most when it is longer (recordingPart: not the first of the parts a recording dropped
   * past the clips is cut into, whose even share of a short last part halved the one clip). Null for what is not a sound of the library. A sound whose pauses
   * cannot be read is cut where one clip ends: the form is saved whatever comes of it.
   */
  private async voicePart(ask: VoiceAsk): Promise<{ start: number; seconds: number } | null> {
    const sound = await this.assetRow(ask.asset);
    if (!sound || !sound.duration_ms || (sound.kind !== "audio" && !(sound.kind === "video" && sound.has_sound))) return null;
    const toS = sound.duration_ms / 1000;
    const { pauses } = await this.media.pauses(sound.id).catch(() => ({ pauses: [] }));
    // a start past the sound's end (a voice changed for a shorter one) starts at 0
    const fromS = ask.fromS < toS - 0.05 ? ask.fromS : 0;
    const { leastS, mostS } = this.recording.clipBounds(ask.window.fits);
    return recordingPart({ fromS, toS, leastS, mostS, pauses });
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

  /**
   * A copy of the timeline beside it (its project and folder), named `name` or "<its name> copy": its clips, their forms
   * and their takes (the same videos of the library, which both play), its music, source and recordings, the clips a trim
   * set aside with them. Not its Undo history, its jobs or its last export. Every id of the copy is new, and every
   * reference between its parts (a clip's take, a take carried on from or finished from, the music's first clip, the
   * source's and recordings' clips) is moved over to the copy's own. Read in the timeline's turn, so that no change is
   * half in it.
   */
  async duplicate(id: string, name?: string) {
    const copy = newId();
    await this.history.oneAtATime(id, async () => {
      const timeline = await this.row(id);
      const clips = await this.db.selectFrom("clips").selectAll().where("timeline_id", "=", id).execute();
      const takes = clips.length ? await this.db.selectFrom("takes").selectAll().where("clip_id", "in", clips.map((c) => c.id)).execute() : [];
      // every id of the timeline's own parts, the clips and takes a trim set aside (in its source and recordings) with them:
      // given new ones wherever they are written, ids of anything else (the library's items, the kit's people) left as they are
      const own = new Map<string, string>([[id, copy], ...[...clips, ...takes].map((r) => [r.id, newId()] as [string, string])]);
      const parked = (v: unknown): void => {
        if (Array.isArray(v)) return v.forEach(parked);
        if (!v || typeof v !== "object") return;
        const o = v as { clip?: { id?: unknown }; takes?: unknown };
        if (o.clip && typeof o.clip.id === "string" && Array.isArray(o.takes)) {
          for (const r of [o.clip, ...(o.takes as Array<{ id?: unknown }>)]) if (typeof r?.id === "string" && !own.has(r.id)) own.set(r.id, newId());
        }
        Object.values(o).forEach(parked);
      };
      for (const text of [timeline.source, timeline.recordings]) {
        try {
          if (text) parked(JSON.parse(text));
        } catch {
          // a source or recordings not read as JSON is copied as it is
        }
      }
      const moved = <T>(row: T): T => JSON.parse(JSON.stringify(row).replace(/[0-9a-f]{32}/g, (x) => own.get(x) ?? x)) as T;
      const at = now();
      await this.db.transaction().execute(async (tx) => {
        await tx.insertInto("timelines").values({
          ...moved(timeline), name: (name?.trim() || `${timeline.name} copy`).slice(0, 200), export_asset_id: null, created_at: at, updated_at: at,
        }).execute();
        for (const c of clips) await tx.insertInto("clips").values({ ...moved(clipColumns(c)), created_at: at, updated_at: at }).execute();
        for (const t of takes) await tx.insertInto("takes").values(moved(takeColumns(t))).execute();
      });
    });
    this.changed();
    return this.view(copy);
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

  /** A file of a linked folder, on the user's disk rather than in Afflatus's storage. */
  private async linkedFile(assetId: string): Promise<boolean> {
    const asset = await this.db.selectFrom("assets").select("file_key").where("id", "=", assetId).executeTakeFirst();
    return Boolean(asset && isLinked(asset.file_key));
  }

  /** Something on a timeline still plays or uses it: another take, a clip's sound or still, a timeline's music. */
  private async stillUsed(assetId: string, except?: string): Promise<boolean> {
    if (await this.db.selectFrom("takes").select("id").where("asset_id", "=", assetId).$if(Boolean(except), (q) => q.where("id", "!=", except!)).executeTakeFirst()) return true;
    if (await this.db.selectFrom("clips").select("id").where((eb) => eb.or([eb("sound_asset_id", "=", assetId), eb("still_asset_id", "=", assetId)])).executeTakeFirst()) return true;
    return Boolean(await this.db.selectFrom("timelines").select("id").where("music_asset_id", "=", assetId).executeTakeFirst());
  }

  /** What is on a timeline is wanted: it never goes to the bin on its own. `db`: the transaction this is part of, when it is part of one. */
  private async keep(assetId: string, db: Db = this.db) {
    await db.updateTable("assets").set({ kept_at: now() }).where("id", "=", assetId).where("kept_at", "is", null).execute();
  }

  /**
   * The clips of a timeline put in this order. Only those whose place changes are written: each written, a clip added at the
   * end of 150 wrote 151 rows, and a recording made into 12 clips 1,878.
   */
  private async renumber(timelineId: string, order: string[], db: Db = this.db) {
    const was = new Map((await db.selectFrom("clips").select(["id", "position"]).where("timeline_id", "=", timelineId).execute()).map((c) => [c.id, c.position]));
    for (const [i, id] of order.entries()) {
      if (was.get(id) !== i) await db.updateTable("clips").set({ position: i }).where("id", "=", id).where("timeline_id", "=", timelineId).execute();
    }
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
    // in the timeline's turn, from the reading of its clips to the writing of the new one: two added at once were both
    // put at the same place, each renumbering the clips without the other
    const id = await this.history.oneAtATime(timelineId, async () => {
      const t = await this.row(timelineId);
      const all = await this.placed(timelineId);
      const index = this.indexAfter(all, opts.after);
      const made = await this.planner.newClip(all, index, opts);
      const stopping = opts.stopAtMs !== undefined ? all[index - 1]?.active : undefined;
      const trims = stopping ? trimsOf(stopping, { shownToMs: opts.stopAtMs }) : null;
      await this.remember(timelineId, made.kind === "still" ? "the image added" : "the clip added");
      // the clip, its place among the others and its take land together, or not at all
      const added = await this.db.transaction().execute(async (tx) => {
        if (stopping && trims) await setTrims(tx, stopping.take.id, { trim_end_ms: trims.end });
        return this.planner.insertClip(timelineId, all, index, made, tx);
      });
      if (made.asset) await this.adoptFolder(t, made.asset, all);
      return added;
    });
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
  async editClip(id: string, patch: ClipPatch, opts: { step?: string } = {}): Promise<{ inputs?: Record<string, unknown> }> {
    const row = await this.clipRow(id);
    const timelineId = row.timeline_id;
    const keys = Object.keys(patch).filter((k) => patch[k as keyof ClipPatch] !== undefined);
    if (keys.length && keys.every((k) => k === "chat" || k === "designer")) {
      // what was said to the designer, and with which language model, is not a change to the timeline: nothing to undo, nothing to redraw
      await this.db.updateTable("clips").set({
        ...(patch.chat !== undefined ? { chat: chatJson(patch.chat) } : {}),
        ...(patch.designer !== undefined ? { designer: patch.designer ? JSON.stringify(patch.designer) : null } : {}),
      }).where("id", "=", id).execute();
      return {};
    }
    // a voice given to the clip: its part worked out before the turn (the first time, ffmpeg reads the sound's pauses), as
    // the clip stood then; in the turn, used if the clip still asks for that part. A clip with a take keeps the part its
    // take was made of: worked out anew, the take would play over a part it was not made of
    const ask = patch.inputs && !row.take_id ? this.voiceAsked(patch.recipe ?? row.recipe_id, JSON.parse(row.inputs) as Record<string, unknown>, patch.inputs) : null;
    const part = ask ? await this.voicePart(ask) : null;
    // in the timeline's turn, from the reading of the clips to the writing: a move worked out from the clips as read put
    // a clip added meanwhile at the same place as another
    const filled = await this.history.oneAtATime(timelineId, () => this.editClipInTurn(id, patch, keys, ask && part ? { ask, part } : null, opts.step));
    await this.touch(timelineId);
    // the form as kept, when the server worked out some of it: the editor shows it in place of what it sent
    return filled ? { inputs: filled } : {};
  }

  /** `step`: the change kept as a step of its own under this label (an MCP token's edit of a form), never folded into the one being typed. */
  private async editClipInTurn(id: string, asked: ClipPatch, keys: string[], voice: { ask: VoiceAsk; part: { start: number; seconds: number } } | null, step?: string): Promise<Record<string, unknown> | null> {
    // read again in the turn: the clip may have changed while the turn was waited for
    const clip = await this.clipRow(id);
    // its voice's part, laid on the form when the clip as it is now still asks for the one worked out (Timelines.voicePart)
    const again = voice && asked.inputs && !clip.take_id ? this.voiceAsked(asked.recipe ?? clip.recipe_id, JSON.parse(clip.inputs) as Record<string, unknown>, asked.inputs) : null;
    const fill = again && voice && again.asset === voice.ask.asset && again.fromS === voice.ask.fromS ? { [again.window.start]: voice.part.start, [again.window.seconds]: voice.part.seconds } : null;
    const patch: ClipPatch = fill ? { ...asked, inputs: { ...asked.inputs, ...fill } } : asked;
    // the form as the clip holds it already (an editor saving again the typing an agent's change was laid over): nothing
    // to write, and no step for Undo to take back that changes nothing
    if (keys.length === 1 && keys[0] === "inputs" && JSON.stringify(patch.inputs) === JSON.stringify(JSON.parse(clip.inputs))) return null;
    const all = await this.placed(clip.timeline_id);
    const checked = await this.checkClipPatch(clip, patch, all);
    if (step && keys.length) await this.remember(clip.timeline_id, step);
    else if (keys.every((k) => k === "inputs" || k === "share") && patch.inputs !== undefined && !patch.share) await this.rememberWriting(clip, all);
    else if (patch.settingsOf !== undefined) await this.remember(clip.timeline_id, `the settings of take ${checked.settingsOf}`);
    else if (keys.length) await this.remember(clip.timeline_id, labelOf(patch));

    const { animate, trims, order, mirror } = checked;
    // switched to a model that cannot carry on from the clip before's (another family, or none that carries on), it starts on
    // its own: a Cut, the default across two models (Extend stays possible, set on the join after, with its warning). The clip
    // after, carrying on from it, is made a cut likewise. Left as it was, it was handed a clip it cannot carry on from (joinWay)
    const at = all.findIndex((p) => p.clip.id === clip.id);
    const modelOf = (p: Placed | undefined) => (p?.clip.kind === "video" && p.clip.recipe_id ? this.registry.recipe(p.clip.recipe_id) : undefined);
    const switched = patch.recipe && patch.recipe !== clip.recipe_id ? this.registry.recipe(patch.recipe) : undefined;
    const prior = at > 0 ? modelOf(all[at - 1]) : undefined;
    const cutHere = Boolean(switched && prior) && patch.joined === undefined && clip.joined === "continue" && joinWay(prior, switched) === "cut";
    const next = at >= 0 ? all[at + 1] : undefined;
    const cutNext = switched && next?.clip.joined === "continue" && modelOf(next) && joinWay(switched, modelOf(next)) === "cut" ? next : undefined;
    // a window of a source made a cut, or made to carry on again: its part of the driving video moves by the frames carried
    const joined = patch.joined ?? (patch.transition || cutHere ? "cut" : undefined);
    const runUp = joined && joined !== clip.joined && !animate
      ? windowRunUp(this.registry.recipe(patch.recipe ?? clip.recipe_id ?? ""), patch.inputs ?? (JSON.parse(clip.inputs) as Record<string, unknown>), joined)
      : null;
    const inputs = runUp ?? patch.inputs;
    await this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("clips")
        .set({
          ...(patch.recipe !== undefined ? { recipe_id: patch.recipe } : {}),
          ...(inputs !== undefined ? { inputs: JSON.stringify(inputs) } : {}),
          ...(patch.joined !== undefined ? { joined: patch.joined } : patch.transition || cutHere ? { joined: "cut" as const } : {}),
          ...(patch.transition !== undefined ? { transition: transitionJson(patch.transition) } : {}),
          ...(patch.take !== undefined ? { take_id: patch.take } : {}),
          ...(patch.soundAsset !== undefined ? { sound_asset_id: patch.soundAsset, sound: patch.sound ?? (patch.soundAsset ? "file" : "own") } : patch.sound !== undefined ? { sound: patch.sound } : {}),
          ...(patch.volume !== undefined ? { volume: Math.max(0, Math.min(100, Math.round(patch.volume))) } : {}),
          ...(patch.fill !== undefined ? { fill: patch.fill ? 1 : 0 } : {}),
          ...(patch.fitNext !== undefined ? { fit_next: patch.fitNext ? 1 : 0 } : {}),
          ...(patch.look !== undefined ? { look: patch.look ? JSON.stringify(patch.look) : null } : {}),
          ...(patch.music !== undefined ? { music: musicJson(patch.music) } : {}),
          ...(mirror !== undefined ? { pin_mirror: mirror } : {}),
          ...(patch.stillMs !== undefined ? { still_ms: Math.max(STILL_MS.least, Math.min(STILL_MS.most, Math.round(patch.stillMs))) } : {}),
          ...(animate
            ? { kind: "video" as const, still_asset_id: null, recipe_id: animate.id, joined: "cut" as const, inputs: JSON.stringify({ [animate.inputs.find((i) => i.type === "image" && i.role === "start")!.id]: clip.still_asset_id }) }
            : {}),
          updated_at: now(),
        })
        .where("id", "=", id)
        .execute();
      if (trims) await setTrims(tx, trims.take, { trim_start_ms: trims.start, trim_end_ms: trims.end });
      if (order) await this.renumber(clip.timeline_id, order, tx);
      if (patch.soundAsset) await this.keep(patch.soundAsset, tx);
      // a window of the source's: what changed in its form is every window's, unless kept to it (share)
      if (patch.inputs !== undefined || patch.share) await this.sameForm(clip.timeline_id, clip, inputs ?? (JSON.parse(clip.inputs) as Record<string, unknown>), tx, patch.share);
      if (cutNext) {
        const moved = windowRunUp(modelOf(cutNext), JSON.parse(cutNext.clip.inputs) as Record<string, unknown>, "cut");
        await tx.updateTable("clips").set({ joined: "cut", ...(moved ? { inputs: JSON.stringify(moved) } : {}), updated_at: now() }).where("id", "=", cutNext.clip.id).execute();
      }
    });
    // a picture pinned on the clip: the timeline takes its folder, as a drop would (within the step just kept)
    if (checked.pinnedNow) {
      const picture = await this.assetRow(checked.pinnedNow);
      if (picture) await this.adoptFolder(await this.row(clip.timeline_id), picture, all);
    }
    return fill ? patch.inputs! : null;
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
    // a clip under a recording stays one of its clips whatever its form (card #72): a model none of them is would take it
    // out without a word, its part left a hole in the song. Leaving the recording is Remove, which cuts the part out
    if (patch.recipe !== undefined && patch.recipe !== clip.recipe_id && this.recording.recordingUnder(clip) && !this.recording.holdsRecording(patch.recipe)) {
      throw httpError(`This clip is under a recording: ${this.recording.formsUnderRecording()} go there. To use another model, remove it from the recording first (its part is cut out).`);
    }
    if (patch.take !== undefined) {
      const take = await this.db.selectFrom("takes").select("id").where("id", "=", patch.take).where("clip_id", "=", id).executeTakeFirst();
      if (!take) throw notFound("this take");
    }
    // the take whose settings are put back (Use this take's settings): its number, for the Undo button
    let settingsOf: number | null = null;
    if (patch.settingsOf !== undefined) {
      settingsOf = (all.find((p) => p.clip.id === id)?.takes.findIndex((t) => t.take.id === patch.settingsOf) ?? -1) + 1;
      if (!settingsOf) throw notFound("this take");
      if (patch.inputs === undefined) throw httpError("Say the settings to put back.");
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
      // a recording's clips and the source's windows keep their order: their In is the first one's part, their Out the
      // last one's, and a removal or a trim reads them in turn. Put out of order, an Out dragged made clips of words
      // already sung, and a re-cut was refused as too short. Another clip may still go between them
      const runs = this.runsOf(await this.row(clip.timeline_id), all);
      const run = runs.find((r) => r.ids.includes(id));
      if (run && order.filter((x) => run.ids.includes(x)).some((x, i) => x !== run.ids[i])) {
        throw httpError(run.kind === "source" ? "The windows of the source play in its order: this one cannot move past another of them." : "The clips of a recording play in its order: this one cannot move past another of them.");
      }
    }
    // the picture newly pinned on its form, if any
    const recipe = patch.inputs ? this.registry.recipe(patch.recipe ?? clip.recipe_id ?? "") : undefined;
    const was = JSON.parse(clip.inputs) as Record<string, unknown>;
    // its part of the source or recording (a voice, its start, its length) is not changed under a render in the queue, as
    // the trims and Undo refuse it: the render would land on a clip it does not fit, and the change could not be undone
    // until the render ended
    const inputs = patch.inputs;
    if (inputs && this.partKeys(clip.recipe_id).some((k) => JSON.stringify(inputs[k] ?? null) !== JSON.stringify(was[k] ?? null)) && (await this.busyOf([id])).size) {
      throw httpError("The clip is rendering or in the queue: let it end, or stop it, to change its voice or its part of the source.", 409);
    }
    const pinned = recipe ? (recipe.inputs as InputSpec[]).find((i) => i.type === "image" && typeof patch.inputs![i.id] === "string" && patch.inputs![i.id] !== was[i.id]) : undefined;
    return { animate, trims, order, pinnedNow: pinned ? (patch.inputs![pinned.id] as string) : null, mirror: this.mirrorAfter(clip, patch), settingsOf };
  }

  /**
   * The clip's flips after the change, as its row keeps them; undefined when they stay as they are. Only a pinned picture of its
   * model is flipped. A pin changed for another picture, or removed, loses its flip: the new picture is shown as it is.
   */
  private mirrorAfter(clip: ClipRow, patch: ClipPatch): string | null | undefined {
    if (patch.pinMirror === undefined && patch.inputs === undefined && patch.recipe === undefined) return undefined;
    const recipe = this.registry.recipe(patch.recipe ?? clip.recipe_id ?? "");
    const images = new Set((recipe?.inputs ?? []).filter((i) => i.type === "image").map((i) => i.id));
    const was = JSON.parse(clip.inputs) as Record<string, unknown>;
    const inputs = patch.inputs ?? was;
    const flips = new Set(mirrorOfRow(clip));
    for (const [id, on] of Object.entries(patch.pinMirror ?? {})) {
      if (!images.has(id)) throw httpError(`${id} is not a pinned frame of this clip's model.`);
      if (on && (typeof inputs[id] !== "string" || !inputs[id])) throw httpError("Pin a picture there first: only a pinned frame is mirrored.");
      if (on) flips.add(id);
      else flips.delete(id);
    }
    for (const id of [...flips]) if (!images.has(id) || (inputs[id] !== was[id] && patch.pinMirror?.[id] === undefined)) flips.delete(id);
    const after = mirrorJson([...flips]);
    return after === (clip.pin_mirror ?? null) ? undefined : after;
  }

  async removeClip(id: string) {
    await this.removeClips((await this.clipRow(id)).timeline_id, [id]);
  }

  /**
   * Clips taken off the timeline, one step for Undo however many (picked with Ctrl+click, they went one step each). One of
   * a recording's Lip sync clips or of the source's windows cuts its part out of it (timelineRemoved.ts, card #75): the
   * first ones go, the In past them; the last ones are set aside as the Out brought in before them sets them aside; a run
   * of them in the middle is set aside as a removed part kept with the clip after it, which becomes a cut (the song's
   * hand-over is off there by itself: the parts no longer meet, TimelinePlan.recordingRun). Any other clip goes as it is.
   * A clip set aside while it renders or waits in the queue is refused, as the trims refuse it: its render would land on no
   * clip. In the timeline's turn and in one transaction: an Undo or a take landing never comes between the removal and the
   * renumbering.
   */
  async removeClips(timelineId: string, ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return;
    await this.row(timelineId);
    await this.history.oneAtATime(timelineId, async () => {
      const all = await this.placed(timelineId);
      const order = all.map((p) => p.clip.id);
      if (unique.some((id) => !order.includes(id))) throw notFound("this clip");
      const gone = new Set(unique);
      const one = all.find((p) => p.clip.id === unique[0])!;
      const label = unique.length > 1 ? `the ${unique.length} clips removed` : one.clip.kind === "still" ? "the image removed" : "the clip removed";
      await this.db.transaction().execute(async (tx) => {
        await this.remember(timelineId, label, undefined, tx);
        await this.cutRuns(timelineId, unique, tx);
        await tx.deleteFrom("clips").where("id", "in", unique).execute();
        await this.renumber(timelineId, order.filter((id) => !gone.has(id)), tx);
      });
    });
    await this.touch(timelineId);
  }

  /**
   * The runs of a recording or the source that clips about to be removed (`ids`) are part of, cut as removeClips cuts them,
   * in the transaction `tx` the removal is made in (removeClips, and In / Out's Remove range: it set them aside the same
   * way, or deleted them with nothing said or kept): the first ones' In moved, the middle ones and the last ones set aside.
   * The clips left for the caller to delete are those not set aside. Refused (409) when one to set aside renders or waits
   * in the queue.
   */
  async cutRuns(timelineId: string, ids: string[], tx: Tx): Promise<void> {
    const t = await tx.selectFrom("timelines").selectAll().where("id", "=", timelineId).executeTakeFirstOrThrow();
    const all = await this.placed(timelineId, tx);
    const gone = new Set(ids);
    const runs = this.runsOf(t, all).map((r) => ({ ...r, removal: removalOf(r.ids, gone) })).filter((r) => r.ids.some((id) => gone.has(id)) && !r.removal.whole);
    if (!runs.length) return;
    const aside = runs.flatMap((r) => [...r.removal.tail, ...r.removal.middles.flatMap((m) => m.ids)]);
    refuseBusy(aside, await this.busyOf(aside, tx), all, "remove it");
    // the clips whose join may change: each one after a part cut out, and the one first now
    const busy = await this.busyOf(runs.flatMap((r) => [...r.removal.middles.map((m) => m.before), ...r.ids.filter((id) => !gone.has(id)).slice(0, 1)]), tx);
    for (const run of runs) await this.cutOut(tx, timelineId, run, all, busy);
  }

  /**
   * The timeline's runs of clips made of one stretch: the source's windows and each recording's Lip sync clips, in order,
   * with the inputs that hold each one's part (`start`, `seconds`) and its part in ms (`span`: `start` where its part
   * begins, `from` where its own frames begin, after those a window that carries on carries, as trimSource reads it).
   */
  private runsOf(t: TimelineRow, all: Placed[]): Run[] {
    const runs: Run[] = [];
    const plan = sourceOfRow(t.source);
    const recipe = plan?.recipe ? this.registry.recipe(plan.recipe) : undefined;
    const driving = recipe?.traits?.windows ? recipe.inputs.find((i) => i.type === "clip" && i.role === "source" && i.window) : undefined;
    if (plan && recipe && driving?.type === "clip" && driving.window) {
      const w = driving.window;
      const fps = recipe.traits!.fps;
      const ofSource = clipsOfSource(plan, all.map((p) => p.clip), (r) => this.registry.recipe(r));
      const ids = all.filter((p) => ofSource.includes(p.clip.id)).map((p) => p.clip.id);
      const span = (clip: RunClip, first: boolean) => {
        const inputs = JSON.parse(String(clip.inputs)) as Record<string, unknown>;
        const start = Number(inputs[w.start]) * 1000;
        const own = clip.joined === "continue" && !first ? start + (carriedOf(this.registry.recipe(String(clip.recipe_id)) ?? recipe, inputs) * 1000) / fps : start;
        return { start, from: own, to: start + Number(inputs[w.seconds]) * 1000 };
      };
      if (ids.length) runs.push({ kind: "source", ids, start: w.start, seconds: w.seconds, span });
    }
    let model: ReturnType<TimelineRecording["recordingModel"]>;
    try {
      model = this.recording.recordingModel();
    } catch {
      return runs;
    }
    const { spec } = model;
    const byAsset = new Map<string, string[]>();
    for (const p of all) {
      const asset = this.recording.recordingUnder(p.clip);
      if (asset) byAsset.set(asset, [...(byAsset.get(asset) ?? []), p.clip.id]);
    }
    const span = (clip: RunClip) => {
      const inputs = JSON.parse(String(clip.inputs)) as Record<string, unknown>;
      const start = Number(inputs[spec.window.start]) * 1000;
      return { start, from: start, to: start + Number(inputs[spec.window.seconds]) * 1000 };
    };
    for (const [asset, ids] of byAsset) runs.push({ kind: "recording", asset, ids, start: spec.window.start, seconds: spec.window.seconds, span });
    return runs;
  }

  /**
   * One run's clips removed (removeClips), written in its transaction: the first ones gone, the In past them, the clip first
   * now taking the join the first one had; each run of them in the middle set aside as a removed part kept with the clip
   * after it, that clip made a cut (a window of the source then starts after the frames it carried, unless it is rendered
   * or in the queue: its take was made of its part); the last ones set aside with what the trims set aside, the Out before
   * them. The parts removed before next to them are folded in (foldParts).
   */
  private async cutOut(tx: Tx, timelineId: string, run: Run & { removal: Removal }, all: Placed[], busy: Set<string>) {
    const { removal } = run;
    const placedOf = (id: string) => all.find((p) => p.clip.id === id)!;
    const t = await tx.selectFrom("timelines").selectAll().where("id", "=", timelineId).executeTakeFirstOrThrow();
    const plan = run.kind === "source" ? sourceOfRow(t.source)! : undefined;
    let parts = plan ? [...(plan.removed ?? [])] : [...(removedRecordings(t)[run.asset!] ?? [])];
    let parked = plan ? [...(plan.parked ?? [])] : [...(parkedRecordings(t)[run.asset!] ?? [])];
    let shortened = plan ? plan.shortened : shortenedRecordings(t)[run.asset!];
    const out = new Set([...removal.lead, ...removal.tail, ...removal.middles.flatMap((m) => m.ids)]);
    const kept = run.ids.filter((id) => !out.has(id));
    // a clip made a cut, or given the join the first one had: a window of the source moves its part by the frames carried
    const rejoin = async (p: Placed, joined: ClipRow["joined"]) => {
      const free = !p.clip.take_id && !busy.has(p.clip.id);
      const moved = plan && free && joined !== p.clip.joined ? windowRunUp(this.registry.recipe(p.clip.recipe_id ?? ""), JSON.parse(p.clip.inputs) as Record<string, unknown>, joined) : null;
      if (joined !== p.clip.joined || moved) await tx.updateTable("clips").set({ joined, ...(moved ? { inputs: JSON.stringify(moved) } : {}), updated_at: now() }).where("id", "=", p.clip.id).execute();
      return moved;
    };
    let fromMs = plan?.fromMs;
    if (removal.lead.length) {
      // the parts removed among them, or just after them (the first now), go with them
      parts = foldParts(parts, removal.lead, null).parts.filter((p) => p.before !== kept[0]);
      const first = placedOf(kept[0]!);
      const moved = await rejoin(first, placedOf(removal.lead[0]!).clip.joined);
      if (plan) fromMs = Math.round(run.span({ ...first.clip, inputs: moved ? JSON.stringify(moved) : first.clip.inputs }, true).start);
    }
    for (const m of removal.middles) {
      const folded = foldParts(parts, m.ids, await parkClips(tx, m.ids));
      parts = folded.parts;
      const there = parts.find((p) => p.before === m.before);
      if (there) {
        // the clip after them is already the cut of a part removed before: one part, these clips first (they lay before it)
        there.rows = [...folded.rows, ...there.rows];
        continue;
      }
      const after = placedOf(m.before);
      const moved = await rejoin(after, "cut");
      parts.push({ before: m.before, rows: folded.rows, joined: after.clip.joined, take: after.clip.take_id, takes: after.takes.map((x) => x.take.id), ...(moved ? { inputs: after.clip.inputs } : {}) });
    }
    let toMs = plan?.toMs;
    if (removal.tail.length) {
      const folded = foldParts(parts, removal.tail, await parkClips(tx, removal.tail));
      parts = folded.parts;
      shortened = atLengthBefore(folded.rows, shortened, run.seconds);
      parked = [...folded.rows, ...parked];
      if (plan) toMs = Math.round(run.span(placedOf(kept.at(-1)!).clip, kept.length === 1).to);
    }
    if (!plan) return setParkedRecording(tx, timelineId, run.asset!, parked, shortened ?? null, parts);
    // the In moved: the source keeps its place under the clips (the first one now starts where the first removed did), and
    // who a swap replaces, clicked on the old first frame, is clicked again on the new one (gone as a moved start drops it)
    const shift = (fromMs ?? plan.fromMs) - plan.fromMs;
    const next: SourcePlan = { ...plan, fromMs: fromMs ?? plan.fromMs, toMs: toMs ?? plan.toMs, atMs: plan.atMs - shift, parked, shortened, removed: parts.length ? parts : undefined };
    if (shift) delete next.pick;
    await tx.updateTable("timelines").set({ source: JSON.stringify(next), updated_at: now() }).where("id", "=", timelineId).execute();
  }

  /**
   * A part removed from the middle of a recording or the source (removeClips) brought back: its clips set aside back as they
   * were, with their takes, just before the clip it was kept with, and that clip given its join and its form back, unless
   * it was rendered since (a take made as a cut, which keeps it) or is in the queue. One step for Undo. Refused while that
   * clip is set aside itself (an Out brought in past it): the Out moved out brings it back first.
   */
  async bringBack(timelineId: string, before: string): Promise<void> {
    await this.history.oneAtATime(timelineId, async () => {
      const t = await this.row(timelineId);
      const plan = sourceOfRow(t.source);
      const recordings = removedRecordings(t);
      const asset = Object.keys(recordings).find((a) => recordings[a]!.some((p) => p.before === before));
      const parts = asset ? recordings[asset]! : (plan?.removed ?? []);
      const part = parts.find((p) => p.before === before);
      if (!part) throw notFound("this removed part");
      const all = await this.placed(timelineId);
      if (!all.some((p) => p.clip.id === before)) throw httpError("The clip after the cut is set aside too: move the Out back out first, then bring the part back.", 409);
      const after = all.find((p) => p.clip.id === before)!;
      const same = !renderedSince({ clip: after.clip, takes: [] }, part) && !(await this.busyOf([before])).size;
      await this.db.transaction().execute(async (tx) => {
        await this.remember(timelineId, "the part brought back", undefined, tx);
        const order = all.map((p) => p.clip.id);
        let at = order.indexOf(before);
        for (const row of part.rows) {
          await unparkClip(tx, row);
          order.splice(at++, 0, String(row.clip.id));
        }
        if (same) await tx.updateTable("clips").set({ joined: part.joined, ...(part.inputs !== undefined ? { inputs: part.inputs } : {}), updated_at: now() }).where("id", "=", before).execute();
        await this.renumber(timelineId, order, tx);
        const left = parts.filter((p) => p !== part);
        if (asset) await setParkedRecording(tx, timelineId, asset, parkedRecordings(t)[asset] ?? [], undefined, left);
        else await tx.updateTable("timelines").set({ source: JSON.stringify({ ...plan!, removed: left.length ? left : undefined }), updated_at: now() }).where("id", "=", timelineId).execute();
      });
    });
    await this.touch(timelineId);
  }

  /**
   * A take goes, and the video that was rendered for it goes to the bin with it (it comes back with
   * Undo, or from the bin for a week). A video that was brought in from the library stays there, and so
   * does one that something else still uses, or one in a linked folder. The newest of the other takes plays instead.
   */
  async removeTake(id: string) {
    const found = await this.db.selectFrom("takes").select("clip_id").where("id", "=", id).executeTakeFirst();
    if (!found) throw notFound("this take");
    const { timeline_id: timelineId } = await this.clipRow(found.clip_id);
    // what is binned is worked out before the transaction: it asks the database outside it
    const binned = await this.history.oneAtATime(timelineId, async () => {
      const take = await this.db.selectFrom("takes").selectAll().where("id", "=", id).executeTakeFirst();
      if (!take) throw notFound("this take");
      // the draft of a finished take: the clip after continues from its latent (a SeedVR2 or RTX finish keeps none of its
      // own), and its video is what a finish is redone from. Removed, the next renders would join on frames without a word
      const finished = await this.db.selectFrom("takes").select("id").where("finished_from", "=", id).executeTakeFirst();
      if (finished) throw httpError("This take is the draft of a finished take: the clip after continues from it, and a finish is redone from it. Remove the finished take first.", 409);
      const clip = await this.clipRow(take.clip_id);
      // a file of a linked folder (a kept render filed there) is the user's own file on disk: it stays in its folder, as the
      // unused takes' do (timelineUnused.ts). Binned in place, emptying the bin would delete it from that folder
      const bin = !(await this.linkedFile(take.asset_id)) && (await this.madeForATimeline(take.asset_id)) && !(await this.stillUsed(take.asset_id, id));
      await this.db.transaction().execute(async (tx) => {
        await this.remember(clip.timeline_id, "the take removed", undefined, tx);
        await tx.deleteFrom("takes").where("id", "=", id).execute();
        if (bin) await tx.updateTable("assets").set({ deleted_at: now() }).where("id", "=", take.asset_id).where("deleted_at", "is", null).execute();
        if (clip.take_id === id) {
          const left = await tx.selectFrom("takes").select("id").where("clip_id", "=", clip.id).orderBy("created_at", "desc").executeTakeFirst();
          await tx.updateTable("clips").set({ take_id: left?.id ?? null }).where("id", "=", clip.id).execute();
        }
      });
      return bin;
    });
    if (binned) this.events.emit("library", { change: "binned" } satisfies LibraryChange);
    await this.touch(timelineId);
  }

  /**
   * The timeline's unused takes go (see timelineUnused.ts), their videos to the bin with them: one step, which Undo takes
   * back (the takes return and their videos leave the bin), and the bin keeps them a week. `binned`: the takes that went.
   */
  async binUnusedTakes(id: string): Promise<{ binned: number; bytes: number }> {
    await this.row(id);
    const u = await this.history.oneAtATime(id, async () => {
      const u = (await unusedTakes(this.db, id)).get(id);
      if (!u?.takes.length) return null;
      const at = now();
      // the step and what it bins land together, in the timeline's turn
      await this.db.transaction().execute(async (tx) => {
        await this.remember(id, "the unused takes binned", undefined, tx);
        const takes = u.takes;
      const assets = [...u.assets.keys()];
      for (let i = 0; i < takes.length; i += 500) await tx.deleteFrom("takes").where("id", "in", takes.slice(i, i + 500)).execute();
      for (let i = 0; i < assets.length; i += 500) await tx.updateTable("assets").set({ deleted_at: at }).where("id", "in", assets.slice(i, i + 500)).where("deleted_at", "is", null).execute();
      });
      return u;
    });
    if (!u) return { binned: 0, bytes: 0 };
    this.events.emit("library", { change: "binned", items: [...u.assets.keys()] } satisfies LibraryChange);
    await this.touch(id);
    return { binned: u.takes.length, bytes: unusedSize(u).unusedBytes };
  }

  // ---------------------------------------------------------------- for the queue

  /** Just before a clip's job is sent: its inputs with its neighbours filled in (TimelinePlan.plan). */
  plan(...args: Parameters<TimelinePlan["plan"]>): Promise<ClipPlan> { return this.planner.plan(...args); }
  /**
   * The clips of timelines, each timeline read once however often it is asked: for one request that plans many clips
   * (plan's `placed`). Not kept past the reader, so an edit made after it is never missed by the next request.
   */
  placedOnce(): (timelineId: string) => Promise<Placed[]> {
    const read = new Map<string, Promise<Placed[]>>();
    return (timelineId) => {
      let got = read.get(timelineId);
      if (!got) read.set(timelineId, (got = this.placed(timelineId)));
      return got;
    };
  }
  /**
   * What a clip's render queued again (Queue.again) waits for, as the timeline's Render has it wait: a clip that carries on
   * from a video clip waits for the job that clip's next take comes out of, while one waits or runs, its join then cut from
   * that take; else it carries on from the take that plays when it starts. A clip before with neither is refused: sent
   * then, a latent landing opened on nothing and rendered as a clip of its own (card #127). Undefined: it waits for nothing.
   */
  async againAfter(clipId: string): Promise<string | undefined> {
    const clip = await this.db.selectFrom("clips").select(["timeline_id", "joined"]).where("id", "=", clipId).executeTakeFirst();
    // a clip taken off its timeline since: its job says so when it starts
    if (!clip || clip.joined !== "continue") return undefined;
    const all = await this.placed(clip.timeline_id);
    const i = all.findIndex((p) => p.clip.id === clipId);
    const prior = i > 0 ? all[i - 1]! : null;
    if (!prior || prior.clip.kind === "still") return undefined;
    // the newest: of several takes asked at once, the last one queued is the one that plays once they are all in
    const coming = await this.db.selectFrom("jobs").select("id").where("clip_id", "=", prior.clip.id).where(toRun).orderBy("created_at", "desc").executeTakeFirst();
    if (coming) return coming.id;
    if (prior.active) return undefined;
    throw httpError(`Clip ${i + 1} carries on from clip ${i}, which has no take: render clip ${i} first, or make their join a hard cut.`);
  }
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
  async generationOf(assetId: string): Promise<{ recipe: string; inputs: Record<string, unknown>; seed: number; mirror: string[] } | null> {
    const asset = await this.db.selectFrom("assets").select("generation_id").where("id", "=", assetId).executeTakeFirst();
    if (!asset?.generation_id) return null;
    const g = await this.db.selectFrom("generations").select(["recipe_id", "inputs", "resolved"]).where("id", "=", asset.generation_id).executeTakeFirst();
    if (!g) return null;
    const { seed, mirror } = JSON.parse(g.resolved) as { seed?: number; mirror?: string[] };
    // with the pinned pictures it flipped (Mirror): rendered again, it flips them again, whatever its clip says now
    return typeof seed === "number" ? { recipe: g.recipe_id, inputs: JSON.parse(g.inputs) as Record<string, unknown>, seed, mirror: mirror ?? [] } : null;
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

  /** The music ducked under speech, the curve the export uses too: null when there is no music or no clip ducks it. */
  async duck(timelineId: string): Promise<DuckCurve | null> {
    const t = await this.row(timelineId);
    if (!t.music_asset_id) return null;
    const laid = laidOut(await this.placed(timelineId));
    const plan = musicPlan(musicBaseOf(t, await this.assetRow(t.music_asset_id)), musicClipsOf(laid));
    if (!plan.spans.some((s) => s.duckDb > 0)) return null;
    return duckCurve(laid, (id, row) => this.media.motion(id, row), plan);
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
    : patch.transition !== undefined ? (patch.transition ? "the transition" : "the transition removed")
    : patch.joined !== undefined ? (patch.joined === "cut" ? "the hard cut" : "the seamless join")
    : patch.animate ? "the image animated (i2v)"
    : patch.sound !== undefined || patch.soundAsset !== undefined || patch.volume !== undefined ? "the audio change"
    : patch.music !== undefined ? "the music under the clip"
    : patch.fill !== undefined ? "the fit in the frame"
    : patch.fitNext !== undefined ? "the end on the next clip"
    : patch.pinMirror !== undefined ? (Object.values(patch.pinMirror).some(Boolean) ? "the frame mirrored" : "the mirror turned off")
    : patch.look !== undefined ? "the change of characters"
    : patch.share === "apart" ? "the change to this clip only"
    : patch.share === "inLine" ? "the clip brought in line"
    : patch.share === "toAll" ? "the clip's settings given to all"
    : "the change of model";
}

/** A voice given to a clip whose part is still to be worked out (Timelines.voiceAsked). */
type VoiceAsk = { asset: string; window: VoiceWindow; fromS: number };

/** What a run's `span` reads of a clip (its row, or a row set aside). */
type RunClip = { inputs?: unknown; joined?: unknown; recipe_id?: unknown };
/** A run of clips made of one stretch (Timelines.runsOf): the source's, or a recording's (`asset`). */
export type Run = { kind: "source" | "recording"; asset?: string; ids: string[]; start: string; seconds: string; span: (clip: RunClip, first: boolean) => { start: number; from: number; to: number } };
