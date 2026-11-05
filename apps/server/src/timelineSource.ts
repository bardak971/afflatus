import { carriedOf, CUT_WINDOW, CUT_WINDOW_MOST, gridAtOrBefore, ownsOf, sameWindowGrid, sourceWindows, trimIn, trimOut, typedSeed, windowBounds, windowShapeOf, type InputSpec, type Recipe, type SourceMarks, type SourceWindow } from "@afflatus/core";
import { z } from "zod";
import { now, type Db } from "./db";
import { httpError, notFound } from "./errors";
import { plannedLengthOf, type AssetRow, type Placed, type TimelineCore, type TimelineRow } from "./timelineModel";
import type { TimelineMedia } from "./timelineMedia";
import { ownInputIds, settingsOf, type NewClip, type TimelinePlan } from "./timelinePlan";
import { atLengthBefore, parkClips, refuseBusy, unparkClip } from "./timelineRecording";
import { aroundRemoved, foldParts, keptAround, removedOf, removedView, type ParkedClip, type RemovedPart } from "./timelineRemoved";
import type { Run, TimelinePatch } from "./timelines";

/**
 * A timeline's source lane (HANDOVER-timeline-brainstorm.md §3.1–3.2): a long video laid under the clips, `atMs` where its
 * own start sits on the timeline, of which the stretch `fromMs`–`toMs` is made into clips by a model that takes a source
 * window by window (Motion transfer: VideoTraits.windows), each window carrying on from the one before, made with the
 * same form (`inputs`: the model's whole form, its picture, prompt and seed among it; its driving video is the source's).
 * `clip`: the clip of the timeline the stretch was taken from (an imported video split where Motion transfer starts),
 * which the made clips take the place of.
 */
export interface SourcePlan {
  asset: string;
  atMs: number;
  fromMs: number;
  toMs: number;
  recipe: string | null;
  windowMs: number;
  inputs: Record<string, unknown>;
  /**
   * ± of the window, in ms, as a recording's Lip sync clips are cut: a window ends within that much of `windowMs` at the best
   * spot there (a scene cut, the next window a new shot; a pause in the speech; the quietest moment); 0: every window that
   * long (sourceWindows). A source of before (2026-10-29) with its scene cuts on reads as CUT_WINDOW, off as 0.
   */
  withinMs: number;
  clip: string | null;
  /**
   * Who a swap replaces: the point clicked on the stretch's first frame (at `fromMs`), as shares of its width and height.
   * The first window takes it; the windows after it follow the person it replaced. Gone when the stretch's start moves.
   */
  pick?: { x: number; y: number } | null;
  /**
   * The clips set apart from the others, by id: the settings each keeps its own (`apart` in a clip's PATCH). A change made
   * on any other clip of the source reaches every clip but on these settings (the owner, 2026-10-18: one form, the clip's).
   */
  apart?: Record<string, string[]>;
  /**
   * The windows set aside by a shorter stretch (its end trimmed in after Make: TimelineSource.trimSource), whole: each clip's row
   * and its takes' rows, in order, so that the stretch made long again brings them back as they were, takes and all.
   * `told`: a rendered one that never comes back (of another model), passed by a trim out and said so once.
   */
  parked?: Array<{ clip: Record<string, unknown>; takes: Array<Record<string, unknown>>; told?: true }>;
  /**
   * The empty window a shorter stretch shortened to its end, and its length before (seconds): the stretch made long again
   * gives it that length back before the windows set aside return, so that no part of the video is left between them.
   */
  shortened?: { clip: string; seconds: number };
  /** Stretches cut out of the middle by removing their windows, each kept with the window after it (timelineRemoved.ts). */
  removed?: RemovedPart[];
  /**
   * The ms at the end of a window's part that its take hides, by clip id: made anew before a part kept removed, its part runs
   * past where that part starts to the frame grid's next count (one on the grid cannot end there), and its take, landed,
   * stops playing there (its end trimmed by as much: TimelineTakes.add). It meets the part exactly, brought back or not,
   * and the window after it carries on from where it stops (TimelinePlan: from where the take before plays to).
   */
  hidden?: Record<string, number>;
}

/** What a timeline's PATCH takes of it: a new source (its video), or changes to the one there; null takes it away. */
export const sourcePatch = z
  .strictObject({
    asset: z.string().optional(),
    atMs: z.number().min(-86_400_000).max(86_400_000).optional(),
    fromMs: z.number().min(0).optional(),
    toMs: z.number().min(0).optional(),
    recipe: z.string().nullable().optional(),
    windowMs: z.number().min(500).max(60_000).optional(),
    /** The model's form every window is made with (what was touched). */
    inputs: z.record(z.string().max(64), z.unknown()).refine((x) => JSON.stringify(x).length < 64_000, "too large").optional(),
    withinMs: z.number().min(0).max(CUT_WINDOW_MOST * 1000).optional(),
    clip: z.string().nullable().optional(),
    pick: z.strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).nullable().optional(),
  })
  .nullable();
export type SourcePatch = z.infer<typeof sourcePatch>;

