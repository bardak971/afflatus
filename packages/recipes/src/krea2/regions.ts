import { regionPicture, regionsOf, roundTo, type GraphBuilder, type Ref, type RegionValue } from "@afflatus/core";
import { boxPixels, REGIONS, regionLoras } from "../shared/regions";

/**
 * Krea 2's regions with a person's picture in a box (card #271). The regional pack and the person reference do not sample
 * together: Krea2Edit's patch replaces Krea 2's forward with the person's picture prepended as tokens, so the pack's masks,
 * built for the text and the canvas alone, never meet a sequence of their length and are left off without a word; and the
 * pack refuses ComfyUI's own reference latents outright. So the picture is made with the boxes first, each person drawn from
 * their words and LoRA in their box; then each person's head is redrawn by Identity Edit V2 as it was trained, a person put
 * into a scene: the square around their face in their box as the scene (pinned to the layout), their picture beside it, their
 * box's words read with both pictures. Two people are redrawn one after the other, each from their own picture, in their box.
 */

/** The square around a face is redrawn at this side: Identity Edit's own range for people (its pack's 1024 grounding). */
const CROP_PX = 1024;
/**
 * The square around the largest face in a box, its side this many face heights (Afflatus's Face Area in a Box): the head and
 * shoulders, at about the scale of the person's picture below, whatever the shot. Their whole box redrawn from a close
 * picture drew them close: a full-body man became a selfie's head and chest pasted over him (a pod, 2026-11-05). The node
 * gives the head and shoulders' mask too, and only those go back: the rest of the box stays as the picture's one pass drew it.
 */
const AREA_SIDE = 3;
const FACE_AREA = "AfflatusFaceArea";
/**
 * The person's picture cut to a square around their face, this many face heights a side (Afflatus's Face Crop), and all but
 * their head and shoulders made a plain grey (Afflatus's Face Backdrop). Given the whole photo, Identity Edit at a denoise of
 * 0.9 and more redrew the photo's own setting into the box (a mirror selfie's salon in a park, on a pod, 2026-11-04); cut to
 * 3 face heights alone, a close selfie kept nearly all of itself, and the salon and the phone in hand still came (2026-11-05).
 */
const FACE_SIDE = 2;
const FACE_CROP = "AfflatusFaceCrop";
const FACE_BACKDROP = "AfflatusFaceBackdrop";

/**
 * Where Afflatus's node pack is older (before 0.49.8) or has no InsightFace: the whole box redrawn, a share of its size around
 * it read as context, never pasted back (on a pod, 2026-11-04, the crop pasted whole wrote one person's shirt print into the
 * next box), the box pasted back with an edge this soft, as a share of its shorter side.
 */
const CONTEXT = 0.15;
const FEATHER = 0.06;

/** The regions with a person's picture: the boxes whose person is redrawn from it. */
export const pictured = (value: unknown): RegionValue[] => regionsOf(value).filter((r) => r.castPicture);

/** The nodes the person pass by box adds, beside the person reference's own (Krea2Edit's patch and grounded encode). */
export const PERSON_BOX_NODES = ["LoadImage", "ImageScale", "VAEEncode", "VAEDecode", "KSampler", "ConditioningZeroOut", "ImageCompositeMasked", "LoraLoaderModelOnly", "Krea2EditModelPatch", "Krea2EditGroundedEncode"];
/**
 * Afflatus's own nodes the pass uses when the ComfyUI has them (afflatus-nodes with InsightFace), and ComfyUI's own the whole
 * box is cut and pasted back with where they are not.
 */
export const PERSON_BOX_OPTIONAL = [FACE_AREA, FACE_CROP, FACE_BACKDROP, "ImageCrop", "SolidMask", "MaskComposite", "FeatherMask"];

/** A box grown by its context, in pixels of a picture of this size, and the size it is redrawn at (on Krea 2's grid of 16). */
function personCrop(box: RegionValue["box"], size: { width: number; height: number }) {
  const p = boxPixels(box, size);
  const dx = Math.round(p.width * CONTEXT), dy = Math.round(p.height * CONTEXT);
  const x = Math.max(0, p.x - dx), y = Math.max(0, p.y - dy);
  const width = Math.min(size.width, p.x + p.width + dx) - x, height = Math.min(size.height, p.y + p.height + dy) - y;
  const k = CROP_PX / Math.max(width, height);
  return { x, y, width, height, box: p, drawn: { width: Math.max(256, roundTo(width * k, 16)), height: Math.max(256, roundTo(height * k, 16)) } };
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
  /** Whether this ComfyUI has a node type (BuildContext.has). */
  has: (node: string) => boolean;
}

/** Where a crop is taken and put back: the scene redrawn, the size it is drawn at, and how it is pasted. */
interface Area {
  scene: Ref;
  drawn: { width: number; height: number };
  paste: (redrawn: Ref) => Ref;
}

/**
 * Each pictured box's person redrawn from their picture, box after box: the square around their face (the whole box on an
 * older node pack) is encoded, sampled again by Krea 2 with the Identity Edit LoRA and the box's own LoRAs (plainly, on the
 * crop alone) at this denoise, and their head and shoulders pasted back (the box, with a soft edge, on an older pack).
 */
