import { clampBox, regionBox, regionsOf, type GraphBuilder, type InputSpec, type LoraValue, type Ref, type RegionValue } from "@afflatus/core";

/**
 * Regions on the Stage (card #271): boxes over a txt2img picture's frame, each with words of its own, a cast person and a
 * LoRA. One input on every form that can read them, in the same place and words; each family turns them into what its model
 * reads, behind one RegionWay (card #291): MOSS-Image's JSON layout (its own nodes, moss/regions.ts), SDXL's conditioning
 * masked to each box (ComfyUI's own nodes, sdxl/regions.ts), Krea 2's regional pack (krea2/regions.ts). A family without a
 * way leaves the row out and says why beside its drops (pictureForm's, shown greyed). The result is guided, not exact: a box
 * says where a thing should go, and the model may still move it, shrink it or let it spill (MOSS's authors measure the
 * layout right about 80 % of the time). What stays here is what every way shares: the row, the boxes in pixels and as masks,
 * and the regions' LoRAs.
 */

/** The input's id on every form. */
export const REGIONS = "regions";
/** The most boxes one picture takes: past this, each box is too small to say much, and SDXL samples once more per LoRA. */
const MOST = 8;

/** Why a family whose regional nodes come from a pack not installed yet has none, for its drop (the form greys the row with it). */
export const REGIONS_NOT_YET = "Not yet on this model: its regional nodes come from a node pack that Afflatus does not install yet (a later round). SDXL, MOSS-Image and Krea 2 have regions now";

type Size = { width: number; height: number };

/**
 * How a family reads regions (card #291): its txt2img takes one, and the Regions row, the nodes, the files and the LoRAs come
 * from it. `apply` makes the family's nodes where its first pass made them, so that a graph is built in the same order: what
 * it is given (`At`) and gives back (`Made`) are the family's, since each reads the boxes at another point of its pass (SDXL
 * over its conditioning, Krea 2 over its model and text, MOSS-Image as the text its sampler reads, at each size).
 */
export interface RegionWay<At, Made, Input = never> {
  /** The model's way in a line, for the row's "?". */
  how: string;
  /** What a region's LoRA does on this model: act inside its box alone, or go on the whole picture with the form's. */
  lora: "scoped" | "global";
  /** Whether a box can be a text, drawn word for word. */
  kinds?: true;
  /** The nodes the regions bring in (none without boxes). */
  nodes(value: unknown): string[];
  /** The files the regions load themselves (a global way's LoRAs are the loader's: withWayLoras). */
  loads(value: unknown): string[];
  apply(g: GraphBuilder, at: At, value: unknown): Made;
  /** What the form shows as the prompt as sent with these boxes, at the picture's size; null without boxes. */
  layoutOf?(input: Input, size: Size): string | null;
}

/**
 * The Regions row: `lora` says what a region's LoRA does on this model, `kinds` whether a box can be a text, `how` the model's
 * way in a line. Its "?" is one or two lines (card #181's rule, card #318): that the result is guided, not exact, is the
 * Guided "?" beside the boxes.
 */
export function regionsInput(o: { lora: "scoped" | "global"; kinds?: true; how: string }): InputSpec {
  const lora = o.lora === "scoped" ? "A box's LoRA and its cast person's act inside it alone." : "A box's LoRA and its cast person's go on the whole picture.";
  return {
    id: REGIONS, type: "regions", label: "Regions", max: MOST, lora: o.lora, ...(o.kinds ? { kinds: true } : {}),
    note: `boxes on the Stage. ${o.how} ${lora}`,
  };
}

/** A box in pixels of a picture of this size: whole pixels, at least one each way, within the picture. */
export function boxPixels(box: RegionValue["box"], size: Size) {
  const b = regionBox(box);
  return clampBox({ x: b.x * size.width, y: b.y * size.height, width: b.w * size.width, height: b.h * size.height }, size);
}

/** A region's LoRAs: its own and its cast person's (put in by the server), those not at 0, each file once. */
export const regionLoras = (r: RegionValue): LoraValue[] =>
  [r.lora, r.castLora].filter((l): l is LoraValue => Boolean(l && l.weight !== 0)).filter((l, i, all) => all.findIndex((x) => x.file === l.file) === i);

/** The LoRAs of every region, each file once: what a model that reads every box in one text puts on the whole picture. */
const allRegionLoras = (regions: readonly RegionValue[]): LoraValue[] =>
  regions.flatMap(regionLoras).filter((l, i, all) => all.findIndex((x) => x.file === l.file) === i);

/**
 * The form's LoRAs as a way loads them: with a global way's, the regions' added (a file the list has already stays at the
 * list's weight); a scoped way holds its own to the boxes and loads them itself.
 */
export const withWayLoras = (way: { lora: "scoped" | "global" }, loras: LoraValue[], value: unknown): LoraValue[] =>
  way.lora === "global" ? [...loras, ...allRegionLoras(regionsOf(value)).filter((l) => !loras.some((h) => h.file === l.file))] : loras;

/** A mask of the picture's size, 1 inside the box and 0 elsewhere (ComfyUI's own SolidMask and MaskComposite). */
export function boxMask(g: GraphBuilder, box: RegionValue["box"], size: Size): Ref {
  const p = boxPixels(box, size);
  return g.out("MaskComposite", { destination: g.out("SolidMask", { value: 0, width: size.width, height: size.height }), source: g.out("SolidMask", { value: 1, width: p.width, height: p.height }), x: p.x, y: p.y, operation: "add" });
}

/** The region LoRA files a scoped way loads (its `loads`). */
export const regionLoads = (value: unknown): string[] => allRegionLoras(regionsOf(value)).map((l) => `loras/${l.file}`);
