import { gridAtOrBefore, sourceWindows, type Recipe, type SourceWindow } from "@afflatus/core";
import { z } from "zod";
import { scenesOf } from "./cut";
import { httpError } from "./errors";
import { extOf } from "./media";
import { sourceOf, type Storage } from "./storage";
import type { AssetRow } from "./timelineModel";

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
  return next;
}

/** A recipe that takes a source window by window, with how it takes it. */
export function windowsOf(recipe: Recipe<any> | undefined) {
  const w = recipe?.traits?.windows;
  return recipe && w ? { fps: recipe.traits!.fps, ...w } : null;
}

/**
 * A window's part of its driving video once its join changes (`joined`, what it becomes): one that carries on starts its
 * carried frames early (they are the clip before's last ones, dropped from what it makes, sourceWindows.ts); made a cut it
 * starts later and is shorter, so that it does not play the run-up again over the clip before (nor its sound). Made to carry
 * on again, it comes back as it was. Null for a recipe not made window by window, or a part that would start before the video.
 *
 * What it makes is on the model's grid (4k + 1), which the frames it shows once the carried ones are gone are not: made a
 * cut, it makes the grid's count that follows them (SCAIL-2: 5 carried, 4 frames later and 4 fewer; Wan Animate 2: 1
 * carried, the same part), held to end where the window ends, as the window after carries on from there. The frame more
 * goes at its start, on the cut: ended a frame late, the window after played that frame again. Its length holds that count
 * and half a frame (sourceWindows.ts), not the window's length less the carried frames, which made a frame more or three
 * fewer as ffmpeg rounded the half frame.
 */
export function windowRunUp(recipe: Recipe<any> | undefined, inputs: Record<string, unknown>, joined: "cut" | "continue"): Record<string, unknown> | null {
  const shape = windowsOf(recipe);
  const grid = recipe?.traits?.frameGrid;
  const driving = recipe?.inputs.find((i) => i.type === "clip" && i.role === "source" && i.window);
  if (!shape || !shape.carried || !grid || !driving || driving.type !== "clip" || !driving.window) return null;
  const { start, seconds } = driving.window;
  if (typeof inputs[start] !== "number" || typeof inputs[seconds] !== "number") return null;
  const { fps } = shape;
  // the frames the part holds now, as the job takes them: on the grid
  const now = gridAtOrBefore(Math.floor((inputs[seconds] as number) * fps + 0.01), grid);
  // the grid's steps within the carried frames: what a cut takes off its start, and carrying on again puts back
  const steps = grid.step * Math.floor(shape.carried / grid.step);
  const frames = joined === "cut" ? now - steps : Math.min(now + steps, gridAtOrBefore(shape.most, grid));
  const at = round4((inputs[start] as number) + (now - frames) / fps);
  if (at < 0) return null;
  return { ...inputs, [start]: at, [seconds]: round4((frames + 0.5) / fps) };
}

const round4 = (s: number) => Math.round(s * 10_000) / 10_000;

/** The windows a source's stretch is made in, with the scene cuts asked for (read with ffmpeg). */
export async function planWindows(plan: SourcePlan, recipe: Recipe<any>, video: AssetRow, storage: Storage): Promise<SourceWindow[]> {
  const shape = windowsOf(recipe);
  if (!shape) throw httpError(`${recipe.title} does not make a long video window by window.`);
  const cutsMs = plan.snap ? await scenesOf(await sourceOf(storage, video.file_key), extOf(video.mime)) : [];
  return sourceWindows({ fromMs: plan.fromMs, toMs: plan.toMs, windowMs: plan.windowMs, shape, cutsMs });
}
