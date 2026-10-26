import { FRAME_SLACK_MS } from "@afflatus/core";
import type { Clip, RecipeInfo, Timeline } from "../api";
import { recordingInput } from "./track/RecordingBand";

/**
 * Why a clip cannot be split in two, as the server refuses it (timelineRange.refuseRunSplit): a clip of a recording, or a
 * window of the source, would keep its whole part in both halves. Said on Split (at the playhead, at In / Out) and the
 * range actions that split under In or Out; null for a clip that splits.
 */
export function unsplittable(c: Clip, recipes: RecipeInfo[], source: Timeline["source"]): string | null {
  if (c.kind !== "video" || !c.recipe) return null;
  const recipe = recipes.find((r) => r.id === c.recipe);
  const spec = recordingInput(recipe);
  if (spec && typeof c.inputs[spec.id] === "string" && c.inputs[spec.id]) return "a recording's clip: its part does not split; Remove it, or cut the recording again";
  const driving = recipe?.traits?.windows ? recipe.inputs.find((i) => i.type === "clip" && i.role === "source" && i.window) : undefined;
  const asset = driving && (c.inputs[driving.id] as { asset?: unknown } | undefined)?.asset;
  if (source && asset && asset === source.asset) return "a window of the source: its part does not split; Remove it, or set the windows anew in Source settings";
  return null;
}

/** The clip a moment falls inside (not on its cut), that would be split there: In or Out of a range. */
export const clipInside = (clips: Clip[], ms: number) => clips.find((c) => c.lengthMs > 0 && c.atMs + FRAME_SLACK_MS <= ms && ms <= c.atMs + c.lengthMs - FRAME_SLACK_MS);
