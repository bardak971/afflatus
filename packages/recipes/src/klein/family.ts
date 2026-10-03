import { defineFamily } from "@afflatus/core";

/**
 * FLUX.2 Klein: pictures from plain sentences, and changes to a picture you have. It reads up to six
 * pictures next to the words, which is how it keeps a person, a place or clothes the same.
 */
export const klein = defineFamily({
  id: "klein",
  name: "FLUX.2 Klein",
  summary: "Photorealistic txt2img from natural-language prompts. Follows reference images and does instruction-based editing.",
  promptStyle: "sentences",
  slots: [
    {
      // the base model first, then any fine-tune of it; never one of H3's files
      id: "unet", label: "Diffusion model", folder: "diffusion_models", detect: ["^(?!.*(minimax|h3)).*flux-?2.*klein.*base", "^(?!.*(minimax|h3)).*(klein|f2k)"],
      hint: "Put a FLUX.2 Klein model (flux-2-klein-base-4b.safetensors, or a fine-tune of it) in ComfyUI's models/diffusion_models folder.",
      get: { file: "flux-2-klein-base-4b.safetensors", url: "https://huggingface.co/Comfy-Org/flux2-klein/resolve/main/split_files/diffusion_models/flux-2-klein-base-4b.safetensors" },
    },
    {
      id: "clip", label: "Text encoder", folder: "text_encoders", detect: ["qwen_?3_?4b"],
      hint: "Put qwen_3_4b.safetensors in ComfyUI's models/text_encoders folder.",
      get: { file: "qwen_3_4b.safetensors", url: "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors" },
    },
    {
      id: "vae", label: "VAE", folder: "vae", detect: ["flux-?2.*vae", "flux2"],
      hint: "Put flux2-vae.safetensors in ComfyUI's models/vae folder.",
      get: { file: "flux2-vae.safetensors", url: "https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors" },
    },
  ],
  loraMatch: ["flux-?2", "klein"],
  guide: `FLUX.2 Klein reads plain sentences, not tags.
A NEW PICTURE: describe it the way you would describe a photograph to someone who cannot see it, most important first:
1. who or what: age, build, hair, face, expression, what they wear (colour, material, fit)
2. what they do and how they stand or sit, where they look
3. where: the place with a few concrete things in it, the time of day, the weather
4. the light (soft window light, golden hour, hard flash) and the camera (close-up, waist up, full body, low angle, shallow depth of field, 35 mm)
5. the look: photorealistic, film grain, a named art style
Two to five sentences. Concrete things, no lists of quality words.
A CHANGE TO A PICTURE: write it as an instruction. Say what changes, then what must stay: "Change her dress to a red silk one. Keep her face, her hair, the pose and the room exactly the same." One change at a time works best.
REFERENCE PICTURES are numbered in the order they were given and are introduced for you; refer to them as "the person", "the place", "the dress from the picture". Never describe a face that a reference picture already shows: say it stays the same.
The part to avoid is a short list of what must not appear.`,
});

export const KLEIN_NEGATIVE = "blurry, low quality, deformed, distorted face, extra fingers, text, watermark, cartoon, illustration";
