import { regionsOf, type GraphBuilder, type Ref, type RegionValue } from "@afflatus/core";
import { boxPixels } from "../shared/regions";
import type { FlowRegions } from "../flow/kit";

/** MOSS-Image's regions (card #271): the boxes as its own JSON layout, every box in one text. */

type Size = { width: number; height: number };

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
function mossBoxes(regions: readonly RegionValue[], size: Size) {
  return regions.map((r) => {
    const p = boxPixels(r.box, size);
    const text = r.kind === "text";
    return { x: p.x, y: p.y, width: p.width, height: p.height, metadata: { type: text ? "text" : "obj", text: text ? r.text ?? "" : "", desc: r.prompt.trim(), palette: [] as string[] } };
  });
}

/** The object boxes that are people ("1, 3"), counted among all boxes as the layout node counts them: a cast person's box. */
const mossCharacters = (regions: readonly RegionValue[]) => regions.flatMap((r, i) => (r.cast && r.kind !== "text" ? [String(i + 1)] : [])).join(", ");

/**
 * The text MOSS-Image reads, as Create Bounding Boxes and MOSS-Image Layout Prompt write it from these boxes (ComfyUI 0.44's
 * nodes_bounding_boxes.py and nodes_moss_image.py, step by step, with Python's rounding): the whole picture's caption, then
 * each box's label, caption, text and its edges in pixels from the picture's centre, [y0, x0, y1, x1]. What the form shows as
 * the prompt as sent; the render's nodes write it themselves.
 */
function mossLayout(prompt: string, regions: readonly RegionValue[], size: Size): string {
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
function mossLayoutText(g: GraphBuilder, prompt: string, regions: readonly RegionValue[], size: Size): Ref {
  // a list as a value is read as a link by ComfyUI: its page sends a list widget's value wrapped in __value__, which the
  // prompt's validation unwraps (execution.py); bare, the pod refused it ("Bad linked input")
  const canvas = g.add("CreateBoundingBoxes", { width: size.width, height: size.height, editor_state: { __value__: mossBoxes(regions, size) } });
  return g.out("MOSSImageLayoutPrompt", { prompt, element: [canvas, 2], width: size.width, height: size.height, character_boxes: mossCharacters(regions) });
}

/** The skip-layer guidance MOSS-Image's layout template turns on with the boxes (its negative side skips a layer). */
const GUIDANCE = { single: "22", end: 0.5 };

/**
 * MOSS-Image's way (Create Bounding Boxes and MOSS-Image Layout Prompt, ComfyUI's own nodes): every box in one text, so their
 * LoRAs go on the whole picture with the form's. The skip-layer guidance goes on the model where the first pass loads it;
 * the layout text is made where a pass reads it, at that pass's size, as the boxes' edges are in its pixels.
 */
export const MOSS_REGIONS = {
  how: "MOSS-Image's own JSON layout: an object box by its prompt, a text box drawn word for word, a cast box as a character.",
  lora: "global",
  kinds: true,
  nodes: (value) => (regionsOf(value).length ? ["CreateBoundingBoxes", "MOSSImageLayoutPrompt", "SkipLayerGuidanceDiTSimple"] : []),
  // its LoRAs are the form's once withWayLoras has added them: the loader loads them
  loads: () => [],
  apply(g, o, value) {
    const regions = regionsOf(value);
    const model = g.out("SkipLayerGuidanceDiTSimple", { model: o.model, double_layers: "", single_layers: GUIDANCE.single, start_percent: 0, end_percent: GUIDANCE.end });
    return { model, text: (size) => mossLayoutText(g, o.prompt, regions, size) };
  },
  layoutOf(input, size) {
    const regions = regionsOf(input.regions);
    return regions.length ? mossLayout(input.prompt, regions, size) : null;
  },
} satisfies FlowRegions;
