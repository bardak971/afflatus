import { defineFamily, defineRecipe, GraphBuilder, REFERENCE_ROLES, type InputSpec, type LoraValue, type Ref, type ReferenceValue } from "@afflatus/core";
import { flowKit, flowRecipes, type FlowSpec } from "../flow/recipes";
import { loadUnet, unetNodes } from "../shared/unet";
import { qwenLint } from "../shared/lint";

const HF = "https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files";
const HF_EDIT = "https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI/resolve/main/split_files";

/**
 * Qwen Image: pictures from plain sentences, good at text in the picture. Written blind from ComfyUI's
 * own templates (`image_qwen_image`, `image_qwen_Image_2512`, `image_qwen_image_edit_2511`): it has never
 * been rendered here. Qwen Image Edit is the model that changes a picture from an instruction.
 */
export const qwen = defineFamily({
  id: "qwen",
  name: "Qwen Image",
  summary: "txt2img from natural-language prompts, with legible text rendering. Qwen Image Edit is the edit model: instruction-based image editing.",
  help: {
    what: "Pictures from sentences, with readable text; Qwen Image Edit edits by instruction.",
    best: "text in pictures, in English and Chinese; long, detailed prompts",
    weak: "edits need the Edit model, a model of its own",
  },
  promptStyle: "sentences",
  slots: [
    {
      // the newest first; never the Edit or the layered models, which do something else
      id: "unet", label: "Diffusion model", folder: "diffusion_models",
      // never Qwen Image 2.1 either: another encoder, another VAE, other nodes
      detect: ["^(?!.*(edit|layered|2[._]1)).*qwen.?image.*2512", "^(?!.*(edit|layered|2[._]1)).*qwen.?image"],
      hint: "Put a Qwen Image model (qwen_image_2512_fp8_e4m3fn.safetensors, or a fine-tune) in ComfyUI's models/diffusion_models folder.",
      get: { file: "qwen_image_2512_fp8_e4m3fn.safetensors", url: `${HF}/diffusion_models/qwen_image_2512_fp8_e4m3fn.safetensors` },
    },
    {
      id: "clip", label: "Text encoder (Qwen 2.5 VL 7B)", folder: "text_encoders", detect: ["qwen.?2[._]?5.?vl.?7b"],
      hint: "Put qwen_2.5_vl_7b_fp8_scaled.safetensors in ComfyUI's models/text_encoders folder.",
      get: { file: "qwen_2.5_vl_7b_fp8_scaled.safetensors", url: `${HF}/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors` },
    },
    {
      // Qwen Image works in the latent space of its own VAE, which is also that of the Wan 2.1 VAE
      id: "vae", label: "VAE", folder: "vae", detect: ["qwen_image_vae", "wan_?2[._]?1.*vae"],
      hint: "Put qwen_image_vae.safetensors (or the Wan 2.1 VAE) in ComfyUI's models/vae folder.",
      get: { file: "qwen_image_vae.safetensors", url: `${HF}/vae/qwen_image_vae.safetensors` },
    },
    {
      id: "turbo", label: "Turbo LoRA (Lightning)", folder: "loras", detect: ["^(?!.*edit).*qwen.?image.*lightning"], optional: true,
      hint: "Without it, Turbo is off and images take the full step count. Put a Qwen-Image-Lightning LoRA in ComfyUI's models/loras folder.",
      get: { file: "Qwen-Image-2512-Lightning-4steps-V1.0-fp32.safetensors", url: "https://huggingface.co/lightx2v/Qwen-Image-2512-Lightning/resolve/main/Qwen-Image-2512-Lightning-4steps-V1.0-fp32.safetensors" },
    },
    {
      id: "edit", label: "Qwen Image Edit model", folder: "diffusion_models", detect: ["^(?!.*2[._]1).*qwen.?image.?edit.*2511", "^(?!.*2[._]1).*qwen.?image.?edit"], optional: true,
      hint: "Without it there is no Edit. Put qwen_image_edit_2511_*.safetensors in ComfyUI's models/diffusion_models folder.",
      get: { file: "qwen_image_edit_2511_fp8mixed.safetensors", url: `${HF_EDIT}/diffusion_models/qwen_image_edit_2511_fp8mixed.safetensors` },
    },
    {
      id: "editTurbo", label: "Turbo LoRA for Edit (Lightning)", folder: "loras", detect: ["qwen.?image.?edit.*lightning"], optional: true,
      hint: "Without it, Edit takes the full step count. Put a Qwen-Image-Edit-Lightning LoRA in ComfyUI's models/loras folder.",
      get: { file: "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors", url: "https://huggingface.co/lightx2v/Qwen-Image-Edit-2511-Lightning/resolve/main/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors" },
    },
  ],
  loraMatch: ["qwen.?image", "qwen"],
  guide: `Qwen Image reads plain sentences, in English or Chinese, and follows long descriptions closely. Its authors' own rewriter is the rule: one continuous paragraph, the subject first (what comes first weighs most), under 200 words; 1 to 3 sentences are often enough.
RULES FOR A NEW PICTURE
- The subject and its look, then the style or medium, the details, the composition and the layering (what is in front, what is behind), the light and the atmosphere.
- A portrait with no cast given: state the person's ethnicity, gender and an age range (the rewriter's own rule). With a cast, their words say it.
- Text that must appear: English double quotes, exact spelling, case and punctuation, where it sits and in what style ("a neon sign that reads "OPEN" above the door, in bold sans-serif"); one text element per clause; keep the strings simple. This model writes text well.
- A proper noun, a brand or an address the user gave is never altered.
- A photographic or cinematic picture ends with ", Ultra HD, 4K, cinematic composition." (the authors' suffix); not flat graphics, UI, posters or print, where "cinematic" adds depth of field and warm grading.
RULES FOR AN INSTRUCTION (the part is called "Instruction": a change to a picture)
- Direct and specific: what changes and what stays ("Turn the cat into a dog, keep the sofa and the light unchanged").
- A change to a person stays subtle and keeps ethnicity, gender, age and hairstyle.
- Text edits quote the old and the new string, keeping the original language and case.
- Several pictures: a role and a place for each ("the bear from the first image on the left, the one from the second on the right").
- Fixed words for known tasks: "Restore and colorize the photo."; "Perform inpainting on this image. The original caption is: …".
- No weights. The "Negative prompt" part works (real CFG): leave the default unless asked. A LoRA's trigger words stay.
EXAMPLES, for the form only (their subjects, places and words are not to be reused):
A new picture: A coffee shop entrance at dusk with a chalkboard sign by the door that reads "Qwen Coffee $2 per cup" in white hand-lettered chalk, and a neon light beside it displaying "OPEN" in warm pink. Wet cobblestones in front reflect the glow; a bicycle leans against the wall on the left, Ultra HD, 4K, cinematic composition.
An instruction: Replace the chalkboard's text "Qwen Coffee $2 per cup" with "CLOSED TODAY" in the same hand-lettered chalk style, and keep everything else unchanged.`,
  /** What the designer wrote, against Qwen's own rewriter: under 200 words, no weights. */
  lint: qwenLint,
});