/** The source as the row keeps it; null when there is none or it cannot be read. */
export function sourceOfRow(raw: string | null | undefined): SourcePlan | null {
  if (!raw) return null;
  try {
    const x = JSON.parse(raw) as Partial<SourcePlan> & { picture?: string | null; prompt?: string; seed?: number | null };
    if (typeof x.asset !== "string") return null;
    // the first sources (2026-10-14) kept their picture, prompt and seed apart from a form
    const older = { ...(x.picture ? { picture: x.picture } : {}), ...(x.prompt ? { prompt: x.prompt } : {}), ...(typeof x.seed === "number" ? { seed: x.seed } : {}) };
    return {
      asset: x.asset, atMs: Number(x.atMs) || 0, fromMs: Number(x.fromMs) || 0, toMs: Number(x.toMs) || 0, recipe: x.recipe ?? null,
      windowMs: Number(x.windowMs) || 5000, inputs: { ...older, ...(x.inputs && typeof x.inputs === "object" ? x.inputs : {}) }, withinMs: withinOf(x), clip: x.clip ?? null,
      ...(x.pick && typeof x.pick.x === "number" && typeof x.pick.y === "number" ? { pick: { x: x.pick.x, y: x.pick.y } } : {}),
      ...(x.apart && typeof x.apart === "object" ? { apart: Object.fromEntries(Object.entries(x.apart).filter(([, v]) => Array.isArray(v) && v.length).map(([k, v]) => [k, v.filter((i): i is string => typeof i === "string")])) } : {}),
      ...(Array.isArray(x.parked) && x.parked.length ? { parked: x.parked.filter((p) => p && typeof p.clip === "object" && Array.isArray(p.takes)) } : {}),
      ...(x.shortened && typeof x.shortened.clip === "string" && Number(x.shortened.seconds) > 0 ? { shortened: { clip: x.shortened.clip, seconds: Number(x.shortened.seconds) } } : {}),
      ...(removedOf(x.removed).length ? { removed: removedOf(x.removed) } : {}),
      ...(x.hidden && typeof x.hidden === "object" ? { hidden: Object.fromEntries(Object.entries(x.hidden).filter(([, ms]) => typeof ms === "number" && ms > 0)) } : {}),
    };
  } catch {
    return null;
  }
}

/** A source's ± as kept: its own, else from the scene cuts switch it had before (on: the recording's ±; off: none). */
function withinOf(x: { withinMs?: unknown; snap?: unknown }): number {
  const own = Number(x.withinMs);
  if (x.withinMs !== undefined && Number.isFinite(own) && own >= 0) return own;
  return x.snap ? CUT_WINDOW * 1000 : 0;
}

/** A new source's ±: the one a recording is cut with. */
export const SOURCE_WITHIN_MS = CUT_WINDOW * 1000;

/** A source after a patch: a new video starts whole, at `atMs`, with the form of the one before it kept. */
export function patchedSource(before: SourcePlan | null, patch: NonNullable<SourcePatch>, video: Pick<AssetRow, "id" | "duration_ms"> | null, endMs: number): SourcePlan {
  const fresh = Boolean(patch.asset && patch.asset !== before?.asset);
  if (!before && !patch.asset) throw httpError("Drop a video on the Source lane first.");
  const length = video?.duration_ms ?? 0;
  const base: SourcePlan = fresh || !before
    ? { asset: patch.asset!, atMs: endMs, fromMs: 0, toMs: length, recipe: before?.recipe ?? null, windowMs: before?.windowMs ?? 5000, inputs: before?.inputs ?? {}, withinMs: before?.withinMs ?? SOURCE_WITHIN_MS, clip: null }
    : before;
  const next: SourcePlan = {
    ...base,
    ...Object.fromEntries(Object.entries(patch).filter(([k, v]) => v !== undefined && k !== "asset")),
  } as SourcePlan;
  // the stretch within the video, at least a second long
  if (length > 0) {
    next.toMs = Math.max(0, Math.min(length, Math.round(next.toMs || length)));
    next.fromMs = Math.max(0, Math.min(next.toMs - 1000, Math.round(next.fromMs)));
  }
  next.atMs = Math.round(next.atMs);
  // a click is on the frame it was made on: another video, or another first frame, is someone else's to pick
  if (!next.pick || (!("pick" in patch) && (fresh || next.fromMs !== before?.fromMs))) delete next.pick;
  return next;
}

/**
 * The clips a source made: those whose model takes a driving video window by window and whose driving video is the
 * source's. Removing the source takes them with it (one step for Undo), rendered or not: a window's take only means
 * something as a part of that source. The clip a stretch was taken from (an imported video) is not one of them.
 */
export function clipsOfSource(plan: Pick<SourcePlan, "asset">, clips: Array<{ id: string; recipe_id: string | null; inputs: string }>, recipeOf: (id: string) => Recipe<any> | undefined): string[] {
  return clips.flatMap((c) => {
    const recipe = c.recipe_id ? recipeOf(c.recipe_id) : undefined;
    const driving = recipe?.traits?.windows ? recipe.inputs.find((i) => i.type === "clip" && i.role === "source" && i.window) : undefined;
    if (!driving) return [];
    try {
      const value = (JSON.parse(c.inputs) as Record<string, unknown>)[driving.id] as { asset?: unknown } | undefined;
      return value?.asset === plan.asset ? [c.id] : [];
    } catch {
      return [];
    }
  });
}

/** A recipe that takes a source window by window, with how it takes it with this form (its run-up as set: windowShapeOf). */
export function windowsOf(recipe: Recipe<any> | undefined, inputs?: Record<string, unknown>) {
  return windowShapeOf(recipe, inputs);
}

