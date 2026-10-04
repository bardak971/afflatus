import { defineFamily } from "@afflatus/core";

const HF = "https://huggingface.co/Comfy-Org/Krea-2/resolve/main";

/**
 * Krea 2: pictures from plain sentences. The model that is published is Turbo (distilled: 8 steps, no
 * negative prompt), and fine-tunes are made from it. It is built here the way ComfyUI's own Krea 2
 * templates build it; the style of reference images is followed with a LoRA made for that.
 */
export const krea2 = defineFamily({
  id: "krea2",
  name: "Krea 2",
  summary: "txt2img from natural-language prompts, in 8 steps. Follows the style of reference images with its style-reference LoRA.",
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
      hint: "Without it, images cannot follow the style of reference images. Put krea2_style_reference.safetensors in ComfyUI's models/loras folder.",
      get: { file: "krea2_style_reference.safetensors", url: `${HF}/loras/krea2_style_reference.safetensors` },
    },
  ],
  loraMatch: ["krea.?2", "(^|[^a-z0-9])k2([^a-z0-9]|$)"],
  guide: `Krea 2 reads plain sentences through a vision-language encoder: grammar, possessives, counts and spatial relations are understood; quality confetti ("masterpiece, 8k") is ignored. One flowing description, 30 to 150 words, as to a skilled visual artist.
RULES
- The medium and the subject first ("A photograph of…", "A watercolour illustration of…"); a medium the user named stays.
- Each subject with its own attributes and what it does; then how the subjects relate in space, in sentences ("two cups to the left of the laptop").
- Then the place and background, the light (where from, its colour, how hard), the camera distance and composition (close-up, waist up, low angle, centred or off to one side), the palette and the textures.
- A style is better described than named: the medium and its characteristics (linework, brush, grain, era, tradition) rather than a bare artist's name.
- Text that must appear: double quotes, word for word.
- Faithful: every subject, action and colour the user gave stays; no people, animals or props they did not ask for; no invented specifics. A detailed request is polished lightly, not rewritten.
- No lists, no quality tags, no (word:1.2) weights: here the weight syntax scales the whole prompt and breaks past 1.2.
- The "Negative prompt" part only acts above CFG 1 (Turbo runs at 1): leave it empty unless asked. A LoRA's trigger words stay.
EXAMPLE, for the form only (its subject, place and words are not to be reused):
A minimalist flat-colour illustration of a person wading through expansive shallow ocean waves beneath a pale peach sky. The figure is small against the water, placed low and to the right, the horizon a single clean line two thirds of the way up. Three flat tones only, sand, sea green and peach; no outlines and no texture, the shapes built from colour alone, in the manner of mid-century travel posters.`,
});
