import { beyondPack, type BuildContext, defineRecipe, GraphBuilder, packCommit, regionPicture, regionsOf, roundTo, type ReferenceValue, type Ref, type RegionValue, type SizeValue } from "@afflatus/core";
import { dropsFor, noReferences, pictureForm } from "../shared/pictureForm";
import { HIRES_PASS_INPUTS, hiresPass, UPSCALER_PREFER, type HiresPass } from "../sdxl/common";
import type { FlowBase } from "../flow/kit";
import { flowFixFace } from "../flow/fix-face";
import { flowPaintOver } from "../flow/paint-over";
import { flowOutpaint } from "../flow/outpaint";
import { flowRedraw } from "../flow/redraw";
import { flowSharper } from "../flow/sharper";
import { DETAIL_INPUTS, DETAIL_OPTIONAL, detailNodes, fullPassNodes, withoutDaemon, type DetailSettings } from "../shared/detail";
import { redrawInTiles, tileInputs, tileNodes, tilePass, inTiles, type TileSettings } from "../shared/tiles";
import { krea2Kit, krea2Spec } from "./common";
import { addedLora, putAdded } from "../shared/model";
import { addedInputs, withRow, type AddedSpec } from "../shared/addedRows";
import { FACE_PASS_INPUTS, FACE_PASS_NODES, FACE_PASS_OPTIONAL, FACE_PASS_SLOTS, facePass, SMALL_FACE_PX, type FacePassValues } from "../klein/facePass";
import { adetail, ADETAIL_OPTIONAL, adetailInputs, adetailNeeds, adetailOn, ALL_DETAIL, DETECTOR_FILES, sized, type AdetailSettings } from "../shared/adetail";
import { facesIn, krea2Layout, krea2RegionNodes, krea2Regions, REGION_FACE_NODES, REGIONS, regionLoads, regionsInput } from "../shared/regions";
import { pictured, PERSON_BOX_NODES, PERSON_BOX_OPTIONAL, personBoxes } from "./regions";

const files = krea2Spec.files;
const withStyle = { ...files, styleRef: "krea2_style_reference.safetensors" };
const withPerson = { ...files, identityEdit: "krea2_identity_edit_v2_r128.safetensors" };
const withFaceRefine = { ...withPerson, kleinUnet: "flux-2-klein-base-4b.safetensors", kleinClip: "qwen_3_4b.safetensors", kleinVae: "flux2-vae.safetensors", faceDetector: "bbox/face_yolov8m.pt" };
/** About the area Krea 2 draws at, and the size a hires pass enlarges to. */
const KREA2_AREA = 1.1 * 1024 * 1024;
const krea2Large = (input: { size: SizeValue; hiresScale: number }) => ({ width: roundTo(roundTo(input.size.width, 16) * input.hiresScale, 16), height: roundTo(roundTo(input.size.height, 16) * input.hiresScale, 16) });

// ---------------------------------------------------------------- txt2img

interface Krea2Picture extends FlowBase, HiresPass, DetailSettings, TileSettings, FacePassValues, AdetailSettings {
  prompt: string;
  /** The person's picture (a cast person's first, or one of the user's): who is in the picture. */
  person: ReferenceValue[];
  /** Krea2Edit's ref_boost: how hard the picture pulls toward the person's. */
  refBoost: number;
  /** The Identity Edit LoRA picked in its row of the LoRA list (empty: the slot's), and its weight. */
  identityLora?: string;
  identityStrength: number;
  references: ReferenceValue[];
  referenceStrength: number;
  /** The style-reference LoRA picked in its row of the LoRA list (empty: the slot's). */
  styleLora?: string;
  size: SizeValue;
  /** Boxes on the Stage, each with its words, a cast person (their words, LoRA and picture) and a LoRA (card #271). */
  regions: RegionValue[];
  /** How much a pictured box's person is redrawn from their picture by Identity Edit (0: not redrawn). */
  regionPersonDenoise: number;
  hires: boolean;
  hiresScale: number;
  hiresUpscaler: string;
  hiresDenoise: number;
  hiresSteps: number;
}

/** The style-reference LoRA was trained on one or two pictures: how many reference images the text encoder is shown. */
const STYLE_IMAGES = 2;

