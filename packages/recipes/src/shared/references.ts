import { type BuildContext, type GraphBuilder, type InputSpec, type Ref, type ReferenceRole, type ReferenceValue } from "@afflatus/core";

/**
 * Reference images on a picture form: pictures the new one takes something from without being drawn from them. The same two
 * rows on every family that reads them (card #277), in the same words: "Reference images", each saying what it shows, and
 * "Reference strength". How a family reads them is its own: Klein and Qwen Image Edit as more pictures beside the prompt,
 * Krea 2 through its style-reference LoRA, FLUX.1 through Redux (here), SDXL through IP-Adapter (here).
 */
export interface ReferenceSettings {
  references: ReferenceValue[];
  referenceStrength: number;
}

/** The two rows. `was`: the older single-picture row they replace (FLUX.1's Redux image), read into the first reference. */
export const referenceInputs = (how: { max: number; roles: ReferenceRole[]; note: string; strength: number; strengthNote: string; noCast?: true; was?: { image: string; strength: string } }): InputSpec[] => [
  { id: "references", type: "references", label: "Reference images", max: how.max, roles: how.roles, note: how.note, ...(how.noCast ? { noCast: true as const } : {}), ...(how.was ? { was: how.was.image } : {}) },
  { id: "referenceStrength", type: "number", label: "Reference strength", note: how.strengthNote, min: 0.05, max: 1.5, step: 0.05, default: how.strength, showWhen: "references", ...(how.was ? { was: how.was.strength } : {}) },
];

const loadEach = (g: GraphBuilder, ctx: BuildContext, refs: ReferenceValue[]) => refs.map((_, i) => g.out("LoadImage", { image: ctx.uploads[`references.${i}`] }));

// ---------------------------------------------------------------- FLUX.1: Redux

/** The nodes Redux brings in. */
export const REDUX_NODES = ["LoadImage", "CLIPVisionLoader", "CLIPVisionEncode", "StyleModelLoader", "StyleModelApply"];
const REDUX_NEEDED = "Reference images on FLUX.1 need Redux and its vision model: flux1-redux-dev.safetensors in ComfyUI's models/style_models folder and sigclip_vision_patch14_384.safetensors in models/clip_vision (both are listed in Settings).";

/** FLUX.1's rows: Redux reads a picture's style, colours and subject, whatever it shows. */
export const reduxInputs = (was?: { image: string; strength: string }) => referenceInputs({
  max: 3, roles: ["style", "object", "place", "clothing", "person"], strength: 0.5, noCast: true,
  note: "their style, colours and subject are added to the prompt (Redux): the new picture is like them, not a copy",
  strengthNote: "1 follows the pictures closely and the prompt little; 0.3 to 0.6 keeps the prompt in charge",
  ...(was ? { was } : {}),
});

/** Redux's two files, for a job that has reference images (Recipe.needsWith). */
export const reduxNeeds = (input: Partial<ReferenceSettings>): string[] => (input.references?.length ? ["redux", "vision"] : []);

/**
 * The prompt's conditioning with each reference picture added by Redux, as ComfyUI's Redux template does it: the picture read
 * by the SigCLIP vision model, its tokens added through StyleModelApply at the strength asked. Unchanged without pictures.
 */
export function withRedux(g: GraphBuilder, ctx: BuildContext, positive: Ref, input: ReferenceSettings): { positive: Ref; loads: string[] } {
  if (!input.references.length) return { positive, loads: [] };
  if (!ctx.slots.redux || !ctx.slots.vision) throw new Error(REDUX_NEEDED);
  const vision = g.out("CLIPVisionLoader", { clip_name: ctx.slots.vision });
  const style = g.out("StyleModelLoader", { style_model_name: ctx.slots.redux });
  for (const picture of loadEach(g, ctx, input.references)) {
    const seen = g.out("CLIPVisionEncode", { clip_vision: vision, image: picture, crop: "center" });
    positive = g.out("StyleModelApply", { conditioning: positive, style_model: style, clip_vision_output: seen, strength: input.referenceStrength, strength_type: "multiply" });
  }
  return { positive, loads: [`style_models/${ctx.slots.redux}`, `clip_vision/${ctx.slots.vision}`] };
}

// ---------------------------------------------------------------- SDXL: IP-Adapter

/** cubiq's ComfyUI_IPAdapter_plus: its loaders and apply nodes (ComfyUI-Manager installs it, packs.ts). */
const IPA_NODES = ["LoadImage", "CLIPVisionLoader", "IPAdapterModelLoader", "IPAdapterAdvanced"];
const FACEID_NODES = ["LoadImage", "CLIPVisionLoader", "IPAdapterModelLoader", "IPAdapterInsightFaceLoader", "IPAdapterFaceID", "LoraLoaderModelOnly"];
const IPA_NEEDED = "Reference images on SDXL need the ComfyUI_IPAdapter_plus pack (ComfyUI-Manager installs it) and IP-Adapter's files: ip-adapter-plus_sdxl_vit-h.safetensors in ComfyUI's models/ipadapter folder and CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors in models/clip_vision (both are listed in Settings).";
const FACEID_NEEDED = "A person's reference image on SDXL is read by IP-Adapter FaceID Plus V2: ip-adapter-faceid-plusv2_sdxl.bin in ComfyUI's models/ipadapter folder, its LoRA ip-adapter-faceid-plusv2_sdxl_lora.safetensors in models/loras (both are listed in Settings), and InsightFace's buffalo_l in models/insightface/models with the insightface package in ComfyUI's Python (Afflatus's pod image has both).";

