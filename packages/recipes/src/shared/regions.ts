import { regionBox, regionsOf, type GraphBuilder, type InputSpec, type LoraValue, type Ref, type RegionValue } from "@afflatus/core";

/**
 * Regions on the Stage (card #271): boxes over a txt2img picture's frame, each with words of its own, a cast person and a
 * LoRA. One input on every form that can read them, in the same place and words; each family turns them into what its model
 * reads: MOSS-Image's JSON layout (its own nodes), SDXL's conditioning masked to each box (ComfyUI's own nodes). A family
 * without a way leaves the row out and says why (pictureForm's drops, shown greyed). The result is guided, not exact: a box
 * says where a thing should go, and the model may still move it, shrink it or let it spill (MOSS's authors measure the
 * layout right about 80 % of the time).
 */

/** The input's id on every form. */
export const REGIONS = "regions";
/** The most boxes one picture takes: past this, each box is too small to say much, and SDXL samples once more per LoRA. */
const MOST = 8;

/** Why each family without regions has none, for its drop (the form greys the row with it). */
export const REGIONS_NOT_YET = "Not yet on this model: its regional nodes come from a node pack that Afflatus does not install yet (a later round). SDXL and MOSS-Image have regions now";
export const REGIONS_WHY = {
  klein: "FLUX.2 Klein has no way to read regions: the only regional pack for it is non-commercial. FLUX 3 Klein's own box layout will come with that model",
  qwen: "Qwen Image reads masked conditioning too weakly for regions to hold (its one pack, mask-based, was found weak): none are offered",
  qwen21: "Qwen Image 2.1 has no regional prompting: no node reads boxes for it",
  zimage: "Z-Image has one small regional pack, untested: none are offered for now",
} as const;

/** The Regions row: `lora` says what a region's LoRA does on this model, `kinds` whether a box can be a text. */
export function regionsInput(o: { lora?: "scoped" | "global"; kinds?: true; how: string }): InputSpec {
  const lora = o.lora === "scoped"
    ? "A region's LoRA, and its cast person's, act inside its box alone."
    : o.lora === "global"
      ? "A region's LoRA, and its cast person's, are put on the whole picture: this model reads every box in one text, so a LoRA cannot be held to one."
      : "";
  return {
    id: REGIONS, type: "regions", label: "Regions", max: MOST, ...(o.kinds ? { kinds: true } : {}), ...(o.lora ? { lora: o.lora } : {}),
    note: [
      `boxes drawn on the Stage, each with its own prompt, a cast person (their words and LoRA) and a LoRA. ${o.how}`,
      lora,
      "The result is guided, not exact: a box says where a thing should go, the model may still move it, shrink it or let it spill.",
      "With Detail: face on, each face found in a person's box is redrawn from that person's words and LoRA",
    ].filter(Boolean).join(" "),
  };
}

/** A box in pixels of a picture of this size: whole pixels, at least one each way, within the picture. */
export function boxPixels(box: RegionValue["box"], size: { width: number; height: number }) {
  const b = regionBox(box);
  const x = Math.min(size.width - 1, Math.round(b.x * size.width));
  const y = Math.min(size.height - 1, Math.round(b.y * size.height));
  return { x, y, width: Math.max(1, Math.min(size.width - x, Math.round(b.w * size.width))), height: Math.max(1, Math.min(size.height - y, Math.round(b.h * size.height))) };
}

/** A region's LoRAs: its own and its cast person's (put in by the server), those not at 0, each file once. */
export const regionLoras = (r: RegionValue): LoraValue[] =>
  [r.lora, r.castLora].filter((l): l is LoraValue => Boolean(l && l.weight !== 0)).filter((l, i, all) => all.findIndex((x) => x.file === l.file) === i);

/** The LoRAs of every region, each file once: what a model that reads every box in one text puts on the whole picture. */
export const allRegionLoras = (regions: readonly RegionValue[]): LoraValue[] =>
  regions.flatMap(regionLoras).filter((l, i, all) => all.findIndex((x) => x.file === l.file) === i);

/** The form's LoRAs with the regions' added (a file the list has already stays at the list's weight). */
export const withRegionLoras = (loras: LoraValue[], regions: readonly RegionValue[]): LoraValue[] =>
  [...loras, ...allRegionLoras(regions).filter((l) => !loras.some((h) => h.file === l.file))];

/** A mask of the picture's size, 1 inside each of these boxes and 0 elsewhere (ComfyUI's own SolidMask and MaskComposite). */
export function boxMask(g: GraphBuilder, boxes: Array<RegionValue["box"]>, size: { width: number; height: number }): Ref {
  let mask = g.out("SolidMask", { value: 0, width: size.width, height: size.height });
  for (const box of boxes) {
    const p = boxPixels(box, size);
    mask = g.out("MaskComposite", { destination: mask, source: g.out("SolidMask", { value: 1, width: p.width, height: p.height }), x: p.x, y: p.y, operation: "add" });
  }
  return mask;
}