/** What a model or a LoRA made for a few steps is called. */
const lightning = /lightning|turbo|distill|(^|[^a-z0-9])\d+[ _-]?steps?/i;

/** Qwen Image's own negative prompt, as its authors and ComfyUI's template give it (low resolution, deformed hands, waxy skin, an "AI look", muddled composition, blurred text). */
const QWEN_NEGATIVE = "低分辨率，低画质，肢体畸形，手指畸形，画面过饱和，蜡像感，人脸无细节，过度光滑，画面具有AI感。构图混乱。文字模糊，扭曲";

const spec: FlowSpec = {
  family: "qwen",
  model: {
    id: "model", type: "model", label: "Model", folder: "diffusion_models", slot: "unet", match: ["^(?!.*(edit|layered|2[._]1)).*qwen.?image", "qwen"],
    note: "Qwen Image, or a fine-tune of it",
  },
  encoder: {
    nodes: ["CLIPLoader"],
    load: (g, slots) => g.out("CLIPLoader", { clip_name: slots.clip, type: "qwen_image", device: "default" }),
    files: (slots) => [`text_encoders/${slots.clip}`],
  },
  shift: { node: "ModelSamplingAuraFlow", default: 3.1, note: "3.1 is what ComfyUI's template uses. 0 leaves the model's own" },
  turbo: {
    slot: "turbo", steps: 4, named: lightning,
    note: "a few steps at CFG 1: with the Lightning LoRA, or as it is with a model made for it",
    stepsNote: "4 or 8: as many as the Lightning LoRA you have is made for",
  },
  negative: { default: QWEN_NEGATIVE, note: "acts with a CFG scale above 1, so not with Turbo. The starting text is Qwen's own, in Chinese", empty: "encode" },
  sampling: {
    steps: 50, stepsNote: "50 is what the 2512 model's authors and ComfyUI's template give; 20 is a quick draft",
    cfg: 4, cfgNote: "4 in ComfyUI's template (2.5 is softer). With Turbo it is 1", sampler: "euler", scheduler: "simple",
  },
  // the sizes Qwen Image's authors list
  shapes: [
    { id: "tall", label: "Portrait 3:4", width: 1104, height: 1472 },
    { id: "square", label: "Square", width: 1328, height: 1328 },
    { id: "wide", label: "Landscape 4:3", width: 1472, height: 1104 },
    { id: "tall-9-16", label: "Portrait 9:16", width: 928, height: 1664 },
    { id: "wide-16-9", label: "Landscape 16:9", width: 1664, height: 928 },
    { id: "tall-2-3", label: "Portrait 2:3", width: 1056, height: 1584 },
    { id: "wide-3-2", label: "Landscape 3:2", width: 1584, height: 1056 },
  ],
  megapixels: 1.8,
  placeholder: "A photograph of a small bakery at dawn, a chalkboard by the door that reads \"FRESH BREAD\", warm light from the windows on wet cobblestones.",
  files: { unet: "qwen_image_2512_fp8_e4m3fn.safetensors", clip: "qwen_2.5_vl_7b_fp8_scaled.safetensors", vae: "qwen_image_vae.safetensors" },
  fineTune: "Qwen\\someone_qwen_image_v1.safetensors",
};

