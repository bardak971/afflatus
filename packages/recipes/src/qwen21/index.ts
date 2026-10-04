import { defineFamily, defineRecipe, GraphBuilder, REFERENCE_ROLES, type InputSpec, type LoraValue, type Ref, type ReferenceValue, type SizeValue } from "@afflatus/core";
import { loadUnet, unetNodes } from "../shared/unet";

const HF = "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main";

/**
 * Qwen Image 2.1 (September 2026): one model that makes pictures and changes them, reading up to ten
 * pictures next to the words, native 2K, in 25 to 40 steps at CFG 1. Written from ComfyUI's own templates
 * (`image_qwen_image_2_1_t2i`, `image_qwen_image_2_1_image_edit`), without their prompt-rewriting language
 * model. Its weights are under the Qwen Research License (research use): the files are the user's to
 * fetch and the terms theirs to accept, which is why nothing starts on this family.
 */
export const qwen21 = defineFamily({
  id: "qwen21",
  name: "Qwen Image 2.1",
  summary: "txt2img and instruction-based editing in one model, up to 10 reference images, native 2K. Weights under the Qwen Research License (research use).",
  promptStyle: "sentences",
  slots: [
    {
      id: "unet", label: "Diffusion model", folder: "diffusion_models", detect: ["qwen.?image.?2[._]1(?!.*vae)"],
      hint: "Put qwen_image_2.1_*.safetensors (the int8 one, 6.8 GB, or bf16) in ComfyUI's models/diffusion_models folder. Its licence (Qwen Research License) is yours to accept.",
      get: { file: "qwen_image_2.1_int8_convrot.safetensors", url: `${HF}/diffusion_models/qwen_image_2.1_int8_convrot.safetensors` },
    },
    {
      id: "clip", label: "Text encoder (Qwen3-VL 8B)", folder: "text_encoders", detect: ["qwen3.?vl.?8b"],
      hint: "Put qwen3vl_8b_*.safetensors in ComfyUI's models/text_encoders folder.",
      get: { file: "qwen3vl_8b_int8_convrot.safetensors", url: `${HF}/text_encoders/qwen3vl_8b_int8_convrot.safetensors` },
    },
    {
      id: "vae", label: "VAE", folder: "vae", detect: ["qwen.?image.?2[._]1.*vae"],
      hint: "Put qwen_image_2.1_vae_bf16.safetensors in ComfyUI's models/vae folder (Qwen Image 2.1 has a VAE of its own).",
      get: { file: "qwen_image_2.1_vae_bf16.safetensors", url: `${HF}/vae/qwen_image_2.1_vae_bf16.safetensors` },
    },
  ],
  loraMatch: ["qwen.?image.?2[._]1"],
  guide: `Qwen Image 2.1 reads plain sentences, in English or Chinese, and follows long descriptions closely. It makes pictures and changes them with the same model.
A NEW PICTURE: describe it as a whole in natural sentences: the subject and its look, the place, the light, the composition, the style or medium. Text that must appear goes in quotes, word for word. A transparent picture: write "This is an RGBA format image with transparency. [the subject]. The image has an alpha channel and a transparent background."
A CHANGE TO A PICTURE: write it as an instruction. The pictures are numbered: <image1> is the picture being changed, <image2> and on are the references; name them that way in the instruction ("Replace the jacket in <image1> with the one in <image2>, keep everything else the same").
Stay faithful to what the user asked: add detail to their idea, not new subjects. No weights, no quality tags. A LoRA's trigger words must stay in the prompt for it to act.`,
});

interface Qwen21Base {
  model?: string;
  precision?: string;
  negative: string;
  loras: LoraValue[];
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  cacheDtype: string;
  seed: number;
}
export interface Qwen21Picture extends Qwen21Base { prompt: string; size: SizeValue }
export interface Qwen21Edit extends Qwen21Base { source: string; prompt: string; references: ReferenceValue[]; resolution: number }