/** The style-reference LoRA, a row of the LoRA list while there are reference images (card #160): no way to remove it, at 0 not loaded. */
const STYLE_ROW: AddedSpec = {
  label: "Needed by this model",
  note: "Krea 2's style-reference LoRA: with reference images, it is what makes the picture follow their style (ComfyUI's image style reference template). At 0 it is not loaded, and the images are read with the prompt alone. Its file is the one of Settings › Models unless another is picked",
  file: { id: "styleLora", label: "Style reference LoRA", slot: "styleRef", match: ["krea.?2.*style.?ref"], note: "the style-reference LoRA. Left as it is, the one of Settings › Models" },
  weight: { id: "referenceStrength", own: true },
  showWhen: "references",
  when: { input: "references", filled: true },
};

/**
 * The person reference (card #219), as the pod test made it (card #217): conradlocke's Identity Edit V2 LoRA on Turbo and its
 * node pack's patch, the person's picture read beside the canvas (not pinned onto its layout: they can be put anywhere in
 * it), the prompt read with the picture at 1024 px, the reference pulled at twice its weight. Likeness 0.66 against a real
 * photo's 0.81 (ArcFace, photos of the person not sent), 0.70 on mid shots, 0.50 full body. The picture is used as it is:
 * no crop to the face (on mid shots a crop changed nothing; a raw photo lost two close-ups of three, where the photo's
 * hands and phone near the face were the trouble, which is the user's choice of photo).
 */
const PERSON_ROW: AddedSpec = {
  label: "Needed by this model",
  note: "Krea 2's Identity Edit V2 LoRA (conradlocke's): with a person reference, it is what keeps the person of the picture. At 0 it is not loaded. Its file is the one of Settings › Models unless another is picked",
  file: { id: "identityLora", label: "Identity Edit LoRA", slot: "identityEdit", match: ["krea.?2.?identity.?edit"], note: "the Identity Edit V2 LoRA. Left as it is, the one of Settings › Models" },
  weight: { id: "identityStrength", label: "Identity strength", note: "the weight of the Identity Edit LoRA. At 0 it is not loaded", default: 1 },
  // with a person reference, or a cast person in a box redrawn from their picture (regions); its inputs are drawn in the row
  // alone, which this says when it is
  when: { any: [{ input: "person", filled: true }, { all: [{ input: REGIONS, field: "cast", filled: true }, { not: { input: "regionPersonDenoise", is: 0 } }] }] },
};
/** Where the person's picture sits for Krea2Edit (2.0 on): beside the canvas; the first of two pictures (a scene) as trained. */
const BESIDE = "beside (right of target)";
const ALIGNED = "aligned (trained)";
/** The longest side of the person's picture as the text encoder reads it with the prompt: 1024 for people, as tested. */
const GROUNDING_PX = 1024;
/**
 * With a person reference, a face is theirs: Detail: face is Face refine's pass, redrawn by FLUX.2 Klein from their picture
 * (klein/facePass.ts), not the generic one by Krea 2 from the prompt, which would draw someone else's.
 */
const PERSON_FACE = `With a person reference, the face is redrawn from their picture instead (Face refine's FLUX.2 Klein pass, faces under ${SMALL_FACE_PX} px)`;
/** Whether the person's face is redrawn by Face refine's pass: with a person reference, Face refine or Detail: face on. */
const personFace = (input: Pick<Krea2Picture, "person" | "faceRefine" | "detailFace">) => Boolean(input.person?.length) && (input.faceRefine || input.detailFace);

/**
 * With regions, a person is drawn in their box: from their words and LoRA in the picture's one pass, then from their picture
 * by Identity Edit over their box (krea2/regions.ts). Neither reference of the form's own samples with the boxes: both bring
 * pictures in as tokens of their own (Krea2Edit's patch, ComfyUI's reference latents), which the pack's masks do not cover.
 */
const REGIONS_ALONE = "Krea 2 takes regions without the form's person reference or style reference images (both read pictures in a way the regional pack's masks do not cover): cast each person into their box instead, or remove the boxes.";
/** Whether a pictured box's face is redrawn from their picture: Detail: face on (Face refine's toggle is the form's person reference's). */
const boxFace = (input: Pick<Krea2Picture, "regions" | "detailFace">) => input.detailFace && pictured(input.regions).length > 0;

/** Why Krea 2 refuses a person reference with style reference images. */
const NOT_BOTH = "Krea 2 takes a person reference or style reference images, not both (the two LoRAs and the two ways of reading pictures were not made to work together): remove one of them.";

/**
 * A picture from a prompt, the way ComfyUI's own Krea 2 Turbo template makes it. With reference images
 * it follows their style: the images are read next to the prompt and the style-reference LoRA is put
 * on the model (ComfyUI's "image style reference" template). With a person's picture it keeps that person
 * (PERSON_ROW), and Face refine redraws their face when it is a small one. Hires fix is the usual upscale and
 * second pass, at the model's own shift (see krea2Spec).
 */
