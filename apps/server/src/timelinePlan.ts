import { FRAME_SLACK_MS, joinFrames, joinWay, latentFrameAtOrBefore, LATENT_FPS, type Recipe } from "@afflatus/core";
import { FfmpegMissing } from "./cut";
import { frozenTailAt } from "./measure";
import { newId, now, type Db } from "./db";
import { httpError, notFound } from "./errors";
import type { Registry } from "./registry";
import type { TimelineMedia } from "./timelineMedia";
import type { TimelineTakes } from "./timelineTakes";
import { FROM_PREVIOUS, landingOnGrid, mirroredPins, plays, stillRef, type AssetRow, type ClipRow, type Placed, type TakeRow, type TimelineCore } from "./timelineModel";

/**
 * What a clip is made from: a new clip's model and form (taken over from the clips before it), a scene planned as
 * several clips, and, just before its job is sent, what it is given of its neighbours.
 */

/** What a clip's job needs to know about its neighbours, worked out just before it is sent. */
export interface ClipPlan {
  input: Record<string, unknown>;
  canvas?: { width: number; height: number };
  /** What it was made from besides its own inputs, for the lineage. */
  sources: Array<{ asset: string; role: string }>;
  links: TakeLinks;
  /** The pinned pictures flipped left to right as they are uploaded: those of the job's flips that are the user's own pins here (mirroredPins). */
  mirror: string[];
}
export interface TakeLinks {
  prev?: { take: string; at: number };
  next?: { take: string; at: number };
}

/**
 * A recipe's inputs without the ones a timeline fills in itself (the clips it joins onto). A source video is the clip's own
 * (Motion transfer's driving video, its part of a timeline's source lane): kept.
 */
export const ownInputIds = (recipe: Recipe<any>) => new Set(recipe.inputs.filter((i) => i.type !== "clip" || i.role === "source").map((i) => i.id));
function ownInputs(recipe: Recipe<any>, input: Record<string, unknown>): Record<string, unknown> {
  const ids = ownInputIds(recipe);
  return Object.fromEntries(Object.entries(input).filter(([id]) => ids.has(id)));
}

/**
 * Where a clip that carries on picks up from a clip before whose latent was kept: on the latent's grid (17k + 5 frames), at or
 * before the moment asked, so the join is made in the latent. Off the grid, the queue joins on frames instead (finishLatent),
 * which a trim made by hand nearly always lands on. The very end of the video stays as it is (the whole latent is taken), and so
 * does a moment whose grid frame would leave fewer frames than the run-up the form asks for.
 */
export function handoverOnGrid(atMs: number, before: { durationMs: number; latentFrames: number | null }, runUpFrames: number): number {
  if (!before.latentFrames || atMs >= before.durationMs - FRAME_SLACK_MS) return atMs;
  const frame = Math.round((atMs * LATENT_FPS) / 1000);
  const grid = latentFrameAtOrBefore(frame);
  if (grid === frame || grid < runUpFrames) return atMs;
  return Math.round(grid * (1000 / LATENT_FPS));
}

/**
 * Where a clip before that ends frozen hands over, from the last moment it still moves (`livelyMs`): on a frame of its kept
 * latent's grid (17k + 5 frames, at or before that moment) so the join is made in the latent, cut there, unless that leaves
 * fewer frames than the run-up the form takes; else on a whole frame of the model that made it (SCAIL-2's 16 a second, not
 * H3's 24), the frames handed over being whole frames of it. A video of unknown making hands over where it stopped moving.
 */
export function handoverFrame(livelyMs: number, before: { latentFrames: number | null; fps: number | null | undefined }, runUpFrames: number): number {
  if (before.latentFrames) {
    const frame = Math.round((livelyMs * LATENT_FPS) / 1000);
    const grid = latentFrameAtOrBefore(frame);
    return Math.round((grid >= runUpFrames ? grid : frame) * (1000 / LATENT_FPS));
  }
  const fps = before.fps;
  return fps ? Math.round(Math.round((livelyMs * fps) / 1000) * (1000 / fps)) : livelyMs;
}

/** What a new clip takes over from the nearest clip before it made with the same recipe: its settings, not its story or its pictures. */
export function settingsOf(recipe: Recipe<any>, all: Placed[], index: number): Record<string, unknown> {
  const before = all.slice(0, index).reverse().find((p) => p.clip.recipe_id === recipe.id);
  if (!before) return {};
  const keep = new Set(recipe.inputs.filter((i) => !["prompt", "image", "clip", "seed"].includes(i.type)).map((i) => i.id));
  return Object.fromEntries(Object.entries(JSON.parse(before.clip.inputs) as Record<string, unknown>).filter(([id]) => keep.has(id)));
}

