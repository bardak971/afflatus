import type { LoraValue } from "@afflatus/core";

/**
 * Regions on the Stage (card #271): boxes drawn over the picture's frame, each with a prompt, optionally a person of the
 * cast and a LoRA. The recipes turn the one Regions field into what each family reads (SDXL's masked conditioning, MOSS's
 * JSON layout); here is only what the form and the Stage hold.
 *
 * The shapes are the recipes' (core's RegionsInput and RegionValue, as agreed with the session that writes them); until that
 * is merged they are said here, and `regionsSpecOf` reads an input as one by its type name.
 */

/** A box as a part of the frame, each side 0 to 1: a size change of the form keeps every box where it was on the picture. */
export interface UnitBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** MOSS's two kinds of box: a thing drawn there, or words written there. */
export type RegionKind = "object" | "text";

export interface RegionValue {
  id: string;
  box: UnitBox;
  /** What is in the box; on a MOSS text box, how its words look ("big cream serif capitals"). */
  prompt: string;
  /** A person of the cast (a Prompt kit person's id): their words and their LoRA go to this region. */
  cast?: string;
  lora?: LoraValue;
  /** MOSS only; none: an object. */
  kind?: RegionKind;
  /** MOSS's text box: the exact words drawn. */
  text?: string;
  /** A painted region (an asset id): kept for later, the recipes read boxes only for now. */
  mask?: string;
}

/** What the "guided" ? says, on the Stage and on the form's card alike. */
export const GUIDED = "Boxes guide where things go; the model may shift, flip or merge them. Overlapping boxes blend. Not an exact placement.";

/** The Regions input of a recipe, as the form reads it. */
export interface RegionsSpec {
  id: string;
  type: "regions";
  label: string;
  note?: string;
  /** The most boxes the family takes. */
  max: number;
  /** The family has Object and Text boxes (MOSS). */
  kinds?: true;
  /** A region's LoRA (and its person's) is held to its box, or put on the whole picture; none: no LoRA per region. */
  lora?: "scoped" | "global";
}

/** A row the form does not take, with why (Recipe.absent): the Regions card greyed with it. */
export interface Absent {
  id: string;
  label: string;
  why: string;
}

/** The recipe's Regions input, read by its type name (the core type is the recipes' session's). */
export function regionsSpecOf(inputs: ReadonlyArray<{ type: string; id: string }>): RegionsSpec | undefined {
  return inputs.find((i) => i.type === "regions") as RegionsSpec | undefined;
}

/** Why a recipe takes no regions, when it says so (its `absent` row): the card is shown greyed with it. */
export const regionsAbsent = (absent: readonly Absent[] | undefined): Absent | undefined => absent?.find((a) => a.id === "regions");

/** A form value read as regions: anything else (an old draft, a value of another shape) is none. */
export function regionsOf(v: unknown): RegionValue[] {
  if (!Array.isArray(v)) return [];
  return v.filter((r): r is RegionValue => Boolean(r) && typeof r === "object" && typeof (r as RegionValue).id === "string" && Boolean((r as RegionValue).box));
}

/** What the regions become for a family, in a few words, under the card's head. */
export function regionsHow(spec: RegionsSpec): string {
  if (spec.kinds) return "Its own layout: each box an object or a text";
  if (spec.lora === "scoped") return "Masked conditioning: each box its prompt, its person and its LoRA";
  if (spec.lora === "global") return "Each box its prompt; a region's LoRA applies to the whole picture";
  return "Each box its prompt";
}
