import { gridAtOrBefore, sourceWindows, windowShapeOf, type Recipe, type SourceWindow } from "@afflatus/core";
import { z } from "zod";
import { httpError } from "./errors";
import type { AssetRow } from "./timelineModel";
import { removedOf, type RemovedPart } from "./timelineRemoved";

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
  /** Windows end at the source's scene cuts, the next one a new shot. */
  snap: boolean;
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
   * The windows set aside by a shorter stretch (its end trimmed in after Make: Timelines.trimSource), whole: each clip's row
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
    snap: z.boolean().optional(),
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
      windowMs: Number(x.windowMs) || 5000, inputs: { ...older, ...(x.inputs && typeof x.inputs === "object" ? x.inputs : {}) }, snap: Boolean(x.snap), clip: x.clip ?? null,
      ...(x.pick && typeof x.pick.x === "number" && typeof x.pick.y === "number" ? { pick: { x: x.pick.x, y: x.pick.y } } : {}),
      ...(x.apart && typeof x.apart === "object" ? { apart: Object.fromEntries(Object.entries(x.apart).filter(([, v]) => Array.isArray(v) && v.length).map(([k, v]) => [k, v.filter((i): i is string => typeof i === "string")])) } : {}),
      ...(Array.isArray(x.parked) && x.parked.length ? { parked: x.parked.filter((p) => p && typeof p.clip === "object" && Array.isArray(p.takes)) } : {}),
      ...(x.shortened && typeof x.shortened.clip === "string" && Number(x.shortened.seconds) > 0 ? { shortened: { clip: x.shortened.clip, seconds: Number(x.shortened.seconds) } } : {}),
      ...(removedOf(x.removed).length ? { removed: removedOf(x.removed) } : {}),
    };
  } catch {
    return null;
  }
}

/** A source after a patch: a new video starts whole, at `atMs`, with the form of the one before it kept. */
export function patchedSource(before: SourcePlan | null, patch: NonNullable<SourcePatch>, video: Pick<AssetRow, "id" | "duration_ms"> | null, endMs: number): SourcePlan {
  const fresh = Boolean(patch.asset && patch.asset !== before?.asset);
  if (!before && !patch.asset) throw httpError("Drop a video on the Source lane first.");
  const length = video?.duration_ms ?? 0;
  const base: SourcePlan = fresh || !before
    ? { asset: patch.asset!, atMs: endMs, fromMs: 0, toMs: length, recipe: before?.recipe ?? null, windowMs: before?.windowMs ?? 5000, inputs: before?.inputs ?? {}, snap: before?.snap ?? false, clip: null }
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
 * The windows a source's stretch is made in, with the scene cuts asked for: the source's as kept beside it
 * (TimelineMedia.scenes, read with ffmpeg once), not read again on every Make.
 */
export async function planWindows(plan: SourcePlan, recipe: Recipe<any>, video: AssetRow, scenes: (assetId: string) => Promise<{ cuts: number[] }>, after?: number): Promise<SourceWindow[]> {
  const shape = windowsOf(recipe, plan.inputs);
  if (!shape) throw httpError(`${recipe.title} does not make a long video window by window.`);
  const cutsMs = plan.snap ? (await scenes(video.id)).cuts : [];
  // cut again after the clips kept: from where the last of them ends, carrying on from it
  return sourceWindows({ fromMs: after ?? plan.fromMs, toMs: plan.toMs, windowMs: plan.windowMs, shape, cutsMs, ...(after !== undefined ? { continues: true } : {}) });
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