export const krea2Picture = pictureForm("txt2img", defineRecipe<Krea2Picture>({
  id: "krea2.text-to-picture",
  family: "krea2",
  version: 1,
  title: "txt2img",
  summary: "Text to image, from a natural-language prompt, with optional hires fix. With reference images, it follows their style; with a person's picture, it keeps that person.",
  output: "image",
  inputs: withRow(withRow([
    krea2Spec.model,
    { id: "prompt", type: "prompt", label: "Prompt", style: "sentences", placeholder: krea2Spec.placeholder },
    {
      // the first of the form's references: a cast person's pictures go there (the server's compose fills the first), their first one
      id: "person", type: "references", label: "Reference image of the person", max: 1, roles: ["person"],
      note: "who is in the picture, kept from their photo (a cast person's first picture). Needs the Identity Edit V2 LoRA and the comfyui-krea2edit node pack 2.0 on. Not with style reference images",
    },
    { id: "refBoost", type: "number", label: "Reference boost", note: "Krea2Edit's ref_boost: how hard the picture pulls toward the person's photo. 1 is off; 2 is what Afflatus's test measured", min: 1, max: 4, step: 0.1, default: 2, showWhen: "person", advanced: true },
    ...FACE_PASS_INPUTS,
    {
      id: "references", type: "references", label: "Reference images", max: STYLE_IMAGES, roles: ["style"],
      note: "the look to follow (a drawing style, a colour mood, a kind of photo), not who is in it. Needs the style-reference LoRA. Not with a person reference",
    },
    // (drawn as the weight of the style-reference LoRA's row in the LoRA list, card #160)
    { id: "referenceStrength", type: "number", label: "Reference strength", note: "the weight of the style-reference LoRA. At 0 it is not loaded", min: 0, max: 1.5, step: 0.05, default: 1, showWhen: "references", advanced: true, inList: "loras" },
    { id: "size", type: "size", label: "Size", default: "tall", grid: 16, min: 256, max: 2048, perModel: true, shapes: krea2Spec.shapes },
    regionsInput({
      lora: "scoped", picture: true,
      how: "Every box is drawn in the one pass (the ComfyUI-Krea2-Regional node pack): its words are read by its part of the picture alone, beside the prompt with where each box lies. A cast person's box is then redrawn from their picture by the Identity Edit V2 LoRA, box after box. Not with the person reference or style reference images above.",
      face: "With Detail: face on, each cast person's face found in their box is redrawn by FLUX.2 Klein from their picture (faces under 150 px, as Face refine)",
    }),
    {
      // on a pod (2026-11-04, Fabien and Nicolas): 0.6 kept the faces the words drew, 0.8 took one of the two people, 0.9 and
      // 1 took both (and the photo's own setting, until the picture was cut to the head and shoulders)
      id: "regionPersonDenoise", type: "number", label: "Person pass denoise", min: 0, max: 1, step: 0.05, default: 0.9, showWhen: REGIONS, advanced: true,
      note: "how much a cast person's box is redrawn from their picture by Identity Edit, after the picture. 0 leaves each person as the boxes drew them, from their words and LoRA; below 0.9 the face hardly changed in Afflatus's test",
    },
    ...adetailInputs("sentences", PERSON_FACE),
    ...DETAIL_INPUTS,
    ...krea2Kit.inputs.slice(0, -1),
    { id: "hires", type: "toggle", label: "Hires fix", note: "upscale, then a second pass over the larger picture", default: false, advanced: true, perModel: true },
    { id: "hiresScale", type: "number", label: "Upscale by", note: "past 2×, the second pass is redrawn in tiles (see Redraw)", min: 1.1, max: 4, step: 0.05, default: krea2Spec.hires!.scale!, unit: "×", showWhen: "hires", advanced: true, perModel: true },
    {
      id: "hiresUpscaler", type: "choice", label: "Upscaler", note: "from your upscale models", showWhen: "hires", advanced: true, perModel: true,
      options: { node: "UpscaleModelLoader", input: "model_name" }, default: "RealESRGAN_x4plus.pth", prefer: UPSCALER_PREFER,
    },
    { id: "hiresDenoise", type: "number", label: "Denoising strength", note: `how much the second pass may redraw; ${krea2Kit.noiseWords(krea2Spec.hires!.denoise!, krea2Spec.hires!.steps!, [{ size: { width: 1024, height: 1024 }, where: "at every size" }])}`, min: 0.05, max: 0.9, step: 0.05, default: krea2Spec.hires!.denoise!, showWhen: "hires", advanced: true, perModel: true },
    { id: "hiresSteps", type: "number", label: "Hires steps", min: 1, max: 60, step: 1, default: krea2Spec.hires!.steps!, showWhen: "hires", advanced: true, perModel: true },
    ...HIRES_PASS_INPUTS,
    ...tileInputs("hires"),
    ...addedInputs(STYLE_ROW),
    ...addedInputs(PERSON_ROW),
    krea2Kit.inputs.at(-1)!,
  ], STYLE_ROW), PERSON_ROW),
  presets: krea2Spec.presets!,
  // refused before it is queued, and said by the form (build() still throws it for a job queued before)
  refuses: [
    { when: { all: [{ input: "person", filled: true }, { input: "references", filled: true }] }, why: NOT_BOTH },
    { when: { all: [{ input: REGIONS, filled: true }, { any: [{ input: "person", filled: true }, { input: "references", filled: true }] }] }, why: REGIONS_ALONE },
  ],
  optionalNodes: [...new Set([...DETAIL_OPTIONAL, ...FACE_PASS_OPTIONAL, ...ADETAIL_OPTIONAL, ...REGION_FACE_NODES, ...PERSON_BOX_OPTIONAL])],
  layoutOf: (input) => (regionsOf(input.regions).length ? krea2Layout(input.prompt, regionsOf(input.regions)) : null),
  // a person reference asks for its LoRA (unless one is picked in its row) and, with Face refine on, Klein's files and the
  // face detector: a pod is sent them; a machine of the user's own makes the picture without the pass rather than wait.
  // Style reference images ask for theirs the same way, which the build refuses them without: a pod was never sent it, and
  // the job was refused there once its boot was paid (card #226). The Detail rows ask for their detectors
  needsWith(input, slots, where) {
    const person = Boolean(input.person?.length);
    const detail = adetailNeeds(input, slots, where, { Face: person || boxFace(input) });
    // a cast person's box redrawn from their picture asks for the Identity Edit LoRA, and Detail: face for Klein's files
    const boxes = pictured(input.regions).length && input.regionPersonDenoise > 0 ? (input.identityLora ? [] : ["identityEdit"]) : [];
    const faces = boxFace(input) ? FACE_PASS_SLOTS.filter((id) => !where?.own || slots?.[id]) : [];
    if (boxes.length || faces.length) return [...new Set([...boxes, ...faces, ...detail])];
    if (input.references?.length && !person) return [...(input.styleLora ? [] : ["styleRef"]), ...detail];
    if (!person) return detail;
    const face = personFace(input) ? FACE_PASS_SLOTS.filter((id) => !where?.own || slots?.[id]) : [];
    return [...new Set([...(input.identityLora ? [] : ["identityEdit"]), ...face, ...detail])];
  },
  nodes: (input) => [
    ...detailNodes(input),
    ...fullPassNodes(input, input.steps), ...(input.hires ? ["KSampler"] : []),
    ...tileNodes(input.hires && inTiles(input, krea2Large(input), KREA2_AREA)),
    ...krea2Kit.loadNodes(input).filter((n) => n !== "KSampler" && (n !== "CLIPTextEncode" || !(input.references.length || input.person.length) || input.negative.trim())), "EmptyLatentImage",
    ...(input.references.length ? ["LoadImage", "TextEncodeQwenImageEditPlus", "FluxKontextMultiReferenceLatentMethod", "LoraLoaderModelOnly", ...(input.shift > 0 ? [] : ["ModelSamplingFlux"])] : []),
    ...(input.person.length ? ["LoadImage", "VAEEncode", "LoraLoaderModelOnly", "Krea2EditModelPatch", "Krea2EditGroundedEncode"] : []),
    // a hires fix in tiles redraws them from the prompt alone (see build)
    ...(input.person.length && input.hires && inTiles(input, krea2Large(input), KREA2_AREA) ? ["CLIPTextEncode"] : []),
    ...(personFace(input) ? FACE_PASS_NODES : []),
    ...krea2RegionNodes(input.regions),
    ...(pictured(input.regions).length && input.regionPersonDenoise > 0 ? PERSON_BOX_NODES : []),
    ...(boxFace(input) ? FACE_PASS_NODES : []),
    // the Detail passes read the prompt alone, which a reference's texts do not hold
    ...((input.references.length || input.person.length) && adetailOn(input, { Face: input.person.length > 0 }) ? ["CLIPTextEncode"] : []),
    ...(input.hires ? ["UpscaleModelLoader", "ImageUpscaleWithModel", "ImageScale", "VAEEncode"] : []),
  ],
  build(input, ctx) {
    const { load, shifted, condFrom, cond: condOf, sample } = krea2Kit;
    const g = new GraphBuilder();
    const styled = input.references.length > 0;
    const person = input.person.length > 0;
    if (styled && person) throw new Error(NOT_BOTH);
    const regioned = regionsOf(input.regions).length > 0;
    if (regioned && (styled || person)) throw new Error(REGIONS_ALONE);
    // the LoRA a reference needs, as its row of the LoRA list has it: its file and weight, the same file by hand put on once,
    // after the user's (card #160)
    const added = styled ? addedLora(ctx.slots.styleRef, input.styleLora, input.referenceStrength, input.loras)
      : person ? addedLora(ctx.slots.identityEdit, input.identityLora, input.identityStrength, input.loras)
      : { lora: null, put: false, loras: input.loras };
    const k = load(g, { ...input, loras: added.loras }, ctx);
    const W = roundTo(input.size.width, 16);
    const H = roundTo(input.size.height, 16);
    if (styled && !added.lora) {
      throw new Error("Style reference images need Krea 2's style-reference LoRA: put krea2_style_reference.safetensors in ComfyUI's models/loras folder (it can be downloaded from Settings).");
    }
    if (person && !added.lora) {
      throw new Error("A person reference needs Krea 2's Identity Edit V2 LoRA: put krea2_identity_edit_v2_r128.safetensors in ComfyUI's models/loras folder (it can be downloaded from Settings).");
    }
    // Krea2Edit before 2.0 has the patch but no say in where the picture sits: sent ref_position, it ignores it and pins the
    // person onto the layout, which is not what was measured. Installing it again would not help: it is updated by hand
    const takes = person ? ctx.inputs?.("Krea2EditModelPatch") : null;
    if (takes && !takes.includes("ref_position")) {
      throw beyondPack(`This ComfyUI's comfyui-krea2edit is older than 2.0, which the person reference is made for (the Comfy Registry has 1.2.3 only): in ComfyUI's folder, git -C custom_nodes/comfyui-krea2edit fetch, then git -C custom_nodes/comfyui-krea2edit checkout ${packCommit("comfyui-krea2edit")} (the commit Afflatus is built against), then restart ComfyUI.`);
    }
    const plain = k.model;
    let model = putAdded(g, plain, added);
    // the shift typed in, else the model's own; with reference images, the one that follows the size, as ComfyUI's
    // style-reference template sets it
    const styledAt = (m: Ref, width: number, height: number) =>
      input.shift > 0 ? shifted(g, m, input, { width, height }) : g.out("ModelSamplingFlux", { model: m, max_shift: 1.15, base_shift: 0.5, width, height });
    const empty = g.out("EmptyLatentImage", { width: W, height: H, batch_size: 1 });
    let positive: Ref;
    if (styled) {
      const images = Object.fromEntries(input.references.slice(0, STYLE_IMAGES).map((_, i) => [`image${i + 1}`, g.out("LoadImage", { image: ctx.uploads[`references.${i}`] })]));
      const read = g.out("TextEncodeQwenImageEditPlus", { clip: k.clip, vae: k.vae, prompt: input.prompt, ...images });
      positive = g.out("FluxKontextMultiReferenceLatentMethod", { conditioning: read, reference_latents_method: "index_timestep_zero" });
    } else if (person) {
      // the patch reads the picture in pixels and fits it to the canvas it samples (each pass's own size, a hires fix's too);
      // given the canvas's latent, it encodes it before sampling rather than in the middle of it
      const picture = g.out("LoadImage", { image: ctx.uploads["person.0"] });
      model = g.out("Krea2EditModelPatch", {
        model, source_latent: g.out("VAEEncode", { pixels: picture, vae: k.vae }), ref_boost: input.refBoost, ref_boost_a: 1, fit_mode: "fit",
        vae: k.vae, source_image: picture, target_latent: empty, ref_position: BESIDE, ref_position_a: ALIGNED,
      });
      positive = g.out("Krea2EditGroundedEncode", { clip: k.clip, prompt: input.prompt, image: picture, grounding_px: GROUNDING_PX, system_prompt: "" });
    } else if (regioned) {
      // every box in the one pass: the pack's patch on the model, its text the base's and each box's joined
      const r = krea2Regions(g, { model, clip: k.clip, prompt: input.prompt, size: { width: W, height: H } }, input.regions);
      model = r.model;
      positive = r.positive;
    } else {
      positive = g.out("CLIPTextEncode", { text: input.prompt, clip: k.clip });
    }
    const cond = condFrom(g, k, input, positive);

    g.phase("sampling");
    const detail = { input, ctx };
    const first = sample(g, k, input, styled ? styledAt(model, W, H) : shifted(g, model, input, { width: W, height: H }), cond, empty, ctx.seed, {}, detail);
    let latent = first.latent;
    const passes: Array<{ node: string; steps: number; pixels?: number }> = [first.pass];
    const loads = [...k.loads, ...(added.put ? [`loras/${added.lora!.file}`] : []), ...regionLoads(input.regions)];

    let image: Ref | null = null;
    if (input.hires) {
      const { width: W2, height: H2 } = krea2Large(input);
      g.phase("upscaling");
      // upscale models enlarge by their own factor (usually 4×): the result is scaled to the size asked for
      const pixels = g.out("VAEDecode", { samples: latent, vae: k.vae });
      const big = g.out("ImageUpscaleWithModel", { upscale_model: g.out("UpscaleModelLoader", { model_name: input.hiresUpscaler }), image: pixels });
      const scaled = g.out("ImageScale", { image: big, upscale_method: "lanczos", width: W2, height: H2, crop: "disabled" });
      g.phase("refining");
      const pass = { steps: input.hiresSteps, denoise: input.hiresDenoise, ...hiresPass(input) };
      if (inTiles(input, { width: W2, height: H2 }, KREA2_AREA)) {
        // the patch fits the person's picture to each tile it samples, and a tile of a wall would be pulled toward them: the
        // tiles are redrawn by the model and the prompt alone (a light pass over a person already there). The regions' masks
        // are the whole picture's, which a tile is not: the same
        const tileModel = person || regioned ? plain : model;
        const tileCond = person || regioned ? condOf(g, k, input, input.prompt) : cond;
        image = redrawInTiles(g, ctx, scaled, k.vae, { width: W2, height: H2 }, input, (l, _tiles, tile) => {
          const second = sample(g, k, input, shifted(g, tileModel, input, { width: tile, height: tile }), tileCond, l, ctx.seed, pass, detail);
          passes.push(tilePass(second.pass, { width: W2, height: H2 }, input));
          return second.latent;
        });
        // each pass at its own size: the first at the picture's first, the tiles at a tile's
        passes[0] = { ...passes[0]!, pixels: W * H };
      } else {
        const second = sample(g, k, input, shifted(g, model, input, { width: W2, height: H2 }), cond, g.out("VAEEncode", { pixels: scaled, vae: k.vae }), ctx.seed, pass, detail);
        latent = second.latent;
        passes.push(second.pass);
      }
      loads.push(`upscale_models/${input.hiresUpscaler}`);
    }

    g.phase("decoding");
    const scale = input.hires ? input.hiresScale : 1;
    // the Detail rows: people and hands redrawn by Krea 2 from the prompt (the user's LoRAs on, not a reference's), each crop
    // at the size it draws best; a face too when there is no person, whose face is theirs (below)
    const d = adetail(g, ctx, input, image ?? g.out("VAEDecode", { samples: latent, vae: k.vae }), {
      model: () => shifted(g, plain, input, { width: 1024, height: 1024 }), clip: k.clip, vae: k.vae,
      cond: (text) => (!text && !styled && !person ? cond : condOf(g, k, input, text ?? input.prompt)),
      steps: k.steps, cfg: k.cfg, sampler: input.sampler, scheduler: input.scheduler, seed: ctx.seed, scale, skip: { Face: person || boxFace(input) },
    });
    let result = d.image;
    // each cast person's box redrawn from their picture by Identity Edit, then their face by Klein's pass in their box alone
    const boxes = regioned
      ? personBoxed(g, ctx, input, result, { size: input.hires ? krea2Large(input) : { width: W, height: H }, scale }, { model: plain, clip: k.clip, vae: k.vae, steps: k.steps, shifted: (m, size) => shifted(g, m, input, size) })
      : null;
    if (boxes) {
      result = boxes.image;
      loads.push(...boxes.loads);
    }
    // Face refine (or Detail: face): the person's face redrawn from their picture when it is a small one, read at the size it
    // was drawn at
    const face = person ? facePass(g, ctx, { ...input, faceRefine: personFace(input) }, result, { pictures: [ctx.uploads["person.0"]!], scale }) : null;
    const after = [...d.passes, ...(boxes?.passes ?? []), ...(face?.pass ? [face.pass] : [])];
    if (face?.pass) {
      result = face.image;
      loads.push(...face.loads);
    }
    const all = after.length ? [...sized(passes, [W * H, krea2Large(input).width * krea2Large(input).height]), ...after] : passes;
    const warnings = [...d.warnings, ...(boxes?.warnings ?? []), ...(face?.said ? [face.said] : [])];
    const out = g.add("PreviewImage", { images: result });
    return {
      graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: all.reduce((n, p) => n + p.steps, 0), passes: all, loads: [...loads, ...d.loads],
      ...(warnings.length ? { warnings } : {}),
    };
  },
  variants: [
    { name: "from words, as ComfyUI's template", input: { prompt: "a" }, slots: files },
    {
      name: "a fine-tune with its own shift, a LoRA, a negative prompt and hires fix",
      input: { prompt: "a", model: "Krea2\\someone_krea2_v1.safetensors", shift: 4, cfg: 3, steps: 25, negative: "blurry", loras: [{ file: "l.safetensors", weight: 0.8 }], hires: true, hiresUpscaler: "u.pth", size: { width: 1152, height: 1536 } },
      slots: files,
    },
    { name: "hires fix at the model's own shift", input: { prompt: "a", hires: true, hiresUpscaler: "u.pth" }, slots: files },
    { name: "detail boost, hires fix 3× in tiles", input: { prompt: "a", detail: true, hires: true, hiresScale: 3, hiresUpscaler: "u.pth" }, slots: files, has: withoutDaemon },
    {
      name: "the style of two reference images",
      input: { prompt: "a", references: [{ asset: "a", role: "style" }, { asset: "b", role: "style" }] },
      slots: withStyle, uploads: { "references.0": "a.png", "references.1": "b.png" },
    },
    {
      name: "a style reference with a negative prompt, a shift and hires fix",
      input: { prompt: "a", references: [{ asset: "a", role: "style" }], negative: "blurry", cfg: 2, shift: 3, hires: true, hiresUpscaler: "u.pth", referenceStrength: 0.8 },
      slots: withStyle, uploads: { "references.0": "a.png" },
    },
    {
      name: "a person reference, Face refine on its small face",
      input: { prompt: "a", person: [{ asset: "p", role: "person" }] },
      slots: withFaceRefine, uploads: { "person.0": "p.png" },
    },
    { name: "Detail: face, hands and person", input: { prompt: "a", ...ALL_DETAIL }, slots: { ...files, ...DETECTOR_FILES } },
    {
      name: "Detail on a style reference, its face with words of its own",
      input: { prompt: "a", references: [{ asset: "a", role: "style" }], ...ALL_DETAIL },
      slots: { ...withStyle, ...DETECTOR_FILES }, uploads: { "references.0": "a.png" },
    },
    {
      name: "a person reference, Face refine off, Detail: face and hands on: the face from their picture",
      input: { prompt: "a", person: [{ asset: "p", role: "person" }], faceRefine: false, detailFace: true, detailHands: true },
      slots: { ...withFaceRefine, ...DETECTOR_FILES }, uploads: { "person.0": "p.png" },
    },
    {
      name: "two regions, left and right",
      input: { prompt: "a", regions: [{ id: "r1", box: { x: 0, y: 0.1, w: 0.5, h: 0.9 }, prompt: "a red armchair" }, { id: "r2", box: { x: 0.5, y: 0.1, w: 0.5, h: 0.9 }, prompt: "a tall green plant" }] },
      slots: files,
    },
    {
      name: "a region with a LoRA held to it, a LoRA on the whole picture, hires fix in tiles",
      input: {
        prompt: "a", loras: [{ file: "l.safetensors", weight: 0.8 }], hires: true, hiresScale: 3, hiresUpscaler: "u.pth",
        regions: [{ id: "r1", box: { x: 0.5, y: 0, w: 0.5, h: 1 }, prompt: "a watercolour lighthouse", lora: { file: "style.safetensors", weight: 0.9 } }, { id: "r2", box: { x: 0, y: 0, w: 0.5, h: 1 }, prompt: "" }],
      },
      slots: files,
    },
    {
      name: "two cast people in two regions with their pictures, their LoRAs held to their boxes, Detail: face, hires fix",
      input: {
        prompt: "a", detailFace: true, hires: true, hiresUpscaler: "u.pth",
        regions: [
          { id: "r1", box: { x: 0, y: 0, w: 0.5, h: 1 }, prompt: "a man in a grey coat", cast: "p1", castPicture: "a1", castLora: { file: "fabien.safetensors", weight: 0.8 } },
          { id: "r2", box: { x: 0.5, y: 0, w: 0.5, h: 1 }, prompt: "a man in a blue jacket", cast: "p2", castPicture: "a2" },
        ],
      },
      slots: { ...withFaceRefine, ...DETECTOR_FILES }, uploads: { "regions.r1": "f.png", "regions.r2": "n.png" },
    },
    {
      name: "a cast person in a region, the person pass off, Detail: face off",
      input: { prompt: "a", regionPersonDenoise: 0, regions: [{ id: "r1", box: { x: 0.25, y: 0, w: 0.5, h: 1 }, prompt: "a man", cast: "p1", castPicture: "a1" }] },
      slots: withPerson, uploads: { "regions.r1": "f.png" },
    },
    {
      name: "a person reference with hires fix in tiles, a LoRA, Face refine off",
      input: { prompt: "a", person: [{ asset: "p", role: "person" }], faceRefine: false, hires: true, hiresScale: 3, hiresUpscaler: "u.pth", loras: [{ file: "l.safetensors", weight: 0.8 }] },
      slots: withPerson, uploads: { "person.0": "p.png" },
    },
  ],
}), dropsFor("txt2img", krea2Spec.drops));