/**
 * A window's part of its driving video once its join changes (`joined`, what it becomes): one that carries on starts its
 * carried frames early (they are the clip before's last ones, dropped from what it makes, sourceWindows.ts); made a cut it
 * starts later and is shorter, so that it does not play the run-up again over the clip before (nor its sound). Made to carry
 * on again, it comes back as it was. Null for a recipe not made window by window, or a part that would start before the video.
 *
 * What it makes is on the model's grid (4k + 1), which the frames it shows once the carried ones are gone are not: made a
 * cut, it makes the grid's count that follows them (SCAIL-2: 5 carried, 4 frames later and 4 fewer; with 1
 * carried, the same part), held to end where the window ends, as the window after carries on from there. The frame more
 * goes at its start, on the cut: ended a frame late, the window after played that frame again. Its length holds that count
 * and half a frame (sourceWindows.ts), not the window's length less the carried frames, which made a frame more or three
 * fewer as ffmpeg rounded the half frame. On a grid coarser than the carried frames (H3's 17k + 5, 5 carried) no whole
 * step fits within them, and the part stayed as it was, playing the 5 frames again over the clip before: it takes one step
 * off its start instead, starting that step past the carried frames, still ending where the window ends.
 */
export function windowRunUp(recipe: Recipe<any> | undefined, inputs: Record<string, unknown>, joined: "cut" | "continue"): Record<string, unknown> | null {
  const shape = windowsOf(recipe, inputs);
  const grid = recipe?.traits?.frameGrid;
  const driving = recipe?.inputs.find((i) => i.type === "clip" && i.role === "source" && i.window);
  if (!shape || !shape.carried || !grid || !driving || driving.type !== "clip" || !driving.window) return null;
  const { start, seconds } = driving.window;
  if (typeof inputs[start] !== "number" || typeof inputs[seconds] !== "number") return null;
  const { fps } = shape;
  // the frames the part holds now, as the job takes them: on the grid
  const now = gridAtOrBefore(Math.floor((inputs[seconds] as number) * fps + 0.01), grid);
  // the fewest grid steps after which at most one carried frame plays again: what a cut takes off its start, and carrying
  // on again puts back (SCAIL-2's 5 on a 4-frame grid: 4, one frame again; H3's 22 on its 17: 34, none, where 17 played 5 twice)
  const steps = grid.step * Math.max(1, Math.ceil((shape.carried - 1) / grid.step));
  const frames = joined === "cut" ? now - steps : Math.min(now + steps, gridAtOrBefore(shape.most, grid));
  const at = round4((inputs[start] as number) + (now - frames) / fps);
  if (at < 0 || frames < shape.least) return null;
  return { ...inputs, [start]: at, [seconds]: round4((frames + 0.5) / fps) };
}

const round4 = (s: number) => Math.round(s * 10_000) / 10_000;

/**
 * The windows a source's stretch is made in, about its window ± its `withinMs`, at the spots its `marks` say (its scene
 * cuts, pauses and loudness, kept beside it once read: TimelineSource.sourceMarksOf), not read again on every Make. `after`:
 * cut again after the clips kept, from where the last of them ends, carrying on from it unless it ended on a cut (`opens`).
 */
export async function planWindows(plan: SourcePlan, recipe: Recipe<any>, video: AssetRow, marks: (assetId: string) => Promise<SourceMarks>, after?: number, opens = false): Promise<SourceWindow[]> {
  const shape = windowsOf(recipe, plan.inputs);
  if (!shape) throw httpError(`${recipe.title} does not make a long video window by window.`);
  const read = plan.withinMs > 0 ? await marks(video.id) : {};
  return sourceWindows({ fromMs: after ?? plan.fromMs, toMs: plan.toMs, windowMs: plan.windowMs, withinMs: plan.withinMs, shape, ...read, ...(after !== undefined && !opens ? { continues: true } : {}) });
}

/**
 * The windows of a stretch that must reach `edgeMs`, the start of a part kept removed (its windows fixed, card #114):
 * windows on the grid seldom end exactly there, and the ones asked for (planWindows) end short of it, by up to a step of
 * the grid (17 frames on H3) or a window's fewest frames (the rest too short for one). Tried with the stretch asked to end
 * a frame further each time, within the part (`limitMs`), and with windows asked a frame longer or shorter than asked
 * (within what one job takes, the nearest first), the plan whose last window runs least past the edge: that much is hidden on its take
 * (SourcePlan.hidden), rendered for nothing. Null when none reaches it.
 */
export async function windowsReaching(plan: SourcePlan, recipe: Recipe<any>, video: AssetRow, marks: (assetId: string) => Promise<SourceMarks>, o: { fromMs: number; edgeMs: number; limitMs: number; after?: number; opens?: boolean }): Promise<SourceWindow[] | null> {
  const shape = windowsOf(recipe, plan.inputs);
  if (!shape) return null;
  const read = plan.withinMs > 0 ? await marks(video.id) : {};
  const frameMs = 1000 / shape.fps;
  const { leastMs, mostMs } = windowBounds(shape);
  // every length a window may be asked for, a frame apart, the one asked first, then the nearest to it
  const lengths = [plan.windowMs, ...Array.from({ length: Math.floor((mostMs - leastMs) / frameMs) + 1 }, (_, k) => leastMs + k * frameMs)]
    .sort((a, b) => Math.abs(a - plan.windowMs) - Math.abs(b - plan.windowMs));
  let best: { windows: SourceWindow[]; over: number } | null = null;
  for (const windowMs of lengths) {
    for (let more = 0; o.edgeMs + more * frameMs < o.limitMs; more++) {
      const windows = sourceWindows({ fromMs: o.after ?? o.fromMs, toMs: o.edgeMs + more * frameMs, windowMs, withinMs: plan.withinMs, shape, ...read, ...(o.after !== undefined && !o.opens ? { continues: true } : {}) });
      const over = (windows.at(-1)?.toMs ?? -Infinity) - o.edgeMs;
      if (over < -frameMs / 2) continue;
      if (!best || over < best.over - 1) best = { windows, over };
      break;
    }
    if (best && best.over <= frameMs / 2) break;
  }
  return best?.windows ?? null;
}

