import { REMOVE_BACKGROUND, type PictureOp } from "@afflatus/core";
import type { RecipeInfo } from "./api";
import type { ActionId } from "./itemActions";
import type { StageMode } from "./paintFix/useStageMode";
import type { QueuedJob } from "./queueVariation";
import type { FrameSides } from "./stageLayer/useFrameTool";

/**
 * The passes on a picture, by the viewer's key for them, said once (card #290): the action that runs it, its label, the
 * recipes that do it, whether its results come back as versions, the Stage's mode it drives and the inputs Paint and fix
 * hands it. Before, these were four tables (OPS, PASS_KEYS, VERSION_PASSES, MODE_PASS) and builders of the same job in
 * three places.
 */
interface Pass {
  action: ActionId;
  label: string;
  /** The recipes that do it, by their picture operation (core's PictureOp); Remove background, no family's form, by its id. */
  op?: readonly PictureOp[];
  id?: string;
  /** Of those, only a face detailer that takes a hand detector (viewer/shared.ts handsOf). */
  hands?: true;
  /**
   * Its results come back as versions of the picture, under it (the owner's choice, card #274): same picture, same
   * framing. Upscale and Remove background make new items.
   */
  version?: true;
  /** The Stage's mode it drives (Paint and fix): without its recipe, the Stage does not take the mode. */
  mode?: StageMode;
}

/** What the fix bar sends besides the mask: the prompt, the denoise, the grow, how many, and the ⚙ popover's rows. */
export interface FixAsk {
  prompt: string;
  /** The mask has a soft edge of its own (the layer's Feather): the recipe's own blend is kept to its least, not added on top. */
  soft?: boolean;
  strength: number;
  grow: number;
  count: number;
  /** The rows changed in ⚙ (TunePopover). */
  tuned: Record<string, unknown>;
}

/** Whether the recipe has a row of this id (a family's form may not take a grow, a prompt or a denoise). */
const takes = (tool: RecipeInfo, id: string) => tool.inputs.some((i) => i.id === id);

/** The prompt as the bar sends it: an empty one keeps the picture's own (carried with it), only what is written replaces it. */
const promptOf = (tool: RecipeInfo, prompt: string) => (prompt.trim() && takes(tool, "prompt") ? { prompt: prompt.trim() } : {});

const TABLE = {
  u: { action: "upscale", label: "Upscale 2x", op: ["upscale"] },
  f: { action: "face", label: "Face refine", op: ["face"], version: true },
  // the face detailer given a hand detector; Klein's redraws a face from a person's pictures and is not offered for hands
  h: { action: "hand", label: "Hand refine", op: ["face"], hands: true, version: true },
  b: { action: "background", label: "Remove background", id: REMOVE_BACKGROUND },
  i: {
    action: "inpaint", label: "Inpaint", op: ["inpaint"], version: true, mode: "paint",
    /** The inpaint recipe's own slots: its mask's, and whether it takes a grow and a prompt (a family's form may not). */
    inputs: (tool: RecipeInfo, ask: Omit<FixAsk, "count"> & { mask: string }): Record<string, unknown> => {
      const slot = tool.inputs.find((i) => i.type === "image" && i.role === "mask")!;
      return {
        [slot.id]: ask.mask,
        ...promptOf(tool, ask.prompt),
        ...(takes(tool, "strength") ? { strength: ask.strength } : {}),
        ...(takes(tool, "maskGrow") ? { maskGrow: ask.grow } : {}),
        // its 0 means "picked from the size of the part", a blur over the whole mask again: with a feathered mask the feather is the edge
        ...(ask.soft && takes(tool, "maskBlur") ? { maskBlur: 1 } : {}),
        ...ask.tuned,
      };
    },
  },
  // a model with no editor (SDXL, Krea 2, Z-Image) edits by its img2img
  e: {
    action: "edit", label: "Edit", op: ["edit", "img2img"], version: true, mode: "edit",
    /** An edit's inputs: the instruction when written, img2img's denoise when it takes one, the ⚙ rows. */
    inputs: (tool: RecipeInfo, ask: Pick<FixAsk, "prompt" | "strength" | "tuned">): Record<string, unknown> =>
      ({ ...promptOf(tool, ask.prompt), ...(takes(tool, "strength") ? { strength: ask.strength } : {}), ...ask.tuned }),
  },
  r: {
    action: "outpaint", label: "Outpaint", op: ["outpaint"], version: true, mode: "outpaint",
    /** The outpaint's inputs: the sides, what the added parts show when written, the ⚙ rows. */
    inputs: (tool: RecipeInfo, ask: Pick<FixAsk, "prompt" | "tuned"> & { sides: FrameSides }): Record<string, unknown> =>
      ({ ...ask.sides, ...promptOf(tool, ask.prompt), ...ask.tuned }),
  },
} as const satisfies Record<string, Pass & { inputs?: unknown }>;

/** A pass's key (the viewer's: U, F, H, B, I, E, R). */
export type PassKey = keyof typeof TABLE;
/** The passes in the order the item's lists show them. */
export const PASSES: Readonly<Record<PassKey, Pass>> = TABLE;
/** The passes Paint and fix drives on the Stage, and the inputs each is handed from its bar. */
export type StagePass = "i" | "e" | "r";
export type AskOf<K extends StagePass> = Parameters<(typeof TABLE)[K]["inputs"]>[1];
export const passInputs = <K extends StagePass>(key: K, tool: RecipeInfo, ask: AskOf<K>): Record<string, unknown> =>
  (TABLE[key].inputs as (tool: RecipeInfo, ask: AskOf<K>) => Record<string, unknown>)(tool, ask);

/** The pass an item's action runs, by its key; none: the action is no pass. */
export const passOf = (action: ActionId): PassKey | undefined => (Object.keys(PASSES) as PassKey[]).find((k) => PASSES[k].action === action);
/** The pass each Stage mode needs. */
export const modePass = (mode: StageMode): PassKey => (Object.keys(PASSES) as PassKey[]).find((k) => PASSES[k].mode === mode)!;

/**
 * A pass's job on a picture: the recipe with what it is handed (`stored`), labelled as the pass, from the picture, as a
 * version of it where the pass lands so. The one builder of it for an item's button, a library selection and Paint and fix.
 */
export const jobOfPass = (key: PassKey, recipe: RecipeInfo, stored: Record<string, unknown>, picture: string): QueuedJob =>
  ({ recipe, stored, label: PASSES[key].label, from: picture, ...(PASSES[key].version ? { versionOf: picture } : {}) });
