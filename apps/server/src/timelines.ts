import { chatJson } from "./designer";
import { createHash } from "node:crypto";
import type { EventEmitter } from "node:events";
import type { Recipe } from "@afflatus/core";
import { CutError, filmStrip, frameAt, joinVideos, rangeKeep, type ExportMusic, type ExportPart } from "./cut";
import { newId, now, OWNER, type Db, type Tables } from "./db";
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
  action: "copy" | "split" | "remove";
  crf?: number;
}

export const EXPORT_JOB = "afflatus.export";
export interface ExportOptions {
  timeline: string;
  /** Enlarge every frame at the end: 1 (as rendered), 1.5 or 2. */
  scale: number;
  music: boolean;
  /** Smooth motion: 48 pictures a second, worked out by ffmpeg from the pictures there are. */
  smooth?: boolean;
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
    const wanted = [...takes.map((t) => t.asset_id), ...clips.flatMap((c) => [c.still_asset_id, c.sound_asset_id]).filter((x): x is string => Boolean(x))];
    const assets = wanted.length ? await this.db.selectFrom("assets").selectAll().where("id", "in", wanted).execute() : [];
    const byId = new Map(assets.map((a) => [a.id, a]));
    return clips.map((clip) => {
      const own = takes.filter((t) => t.clip_id === clip.id && byId.has(t.asset_id)).map((take) => ({ take, asset: byId.get(take.asset_id)! }));
      return {
        clip, takes: own, active: own.find((t) => t.take.id === clip.take_id) ?? null,
        still: (clip.still_asset_id && byId.get(clip.still_asset_id)) || null,
        sound: (clip.sound_asset_id && byId.get(clip.sound_asset_id)) || null,
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
    const followed = b.active.take.prev_take_id === a.active.take.id && near(b.active.take.prev_at_ms, plays(a.active).end) && b.active.take.trim_start_ms === 0;
    const landed = a.active.take.next_take_id === b.active.take.id && near(a.active.take.next_at_ms, plays(b.active).start) && a.active.take.trim_end_ms === 0;
    return followed || landed ? "fresh" : "stale";
  }

  async list() {
    const rows = await this.db.selectFrom("timelines").selectAll().where("owner_id", "=", OWNER).orderBy("updated_at", "desc").execute();
    const items = [];
    for (const t of rows) {
      const all = await this.placed(t.id);
      const first = all.find((p) => p.active || p.still);
      items.push({
        id: t.id, name: t.name, width: t.width, height: t.height, updatedAt: t.updated_at, clips: all.length,
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
    const takeView = (x: { take: TakeRow; asset: AssetRow }) => ({
      id: x.take.id, asset: assetView(x.asset), headMs: x.take.head_ms, tailMs: x.take.tail_ms,
      trimStartMs: x.take.trim_start_ms, trimEndMs: x.take.trim_end_ms, startMs: plays(x).start, endMs: plays(x).end, createdAt: x.take.created_at,
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
    const exports = (await this.db.selectFrom("jobs").select(["id", "status", "inputs", "error"]).where("recipe_id", "=", EXPORT_JOB).orderBy("created_at", "desc").limit(30).execute())
      .filter((j) => (JSON.parse(j.inputs) as ExportOptions).timeline === id);
    const exporting = exports.find((j) => j.status === "queued" || j.status === "running");
    const exported = await this.assetRow(t.export_asset_id);
    return {
      id: t.id, name: t.name, width: t.width, height: t.height, updatedAt: t.updated_at, durationMs: at, clips,
      look: t.look ? (JSON.parse(t.look) as Look) : null,
      mood: t.mood ?? "",
      music: music ? { asset: assetView(music), volume: t.music_volume, fadeInMs: t.music_fade_in_ms, fadeOutMs: t.music_fade_out_ms, duck: Boolean(t.music_duck) } : null,
      /** What Undo would take back, in a few words; null when there is nothing to undo. */
      undo: undo?.label ?? null,
      exporting: exporting ? { id: exporting.id, status: exporting.status } : null,
      exported: exported && !exported.deleted_at ? assetView(exported) : null,
      exportFailed: !exporting && exports[0]?.status === "failed" ? exports[0].error : null,
    };
  }

  // ---------------------------------------------------------------- undo

  /** Keep what the timeline looks like now, before a change. `label` says what the change is, for the Undo button. */
  private async remember(timelineId: string, label: string) {
    const timeline = await this.row(timelineId);
    const clips = await this.db.selectFrom("clips").selectAll().where("timeline_id", "=", timelineId).execute();
    const takes = clips.length ? await this.db.selectFrom("takes").selectAll().where("clip_id", "in", clips.map((c) => c.id)).execute() : [];
    const last = await this.db.selectFrom("timeline_history").select("seq").where("timeline_id", "=", timelineId).orderBy("seq", "desc").executeTakeFirst();
    const seq = (last?.seq ?? 0) + 1;
    await this.db.insertInto("timeline_history").values({ id: newId(), timeline_id: timelineId, seq, label, snapshot: JSON.stringify({ timeline, clips, takes }), created_at: now() }).execute();
    await this.db.deleteFrom("timeline_history").where("timeline_id", "=", timelineId).where("seq", "<=", seq - HISTORY).execute();
    return seq;
  }

  /**
   * Take the last change back. What was rendered since is not lost: a take made after that change stays
   * on its clip, and stays the one that plays if it was.
   */
  async undo(timelineId: string): Promise<string> {
    const last = await this.db.selectFrom("timeline_history").selectAll().where("timeline_id", "=", timelineId).orderBy("seq", "desc").executeTakeFirst();
    if (!last) throw refused("There is nothing to undo.");
    const was = JSON.parse(last.snapshot) as { timeline: TimelineRow; clips: ClipRow[]; takes: TakeRow[] };
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
      await tx.deleteFrom("timeline_history").where("id", "=", last.id).execute();
      // a take that is back has its video back: removing it had sent the video to the bin
      if (kept.length) await tx.updateTable("assets").set({ deleted_at: null }).where("id", "in", kept.map((t) => t.asset_id)).where("deleted_at", "is not", null).execute();
    });
    this.changed();
    return last.label;
  }

  // ---------------------------------------------------------------- editing

  async create(name: string | undefined) {
    const id = newId();
    const at = now();
    const count = Number((await this.db.selectFrom("timelines").select((eb) => eb.fn.countAll().as("n")).executeTakeFirst())?.n ?? 0);
    await this.db
      .insertInto("timelines")
      .values({
        id, owner_id: OWNER, name: name?.trim() || `Timeline ${count + 1}`, width: null, height: null,
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
      patch.name !== undefined ? "the new name" : patch.width !== undefined ? "the new aspect ratio" : patch.look !== undefined ? "the change of characters" : patch.mood !== undefined ? "the look and mood" : m?.asset === null ? "the music removed" : m?.asset ? "the new music" : "the music's settings",
    );
    const within = (n: number, least: number, most: number) => Math.max(least, Math.min(most, Math.round(n)));
    await this.db
      .updateTable("timelines")
      .set({
        ...(patch.name !== undefined ? { name: patch.name.trim() || "Untitled" } : {}),
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
    await this.row(timelineId);
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
      const overlap = made ? (JSON.parse(made.resolved) as { overlap?: { headMs: number; tailMs: number } }).overlap : undefined;
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
    await this.touch(timelineId);
    return id;
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

  private async addTake(clipId: string, asset: AssetRow, overlap: { headMs: number; tailMs: number }, links: TakeLinks) {
    const id = newId();
    await this.db
      .insertInto("takes")
      .values({
        id, clip_id: clipId, asset_id: asset.id, head_ms: overlap.headMs, tail_ms: overlap.tailMs, trim_start_ms: 0, trim_end_ms: 0,
        prev_take_id: links.prev?.take ?? null, prev_at_ms: links.prev?.at ?? null, next_take_id: links.next?.take ?? null, next_at_ms: links.next?.at ?? null,
        created_at: now(),
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
      const at = plays(before).end;
      if (prevSpec) {
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

  /** A clip's job is done: its video becomes a take, and plays. The first take of a timeline decides its frame. */
  async finished(clipId: string, generationId: string, overlap: { headMs: number; tailMs: number } | undefined, links: TakeLinks): Promise<void> {
    const clip = await this.db.selectFrom("clips").selectAll().where("id", "=", clipId).executeTakeFirst();
    // the clip was removed while it rendered: the video is in the library all the same
    if (!clip) return;
    const asset = await this.db.selectFrom("assets").selectAll().where("generation_id", "=", generationId).where("kind", "=", "video").executeTakeFirst();
    if (!asset) return;
    await this.addTake(clipId, asset, overlap ?? { headMs: 0, tailMs: 0 }, links);
    await this.touch(clip.timeline_id);
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
  async strip(assetId: string, opts: { frames?: number; height?: number } = {}): Promise<Uint8Array> {
    const video = await this.assetRow(assetId);
    if (!video || video.kind !== "video") throw missing("this video");
    const sized = opts.frames || opts.height;
    const key = sized ? `strips/${video.id.slice(0, 2)}/${video.id}-${opts.frames ?? 0}x${opts.height ?? 0}.jpg` : `strips/${video.id.slice(0, 2)}/${video.id}.jpg`;
    const have = await this.storage.get(key).catch(() => null);
    if (have) return have;
    const bytes = await this.storage.get(video.file_key);
    const length = video.duration_ms ?? (await readVideo(bytes, extOf(video.mime))).facts?.durationMs;
    if (!length) throw new CutError("This video could not be read.");
    const strip = await filmStrip(bytes, extOf(video.mime), length, opts);
    await this.storage.put(key, strip);
    return strip;
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

  // ---------------------------------------------------------------- export

  /** The timeline as one video in the library: what plays, start to end, with its sounds and its music. */
  async export(id: string, opts: { scale?: number; music?: boolean; smooth?: boolean; signal?: AbortSignal } = {}) {
    const t = await this.row(id);
    const all = (await this.placed(id)).filter((p) => lengthOf(p) > 0);
    if (!all.length) throw new CutError("There is nothing to export yet: no clip of this timeline has a take.");
    const first = all[0]!.active?.asset ?? all[0]!.still;
    const frame = t.width && t.height ? { width: t.width, height: t.height } : { width: first?.width ?? 576, height: first?.height ?? 1024 };
    const fps = Math.round(Math.max(...all.map((p) => p.active?.asset.fps ?? 24), 1));
    const parts: ExportPart[] = [];
    for (const p of all) {
      const soundFile = p.clip.sound === "file" && p.sound ? { bytes: await this.storage.get(p.sound.file_key), ext: extOf(p.sound.mime) } : undefined;
      const heard = { sound: p.clip.sound, soundFile, volume: p.clip.volume / 100, fill: Boolean(p.clip.fill) };
      if (p.clip.kind === "still") {
        parts.push({ kind: "still", bytes: await this.storage.get(p.still!.file_key), ext: extOf(p.still!.mime), startMs: 0, endMs: p.clip.still_ms, hasSound: false, ...heard });
      } else {
        const x = p.active!;
        parts.push({ kind: "video", bytes: await this.storage.get(x.asset.file_key), ext: extOf(x.asset.mime), startMs: plays(x).start, endMs: plays(x).end, hasSound: Boolean(x.asset.has_sound), ...heard });
      }
    }
    const track = opts.music === false ? undefined : await this.assetRow(t.music_asset_id);
    const music: ExportMusic | undefined = track
      ? {
          bytes: await this.storage.get(track.file_key), ext: extOf(track.mime), durationMs: track.duration_ms ?? 0,
          volume: t.music_volume / 100, fadeInMs: t.music_fade_in_ms, fadeOutMs: t.music_fade_out_ms, duck: Boolean(t.music_duck),
        }
      : undefined;
    const bytes = await joinVideos(parts, frame, fps, { scale: opts.scale ?? 1, music, smoothTo: opts.smooth ? 48 : undefined, signal: opts.signal });
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
        id: assetId, owner_id: OWNER, kind: "video", origin: "exported", name: t.name, file_key: key, thumb_key: thumb ? thumbKey(assetId) : null,
        mime: "video/mp4", bytes: bytes.length, width: video.facts?.width ?? frame.width, height: video.facts?.height ?? frame.height,
        duration_ms: video.facts?.durationMs ?? null, fps: video.facts?.fps ?? fps, has_sound: 1, folder_id: null, generation_id: null,
        kept_at: at, deleted_at: null, created_at: at,
      })
      .execute();
    await this.db.updateTable("timelines").set({ export_asset_id: assetId }).where("id", "=", id).execute();
    this.events.emit("library");
    this.changed();
    return assetView(await this.db.selectFrom("assets").selectAll().where("id", "=", assetId).executeTakeFirstOrThrow());
  }
}