/**
 * A window clip's form taken from one windowed form to another of the same grid: its part of the source moved to the new
 * form's own inputs (Motion transfer's driving video and its part, the swap's source video), the rest kept as it is (the
 * inputs both forms share keep their values; what only the old one had stays stored, unread, and comes back with it).
 * `alone`: this window takes the form by itself, the others keeping theirs (the new form's windowFrom).
 */
export function windowFormFor(from: Recipe<any>, to: Recipe<any>, inputs: Record<string, unknown>, alone = false): Record<string, unknown> {
  const window = (r: Recipe<any>) => {
    const d = r.inputs.find((i) => i.type === "clip" && i.role === "source" && i.window);
    return d?.type === "clip" && d.window ? { driving: d.id, start: d.window.start, seconds: d.window.seconds } : null;
  };
  const [a, b] = [window(from), window(to)];
  if (!a || !b) return inputs;
  const { [a.driving]: driving, [a.start]: start, [a.seconds]: seconds, ...rest } = inputs;
  const moved = { ...rest, [b.driving]: driving, [b.start]: start, [b.seconds]: seconds };
  return to.windowFrom ? to.windowFrom(from, moved, alone) : moved;
}

/** What the source's windows ask of the model besides its core (Timelines): the clips in the queue, the runs, an edit of the timeline. */
export interface SourceTimelines {
  busyOf(ids: string[], db?: Db): Promise<Set<string>>;
  runsOf(t: TimelineRow, all: Placed[]): Run[];
  edit(id: string, patch: TimelinePatch): Promise<unknown>;
}

/**
 * The source lane's windows made into clips and kept in step with it: made from the source, trimmed, split, given another
 * model, and what the source is cut at (its scene cuts, pauses and loudness).
 */
export class TimelineSource {
  constructor(private readonly core: TimelineCore, private readonly planner: TimelinePlan, private readonly media: TimelineMedia, private readonly timelines: SourceTimelines) {}

