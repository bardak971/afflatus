import { RANDOM_SEED } from "@afflatus/core";
import type { AssetDetail, RecipeInfo } from "./api";
import type { ActionId } from "./itemActions";
import { modelGroups } from "./picker";
import type { QueuedJob } from "./queueVariation";
import { carried } from "./viewer/shared";

/**
 * Vary subtle and Vary strong (card #270), Fooocus's two buttons: an img2img of a result on the model it was made with, at a
 * low denoise (its details drawn again, the picture kept) or a high one (its layout and colours kept, the rest drawn anew).
 * No variation seed (A1111's subseed and its strength): ComfyUI's own nodes have none, and the custom packs that add one
 * each patch the sampler their own way; the img2img works on every family that has one.
 */
export type VaryHow = "subtle" | "strong";

/** The actions that vary a result, and how far each goes. */
export const VARY: Partial<Record<ActionId, VaryHow>> = { "vary-subtle": "subtle", "vary-strong": "strong" };

/**
 * The denoise each Vary starts from, by family. SDXL takes Fooocus's own (0.5 and 0.85), tuned on SDXL. The flow models
 * (FLUX.1, Krea 2, Qwen Image, Qwen Image 2.1, Z-Image, FLUX.2 Klein) sample on a shifted schedule, where the same denoise
 * starts from far more real noise (at shift 3, 0.5 starts from σ 0.75 and 0.85 from σ 0.94, nearly a new picture): theirs
 * are lower, 0.3 (σ 0.56) and 0.65 (σ 0.85). A family not named here samples as the flow models do.
 */
const DENOISE: Record<string, Record<VaryHow, number>> = {
  sdxl: { subtle: 0.5, strong: 0.85 },
};
const FLOW: Record<VaryHow, number> = { subtle: 0.3, strong: 0.65 };

export const varyDenoise = (family: string, how: VaryHow): number => (DENOISE[family] ?? FLOW)[how];

/** The recipe a Vary runs: the img2img of the model the picture was made with; none when that model has no img2img. */
export function varyTool(all: RecipeInfo[], families: Array<{ id: string; name: string; summary: string }>, made: string | undefined): RecipeInfo | undefined {
  if (!made) return undefined;
  const mine = modelGroups(all.filter((r) => r.output === "image"), families).find((group) => group.recipes.some((r) => r.id === made));
  return mine?.recipes.find((r) => r.id.endsWith(".redraw"));
}

/**
 * A Vary's job on a picture: what the picture was made with (its prompt, model, LoRAs, sampling) carried into its model's
 * img2img, the picture as the source, the denoise of the family, a new seed for each copy.
 */
export function varyJob(how: VaryHow, label: string, g: AssetDetail["generation"], madeWith: RecipeInfo | undefined, tool: RecipeInfo, picture: string): QueuedJob {
  const source = tool.inputs.find((i) => i.type === "image" && i.role === "source")!;
  const seed = tool.inputs.find((i) => i.type === "seed")?.id;
  return {
    recipe: tool, label, from: picture,
    stored: { ...carried(g, madeWith, tool, false), [source.id]: picture, strength: varyDenoise(tool.family, how), ...(seed ? { [seed]: RANDOM_SEED } : {}) },
  };
}
