import { chatJson } from "./llm";
import type { EventEmitter } from "node:events";
import { duckCurve, type DuckCurve } from "./duck";
import { joinWay, musicPlan, plural, recordingParts, sameWindowGrid, typedSeed, type ClipMusic, type InputSpec, type Transition } from "@afflatus/core";
import { newId, now, OWNER, type Db } from "./db";
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
import { TimelineHistory } from "./timelineHistory";
import { TimelineRange } from "./timelineRange";
import { takeView, TimelineViews } from "./timelineViews";
import { ownInputIds, recipeWithStart, settingsOf, TimelinePlan, type ClipPlan, type NewClip, type TakeLinks } from "./timelinePlan";
import { clipsOfSource, patchedSource, planWindows, sourceOfRow, windowFormFor, windowRunUp, type SourcePatch, type SourcePlan } from "./timelineSource";
import { TimelineTakes } from "./timelineTakes";
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
      settingsOf, frame: (video, atMs, once, timeline) => this.media.frame(video, atMs, once, timeline), motion: (id) => this.media.motion(id),
    };
    this.range = new TimelineRange(core);
    this.media = new TimelineMedia(core);
    this.exporter = new TimelineExport(core, (asset) => this.media.means(asset));
    this.takes = new TimelineTakes(core);
    this.planner = new TimelinePlan(core, this.takes, this.media);
    this.history = new TimelineHistory(db, (id) => this.row(id), () => this.changed());
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
        plannedMs: all.reduce((sum, p) => sum + plannedLengthOf(p, p.clip.recipe_id ? this.registry.recipe(p.clip.recipe_id) : undefined), 0),
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
      // a finished take (an upscale, made by a cut) is not measured: it has the figures of the take it was finished from,
      // the same frames, so that clips still compare like for like whether they play their finished take or not
      const from = takes.find((y) => y.take.id === x.take.finished_from);
      const source = from?.asset.generation_id ? rendered.get(from.asset.generation_id) : undefined;
      return source?.measure ? { genMs: own?.genMs ?? null, measure: source.measure, recipe: own?.recipe ?? source.recipe } : own;
    };
    const viewOf = (takes: Taken[]) => (x: Taken) => takeView(x, renderOf(x, takes));
    let at = 0;
    const clips = all.map((p, i) => {
      const length = lengthOf(p);
      const job = live.get(p.clip.id);
      const ended = last.get(p.clip.id);
      const view = {
        id: p.clip.id, kind: p.clip.kind, joined: p.clip.joined, join: this.joinState(all, i), recipe: p.clip.recipe_id,
        inputs: JSON.parse(p.clip.inputs) as Record<string, unknown>,
        take: p.active ? viewOf(p.takes)(p.active) : null,
        takes: p.takes.map(viewOf(p.takes)),
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
    return { ...(await this.views.headOf(t)), durationMs: at, clips };
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
      const end = all.reduce((sum, p) => sum + plannedLengthOf(p, p.clip.recipe_id ? this.registry.recipe(p.clip.recipe_id) : undefined), 0);
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
   * Picture taken away is not taken from the others. A clip of another video, or of another model, is left alone. Its
   * takes stay; its next take is made with the new form.
   */
  private async sameForm(timelineId: string, from: Pick<ClipRow, "id" | "recipe_id" | "inputs"> | null, inputs: Record<string, unknown>, tx: Db, share?: ClipPatch["share"]) {
    const t = await tx.selectFrom("timelines").select(["source"]).where("id", "=", timelineId).executeTakeFirst();
    const plan = sourceOfRow(t?.source);
    if (!plan?.recipe) return;
    const recipe = this.registry.recipe(plan.recipe);
    const driving = recipe?.inputs.find((i) => i.type === "clip" && i.role === "source" && i.window);
    if (!recipe || !driving || driving.type !== "clip" || !driving.window) return;
    const bound = (inp: Record<string, unknown>) => (inp[driving.id] as { asset?: string } | undefined)?.asset === plan.asset;
    if (from && (from.recipe_id !== recipe.id || !bound(inputs))) return;
    const pictures = new Set(recipe.inputs.filter((i) => i.type === "image").map((i) => i.id));
    const ids = recipe.inputs.filter((i) => i.type !== "clip" && i.id !== "seed" && i.id !== driving.window!.start && i.id !== driving.window!.seconds).map((i) => i.id);
    const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const was = from ? (JSON.parse(from.inputs) as Record<string, unknown>) : {};
    const clips = (await tx.selectFrom("clips").select(["id", "inputs"]).where("timeline_id", "=", timelineId).where("recipe_id", "=", recipe.id).execute())
      .map((c) => ({ id: c.id, inputs: JSON.parse(c.inputs) as Record<string, unknown> }))
      .filter((c) => bound(c.inputs));
    // what each clip keeps its own, the ones gone forgotten
    const apart: Record<string, string[]> = Object.fromEntries(Object.entries(plan.apart ?? {}).filter(([id]) => clips.some((c) => c.id === id)));
    const mine = from ? apart[from.id] ?? [] : [];
    const changed = from ? ids.filter((k) => !same(was[k], inputs[k])) : ids.filter((k) => k in inputs);
    // what each window keeps its own (its prompt) goes to the others only when given to all; the run-up is the cut's, the
    // same in every window whatever is set apart (a window carrying on from another count would no longer meet its part)
    const ownIds = new Set(recipe.traits?.windows?.own ?? []);
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
    // the first window's prompt written (Swap motion's: Make came before it, on an empty form): the windows that carry on
    // and still hold what was made for its old prompt take what its new one makes (windowCarryOn); one written by hand stays
    if (from && recipe.windowCarryOn) {
      const before = recipe.windowCarryOn(was);
      const after = recipe.windowCarryOn(inputs);
      const follow = Object.keys(after).filter((k) => !same(before[k], after[k]));
      const opens = follow.length ? (await tx.selectFrom("clips").select("joined").where("id", "=", from.id).executeTakeFirst())?.joined === "cut" : false;
      if (opens) {
        const rows = await tx.selectFrom("clips").select(["id", "inputs", "joined"]).where("timeline_id", "=", timelineId).where("recipe_id", "=", recipe.id).execute();
        for (const r of rows) {
          if (r.id === from.id || r.joined !== "continue") continue;
          const held = JSON.parse(r.inputs) as Record<string, unknown>;
          if (!bound(held)) continue;
          const keep = follow.filter((k) => same(held[k], before[k]));
          if (keep.length) await tx.updateTable("clips").set({ inputs: JSON.stringify({ ...held, ...Object.fromEntries(keep.map((k) => [k, after[k]])) }), updated_at: now() }).where("id", "=", r.id).execute();
        }
      }
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
  /** What `anew` drops: every clip the source made, from the first one's place; none of them in the queue. */
  private async allAnew(all: Placed[], plan: SourcePlan) {
    const ofSource = clipsOfSource(plan, all.map((p) => p.clip), (r) => this.registry.recipe(r));
    if (!ofSource.length) throw httpError("The source has no clips to make anew: make them first.");
    const busy = await this.db.selectFrom("jobs").select("clip_id").where("clip_id", "in", ofSource).where("status", "in", ["queued", "running"]).executeTakeFirst();
    if (busy) throw httpError("A clip of the source is rendering or in the queue: let it end, or stop it, to change the source's model.", 409);
    return { kept: 0, drop: ofSource, after: undefined, index: all.findIndex((p) => p.clip.id === ofSource[0]), form: undefined };
  }

  /**
   * The source given another form that makes it window by window (from its Model list, or a window clip's). Between forms
   * of one grid (H3's Swap character, Swap motion, Motion transfer), in place: its windows keep their parts, their own
   * settings and their takes, and each one's next take is made with the new form; a window that carries on with the
   * carried-on settings of the old form (Swap motion's motion prompt) takes the new form's, or window 1's when it has none.
   * Across grids (SCAIL-2 and H3), every window made anew, rendered or not (makeFromSource `anew`): the editor says so
   * before it asks. Nothing made yet: only the source's model. One step to undo either way.
   */
  async sourceForm(timelineId: string, recipeId: string): Promise<{ switched: boolean; clips: string[] }> {
    const next = this.registry.recipe(recipeId);
    if (!next?.traits?.windows) throw httpError(`${next?.title ?? recipeId} does not make a long video window by window.`);
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
    await this.history.oneAtATime(timelineId, async () => {
      await this.remember(timelineId, `the source made with ${next.title}`);
      const mine = all.filter((p) => ofSource.includes(p.clip.id));
      const own = [...new Set([...(old.traits?.windows?.own ?? []), ...(next.traits?.windows?.own ?? [])])];
      const pick = (form: Record<string, unknown>) => Object.fromEntries(own.map((k) => [k, form[k]]));
      const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
      const first = windowFormFor(old, next, JSON.parse(mine[0]!.clip.inputs) as Record<string, unknown>);
      const firstOld = JSON.parse(mine[0]!.clip.inputs) as Record<string, unknown>;
      await this.db.transaction().execute(async (tx) => {
        for (const p of mine) {
          let inputs = windowFormFor(old, next, JSON.parse(p.clip.inputs) as Record<string, unknown>);
          if (p.clip.joined === "continue" && p !== mine[0]) {
            // what it carried on with, as the old form gave it, or window 1's own: the new form's carried-on settings
            const carried = old.windowCarryOn ? { ...pick(firstOld), ...old.windowCarryOn(firstOld) } : pick(firstOld);
            if (same(pick(inputs), pick(carried))) inputs = { ...inputs, ...pick(first), ...(next.windowCarryOn?.(first) ?? {}) };
          }
          await tx.updateTable("clips").set({ recipe_id: next.id, inputs: JSON.stringify(inputs), updated_at: now() }).where("id", "=", p.clip.id).execute();
        }
        await tx.updateTable("timelines").set({ source: JSON.stringify({ ...plan, recipe: next.id }), updated_at: now() }).where("id", "=", timelineId).execute();
      });
    });
    await this.touch(timelineId);
    return { switched: true, clips: [] };
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
    return { kept: kept.length, drop, after, index: all.findIndex((p) => p.clip.id === drop[0]), form: JSON.parse(mine[0]!.clip.inputs) as Record<string, unknown> };
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
   */
  async makeFromSource(timelineId: string, opts: { again?: boolean; anew?: boolean; recipe?: string } = {}): Promise<string[]> {
    // the source's scene cuts read before the timeline is held (the first time, ffmpeg reads every frame of it): inside, they are read back
    const asked = sourceOfRow((await this.row(timelineId)).source);
    if (asked?.snap) await this.media.scenes(asked.asset).catch(() => {});
    const ids = await this.history.oneAtATime(timelineId, async () => {
      const t = await this.row(timelineId);
      const plan = sourceOfRow(t.source);
      if (!plan) throw httpError("Drop a video on the Source lane first.");
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
      const again = opts.anew ? await this.allAnew(all, plan) : opts.again ? await this.cutAgain(all, plan, driving) : null;
      const windows = await planWindows(plan, recipe, video, (id) => this.media.scenes(id), again?.after);
      if (!windows.length) throw httpError(again?.after !== undefined ? "Nothing of the stretch is left after the rendered clips." : "The stretch is too short for one clip: make it longer.");
      // in place of the clip the stretch was taken from (still the same video), or of the empty clip it was dropped for (its
      // model the windows'), else after the last clip
      const replaced = again ? -1 : plan.clip ? all.findIndex((p) => p.clip.id === plan.clip && (p.active ? p.active.asset.id === plan.asset : !p.clip.take_id)) : -1;
      const index = again ? again.index : replaced >= 0 ? replaced : all.length;
      const startsAt = all.slice(0, index).reduce((sum, p) => sum + plannedLengthOf(p, p.clip.recipe_id ? this.registry.recipe(p.clip.recipe_id) : undefined), 0);
      // a seed only when one was typed on the source form: else each render draws its own, as for a new clip (the shared
      // Picture keeps the person the same from window to window, not a seed). One drawn here would be a typed seed to the
      // seed mode, every New take sent with it again
      const seed = typedSeed(plan.inputs.seed);
      // the form every window is made with: the settings of the last clip of that model, then the source's own form; the
      // clips a timeline fills in itself and the driving video's part are each window's
      const own = ownInputIds(recipe);
      const form = Object.fromEntries(Object.entries(again?.form ?? { ...settingsOf(recipe, all, index), ...plan.inputs }).filter(([k]) => own.has(k) && k !== driving.id && k !== driving.window!.start && k !== driving.window!.seconds && !(again && k === "seed")));
      const pictureSpec = recipe.inputs.find((i) => i.type === "image" && i.role === "source");
      const picture = pictureSpec && typeof form[pictureSpec.id] === "string" ? (form[pictureSpec.id] as string) : null;
      await this.remember(timelineId, opts.anew ? `the source made anew with ${recipe.title}` : again ? "the source cut again" : `the ${windows.length} clips made from the source`);
      return this.db.transaction().execute(async (tx) => {
        const order: Array<{ clip: { id: string } }> = all.filter((p) => !again?.drop.includes(p.clip.id)).map((p) => ({ clip: { id: p.clip.id } }));
        if (again?.drop.length) await tx.deleteFrom("clips").where("id", "in", again.drop).execute();
        if (replaced >= 0) {
          await tx.deleteFrom("clips").where("id", "=", plan.clip!).execute();
          order.splice(replaced, 1);
        }
        const made: string[] = [];
        for (const [k, w] of windows.entries()) {
          const clip: NewClip = {
            kind: "video", recipeId: recipe.id, joined: w.opens ? "cut" : "continue", still: null, take: null, asset: undefined, look: null,
            // the first window replaces the person clicked on its first frame, the ones after follow it (h3.swap's pick)
            // a window that carries on starts on what the model gives those (Swap motion: its motion prompt, the swap's naming
            // <Video 1>, which a window driven by the pose has not)
            inputs: { ...form, ...(w.opens ? {} : recipe.windowCarryOn?.(form) ?? {}), [driving.id]: { asset: plan.asset, ...(k === 0 && !again?.kept && plan.pick && driving.pick ? { pick: plan.pick } : {}) }, [driving.window!.start]: w.start, [driving.window!.seconds]: w.seconds, ...(seed !== null ? { seed } : {}) },
          };
          const id = await this.planner.insertClip(timelineId, order, index + k, clip, tx);
          order.splice(index + k, 0, { clip: { id } });
          made.push(id);
        }
        // the source's start sits where its stretch now plays from; the clip it was taken from is gone. Cut again, it stays where
        // it was, and the clips it no longer has keep nothing apart
        const apart = plan.apart ? Object.fromEntries(Object.entries(plan.apart).filter(([id]) => !again?.drop.includes(id))) : undefined;
        const placedPlan = { ...(again ? { ...plan, clip: null, ...(apart ? { apart } : {}) } : { ...plan, atMs: startsAt - plan.fromMs, clip: null }), recipe: recipe.id };
        await tx.updateTable("timelines").set({ source: JSON.stringify(placedPlan), updated_at: now() }).where("id", "=", timelineId).execute();
        if (picture) await this.keep(picture, tx);
        return made;
      });
    });
    await this.touch(timelineId);
    return ids;
  }

  /**
   * A voice recording dropped on the track made into Lip sync clips: cut at its pauses (recordingParts) into parts of about
   * `seconds` (5 by default) within what one clip takes, one clip a part, each carrying on from the one before. In place of
   * the empty clip it was dropped on, else after the last clip. The model is the one whose form takes a recording laid on a
   * clip's sound part by part (H3 · Lip sync), with the settings of the last clip of it. One step for Undo; nothing renders.
   */
  async makeFromRecording(timelineId: string, o: { asset: string; clip?: string; seconds?: number }): Promise<string[]> {
    const recipe = this.registry.recipes().find((r) => r.output === "video" && r.inputs.some((i) => i.type === "audio" && i.role === "sound" && i.window));
    const spec = recipe?.inputs.find((i) => i.type === "audio" && i.role === "sound" && i.window);
    if (!recipe || !spec || spec.type !== "audio" || !spec.window) throw httpError("No model on this Afflatus makes a clip around a recording (MiniMax H3 · Lip sync).");
    const sound = await this.assetRow(o.asset);
    if (!sound || (sound.kind !== "audio" && sound.kind !== "video") || !sound.duration_ms) throw httpError("A recording has to be a sound (or a video's sound) of the library.");
    const { pauses } = await this.media.pauses(sound.id);
    const fits = spec.window.fits;
    const leastS = fits?.min ?? 1;
    const mostS = fits ? fits.frames / fits.fps - (fits.pad ?? 0) : 15;
    const parts = recordingParts({ fromS: 0, toS: sound.duration_ms / 1000, wantS: o.seconds ?? 5, leastS, mostS, pauses });
    if (!parts.length) throw httpError("The recording is too short for a clip.");
    const ids = await this.history.oneAtATime(timelineId, async () => {
      await this.row(timelineId);
      const all = await this.placed(timelineId);
      // the empty clip it was dropped on: the clips go in its place, with what was written in it (its scene)
      const replaced = o.clip ? all.findIndex((p) => p.clip.id === o.clip && !p.clip.take_id && p.clip.kind === "video") : -1;
      const index = replaced >= 0 ? replaced : all.length;
      const own = ownInputIds(recipe);
      const kept = replaced >= 0 && all[replaced]!.clip.recipe_id === recipe.id ? (JSON.parse(all[replaced]!.clip.inputs) as Record<string, unknown>) : {};
      const form = Object.fromEntries(Object.entries({ ...settingsOf(recipe, all, index), ...kept }).filter(([k]) => own.has(k) && k !== spec.id && k !== spec.window!.start && k !== spec.window!.seconds && k !== "seed"));
      const before = index > 0 ? all[index - 1] : undefined;
      // the first carries on from the clip before when it can (H3 to Lip sync: in the latent), else it starts on its own
      const opens = !before || before.clip.kind !== "video" || !before.clip.recipe_id || joinWay(this.registry.recipe(before.clip.recipe_id), recipe) === "cut";
      await this.remember(timelineId, `the ${plural(parts.length, "Lip sync clip")} made from the recording`);
      return this.db.transaction().execute(async (tx) => {
        const order: Array<{ clip: { id: string } }> = all.map((p) => ({ clip: { id: p.clip.id } }));
        if (replaced >= 0) {
          await tx.deleteFrom("clips").where("id", "=", o.clip!).execute();
          order.splice(replaced, 1);
        }
        const made: string[] = [];
        for (const [k, part] of parts.entries()) {
          const clip: NewClip = {
            kind: "video", recipeId: recipe.id, joined: k === 0 && opens ? "cut" : "continue", still: null, take: null, asset: undefined, look: null,
            inputs: { ...form, [spec.id]: sound.id, [spec.window!.start]: part.start, [spec.window!.seconds]: part.seconds },
          };
          const id = await this.planner.insertClip(timelineId, order, index + k, clip, tx);
          order.splice(index + k, 0, { clip: { id } });
          made.push(id);
        }
        await this.keep(sound.id, tx);
        return made;
      });
    });
    await this.touch(timelineId);
    return ids;
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
  async editClip(id: string, patch: ClipPatch) {
    const { timeline_id: timelineId } = await this.clipRow(id);
    const keys = Object.keys(patch).filter((k) => patch[k as keyof ClipPatch] !== undefined);
    if (keys.length && keys.every((k) => k === "chat" || k === "designer")) {
      // what was said to the designer, and with which language model, is not a change to the timeline: nothing to undo, nothing to redraw
      await this.db.updateTable("clips").set({
        ...(patch.chat !== undefined ? { chat: chatJson(patch.chat) } : {}),
        ...(patch.designer !== undefined ? { designer: patch.designer ? JSON.stringify(patch.designer) : null } : {}),
      }).where("id", "=", id).execute();
      return;
    }
    // in the timeline's turn, from the reading of the clips to the writing: a move worked out from the clips as read put
    // a clip added meanwhile at the same place as another
    await this.history.oneAtATime(timelineId, () => this.editClipInTurn(id, patch, keys));
    await this.touch(timelineId);
  }

  private async editClipInTurn(id: string, patch: ClipPatch, keys: string[]) {
    // read again in the turn: the clip may have changed while the turn was waited for
    const clip = await this.clipRow(id);
    const all = await this.placed(clip.timeline_id);
    const checked = await this.checkClipPatch(clip, patch, all);
    if (keys.every((k) => k === "inputs" || k === "share") && patch.inputs !== undefined && !patch.share) await this.rememberWriting(clip, all);
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
    return { animate, trims, order, pinnedNow: pinned ? (patch.inputs![pinned.id] as string) : null, mirror: this.mirrorAfter(clip, patch) };
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
    const clip = await this.clipRow(id);
    // in the timeline's turn and in one transaction: an Undo or a take landing never comes between the removal and the renumbering
    await this.history.oneAtATime(clip.timeline_id, () => this.db.transaction().execute(async (tx) => {
      await this.remember(clip.timeline_id, clip.kind === "still" ? "the image removed" : "the clip removed", undefined, tx);
      await tx.deleteFrom("clips").where("id", "=", id).execute();
      await this.renumber(clip.timeline_id, (await this.placed(clip.timeline_id, tx)).map((p) => p.clip.id), tx);
    }));
    await this.touch(clip.timeline_id);
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
    return duckCurve(laid, (id) => this.media.motion(id), plan);
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