  /**
   * What cutting the source again keeps and drops: its clips at the start that are rendered or in the queue kept, the rest
   * dropped; where the new clips go (in place of the first dropped), where in the source they start (where the last kept
   * one's window ends; none kept, at the stretch's start) and the form they share (the source's first clip's).
   */
  /** What `append` adds after: every clip the source made kept, the new windows from where the last one ends, after it. */
  private afterAll(all: Placed[], plan: SourcePlan, driving: Extract<InputSpec, { type: "clip" }>) {
    const ofSource = this.core.sourceClips(plan, all.map((p) => p.clip));
    const mine = all.filter((p) => ofSource.includes(p.clip.id));
    const last = mine.at(-1);
    if (!last) throw httpError("The source has no clips to add after: make them first.");
    const fps = this.core.registry.recipe(last.clip.recipe_id ?? "")?.traits?.fps ?? 24;
    const w = driving.window!;
    const inputs = JSON.parse(last.clip.inputs) as Record<string, unknown>;
    // a part holds its frames and half a frame more (sourceWindows): it ends its whole frames after its start, less what its
    // take hides (one ended on a scene cut: the next window opens the new shot there)
    const hides = plan.hidden?.[last.clip.id] ?? 0;
    const after = Math.round((Number(inputs[w.start]) + Math.floor(Number(inputs[w.seconds]) * fps + 1e-6) / fps) * 1000) - hides;
    return { kept: mine.length, drop: [] as string[], after, opens: hides > 0, index: all.findIndex((p) => p.clip.id === last.clip.id) + 1, form: JSON.parse(mine[0]!.clip.inputs) as Record<string, unknown> };
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
    // the source's marks read before the timeline is held, as makeFromSource does (a moved start makes it anew in the turn)
    const asked = sourceOfRow((await this.core.row(timelineId)).source);
    if (asked && asked.withinMs > 0) await this.sourceMarksOf(asked.asset).catch(() => {});
    const out = await this.core.oneAtATime(timelineId, async () => {
      const t = await this.core.row(timelineId);
      const plan = sourceOfRow(t.source);
      if (!plan?.recipe) throw httpError("Drop a video on the Source lane first.");
      const recipe = this.core.registry.recipe(plan.recipe);
      const driving = recipe?.inputs.find((i) => i.type === "clip" && i.role === "source" && i.window);
      if (!recipe?.traits?.windows || !driving || driving.type !== "clip" || !driving.window) throw httpError(`${recipe?.title ?? plan.recipe} takes no driving video.`);
      const video = await this.core.assetRow(plan.asset);
      const length = video?.duration_ms ?? plan.toMs;
      const fromMs = Math.max(0, Math.min(length - 1000, Math.round(to.fromMs)));
      let toMs = Math.max(fromMs + 1000, Math.min(length, Math.round(to.toMs)));
      if (fromMs !== plan.fromMs) return { clips: await this.makeFromSource(timelineId, { anew: true, stretch: { fromMs, toMs } }), toMs };
      if (toMs === plan.toMs) return { clips: [], toMs };
      const w = driving.window;
      const fps = recipe.traits.fps;
      const all = await this.core.placed(timelineId);
      const ofSource = this.core.sourceClips(plan, all.map((p) => p.clip));
      const mine = all.filter((p) => ofSource.includes(p.clip.id));
      // a window that carries on starts its part early by the frames it carries (its run-up): its own frames begin there; one
      // ended on a scene cut stops there, its take hiding what its part runs past it (SourcePlan.hidden)
      const part = (clip: { id?: unknown; inputs?: unknown; joined?: unknown }, first: boolean) => {
        const inputs = JSON.parse(String(clip.inputs)) as Record<string, unknown>;
        const from = Number(inputs[w.start]) * 1000;
        const own = clip.joined === "continue" && !first ? from + (carriedOf(recipe, inputs) * 1000) / fps : from;
        const hides = plan.hidden?.[String(clip.id)] ?? 0;
        return { from, start: own, end: from + Number(inputs[w.seconds]) * 1000 - hides, inputs };
      };
      let parked = [...(plan.parked ?? [])];
      let shortened = plan.shortened;
      const order = all.map((p) => p.clip.id);
      if (toMs < plan.toMs) {
        const busy = await this.timelines.busyOf(mine.map((p) => p.clip.id));
        const cut = trimIn(mine.map((p, k) => ({ id: p.clip.id, ...part(p.clip, k === 0), whole: Boolean(p.clip.take_id) || busy.has(p.clip.id), busy: busy.has(p.clip.id) })), toMs, (recipe.traits.windows.least / fps) * 1000);
        refuseBusy(cut.away, busy, all, "trim the source's end before it");
        toMs = cut.toMs;
        // the end back where it was (snapped onto a rendered window), nothing set aside nor shortened: no step to undo
        if (toMs === plan.toMs && !cut.away.length && !cut.shortened.length) return { clips: [], toMs };
        await this.core.db.transaction().execute(async (tx) => {
          await this.core.remember(timelineId, "the source made shorter", undefined, tx);
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
          await this.core.renumber(timelineId, order.filter((id) => !cut.away.includes(id)), tx);
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
      const busy = last ? await this.timelines.busyOf([last.clip.id]) : new Set<string>();
      const ofGrid = (id: unknown) => {
        const r = typeof id === "string" ? this.core.registry.recipe(id) : undefined;
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
      const left = await this.core.db.transaction().execute(async (tx) => {
        await this.core.remember(timelineId, "the source made longer", undefined, tx);
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
        await this.core.renumber(timelineId, order, tx);
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
    await this.core.touch(timelineId);
    return out;
  }

  /** What `anew` drops: every clip the source made, from the first one's place; none of them in the queue. */
  private async allAnew(all: Placed[], plan: SourcePlan) {
    const ofSource = this.core.sourceClips(plan, all.map((p) => p.clip));
    if (!ofSource.length) throw httpError("The source has no clips to make anew: make them first.");
    if ((await this.timelines.busyOf(ofSource)).size) throw httpError("A clip of the source is rendering or in the queue: let it end, or stop it, to change the source's model.", 409);
    return { kept: 0, drop: ofSource, after: undefined, opens: false, index: all.findIndex((p) => p.clip.id === ofSource[0]), form: undefined };
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
    const next = this.core.registry.recipe(recipeId);
    if (!next?.traits?.windows) throw httpError(`${next?.title ?? recipeId} does not make a long video window by window.`);
    const out = await this.core.oneAtATime(timelineId, async () => {
      const t = await this.core.row(timelineId);
      const plan = sourceOfRow(t.source);
      if (!plan) throw httpError("Drop a video on the Source lane first.");
      const old = plan.recipe ? this.core.registry.recipe(plan.recipe) : undefined;
      const all = await this.core.placed(timelineId);
      const ofSource = this.core.sourceClips(plan, all.map((p) => p.clip));
      if (!ofSource.length || !old || !sameWindowGrid(old, next)) {
        if (!ofSource.length) {
          await this.timelines.edit(timelineId, { source: { recipe: next.id } });
          return { switched: false, clips: [] };
        }
        return { switched: false, clips: await this.makeFromSource(timelineId, { anew: true, recipe: next.id }) };
      }
      const busy = await this.timelines.busyOf(ofSource);
      const mine = all.filter((p) => ofSource.includes(p.clip.id) && !busy.has(p.clip.id));
      // a window's form in the new model's words, from the form it has: each window may have its own (card #42)
      const formOf = (row: { recipe_id?: unknown; inputs?: unknown }) => windowFormFor((typeof row.recipe_id === "string" ? this.core.registry.recipe(row.recipe_id) : undefined) ?? old, next, JSON.parse(String(row.inputs)) as Record<string, unknown>);
      const formed = (row: ParkedClip) => ({ ...row, clip: { ...row.clip, recipe_id: next.id, inputs: JSON.stringify(formOf(row.clip)) } });
      const parked = (plan.parked ?? []).map(formed);
      // the parts removed from the middle too, and the form the clip after each gets back with it
      const removed = (plan.removed ?? []).map((p) => ({ ...p, rows: p.rows.map(formed), ...(p.inputs !== undefined ? { inputs: JSON.stringify(formOf({ inputs: p.inputs })) } : {}) }));
      await this.core.db.transaction().execute(async (tx) => {
        await this.core.remember(timelineId, `the source made with ${next.title}`, undefined, tx);
        for (const p of mine) {
          const inputs = formOf(p.clip);
          await tx.updateTable("clips").set({ recipe_id: next.id, inputs: JSON.stringify(inputs), updated_at: now() }).where("id", "=", p.clip.id).execute();
        }
        await tx.updateTable("timelines").set({ source: JSON.stringify({ ...plan, recipe: next.id, ...(parked.length ? { parked } : {}), ...(removed.length ? { removed } : {}) }), updated_at: now() }).where("id", "=", timelineId).execute();
      });
      return { switched: true, clips: [] };
    });
    await this.core.touch(timelineId);
    return out;
  }

  /**
   * One window of the source given another form of its grid (card #42: Swap character where a shot opens or the motion
   * drifts, Motion transfer where it carries on), from its Model list with Apply to: This clip. In place: its part, its own
   * settings and its takes kept (each take keeps the form it was made with), its next take made with the new form; the
   * other windows and the source's own form as they are. One step to undo.
   */
  async windowForm(timelineId: string, clipId: string, recipeId: string): Promise<void> {
    const next = this.core.registry.recipe(recipeId);
    const t = await this.core.row(timelineId);
    const plan = sourceOfRow(t.source);
    const source = plan?.recipe ? this.core.registry.recipe(plan.recipe) : undefined;
    if (!plan || !source) throw httpError("Drop a video on the Source lane first.");
    if (!next?.traits?.windows || !sameWindowGrid(source, next)) throw httpError(`${next?.title ?? recipeId} does not cut the source as its other windows do: give it to all of them.`);
    await this.core.oneAtATime(timelineId, async () => {
      const all = await this.core.placed(timelineId);
      const p = all.find((x) => x.clip.id === clipId);
      if (!p || !this.core.sourceClips(plan, [p.clip]).length) throw httpError("That clip is not a window of the source.");
      if (p.clip.recipe_id === next.id) return;
      if ((await this.timelines.busyOf([clipId])).size) throw httpError("The clip is rendering or in the queue: let it end, or stop it, to change its model.", 409);
      const was = (p.clip.recipe_id ? this.core.registry.recipe(p.clip.recipe_id) : undefined) ?? source;
      const inputs = windowFormFor(was, next, JSON.parse(p.clip.inputs) as Record<string, unknown>, true);
      // the step kept with the change, as one
      await this.core.db.transaction().execute(async (tx) => {
        await this.core.remember(timelineId, `clip ${all.indexOf(p) + 1} made with ${next.title}`, undefined, tx);
        await tx.updateTable("clips").set({ recipe_id: next.id, inputs: JSON.stringify(inputs), updated_at: now() }).where("id", "=", clipId).execute();
      });
    });
    await this.core.touch(timelineId);
  }

  private async cutAgain(all: Placed[], plan: SourcePlan, driving: Extract<InputSpec, { type: "clip" }>) {
    const ofSource = this.core.sourceClips(plan, all.map((p) => p.clip));
    const mine = all.filter((p) => ofSource.includes(p.clip.id));
    if (!mine.length) throw httpError("The source has no clips to cut again: make them first.");
    const busy = new Set((await this.core.db.selectFrom("jobs").select("clip_id").where("clip_id", "in", mine.map((p) => p.clip.id)).where("status", "in", ["queued", "running"]).execute()).map((j) => j.clip_id));
    const kept: Placed[] = [];
    const drop: string[] = [];
    for (const p of mine) {
      if (p.clip.take_id || busy.has(p.clip.id)) {
        if (drop.length) throw httpError(`Clip ${all.indexOf(p) + 1} is rendered after clips of the source that are not: remove it, or its take, to cut the source again.`);
        kept.push(p);
      } else drop.push(p.clip.id);
    }
    // an empty clip the source is cut again for (given the source's model after its clips: the owner removed clip 3, added a
    // clip and picked the source's swap, 2026-10-20): the next window goes in its place, from where the kept ones end
    const empty = plan.clip ? all.find((p) => p.clip.id === plan.clip && !ofSource.includes(p.clip.id) && !p.clip.take_id && !p.active) : undefined;
    if (empty) drop.push(empty.clip.id);
    if (!drop.length) throw httpError("Every clip of the source is rendered or in the queue: nothing is left to cut again.");
    const last = kept.at(-1);
    const fps = this.core.registry.recipe(mine[0]!.clip.recipe_id ?? "")?.traits?.fps ?? 24;
    const w = driving.window!;
    const lastInputs = last ? (JSON.parse(last.clip.inputs) as Record<string, unknown>) : null;
    // a part holds its frames and half a frame more (sourceWindows): it ends its whole frames after its start, less what its
    // take hides (one ended on a scene cut: the next window opens the new shot there)
    const hides = last ? (plan.hidden?.[last.clip.id] ?? 0) : 0;
    const after = lastInputs ? Math.round((Number(lastInputs[w.start]) + Math.floor(Number(lastInputs[w.seconds]) * fps + 1e-6) / fps) * 1000) - hides : undefined;
    const opens = hides > 0;
    // each window dropped, where its part lies (`from`, its own frames from `start`, past its run-up), its form and what it
    // keeps its own, as typed on it (what the source's form has is no window's own): the window made in its place takes it
    // (ownsOf). One given a form of its own (card #42: a swap where the motion drifts) keeps what its form before kept its
    // own too: read from its form's list only, the Motion transfer description typed before it was a swap went
    const source = plan.recipe ? this.core.registry.recipe(plan.recipe) : undefined;
    // the other forms of the source's grid: a prompt typed on a window under one of them (a Motion transfer's description
    // on a window of a swap) stays its own whatever form it has now
    const mates = source ? this.core.registry.recipes().filter((x) => x.id !== source.id && sameWindowGrid(source, x)) : [];
    const owns = mine.filter((p) => drop.includes(p.clip.id)).map((p) => {
      const inputs = JSON.parse(p.clip.inputs) as Record<string, unknown>;
      const r = p.clip.recipe_id ? this.core.registry.recipe(p.clip.recipe_id) : undefined;
      const opens = p.clip.joined !== "continue";
      const keys = new Set((source ? [r, source, ...mates] : [r]).flatMap((x) => x?.traits?.windows?.own ?? []));
      const from = Number(inputs[w.start]) * 1000;
      const start = !opens && p !== mine[0] && r ? from + (carriedOf(r, inputs) * 1000) / fps : from;
      return { from, start, to: from + Number(inputs[w.seconds]) * 1000, recipe: r, own: Object.fromEntries([...keys].filter((k) => k in inputs && inputs[k] !== plan.inputs[k]).map((k) => [k, inputs[k]])) };
    });
    return { kept: kept.length, drop, after, opens, index: all.findIndex((p) => p.clip.id === drop[0]), form: JSON.parse(mine[0]!.clip.inputs) as Record<string, unknown>, owns };
  }

  /**
   * The source split at a moment of it (`atMs`, in its own time): what comes before it, from where its stretch starts, becomes
   * a clip of the timeline playing the source as it is (where the made clips will go, before them), and the stretch made into
   * clips starts at that moment. The source keeps its place under the clips. One step for Undo.
   */
  async splitSource(timelineId: string, atMs: number): Promise<string> {
    const id = await this.core.oneAtATime(timelineId, async () => {
      const t = await this.core.row(timelineId);
      const plan = sourceOfRow(t.source);
      if (!plan) throw httpError("Drop a video on the Source lane first.");
      const video = await this.core.assetRow(plan.asset);
      if (!video) throw notFound("the source video");
      const length = video.duration_ms ?? plan.toMs;
      const cut = Math.round(atMs);
      if (cut < plan.fromMs + 200 || cut > plan.toMs - 1000) throw httpError("Put the playhead inside the stretch, at least a second before its end.");
      const all = await this.core.placed(timelineId);
      const replaced = plan.clip ? all.findIndex((p) => p.clip.id === plan.clip) : -1;
      const index = replaced >= 0 ? replaced : all.length;
      const made = await this.planner.newClip(all, index, { asset: plan.asset });
      await this.core.remember(timelineId, "the source split");
      return this.core.db.transaction().execute(async (tx) => {
        const clip = await this.planner.insertClip(timelineId, all, index, made, tx);
        await tx.updateTable("takes").set({ trim_start_ms: plan.fromMs, trim_end_ms: Math.max(0, length - cut) }).where("clip_id", "=", clip).execute();
        await tx.updateTable("timelines").set({ source: JSON.stringify({ ...plan, fromMs: cut }), updated_at: now() }).where("id", "=", timelineId).execute();
        return clip;
      });
    });
    await this.core.touch(timelineId);
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
    // the source's marks read before the timeline is held (the first time, ffmpeg reads every frame of it): inside, they are read back
    const asked = sourceOfRow((await this.core.row(timelineId)).source);
    if (asked && asked.withinMs > 0) await this.sourceMarksOf(asked.asset).catch(() => {});
    const ids = await this.core.oneAtATime(timelineId, async () => {
      const t = await this.core.row(timelineId);
      const read = sourceOfRow(t.source);
      if (!read) throw httpError("Drop a video on the Source lane first.");
      // `stretch`: the source's start moved after Make (trimSource): every window made anew over the new stretch, nothing set
      // aside but the parts removed from it (below)
      const plan: SourcePlan = opts.stretch ? { ...read, fromMs: opts.stretch.fromMs, toMs: opts.stretch.toMs, parked: [], shortened: undefined } : read;
      // `recipe`: the model it is made anew with, written with the clips (one step for Undo)
      const recipeId = opts.recipe ?? plan.recipe;
      const recipe = recipeId ? this.core.registry.recipe(recipeId) : undefined;
      if (!recipe) throw httpError("Choose the model the clips are made with.");
      if (!recipe.traits?.windows) throw httpError(`${recipe.title} does not make a long video window by window.`);
      const video = await this.core.assetRow(plan.asset);
      if (!video) throw notFound("the source video");
      const driving = recipe.inputs.find((i) => i.type === "clip" && i.role === "source" && i.window);
      if (!driving || driving.type !== "clip" || !driving.window) throw httpError(`${recipe.title} takes no driving video.`);
      const all = await this.core.placed(timelineId);
      // cut again: the source's clips rendered (or in the queue) at its start kept, the rest made anew after them
      const again = opts.anew ? await this.allAnew(all, plan) : opts.append ? this.afterAll(all, plan, driving) : opts.again ? await this.cutAgain(all, plan, driving) : null;
      // made anew or cut again: around the parts removed from the middle of the windows dropped, which stay removed with
      // their takes, each kept with the first window after it, a cut (card #114); those kept with a window kept stay as they
      // are. One past the end (kept with a window a trim set aside) or before the new start goes: the editor asks first
      const anew = Boolean(opts.anew || opts.again);
      const dropped = new Set(again?.drop ?? []);
      const removed = anew ? (plan.removed ?? []) : [];
      const stays = removed.filter((p) => !dropped.has(p.before) && all.some((x) => x.clip.id === p.before));
      const run = removed.length ? this.timelines.runsOf(t, all).find((r) => r.kind === "source") : undefined;
      const runFps = (read.recipe ? this.core.registry.recipe(read.recipe)?.traits?.fps : undefined) ?? recipe.traits.fps;
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
        const r = typeof row.clip.recipe_id === "string" ? this.core.registry.recipe(row.clip.recipe_id) : undefined;
        return Boolean(r && (r.id === recipe.id || sameWindowGrid(recipe, r)));
      };
      const segments = pieces.flatMap((piece, k) => [
        ...piece.after.filter((part) => !part.rows.every(ofGrid)).map((part) => ({ aside: part, k, fromMs: spans.get(part)!.fromMs, toMs: spans.get(part)!.toMs })),
        { aside: null, k, fromMs: piece.fromMs, toMs: piece.toMs },
      ]);
      const marks = (id: string) => this.sourceMarksOf(id);
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
        // after kept clips whose last ended on a scene cut, the first window opens the new shot there
        const opensAfter = carries !== undefined && carries === again?.after && Boolean(again?.opens);
        let made = await planWindows({ ...plan, fromMs, toMs: segment.toMs }, recipe, video, marks, carries, opensAfter);
        const next = segments[g + 1];
        const keptNext = !segment.aside && next && !next.aside ? pieces[next.k]!.after[0] : undefined;
        const span = keptNext ? spans.get(keptNext) : undefined;
        if (shape && span && made.length && made.at(-1)!.toMs < span.fromMs - 500 / shape.fps) {
          made = (await windowsReaching(plan, recipe, video, marks, { fromMs, edgeMs: span.fromMs, limitMs: span.toMs, after: carries, opens: opensAfter })) ?? made;
          const over = made.at(-1)!.toMs - span.fromMs;
          if (over > 500 / shape.fps) hiddenAt.set(cutUp.flat().length + made.length - 1, Math.round(over));
        }
        // a window ended on a scene cut hides what its part runs past it, so that it stops on the cut
        for (const [k, w] of made.entries()) if (w.hideMs && !hiddenAt.has(cutUp.flat().length + k)) hiddenAt.set(cutUp.flat().length + k, w.hideMs);
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
      const startsAt = all.slice(0, index).reduce((sum, p) => sum + plannedLengthOf(p, p.clip.recipe_id ? this.core.registry.recipe(p.clip.recipe_id) : undefined, plan.hidden?.[p.clip.id]), 0);
      // a seed only when one was typed on the source form: else each render draws its own, as for a new clip (the shared
      // Picture keeps the person the same from window to window, not a seed). One drawn here would be a typed seed to the
      // seed mode, every New take sent with it again
      const seed = typedSeed(plan.inputs.seed);
      // the form every window is made with: the settings of the last clip of that model, then the source's own form; the
      // clips a timeline fills in itself and the driving video's part are each window's
      // the form a window that carries on is made with (Swap character's: Motion transfer), when it cuts the source alike;
      // its own settings kept on the source's form too (a Picture aside: a window after a swap has none of its own)
      const carry = recipe.traits.windows.carryOn ? this.core.registry.recipe(recipe.traits.windows.carryOn) : undefined;
      const carryOn = carry && sameWindowGrid(recipe, carry) ? carry : undefined;
      const own = new Set([...ownInputIds(recipe), ...(carryOn ? [...ownInputIds(carryOn)].filter((id) => carryOn.inputs.find((i) => i.id === id)?.type !== "image") : [])]);
      const form = Object.fromEntries(Object.entries(again?.form ?? { ...settingsOf(recipe, all, index), ...plan.inputs }).filter(([k]) => own.has(k) && k !== driving.id && k !== driving.window!.start && k !== driving.window!.seconds && !(again && k === "seed")));
      const pictureSpec = recipe.inputs.find((i) => i.type === "image" && i.role === "source");
      const picture = pictureSpec && typeof form[pictureSpec.id] === "string" ? (form[pictureSpec.id] as string) : null;
      if (!opts.remembered) await this.core.remember(timelineId, opts.stretch ? "the source's start moved" : opts.anew ? `the source made anew with ${recipe.title}` : opts.append ? "the source made longer" : again ? "the source cut again" : `the ${windows.length} clips made from the source`);
      return this.core.db.transaction().execute(async (tx) => {
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
        await this.core.renumber(timelineId, order.map((p) => p.clip.id).filter((id) => !aside.includes(id)), tx);
        // the source's start sits where its stretch now plays from; the clip it was taken from is gone. Cut again, it stays where
        // it was, and the clips it no longer has keep nothing apart
        const apart = plan.apart ? Object.fromEntries(Object.entries(plan.apart).filter(([id]) => !again?.drop.includes(id))) : undefined;
        const placedPlan = { ...(again ? { ...plan, clip: null, ...(apart ? { apart } : {}) } : { ...plan, atMs: startsAt - plan.fromMs, clip: null }), recipe: recipe.id, hidden: Object.keys(hidden).length ? hidden : undefined, ...(anew ? { parked: [], shortened: undefined, removed: parts.length ? parts : undefined } : {}) };
        await tx.updateTable("timelines").set({ source: JSON.stringify(placedPlan), updated_at: now() }).where("id", "=", timelineId).execute();
        if (picture) await this.core.keep(picture, tx);
        return made.filter((id) => !aside.includes(id));
      });
    });
    await this.core.touch(timelineId);
    return ids;
  }

  /**
   * What a source is cut at besides its length (sourceWindows): its scene cuts, the pauses in its speech and its loudness
   * (the voice band's, else the whole sound's), each kept beside it once read. A video without sound has none of the last two;
   * one whose cuts could not be read is cut at the others (not kept: read again next time), not refused.
   */
  private async sourceMarksOf(assetId: string): Promise<SourceMarks> {
    const video = await this.core.assetRow(assetId);
    if (!video) throw notFound("the source video");
    const [{ cuts }, pauses, levels] = await Promise.all([
      this.media.scenes(assetId).catch(() => ({ cuts: [] as number[] })),
      this.media.pauses(assetId).then((p) => p.pauses, () => []),
      this.media.motion(assetId, video).then((m) => {
        const db = m.speech ?? m.sound;
        return db?.length ? { rate: m.rate, db } : null;
      }, () => null),
    ]);
    return { cutsMs: cuts, pauses, levels };
  }
}