/** A video recipe that opens on a picture: `preferred` when it does, else the first that does. */
export function recipeWithStart(registry: Registry, preferred: string | null): Recipe<any> | undefined {
  const opens = (r: Recipe<any> | undefined) => r?.output === "video" && r.inputs.some((i) => i.type === "image" && i.role === "start");
  const own = preferred ? registry.recipe(preferred) : undefined;
  return opens(own) ? own : registry.recipes().find(opens);
}

/** What a new clip is, before it is written (see TimelinePlan.newClip). */
export type NewClip = Awaited<ReturnType<TimelinePlan["newClip"]>>;

export class TimelinePlan {
  constructor(private readonly core: TimelineCore, private readonly takes: TimelineTakes, private readonly media: TimelineMedia) {}

  /**
   * A scene written as several clips (by the designer): one new clip for each, at the end, each flowing on from the one
   * before, its texts in its form. Nothing is rendered. One step to undo.
   */
  async planClips(timelineId: string, recipe: string, texts: Array<Record<string, string>>): Promise<string[]> {
    if (!this.core.registry.recipe(recipe)) throw httpError(`there is no model or operation called ${recipe}`);
    await this.core.row(timelineId);
    // in the timeline's turn, from the reading of its clips to the writing of the new ones: a clip added meanwhile took a
    // place one of them was given too
    const ids = await this.core.oneAtATime(timelineId, async () => {
      const all = await this.core.placed(timelineId);
      const made: NewClip[] = [];
      for (const k of texts.keys()) made.push(await this.newClip(all, all.length + k, { recipe }));
      await this.core.remember(timelineId, texts.length > 1 ? "the clips planned" : "the clip added");
      return this.core.db.transaction().execute(async (tx) => {
        const order: Array<Pick<Placed, "clip">> = [...all];
        const out: string[] = [];
        for (const [k, text] of texts.entries()) {
          const id = await this.insertClip(timelineId, order, order.length, { ...made[k]!, inputs: { ...made[k]!.inputs, ...text } }, tx, false);
          order.push({ clip: { id } as ClipRow });
          out.push(id);
        }
        await this.core.renumber(timelineId, order.map((p) => p.clip.id), tx);
        return out;
      });
    });
    await this.core.touch(timelineId);
    return ids;
  }

  /** What a new clip at `index` is: its kind, model, form and how it starts, and the take or picture it comes with. Nothing is written. */
  async newClip(all: Placed[], index: number, opts: { asset?: string; recipe?: string; as?: "still" | "clip" }) {
    const { db, registry } = this.core;
    // a new clip is made the way the last rendered clip before it was. Not as a window of the source (Motion transfer): it
    // would have no driving video. After one, as another clip of the timeline, else with no model yet (the editor gives its own)
    const last = all.slice(0, index).reverse().find((p) => p.clip.recipe_id);
    const windowed = (p: Placed) => Boolean(registry.recipe(p.clip.recipe_id ?? "")?.traits?.windows);
    const other = (p: Placed) => Boolean(p.clip.recipe_id) && !windowed(p);
    const lastRecipe = (last && windowed(last) ? (all.slice(0, index).reverse().find(other) ?? all.find(other)) : last)?.clip.recipe_id ?? null;
    let recipeId = opts.recipe ?? lastRecipe;
    let inputs: Record<string, unknown> = {};
    let joined: ClipRow["joined"] = "continue";
    let kind: ClipRow["kind"] = "video";
    let still: string | null = null;
    let take: { asset: AssetRow; head: number; tail: number; latent?: boolean; frames?: boolean } | null = null;

    const asset = await this.core.assetRow(opts.asset ?? null);
    if (opts.asset && !asset) throw notFound("this item");
    const made = asset?.generation_id ? await db.selectFrom("generations").selectAll().where("id", "=", asset.generation_id).executeTakeFirst() : undefined;

    if (asset?.kind === "video") {
      // what it was made with comes along, so that another take can be made of it
      const recipe = made ? registry.recipe(made.recipe_id) : undefined;
      if (made && recipe) {
        recipeId = recipe.id;
        inputs = ownInputs(recipe, JSON.parse(made.inputs) as Record<string, unknown>);
      } else recipeId = null;
      const overlap = made ? (JSON.parse(made.resolved) as { overlap?: { headMs: number; tailMs: number; latent?: boolean; frames?: boolean } }).overlap : undefined;
      take = { asset, head: overlap?.headMs ?? 0, tail: overlap?.tailMs ?? 0, latent: overlap?.latent, frames: overlap?.frames };
      // a video brought in starts on its own: it was not made to follow what is before it
      joined = "cut";
    } else if (asset?.kind === "image" && opts.as === "clip") {
      const recipe = recipeWithStart(registry, recipeId);
      if (!recipe) throw httpError("None of your video models takes a first frame (i2v).");
      recipeId = recipe.id;
      inputs = { ...settingsOf(recipe, all, index), [recipe.inputs.find((i) => i.type === "image" && i.role === "start")!.id]: asset.id };
      joined = "cut";
    } else if (asset?.kind === "image") {
      kind = "still";
      still = asset.id;
      recipeId = null;
      joined = "cut";
    } else if (asset) {
      throw httpError("Only videos and images go on the video track. Audio goes on a clip, or on the music track.");
    } else {
      const recipe = recipeId ? registry.recipe(recipeId) : undefined;
      if (recipe) inputs = settingsOf(recipe, all, index);
    }
    // after a clip it cannot carry on from (another family, or a model that does not carry on) it starts on its own: a Cut,
    // the default across two models (Extend stays possible, set on the join, with its warning; joinWay)
    const before = all[index - 1];
    if (joined === "continue" && before?.clip.kind === "video" && before.clip.recipe_id && recipeId && joinWay(registry.recipe(before.clip.recipe_id), registry.recipe(recipeId)) === "cut") joined = "cut";
    // the cast and places of the clip before come along when it has its own: set once, not again for every clip
    const look = kind === "video" ? (all[index - 1]?.clip.look ?? null) : null;
    return { kind, recipeId, inputs, joined, still, take, asset, look };
  }

