import { defineFamily, type PromptLine, QUALITY_WORDS, WEIGHT_SYNTAX, wordCount } from "@afflatus/core";

/**
 * FLUX.2 Klein: pictures from plain sentences, and changes to a picture you have. It reads up to six
 * pictures next to the words, which is how it keeps a person, a place or clothes the same.
 */
export const klein = defineFamily({
  id: "klein",
  name: "FLUX.2 Klein",
  summary: "Photorealistic txt2img from natural-language prompts. Follows reference images and does instruction-based editing.",
  help: {
    what: "Photoreal pictures from sentences, edits by instruction, guided by reference pictures.",
    best: "photos; edits guided by reference pictures",
    weak: "on the small 4B model, edits rougher than Qwen Image 2.1's in Afflatus's tests",
  },
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
      // or the small decoder ComfyUI's Klein edit templates ship with (the full encoder, a faster decoder)
      id: "vae", label: "VAE", folder: "vae", detect: ["flux-?2.*vae", "flux2", "full_encoder_small_decoder"],
      hint: "Put flux2-vae.safetensors (or full_encoder_small_decoder.safetensors) in ComfyUI's models/vae folder.",
      get: { file: "flux2-vae.safetensors", url: "https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors" },
    },
  ],
  loraMatch: ["flux-?2", "klein"],
  guide: `FLUX.2 Klein reads plain sentences, not tags, and its guide says prompt following depends on how the prompt is written: what comes first weighs most. Subject + Action + Style + Context, 30 to 100 words, two to five sentences. No negative prompt, no weights.
RULES FOR A NEW PICTURE
1. who or what: age, build, hair, face, expression, clothing (colour, material, fit)
2. what they do, how they stand or sit, where they look
3. where: the place with a few concrete things, the time of day, the weather
4. the light (soft window light, golden hour, hard flash) and the camera (close-up, waist up, full body, low angle, a wide or a long lens): only what this picture calls for
5. the look: photorealistic, film grain, a named art style. One style register per prompt.
- Colours bound to a thing ("a jacket in cobalt blue"; a hex value works: "the jacket in colour #0047AB").
- Text that must appear: double quotes, with placement, typeface style, size and colour.
- Only what IS wanted: say the wanted state, never a ban.
RULES FOR A CHANGE TO A PICTURE
- An instruction: what changes, then what must stay ("Change her dress to a red silk one. Keep her face, her hair, the pose and the room exactly the same."). One change at a time. "Preserving its exact proportions", "keep the lighting and the background" hold things in place.
- Reference pictures are numbered in the order given and introduced for you: give each a role by number ("the person from image 1 wearing the jacket from image 2"); more than three blend identities. Never describe a face a reference already shows: say it stays the same.
- The "Negative prompt" part only acts above CFG 1 (an undistilled model): leave it empty unless asked.
- Faithful to the user's idea: detail, not new subjects. A LoRA's trigger words stay.
EXAMPLES, for the form only (their subjects, places and words are not to be reused):
A new picture: A small terrier wrapped in a white towel after a bath, photographed with direct flash and high exposure, the wet fur sharply detailed, sitting on the edge of a tub in a tiled bathroom. An editorial raw portrait with harsh flash light, intimate and humorous, in a documentary style.
A change: Place the pocket watch from image 1 on the oak desk from image 2, preserving its exact proportions and the desk's lighting; keep everything else in image 2 as it is.`,
  /** What the designer wrote, against Klein's guide: no weights, no quality words, 30 to 100 words. */
  lint({ text, main }) {
    if (!text?.trim()) return [];
    const out: PromptLine[] = [];
    if (WEIGHT_SYNTAX.test(text)) out.push({ part: main, text: "A (word:1.2) weight: this model does not read weights." });
    if (QUALITY_WORDS.test(text)) out.push({ part: main, text: "Quality words (masterpiece, 8k…): this model ignores them." });
    const n = wordCount(text);
    if (n > 170) out.push({ part: main, text: `${n} words; 30 to 100 is the range that works.` });
    return out;
  },
});
