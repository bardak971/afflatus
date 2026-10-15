import { defineFamily, defineRecipe, GraphBuilder, REFERENCE_ROLES, roundTo, type InputSpec, type LoraValue, type Ref, type ReferenceValue, type SizeValue } from "@afflatus/core";
import { loadUnet, unetNodes } from "../shared/unet";
import { qwen21Lint } from "../shared/lint";
import { FACE_AT_NODE, FACE_NODE, faceScore } from "../shared/face";

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
  help: {
    what: "Pictures and edits in one model, guided by up to 9 reference pictures, native 2K.",
    best: "edits guided by reference pictures that leave the rest of the picture as it was",
    weak: "research-use licence; lights what it adds evenly unless asked for the scene's light",
  },
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
  guide: `Qwen Image 2.1 was trained on prompts its authors' own rewriter writes (Qwen-Image-2.1-PE), and reads that form best: plain English sentences (or Chinese), one paragraph, no tags, no weights, no quality words.
RULES FOR A NEW PICTURE (the rewriter's: the finished picture described as if looking at it)
- About 20 sentences, 400 to 500 words, whatever the length of the brief: a short brief means deciding most of the frame, not writing less. A quiet single subject runs shorter, a dense frame longer.
- The opening sentence names the medium, the style, the subject and the background or palette: "The image is a vertical realistic photograph of …".
- Then walk the frame: the background right after the opening, then the top, the left, the centre, the right and the bottom (one subject: the background, its pose and place, the head and face, the body and each garment, what it holds). About a third of the sentences open on where they look ("In the upper-left corner, …"), reaching the corners and the edges.
- The light has a sentence of its own: its source, direction and quality, and the shadows and highlights it leaves.
- The last sentence steps back to the whole frame: balance, palette, style and mood ("The overall composition …").
- Present tense, third person, an observer: no "create", no "you", no "make sure". What the user did not fix is hedged ("appears to be", "likely", "a notebook or a tablet").
- Colours with a modifier (deep navy, pale cream), materials (brushed metal, coarse linen), counts as words; every item named, never "several items".
- People: build, posture, gaze, expression, hair, skin tone, each garment with its colour and material; an age as a life stage or a decade, never a number. With a cast, their words say who they are.
- Text that must appear: straight double quotes, the exact characters, where it sits, its weight, colour and size, in reading order. A picture with no text gets none invented; marks not meant to be read are blurred or too small to read.
- Objects by class unless the user named a brand. No aspect ratio, resolution or pixel count in the words.
- A transparent picture: "This is an RGBA format image with transparency. [the description]. The image has an alpha channel and a transparent background."
RULES FOR AN INSTRUCTION (the part is called "Instruction": a change to a picture)
- One paragraph that leads with the operation, written for someone holding only the input pictures.
- The pictures are <image1>, <image2>… (with one picture: "the image"). Each one's role is said: <image1> is the canvas whose composition stays, the others give what is taken from them (a face, clothes, a place, a look), each named on its own, never as a group.
- The change is strong and unmistakable; what is not named stays, in one clause naming it by type and place ("keep the background, every other person and the framing unchanged"), not described again (described, it drifts).
- A person's identity from a reference is pointed at, never described ("the head of the person shown in <image2>"). A face swap replaces the head (face, hair and beard), not the person, keeps the head's position, angle and tilt, and takes the scene's light; 2 to 3 sentences.
- Said as what to do: "keep … unchanged", not "do not …". Text edits quote the old and the new string exactly. Only what is visible is claimed.
- No weights, no quality tags. The "Negative prompt" part is unused at the model's own CFG of 1. A LoRA's trigger words stay. Faithful to the user's idea: detail, not new subjects.
EXAMPLES, for the form only (their subjects, places and words are not to be reused; a real new picture runs about twice as long):
A new picture: The image is a vertical realistic photograph of a small bakery entrance at dawn, set in a weathered brick facade of warm terracotta and soot grey. Behind the roofline, a pale blue sky turns peach toward the horizon. Across the top of the frame, a dark green awning with scalloped edges shades the doorway. On the left side of the frame, a chalkboard on a wooden easel reads "FRESH BREAD" in white hand-lettered chalk. In the centre, a glass-paned door stands half open, warm amber light spilling onto the stone step. On the right, a wicker basket of round loaves sits on a small café table of dark weathered wood. Across the lower third, wet cobblestones catch the glow in broken reflections. The lighting is soft early daylight from the left, with the warm light of the shop leaving long, faint shadows across the step. The overall composition is balanced and inviting, in a muted warm palette with a quiet morning mood.
An instruction: On <image1>, replace the shirt of the woman with the light blue linen shirt shown in <image2>, matching its colour, collar and buttons, fitted to her pose and the folds at her arms. Keep her face, hair, pose, the background and the framing of <image1> unchanged.`,
  /** What the designer wrote, against Qwen 2.1's own rewriter: no weights; no word cap (it writes 400 to 500 words). */
  lint: qwen21Lint,
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
interface Qwen21Picture extends Qwen21Base { prompt: string; size: SizeValue }
interface Qwen21Edit extends Qwen21Base { source: string; prompt: string; references: ReferenceValue[]; resolution: number }
interface Qwen21MotionPicture extends Qwen21Base { source: string; people: ReferenceValue[]; relight: boolean; replace: string; relit: string; resolution: number }

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
      // up to the 2K sizes Qwen's authors list, the largest of which (2400 × 1792) has just over 4.3 megapixels
      id: "size", type: "size", label: "Size", default: "tall", grid: 32, min: 256, max: 2752, maxPixels: 4.31e6,
      shapes: [
        { id: "tall", label: "Portrait", width: 896, height: 1152 },
        { id: "square", label: "Square", width: 1024, height: 1024 },
        { id: "wide", label: "Landscape", width: 1152, height: 896 },
        { id: "tall-9-16", label: "Portrait 9:16", width: 768, height: 1376 },
        { id: "wide-16-9", label: "Landscape 16:9", width: 1376, height: 768 },
        { id: "square-2k", label: "Square 2K", width: 2048, height: 2048 },
        { id: "tall-2k", label: "Portrait 3:4 2K", width: 1792, height: 2400 },
        { id: "wide-2k", label: "Landscape 4:3 2K", width: 2400, height: 1792 },
        { id: "tall-2-3-2k", label: "Portrait 2:3 2K", width: 1696, height: 2528 },
        { id: "wide-3-2-2k", label: "Landscape 3:2 2K", width: 2528, height: 1696 },
        { id: "tall-9-16-2k", label: "Portrait 9:16 2K", width: 1536, height: 2752 },
        { id: "wide-16-9-2k", label: "Landscape 16:9 2K", width: 2752, height: 1536 },
      ],
    },
    ...sampling,
  ],
  nodes: (input) => [...NODES(input), "EmptyLatentImage"],
  optionalNodes: ["LoraLoaderModelOnly"],
  build(input, ctx) {
    const g = new GraphBuilder();
    const k = load(g, input, ctx);
    const size = { width: roundTo(input.size.width, 32), height: roundTo(input.size.height, 32) };
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

/** What a picture read beside the canvas costs a step, against the canvas: measured at 1 MP, 545 ms a step with the picture alone, 670 with one more, 880 with two, 1060 with three. */
const PICTURE_COST = 0.4;

/**
 * What one step of an edit samples, in pixels, as the forecast reads it: its canvas (the first picture brought to about
 * `resolution` on a side, its shape kept, on a grid of 32; at 0 its own size) and the `pictures` it reads, each at
 * PICTURE_COST of it. Its graph says no size (the encoder makes the canvas): its renders were recorded with no work and
 * never learned from.
 */
function editPixels(first: { width: number; height: number } | undefined, resolution: number, pictures: number): number {
  const from = first?.width && first.height ? first : { width: 1024, height: 1024 };
  const k = resolution > 0 ? resolution / Math.sqrt(from.width * from.height) : 1;
  const canvas = roundTo(from.width * k, 32) * roundTo(from.height * k, 32);
  return Math.round(canvas * (1 + PICTURE_COST * pictures));
}

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
    const pass = { node: sampled[0], steps: input.steps, pixels: editPixels(ctx.media.source, input.resolution, pictures.length) };
    return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: input.steps, passes: [pass], loads: k.loads };
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

