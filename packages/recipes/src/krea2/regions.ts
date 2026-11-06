import { regionBox, regionsOf, type InputSpec, type Ref, type RegionValue } from "@afflatus/core";
import { boxMask, REGIONS, regionLoads, regionLoras, type RegionWay } from "../shared/regions";

/** Krea 2's regions (card #271): every box read in one pass, by ComfyUI-Krea2-Regional's own lower-level nodes. */

/** Where a box lies, in the words the pack's builder puts in the base prompt (krea2_builder.py's _ZONES). */
const ZONES = [["upper left", "top", "upper right"], ["left side", "center", "right side"], ["lower left", "bottom", "lower right"]] as const;

/** A LoRA's trigger-like word ("ohwx", "m_char", "xk3wChar"), which Krea 2 draws as letters beside a place in the text (_looks_like_trigger). */
const triggerLike = (word: string) => !word.includes(" ") && (/\d|_/.test(word) || /[A-Z]/.test(word.slice(1)));

/** The few words of a box said in the base prompt: its first clause of two words or more, else one that is not a trigger (_hint_clause). */
function hintClause(prompt: string): string {
  const clauses = prompt.split(",").map((c) => c.trim().replace(/^"+|"+$/g, "").replace(/<[^>]*>/g, "").trim()).filter(Boolean);
  return clauses.find((c) => c.split(/\s+/).length >= 2) ?? clauses.find((c) => !triggerLike(c)) ?? "a subject";
}

/**
 * Where a box is and how large, as one sentence of the base prompt ("in the left side of the image, prominent: a woman in a
 * red coat"), the way the pack's builder says it (_layout_hint): Krea 2's Qwen3-VL encoder reads such placements, which
 * steers where each subject is drawn, while the attention masks hold what each box's tokens read (the pack's README). Only
 * with "Position hints" (KREA2_LAYOUTS).
 */
function krea2Hint(r: RegionValue): string {
  const b = regionBox(r.box);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const zone = ZONES[cy < 1 / 3 ? 0 : cy < 2 / 3 ? 1 : 2][cx < 1 / 3 ? 0 : cx < 2 / 3 ? 1 : 2];
  const area = b.w * b.h;
  const scale = area > 0.5 ? "dominating the frame" : area > 0.22 ? "prominent" : "small";
  const clause = hintClause(r.prompt);
  const short = clause.length > 70 ? `${clause.slice(0, 67).trimEnd()}...` : clause;
  return `in the ${zone} of the image, ${scale}: ${short}`;
}

/**
 * What the base text says of the boxes (the pack builder's layout_in_base): nothing, the masks alone placing what each box
 * holds, or where each box is and what it holds. Off by default: on a pod (2026-11-05), the prompt of two men side by side on
 * a sidewalk, full body, came out as one street; with a sentence per man added (the hints, or two other wordings), as two
 * photos side by side with a seam down the middle, with or without the boxes' masks.
 */
const KREA2_LAYOUTS = ["Off", "Position hints"] as const;
export type Krea2Layout = (typeof KREA2_LAYOUTS)[number];

/** The Krea 2 row of the layout in the base text, shown with the regions. */
export const KREA2_LAYOUT_INPUT: InputSpec = {
  id: "regionLayout", type: "choice", label: "Layout in base prompt", options: [...KREA2_LAYOUTS], default: "Off", showWhen: REGIONS, advanced: true,
  note: "the regional pack's layout_in_base. Off: the prompt as written, the boxes' masks place what each holds. Position hints: a sentence per box added to the prompt (\"in the left side of the image, prominent: …\"), which pulls each part into its box harder, but turned a full-body picture of two people into two photos side by side in Afflatus's test",
};

/** The whole picture's text as Krea 2 reads it with regions: the prompt, then, with the hints, where each box is (the builder's "position hints"). */
function krea2BaseText(prompt: string, regions: readonly RegionValue[], layout: Krea2Layout = "Off"): string {
  const sentences = [prompt.trim().replace(/\.+$/, ""), ...(layout === "Position hints" ? regions.map(krea2Hint) : [])].filter(Boolean);
  return sentences.join(". ") || "an image";
}

/**
 * The model and text of a picture with regions, in one pass (ComfyUI-Krea2-Regional's own lower-level nodes, the canvas
 * builder's work done here): each box's words read alone and joined to the base text, a joint attention mask keeping each
 * box's picture tokens on its own words beside the base's, and its LoRAs gated to its tokens, so that they act inside it
 * alone while the form's LoRAs stay on the whole picture. The pack's own example's settings: masks kept to one box where two
 * grow into each other, and "refine boxes", which snaps each mask to the subject the model draws inside its (grown) box
 * after the first two steps, so a LoRA follows the person rather than the rectangle.
 */
export const KREA2_REGIONS = {
  how: "ComfyUI-Krea2-Regional, in one pass: each box's words read by its part of the picture, beside the prompt. Not with a person or style reference.",
  lora: "scoped",
  /** A mask per box, its text, the pack's region chain, its LoRAs and its patch. */
  nodes(value) {
    const regions = regionsOf(value);
    if (!regions.length) return [];
    return ["SolidMask", "MaskComposite", "CLIPTextEncode", "Krea2RegionalPrompt", "Krea2ApplyRegional", ...(regions.some((r) => regionLoras(r).length) ? ["Krea2LoRA"] : [])];
  },
  loads: regionLoads,
  apply(g, o, value) {
    const regions = regionsOf(value);
    let chain: Ref | null = null;
    for (const r of regions) {
      let loras: Ref | null = null;
      for (const l of regionLoras(r)) loras = g.out("Krea2LoRA", { lora_name: l.file, strength: l.weight, ...(loras ? { prev_loras: loras } : {}) });
      chain = g.out("Krea2RegionalPrompt", {
        conditioning: g.out("CLIPTextEncode", { text: r.prompt.trim(), clip: o.clip }), mask: boxMask(g, r.box, o.size),
        ...(loras ? { loras } : {}), ...(chain ? { prev_regions: chain } : {}),
      });
    }
    const applied = g.add("Krea2ApplyRegional", {
      model: o.model, conditioning: g.out("CLIPTextEncode", { text: krea2BaseText(o.prompt, regions, o.layout), clip: o.clip }), regions: chain!,
      restrict_img_attn: false, exclusive_masks: true, adaptive_masks: "refine boxes", adaptive_steps: 2, adaptive_threshold: 0.45,
      base_loras_exclude_regions: false, region_lock_strength: 0, region_lock_start: 0.35, region_lock_end: 0.85, restrict_end_percent: 1, unmaskable_layers: "skip",
    });
    return { model: [applied, 0] as Ref, positive: [applied, 1] as Ref };
  },
  /** What the form shows as the prompt as sent: the base text, then each box's own, as the model is given them. */
  layoutOf(input) {
    const regions = regionsOf(input.regions);
    if (!regions.length) return null;
    return [krea2BaseText(input.prompt, regions, input.regionLayout), ...regions.map((r, i) => `Region ${i + 1}: ${r.prompt.trim()}`)].join("\n");
  },
} satisfies RegionWay<
  { model: Ref; clip: Ref; prompt: string; size: { width: number; height: number }; layout?: Krea2Layout },
  { model: Ref; positive: Ref },
  { prompt: string; regions?: RegionValue[]; regionLayout?: Krea2Layout }
>;