  /**
   * The clip, its place among the others and its take, written in the transaction `tx`. `renumber` false: the others are not
   * moved along, for a caller that adds several and renumbers once (each renumbering the timeline, 12 clips of a recording
   * wrote 1,878 positions).
   */
  async insertClip(timelineId: string, all: Array<{ clip: { id: string } }>, index: number, made: NewClip, tx: Db, renumber = true): Promise<string> {
    const id = newId();
    const at = now();
    const order = all.map((p) => p.clip.id);
    order.splice(index, 0, id);
    await tx
      .insertInto("clips")
      .values({
        id, timeline_id: timelineId, position: index, take_id: null, joined: made.joined, recipe_id: made.recipeId, inputs: JSON.stringify(made.inputs),
        kind: made.kind, still_asset_id: made.still, still_ms: 3000, sound: "own", sound_asset_id: null, volume: 100, fill: 0, look: made.look ?? null, chat: null, created_at: at, updated_at: at,
      })
      .execute();
    if (renumber) await this.core.renumber(timelineId, order, tx);
    const take = made.take;
    if (take) await this.takes.add(id, take.asset, { headMs: take.head, tailMs: take.tail, latent: take.latent, frames: take.frames }, {}, null, tx);
    if (made.still) await this.core.keep(made.still, tx);
    return id;
  }