/** The photos as the instruction names them, every one: "<image2>", "<image2> and <image3>", "<image2>, <image3> and <image4>". */
const photoTags = (n: number) => {
  const tags = Array.from({ length: Math.max(1, n) }, (_, i) => `<image${i + 2}>`);
  return tags.length === 1 ? tags[0]! : `${tags.slice(0, -1).join(", ")} and ${tags.at(-1)}`;
};
/**
 * What puts the person in, for n photos: the head is replaced, not the person, which Qwen read as a whole person to add
 * (pasted in beside the one kept, or the man behind made them too), and every photo is named. Qwen's own edit rewriter
 * (Qwen-Image-2.1-PE-I2I) wrote it this way; made a fixed template, it gave 12 clean swaps of 12 with three photos where the
 * words before gave 3, and 6 of 6 with one (HANDOVER-motion-picture-report.md §4). No subject or footage of its own: the
 * frame's light and colour are the ones asked for.
 */
export function motionReplace(n: number): string {
  const refs = photoTags(n);
  return (
    `On <image1>, replace the head of the main person (face, hair and beard) with the head of the person shown in ${refs}, so that the result reads as the same individual as in ${n > 1 ? "those references" : refs}, with matching facial features, face shape, hair and beard. ` +
    "The new head keeps the position, angle and tilt of the head in <image1> and takes on the lighting direction and colour temperature of the <image1> scene, with skin shading and shadows consistent with its light, so that they appear naturally filmed in this scene. " +
    "Keep the body, pose, clothing, background, every other person and all other elements of <image1> completely unchanged."
  );
}
/** The default as the form shows it (one photo); sent as it is, the recipe names every photo given (motionReplace). */
export const MOTION_REPLACE = motionReplace(1);
/**
 * The second pass, on the picture the first made: into the frame's light, said as what to do. Without the photos: given
 * them, it pasted them in as more people.
 */
