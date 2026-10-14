import { sourceWindows, type Recipe, type SourceWindow } from "@afflatus/core";
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

/** The windows a source's stretch is made in, with the scene cuts asked for (read with ffmpeg). */
export async function planWindows(plan: SourcePlan, recipe: Recipe<any>, video: AssetRow, storage: Storage): Promise<SourceWindow[]> {
  const shape = windowsOf(recipe);
  if (!shape) throw httpError(`${recipe.title} does not make a long video window by window.`);
  const cutsMs = plan.snap ? await scenesOf(await sourceOf(storage, video.file_key), extOf(video.mime)) : [];
  return sourceWindows({ fromMs: plan.fromMs, toMs: plan.toMs, windowMs: plan.windowMs, shape, cutsMs });
}
