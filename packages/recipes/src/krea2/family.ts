import { defineFamily } from "@studai/core";

const HF = "https://huggingface.co/Comfy-Org/Krea-2/resolve/main";

/**
 * Krea 2: pictures from plain sentences. The model that is published is Turbo (distilled: 8 steps, no
 * negative prompt), and fine-tunes are made from it. It is built here the way ComfyUI's own Krea 2
 * templates build it; the style of reference images is followed with a LoRA made for that.
 */
export const krea2 = defineFamily({
  id: "krea2",
  name: "Krea 2",
  summary: "Pictures from plain sentences, in 8 steps. Follows the style of reference images with its style-reference LoRA.",
  promptStyle: "sentences",
  slots: [
    {
      // Turbo itself first, then any fine-tune of it (a folder named for it counts)
      id: "unet", label: "Diffusion model", folder: "diffusion_models", detect: ["krea.?2.*turbo", "krea.?2", "(^|[^a-z0-9])k2([^a-z0-9]|$)"],
      hint: "Put a Krea 2 model (krea2_turbo_fp8_scaled.safetensors, or a fine-tune of it) in ComfyUI's models/diffusion_models folder.",
      get: { file: "krea2_turbo_fp8_scaled.safetensors", url: `${HF}/diffusion_models/krea2_turbo_fp8_scaled.safetensors` },
    },
    {
      id: "clip", label: "Text encoder", folder: "text_encoders", detect: ["qwen3vl_?4b"],
      hint: "Put qwen3vl_4b_fp8_scaled.safetensors in ComfyUI's models/text_encoders folder.",
      get: { file: "qwen3vl_4b_fp8_scaled.safetensors", url: `${HF}/text_encoders/qwen3vl_4b_fp8_scaled.safetensors` },
    },
    {
      // Krea 2 works in the latent space of the Qwen Image VAE, which is also that of the Wan 2.1 VAE
      id: "vae", label: "VAE", folder: "vae", detect: ["qwen_image_vae", "wan_?2[._]?1.*vae"],
      hint: "Put qwen_image_vae.safetensors (or the Wan 2.1 VAE) in ComfyUI's models/vae folder.",
      get: { file: "qwen_image_vae.safetensors", url: `${HF}/vae/qwen_image_vae.safetensors` },
    },
    {
      id: "styleRef", label: "Style reference LoRA", folder: "loras", detect: ["krea.?2.*style.?ref"], optional: true,
      hint: "Without it, pictures cannot follow the style of reference images. Put krea2_style_reference.safetensors in ComfyUI's models/loras folder.",
      get: { file: "krea2_style_reference.safetensors", url: `${HF}/loras/krea2_style_reference.safetensors` },
    },
  ],
  loraMatch: ["krea.?2", "(^|[^a-z0-9])k2([^a-z0-9]|$)"],
  guide: `Krea 2 reads plain sentences, not tags, and it reads them closely: write one cohesive paragraph.
A GOOD KREA 2 PROMPT
- Start with the medium and the subject: "A photograph of…", "A watercolour illustration of…". When the user names a medium, keep it.
- Group each subject with its own attributes and what it does: who, how they look, what they wear, their pose and expression. Then how the subjects relate in space (left, right, behind, in the foreground).
- Then the place and the background, the light (where it comes from, its colour, how hard it is) and the camera or composition (close-up, waist up, low angle, shallow depth of field).
- Colours, materials, textures and quantities said plainly: the model is trained to notice colour, shape, size, texture, quantity, text and spatial relationships.
- Text that must appear in the picture goes in quotes, word for word.
- Stay faithful: keep every subject, action and colour the user gave; do not add people, animals or props they did not ask for, and do not invent very specific clothing or details the request does not support.
- If the request is already detailed, polish it lightly instead of rewriting it.
No lists, no weights, no quality tags. Three to six sentences are usually right.
The negative prompt only acts when the CFG scale is above 1 (Turbo runs at 1): leave it empty unless the user asks.
A LoRA's trigger words must stay in the prompt for it to act.`,
});