export const MOTION_RELIGHT =
  "Relight the main person in <image1> so that they sit in the scene's light: the same direction, colour and strength of light as on the people and the room around them, the same shadows across the face, and the same focus, noise and image quality as the rest of <image1>. " +
  "Keep their face, expression, pose, hair, clothing and everything else in <image1> exactly as it is.";
/** The first defaults (2026-10-14, written on the meme): a form that kept them gets today's. */
const FIRST_REPLACE =
  "Replace the main person in <image1> with the person in <image2>: their face, their hair, their beard and their skin. " +
  "They are lit exactly like the rest of <image1>: the same light and shadows on the face, the same soft, grainy phone-video look, so that they belong in the picture. " +
  "Keep everything else in <image1> exactly the same: their clothes, their pose, the people around them and the framing.";
const FIRST_RELIGHT =
  "Relight only the main person in <image1> so that they match the rest of the picture: the same light as on the people and the room around them, " +
  "the same shadows on their face, less light on their skin where the room is dark, and the same soft, grainy phone-video look. " +
  "Do not change their face, their hair, their expression or anything else in <image1>.";

/**
 * The picture a Motion transfer is made from, in one job: a frame of the driving video with the person of the photos put
 * in (Qwen Image 2.1 · Edit, the first person's photos as <image2>…), then relit into the frame's light by a second Edit
 * pass on what the first made: the two steps the meme test took by hand (motionPicture.tsx, the picture box of the
 * Motion transfer forms, runs it three times and lets the user pick). Without relight, the first pass alone.
 */