// ---- SDXL: the conditioning of each region, masked to its box

/** The nodes SDXL's regions bring in: a mask per box, its text masked and added, a LoRA held to its box by hooks. */
export function sdxlRegionNodes(value: unknown): string[] {
  const regions = regionsOf(value);
  if (!regions.length) return [];
  const hooked = regions.some((r) => regionLoras(r).length);
  const plain = regions.some((r) => !regionLoras(r).length);
  return ["SolidMask", "MaskComposite", ...(plain ? ["ConditioningSetMask", "ConditioningCombine"] : []), ...(hooked ? ["CreateHookLora", "SetClipHooks", "ConditioningSetPropertiesAndCombine"] : [])];
}

/** What a region's text was read into, for the face pass after: its box and its conditioning (with its LoRA's hooks). */
export interface RegionCond {
  box: RegionValue["box"];
  /** Its words as read, whole-picture (no mask): what a face of it is redrawn from. */
  cond: Ref;
  /** Its LoRAs as hooks, when it has any: the face pass's conditioning carries them, so they act on that face alone. */
  hooks: Ref | null;
  /** A cast person stands in it. */
  person: boolean;
}

/**
 * The picture's text with each region's added over its box: ComfyUI's masked conditioning, the region's words sampled inside
 * its box beside the whole picture's everywhere (the base keeps the scene one picture). A region with a LoRA (its own, its
 * person's) is read by the text encoder with the LoRA on and samples with it on inside its box alone: ComfyUI's hooks
 * (CreateHookLora on the clip with SetClipHooks, and on the conditioning with ConditioningSetPropertiesAndCombine), its own
 * documented way to hold a LoRA to one part of a picture, so that two people's LoRAs do not blend into one face.
 */
export function sdxlRegions(g: GraphBuilder, o: { clip: Ref; positive: Ref; quality: string; size: { width: number; height: number } }, value: unknown): { positive: Ref; regions: RegionCond[] } {
  const regions = regionsOf(value);
  let positive = o.positive;
  const out: RegionCond[] = [];
  for (const r of regions) {
    const text = [o.quality.trim().replace(/,\s*$/, ""), r.prompt.trim()].filter(Boolean).join(", ");
    const mask = boxMask(g, [r.box], o.size);
    const loras = regionLoras(r);
    if (loras.length) {
      let hooks: Ref | null = null;
      for (const l of loras) hooks = g.out("CreateHookLora", { lora_name: l.file, strength_model: l.weight, strength_clip: l.weight, ...(hooks ? { prev_hooks: hooks } : {}) });
      const clip = g.out("SetClipHooks", { clip: o.clip, apply_to_conds: true, schedule_clip: false, hooks: hooks! });
      const cond = g.out("CLIPTextEncode", { text, clip });
      positive = g.out("ConditioningSetPropertiesAndCombine", { cond: positive, cond_NEW: cond, strength: 1, set_cond_area: "default", mask, hooks: hooks! });
      out.push({ box: r.box, cond, hooks, person: Boolean(r.cast) });
    } else {
      const cond = g.out("CLIPTextEncode", { text, clip: o.clip });
      positive = g.out("ConditioningCombine", { conditioning_1: positive, conditioning_2: g.out("ConditioningSetMask", { conditioning: cond, mask, strength: 1, set_cond_area: "default" }) });
      out.push({ box: r.box, cond, hooks: null, person: Boolean(r.cast) });
    }
  }
  return { positive, regions: out };
}

/** The region LoRA files a render loads (for `loads`). */
export const regionLoads = (value: unknown): string[] => allRegionLoras(regionsOf(value)).map((l) => `loras/${l.file}`);

// ---- the face pass, region by region

/** The nodes the face pass by region adds, beside the Impact Pack's detailer: optional as it is (shared/adetail.ts). */
export const REGION_FACE_NODES = ["SolidMask", "MaskComposite", "InvertMask", "MaskToSEGS", "ImpactSEGSIntersectionFilter", "ConditioningSetProperties"];

/**
 * The faces found inside these boxes (`inside`), or outside all of them: a face kept when less than half of it lies on the
 * other side (the Impact Pack's intersection filter, which drops a face more than half over the mask it is given).
 */