const model: InputSpec = { id: "model", type: "model", label: "Model", folder: "diffusion_models", slot: "unet", match: ["qwen.?image.?2[._]1(?!.*vae)"], note: "Qwen Image 2.1, or a fine-tune of it" };
/** How it samples: the values of ComfyUI's template (25 steps) raised to what Qwen's authors give (about 40 with euler), each kept per model once saved. */
const sampling: InputSpec[] = [
  { id: "loras", type: "loras", label: "LoRAs", max: 6 },
  { id: "negative", type: "prompt", label: "Negative prompt", note: "unused at CFG 1, which is the model's own setting; raise the CFG scale for it to act", style: "sentences", optional: true, default: "", advanced: true, perModel: true },
  { id: "steps", type: "number", label: "Steps", note: "about 40 with euler, as Qwen's authors give; ComfyUI's template starts at 25", min: 1, max: 80, step: 1, default: 40, advanced: true, perModel: true },
  { id: "cfg", type: "number", label: "CFG scale", note: "1 is the model's own setting. Above 1 the negative prompt acts and every step takes twice as long", min: 1, max: 10, step: 0.5, default: 1, advanced: true, perModel: true },
  { id: "sampler", type: "choice", label: "Sampler", options: { node: "KSampler", input: "sampler_name" }, default: "euler", advanced: true, perModel: true },
  { id: "scheduler", type: "choice", label: "Scheduler", options: { node: "KSampler", input: "scheduler" }, default: "simple", advanced: true, perModel: true },
  {
    id: "precision", type: "choice", label: "Weight precision", options: { node: "UNETLoader", input: "weight_dtype" }, default: "default", advanced: true, perModel: true,
    note: "how the model's weights are held in memory: default keeps the file's own; fp8 halves a bf16 file",
  },
  {
    id: "cacheDtype", type: "choice", label: "KV cache precision", options: ["default", "int8", "int4"], default: "default", advanced: true,
    note: "the model's cache of the prompt and the reference pictures: default is lossless; int8 halves it at about the same quality, int4 quarters it. Smaller helps edits with many pictures on a small card",
  },
  { id: "seed", type: "seed", label: "Seed" },
];
const r32 = (n: number) => Math.max(32, Math.round(n / 32) * 32);

/** The model with its LoRAs and its cache, the text encoder and the VAE. */
function load(g: GraphBuilder, input: Qwen21Base, ctx: Parameters<typeof loadUnet>[1]) {
  const unet = input.model ?? ctx.slots.unet;
  let m: Ref = loadUnet(g, ctx, unet, input.precision || "default");
  for (const l of input.loras) if (l.weight !== 0) m = g.out("LoraLoaderModelOnly", { model: m, lora_name: l.file, strength_model: l.weight });
  m = g.out("QwenImage21Cache", { model: m, device: "auto", dtype: input.cacheDtype });
  return {
    model: m,
    clip: g.out("CLIPLoader", { clip_name: ctx.slots.clip, type: "qwen_image", device: "default" }),
    vae: g.out("VAELoader", { vae_name: ctx.slots.vae }),
    loads: [`diffusion_models/${unet}`, `text_encoders/${ctx.slots.clip}`, `vae/${ctx.slots.vae}`, ...input.loras.filter((l) => l.weight !== 0).map((l) => `loras/${l.file}`)],
  };
}
const NODES = (input: Qwen21Base) => [...unetNodes(input.model), "QwenImage21Cache", "CLIPLoader", "VAELoader", "TextEncodeQwenImage21", "KSampler", "VAEDecode", "PreviewImage"];
const files = { unet: "qwen_image_2.1_int8_convrot.safetensors", clip: "qwen3vl_8b_int8_convrot.safetensors", vae: "qwen_image_2.1_vae_bf16.safetensors" };

export const qwen21Picture = defineRecipe<Qwen21Picture>({
  id: "qwen21.text-to-picture",
  family: "qwen21",
  version: 1,
  title: "txt2img",
  summary: "Text to image with Qwen Image 2.1: natural-language prompts, legible text, up to 2K.",
  output: "image",
  inputs: [
    model,
    { id: "prompt", type: "prompt", label: "Prompt", style: "sentences", placeholder: "A photograph of a small bakery at dawn, a chalkboard by the door that reads \"FRESH BREAD\", warm light from the windows on wet cobblestones." },
    {
      id: "size", type: "size", label: "Size", default: "tall", grid: 32, min: 256, max: 2048, maxPixels: 4.3e6,
      shapes: [
        { id: "tall", label: "Portrait", width: 896, height: 1152 },
        { id: "square", label: "Square", width: 1024, height: 1024 },
        { id: "wide", label: "Landscape", width: 1152, height: 896 },
        { id: "square-2k", label: "Square 2K", width: 2048, height: 2048 },
      ],
    },
    ...sampling,
  ],
  nodes: (input) => [...NODES(input), "EmptyLatentImage"],
  optionalNodes: ["LoraLoaderModelOnly"],
  build(input, ctx) {
    const g = new GraphBuilder();
    const k = load(g, input, ctx);
    const size = { width: r32(input.size.width), height: r32(input.size.height) };
    const read = g.add("TextEncodeQwenImage21", { clip: k.clip, prompt: input.prompt, negative_prompt: input.negative, resolution: 1024, vae: k.vae });
    g.phase("sampling");
    const sampled = g.out("KSampler", {
      model: k.model, positive: [read, 0], negative: [read, 1], latent_image: g.out("EmptyLatentImage", { width: size.width, height: size.height, batch_size: 1 }), seed: ctx.seed,
      steps: input.steps, cfg: input.cfg, sampler_name: input.sampler, scheduler: input.scheduler, denoise: 1,
    });
    g.phase("decoding");
    const out = g.add("PreviewImage", { images: g.out("VAEDecode", { samples: sampled, vae: k.vae }) });
    return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: input.steps, passes: [{ node: sampled[0], steps: input.steps }], loads: k.loads };
  },
  variants: [
    { name: "from words, as ComfyUI's template", input: { prompt: "a" }, slots: files },
    { name: "2K, a LoRA, a negative prompt with a CFG, the cache in int8", input: { prompt: "a", size: { width: 2048, height: 2048 }, negative: "blurry", cfg: 2.5, cacheDtype: "int8", loras: [{ file: "l.safetensors", weight: 0.8 }] }, slots: files },
  ],
});

