import { RANDOM_SEED, REMOVE_BACKGROUND, squash, typedSeed, type ChoiceInput } from "@afflatus/core";
import type { AssetDetail, RecipeInfo } from "../api";
import { carryAcross, carryOver, modelGroups } from "../picker";

export const FORMATS: Record<string, string> = { "image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WebP", "video/mp4": "MP4", "video/webm": "WebM", "audio/wav": "WAV", "audio/mpeg": "MP3", "audio/flac": "FLAC", "audio/mp4": "M4A", "audio/ogg": "OGG" };

/** The operations that have a key, by how their recipes are named; `takes`: of those, the ones that can do it. */
export const OPS: Record<string, { ends: string[]; label: string; takes?(r: RecipeInfo): boolean }> = {
  u: { ends: [".sharper"], label: "Upscale 2x" },
  f: { ends: [".fix-face"], label: "Face refine" },
  // the face detailer given a hand detector; Klein's redraws a face from a person's pictures and is not offered for hands
  h: { ends: [".fix-face"], label: "Hand refine", takes: (r) => Boolean(handsOf(r)) },
  b: { ends: [REMOVE_BACKGROUND], label: "Remove background" },
  i: { ends: [".paint-over"], label: "Inpaint" },
  e: { ends: [".edit", ".redraw"], label: "Edit" },
  // Klein names its outpaint by what it does to the frame; the other image models (SDXL, Flux, Qwen) call theirs outpaint
  r: { ends: [".outpaint", ".change-shape"], label: "Outpaint" },
};

/**
 * The recipe for an operation on a picture: the one of the model the picture was made with (`made`, its recipe id) when
 * that model has it, else one that is ready, else any. `all` is the recipes of the families turned on.
 */
export function toolOf(key: string, all: RecipeInfo[], families: Array<{ id: string; name: string; summary: string }>, made: string | undefined, ready: (r: RecipeInfo) => boolean): RecipeInfo | undefined {
  const ends = OPS[key]?.ends ?? [];
  const takes = OPS[key]?.takes ?? (() => true);
  const fits = (r: RecipeInfo) => r.output === "image" && ends.some((e) => r.id.endsWith(e)) && takes(r);
  const mine = modelGroups(all.filter((r) => r.output === "image"), families).find((group) => group.recipes.some((r) => r.id === made));
  return mine?.recipes.find(fits) ?? all.find((r) => fits(r) && ready(r)) ?? all.find(fits);
}

/** A hand detector's file as ComfyUI lists it under models/ultralytics, the one the detailers' hand values are known by. */
const HAND_FILE = "bbox/hand_yolov8s.pt";

/**
 * A face detailer's way to take hands: its detection model, and the values it starts on with a hand detector (the
 * recipe's own `whenChosen`, so the one-click pass and the form agree). None: it has no such values (Klein's).
 */
export function handsOf(r: RecipeInfo): { input: ChoiceInput; match: string; values: Record<string, unknown> } | undefined {
  const input = r.inputs.find((i): i is ChoiceInput => i.type === "choice" && i.id === "detector");
  const when = input?.whenChosen?.find((w) => new RegExp(w.match, "i").test(HAND_FILE));
  return input && when ? { input, match: when.match, values: when.values } : undefined;
}

/** What a refusal to queue Hand refine says when ComfyUI has no hand detector. */
export const NO_HAND_DETECTOR = "The hand detector is not installed: Settings → Models → Image tools has it (one click).";

/**
 * What Hand refine adds to the face detailer's form: the values it starts on with a hand detector, and the detector's file
 * among those ComfyUI offers (`options`, the setup's lists for the recipe's inputs). `missing`: ComfyUI answers and has none (offline nothing is listed, and the queue says why).
 */
export function handsInput(tool: RecipeInfo, options: Record<string, string[]> | undefined, online: boolean): { values: Record<string, unknown>; missing: boolean } | undefined {
  const way = handsOf(tool);
  if (!way) return undefined;
  const file = (options?.[way.input.id] ?? []).find((o) => new RegExp(way.match, "i").test(o));
  return { values: { ...way.values, ...(file ? { [way.input.id]: file } : {}) }, missing: !file && online };
}

/** The render a pass on an item carries: its own, else the one it was taken from (a mirrored copy, a frame, a cut). */
export const renderOf = (d: Pick<AssetDetail, "generation" | "ancestor"> | undefined): AssetDetail["generation"] => d?.generation ?? d?.ancestor ?? null;

/**
 * What a tool is handed along with a picture: what the picture was made with (its prompt, model, LoRAs…), where the
 * tool has a place for it. Never a picture or a seed: the picture is the new source; its own source, mask and seed stay
 * behind. `withLook`: its cast goes along, so what was typed is carried rather than the words the cast put in.
 */
export function carried(g: AssetDetail["generation"] | null | undefined, from: RecipeInfo | undefined, to: RecipeInfo, withLook: boolean): Record<string, unknown> {
  if (!g || !from) return {};
  const own = ownInputs(g, withLook);
  const taken = squash(from.family) === squash(to.family) ? carryOver(from, to, own, undefined) : borrowed(from, to, own);
  for (const i of to.inputs) if (i.type === "image" || i.type === "seed") delete taken[i.id];
  return taken;
}

/**
 * What goes to another model's tool, the one a picture's own model lacks (MOSS has no inpaint and no editor: Paint and fix
 * and Edit in box borrow Klein's or SDXL's): what the picture is of, never how its model was run. Its model file in the
 * other's model slot is a refusal or garbage, its negative and LoRAs are that model's own. Its prompt goes along whatever
 * the two call it and however they are written to: an empty Fix keeps "the picture's own", as the bar says.
 */
function borrowed(from: RecipeInfo, to: RecipeInfo, own: Record<string, unknown>): Record<string, unknown> {
  const out = carryAcross(from, to, own, undefined);
  const said = (r: RecipeInfo) => r.inputs.find((i) => i.type === "prompt" && !i.optional);
  const a = said(from);
  const b = said(to);
  const text = a && own[a.id];
  if (b && out[b.id] === undefined && typeof text === "string" && text.trim()) out[b.id] = text;
  return out;
}

/**
 * What a new draft made from a result starts from. Handed its cast again (`withLook`): the person's own form, from before the
 * server worked the cast into it, so that the cast's words are not carried in the prompt and given again beside it.
 */
export const ownInputs = (g: { inputs: Record<string, unknown>; asked?: Record<string, unknown> }, withLook: boolean): Record<string, unknown> => (withLook && g.asked ? g.asked : g.inputs);

/** Reuse keeps the seed the render went out with ("same"), or rolls a new one ("new"). */
export type ReuseSeed = "same" | "new";

/**
 * A render's generation parameters for a new draft: its seed kept (the one it was rendered with, even when the form
 * drew it), or a new one. A model with no seed input is handed none; one with no seed known rolls a new one.
 */
export function reusedInputs(g: Pick<NonNullable<AssetDetail["generation"]>, "inputs" | "resolved">, recipe: Pick<RecipeInfo, "inputs"> | undefined, seed: ReuseSeed): Record<string, unknown> {
  const slot = recipe ? recipe.inputs.find((i) => i.type === "seed")?.id : "seed";
  if (!slot) return { ...g.inputs };
  const kept = typedSeed(g.resolved.seed) ?? typedSeed(g.inputs[slot]);
  return { ...g.inputs, [slot]: seed === "same" && kept !== null ? kept : RANDOM_SEED };
}
