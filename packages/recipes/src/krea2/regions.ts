import { regionPicture, regionsOf, roundTo, type GraphBuilder, type Ref, type RegionValue } from "@afflatus/core";
import { boxPixels, REGIONS, regionLoras } from "../shared/regions";

/**
 * Krea 2's regions with a person's picture in a box (card #271). The regional pack and the person reference do not sample
 * together: Krea2Edit's patch replaces Krea 2's forward with the person's picture prepended as tokens, so the pack's masks,
 * built for the text and the canvas alone, never meet a sequence of their length and are left off without a word; and the
 * pack refuses ComfyUI's own reference latents outright. So the picture is made with the boxes first, each person drawn from
 * their words and LoRA in their box; then each person's box is redrawn by Identity Edit V2 as it was trained, a person put
 * into a scene: the box's crop as the scene (pinned to the layout), the person's picture beside it, their box's words read
 * with both pictures. Two people are redrawn one after the other, each from their own picture, in their own box.
 */

/** Context around a person's box in the crop that is redrawn: a share of the box's size on each side, so their edges join. */
const CONTEXT = 0.15;
/** The crop is redrawn with its longest side at this: Identity Edit's own range for people (its pack's 1024 grounding). */
const CROP_PX = 1024;
/** The redrawn crop is pasted back with an edge this soft, as a share of its shorter side. */
const FEATHER = 0.06;

/** The regions with a person's picture: the boxes whose person is redrawn from it. */
export const pictured = (value: unknown): RegionValue[] => regionsOf(value).filter((r) => r.castPicture);

/** The nodes the person pass by box adds, beside the person reference's own (Krea2Edit's patch and grounded encode). */
export const PERSON_BOX_NODES = ["LoadImage", "ImageCrop", "ImageScale", "VAEEncode", "VAEDecode", "KSampler", "ConditioningZeroOut", "SolidMask", "FeatherMask", "ImageCompositeMasked", "LoraLoaderModelOnly", "Krea2EditModelPatch", "Krea2EditGroundedEncode"];

/** A box grown by its context, in pixels of a picture of this size, and the size it is redrawn at (on Krea 2's grid of 16). */
function personCrop(box: RegionValue["box"], size: { width: number; height: number }) {
  const p = boxPixels(box, size);
  const dx = Math.round(p.width * CONTEXT), dy = Math.round(p.height * CONTEXT);
  const x = Math.max(0, p.x - dx), y = Math.max(0, p.y - dy);
  const width = Math.min(size.width, p.x + p.width + dx) - x, height = Math.min(size.height, p.y + p.height + dy) - y;
  const k = CROP_PX / Math.max(width, height);
  return { x, y, width, height, drawn: { width: Math.max(256, roundTo(width * k, 16)), height: Math.max(256, roundTo(height * k, 16)) } };
}

interface PersonBoxPass {
  image: Ref;
  size: { width: number; height: number };
  /** The model as the pictures were sampled with (the form's LoRAs on), the Identity Edit LoRA and its weight. */
  model: Ref;
  identity: { file: string; weight: number };
  clip: Ref;
  vae: Ref;
  refBoost: number;
  denoise: number;
  steps: number;
  sampler: string;
  scheduler: string;
  seed: number;
  /** The model as one crop samples (its shift for the crop's size). */
  shifted: (model: Ref, size: { width: number; height: number }) => Ref;
  uploads: Record<string, string | undefined>;
}

/**
 * Each pictured box's person redrawn from their picture, box after box: the crop is encoded, sampled again by Krea 2 with
 * the Identity Edit LoRA and the box's own LoRAs (plainly, on the crop alone) at this denoise, and pasted back with a soft edge.
 */
export function personBoxes(g: GraphBuilder, people: readonly RegionValue[], o: PersonBoxPass): { image: Ref; passes: Array<{ node: string; steps: number; pixels: number }> } {
  let image = o.image;
  const passes: Array<{ node: string; steps: number; pixels: number }> = [];
  for (const r of people) {
    const upload = o.uploads[regionPicture(REGIONS, r)];
    if (!upload) continue;
    const c = personCrop(r.box, o.size);
    const scene = g.out("ImageScale", { image: g.out("ImageCrop", { image, width: c.width, height: c.height, x: c.x, y: c.y }), upscale_method: "lanczos", width: c.drawn.width, height: c.drawn.height, crop: "disabled" });
    const person = g.out("LoadImage", { image: upload });
    const latent = g.out("VAEEncode", { pixels: scene, vae: o.vae });
    let model = g.out("LoraLoaderModelOnly", { model: o.model, lora_name: o.identity.file, strength_model: o.identity.weight });
    for (const l of regionLoras(r)) model = g.out("LoraLoaderModelOnly", { model, lora_name: l.file, strength_model: l.weight });
    // the scene first and pinned onto the layout, the person last and beside it: Identity Edit V2's person-into-a-scene setup
    model = g.out("Krea2EditModelPatch", {
      model, source_latent: latent, ref_boost: o.refBoost, ref_boost_a: 1, fit_mode: "fit", vae: o.vae, source_image: scene, source_image_b: person,
      target_latent: latent, ref_position: "beside (right of target)", ref_position_a: "aligned (trained)",
    });
    const positive = g.out("Krea2EditGroundedEncode", { clip: o.clip, prompt: r.prompt.trim(), image: scene, image_b: person, grounding_px: CROP_PX, system_prompt: "" });
    const sampled = g.add("KSampler", {
      model: o.shifted(model, c.drawn), positive, negative: g.out("ConditioningZeroOut", { conditioning: positive }), latent_image: latent,
      seed: o.seed, steps: o.steps, cfg: 1, sampler_name: o.sampler, scheduler: o.scheduler, denoise: o.denoise,
    });
    // ComfyUI's KSampler runs all its steps at a denoise below 1, over the end of a longer schedule
    passes.push({ node: sampled, steps: o.steps, pixels: c.drawn.width * c.drawn.height });
    const back = g.out("ImageScale", { image: g.out("VAEDecode", { samples: [sampled, 0], vae: o.vae }), upscale_method: "lanczos", width: c.width, height: c.height, crop: "disabled" });
    const edge = Math.max(1, Math.round(Math.min(c.width, c.height) * FEATHER));
    const mask = g.out("FeatherMask", { mask: g.out("SolidMask", { value: 1, width: c.width, height: c.height }), left: c.x > 0 ? edge : 0, top: c.y > 0 ? edge : 0, right: c.x + c.width < o.size.width ? edge : 0, bottom: c.y + c.height < o.size.height ? edge : 0 });
    image = g.out("ImageCompositeMasked", { destination: image, source: back, x: c.x, y: c.y, resize_source: false, mask });
  }
  return { image, passes };
}
