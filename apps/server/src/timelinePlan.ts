import { FRAME_SLACK_MS, latentFrameAtOrBefore, MODEL_FPS, type Recipe } from "@afflatus/core";
import { FfmpegMissing, frozenTailAt } from "./cut";
import { newId, now, type Db } from "./db";
import { httpError, notFound } from "./errors";
import type { Registry } from "./registry";
import type { TimelineMedia } from "./timelineMedia";
import type { TimelineTakes } from "./timelineTakes";
import { FROM_PREVIOUS, landingOnGrid, plays, stillRef, type AssetRow, type ClipRow, type Placed, type TakeRow, type TimelineCore } from "./timelineModel";

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
}
export interface TakeLinks {
  prev?: { take: string; at: number };
  next?: { take: string; at: number };
}

/** A recipe's inputs without the ones a timeline fills in itself. */
function ownInputs(recipe: Recipe<any>, input: Record<string, unknown>): Record<string, unknown> {
  const ids = new Set(recipe.inputs.filter((i) => i.type !== "clip").map((i) => i.id));
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
  const frame = Math.round((atMs * MODEL_FPS) / 1000);
  const grid = latentFrameAtOrBefore(frame);
  if (grid === frame || grid < Math.max(runUpFrames, 22)) return atMs;
  return Math.round(grid * (1000 / MODEL_FPS));
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
    const all = await this.core.placed(timelineId);
    const made: NewClip[] = [];
    for (const k of texts.keys()) made.push(await this.newClip(all, all.length + k, { recipe }));
    await this.core.remember(timelineId, texts.length > 1 ? "the clips planned" : "the clip added");
    const ids = await this.core.db.transaction().execute(async (tx) => {
      const order: Array<Pick<Placed, "clip">> = [...all];
      const out: string[] = [];
      for (const [k, text] of texts.entries()) {
        const id = await this.insertClip(timelineId, order, order.length, { ...made[k]!, inputs: { ...made[k]!.inputs, ...text } }, tx);
        order.push({ clip: { id } as ClipRow });
        out.push(id);
      }
      return out;
    });
    await this.core.touch(timelineId);
    return ids;
  }

  /** What a new clip at `index` is: its kind, model, form and how it starts, and the take or picture it comes with. Nothing is written. */
  async newClip(all: Placed[], index: number, opts: { asset?: string; recipe?: string; as?: "still" | "clip" }) {
    const { db, registry } = this.core;
    // a new clip is made the way the last rendered clip before it was
    const lastRecipe = all.slice(0, index).reverse().find((p) => p.clip.recipe_id)?.clip.recipe_id ?? null;
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
    // the cast and places of the clip before come along when it has its own: set once, not again for every clip
    const look = kind === "video" ? (all[index - 1]?.clip.look ?? null) : null;
    return { kind, recipeId, inputs, joined, still, take, asset, look };
  }

  /** The clip, its place among the others and its take, written in the transaction `tx`. */
  async insertClip(timelineId: string, all: Array<Pick<Placed, "clip">>, index: number, made: NewClip, tx: Db): Promise<string> {
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
    await this.core.renumber(timelineId, order, tx);
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
   * far as it is known now, without the work.
   */
  async plan(clipId: string, recipe: Recipe<any>, raw: Record<string, unknown>, fit: boolean, finishedFrom: string | null = null, quick = false): Promise<ClipPlan> {
    const clip = await this.core.clipRow(clipId);
    const t = await this.core.row(clip.timeline_id);
    const all = await this.core.placed(clip.timeline_id);
    const i = all.findIndex((p) => p.clip.id === clipId);
    const plan: ClipPlan = { input: ownInputs(recipe, raw), sources: [], links: {} };
    if (t.width && t.height) plan.canvas = { width: t.width, height: t.height };
    if (clip.joined === "continue" && i > 0) await this.carryOn(plan, all[i - 1]!, recipe, raw, finishedFrom, quick);
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
      const at = landingOnGrid(after.active);
      plan.input[nextSpec.id] = { asset: after.active.asset.id, at };
      plan.links.next = { take: after.active.take.id, at };
    }
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
      if (raw.handover !== false && !sameBefore && !quick) {
        // ffmpeg missing is said, not taken for a clip that moves to its end
        const lively = await this.handoverAt(before).catch((err: Error) => {
          if (err instanceof FfmpegMissing) throw err;
          return null;
        });
        // on the model's frame grid: the frames handed over are whole frames of it, and the clip before stops on one
        if (lively !== null && lively < at - FRAME_SLACK_MS) {
          const frame = Math.round((lively * MODEL_FPS) / 1000);
          // a clip whose latent was kept hands over on its latent's grid (17k + 5 frames, at or before the frozen tail):
          // the join is then made in the latent, cut there, rather than from frames
          const grid = before.asset.latent_frames ? latentFrameAtOrBefore(frame) : frame;
          const usable = grid >= 22 ? grid : frame;
          at = Math.round(usable * (1000 / MODEL_FPS));
        }
      }
      // a clip before trimmed by hand stops wherever its out point was put: picked up on the latent's grid all the same, and
      // that clip then stops there when the take comes back (TimelineTakes, the hand-over before the frozen tail)
      if (!sameBefore) at = handoverOnGrid(at, { durationMs: before.asset.duration_ms ?? 0, latentFrames: before.asset.latent_frames }, Number(raw.context) || 22);
      plan.input[prevSpec.id] = { asset: before.asset.id, at };
      plan.links.prev = { take: before.take.id, at };
    } else if (startSpec && recipe.traits?.continues === "frame" && !quick) {
      // a recipe that opens on a picture picks up from the last frame that plays
      plan.input[startSpec.id] = (await this.media.frame(before.asset, Math.max(0, at - FRAME_SLACK_MS), true)).id;
      plan.sources.push({ asset: before.asset.id, role: "previous" });
      plan.links.prev = { take: before.take.id, at };
    }
  }

  /** The moment the clip before should hand over: before its frozen tail when it has one, else null. */
  private async handoverAt(before: { take: TakeRow; asset: AssetRow }): Promise<number | null> {
    const { rate, values } = await this.media.motion(before.asset.id);
    const { start, end } = plays(before);
    return frozenTailAt(values, rate, start, end);
  }
}
