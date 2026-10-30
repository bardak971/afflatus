import type { AddedLora, InputSpec, StartCondition } from "@afflatus/core";
import { UPSCALE } from "../video/upscale";
import { namedFor } from "./model";

/**
 * Turbo's LoRA as a row of H3's LoRA list (card #160): its file and its weight, inputs of their own drawn in that row. Left
 * as they start, the render is the one it was before they were (the slot's file, at 1).
 */
export const TURBO_LORA_INPUTS: InputSpec[] = [
  {
    id: "turboLora", type: "model", label: "Turbo LoRA", folder: "loras", slot: "turbo", blank: true, match: ["minimax.?h3.*turbo"], showWhen: "fast", advanced: true, perModel: true, inList: "loras",
    note: "the LoRA Turbo puts on the model. Left as it is, the one of Settings › Models (MiniMax H3's Turbo LoRA, or the reference model's own for a clip made from references). Another file runs at Turbo's steps all the same",
  },
  { id: "turboWeight", type: "number", label: "Turbo LoRA weight", min: -4, max: 4, step: 0.05, default: 1, showWhen: "fast", advanced: true, perModel: true, inList: "loras", note: "its strength_model: 1 is the LoRA's own. At 0 it is not loaded, Turbo's steps run without it" },
];

const named = (input: string | undefined, slot: string, re: RegExp): StartCondition => ({ name: { ...(input ? { input } : {}), slot }, match: re.source });
/** "Distilled model" or "Hybrid model" as modelOf reads it: Yes, or the file's name says so unless No. */
const said = (id: "turboIn" | "hybrid", model: StartCondition): StartCondition =>
  ({ any: [{ input: id, is: "Yes" }, { all: [{ not: { input: id, is: "No" } }, model] }] });
const TURBO_MODEL = said("turboIn", named("model", "unet", namedFor.turbo));
const HYBRID_MODEL = said("hybrid", named("model", "unet", namedFor.hybrid));
/** A distilled reference model takes no LoRA (loadH3Model). */
const REF_DISTILLED = named(undefined, "refUnet", namedFor.turbo);

/** The clip made by the reference route on H3's own model inputs (uses), the condition saying when. */
function videoRow(reference: StartCondition): { when: StartCondition; slots: AddedLora["slots"] } {
  return {
    when: {
      any: [
        // its own model: unless that is distilled
        { all: [{ not: reference }, { not: TURBO_MODEL }] },
        { all: [reference, HYBRID_MODEL, { not: TURBO_MODEL }] },
        // MiniMax's reference model: unless that is distilled
        { all: [reference, { not: HYBRID_MODEL }, { not: REF_DISTILLED }] },
      ],
    },
    // the reference model has a turbo LoRA of its own; without it the usual one is used
    slots: [{ slot: "refTurbo", when: { all: [reference, { not: HYBRID_MODEL }] } }, { slot: "turbo" }],
  };
}

const NOTE = "Turbo's LoRA: Turbo puts it on the model, at the weight set here. Its file is the one of Settings › Models (MiniMax H3's Turbo LoRA, or the reference model's own for a clip made from references) unless another is picked; any LoRA may take its place, at Turbo's steps. Removing the row turns Turbo off";
/**
 * What samples nothing, set by the app and never a form's: a Finish › Face refine (the take's own latent decoded, its faces
 * redrawn) and a swap's mask shown on its own (H3 not run).
 */
const SAMPLES: StartCondition = {
  all: [
    { not: { all: [{ input: "faceRefineOnly", is: true }, { not: { input: "upscale", is: UPSCALE.latent } }] } },
    { not: { input: "maskPreview", is: true } },
  ],
};
const row = (r: { when: StartCondition; slots: AddedLora["slots"] }): AddedLora => ({ label: "Turbo", note: NOTE, toggle: "fast", file: "turboLora", weight: "turboWeight", ...r, when: { all: [SAMPLES, r.when] } });

/** H3's forms made by H3's own model inputs (Video with audio, Lip sync): references, reference videos or a voice take the reference route. */
export const H3_TURBO_ROW = row(videoRow({ any: [{ input: "references", filled: true }, { input: "refVideos", filled: true }, { input: "voice", filled: true }] }));

/** A swap's (and a window after it): its model run as the clip's own, a hybrid, MiniMax's reference turbo LoRA first. */
const SWAP_MODEL_TURBO = named("swapModel", "swapUnet", namedFor.turbo);
export const SWAP_TURBO_ROW = row({ when: { not: SWAP_MODEL_TURBO }, slots: [{ slot: "refTurbo" }, { slot: "turbo" }] });

/**
 * A Motion transfer's: a window after a swap as the swap; any other on H3's model, by the reference route with a cast
 * picture, or carrying on where the reference route can run (the reference model there, or a hybrid picked).
 */
const AFTER_SWAP: StartCondition = { all: [{ input: "afterSwap", is: true }, { input: "previous", filled: true }] };
const MOTION_VIDEO = videoRow({ any: [{ input: "references", filled: true }, { all: [{ input: "previous", filled: true }, { any: [named(undefined, "refUnet", /./), HYBRID_MODEL] }] }] });
export const MOTION_TURBO_ROW = row({
  when: { any: [{ all: [AFTER_SWAP, { not: SWAP_MODEL_TURBO }] }, { all: [{ not: AFTER_SWAP }, MOTION_VIDEO.when] }] },
  slots: [{ slot: "refTurbo", when: { any: [AFTER_SWAP, MOTION_VIDEO.slots[0]!.when!] } }, { slot: "turbo" }],
});

/** A form's LoRA list with Turbo's row in it. */
export const withTurboRow = (inputs: InputSpec[], added: AddedLora): InputSpec[] =>
  inputs.map((i) => (i.id === "loras" && i.type === "loras" ? { ...i, added: [added] } : i));