  /**
   * Just before a clip's job is sent: its inputs with its neighbours filled in. A clip that carries on
   * from the one before is given that clip's video and the moment it stops playing (after a still: the
   * picture, to open on); a take made to fit is given the next clip's video and the moment it starts playing.
   * `quick`: for the forecast of a clip still waiting, nothing is measured or made (where the clip before stops
   * moving, its last frame as a picture) and a clip before with no take yet is no error: what it joins onto, as
   * far as it is known now, without the work. `flips`: the pinned pictures the job was sent to flip (its clip's Mirror).
   * `placed`: where the timeline's clips are read, for a request that plans many clips of it (Timelines.placedOnce); each
   * reading the whole timeline again, the editor's forecasts of a 150-clip timeline took 1.4 s.
   */
  async plan(clipId: string, recipe: Recipe<any>, raw: Record<string, unknown>, fit: boolean, finishedFrom: string | null = null, quick = false, flips: readonly string[] = [], placed: (timelineId: string) => Promise<Placed[]> = (id) => this.core.placed(id)): Promise<ClipPlan> {
    const clip = await this.core.clipRow(clipId);
    const t = await this.core.row(clip.timeline_id);
    const all = await placed(clip.timeline_id);
    const i = all.findIndex((p) => p.clip.id === clipId);
    const plan: ClipPlan = { input: ownInputs(recipe, raw), sources: [], links: {}, mirror: [] };
    if (t.width && t.height) plan.canvas = { width: t.width, height: t.height };
    if (clip.joined === "continue" && i > 0) await this.carryOn(plan, all[i - 1]!, recipe, raw, finishedFrom, quick);
    await this.recordingRun(plan, recipe, raw, all, i);
    const startSpec = recipe.inputs.find((s) => s.type === "image" && s.role === "start");
    if (startSpec && plan.input[startSpec.id] === FROM_PREVIOUS && !quick) {
      throw httpError("This clip extends the previous clip from its last frame, and that clip has no take yet.");
    }
    const after = i < all.length - 1 ? all[i + 1]! : null;
    const nextSpec = recipe.inputs.find((s) => s.type === "clip" && s.role === "next");
    // a clip with its own last frame pinned ends on that picture: given the next clip's video too, both would guide the
    // same last frames (the take bends toward the next clip, then the pinned frame snaps in), so the pin wins
    const endSpec = recipe.inputs.find((s) => s.type === "image" && s.role === "end");
    const pinnedEnd = Boolean(endSpec && typeof plan.input[endSpec.id] === "string" && plan.input[endSpec.id] !== "");
    if (fit && !pinnedEnd && nextSpec && after?.active && after.clip.joined === "continue") {
      const at = landingOnGrid(after.active, joinFrames(recipe, "next", raw));
      plan.input[nextSpec.id] = { asset: after.active.asset.id, at };
      plan.links.next = { take: after.active.take.id, at };
    }
    // a frame carried on from the clip before, or landed on in the clip after, is never flipped: the join would no longer meet
    plan.mirror = mirroredPins(recipe, plan.input, flips, { carries: clip.joined === "continue" && i > 0, lands: Boolean(plan.links.next) });
    return plan;
  }

  /**
   * What a clip that carries on from `prior` is given: a still's picture to open on; else the video before and the moment it
   * stops playing (handed over before its frozen tail, on its latent's grid when that was kept), or its last frame to open on.
   */
  private async carryOn(plan: ClipPlan, prior: Placed, recipe: Recipe<any>, raw: Record<string, unknown>, finishedFrom: string | null, quick: boolean) {
    const prevSpec = recipe.inputs.find((s) => s.type === "clip" && s.role === "previous");
    const startSpec = recipe.inputs.find((s) => s.type === "image" && s.role === "start");
    const before = prior.active;
    if (prior.clip.kind === "still" && prior.still && startSpec) {
      plan.input[startSpec.id] = prior.still.id;
      plan.links.prev = { take: stillRef(prior.still.id), at: 0 };
      return;
    }
    if (!before) return;
    let at = plays(before).end;
    // a finish's re-render carries on from the same video and moment as its draft (its own render's input), while the clip
    // before is that video or its finish (the finish route skips a clip that is not, see timelines-api)
    const carried = finishedFrom && prevSpec ? (raw[prevSpec.id] as { asset?: string; at?: number } | undefined) : undefined;
    const beforeDraft = before.take.finished_from ? (await this.core.db.selectFrom("takes").select("asset_id").where("id", "=", before.take.finished_from).executeTakeFirst())?.asset_id : undefined;
    const sameBefore = Boolean(carried?.asset && typeof carried.at === "number" && (carried.asset === before.asset.id || carried.asset === beforeDraft));
    if (sameBefore) at = carried!.at!;
    if (prevSpec) {
      // the clip before ends frozen: hand over where it still moved, unless the form says not to
      // a window of a long source carries on exactly where the window before ends: its part of the source starts there
      if (raw.handover !== false && !sameBefore && !quick && !recipe.traits?.windows) {
        // ffmpeg missing is said, not taken for a clip that moves to its end
        const lively = await this.handoverAt(before).catch((err: Error) => {
          if (err instanceof FfmpegMissing) throw err;
          return null;
        });
        if (lively !== null && lively < at - FRAME_SLACK_MS) {
          const fps = this.core.registry.recipe(prior.clip.recipe_id ?? "")?.traits?.fps ?? before.asset.fps;
          at = handoverFrame(lively, { latentFrames: before.asset.latent_frames, fps }, joinFrames(recipe, "previous", raw));
        }
      }
      // a clip before trimmed by hand stops wherever its out point was put: picked up on the latent's grid all the same, and
      // that clip then stops there when the take comes back (TimelineTakes, the hand-over before the frozen tail)
      if (!sameBefore) at = handoverOnGrid(at, { durationMs: before.asset.duration_ms ?? 0, latentFrames: before.asset.latent_frames }, joinFrames(recipe, "previous", raw));
      plan.input[prevSpec.id] = { asset: before.asset.id, at };
      plan.links.prev = { take: before.take.id, at };
    } else if (startSpec && recipe.traits?.continues === "frame" && !quick) {
      // a recipe that opens on a picture picks up from the last frame that plays
      plan.input[startSpec.id] = (await this.media.frame(before.asset, Math.max(0, at - FRAME_SLACK_MS), true)).id;
      plan.sources.push({ asset: before.asset.id, role: "previous" });
      plan.links.prev = { take: before.take.id, at };
    }
  }