/** IP-Adapter's files under their usual names, for the graph checker's variants. */
export const IP_FILES = {
  ipAdapter: "ip-adapter-plus_sdxl_vit-h.safetensors", ipVision: "CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors",
  faceId: "ip-adapter-faceid-plusv2_sdxl.bin", faceIdLora: "ip-adapter-faceid-plusv2_sdxl_lora.safetensors",
};

/** Whether a reference is read for the face in it (FaceID), or for what it looks like (Plus). */
const isPerson = (r: ReferenceValue) => r.role === "person";

/** SDXL's rows: a person by their face (FaceID), anything else by its look (Plus); a style picture by its style alone. */
export const IP_ADAPTER_INPUTS = referenceInputs({
  max: 3, roles: ["person", "style", "object", "place", "clothing"], strength: 0.7, noCast: true,
  note: "IP-Adapter: a person keeps their face (FaceID Plus V2), a style picture gives its style alone, anything else its look and subject",
  strengthNote: "IP-Adapter's weight: 0.5 leaves the prompt in charge, 1 follows the pictures closely",
});

/** The nodes IP-Adapter brings in for these pictures. */
export const ipAdapterNodes = (input: Partial<ReferenceSettings>): string[] => {
  const refs = input.references ?? [];
  return [...(refs.some((r) => !isPerson(r)) ? IPA_NODES : []), ...(refs.some(isPerson) ? FACEID_NODES : [])];
};

/** IP-Adapter's files for these pictures (Recipe.needsWith): Plus's for a look, FaceID's and its LoRA for a person. */
export const ipAdapterNeeds = (input: Partial<ReferenceSettings>): string[] => {
  const refs = input.references ?? [];
  return [...(refs.length ? ["ipVision"] : []), ...(refs.some((r) => !isPerson(r)) ? ["ipAdapter"] : []), ...(refs.some(isPerson) ? ["faceId", "faceIdLora"] : [])];
};

/**
 * The checkpoint's model with each reference picture put on by IP-Adapter, as cubiq's examples do it: IPAdapterAdvanced for a
 * look (a style picture at "style transfer", which takes the style and leaves the subject), and for a person FaceID Plus V2
 * with its LoRA (at 0.6, as the pack's own FaceID loader puts it) and InsightFace on the CPU. Unchanged without pictures.
 */
export function withIpAdapter(g: GraphBuilder, ctx: BuildContext, model: Ref, input: ReferenceSettings): { model: Ref; loads: string[] } {
  if (!input.references.length) return { model, loads: [] };
  const people = input.references.some(isPerson);
  const looks = input.references.some((r) => !isPerson(r));
  if (!ctx.slots.ipVision || (looks && !ctx.slots.ipAdapter) || !ctx.has("IPAdapterAdvanced")) throw new Error(IPA_NEEDED);
  if (people && (!ctx.slots.faceId || !ctx.slots.faceIdLora || !ctx.has("IPAdapterFaceID"))) throw new Error(FACEID_NEEDED);
  const vision = g.out("CLIPVisionLoader", { clip_name: ctx.slots.ipVision });
  const loads = [`clip_vision/${ctx.slots.ipVision}`];
  const pictures = loadEach(g, ctx, input.references);
  const common = { combine_embeds: "concat", start_at: 0, end_at: 1, embeds_scaling: "V only", clip_vision: vision };
  if (looks) {
    const adapter = g.out("IPAdapterModelLoader", { ipadapter_file: ctx.slots.ipAdapter });
    loads.push(`ipadapter/${ctx.slots.ipAdapter}`);
    input.references.forEach((r, i) => {
      if (isPerson(r)) return;
      model = g.out("IPAdapterAdvanced", { model, ipadapter: adapter, image: pictures[i]!, weight: input.referenceStrength, weight_type: r.role === "style" ? "style transfer" : "linear", ...common });
    });
  }
  if (people) {
    model = g.out("LoraLoaderModelOnly", { model, lora_name: ctx.slots.faceIdLora, strength_model: 0.6 });
    const adapter = g.out("IPAdapterModelLoader", { ipadapter_file: ctx.slots.faceId });
    const faces = g.out("IPAdapterInsightFaceLoader", { provider: "CPU", model_name: "buffalo_l" });
    loads.push(`ipadapter/${ctx.slots.faceId}`, `loras/${ctx.slots.faceIdLora}`);
    input.references.forEach((r, i) => {
      if (!isPerson(r)) return;
      model = g.out("IPAdapterFaceID", { model, ipadapter: adapter, image: pictures[i]!, weight: input.referenceStrength, weight_faceidv2: input.referenceStrength, weight_type: "linear", ...common, insightface: faces });
    });
  }
  return { model, loads };
}