export const qwen21MotionPicture = defineRecipe<Qwen21MotionPicture>({
  id: "qwen21.motion-picture",
  family: "qwen21",
  version: 1,
  title: "Picture for Motion transfer",
  summary: "A frame of a video with the person of your photos put in, then relit into its light: the picture a Motion transfer moves.",
  output: "image",
  inputs: [
    model,
    { id: "source", type: "image", role: "source", label: "Frame", note: "the frame of the driving video the person is put into: <image1>" },
    {
      id: "people", type: "references", label: "Who goes in", max: 3, roles: ["person"],
      note: "photos of the person: one sharp, front-facing and well lit matters most; a second from another angle helps a frame where they are turned",
    },
    { id: "relight", type: "toggle", label: "Relight", default: true, note: "a second pass that brings the person into the frame's light and look, the face left as it is" },
    { id: "replace", type: "prompt", label: "Instruction", style: "sentences", default: MOTION_REPLACE, advanced: true, note: "what the first pass is told; <image2> on are the photos. Left as it is, it names every photo given" },
    { id: "relit", type: "prompt", label: "Relight instruction", style: "sentences", default: MOTION_RELIGHT, advanced: true, showWhen: "relight", note: "what the second pass is told" },
    { id: "resolution", type: "number", label: "Working size", min: 0, max: 2048, step: 32, default: 1024, unit: " px", advanced: true, note: "the pictures are brought to about this many pixels on a side before the model reads them" },
    ...sampling,
  ],
  nodes: (input) => [...NODES(input), "LoadImage"],
  optionalNodes: ["LoraLoaderModelOnly", FACE_NODE, FACE_AT_NODE],
  build(input, ctx) {
    const g = new GraphBuilder();
    const k = load(g, input, ctx);
    const photos = input.people.slice(0, 3).map((_, i) => ctx.uploads[`people.${i}`]);
    // the defaults (today's or the first) are worded for the photos given; words of the user's own are sent as written
    const replace = input.replace === MOTION_REPLACE || input.replace === FIRST_REPLACE ? motionReplace(photos.length) : input.replace;
    const relit = input.relit === FIRST_RELIGHT ? MOTION_RELIGHT : input.relit;
    const pass = (prompt: string, images: Ref[], seed: number) => {
      const read = g.add("TextEncodeQwenImage21", {
        clip: k.clip, prompt, negative_prompt: input.negative, resolution: input.resolution, vae: k.vae,
        ...Object.fromEntries(images.map((image, i) => [`images.image_${i + 1}`, image])),
      });
      g.phase("sampling");
      const sampled = g.out("KSampler", {
        model: k.model, positive: [read, 0], negative: [read, 1], latent_image: [read, 2], seed,
        steps: input.steps, cfg: input.cfg, sampler_name: input.sampler, scheduler: input.scheduler, denoise: 1,
      });
      g.phase("decoding");
      return { sampled, image: g.out("VAEDecode", { samples: sampled, vae: k.vae }) };
    };
    const frame = g.out("LoadImage", { image: ctx.uploads.source });
    const shots = photos.map((file) => g.out("LoadImage", { image: file }));
    const put = pass(replace, [frame, ...shots], ctx.seed);
    const lit = input.relight ? pass(relit, [put.image], ctx.seed + 1) : null;
    const made = (lit ?? put).image;
    const out = g.add("PreviewImage", { images: made });
    // how much the face where the frame's main person stands is the person of the photos, and whether they were pasted in
    // elsewhere too (the Afflatus pack's Face At, with insightface): the box ranks by it
    const score = faceScore(g, ctx, made, shots, frame);
    // the first pass reads the frame and the photos, the relight only what the first made
    const passes = [
      { node: put.sampled[0], steps: input.steps, pixels: editPixels(ctx.media.source, input.resolution, 1 + shots.length) },
      ...(lit ? [{ node: lit.sampled[0], steps: input.steps, pixels: editPixels(ctx.media.source, input.resolution, 1) }] : []),
    ];
    return {
      graph: g.graph, phases: g.phases, totalSteps: input.steps * passes.length, passes, loads: k.loads,
      outputs: [{ node: out, kind: "image", role: "result" }, ...score],
    };
  },
  variants: [
    {
      name: "a frame, two photos, relit", input: { source: "f", people: [{ asset: "a", role: "person" }, { asset: "b", role: "person" }] },
      slots: files, uploads: { source: "f.png", "people.0": "a.png", "people.1": "b.png" }, media: { source: { width: 480, height: 854 } },
    },
    { name: "without relight", input: { source: "f", people: [{ asset: "a", role: "person" }], relight: false }, slots: files, uploads: { source: "f.png", "people.0": "a.png" }, media: { source: { width: 480, height: 854 } } },
  ],
});