export function personBoxes(g: GraphBuilder, people: readonly RegionValue[], o: PersonBoxPass): { image: Ref; passes: Array<{ node: string; steps: number; pixels: number }>; warnings: string[] } {
  let image = o.image;
  const passes: Array<{ node: string; steps: number; pixels: number }> = [];
  // the three come with afflatus-nodes' InsightFace, Face Area from 0.49.8 on
  const cut = o.has(FACE_CROP) && o.has(FACE_BACKDROP);
  const headed = cut && o.has(FACE_AREA);
  const warnings = headed || !people.length ? [] : [
    cut
      ? "The people's whole boxes were redrawn, not their heads: this ComfyUI's Afflatus node pack is older than 0.49.8 (no Face Area in a Box), and a person far off may come back drawn close."
      : "The people's whole boxes were redrawn from their whole pictures: this ComfyUI lacks Afflatus's face nodes (its node pack, with insightface), and the photo's own setting may show in their box.",
  ];
  for (const r of people) {
    const upload = o.uploads[regionPicture(REGIONS, r)];
    if (!upload) continue;
    const area = headed ? headArea(g, image, r, o) : boxArea(g, image, r, o);
    const photo = g.out("LoadImage", { image: upload });
    const person = cut ? g.out(FACE_BACKDROP, { image: g.out(FACE_CROP, { image: photo, factor: FACE_SIDE }), backdrop: "grey" }) : photo;
    const latent = g.out("VAEEncode", { pixels: area.scene, vae: o.vae });
    let model = g.out("LoraLoaderModelOnly", { model: o.model, lora_name: o.identity.file, strength_model: o.identity.weight });
    for (const l of regionLoras(r)) model = g.out("LoraLoaderModelOnly", { model, lora_name: l.file, strength_model: l.weight });
    // the scene first and pinned onto the layout, the person last and beside it: Identity Edit V2's person-into-a-scene setup
    model = g.out("Krea2EditModelPatch", {
      model, source_latent: latent, ref_boost: o.refBoost, ref_boost_a: 1, fit_mode: "fit", vae: o.vae, source_image: area.scene, source_image_b: person,
      target_latent: latent, ref_position: "beside (right of target)", ref_position_a: "aligned (trained)",
    });
    const positive = g.out("Krea2EditGroundedEncode", { clip: o.clip, prompt: r.prompt.trim(), image: area.scene, image_b: person, grounding_px: CROP_PX, system_prompt: "" });
    const sampled = g.add("KSampler", {
      model: o.shifted(model, area.drawn), positive, negative: g.out("ConditioningZeroOut", { conditioning: positive }), latent_image: latent,
      seed: o.seed, steps: o.steps, cfg: 1, sampler_name: o.sampler, scheduler: o.scheduler, denoise: o.denoise,
    });
    // ComfyUI's KSampler runs all its steps at a denoise below 1, over the end of a longer schedule
    passes.push({ node: sampled, steps: o.steps, pixels: area.drawn.width * area.drawn.height });
    image = area.paste(g.out("VAEDecode", { samples: [sampled, 0], vae: o.vae }));
  }
  return { image, passes, warnings };
}

/**
 * The square around the largest face in the box, at CROP_PX, and its head and shoulders pasted back where the square lies
 * (the node's place and side, linked): nothing goes back from a box with no face found.
 */
function headArea(g: GraphBuilder, image: Ref, r: RegionValue, o: PersonBoxPass): Area {
  const p = boxPixels(r.box, o.size);
  const area = g.add(FACE_AREA, { image, x: p.x, y: p.y, width: p.width, height: p.height, factor: AREA_SIDE, size: CROP_PX });
  return {
    scene: [area, 0],
    drawn: { width: CROP_PX, height: CROP_PX },
    paste: (redrawn) => g.out("ImageCompositeMasked", {
      destination: image, source: g.out("ImageScale", { image: redrawn, upscale_method: "lanczos", width: [area, 4], height: [area, 4], crop: "disabled" }),
      x: [area, 2], y: [area, 3], resize_source: false, mask: [area, 1],
    }),
  };
}

/** The whole box with its context around it, and the box alone pasted back with its edge softened inside it. */
function boxArea(g: GraphBuilder, image: Ref, r: RegionValue, o: PersonBoxPass): Area {
  const c = personCrop(r.box, o.size);
  const scene = g.out("ImageScale", { image: g.out("ImageCrop", { image, width: c.width, height: c.height, x: c.x, y: c.y }), upscale_method: "lanczos", width: c.drawn.width, height: c.drawn.height, crop: "disabled" });
  const b = c.box;
  const edge = Math.max(1, Math.round(Math.min(b.width, b.height) * FEATHER));
  // none at the picture's own edge
  const inBox = g.out("FeatherMask", {
    mask: g.out("SolidMask", { value: 1, width: b.width, height: b.height }),
    left: b.x > 0 ? edge : 0, top: b.y > 0 ? edge : 0, right: b.x + b.width < o.size.width ? edge : 0, bottom: b.y + b.height < o.size.height ? edge : 0,
  });
  const mask = g.out("MaskComposite", { destination: g.out("SolidMask", { value: 0, width: c.width, height: c.height }), source: inBox, x: b.x - c.x, y: b.y - c.y, operation: "add" });
  return {
    scene,
    drawn: c.drawn,
    paste: (redrawn) => g.out("ImageCompositeMasked", {
      destination: image, source: g.out("ImageScale", { image: redrawn, upscale_method: "lanczos", width: c.width, height: c.height, crop: "disabled" }),
      x: c.x, y: c.y, resize_source: false, mask,
    }),
  };
}