/**
 * The regions' cast people, after the picture: each pictured box redrawn from its person's picture by Identity Edit
 * (krea2/regions.ts) unless its denoise is 0, then, with Detail: face on, the largest face in each box by Face refine's Klein
 * pass from that person's picture, so two people keep two faces. A person with no picture keeps what their words drew.
 */
function personBoxed(
  g: GraphBuilder, ctx: BuildContext, input: Krea2Picture, image: Ref, at: { size: { width: number; height: number }; scale: number },
  k: { model: Ref; clip: Ref; vae: Ref; steps: number; shifted: (model: Ref, size: { width: number; height: number }) => Ref },
) {
  const people = pictured(input.regions).filter((r) => ctx.uploads[regionPicture(REGIONS, r)]);
  const made = { image, passes: [] as Array<{ node: string; steps: number; pixels: number; unsampled?: string }>, loads: [] as string[], warnings: [] as string[] };
  if (!people.length) return made;
  if (input.regionPersonDenoise > 0) {
    // its row's file and weight, as the LoRA list shows them (a hand row of the same file gives its weight)
    const identity = addedLora(ctx.slots.identityEdit, input.identityLora, input.identityStrength, input.loras);
    if (!identity.lora || !identity.put) made.warnings.push("The cast people's boxes were not redrawn from their pictures: that needs Krea 2's Identity Edit V2 LoRA (Settings › Models), at a weight above 0.");
    else {
      g.phase("detailing");
      const redrawn = personBoxes(g, people, {
        image, size: at.size, model: k.model, identity: identity.lora, clip: k.clip, vae: k.vae, refBoost: input.refBoost, denoise: input.regionPersonDenoise,
        steps: k.steps, sampler: input.sampler, scheduler: input.scheduler, seed: ctx.seed, shifted: k.shifted, uploads: ctx.uploads, has: ctx.has,
      });
      made.image = redrawn.image;
      made.warnings.push(...redrawn.warnings);
      made.passes.push(...redrawn.passes);
      made.loads.push(`loras/${identity.lora.file}`);
    }
  }
  if (input.detailFace) {
    for (const [i, r] of people.entries()) {
      const face = facePass(g, ctx, { faceRefine: true, faceRefineDenoise: input.faceRefineDenoise }, made.image, {
        pictures: [ctx.uploads[regionPicture(REGIONS, r)]!], scale: at.scale, within: (segs) => facesIn(g, segs, [r.box], at.size, true),
        none: `Detail: face found no face under ${SMALL_FACE_PX} px tall in person ${i + 1}'s box: their face is as drawn.`,
      });
      if (face.said && !made.warnings.includes(face.said)) made.warnings.push(face.said);
      if (!face.pass) continue;
      made.image = face.image;
      made.passes.push(face.pass);
      for (const file of face.loads) if (!made.loads.includes(file)) made.loads.push(file);
    }
  }
  return made;
}

// ---------------------------------------------------------------- img2img, inpaint, outpaint, upscale 2x, face detailer: the picture models' own

// its img2img takes neither the style references nor the person of txt2img: those are read by txt2img's own graph
export const krea2Redraw = flowRedraw({ ...krea2Spec, drops: { ...krea2Spec.drops, ...noReferences("Krea 2's img2img reads no reference image: txt2img takes them (a style, a person)") } }, krea2Kit);
export const krea2PaintOver = flowPaintOver(krea2Spec, krea2Kit);
export const krea2Outpaint = flowOutpaint(krea2Spec, krea2Kit);
export const krea2Sharper = flowSharper(krea2Spec, krea2Kit);
export const krea2FixFace = flowFixFace(krea2Spec, krea2Kit);