  /**
   * A recording that runs on across clips (a song, Lip sync's parts end to end): a clip whose part the next clip's carries on
   * hands over the recording itself after its part (the window's `goesOn`), not its end faded out; and a clip after one made
   * so starts its part where that clip's sound stops playing, keeping its own end. A clip outlasts its part (the pad and the
   * frame grid: 0.69 s at 8 s parts); faded, that tail fell silent while its mouth went on, and the next clip sang those
   * words again (Timeline 24, 2026-10-24). A clip before made without it (before this, or the last of its run) is left as it is.
   */
  private async recordingRun(plan: ClipPlan, recipe: Recipe<any>, raw: Record<string, unknown>, all: Placed[], i: number) {
    const spec = recipe.inputs.find((s) => s.type === "audio" && s.window?.goesOn);
    if (spec?.type !== "audio" || !spec.window?.goesOn || typeof raw[spec.id] !== "string") return;
    const w = spec.window;
    const goesOn = w.goesOn!;
    // a clip's part of the same recording, from its form (where the recording's cut put it)
    const partOf = (inputs: Record<string, unknown>) => ({ start: Number(inputs[w.start]), seconds: Number(inputs[w.seconds]) });
    const sameRecording = (p: Placed | undefined) => (p?.clip.recipe_id === recipe.id && (JSON.parse(p.clip.inputs) as Record<string, unknown>)[spec.id] === raw[spec.id] ? partOf(JSON.parse(p.clip.inputs) as Record<string, unknown>) : null);
    const meets = (a: { start: number; seconds: number }, b: { start: number; seconds: number }) => Math.abs(a.start + a.seconds - b.start) <= 0.05;
    const own = partOf(raw);
    if (!Number.isFinite(own.start) || !Number.isFinite(own.seconds)) return;
    const next = sameRecording(all[i + 1]);
    if (next && meets(own, next)) plan.input[goesOn] = true;
    // where the clip before's sound stops playing, in the recording: its part's start as it was rendered, plus how far into its
    // file it plays, less what comes before its part there (the frames of the clip before it, the moment before the words)
    const prior = all[i - 1];
    const before = sameRecording(prior);
    if (!before || !meets(before, own) || !prior?.active) return;
    const genId = prior.active.asset.generation_id;
    const made = genId ? await this.core.db.selectFrom("generations").select("inputs").where("id", "=", genId).executeTakeFirst() : undefined;
    const was = made ? (JSON.parse(made.inputs) as Record<string, unknown>) : null;
    if (!was?.[goesOn]) return;
    // its head (the frames it shares with that clip) sounds of the recording that clip sang, not of the model's guess at it
    if (w.leadIn) plan.input[w.leadIn] = true;
    const fps = w.fits?.fps ?? 24;
    const lead = Math.round((w.fits?.less ?? []).reduce((sum, id) => sum + (Number(was[id]) || 0), 0) * fps) / fps;
    const endMs = Math.min(plan.links.prev?.at ?? plays(prior.active).end, prior.active.asset.duration_ms ?? Infinity);
    const reached = Number(was[w.start]) + (endMs - prior.active.take.head_ms) / 1000 - lead;
    const end = own.start + own.seconds;
    // nothing to skip, or so little left that the clip would be under a second: its part as it was cut
    if (!Number.isFinite(reached) || reached <= own.start + 0.01 || end - reached < 1) return;
    plan.input[w.start] = Math.round(reached * 1000) / 1000;
    plan.input[w.seconds] = Math.round((end - reached) * 1000) / 1000;
  }

  /** The moment the clip before should hand over: before its frozen tail when it has one, else null. */
  private async handoverAt(before: { take: TakeRow; asset: AssetRow }): Promise<number | null> {
    const { rate, values } = await this.media.motion(before.asset.id);
    const { start, end } = plays(before);
    return frozenTailAt(values, rate, start, end);
  }
}
