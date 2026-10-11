import { defineFamily, type PromptLine, QUALITY_WORDS, WEIGHT_SYNTAX, wordCount } from "@afflatus/core";
import { flowRecipes, type FlowSpec } from "../flow/recipes";

const HF = "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files";

/**
 * Z-Image: pictures from plain sentences, in English or Chinese, with legible text in the picture. Written
 * blind from ComfyUI's own template (`image_z_image_turbo`): it has never been rendered here. The model
 * that is published for pictures is Turbo (distilled: 8 steps at CFG 1), and fine-tunes are made from
 * it; Z-Image Base, the undistilled one, is started on its own sampling by a preset. There is no edit model.
 */
export const zimage = defineFamily({
  id: "zimage",
  name: "Z-Image",
  summary: "txt2img from natural-language prompts in English or Chinese, in 8 steps, with legible text rendering: Z-Image Turbo and its fine-tunes.",
  promptStyle: "sentences",
  slots: [
    {
      // Turbo itself first, then any fine-tune of it (a short "zit" in the name counts); never the models that do
      // something else (Omni, Edit, the Fun and control ones). Base only when it is the one there is.
      id: "unet", label: "Diffusion model", folder: "diffusion_models",
      detect: ["^(?!.*(omni|edit|fun|control|base)).*z[ ._-]?image[ ._-]?turbo", "^(?!.*(omni|edit|fun|control)).*z[ ._-]?image", "(^|[^a-z0-9])zit([^a-z0-9]|$)"],
      hint: "Put a Z-Image model (z_image_turbo_bf16.safetensors, or a fine-tune of it) in ComfyUI's models/diffusion_models folder.",
      get: { file: "z_image_turbo_bf16.safetensors", url: `${HF}/diffusion_models/z_image_turbo_bf16.safetensors` },
    },
    {
      // Qwen3 4B, the same file FLUX.2 Klein reads with; never Krea 2's Qwen3-VL 4B, another model
      id: "clip", label: "Text encoder (Qwen3 4B)", folder: "text_encoders", detect: ["qwen_?3_?4b"],
      hint: "Put qwen_3_4b.safetensors in ComfyUI's models/text_encoders folder.",
      get: { file: "qwen_3_4b.safetensors", url: `${HF}/text_encoders/qwen_3_4b.safetensors` },
    },
    {
      // Z-Image works in the latent space of FLUX.1's VAE, named "ae": never the VAE of FLUX.2
      id: "vae", label: "VAE", folder: "vae", detect: ["z.?image.*(vae|ae)\\.", "(^|[\\\\/])ae\\.(safetensors|sft)$", "^(?!.*(flux.?2|klein)).*flux.?1?.?vae"],
      hint: "Put ae.safetensors (FLUX.1's VAE) in ComfyUI's models/vae folder.",
      get: { file: "ae.safetensors", url: `${HF}/vae/ae.safetensors` },
    },
  ],
  loraMatch: ["z[ ._-]?image", "(^|[^a-z0-9])zit([^a-z0-9]|$)"],
  guide: `Z-Image reads plain sentences, in English or Chinese, through a Qwen3 language model: long, detailed descriptions are followed closely, and its authors' own prompt enhancer writes them that way. One flowing paragraph, the subject first; 50 to 200 words is plenty.
RULES
- The medium and the subject first ("A photograph of…", "An ink illustration of…"); a medium the user named stays.
- Who or what with look, clothing, pose and expression; then the place and background, the light (where from, its colour, how hard), the camera distance and angle, the palette and the textures.
- How things relate in space, in sentences ("a lamp to the left of the bed, a window behind it").
- Text that must appear: double quotes, word for word, with where it sits and in what style ("a shop sign that reads "OPEN" in red brush lettering"); English and Chinese both render.
- Only what IS in the picture: say the wanted state, never a ban.
- No lists, no quality tags ("masterpiece, 8k"), no (word:1.2) weights: this model does not read them.
- Faithful to the user's idea: detail, not new subjects. A LoRA's trigger words stay.
- The "Negative prompt" part only acts above CFG 1 (Turbo runs at 1): leave it empty unless asked.
EXAMPLE, for the form only (its subject, place and words are not to be reused):
A photograph of an old bookbinder at a cluttered workbench, sleeves rolled up, pressing gold leaf onto the spine of a leather book with a small brass tool. Afternoon light comes through a dusty window on the left and falls across stacks of paper, spools of thread and a pot of glue. A hand-painted sign on the back wall reads "BINDERY SINCE 1952" in faded green letters. Medium shot from slightly above, shallow depth of field, warm browns and ochres.`,
  /** What the designer wrote, against Z-Image's guide: no weights, no quality words, not past what its encoder reads well. */
  lint({ text, main }) {
    if (!text?.trim()) return [];
    const out: PromptLine[] = [];
    const n = wordCount(text);
    if (n > 300) out.push({ part: main, text: `${n} words; Z-Image follows detail best under about 200.` });
    if (WEIGHT_SYNTAX.test(text)) out.push({ part: main, text: "A (word:1.2) weight: Z-Image does not read weights." });
    if (QUALITY_WORDS.test(text)) out.push({ part: main, text: "Quality words (masterpiece, 8k…): Z-Image ignores them." });
    return out;
  },
});