export function facesIn(g: GraphBuilder, segs: Ref, boxes: Array<RegionValue["box"]>, size: { width: number; height: number }, inside: boolean): Ref {
  const mask = boxMask(g, boxes, size);
  const away = g.out("MaskToSEGS", { mask: inside ? g.out("InvertMask", { mask }) : mask, combined: true, crop_factor: 1, bbox_fill: false, drop_size: 1, contour_fill: false });
  return g.out("ImpactSEGSIntersectionFilter", { segs1: segs, segs2: away, ioa_threshold: 0.5 });
}

// ---- MOSS-Image: the layout

/** Python's round() on a float (halves to even), which ComfyUI's box nodes use: the layout said here is the one they write. */
const pyRound = (v: number) => {
  const f = Math.floor(v);
  const d = v - f;
  return d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1;
};

/**
 * The regions as Create Bounding Boxes' canvas holds them (its editor_state, as ComfyUI's page sends it): boxes in pixels of
 * the picture, each an object or a text, its words (`desc`) and the text it draws. Background first, foreground last, as the
 * node asks: the order the form lists them in.
 */
export function mossBoxes(regions: readonly RegionValue[], size: { width: number; height: number }) {
  return regions.map((r) => {
    const p = boxPixels(r.box, size);
    const text = r.kind === "text";
    return { x: p.x, y: p.y, width: p.width, height: p.height, metadata: { type: text ? "text" : "obj", text: text ? r.text ?? "" : "", desc: r.prompt.trim(), palette: [] as string[] } };
  });
}

/** The object boxes that are people ("1, 3"), counted among all boxes as the layout node counts them: a cast person's box. */
export const mossCharacters = (regions: readonly RegionValue[]) => regions.flatMap((r, i) => (r.cast && r.kind !== "text" ? [String(i + 1)] : [])).join(", ");

/**
 * The text MOSS-Image reads, as Create Bounding Boxes and MOSS-Image Layout Prompt write it from these boxes (ComfyUI 0.44's
 * nodes_bounding_boxes.py and nodes_moss_image.py, step by step, with Python's rounding): the whole picture's caption, then
 * each box's label, caption, text and its edges in pixels from the picture's centre, [y0, x0, y1, x1]. What the form shows as
 * the prompt as sent; the render's nodes write it themselves.
 */
export function mossLayout(prompt: string, regions: readonly RegionValue[], size: { width: number; height: number }): string {
  const { width, height } = size;
  const characters = new Set(mossCharacters(regions).split(", ").filter(Boolean).map(Number));
  const items = mossBoxes(regions, size).map((b, i) => {
    // the canvas's box as shares of the picture, then on its 0–1000 grid (build_elements' _norm_bbox)
    const grid = (v: number) => Math.max(0, Math.min(1000, pyRound(v * 1000)));
    const fx = b.x / width, fy = b.y / height, fw = b.width / width, fh = b.height / height;
    const [y0, x0, y1, x1] = [grid(fy), grid(fx), grid(fy + fh), grid(fx + fw)] as [number, number, number, number];
    const text = b.metadata.type === "text";
    const item: Record<string, unknown> = { label: text ? "text" : characters.has(i + 1) ? "character" : "object", caption: b.metadata.desc };
    if (text) item.text = b.metadata.text;
    // round(…, 9) as the node does, against a float's last digit, before the floor and the ceiling
    const at = (v: number, edge: number) => Number(((v * edge) / 1000).toFixed(9));
    item.bbox = [Math.floor(at(y0, height)) - Math.floor(height / 2), Math.floor(at(x0, width)) - Math.floor(width / 2), Math.ceil(at(y1, height)) - Math.floor(height / 2), Math.ceil(at(x1, width)) - Math.floor(width / 2)];
    return item;
  });
  if (!items.length) return prompt;
  return JSON.stringify({ summary: { caption: prompt.trim() }, items, bbox_coord_space: "abs_centralized", bbox_format: "yxyx" });
}

/** The layout nodes on a graph: the boxes' canvas, then the layout text from it and the prompt. */
export function mossLayoutText(g: GraphBuilder, prompt: string, regions: readonly RegionValue[], size: { width: number; height: number }): Ref {
  // a list as a value is read as a link by ComfyUI: its page sends a list widget's value wrapped in __value__, which the
  // prompt's validation unwraps (execution.py); bare, the pod refused it ("Bad linked input")
  const canvas = g.add("CreateBoundingBoxes", { width: size.width, height: size.height, editor_state: { __value__: mossBoxes(regions, size) } });
  return g.out("MOSSImageLayoutPrompt", { prompt, element: [canvas, 2], width: size.width, height: size.height, character_boxes: mossCharacters(regions) });
}
export const MOSS_LAYOUT_NODES = ["CreateBoundingBoxes", "MOSSImageLayoutPrompt"];
