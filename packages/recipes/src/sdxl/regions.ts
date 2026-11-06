import { regionsOf, withQuality, type Ref } from "@afflatus/core";
import { boxMask, regionLoads, regionLoras, type RegionWay } from "../shared/regions";

/**
 * SDXL's regions (card #271): the picture's text with each region's added over its box, ComfyUI's masked conditioning, the
 * region's words sampled inside its box beside the whole picture's everywhere (the base keeps the scene one picture). A region
 * with a LoRA (its own, its person's) is read by the text encoder with the LoRA on and samples with it on inside its box
 * alone: ComfyUI's hooks (CreateHookLora on the clip with SetClipHooks, and on the conditioning with
 * ConditioningSetPropertiesAndCombine), its own documented way to hold a LoRA to one part of a picture, so that two people's
 * LoRAs do not blend into one face.
 */
export const SDXL_REGIONS = {
  how: "Masked conditioning: each box's tags inside it, beside the prompt's; hires tiles redraw from the prompt alone.",
  lora: "scoped",
  /** A mask per box, its text masked and added, a LoRA held to its box by hooks. */
  nodes(value) {
    const regions = regionsOf(value);
    if (!regions.length) return [];
    const hooked = regions.some((r) => regionLoras(r).length);
    const plain = regions.some((r) => !regionLoras(r).length);
    return ["SolidMask", "MaskComposite", ...(plain ? ["ConditioningSetMask", "ConditioningCombine"] : []), ...(hooked ? ["CreateHookLora", "SetClipHooks", "ConditioningSetPropertiesAndCombine"] : [])];
  },
  loads: regionLoads,
  /** The positive conditioning with every region's over its box. */
  apply(g, o, value) {
    let positive = o.positive;
    for (const r of regionsOf(value)) {
      const text = withQuality(o.quality, r.prompt.trim());
      const mask = boxMask(g, r.box, o.size);
      const loras = regionLoras(r);
      if (loras.length) {
        let hooks: Ref | null = null;
        for (const l of loras) hooks = g.out("CreateHookLora", { lora_name: l.file, strength_model: l.weight, strength_clip: l.weight, ...(hooks ? { prev_hooks: hooks } : {}) });
        const clip = g.out("SetClipHooks", { clip: o.clip, apply_to_conds: true, schedule_clip: false, hooks: hooks! });
        const cond = g.out("CLIPTextEncode", { text, clip });
        positive = g.out("ConditioningSetPropertiesAndCombine", { cond: positive, cond_NEW: cond, strength: 1, set_cond_area: "default", mask, hooks: hooks! });
      } else {
        const cond = g.out("CLIPTextEncode", { text, clip: o.clip });
        positive = g.out("ConditioningCombine", { conditioning_1: positive, conditioning_2: g.out("ConditioningSetMask", { conditioning: cond, mask, strength: 1, set_cond_area: "default" }) });
      }
    }
    return positive;
  },
} satisfies RegionWay<{ clip: Ref; positive: Ref; quality: string; size: { width: number; height: number } }, Ref>;
