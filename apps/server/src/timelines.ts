import { chatJson } from "./llm";
import type { EventEmitter } from "node:events";
import { duckCurve, type DuckCurve } from "./duck";
import { carriedOf, carryOver, joinFrames, joinWay, laysSound, madeAroundRecording, musicPlan, recordingSpecOf, sungHead, plural, recordingPart, recordingParts, sameWindowGrid, CUT_WINDOW, type ClipGrid, type CutMarks, trimIn, typedSeed, type ClipMusic, type SourceWindow, type InputSpec, type Recipe, type Transition } from "@afflatus/core";
import { newId, now, OWNER, toRun, type Db } from "./db";
import type { LibraryChange } from "./events";
import { httpError, notFound } from "./errors";
import { CutError } from "./cut";
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
import { madeOf, takeView, TimelineViews } from "./timelineViews";
import { draftOf, generationOfTake, ownInputIds, recipeWithStart, settingsOf, TimelinePlan, type ClipPlan, type NewClip, type TakeLinks } from "./timelinePlan";
import { clipsOfSource, patchedSource, planWindows, sourceOfRow, windowFormFor, windowRunUp, windowsOf, windowsReaching, type SourcePatch, type SourcePlan } from "./timelineSource";
import { TimelineTakes } from "./timelineTakes";
import { aroundRemoved, foldParts, keptAround, removalOf, removedOf, removedView, renderedSince, type ParkedClip, type Removal, type RemovedPart } from "./timelineRemoved";
import { unusedSize, unusedTakes } from "./timelineUnused";
import { clockOf, derivedKeys, formFilled, FROM_PREVIOUS, laidOut, lengthOf, markJoins, plannedLengthOf, setTrims, STILL_MS, stillRef, takeFollows, takeLandsOn, trimsOf, type AssetRow, type ClipRow, type Placed, type TakeRow, type Taken, type TimelineCore, type TimelineRow, mirroredPins, mirrorJson, mirrorOfRow, musicBaseOf, musicClipsOf, musicJson, musicOfRow, transitionJson, transitionOfRow } from "./timelineModel";

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
  by?: number;
  colour?: string;
  upscaleModel?: string;
  /** "finish" with SeedVR2: frames restored together, 0 = by the frame's size. */
  seedvrFrames?: number;
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
      row: (id) => this.row(id), clipRow: (id) => this.clipRow(id), assetRow: (id) => this.assetRow(id), placed: (id, db) => this.placed(id, db),
      remember: (id, label, added, db) => this.remember(id, label, added, db), oneAtATime: (key, work) => this.history.oneAtATime(key, work), touch: (id) => this.touch(id), keep: (id, db) => this.keep(id, db), renumber: (id, order, db) => this.renumber(id, order, db),
      settingsOf, frame: (video, atMs, once, timeline) => this.media.frame(video, atMs, once, timeline), motion: (id, row) => this.media.motion(id, row),
      cutRuns: (id, ids, tx) => this.cutRuns(id, ids, tx as Tx),
    };
    this.range = new TimelineRange(core);
    this.media = new TimelineMedia(core);
    this.exporter = new TimelineExport(core, (asset) => this.media.means(asset));
    this.takes = new TimelineTakes(core);
    this.planner = new TimelinePlan(core, this.takes, this.media);
    this.history = new TimelineHistory(db, (id) => this.row(id), () => this.changed(), (id) => this.partKeys(id));
    this.views = new TimelineViews(db);
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

  async view(id: string) {
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
      // what it was made with is its draft's form: what a finish added (its route, its upscale) is not the clip's to take back
      const draft = draftOf(x, takes);
      const drafted = draft === x ? own : rendered.get(generationOfTake(draft, takes) ?? "");
      return takeView(x, r, laid(r?.recipe ?? clipRecipe, own?.inputs), madeOf(this.registry.recipe(drafted?.recipe ?? ""), drafted, draft.take.prev_take_id));
    };
    let at = 0;
    const hidden = sourceOfRow(t.source)?.hidden;
    const clips = all.map((p, i) => {
      const length = lengthOf(p);
      const job = live.get(p.clip.id);
      const ended = last.get(p.clip.id);
      const view = {
        id: p.clip.id, kind: p.clip.kind, joined: p.clip.joined, join: this.joinState(all, i), recipe: p.clip.recipe_id,
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

  // ---------------------------------------------------------------- editing

  async create(name: string | undefined, project?: string | null, folder?: string | null, chosen = false) {
    const id = newId();
    const at = now();
    // numbered within its project (or the Inbox): each is its own workspace. Counted and written in the project's turn:
    // two made at once were given the same number
    await this.history.oneAtATime(`new-timeline:${project ?? ""}`, async () => {
      const count = Number((await this.db.selectFrom("timelines").select((eb) => eb.fn.countAll().as("n")).where("project_id", project ? "=" : "is", project ?? null).executeTakeFirst())?.n ?? 0);
      await this.db
        .insertInto("timelines")
        .values({
          id, owner_id: OWNER, name: name?.trim() || `Timeline ${count + 1}`, width: null, height: null, project_id: project ?? null, folder_id: folder ?? null, folder_chosen: chosen ? 1 : 0,
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

  /**
   * What cutting the source again keeps and drops: its clips at the start that are rendered or in the queue kept, the rest
   * dropped; where the new clips go (in place of the first dropped), where in the source they start (where the last kept
   * one's window ends; none kept, at the stretch's start) and the form they share (the source's first clip's).
   */
  /** What `append` adds after: every clip the source made kept, the new windows from where the last one ends, after it. */
  private afterAll(all: Placed[], plan: SourcePlan, driving: Extract<InputSpec, { type: "clip" }>) {
    const ofSource = clipsOfSource(plan, all.map((p) => p.clip), (r) => this.registry.recipe(r));
    const mine = all.filter((p) => ofSource.includes(p.clip.id));
    const last = mine.at(-1);
    if (!last) throw httpError("The source has no clips to add after: make them first.");
    const fps = this.registry.recipe(last.clip.recipe_id ?? "")?.traits?.fps ?? 24;
    const w = driving.window!;
    const inputs = JSON.parse(last.clip.inputs) as Record<string, unknown>;
    // a part holds its frames and half a frame more (sourceWindows): it ends its whole frames after its start
    const after = Math.round((Number(inputs[w.start]) + Math.floor(Number(inputs[w.seconds]) * fps + 1e-6) / fps) * 1000);
    return { kept: mine.length, drop: [] as string[], after, index: all.findIndex((p) => p.clip.id === last.clip.id) + 1, form: JSON.parse(mine[0]!.clip.inputs) as Record<string, unknown> };
  }

  /**
   * The source's stretch trimmed after Make (the rethink's trim, step 5): its end, or its start.
   * - Its end in: the windows past it set aside with the source (their clips and takes kept whole in `parked`), an empty
   *   window it falls in shortened to it, or set aside when what is left is under the fewest frames a window takes; a
   *   rendered window, or one in the queue, is never shortened: the end snaps to its nearer end (trimIn). The first window
   *   always stays. A window in the queue is never set aside: refused, as its render would land on no clip.
   * - Its end out (trimOut): an empty window it shortened made longer again, then the windows set aside back as they were
   *   while the stretch holds them, each where the one before it ends; one not held yet stops the end there, kept aside.
   *   Then new windows on the grid from where the last one ends.
   * - Its start, moved: every window shifts, so every window is made anew over the new stretch (the editor asks first
   *   when that leaves rendered takes behind; Undo brings them back).
   * Read and written in the timeline's turn, one step for Undo kept with the change (a trim refused keeps none): read before
   * the turn, the second of two trims sent at once wrote back the windows set aside as it had found them, losing those the
   * first had set aside. Returns the clips added (to open the first), where the end came to rest, and what to tell the
   * user (`said`: rendered windows that never come back passed, the first time).
   */
  async trimSource(timelineId: string, to: { fromMs: number; toMs: number }): Promise<{ clips: string[]; toMs: number; said?: string }> {
    // the source's scene cuts read before the timeline is held, as makeFromSource does (a moved start makes it anew in the turn)
    const asked = sourceOfRow((await this.row(timelineId)).source);
    if (asked?.snap) await this.media.scenes(asked.asset).catch(() => {});
    const out = await this.history.oneAtATime(timelineId, async () => {
      const t = await this.row(timelineId);
      const plan = sourceOfRow(t.source);
      if (!plan?.recipe) throw httpError("Drop a video on the Source lane first.");
      const recipe = this.registry.recipe(plan.recipe);
      const driving = recipe?.inputs.find((i) => i.type === "clip" && i.role === "source" && i.window);
      if (!recipe?.traits?.windows || !driving || driving.type !== "clip" || !driving.window) throw httpError(`${recipe?.title ?? plan.recipe} takes no driving video.`);
      const video = await this.assetRow(plan.asset);
      const length = video?.duration_ms ?? plan.toMs;
      const fromMs = Math.max(0, Math.min(length - 1000, Math.round(to.fromMs)));
      let toMs = Math.max(fromMs + 1000, Math.min(length, Math.round(to.toMs)));
      if (fromMs !== plan.fromMs) return { clips: await this.makeFromSource(timelineId, { anew: true, stretch: { fromMs, toMs } }), toMs };
      if (toMs === plan.toMs) return { clips: [], toMs };
      const w = driving.window;
      const fps = recipe.traits.fps;
      const all = await this.placed(timelineId);
      const ofSource = clipsOfSource(plan, all.map((p) => p.clip), (r) => this.registry.recipe(r));
      const mine = all.filter((p) => ofSource.includes(p.clip.id));
      // a window that carries on starts its part early by the frames it carries (its run-up): its own frames begin there
      const part = (clip: { inputs?: unknown; joined?: unknown }, first: boolean) => {
        const inputs = JSON.parse(String(clip.inputs)) as Record<string, unknown>;
        const from = Number(inputs[w.start]) * 1000;
        const own = clip.joined === "continue" && !first ? from + (carriedOf(recipe, inputs) * 1000) / fps : from;
        return { from, start: own, end: from + Number(inputs[w.seconds]) * 1000, inputs };
      };
      let parked = [...(plan.parked ?? [])];
      let shortened = plan.shortened;
      const order = all.map((p) => p.clip.id);
      if (toMs < plan.toMs) {
        const busy = await this.busyOf(mine.map((p) => p.clip.id));
        const cut = trimIn(mine.map((p, k) => ({ id: p.clip.id, ...part(p.clip, k === 0), whole: Boolean(p.clip.take_id) || busy.has(p.clip.id), busy: busy.has(p.clip.id) })), toMs, (recipe.traits.windows.least / fps) * 1000);
        refuseBusy(cut.away, busy, all, "trim the source's end before it");
        toMs = cut.toMs;
        // the end back where it was (snapped onto a rendered window), nothing set aside nor shortened: no step to undo
        if (toMs === plan.toMs && !cut.away.length && !cut.shortened.length) return { clips: [], toMs };
        await this.db.transaction().execute(async (tx) => {
          await this.remember(timelineId, "the source made shorter", undefined, tx);
          // the window shortened by this trim, if any: recorded once those set aside have their length back
          let fresh: typeof shortened;
          for (const s of cut.shortened) {
            const { inputs } = part(mine.find((p) => p.clip.id === s.id)!.clip, false);
            // its length before is kept (the first, when it is shortened again), for the stretch made long again: even an end
            // that falls within a rounding of its end, which shortened it by a frame for good while nothing recorded it
            if (shortened?.clip !== s.id) fresh = { clip: s.id, seconds: Number(inputs[w.seconds]) };
            await tx.updateTable("clips").set({ inputs: JSON.stringify({ ...inputs, [w.seconds]: Math.round(s.ms) / 1000 }), updated_at: now() }).where("id", "=", s.id).execute();
          }
          // set aside whole, in order, before those set aside already (they lie further on); a window shortened before is
          // set aside at its length before, as it lay among them, unless it was rendered since (atLengthBefore)
          // a part removed before one of them goes back among them, end to end, for the end out to bring back (foldParts)
          const { rows, parts } = foldParts(plan.removed ?? [], cut.away, await parkClips(tx, cut.away));
          shortened = atLengthBefore(rows, shortened, w.seconds);
          if (fresh) shortened = fresh;
          parked = [...rows, ...parked];
          await this.renumber(timelineId, order.filter((id) => !cut.away.includes(id)), tx);
          await tx.updateTable("timelines").set({ source: JSON.stringify({ ...plan, toMs, parked, shortened, removed: parts.length ? parts : undefined }), updated_at: now() }).where("id", "=", timelineId).execute();
        });
        return { clips: [], toMs };
      }
      // the empty window shortened to the old end given its length back first, while the stretch holds it (else the video
      // between it and the windows set aside would be in no window); then those come back as they were (trimOut). A window
      // of another form of the source's grid is one of its own (card #42: a Motion transfer after a swap); one of another
      // model (set aside before the source's model changed, or its model gone since) never comes back. That one is left out
      // of the walk: kept aside with its takes, out of the way, said once, and the end goes on past it (walked, one with a
      // take stopped every trim out there for good, with nothing said); one with no take goes when the rest do
      const last = mine.at(-1);
      const lastSpan = last ? part(last.clip, last === mine[0]) : undefined;
      const reach = last && lastSpan && shortened && last.clip.id === shortened.clip && !last.clip.take_id ? lastSpan.from + shortened.seconds * 1000 : undefined;
      const busy = last ? await this.busyOf([last.clip.id]) : new Set<string>();
      const ofGrid = (id: unknown) => {
        const r = typeof id === "string" ? this.registry.recipe(id) : undefined;
        return Boolean(r && (r.id === recipe.id || sameWindowGrid(recipe, r)));
      };
      const fitting = parked.filter((row) => ofGrid(row.clip.recipe_id));
      const off = parked.filter((row) => !ofGrid(row.clip.recipe_id));
      const cuts = new Set((plan.removed ?? []).map((p) => p.before));
      const rows = fitting.map((row) => ({ ...part(row.clip, false), fits: true, taken: row.takes.length > 0, cut: cuts.has(String(row.clip.id)) }));
      const grow = trimOut(last && lastSpan ? { start: lastSpan.from, end: lastSpan.end, free: !last.clip.take_id && !busy.has(last.clip.id), reach } : undefined, rows, toMs, { fromMs: plan.fromMs });
      const kept = grow.keep ? fitting.slice(grow.back) : [];
      const offKept = grow.keep ? off : off.filter((row) => row.takes.length);
      const untold = offKept.filter((row) => row.takes.length && !row.told).length;
      const said = !untold ? undefined : untold === 1 ? "A rendered window set aside under a model this source no longer takes stays aside with its takes: the end goes on past it." : `${untold} rendered windows set aside under a model this source no longer takes stay aside with their takes: the end goes on past them.`;
      // windows still set aside past the end: it rests where the windows end (never back before where it was), not on a
      // stretch past them in no window
      if (kept.length) toMs = Math.max(plan.toMs, Math.round(grow.end));
      if (grow.lastEnd === undefined && !grow.back && kept.length === fitting.length && offKept.length === off.length && !untold && toMs === plan.toMs) return { clips: [], toMs };
      const left = await this.db.transaction().execute(async (tx) => {
        await this.remember(timelineId, "the source made longer", undefined, tx);
        if (last && lastSpan && grow.lastEnd !== undefined) {
          // as long as it was before (its own figure, not one rounded back from ms), or as far as the stretch goes
          const whole = reach !== undefined && grow.lastEnd >= reach - 1;
          await tx.updateTable("clips").set({ inputs: JSON.stringify({ ...lastSpan.inputs, [w.seconds]: whole ? shortened!.seconds : Math.round(grow.lastEnd - lastSpan.from) / 1000 }), updated_at: now() }).where("id", "=", last.clip.id).execute();
          if (whole) shortened = undefined;
        }
        let at = last ? order.indexOf(last.clip.id) + 1 : order.length;
        for (const row of parked.slice(0, grow.back)) {
          await unparkClip(tx, row);
          order.splice(at++, 0, String(row.clip.id));
        }
        parked = [...kept, ...offKept.map((row) => (row.takes.length ? { ...row, told: true as const } : row))];
        await this.renumber(timelineId, order, tx);
        await tx.updateTable("timelines").set({ source: JSON.stringify({ ...plan, toMs, parked, shortened }), updated_at: now() }).where("id", "=", timelineId).execute();
        return kept.length;
      });
      // longer than the windows brought back: new windows on the grid from where the last ends (none to add: nothing), in
      // the same step
      if (left) return { clips: [], toMs, ...(said ? { said } : {}) };
      const clips = await this.makeFromSource(timelineId, { append: true, remembered: true }).catch((err: Error & { statusCode?: number }) => {
        if (err.statusCode && err.statusCode < 500) return [] as string[];
        throw err;
      });
      return { clips, toMs, ...(said ? { said } : {}) };
    });
    await this.touch(timelineId);
    return out;
  }

  /** The clips of these that have a render or a finish queued or under way. */
  private async busyOf(ids: string[], db: Db = this.db): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await db.selectFrom("jobs").select("clip_id").where("clip_id", "in", ids).where("status", "in", ["queued", "running"]).execute();
    return new Set(rows.flatMap((j) => (j.clip_id ? [j.clip_id] : [])));
  }

  /** What `anew` drops: every clip the source made, from the first one's place; none of them in the queue. */
  private async allAnew(all: Placed[], plan: SourcePlan) {
    const ofSource = clipsOfSource(plan, all.map((p) => p.clip), (r) => this.registry.recipe(r));
    if (!ofSource.length) throw httpError("The source has no clips to make anew: make them first.");
    if ((await this.busyOf(ofSource)).size) throw httpError("A clip of the source is rendering or in the queue: let it end, or stop it, to change the source's model.", 409);
    return { kept: 0, drop: ofSource, after: undefined, index: all.findIndex((p) => p.clip.id === ofSource[0]), form: undefined };
  }

  /**
   * The source given another form that makes it window by window (from its Model list, or a window clip's). Between forms
   * of one grid (H3's Swap character, Motion transfer), in place: every window takes it, whatever form it had of its own
   * (windowForm), and keeps its part, its own settings and its takes; each one's next take is made with the new form.
   * The windows a trim set aside take the new form too: a trim out brings them back made with it. A window that renders or
   * waits in the queue keeps its form, as one given its own (windowForm) does: its render was sent with it, and the take it
   * lands is then one of the form its clip has (its Model list switches it once it is done). The switch was refused for it
   * before, though in place nothing is deleted: that held every other window back while an H3 queue ran. Across grids
   * (SCAIL-2 and H3), every window made anew, rendered or not (makeFromSource `anew`): the editor says so before it asks.
   * Nothing made yet: only the source's model. One step to undo either way. Read in the timeline's turn: a form saved meanwhile is not written back as it was.
   */
  async sourceForm(timelineId: string, recipeId: string): Promise<{ switched: boolean; clips: string[] }> {
    const next = this.registry.recipe(recipeId);
    if (!next?.traits?.windows) throw httpError(`${next?.title ?? recipeId} does not make a long video window by window.`);
    const out = await this.history.oneAtATime(timelineId, async () => {
      const t = await this.row(timelineId);
      const plan = sourceOfRow(t.source);
      if (!plan) throw httpError("Drop a video on the Source lane first.");
      const old = plan.recipe ? this.registry.recipe(plan.recipe) : undefined;
      const all = await this.placed(timelineId);
      const ofSource = clipsOfSource(plan, all.map((p) => p.clip), (r) => this.registry.recipe(r));
      if (!ofSource.length || !old || !sameWindowGrid(old, next)) {
        if (!ofSource.length) {
          await this.edit(timelineId, { source: { recipe: next.id } });
          return { switched: false, clips: [] };
        }
        return { switched: false, clips: await this.makeFromSource(timelineId, { anew: true, recipe: next.id }) };
      }
      const busy = await this.busyOf(ofSource);
      const mine = all.filter((p) => ofSource.includes(p.clip.id) && !busy.has(p.clip.id));
      // a window's form in the new model's words, from the form it has: each window may have its own (card #42)
      const formOf = (row: { recipe_id?: unknown; inputs?: unknown }) => windowFormFor((typeof row.recipe_id === "string" ? this.registry.recipe(row.recipe_id) : undefined) ?? old, next, JSON.parse(String(row.inputs)) as Record<string, unknown>);
      const formed = (row: ParkedClip) => ({ ...row, clip: { ...row.clip, recipe_id: next.id, inputs: JSON.stringify(formOf(row.clip)) } });
      const parked = (plan.parked ?? []).map(formed);
      // the parts removed from the middle too, and the form the clip after each gets back with it
      const removed = (plan.removed ?? []).map((p) => ({ ...p, rows: p.rows.map(formed), ...(p.inputs !== undefined ? { inputs: JSON.stringify(formOf({ inputs: p.inputs })) } : {}) }));
      await this.db.transaction().execute(async (tx) => {
        await this.remember(timelineId, `the source made with ${next.title}`, undefined, tx);
        for (const p of mine) {
          const inputs = formOf(p.clip);
          await tx.updateTable("clips").set({ recipe_id: next.id, inputs: JSON.stringify(inputs), updated_at: now() }).where("id", "=", p.clip.id).execute();
        }
        await tx.updateTable("timelines").set({ source: JSON.stringify({ ...plan, recipe: next.id, ...(parked.length ? { parked } : {}), ...(removed.length ? { removed } : {}) }), updated_at: now() }).where("id", "=", timelineId).execute();
      });
      return { switched: true, clips: [] };
    });
    await this.touch(timelineId);
    return out;
  }

  /**
   * One window of the source given another form of its grid (card #42: Swap character where a shot opens or the motion
   * drifts, Motion transfer where it carries on), from its Model list with Apply to: This clip. In place: its part, its own
   * settings and its takes kept (each take keeps the form it was made with), its next take made with the new form; the
   * other windows and the source's own form as they are. One step to undo.
   */
  async windowForm(timelineId: string, clipId: string, recipeId: string): Promise<void> {
    const next = this.registry.recipe(recipeId);
    const t = await this.row(timelineId);
    const plan = sourceOfRow(t.source);
    const source = plan?.recipe ? this.registry.recipe(plan.recipe) : undefined;
    if (!plan || !source) throw httpError("Drop a video on the Source lane first.");
    if (!next?.traits?.windows || !sameWindowGrid(source, next)) throw httpError(`${next?.title ?? recipeId} does not cut the source as its other windows do: give it to all of them.`);
    await this.history.oneAtATime(timelineId, async () => {
      const all = await this.placed(timelineId);
      const p = all.find((x) => x.clip.id === clipId);
      if (!p || !clipsOfSource(plan, [p.clip], (r) => this.registry.recipe(r)).length) throw httpError("That clip is not a window of the source.");
      if (p.clip.recipe_id === next.id) return;
      if ((await this.busyOf([clipId])).size) throw httpError("The clip is rendering or in the queue: let it end, or stop it, to change its model.", 409);
      const was = (p.clip.recipe_id ? this.registry.recipe(p.clip.recipe_id) : undefined) ?? source;
      const inputs = windowFormFor(was, next, JSON.parse(p.clip.inputs) as Record<string, unknown>, true);
      // the step kept with the change, as one
      await this.db.transaction().execute(async (tx) => {
        await this.remember(timelineId, `clip ${all.indexOf(p) + 1} made with ${next.title}`, undefined, tx);
        await tx.updateTable("clips").set({ recipe_id: next.id, inputs: JSON.stringify(inputs), updated_at: now() }).where("id", "=", clipId).execute();
      });
    });
    await this.touch(timelineId);
  }

  private async cutAgain(all: Placed[], plan: SourcePlan, driving: Extract<InputSpec, { type: "clip" }>) {
    const ofSource = clipsOfSource(plan, all.map((p) => p.clip), (r) => this.registry.recipe(r));
    const mine = all.filter((p) => ofSource.includes(p.clip.id));
    if (!mine.length) throw httpError("The source has no clips to cut again: make them first.");
    const busy = new Set((await this.db.selectFrom("jobs").select("clip_id").where("clip_id", "in", mine.map((p) => p.clip.id)).where("status", "in", ["queued", "running"]).execute()).map((j) => j.clip_id));
    const kept: Placed[] = [];
    const drop: string[] = [];
    for (const p of mine) {
      if (p.clip.take_id || busy.has(p.clip.id)) {
        if (drop.length) throw httpError(`Clip ${all.indexOf(p) + 1} is rendered after clips of the source that are not: remove it, or its take, to cut the source again.`);
        kept.push(p);
      } else drop.push(p.clip.id);
    }
    // an empty clip the source is cut again for (given the source's model after its clips: the owner removed clip 3, added a
    // clip and picked Swap motion, 2026-10-20): the next window goes in its place, from where the kept ones end
    const empty = plan.clip ? all.find((p) => p.clip.id === plan.clip && !ofSource.includes(p.clip.id) && !p.clip.take_id && !p.active) : undefined;
    if (empty) drop.push(empty.clip.id);
    if (!drop.length) throw httpError("Every clip of the source is rendered or in the queue: nothing is left to cut again.");
    const last = kept.at(-1);
    const fps = this.registry.recipe(mine[0]!.clip.recipe_id ?? "")?.traits?.fps ?? 24;
    const w = driving.window!;
    const lastInputs = last ? (JSON.parse(last.clip.inputs) as Record<string, unknown>) : null;
    // a part holds its frames and half a frame more (sourceWindows): it ends its whole frames after its start
    const after = lastInputs ? Math.round((Number(lastInputs[w.start]) + Math.floor(Number(lastInputs[w.seconds]) * fps + 1e-6) / fps) * 1000) : undefined;
    // each window dropped, where its part lies (`from`, its own frames from `start`, past its run-up), its form and what it
    // keeps its own, as typed on it (what the source's form has is no window's own): the window made in its place takes it
    // (ownsOf). One given a form of its own (card #42: a swap where the motion drifts) keeps what its form before kept its
    // own too: read from its form's list only, the Motion transfer description typed before it was a swap went
    const source = plan.recipe ? this.registry.recipe(plan.recipe) : undefined;
    const carry = source?.traits?.windows?.carryOn ? this.registry.recipe(source.traits.windows.carryOn) : undefined;
    const owns = mine.filter((p) => drop.includes(p.clip.id)).map((p) => {
      const inputs = JSON.parse(p.clip.inputs) as Record<string, unknown>;
      const r = p.clip.recipe_id ? this.registry.recipe(p.clip.recipe_id) : undefined;
      const opens = p.clip.joined !== "continue";
      const given = Boolean(r && source && r.id !== (opens || !carry ? source : carry).id);
      const keys = new Set((given ? [r, source, carry] : [r]).flatMap((x) => x?.traits?.windows?.own ?? []));
      const from = Number(inputs[w.start]) * 1000;
      const start = !opens && p !== mine[0] && r ? from + (carriedOf(r, inputs) * 1000) / fps : from;
      return { from, start, to: from + Number(inputs[w.seconds]) * 1000, recipe: r, own: Object.fromEntries([...keys].filter((k) => k in inputs && inputs[k] !== plan.inputs[k]).map((k) => [k, inputs[k]])) };
    });
    return { kept: kept.length, drop, after, index: all.findIndex((p) => p.clip.id === drop[0]), form: JSON.parse(mine[0]!.clip.inputs) as Record<string, unknown>, owns };
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
   * The source split at a moment of it (`atMs`, in its own time): what comes before it, from where its stretch starts, becomes
   * a clip of the timeline playing the source as it is (where the made clips will go, before them), and the stretch made into
   * clips starts at that moment. The source keeps its place under the clips. One step for Undo.
   */
  async splitSource(timelineId: string, atMs: number): Promise<string> {
    const id = await this.history.oneAtATime(timelineId, async () => {
      const t = await this.row(timelineId);
      const plan = sourceOfRow(t.source);
      if (!plan) throw httpError("Drop a video on the Source lane first.");
      const video = await this.assetRow(plan.asset);
      if (!video) throw notFound("the source video");
      const length = video.duration_ms ?? plan.toMs;
      const cut = Math.round(atMs);
      if (cut < plan.fromMs + 200 || cut > plan.toMs - 1000) throw httpError("Put the playhead inside the stretch, at least a second before its end.");
      const all = await this.placed(timelineId);
      const replaced = plan.clip ? all.findIndex((p) => p.clip.id === plan.clip) : -1;
      const index = replaced >= 0 ? replaced : all.length;
      const made = await this.planner.newClip(all, index, { asset: plan.asset });
      await this.remember(timelineId, "the source split");
      return this.db.transaction().execute(async (tx) => {
        const clip = await this.planner.insertClip(timelineId, all, index, made, tx);
        await tx.updateTable("takes").set({ trim_start_ms: plan.fromMs, trim_end_ms: Math.max(0, length - cut) }).where("clip_id", "=", clip).execute();
        await tx.updateTable("timelines").set({ source: JSON.stringify({ ...plan, fromMs: cut }), updated_at: now() }).where("id", "=", timelineId).execute();
        return clip;
      });
    });
    await this.touch(timelineId);
    return id;
  }

  /**
   * The source lane's stretch made into clips, one a window (timelineSource.ts): each takes its part of the source as its
   * driving video and carries on from the one before (a window after a scene cut opens a new shot: a cut), with the same
   * picture and prompt in every one, and the seed typed on the source form if one was. In place of the clip the stretch was taken from, else after the last clip. One
   * step for Undo. Nothing is rendered here: the editor sends the new clips to render, as from its Render button.
   *
   * `again`: the source cut again into the clips it made (its window or its scene cuts changed). The clips at its start that
   * are rendered, or in the queue, are kept; the others are made anew from where the last kept one ends, carrying on from
   * it, with the form the source's clips share (the first one's). A rendered clip after one that is not stops it.
   *
   * `anew`: every clip the source made, rendered or not, made anew in their place (its form changed to one that cuts it on
   * another grid: sourceForm). Their takes' videos stay in the library; Undo brings the clips back with them.
   *
   * Made anew or cut again, the windows a trim set aside go too (Undo brings them back): they were cut on the old grid, or
   * with the old model, and a trim out brought them back after windows they no longer meet.
   *
   * `remembered`: the step is the caller's, kept already in this turn (a trim out that adds windows: one step for Undo).
   */
  async makeFromSource(timelineId: string, opts: { again?: boolean; anew?: boolean; recipe?: string; append?: boolean; stretch?: { fromMs: number; toMs: number }; remembered?: boolean } = {}): Promise<string[]> {
    // the source's scene cuts read before the timeline is held (the first time, ffmpeg reads every frame of it): inside, they are read back
    const asked = sourceOfRow((await this.row(timelineId)).source);
    if (asked?.snap) await this.media.scenes(asked.asset).catch(() => {});
    const ids = await this.history.oneAtATime(timelineId, async () => {
      const t = await this.row(timelineId);
      const read = sourceOfRow(t.source);
      if (!read) throw httpError("Drop a video on the Source lane first.");
      // `stretch`: the source's start moved after Make (trimSource): every window made anew over the new stretch, nothing set
      // aside but the parts removed from it (below)
      const plan: SourcePlan = opts.stretch ? { ...read, fromMs: opts.stretch.fromMs, toMs: opts.stretch.toMs, parked: [], shortened: undefined } : read;
      // `recipe`: the model it is made anew with, written with the clips (one step for Undo)
      const recipeId = opts.recipe ?? plan.recipe;
      const recipe = recipeId ? this.registry.recipe(recipeId) : undefined;
      if (!recipe) throw httpError("Choose the model the clips are made with.");
      if (!recipe.traits?.windows) throw httpError(`${recipe.title} does not make a long video window by window.`);
      const video = await this.assetRow(plan.asset);
      if (!video) throw notFound("the source video");
      const driving = recipe.inputs.find((i) => i.type === "clip" && i.role === "source" && i.window);
      if (!driving || driving.type !== "clip" || !driving.window) throw httpError(`${recipe.title} takes no driving video.`);
      const all = await this.placed(timelineId);
      // cut again: the source's clips rendered (or in the queue) at its start kept, the rest made anew after them
      const again = opts.anew ? await this.allAnew(all, plan) : opts.append ? this.afterAll(all, plan, driving) : opts.again ? await this.cutAgain(all, plan, driving) : null;
      // made anew or cut again: around the parts removed from the middle of the windows dropped, which stay removed with
      // their takes, each kept with the first window after it, a cut (card #114); those kept with a window kept stay as they
      // are. One past the end (kept with a window a trim set aside) or before the new start goes: the editor asks first
      const anew = Boolean(opts.anew || opts.again);
      const dropped = new Set(again?.drop ?? []);
      const removed = anew ? (plan.removed ?? []) : [];
      const stays = removed.filter((p) => !dropped.has(p.before) && all.some((x) => x.clip.id === p.before));
      const run = removed.length ? this.runsOf(t, all).find((r) => r.kind === "source") : undefined;
      const runFps = (read.recipe ? this.registry.recipe(read.recipe)?.traits?.fps : undefined) ?? recipe.traits.fps;
      // a part's own frames, from after those its first window carried to the end of its last one's whole frames (a part
      // holds half a frame more: sourceWindows), where the window after it started
      const spanOf = (row: ParkedClip) => {
        const s = run!.span(row.clip, false);
        return { from: s.from, to: s.start + (Math.floor(((s.to - s.start) / 1000) * runFps + 1e-6) * 1000) / runFps };
      };
      const start = again?.after ?? plan.fromMs;
      const spans = new Map(run ? removed.filter((p) => dropped.has(p.before)).map((part) => [part, removedView(part, spanOf)] as const) : []);
      const { pieces } = aroundRemoved(start, plan.toMs, [...spans].map(([part, span]) => ({ part, ...span })));
      // a part whose clips are of another grid (the source made anew with a model that cuts it otherwise) is made anew too:
      // windows of the new model over its span, set aside at once as its clips. It stays removed, and Bring back puts back
      // windows of the model the source has, carrying on from the one before; its old clips' takes go (the editor asks first)
      const ofGrid = (row: ParkedClip) => {
        const r = typeof row.clip.recipe_id === "string" ? this.registry.recipe(row.clip.recipe_id) : undefined;
        return Boolean(r && (r.id === recipe.id || sameWindowGrid(recipe, r)));
      };
      const segments = pieces.flatMap((piece, k) => [
        ...piece.after.filter((part) => !part.rows.every(ofGrid)).map((part) => ({ aside: part, k, fromMs: spans.get(part)!.fromMs, toMs: spans.get(part)!.toMs })),
        { aside: null, k, fromMs: piece.fromMs, toMs: piece.toMs },
      ]);
      const scenes = (id: string) => this.media.scenes(id);
      // planned in order: windows on the grid seldom end exactly where they are asked to (a step of 17 frames on H3), so a
      // part made anew starts where the windows before it end, and the piece after it where its own end: they meet. The
      // last window before a part kept as it was (its edge fixed) runs past its start to the grid's next count instead,
      // its take hiding that much (`hidden`): it meets the part exactly, and the window after a part brought back carries
      // on from there
      const shape = windowsOf(recipe, plan.inputs);
      const cutUp: SourceWindow[][] = [];
      const hiddenAt = new Map<number, number>();
      let reached: number | undefined;
      for (const [g, segment] of segments.entries()) {
        const chained = reached !== undefined && (segment.aside || segments[g - 1]?.aside) ? reached : undefined;
        const fromMs = chained ?? segment.fromMs;
        const carries = segment.aside ? (fromMs > start + 50 ? fromMs : undefined) : segment.k === 0 && !pieces[0]!.after.length ? again?.after : undefined;
        let made = await planWindows({ ...plan, fromMs, toMs: segment.toMs }, recipe, video, scenes, carries);
        const next = segments[g + 1];
        const keptNext = !segment.aside && next && !next.aside ? pieces[next.k]!.after[0] : undefined;
        const span = keptNext ? spans.get(keptNext) : undefined;
        if (shape && span && made.length && made.at(-1)!.toMs < span.fromMs - 500 / shape.fps) {
          made = (await windowsReaching(plan, recipe, video, scenes, { fromMs, edgeMs: span.fromMs, limitMs: span.toMs, after: carries })) ?? made;
          const over = made.at(-1)!.toMs - span.fromMs;
          if (over > 500 / shape.fps) hiddenAt.set(cutUp.flat().length + made.length - 1, Math.round(over));
        }
        cutUp.push(made);
        reached = made.length ? made.at(-1)!.toMs : chained;
      }
      const windows = cutUp.flat();
      // the first window of the stretch made, not of a part set aside: the one the click on its first frame goes to
      const firstOwn = cutUp.slice(0, segments.findIndex((g) => !g.aside)).flat().length;
      if (!windows.length) throw httpError(again?.after !== undefined ? "Nothing of the stretch is left after the rendered clips." : "The stretch is too short for one clip: make it longer.");
      // in place of the clip the stretch was taken from (still the same video), or of the empty clip it was dropped for (its
      // model the windows'), else after the last clip
      const replaced = again ? -1 : plan.clip ? all.findIndex((p) => p.clip.id === plan.clip && (p.active ? p.active.asset.id === plan.asset : !p.clip.take_id)) : -1;
      const index = again ? again.index : replaced >= 0 ? replaced : all.length;
      const startsAt = all.slice(0, index).reduce((sum, p) => sum + plannedLengthOf(p, p.clip.recipe_id ? this.registry.recipe(p.clip.recipe_id) : undefined, plan.hidden?.[p.clip.id]), 0);
      // a seed only when one was typed on the source form: else each render draws its own, as for a new clip (the shared
      // Picture keeps the person the same from window to window, not a seed). One drawn here would be a typed seed to the
      // seed mode, every New take sent with it again
      const seed = typedSeed(plan.inputs.seed);
      // the form every window is made with: the settings of the last clip of that model, then the source's own form; the
      // clips a timeline fills in itself and the driving video's part are each window's
      // the form a window that carries on is made with (Swap character's: Motion transfer), when it cuts the source alike;
      // its own settings kept on the source's form too (a Picture aside: a window after a swap has none of its own)
      const carry = recipe.traits.windows.carryOn ? this.registry.recipe(recipe.traits.windows.carryOn) : undefined;
      const carryOn = carry && sameWindowGrid(recipe, carry) ? carry : undefined;
      const own = new Set([...ownInputIds(recipe), ...(carryOn ? [...ownInputIds(carryOn)].filter((id) => carryOn.inputs.find((i) => i.id === id)?.type !== "image") : [])]);
      const form = Object.fromEntries(Object.entries(again?.form ?? { ...settingsOf(recipe, all, index), ...plan.inputs }).filter(([k]) => own.has(k) && k !== driving.id && k !== driving.window!.start && k !== driving.window!.seconds && !(again && k === "seed")));
      const pictureSpec = recipe.inputs.find((i) => i.type === "image" && i.role === "source");
      const picture = pictureSpec && typeof form[pictureSpec.id] === "string" ? (form[pictureSpec.id] as string) : null;
      if (!opts.remembered) await this.remember(timelineId, opts.stretch ? "the source's start moved" : opts.anew ? `the source made anew with ${recipe.title}` : opts.append ? "the source made longer" : again ? "the source cut again" : `the ${windows.length} clips made from the source`);
      return this.db.transaction().execute(async (tx) => {
        const order: Array<{ clip: { id: string } }> = all.filter((p) => !again?.drop.includes(p.clip.id)).map((p) => ({ clip: { id: p.clip.id } }));
        if (again?.drop.length) await tx.deleteFrom("clips").where("id", "in", again.drop).execute();
        if (replaced >= 0) {
          await tx.deleteFrom("clips").where("id", "=", plan.clip!).execute();
          order.splice(replaced, 1);
        }
        const made: string[] = [];
        const forms: Array<{ recipe: Recipe<any>; inputs: Record<string, unknown> }> = [];
        const owned = ownsOf(windows, again && "owns" in again ? again.owns : [], (1000 / recipe.traits!.fps) / 2);
        for (const [k, w] of windows.entries()) {
          // the first window replaces the person clicked on its first frame, the ones after follow it (h3.swap's pick)
          const inputs = { ...form, [driving.id]: { asset: plan.asset, ...(k === firstOwn && !again?.kept && plan.pick && driving.pick ? { pick: plan.pick } : {}) }, [driving.window!.start]: w.start, [driving.window!.seconds]: w.seconds, ...(seed !== null ? { seed } : {}) };
          // cut again: what the windows dropped kept their own (ownsOf); one that carries on where one lay before keeps the
          // form it was given (card #42), when it is of the grid
          const { own: itsOwn, form: theirs } = owned[k]!;
          const madeWith = theirs && (theirs.id === recipe.id || sameWindowGrid(recipe, theirs)) ? theirs : !w.opens && carryOn ? carryOn : recipe;
          const clip: NewClip = {
            kind: "video", recipeId: madeWith.id, joined: w.opens ? "cut" : "continue", still: null, take: null, asset: undefined, look: null,
            inputs: { ...(madeWith.id !== recipe.id ? windowFormFor(recipe, madeWith, inputs, true) : inputs), ...itsOwn },
          };
          const id = await this.planner.insertClip(timelineId, order, index + k, clip, tx, false);
          order.splice(index + k, 0, { clip: { id } });
          made.push(id);
          forms.push({ recipe: madeWith, inputs: clip.inputs });
        }
        // each part removed kept with the first window after it, made a cut: carrying on, as Bring back makes it again, it
        // starts earlier by the frames it carries (windowRunUp), as the window it replaces did
        let at = 0;
        const ofSegment = cutUp.map((w) => made.slice(at, (at += w.length)));
        const firsts = pieces.map((_, k) => ofSegment[segments.findIndex((g) => !g.aside && g.k === k)]![0] ?? null);
        // the windows made over a part of another grid set aside as its clips (none made: it keeps its own)
        const remade = new Map<RemovedPart, ParkedClip[]>();
        const aside: string[] = [];
        for (const [g, segment] of segments.entries()) {
          const part = segment.aside;
          if (!part || !ofSegment[g]!.length) continue;
          remade.set(part, await parkClips(tx, ofSegment[g]!));
          aside.push(...ofSegment[g]!);
        }
        const around = pieces.map((piece) => ({ ...piece, after: piece.after.map((p) => (remade.has(p) ? { ...p, rows: remade.get(p)! } : p)) }));
        const { kept } = keptAround(around, firsts, (part, before) => {
          const k = made.indexOf(before);
          const carrying = part.joined === "continue" ? windowRunUp(forms[k]!.recipe, forms[k]!.inputs, "continue") : null;
          return { before, rows: part.rows, joined: part.joined, take: null, ...(carrying ? { inputs: JSON.stringify(carrying) } : {}) };
        });
        const parts = [...stays, ...kept];
        // what each window's take hides of its end: those kept (cut again) keep theirs, those made say theirs
        const hidden = Object.fromEntries([
          ...Object.entries(plan.hidden ?? {}).filter(([id]) => order.some((p) => p.clip.id === id) && !made.includes(id)),
          ...[...hiddenAt].map(([k, ms]) => [made[k]!, ms] as const),
        ]);
        // the clips after them moved along once, all the windows in (those set aside out)
        await this.renumber(timelineId, order.map((p) => p.clip.id).filter((id) => !aside.includes(id)), tx);
        // the source's start sits where its stretch now plays from; the clip it was taken from is gone. Cut again, it stays where
        // it was, and the clips it no longer has keep nothing apart
        const apart = plan.apart ? Object.fromEntries(Object.entries(plan.apart).filter(([id]) => !again?.drop.includes(id))) : undefined;
        const placedPlan = { ...(again ? { ...plan, clip: null, ...(apart ? { apart } : {}) } : { ...plan, atMs: startsAt - plan.fromMs, clip: null }), recipe: recipe.id, ...(anew ? { parked: [], shortened: undefined, removed: parts.length ? parts : undefined, hidden: Object.keys(hidden).length ? hidden : undefined } : {}) };
        await tx.updateTable("timelines").set({ source: JSON.stringify(placedPlan), updated_at: now() }).where("id", "=", timelineId).execute();
        if (picture) await this.keep(picture, tx);
        return made.filter((id) => !aside.includes(id));
      });
    });
    await this.touch(timelineId);
    return ids;
  }

  /**
   * A voice recording dropped on the track made into Lip sync clips: cut (recordingParts) into parts of about `seconds` (5
   * by default) ± `window` (CUT_WINDOW), at a pause, a lyric line's end or the quietest moment there, within what one clip takes, one clip a part, each carrying on from the one before. In place of
   * the empty clip it was dropped on, else after the last clip. The model is the one whose form takes a recording laid on a
   * clip's sound part by part (H3 · Lip sync), with the settings of the last clip of it. One step for Undo; nothing renders.
   * A clip in the queue is never replaced (dropped on, or made anew over a moved start): refused, as its render would land
   * on no clip.
   */
  async makeFromRecording(timelineId: string, o: { asset: string; clip?: string; seconds?: number; window?: number; fromS?: number; toS?: number; replace?: string[]; label?: string; keepCut?: boolean }): Promise<string[]> {
    const sound = await this.assetRow(o.asset);
    if (!sound || (sound.kind !== "audio" && sound.kind !== "video") || !sound.duration_ms) throw httpError("A recording has to be a sound (or a video's sound) of the library.");
    if (sound.kind === "video" && !sound.has_sound) throw httpError("That video has no sound: a recording has to be a sound, or a video with sound.");
    const marks = await this.cutMarksOf(sound);
    const ids = await this.history.oneAtATime(timelineId, async () => {
      const t = await this.row(timelineId);
      const all = await this.placed(timelineId);
      // the empty clip it was dropped on: the clips go in its place, with what was written in it (its scene). `replace`: the
      // clips of the recording made anew in their place (its start moved)
      const gone = o.replace ?? (o.clip && all.some((p) => p.clip.id === o.clip && !p.clip.take_id && p.clip.kind === "video") ? [o.clip] : []);
      refuseBusy(gone, await this.busyOf(gone), all, o.replace ? "move the recording's start" : "drop a recording on it");
      // a re-cut or a moved start keeps each clip's form where its part survives (card #72): the clips it replaces, as they lie
      const was = o.replace ? all.filter((p) => o.replace!.includes(p.clip.id)).map((p) => this.partOfClip(p)) : [];
      const cut = cutOf(recordingCuts(await this.row(timelineId)), sound.id);
      // the form its new parts take (card #2): its New clips form, else Lip sync of the family of the clip it was dropped on,
      // replaces or comes after (an LTX clip makes LTX clips), kept as its New clips form so that its panel says it
      const near = all.find((p) => p.clip.id === gone[0]) ?? all.filter((p) => p.clip.kind === "video" && p.clip.recipe_id).at(-1);
      const form = this.newClipsForm(cut.form, near?.clip.recipe_id);
      // `fromS` to `toS`: the stretch of the recording its clips are made of (a recording trimmed: trimRecording), all of it by
      // default, cut to what one clip of that form holds
      // made anew over its clips (a re-cut, a moved start): around the parts removed from their middle, which stay removed
      // with their takes, each kept with the first clip after it, a cut (card #114). One kept with a clip a trim set aside,
      // or before the new start, goes (the editor asks first when it holds takes)
      const fromS = o.fromS ?? 0;
      const toS = o.toS ?? sound.duration_ms! / 1000;
      const among = new Set(o.replace ?? []);
      const removed = o.replace ? (removedRecordings(t)[sound.id] ?? []).filter((p) => among.has(p.before)) : [];
      const spanOf = this.recordingSpan();
      const { pieces } = aroundRemoved(fromS * 1000, toS * 1000, removed.map((part) => ({ part, ...removedView(part, spanOf) })));
      const fits = recordingSpecOf(form.inputs)!.window.fits;
      // each part ends where a clip of the form can (ClipGrid): the first carries on from the clip before as recordingClipsIn
      // will make it (its run-up, and its own moment before the words), or opens on a cut; one after a part removed, on a cut
      const index = gone.length ? all.findIndex((p) => gone.includes(p.clip.id)) : all.length;
      const left = all.filter((p) => !gone.includes(p.clip.id));
      const firstOpensCut = this.opensOnCut(index > 0 ? left[index - 1] : undefined, form);
      const firstForm = was.find((c) => c.from <= fromS * 1000 + 1 && c.to > fromS * 1000)?.inputs ?? settingsOf(form, all, index);
      const cutUp = pieces.map((piece, k) => {
        const opensCut = k > 0 || piece.after.length > 0 || firstOpensCut;
        const grid = this.clipGridOf(form, opensCut, k === 0 ? firstForm : {});
        return this.recordingPartsOf(fits, marks, piece.fromMs / 1000, piece.toMs / 1000, o.seconds, o.window, grid).map((p, i) => ({ ...p, ...(i === 0 && (k > 0 || piece.after.length) ? { cut: true } : {}) }));
      });
      const parts = cutUp.flat();
      if (!parts.length) throw httpError("The recording is too short for a clip.");
      return this.db.transaction().execute(async (tx) => {
        await this.remember(timelineId, o.label ?? `the ${plural(parts.length, "clip")} made from the recording`, undefined, tx);
        const made = await this.recordingClipsIn(tx, timelineId, sound, parts, { gone, was, form: form.id });
        if (cut.form !== form.id && !o.keepCut) await setRecordingCut(tx, timelineId, sound.id, { ...cut, form: form.id });
        // made anew over a moved start: what a trim had set aside of it no longer fits its clips
        if (o.replace?.length) {
          let at = 0;
          const firsts = cutUp.map((p) => (p.length ? made[(at += p.length) - p.length]! : null));
          const { kept } = keptAround(pieces, firsts, (part, before) => ({ before, rows: part.rows, joined: part.joined, take: null }));
          await setParkedRecording(tx, timelineId, sound.id, [], null, kept);
        }
        // cut again at another length (the recording's panel): kept for its trims, which cut what they add the same way
        if (o.keepCut) await setRecordingCut(tx, timelineId, sound.id, { ...cut, form: form.id, seconds: o.seconds ?? DEFAULT_CUT.seconds, window: o.window ?? DEFAULT_CUT.window });
        return made;
      });
    });
    await this.touch(timelineId);
    return ids;
  }

  /**
   * What a recording is cut at: its pauses and timed lines, read once and kept beside it (TimelineMedia.pauses), and its
   * loudness (the voice band's, else the whole sound's), kept as its curve on the track is. A sound ffmpeg could not read
   * is said as such; its loudness not measured, a part with no pause or line in its window ends at the length asked.
   */
  private async cutMarksOf(sound: AssetRow): Promise<CutMarks> {
    const { pauses, lines } = await this.media.pauses(sound.id).catch((err: Error) => {
      throw err instanceof CutError ? httpError(`The recording's sound could not be read (${err.message}).`) : err;
    });
    const levels = await this.media.motion(sound.id, sound).then((m) => {
      const db = m.speech ?? m.sound;
      return db?.length ? { rate: m.rate, db } : null;
    }, () => null);
    return { pauses, lines, levels };
  }

  /**
   * The parts `fromS` to `toS` of a recording is cut into for the Lip sync model's clips (recordingParts), about `seconds`
   * each, within `window` of that, each ending where a clip of the form can (`grid`, clipGridOf).
   */
  private recordingPartsOf(fits: VoiceWindow["fits"], marks: CutMarks, fromS: number, toS: number, seconds = DEFAULT_CUT.seconds, window = DEFAULT_CUT.window, grid?: ClipGrid) {
    return recordingParts({ fromS, toS, wantS: seconds, ...this.clipBounds(fits), ...marks, windowS: window, ...(grid ? { clipGrid: grid } : {}) });
  }

  /**
   * Where a clip of `form` can end (core ClipGrid): its model's frame counts, less the run-up it carries on from (the form's
   * own, or `first`'s: the settings its first clip is made with), and for the first part its moment before the words too,
   * which the clip plays before its part as it plays the run-up. None when `opensCut`: the first then plays from its start.
   * Undefined for a form with no frame grid.
   */
  private clipGridOf(form: Recipe<any>, opensCut: boolean, first: Record<string, unknown> = {}): ClipGrid | undefined {
    const { fps, frameGrid } = form.traits ?? {};
    const fits = recordingSpecOf(form.inputs)?.window.fits;
    if (!fps || !frameGrid) return undefined;
    const head = joinFrames(form, "previous", first);
    const given = (id: string) => {
      const spec = form.inputs.find((i) => i.id === id);
      return Number(first[id] ?? (spec && "default" in spec ? spec.default : 0)) || 0;
    };
    const lead = Math.round((fits?.less ?? []).reduce((sum, id) => sum + given(id), 0) * fps);
    return { fps, grid: frameGrid, head, firstHead: (opensCut ? 0 : head) + lead };
  }

  /** Whether a clip of `form` placed after `before` opens on a cut (nothing to carry on from, or a form it cannot carry on from), as recordingClipsIn makes its first. */
  private opensOnCut(before: Placed | undefined, form: Recipe<any>): boolean {
    return !before || before.clip.kind !== "video" || !before.clip.recipe_id || joinWay(this.registry.recipe(before.clip.recipe_id), form) === "cut";
  }

  /** The fewest and most seconds of a recording one Lip sync clip takes. */
  private clipBounds(fits: VoiceWindow["fits"]) {
    return { leastS: fits?.min ?? 1, mostS: fits ? fits.frames / fits.fps - (fits.pad ?? 0) : 15 };
  }

  /**
   * The clips of these parts of a recording, written in the transaction given: in place of the clips `gone` (the first of
   * them), else after `after`, else at the end. Each part is made in the form of the clip it replaces whose part it overlaps
   * most (`was`: a re-cut keeps a clip's form and its settings where its part survives, card #72), else in the recording's
   * New clips form (`form`, Lip sync by default), with what was written in the clip it replaces (its shared inputs across a
   * change of form, its seed on the first: writtenIn), or the settings of the clip it follows when it is of that form, else
   * of the last clip of it; the first carrying on from the clip before when it can.
   */
  private async recordingClipsIn(tx: Db, timelineId: string, sound: AssetRow, parts: Array<{ start: number; seconds: number; cut?: boolean }>, at: { gone: string[]; after?: string; was?: ClipPart[]; form?: string }): Promise<string[]> {
    const { spec } = this.recordingModel();
    const { gone, after } = at;
    const all = await this.placed(timelineId, tx);
    const replaced = gone.length ? all.findIndex((p) => gone.includes(p.clip.id)) : -1;
    const index = replaced >= 0 ? replaced : after ? all.findIndex((p) => p.clip.id === after) + 1 : all.length;
    const model = replaced >= 0 ? all[replaced] : after ? all.find((p) => p.clip.id === after) : undefined;
    const fresh = (at.form && this.holdsRecording(at.form) ? this.registry.recipe(at.form) : undefined) ?? this.newClipsForm(undefined, model?.clip.recipe_id);
    const ofPart = new Set([spec.id, spec.window.start, spec.window.seconds, "seed"]);
    // the clips it replaces taken out, the new ones go where the first of them was: the clip before is the one just ahead
    const left = all.filter((p) => !gone.includes(p.clip.id));
    const before = index > 0 ? left[index - 1] : undefined;
    const order: Array<{ clip: { id: string } }> = left.map((p) => ({ clip: { id: p.clip.id } }));
    if (gone.length) await tx.deleteFrom("clips").where("id", "in", gone).execute();
    const made: string[] = [];
    for (const [k, part] of parts.entries()) {
      const from = part.start * 1000;
      const to = (part.start + part.seconds) * 1000;
      const overlap = (c: ClipPart) => Math.min(to, c.to) - Math.max(from, c.from);
      const survives = (at.was ?? []).reduce<ClipPart | undefined>((best, c) => (overlap(c) > 0 && (!best || overlap(c) > overlap(best)) ? c : best), undefined);
      const recipe = (survives && this.holdsRecording(survives.recipe) ? this.registry.recipe(survives.recipe) : undefined) ?? fresh;
      const own = ownInputIds(recipe);
      // the clip dropped on hands what was written in it over in any form; one it comes after, only in its own
      const kept = survives?.recipe === recipe.id ? survives.inputs : model && (replaced >= 0 || model.clip.recipe_id === recipe.id) ? this.writtenIn(model, recipe) : {};
      // the first part takes the place of the clip dropped on and keeps its seed; the others draw their own
      const seed = k === 0 && !survives && replaced >= 0 && "seed" in kept ? { seed: kept.seed } : {};
      const form = { ...Object.fromEntries(Object.entries({ ...settingsOf(recipe, all, index), ...kept }).filter(([key]) => own.has(key) && !ofPart.has(key))), ...seed };
      // the first carries on from the clip before when it can (H3 to Lip sync: in the latent), else it starts on its own
      // one after a part removed (`cut`: made anew around it) meets nothing before it: a cut
      const opens = part.cut || (k === 0 && this.opensOnCut(before, recipe));
      const clip: NewClip = {
        kind: "video", recipeId: recipe.id, joined: opens ? "cut" : "continue", still: null, take: null, asset: undefined, look: null,
        inputs: { ...form, [spec.id]: sound.id, [spec.window.start]: part.start, [spec.window.seconds]: part.seconds },
      };
      const id = await this.planner.insertClip(timelineId, order, index + k, clip, tx, false);
      order.splice(index + k, 0, { clip: { id } });
      made.push(id);
    }
    // the clips after them moved along once, all the parts in
    await this.renumber(timelineId, order.map((p) => p.clip.id), tx);
    await this.keep(sound.id, tx);
    return made;
  }

  /**
   * What was written in a clip (its scene, model, LoRAs, seed…) that a clip of `recipe` made in its place keeps: all of it in
   * the same form; across a change of form (a recording dropped on LTX · Video with audio makes LTX · Lip sync, card #2) the
   * inputs both forms have, as the studio carries them when its operation changes (carryOver); into another family only the
   * prompts, its model and LoRAs being of no use there.
   */
  private writtenIn(model: Placed, recipe: Recipe<any>): Record<string, unknown> {
    const inputs = JSON.parse(model.clip.inputs) as Record<string, unknown>;
    if (model.clip.recipe_id === recipe.id) return inputs;
    const from = model.clip.recipe_id ? this.registry.recipe(model.clip.recipe_id) : undefined;
    if (!from) return {};
    const carried = carryOver(from, recipe, inputs, undefined);
    if (from.family === recipe.family) return carried;
    const prompts = new Set(recipe.inputs.filter((i) => i.type === "prompt").map((i) => i.id));
    return Object.fromEntries(Object.entries(carried).filter(([id]) => prompts.has(id)));
  }

  /** A clip under a recording as a re-cut reads it: its part of the recording in ms, its form and what it was given. */
  private partOfClip(p: Placed): ClipPart {
    const { spec } = this.recordingModel();
    const inputs = JSON.parse(p.clip.inputs) as Record<string, unknown>;
    const from = Number(inputs[spec.window.start]) * 1000;
    return { from, to: from + Number(inputs[spec.window.seconds]) * 1000, recipe: p.clip.recipe_id ?? "", inputs };
  }

  /**
   * A timeline's recordings and what of each a trim set aside (`parkedTakes`: of those, the rendered), as the editor draws
   * them on the Audio row; and how each is cut into clips (about `seconds`, ± `window`), as its panel shows it.
   */
  private async recordingsView(t: TimelineRow, all: Placed[]) {
    let spanOf: ReturnType<Timelines["recordingSpan"]>;
    try {
      spanOf = this.recordingSpan();
    } catch {
      return [];
    }
    const parked = parkedRecordings(t);
    const cuts = recordingCuts(t);
    const used = all.map((p) => this.recordingUnder(p.clip));
    const ids = [...new Set([...used, ...Object.keys(parked)].filter((x): x is string => typeof x === "string" && Boolean(x)))];
    const rows = ids.length ? await this.db.selectFrom("assets").selectAll().where("id", "in", ids).execute() : [];
    const removed = removedRecordings(t);
    return rows.filter((a) => used.includes(a.id)).map((a) => ({
      asset: assetView(a), parked: parked[a.id]?.length ?? 0, parkedTakes: (parked[a.id] ?? []).filter((row) => row.clip.take_id).length, ...cutOf(cuts, a.id),
      // the parts cut out of its middle by removing their clips, each by the clip after it
      removed: (removed[a.id] ?? []).map((p) => removedView(p, spanOf)),
    }));
  }

  /** A clip under a recording set aside, its part of it in ms (removedView's reading). */
  private recordingSpan() {
    const w = this.recordingModel().spec.window;
    return (row: ParkedClip) => {
      const inputs = JSON.parse(String(row.clip.inputs)) as Record<string, unknown>;
      return { from: Number(inputs[w.start]) * 1000, to: (Number(inputs[w.start]) + Number(inputs[w.seconds])) * 1000 };
    };
  }

  /**
   * A clip's part of a source or recording: the inputs that may not change under a render in the queue, by its form's
   * save as by Undo and Redo (its render would not fit the clip).
   */
  private partKeys(recipeId: string | null): string[] {
    return (recipeId ? this.registry.recipe(recipeId)?.inputs.flatMap((i) => ("window" in i && i.window ? [i.id, i.window.start, i.window.seconds] : [])) : undefined) ?? [];
  }

  /**
   * The model whose form is made around a recording laid on a clip's sound part by part (H3 · Lip sync), and that input:
   * a dropped recording's clips are made in it. Its input's ids are those of every form a clip under a recording takes.
   */
  private recordingModel() {
    const recipe = this.registry.recipes().find((r) => r.output === "video" && madeAroundRecording(r.inputs));
    const spec = recipe && recordingSpecOf(recipe.inputs);
    if (!recipe || !spec) throw httpError("No model on this Afflatus makes a clip around a recording (MiniMax H3 · Lip sync).");
    return { recipe, spec };
  }

  /**
   * The form a recording's new clips are made in: its New clips form (card #72), else the form made around a recording of the
   * family of `near`, the clip it was dropped on or comes after (card #2: LTX's Lip sync after an LTX clip), else the first
   * model made around one (H3 · Lip sync).
   */
  private newClipsForm(form: string | undefined, near: string | null | undefined): Recipe<any> {
    if (form && this.holdsRecording(form)) return this.registry.recipe(form)!;
    const family = near ? this.registry.recipe(near)?.family : undefined;
    const own = family ? this.registry.recipes().find((r) => r.family === family && r.output === "video" && madeAroundRecording(r.inputs)) : undefined;
    return own ?? this.recordingModel().recipe;
  }

  /** What one clip of a recording's New clips form holds of it: the cuts, re-cuts and longer Outs cut their new parts to it. */
  private async newClipsFits(timelineId: string, asset: string, near?: string | null) {
    const form = this.newClipsForm(cutOf(recordingCuts(await this.row(timelineId)), asset).form, near);
    return recordingSpecOf(form.inputs)!.window.fits;
  }

  /** Whether a clip in this form can be under a recording (card #72): made around it (Lip sync), or one it plays over (Video with audio). */
  private holdsRecording(recipeId: string | null | undefined): boolean {
    const recipe = recipeId ? this.registry.recipe(recipeId) : undefined;
    return Boolean(recipe && recordingSpecOf(recipe.inputs));
  }

  /**
   * The recording a clip is under: its recording input set, whatever its form, as long as the form takes one (card #72).
   * Its model changed between Lip sync and Video with audio, it stays one of the recording's; leaving it is Remove.
   */
  private recordingUnder(clip: { recipe_id?: unknown; inputs?: unknown }): string | undefined {
    const recipe = typeof clip.recipe_id === "string" ? this.registry.recipe(clip.recipe_id) : undefined;
    const spec = recipe && recordingSpecOf(recipe.inputs);
    const asset = spec ? (JSON.parse(String(clip.inputs)) as Record<string, unknown>)[spec.id] : undefined;
    return typeof asset === "string" && asset ? asset : undefined;
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
    const { leastS, mostS } = this.clipBounds(ask.window.fits);
    return recordingPart({ fromS, toS, leastS, mostS, pauses });
  }

  /**
   * A recording's Lip sync clips trimmed (the rethink's trim, for recordings): the stretch of it they are made of, its In
   * and Out in ms of the recording. The same rule as the source's windows (trimSource, trimIn):
   * - Its end in: the clips past it set aside (an end out brings them back); an empty clip it falls in is shortened to it,
   *   or set aside when what is left is under the fewest seconds a clip takes; a rendered clip, or one in the queue, is
   *   never shortened: the end snaps to its nearer end, never back before the clip kept before it. The first clip always
   *   stays. A clip in the queue is never set aside: refused. The clip shortened keeps its length before (under the
   *   recordings' `shortened`), given back by the end out, or when it is set aside after all, as the source's windows do.
   * - Its end out (trimOut): the clips set aside back as they were while the stretch holds them (one not held yet stops the
   *   end there, kept aside), then new clips, cut at its pauses, after the last one, none shorter than a clip takes; one
   *   step for Undo, one transaction.
   * - Its start moved: its clips made anew over the new stretch, around the parts removed from it (makeFromRecording; the
   *   editor asks first when that leaves rendered takes).
   * Read and written in the timeline's turn (trimSource says why). Returns the clips added, and where the end came to rest.
   */
  async trimRecording(timelineId: string, to: { asset: string; fromMs: number; toMs: number }): Promise<{ clips: string[]; toMs: number }> {
    const { spec } = this.recordingModel();
    const w = spec.window;
    const sound = await this.assetRow(to.asset);
    const length = sound?.duration_ms ?? 0;
    if (!sound || !length) throw httpError("A recording has to be a sound of the library.");
    // what it is cut at read before the timeline is held (the first time, ffmpeg reads the whole sound): in the turn, read back
    const marks = await this.cutMarksOf(sound);
    const out = await this.history.oneAtATime(timelineId, async () => {
      const all = await this.placed(timelineId);
      const mine = all.filter((p) => this.recordingUnder(p.clip) === to.asset);
      if (!mine.length) throw httpError("No clip of this timeline is made of that recording.");
      const part = (clip: { inputs?: unknown }) => {
        const inputs = JSON.parse(String(clip.inputs)) as Record<string, unknown>;
        const start = Number(inputs[w.start]) * 1000;
        return { start, end: start + Number(inputs[w.seconds]) * 1000, inputs };
      };
      const curFrom = Math.round(part(mine[0]!.clip).start);
      const curTo = Math.round(part(mine.at(-1)!.clip).end);
      const fromMs = Math.max(0, Math.min(length - 1000, Math.round(to.fromMs)));
      let toMs = Math.max(fromMs + 1000, Math.min(length, Math.round(to.toMs)));
      const busy = await this.busyOf(mine.map((p) => p.clip.id));
      // cut as its panel set it: the parts a trim adds or makes anew are of the same length and window, and as long as
      // one clip of its New clips form holds
      const cutAs = cutOf(recordingCuts(await this.row(timelineId)), to.asset);
      const fits = await this.newClipsFits(timelineId, to.asset, mine.at(-1)!.clip.recipe_id);
      if (Math.abs(fromMs - curFrom) > 20) {
        const clips = await this.makeFromRecording(timelineId, { asset: to.asset, fromS: fromMs / 1000, toS: toMs / 1000, seconds: cutAs.seconds, window: cutAs.window, replace: mine.map((p) => p.clip.id), label: "the recording's start moved" });
        return { clips, toMs };
      }
      if (Math.abs(toMs - curTo) <= 20) return { clips: [], toMs: curTo };
      if (toMs > curTo) {
        // an empty last clip first made longer toward where the first clip set aside starts (its end had been brought in to
        // the trim), then those set aside back as they were while the stretch holds them, then new clips at its pauses past
        // them, none shorter than a clip can be (trimOut). Worked out first, then written in one transaction: one step for Undo
        const { mostS } = this.clipBounds(fits);
        const row = await this.row(timelineId);
        const parked = parkedRecordings(row)[to.asset] ?? [];
        // the clips set aside with a part removed before them, kept removed (foldParts): they come back past it
        const cuts = new Set((removedRecordings(row)[to.asset] ?? []).map((p) => p.before));
        let shortened = shortenedRecordings(row)[to.asset];
        const last = mine.at(-1)!;
        const lastPart = part(last.clip);
        const first = parked[0] ? part(parked[0].clip) : undefined;
        // as far as the first clip set aside starts, else (none set aside) its own length before a trim in shortened it
        const before = shortened?.clip === last.clip.id ? lastPart.start + shortened.seconds * 1000 : undefined;
        // never across a part kept removed: the first clip set aside then starts past that part, and growing up to it would
        // play the removed words in the empty last clip
        const pastRemoved = parked[0] ? cuts.has(String(parked[0].clip.id)) : false;
        const reach = last.clip.take_id || pastRemoved ? undefined : first ? ((first.start - lastPart.start) / 1000 <= mostS ? first.start : undefined) : before;
        const grow = trimOut({ start: lastPart.start, end: curTo, free: !last.clip.take_id && !busy.has(last.clip.id), reach }, parked.map((p) => ({ ...part(p.clip), fits: true, taken: p.takes.length > 0, cut: cuts.has(String(p.clip.id)) })), toMs, { fromMs: curFrom, leastMs: (fits?.min ?? 1) * 1000, mostMs: mostS * 1000 });
        const { back } = grow;
        const end = Math.round(grow.end);
        // the new parts carry on from the clip before them: each ends where a clip of the New clips form can (clipGridOf)
        const grid = this.clipGridOf(this.newClipsForm(cutAs.form, mine.at(-1)!.clip.recipe_id), false);
        const parts = grow.more && toMs > end + 50 ? this.recordingPartsOf(fits, marks, end / 1000, toMs / 1000, cutAs.seconds, cutAs.window, grid) : [];
        if (grow.lastEnd === undefined && !back && !parts.length) return { clips: [], toMs: curTo };
        const after = back ? String(parked[back - 1]!.clip.id) : last.clip.id;
        const rest = grow.keep ? parked.slice(back) : [];
        const clips = await this.db.transaction().execute(async (tx) => {
          await this.remember(timelineId, "the recording made longer", undefined, tx);
          const order = all.map((p) => p.clip.id);
          if (grow.lastEnd !== undefined) {
            // as long as it was before (its own figure, not one rounded back from ms), or as far as the stretch goes
            const whole = before !== undefined && grow.lastEnd >= before - 1;
            await tx.updateTable("clips").set({ inputs: JSON.stringify({ ...lastPart.inputs, [w.seconds]: whole ? shortened!.seconds : Math.round(grow.lastEnd - lastPart.start) / 1000 }), updated_at: now() }).where("id", "=", last.clip.id).execute();
            if (whole) shortened = undefined;
          }
          let at = order.indexOf(last.clip.id) + 1;
          for (const row of parked.slice(0, back)) {
            await unparkClip(tx, row);
            order.splice(at++, 0, String(row.clip.id));
          }
          await this.renumber(timelineId, order, tx);
          const made = parts.length ? await this.recordingClipsIn(tx, timelineId, sound, parts, { gone: [], after, form: cutAs.form }) : [];
          await setParkedRecording(tx, timelineId, to.asset, rest, shortened ?? null);
          return made;
        });
        return { clips, toMs: parts.length ? toMs : end };
      }
      const cut = trimIn(mine.map((p) => ({ id: p.clip.id, from: part(p.clip).start, ...part(p.clip), whole: Boolean(p.clip.take_id) || busy.has(p.clip.id), busy: busy.has(p.clip.id) })), toMs, (fits?.min ?? 1) * 1000);
      refuseBusy(cut.away, busy, all, "trim the recording's end before it");
      toMs = cut.toMs;
      if (!cut.away.length && !cut.shortened.length && Math.abs(toMs - curTo) <= 20) return { clips: [], toMs: curTo };
      await this.db.transaction().execute(async (tx) => {
        await this.remember(timelineId, "the recording made shorter", undefined, tx);
        const row = await tx.selectFrom("timelines").selectAll().where("id", "=", timelineId).executeTakeFirstOrThrow();
        let shortened = shortenedRecordings(row)[to.asset];
        // the clip shortened by this trim, if any: its length before kept (the first, when it is shortened again), as the
        // source's windows keep theirs (trimSource), once those set aside have their length back
        let fresh: typeof shortened;
        for (const s of cut.shortened) {
          const { inputs } = part(mine.find((p) => p.clip.id === s.id)!.clip);
          if (shortened?.clip !== s.id) fresh = { clip: s.id, seconds: Number(inputs[w.seconds]) };
          await tx.updateTable("clips").set({ inputs: JSON.stringify({ ...inputs, [w.seconds]: Math.round(s.ms) / 1000 }), updated_at: now() }).where("id", "=", s.id).execute();
        }
        // set aside whole, in order, before those set aside already (they lie further on): the end out brings them back. A
        // clip shortened before is set aside at its length before, as it lay among them, unless it was rendered since
        // (atLengthBefore). A part removed before one of them goes back among them, end to end (foldParts)
        const { rows, parts } = foldParts(removedRecordings(row)[to.asset] ?? [], cut.away, await parkClips(tx, cut.away));
        shortened = atLengthBefore(rows, shortened, w.seconds);
        if (fresh) shortened = fresh;
        await setParkedRecording(tx, timelineId, to.asset, [...rows, ...(parkedRecordings(row)[to.asset] ?? [])], shortened ?? null, parts);
        if (cut.away.length) await this.renumber(timelineId, all.map((p) => p.clip.id).filter((id) => !cut.away.includes(id)), tx);
      });
      return { clips: [], toMs };
    });
    await this.touch(timelineId);
    return out;
  }

  /**
   * A recording's clips cut again (its panel's Clip length ± its window): made anew over the stretch they use, about
   * `seconds` each, within `window` of that, as a moved start makes them, the parts removed from it kept removed (the editor asks first when that leaves
   * rendered takes behind); the cut kept, so its trims cut what they add the same way. One step for Undo.
   */
  async cutRecording(timelineId: string, o: { asset: string; seconds: number; window: number }): Promise<{ clips: string[] }> {
    const { spec } = this.recordingModel();
    const w = spec.window;
    const { leastS, mostS } = this.clipBounds(await this.newClipsFits(timelineId, o.asset));
    const seconds = Math.min(Math.max(o.seconds, leastS), mostS);
    const clips = await this.history.oneAtATime(timelineId, async () => {
      const mine = await this.recordingClipsOf(timelineId, o.asset);
      const part = (inputs: Record<string, unknown>) => ({ start: Number(inputs[w.start]), end: Number(inputs[w.start]) + Number(inputs[w.seconds]) });
      const fromS = part(mine[0]!.inputs).start;
      const toS = part(mine.at(-1)!.inputs).end;
      return this.makeFromRecording(timelineId, { asset: o.asset, fromS, toS, seconds, window: Math.max(0, o.window), replace: mine.map((c) => c.id), label: "the recording cut again", keepCut: true });
    });
    return { clips };
  }

  /**
   * What a recording's clips share, given to all of them at once (its panel's Shared by its clips): any setting of the Lip
   * sync form but the recording itself, each clip's part of it and its seed; null takes it away. One step for Undo. Their
   * takes stay; their next ones are made with it.
   */
  async recordingForm(timelineId: string, o: { asset: string; inputs: Record<string, unknown> }): Promise<Array<{ id: string; inputs: Record<string, unknown> }>> {
    const { spec } = this.recordingModel();
    const w = spec.window;
    // any setting of a form a clip under a recording takes; each clip is given those its own form has (card #72)
    const forms = this.registry.recipes().filter((r) => r.output === "video" && recordingSpecOf(r.inputs));
    const shared = new Set(forms.flatMap((r) => r.inputs).filter((i) => i.type !== "clip" && i.id !== spec.id && i.id !== w.start && i.id !== w.seconds && i.id !== "seed").map((i) => i.id));
    const given = Object.entries(o.inputs).filter(([k]) => shared.has(k));
    if (!given.length) throw httpError("Nothing the recording's clips can share was given.");
    let written: Array<{ id: string; inputs: Record<string, unknown> }> = [];
    await this.history.oneAtATime(timelineId, async () => {
      const mine = await this.recordingClipsOf(timelineId, o.asset);
      const changed = mine.flatMap((c) => {
        const next = { ...c.inputs };
        const own = new Set((c.recipe ? this.registry.recipe(c.recipe)?.inputs ?? [] : []).map((i) => i.id));
        for (const [k, v] of given) {
          if (!own.has(k)) continue;
          if (v === null || v === undefined) delete next[k];
          else next[k] = v;
        }
        return JSON.stringify(next) === JSON.stringify(c.inputs) ? [] : [{ id: c.id, next }];
      });
      if (!changed.length) return;
      written = changed.map((c) => ({ id: c.id, inputs: c.next }));
      await this.db.transaction().execute(async (tx) => {
        await this.remember(timelineId, "the recording's clips changed together", undefined, tx);
        for (const c of changed) await tx.updateTable("clips").set({ inputs: JSON.stringify(c.next), updated_at: now() }).where("id", "=", c.id).execute();
      });
    });
    await this.touch(timelineId);
    // the clips' forms as written: the editor's edits over them become these (a clip typed in before kept its old text)
    return written;
  }

  /**
   * The form a recording's new clips are made in (its panel's New clips, card #72): a re-cut's parts no clip had, a longer
   * Out's. One of the forms a clip under a recording takes; one step for Undo. The clips it has keep theirs.
   */
  async recordingNewClips(timelineId: string, o: { asset: string; recipe: string }): Promise<void> {
    if (!this.holdsRecording(o.recipe)) throw httpError(`That model does not go under a recording: ${this.formsUnderRecording()} do.`);
    await this.history.oneAtATime(timelineId, async () => {
      const t = await this.row(timelineId);
      await this.recordingClipsOf(timelineId, o.asset);
      await this.db.transaction().execute(async (tx) => {
        await this.remember(timelineId, "the form of the recording's new clips", undefined, tx);
        await setRecordingCut(tx, timelineId, o.asset, { ...cutOf(recordingCuts(t), o.asset), form: o.recipe });
      });
    });
    await this.touch(timelineId);
  }

  /**
   * The forms a clip under a recording takes, named as the editor's model list names them, with their family ("MiniMax H3 ·
   * Lip sync, MiniMax H3 · Video with audio and Wan 2.2 · Video": Wan's title alone says no model).
   */
  private formsUnderRecording(): string {
    // the form a recording is made around first, as the editor lists them
    const forms = this.registry.recipes().filter((r) => r.output === "video" && recordingSpecOf(r.inputs));
    const named = (r: Recipe<any>) => `${this.registry.family(r.family)?.name ?? r.family} · ${r.title}`;
    const titles = [...forms.filter((r) => madeAroundRecording(r.inputs)), ...forms.filter((r) => !madeAroundRecording(r.inputs))].map(named);
    return titles.length > 1 ? `${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}` : (titles[0] ?? "none");
  }

  /** A recording's clips on a timeline, whatever their form, in order, with their forms read; none is refused. */
  private async recordingClipsOf(timelineId: string, asset: string) {
    const mine = (await this.placed(timelineId))
      .filter((p) => this.recordingUnder(p.clip) === asset)
      .map((p) => ({ id: p.clip.id, recipe: p.clip.recipe_id, inputs: JSON.parse(p.clip.inputs) as Record<string, unknown> }));
    if (!mine.length) throw httpError("No clip of this timeline is made of that recording.");
    return mine;
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
  async editClip(id: string, patch: ClipPatch): Promise<{ inputs?: Record<string, unknown> }> {
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
    const filled = await this.history.oneAtATime(timelineId, () => this.editClipInTurn(id, patch, keys, ask && part ? { ask, part } : null));
    await this.touch(timelineId);
    // the form as kept, when the server worked out some of it: the editor shows it in place of what it sent
    return filled ? { inputs: filled } : {};
  }

  private async editClipInTurn(id: string, asked: ClipPatch, keys: string[], voice: { ask: VoiceAsk; part: { start: number; seconds: number } } | null): Promise<Record<string, unknown> | null> {
    // read again in the turn: the clip may have changed while the turn was waited for
    const clip = await this.clipRow(id);
    // its voice's part, laid on the form when the clip as it is now still asks for the one worked out (Timelines.voicePart)
    const again = voice && asked.inputs && !clip.take_id ? this.voiceAsked(asked.recipe ?? clip.recipe_id, JSON.parse(clip.inputs) as Record<string, unknown>, asked.inputs) : null;
    const fill = again && voice && again.asset === voice.ask.asset && again.fromS === voice.ask.fromS ? { [again.window.start]: voice.part.start, [again.window.seconds]: voice.part.seconds } : null;
    const patch: ClipPatch = fill ? { ...asked, inputs: { ...asked.inputs, ...fill } } : asked;
    const all = await this.placed(clip.timeline_id);
    const checked = await this.checkClipPatch(clip, patch, all);
    if (keys.every((k) => k === "inputs" || k === "share") && patch.inputs !== undefined && !patch.share) await this.rememberWriting(clip, all);
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
    if (patch.recipe !== undefined && patch.recipe !== clip.recipe_id && this.recordingUnder(clip) && !this.holdsRecording(patch.recipe)) {
      throw httpError(`This clip is under a recording: ${this.formsUnderRecording()} go there. To use another model, remove it from the recording first (its part is cut out).`);
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
    let model: ReturnType<Timelines["recordingModel"]>;
    try {
      model = this.recordingModel();
    } catch {
      return runs;
    }
    const { spec } = model;
    const byAsset = new Map<string, string[]>();
    for (const p of all) {
      const asset = this.recordingUnder(p.clip);
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
    throw httpError(`Clip ${i + 1} carries on from clip ${i}, which has no take: render clip ${i} first, or make their join a cut.`);
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
    : patch.joined !== undefined ? (patch.joined === "cut" ? "the cut" : "the join")
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

/** A window a cut again drops, as ownsOf reads it: its part, its own frames' start, its form and what it keeps its own. */
/** The window of a model's recording input (H3 · Lip sync's): where in the sound a clip's part starts, how long it lasts, what one clip holds. */
type VoiceWindow = NonNullable<Extract<InputSpec, { type: "audio" }>["window"]>;
/** A voice given to a clip whose part is still to be worked out (Timelines.voiceAsked). */
type VoiceAsk = { asset: string; window: VoiceWindow; fromS: number };
type DroppedWindow = { from: number; start: number; to: number; recipe?: Recipe<any>; own: Record<string, unknown> };

/**
 * What each window a cut again makes takes of the windows it drops (makeFromSource `again`), in ms. One that lies where a
 * dropped one lay (within half a frame, `slack`) keeps all it kept its own, and when it carries on, the form it was given
 * (a window that opens a shot is the source's form: made again with Swap character after Motion transfer, the opening is
 * a swap). Else it takes what the dropped window whose own frames hold its middle kept its own, not its form (a form given
 * where the motion drifted is not the user's for a window lying elsewhere). A dropped window none of them took gives the
 * text it kept its own to the nearest new window, before or after what that one has, as they lie in time: by middles
 * alone, a window between two middles lost its prompt, its swap's too.
 */
export function ownsOf(windows: Array<{ start: number; seconds: number; opens?: boolean }>, dropped: DroppedWindow[], slack: number): Array<{ own: Record<string, unknown>; form?: Recipe<any> }> {
  const mid = (w: { start: number; seconds: number }) => (w.start + w.seconds / 2) * 1000;
  const took = windows.map((w) => {
    const same = dropped.findIndex((o) => Math.abs(o.from - w.start * 1000) <= slack && Math.abs(o.to - (w.start + w.seconds) * 1000) <= slack);
    if (same >= 0) return { at: same, same: true };
    return { at: dropped.findIndex((o) => mid(w) >= o.start && mid(w) < o.to), same: false };
  });
  const out = took.map(({ at, same }, k) => ({ own: at >= 0 ? { ...dropped[at]!.own } : {}, ...(same && !windows[k]!.opens ? { form: dropped[at]!.recipe } : {}) }));
  for (const [j, o] of dropped.entries()) {
    if (!windows.length || took.some((x) => x.at === j)) continue;
    const typed = Object.entries(o.own).filter(([, v]) => typeof v === "string" && v.trim());
    if (!typed.length) continue;
    const at = (o.from + o.to) / 2;
    const near = windows.reduce((best, w, k) => (Math.abs(mid(w) - at) < Math.abs(mid(windows[best]!) - at) ? k : best), 0);
    const own = out[near]!.own;
    for (const [k, v] of typed) {
      const has = typeof own[k] === "string" ? (own[k] as string).trim() : "";
      own[k] = !has || has.includes(v as string) ? (has || v) : at < mid(windows[near]!) ? `${v} ${has}` : `${has} ${v}`;
    }
  }
  return out;
}

/** What a run's `span` reads of a clip (its row, or a row set aside). */
type RunClip = { inputs?: unknown; joined?: unknown; recipe_id?: unknown };
/** A run of clips made of one stretch (Timelines.runsOf): the source's, or a recording's (`asset`). */
type Run = { kind: "source" | "recording"; asset?: string; ids: string[]; start: string; seconds: string; span: (clip: RunClip, first: boolean) => { start: number; from: number; to: number } };
type Tx = Parameters<Parameters<ReturnType<Db["transaction"]>["execute"]>[0]>[0];

/**
 * The clip a trim out starts from, in ms: where its part starts and ends; `free`: empty and not in the queue, so it may be
 * made longer; `reach`: the end it may be made longer to (where it ended before a trim shortened it), if any.
 */
type GrowFrom = { start: number; end: number; free: boolean; reach?: number };

/**
 * What an end trimmed out does: the rule a source's windows and a recording's Lip sync clips share (trimSource,
 * trimRecording), as trimIn is for an end brought in. The last clip, empty and shortened by a trim in, is made longer first,
 * as far as its `reach` and the stretch go. Then the clips set aside come back in order while each starts where the one
 * before it ends and the stretch holds it whole: one it does not hold yet stops there, it and those after it kept aside
 * (`keep`), and nothing is added past them. One that does not meet the clip before is kept aside while the last clip can
 * still reach it (empty and shortened, its length not given back yet, or in the queue with no take yet: a few seconds more
 * of stretch bring them together). Else it never will, as one of another model (`fits` false) never comes back: when it or
 * one after it has a take (`taken`), the end stops there too and every one of them stays aside (a rendered window
 * shortened by a trim in, its render landed, is never made longer under its take; Undo, or its take removed, brings them
 * back), and only when none has one do they go (`keep` false) and new clips are made past the last one. Dropped, the
 * shortened window's render landing lost every rendered window set aside, on the next drag out, with nothing said. Twice
 * this rule was written out twice, and the two drifted: a gap that only waited for a longer stretch dropped every window
 * set aside, a rendered clip under new parts went with its take, and a window in the queue was given its length back under
 * its render. A clip set aside with a part removed before it (`cut`) comes back past the gap the part leaves. `more`: new
 * clips may be added from `end` to the stretch's end; with `leastMs`, never one shorter than a clip can be, whichever way
 * the clips set aside ended: the empty last clip takes what is left when it holds it (`mostMs`), else the end rests where
 * the clips end (recordingParts folds a short last part alike).
 */
export function trimOut(last: GrowFrom | undefined, rows: Array<{ start: number; end: number; fits: boolean; taken?: boolean; cut?: boolean }>, asked: number, o: { fromMs: number; leastMs?: number; mostMs?: number }): { lastEnd?: number; back: number; end: number; keep: boolean; more: boolean } {
  let end = last ? last.end : o.fromMs;
  let lastEnd: number | undefined;
  // any length a trim in took off given back (within a rounding too: a window left a frame short stays so for good)
  if (last?.free && last.reach !== undefined && last.reach > end + 0.5) {
    lastEnd = Math.round(Math.min(last.reach, asked));
    end = lastEnd;
  }
  let back = 0;
  let keep = true;
  for (const [k, row] of rows.entries()) {
    // the clip after a part removed from the middle (`cut`, timelineRemoved.ts) starts past it on purpose: it meets the one
    // before it across the part, which stays removed
    const meets = row.fits && (!last || Math.abs(row.start - end) <= 50 || Boolean(row.cut && row.start > end));
    if (!meets) {
      const waits = row.fits && back === 0 && last?.reach !== undefined && Math.abs(row.start - last.reach) <= 50;
      if (waits || rows.slice(k).some((r) => r.taken)) return { lastEnd, back, end, keep: true, more: false };
      keep = false;
      break;
    }
    if (row.end > asked + 50) return { lastEnd, back, end, keep: true, more: false };
    end = row.end;
    back++;
  }
  if (o.leastMs !== undefined && asked > end + 50 && asked - end < o.leastMs) {
    if (!back && last?.free && o.mostMs !== undefined && asked - last.start <= o.mostMs) {
      lastEnd = Math.round(asked);
      end = lastEnd;
    }
    return { lastEnd, back, end, keep, more: false };
  }
  return { lastEnd, back, end, keep, more: true };
}

/**
 * Refused (409) when a clip about to be set aside or replaced has a render or a finish queued or under way: its render would
 * land on no clip, its video kept by nothing, and on a rented GPU paid for all the same. `what`: what the user was doing.
 */
function refuseBusy(ids: string[], busy: Set<string>, all: Placed[], what: string) {
  const hit = ids.find((id) => busy.has(id));
  if (hit) throw httpError(`Clip ${all.findIndex((p) => p.clip.id === hit) + 1} is rendering or in the queue: let it end, or stop it, to ${what}.`, 409);
}

/** These clips set aside, in their order, and taken off the timeline (their takes go with them, kept in what is returned). */
async function parkClips(tx: Tx, ids: string[]): Promise<ParkedClip[]> {
  const rows: ParkedClip[] = [];
  for (const id of ids) {
    const clip = await tx.selectFrom("clips").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    const takes = await tx.selectFrom("takes").selectAll().where("clip_id", "=", id).execute();
    rows.push({ clip: clip as unknown as Record<string, unknown>, takes: takes as unknown as Array<Record<string, unknown>> });
  }
  if (ids.length) await tx.deleteFrom("clips").where("id", "in", ids).execute();
  return rows;
}

/**
 * The clip a trim in shortened before (`shortened`), set aside whole by a deeper one (among `rows`): set aside at its
 * length before, as it lay among those set aside further on. Set aside short, it no longer met the next one, and the end
 * out dropped that one and every one after it, rendered or not. Not when it was rendered since: its takes were made at
 * the shorter length, which it keeps (given back, it came back longer than the take playing on it, and the clip after it
 * was placed for a part that take does not reach), and the end out stops at it, as at any rendered clip that does not
 * meet the next (trimOut). The record is spent either way: returns what is left of it. `seconds`: the input of its length.
 */
function atLengthBefore(rows: ParkedClip[], shortened: Shortened | undefined, seconds: string): Shortened | undefined {
  const row = shortened && rows.find((p) => p.clip.id === shortened.clip);
  if (!shortened || !row) return shortened;
  if (!row.takes.length) row.clip = { ...row.clip, inputs: JSON.stringify({ ...(JSON.parse(String(row.clip.inputs)) as Record<string, unknown>), [seconds]: shortened.seconds }) };
  return undefined;
}

/**
 * A clip set aside back as it was, with its takes and the one that played (its place in the order is the caller's). Only
 * the columns a clip and a take have now, as Undo puts them back. A take whose video was erased meanwhile stays out (the
 * clip comes back without it, as Undo's does: it would fail the take's tie to its video, and with it every trim out after);
 * one whose video is in the bin brings it back out.
 */
async function unparkClip(tx: Tx, row: ParkedClip) {
  const { take_id: takeId, ...clip } = clipColumns(row.clip as unknown as ClipRow);
  const takes = row.takes.map((t) => takeColumns(t as unknown as TakeRow));
  const there = takes.length ? new Set((await tx.selectFrom("assets").select("id").where("id", "in", takes.map((t) => t.asset_id)).execute()).map((a) => a.id)) : new Set<string>();
  const kept = takes.filter((t) => there.has(t.asset_id));
  await tx.insertInto("clips").values({ ...clip, take_id: null }).execute();
  for (const take of kept) await tx.insertInto("takes").values(take).execute();
  if (kept.length) await tx.updateTable("assets").set({ deleted_at: null }).where("id", "in", kept.map((t) => t.asset_id)).where("deleted_at", "is not", null).execute();
  const playing = kept.some((t) => t.id === takeId) ? takeId : kept.at(-1)?.id;
  if (playing) await tx.updateTable("clips").set({ take_id: playing }).where("id", "=", clip.id).execute();
}

/** What a trim set aside of each of a timeline's recordings, by recording asset. */
function parkedRecordings(t: TimelineRow): Record<string, ParkedClip[]> {
  try {
    const read = JSON.parse(t.recordings ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(read).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as ParkedClip[]).filter((p) => p && typeof p.clip === "object" && Array.isArray(p.takes))]));
  } catch {
    return {};
  }
}

/** A clip a trim in shortened, and its length before (in seconds), for the end out to give it back. */
type Shortened = { clip: string; seconds: number };
/** Where the recordings' shortened clips are kept, in the same JSON: no recording is named so (asset ids are hex). */
const SHORTENED = "shortened";

/** The clip of each of a timeline's recordings that a trim in shortened, by recording asset. */
function shortenedRecordings(t: TimelineRow): Record<string, Shortened> {
  try {
    const read = (JSON.parse(t.recordings ?? "{}") as Record<string, unknown>)[SHORTENED];
    if (!read || typeof read !== "object") return {};
    return Object.fromEntries(Object.entries(read as Record<string, Partial<Shortened>>).filter(([, v]) => typeof v?.clip === "string" && typeof v.seconds === "number")) as Record<string, Shortened>;
  } catch {
    return {};
  }
}

/**
 * What is set aside of one recording, written back (none: its entry goes), with its clip a trim in shortened (null: none;
 * left out: as it is).
 */
async function setParkedRecording(db: Db | Tx, timelineId: string, asset: string, rows: ParkedClip[], shortened?: Shortened | null, removed?: RemovedPart[]) {
  const t = await db.selectFrom("timelines").selectAll().where("id", "=", timelineId).executeTakeFirstOrThrow();
  const map: Record<string, unknown> = parkedRecordings(t);
  const short = shortenedRecordings(t);
  const cuts = recordingCuts(t);
  const parts = removedRecordings(t);
  if (rows.length) map[asset] = rows;
  else delete map[asset];
  if (shortened) short[asset] = shortened;
  else if (shortened === null) delete short[asset];
  if (removed?.length) parts[asset] = removed;
  else if (removed) delete parts[asset];
  if (Object.keys(short).length) map[SHORTENED] = short;
  if (Object.keys(cuts).length) map[CUTS] = cuts;
  if (Object.keys(parts).length) map[REMOVED] = parts;
  await db.updateTable("timelines").set({ recordings: Object.keys(map).length ? JSON.stringify(map) : null }).where("id", "=", timelineId).execute();
}

/** Where the recordings' removed parts are kept (timelineRemoved.ts), in the same JSON: no recording is named so. */
const REMOVED = "removed";

/** The parts cut out of the middle of each of a timeline's recordings by removing their clips, by recording asset. */
function removedRecordings(t: TimelineRow): Record<string, RemovedPart[]> {
  try {
    const read = (JSON.parse(t.recordings ?? "{}") as Record<string, unknown>)[REMOVED];
    if (!read || typeof read !== "object") return {};
    return Object.fromEntries(Object.entries(read as Record<string, unknown>).map(([k, v]) => [k, removedOf(v)] as const).filter(([, v]) => v.length));
  } catch {
    return {};
  }
}

/** How a recording is cut into clips, as its panel sets it: about `seconds` a clip, ± `window` (0: exactly that). */
type RecordingCut = { seconds: number; window: number; form?: string };
/** A clip under a recording as a re-cut reads it (Timelines.partOfClip). */
type ClipPart = { from: number; to: number; recipe: string; inputs: Record<string, unknown> };
/** A recording cut as it is dropped: about 5 s a clip, ± CUT_WINDOW. */
const DEFAULT_CUT: RecordingCut = { seconds: 5, window: CUT_WINDOW };
/** Where the recordings' cuts are kept, in the same JSON as what a trim set aside (asset ids are hex: none is named so). */
const CUTS = "cut";

/** Each recording's cut set in its panel, by recording asset (those cut as dropped have none). */
function recordingCuts(t: TimelineRow): Record<string, RecordingCut> {
  try {
    const read = (JSON.parse(t.recordings ?? "{}") as Record<string, unknown>)[CUTS];
    if (!read || typeof read !== "object") return {};
    // kept before the window (Snap to pauses, card #130): snapped reads as the window a recording is dropped with, unsnapped as 0
    return Object.fromEntries(Object.entries(read as Record<string, Partial<RecordingCut> & { snap?: boolean }>).flatMap(([k, v]) => {
      if (typeof v?.seconds !== "number") return [];
      const window = typeof v.window === "number" ? v.window : typeof v.snap === "boolean" ? (v.snap ? CUT_WINDOW : 0) : null;
      return window === null ? [] : [[k, { seconds: v.seconds, window, ...(typeof v.form === "string" ? { form: v.form } : {}) }] as const];
    }));
  } catch {
    return {};
  }
}

/** One recording's cut: as its panel set it, else as it was dropped. */
function cutOf(cuts: Record<string, RecordingCut>, asset: string): RecordingCut {
  return cuts[asset] ?? DEFAULT_CUT;
}

/** One recording's cut written back, beside what a trim set aside of the recordings (left as it is). */
async function setRecordingCut(db: Db | Tx, timelineId: string, asset: string, cut: RecordingCut) {
  const t = await db.selectFrom("timelines").selectAll().where("id", "=", timelineId).executeTakeFirstOrThrow();
  let map: Record<string, unknown> = {};
  try {
    map = (JSON.parse(t.recordings ?? "{}") as Record<string, unknown>) ?? {};
  } catch {
    // unreadable: written anew with the cut alone
  }
  map[CUTS] = { ...recordingCuts(t), [asset]: cut };
  await db.updateTable("timelines").set({ recordings: JSON.stringify(map) }).where("id", "=", timelineId).execute();
}