const spec: FlowSpec = {
  family: "zimage",
  model: {
    id: "model", type: "model", label: "Model", folder: "diffusion_models", slot: "unet", match: ["^(?!.*(omni|edit|fun|control)).*z[ ._-]?image", "(^|[^a-z0-9])zit([^a-z0-9]|$)"],
    note: "Z-Image Turbo, or a fine-tune of it",
  },
  encoder: {
    nodes: ["CLIPLoader"],
    load: (g, slots) => g.out("CLIPLoader", { clip_name: slots.clip, type: "lumina2", device: "default" }),
    files: (slots) => [`text_encoders/${slots.clip}`],
  },
  shift: { node: "ModelSamplingAuraFlow", default: 3, note: "3 is what ComfyUI's template uses. 0 leaves the model's own" },
  negative: { default: "", note: "only acts with a CFG scale above 1, which Turbo is not made for", empty: "zero" },
  sampling: {
    steps: 8, stepsNote: "8 for Turbo, as ComfyUI's template has it now; 28 to 50 for Base",
    cfg: 1, cfgNote: "1 is what Turbo is made for. Above 1 the negative prompt acts and every step takes twice as long", sampler: "res_multistep", scheduler: "simple",
  },
  // a 1.5× pass that redraws little: the authors' own 2K upscale redraws 0.33 and warns against more than 0.35
  hires: { scale: 1.5, denoise: 0.3 },
  shapes: [
    { id: "tall", label: "Portrait", width: 896, height: 1152 },
    { id: "square", label: "Square", width: 1024, height: 1024 },
    { id: "wide", label: "Landscape", width: 1152, height: 896 },
    { id: "tall-9-16", label: "Portrait 9:16", width: 720, height: 1280 },
    { id: "wide-16-9", label: "Landscape 16:9", width: 1280, height: 720 },
  ],
  megapixels: 1.6,
  // Z-Image draws up to about 2048 × 2048
  maxPixels: 4.2e6,
  presets: [
    {
      // only by its own names: a Turbo fine-tune whose name leaves out "turbo" would come out burnt at 30 steps and CFG 4
      match: "z.?image.?base|(^|[\\\\/])z_image_(bf16|fp8)",
      values: { steps: 30, cfg: 4, sampler: "res_multistep" },
      note: "Z-Image Base: not distilled, 28 to 50 steps at CFG 3 to 5, the negative prompt acts",
    },
  ],
  placeholder: "A photograph of a small bookshop at dusk, a hand-painted sign above the door that reads \"OPEN LATE\", warm light from the windows on the wet pavement.",
  files: { unet: "z_image_turbo_bf16.safetensors", clip: "qwen_3_4b.safetensors", vae: "ae.safetensors" },
  fineTune: "ZImage\\someone_zimage_turbo_v1.safetensors",
};

const made = flowRecipes(spec);
export const zimagePicture = made.picture;
export const zimageRedraw = made.redraw;
export const zimagePaintOver = made.paintOver;
export const zimageOutpaint = made.outpaint;
export const zimageSharper = made.sharper;
export const zimageFixFace = made.fixFace;
