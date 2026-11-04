import type { InputSpec, RegionValue } from "@afflatus/core";

/**
 * Regions on the Stage (card #271): boxes drawn over the picture's frame, each with a prompt, optionally a person of the
 * cast and a LoRA. The recipes turn the one Regions field into what each family reads (SDXL's masked conditioning, MOSS's
 * JSON layout); core says the shapes (RegionsInput, RegionValue), here is what the form and the Stage make of them.
 */

export type { RegionValue };

/** A box as a part of the frame, each side 0 to 1: a size change of the form keeps every box where it was on the picture. */
export type UnitBox = RegionValue["box"];

/** MOSS's two kinds of box: a thing drawn there, or words written there. */
export type RegionKind = NonNullable<RegionValue["kind"]>;

/** What the "guided" ? says, on the Stage and on the form's card alike. */
export const GUIDED = "Boxes guide where things go; the model may shift, flip or merge them. Overlapping boxes blend. Not an exact placement.";

/** The Regions input of a recipe (core's RegionsInput). */
export type RegionsSpec = Extract<InputSpec, { type: "regions" }>;

/** A row the form does not take, with why (Recipe.absent): the Regions card greyed with it. */
export interface Absent {
  id: string;
  label: string;
  why: string;
}

/** The recipe's Regions input. */
export function regionsSpecOf(inputs: readonly InputSpec[]): RegionsSpec | undefined {
  return inputs.find((i): i is RegionsSpec => i.type === "regions");
}

/** Why a recipe takes no regions, when it says so (its `absent` row): the card is shown greyed with it. */
export const regionsAbsent = (absent: readonly Absent[] | undefined): Absent | undefined => absent?.find((a) => a.id === "regions");

/**
 * A form value read as the boxes drawn, every one (core's regionsOf keeps only those that say something, as the recipes send
 * them): anything else (an old draft, a value of another shape) is none.
 */
export function regionList(v: unknown): RegionValue[] {
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