const made = flowRecipes(spec);
export const qwenPicture = made.picture;
export const qwenRedraw = made.redraw;
export const qwenPaintOver = made.paintOver;
export const qwenOutpaint = made.outpaint;
export const qwenSharper = made.sharper;
export const qwenFixFace = made.fixFace;

// ---------------------------------------------------------------- edit (Qwen Image Edit)

interface QwenEdit {
  model?: string;
  precision?: string;
  source: string;
  prompt: string;
  references: ReferenceValue[];
  negative: string;
  loras: LoraValue[];
  fast: boolean;
  turboSteps: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  shift: number;
  seed: number;
}

const kit = flowKit(spec);
/** How many pictures Qwen Image Edit reads next to the instruction: the one that is edited and two more. */
const EDIT_IMAGES = 3;
const editModel: InputSpec = {
  id: "model", type: "model", label: "Model", folder: "diffusion_models", slot: "edit", match: ["qwen.?image.?edit"],
  note: "Qwen Image Edit, or a fine-tune of it",
};

/**
 * A picture changed from an instruction, with Qwen Image Edit, as ComfyUI's template does it: the
 * instruction is read together with the picture (and up to two more pictures it can take things from),
 * and the result is drawn over the picture itself. What is not asked to change stays.
 */
export const qwenEdit = defineRecipe<QwenEdit>({
  id: "qwen.edit",
  family: "qwen",
  version: 1,
  title: "Edit",
  summary: "Instruction-based editing (\"make the jacket red\", \"put her in the place of image 2\") with Qwen Image Edit. The rest of the image is kept.",
  output: "image",
  needs: ["edit"],
  inputs: [
    editModel,
    { id: "source", type: "image", role: "source", label: "Image", note: "the picture it works on" },
    { id: "prompt", type: "prompt", label: "Instruction", style: "sentences", placeholder: "Change the sofa's leather to the fur of image 2, keep everything else the same." },
    {
      id: "references", type: "references", label: "Additional images", max: EDIT_IMAGES - 1, roles: [...REFERENCE_ROLES],
      note: "something to take from: a person, a place, clothes, an object, a look. Call them \"image 2\" and \"image 3\" in the instruction",
    },
    ...kit.inputs.map((i) => (i.id === "steps" ? { ...i, default: 40, note: "40 in ComfyUI's template" } : i.id === "fast" ? { ...i, note: "4 steps at CFG 1, with the Lightning LoRA made for Edit" } : i) as InputSpec),
  ],
  nodes: (input) => [
    ...unetNodes(input.model), "CLIPLoader", "VAELoader", "KSampler", "VAEDecode", "PreviewImage", "LoadImage", "FluxKontextImageScale", "VAEEncode",
    "TextEncodeQwenImageEditPlus", "FluxKontextMultiReferenceLatentMethod", "CFGNorm",
    ...(input.shift > 0 ? ["ModelSamplingAuraFlow"] : []),
  ],
  optionalNodes: ["LoraLoaderModelOnly"],
  build(input, ctx) {
    const unet = input.model ?? ctx.slots.edit;
    if (!unet) throw new Error("Edit needs Qwen Image Edit: put qwen_image_edit_2511_*.safetensors in ComfyUI's models/diffusion_models folder (it can be downloaded from Settings).");
    const g = new GraphBuilder();
    const clip = g.out("CLIPLoader", { clip_name: ctx.slots.clip, type: "qwen_image", device: "default" });
    const vae = g.out("VAELoader", { vae_name: ctx.slots.vae });
    // the model as ComfyUI's template prepares it: its LoRAs, the shift, the CFG kept in bounds, then the Lightning LoRA
    let model: Ref = loadUnet(g, ctx, unet, input.precision || "default");
    for (const l of input.loras) if (l.weight !== 0) model = g.out("LoraLoaderModelOnly", { model, lora_name: l.file, strength_model: l.weight });
    if (input.shift > 0) model = g.out("ModelSamplingAuraFlow", { model, shift: input.shift });
    model = g.out("CFGNorm", { model, strength: 1, pre_cfg: false });
    // a model made for a few steps runs at them whether Turbo is on or not
    const made = lightning.test(unet.split(/[\\/]/).pop() ?? "");
    const turboLora = input.fast && !made ? ctx.slots.editTurbo : undefined;
    const turbo = made || (input.fast && Boolean(turboLora));
    if (turboLora) model = g.out("LoraLoaderModelOnly", { model, lora_name: turboLora, strength_model: 1 });

    const picture = g.out("FluxKontextImageScale", { image: g.out("LoadImage", { image: ctx.uploads.source }) });
    const more = Object.fromEntries(input.references.slice(0, EDIT_IMAGES - 1).map((_, i) => [`image${i + 2}`, g.out("LoadImage", { image: ctx.uploads[`references.${i}`] })]));
    const read = (prompt: string) => g.out("FluxKontextMultiReferenceLatentMethod", {
      conditioning: g.out("TextEncodeQwenImageEditPlus", { clip, vae, prompt, image1: picture, ...more }),
      reference_latents_method: "index_timestep_zero",
    });
    const steps = turbo ? input.turboSteps : input.steps;
    g.phase("sampling");
    const sampled = g.out("KSampler", {
      model, positive: read(input.prompt), negative: read(input.negative), latent_image: g.out("VAEEncode", { pixels: picture, vae }), seed: ctx.seed,
      steps, cfg: turbo ? 1 : input.cfg, sampler_name: input.sampler, scheduler: input.scheduler, denoise: 1,
    });
    g.phase("decoding");
    const out = g.add("PreviewImage", { images: g.out("VAEDecode", { samples: sampled, vae }) });
    return {
      graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: steps, passes: [{ node: sampled[0], steps }],
      loads: [
        `diffusion_models/${unet}`, `text_encoders/${ctx.slots.clip}`, `vae/${ctx.slots.vae}`,
        ...(turboLora ? [`loras/${turboLora}`] : []), ...input.loras.filter((l) => l.weight !== 0).map((l) => `loras/${l.file}`),
      ],
    };
  },
  variants: [
    { name: "from an instruction", input: { source: "p", prompt: "a" }, slots: { ...spec.files, edit: "qwen_image_edit_2511.safetensors" }, uploads: { source: "s.png" }, media: { source: { width: 896, height: 1152 } } },
    {
      name: "with two more images, Turbo, a LoRA and the model's own shift",
      input: { source: "p", prompt: "a", references: [{ asset: "a", role: "object" }, { asset: "b", role: "place" }], fast: true, shift: 0, negative: "blurry", loras: [{ file: "l.safetensors", weight: 0.8 }] },
      slots: { ...spec.files, edit: "qwen_image_edit_2511.safetensors", editTurbo: "edit_lightning.safetensors" },
      uploads: { source: "s.png", "references.0": "a.png", "references.1": "b.png" }, media: { source: { width: 1536, height: 2048 } },
    },
  ],
});