/** How many pictures the model reads next to the instruction: the one that is edited and nine more. */
const EDIT_IMAGES = 10;

export const qwen21Edit = defineRecipe<Qwen21Edit>({
  id: "qwen21.edit",
  family: "qwen21",
  version: 1,
  title: "Edit",
  summary: "Instruction-based editing with Qwen Image 2.1 (\"replace the jacket in <image1> with the one in <image2>\"), up to 9 reference images. The rest of the image is kept.",
  output: "image",
  inputs: [
    model,
    { id: "source", type: "image", role: "source", label: "Image", note: "<image1> in the instruction" },
    { id: "prompt", type: "prompt", label: "Instruction", style: "sentences", placeholder: "Replace the jacket in <image1> with the one in <image2>, keep everything else the same." },
    {
      id: "references", type: "references", label: "Reference images", max: EDIT_IMAGES - 1, roles: [...REFERENCE_ROLES],
      note: "something to take from: a person, a place, clothes, an object, a look. They are <image2>, <image3>… in the instruction, in this order",
    },
    {
      id: "resolution", type: "number", label: "Working size", min: 0, max: 2048, step: 32, default: 1024, unit: " px", advanced: true,
      note: "the pictures are brought to about this many pixels on a side (their shape kept) before the model reads them; the result follows the first. 0 keeps them as they are, on a grid of 32",
    },
    ...sampling,
  ],
  nodes: (input) => [...NODES(input), "LoadImage"],
  optionalNodes: ["LoraLoaderModelOnly"],
  build(input, ctx) {
    const g = new GraphBuilder();
    const k = load(g, input, ctx);
    const pictures = [ctx.uploads.source, ...input.references.slice(0, EDIT_IMAGES - 1).map((_, i) => ctx.uploads[`references.${i}`])];
    // the pictures go in as "images.image_N", counted from 1: the encoder reads them and gives the canvas of the first as the latent
    const read = g.add("TextEncodeQwenImage21", {
      clip: k.clip, prompt: input.prompt, negative_prompt: input.negative, resolution: input.resolution, vae: k.vae,
      ...Object.fromEntries(pictures.map((file, i) => [`images.image_${i + 1}`, g.out("LoadImage", { image: file })])),
    });
    g.phase("sampling");
    const sampled = g.out("KSampler", {
      model: k.model, positive: [read, 0], negative: [read, 1], latent_image: [read, 2], seed: ctx.seed,
      steps: input.steps, cfg: input.cfg, sampler_name: input.sampler, scheduler: input.scheduler, denoise: 1,
    });
    g.phase("decoding");
    const out = g.add("PreviewImage", { images: g.out("VAEDecode", { samples: sampled, vae: k.vae }) });
    return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: input.steps, passes: [{ node: sampled[0], steps: input.steps }], loads: k.loads };
  },
  variants: [
    { name: "from an instruction", input: { source: "p", prompt: "a" }, slots: files, uploads: { source: "s.png" }, media: { source: { width: 896, height: 1152 } } },
    {
      name: "with two references, the pictures left at their size, a GGUF model",
      input: { source: "p", prompt: "a", model: "qwen_image_2.1-Q4_K_M.gguf", resolution: 0, references: [{ asset: "a", role: "clothing" }, { asset: "b", role: "place" }] },
      slots: files, uploads: { source: "s.png", "references.0": "a.png", "references.1": "b.png" }, media: { source: { width: 1536, height: 2048 } },
    },
  ],
});
