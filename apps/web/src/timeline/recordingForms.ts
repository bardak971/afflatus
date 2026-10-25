import { joinWay, madeAroundRecording } from "@afflatus/core";
import type { RecipeInfo } from "../api";
import { recipeLabel } from "../format";
import type { Option } from "../Select";
import { recordingInput } from "./track/RecordingBand";

/** How a model would meet the clip before, as the model list says it beside each (the join rule, joinWay). */
export const JOIN_WORDS = { seamless: "seamless", frames: "carries on", cut: "a cut" } as const;

/** What the recording does on a clip in this form (card #72): the mouth follows it (Lip sync), or it plays over the clip. */
export const recordingDoes = (recipe: RecipeInfo) => (madeAroundRecording(recipe.inputs) ? "the mouth follows its part" : "plays over");

/** The forms a clip under a recording takes (card #72): Lip sync first, then those it plays over (Video with audio). */
export function recordingForms(recipes: RecipeInfo[]): RecipeInfo[] {
  const holding = recipes.filter((r) => r.output === "video" && !r.hidden && recordingInput(r));
  return [...holding.filter((r) => madeAroundRecording(r.inputs)), ...holding.filter((r) => !madeAroundRecording(r.inputs))];
}

/** Said under the model list of a clip under a recording: why no other model is listed, and how to use one. */
export const OTHER_MODELS_SAID = "Other models don't go under a recording yet. To use one here, remove the clip from the recording (its part is cut out, asked first).";

/**
 * The forms a clip under a recording takes, as its model list offers them: each says what the recording does on it and
 * how it meets the clip before (`prior`), as the model list does for any clip.
 */
export function recordingFormOptions(recipes: RecipeInfo[], families: Array<{ id: string; name: string }> | undefined, prior: RecipeInfo | undefined, o: { short?: boolean } = {}): Option[] {
  const said = (r: RecipeInfo) => (prior ? `${recordingDoes(r)} · ${JOIN_WORDS[joinWay(prior, r)]}` : recordingDoes(r));
  return recordingForms(recipes).map((r) => ({
    value: r.id,
    // `short`: by its title alone, what it does on the line under it (a recording's list of its clips: the family is the
    // same for all, and the narrow list cut a note beside the title short)
    label: o.short ? r.title : recipeLabel(families?.find((f) => f.id === r.family)?.name, r.title),
    ...(o.short ? { detail: said(r) } : { detail: r.summary, note: said(r) }),
  }));
}
