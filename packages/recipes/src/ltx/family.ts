import { frameOf } from "@studai/core";
import { defineFamily } from "@studai/core";

/**
 * LTX 2.3: video with sound, from words, from a picture, or between a first and a last picture.
 *
 * The model comes in one of two ways, and either makes the family ready:
 * - one checkpoint file that holds everything (Lightricks' own, what ComfyUI's templates use);
 * - its parts as separate files (how fine-tunes and repacks are usually given): the diffusion model,
 *   the video VAE, the audio VAE and the text projection.
 * The Gemma text encoder is a file of its own both ways.
 */
export const ltx = defineFamily({
  id: "ltx",
  name: "LTX 2.3",
  summary: "Video with sound. Made from words, opens on a picture, or goes from one picture to another.",
  promptStyle: "sentences",
  slots: [
    {
      // the distilled one before the full one: it needs no LoRA and is the one made for 8 steps
      id: "checkpoint", label: "Checkpoint (single file)", folder: "checkpoints", detect: ["ltx.?2[._]?3.*distilled", "ltx.?2[._]?3"], unless: "unet",
      hint: "Put ltx-2.3-22b-distilled-fp8.safetensors in ComfyUI's models/checkpoints folder. Or have the model in separate files: a diffusion model, the two VAEs and the text projection.",
      get: { file: "ltx-2.3-22b-distilled-fp8.safetensors", url: "https://huggingface.co/Lightricks/LTX-2.3-fp8/resolve/main/ltx-2.3-22b-distilled-fp8.safetensors" },
    },
    {
      id: "unet", label: "Diffusion model (split files)", folder: "diffusion_models", detect: ["ltx.?2[._]?3"], unless: "checkpoint",
      hint: "Only when the model is not one checkpoint: put an LTX 2.3 diffusion model (a fine-tune, usually) in ComfyUI's models/diffusion_models folder.",
    },
    {
      id: "videoVae", label: "Video VAE (split files)", folder: "vae", detect: ["ltx.?2?[._]?3.*video.?vae"], unless: "checkpoint",
      hint: "Only when the model is not one checkpoint: put LTX 2.3's video VAE (LTX23_video_vae_*.safetensors) in ComfyUI's models/vae folder.",
    },
    {
      id: "audioVae", label: "Audio VAE (split files)", folder: "vae", detect: ["ltx.?2?[._]?3.*audio.?vae"], unless: "checkpoint",
      hint: "Only when the model is not one checkpoint: put LTX 2.3's audio VAE (LTX23_audio_vae_*.safetensors) in ComfyUI's models/vae folder.",
    },
    {
      id: "projection", label: "Text projection (split files)", folder: "text_encoders", detect: ["ltx.?2[._]?3.*text.?projection"], unless: "checkpoint",
      hint: "Only when the model is not one checkpoint: put ltx-2.3_text_projection_*.safetensors in ComfyUI's models/text_encoders folder.",
    },
    {
      id: "clip", label: "Text encoder (Gemma 3 12B)", folder: "text_encoders", detect: ["gemma.?3.?12b"],
      hint: "Put gemma_3_12B_it_*.safetensors in ComfyUI's models/text_encoders folder.",
      get: { file: "gemma_3_12B_it_fp4_mixed.safetensors", url: "https://huggingface.co/Comfy-Org/ltx-2/resolve/main/split_files/text_encoders/gemma_3_12B_it_fp4_mixed.safetensors" },
    },
    {
      id: "upscaler", label: "Latent upscaler (×2)", folder: "latent_upscale_models", detect: ["ltx.?2[._]?3.*spatial.?upscaler"], optional: true,
      hint: "Without it, clips are made in one pass at full size, which is slower and softer. Put ltx-2.3-spatial-upscaler-x2-*.safetensors in ComfyUI's models/latent_upscale_models folder.",
      get: { file: "ltx-2.3-spatial-upscaler-x2-1.1.safetensors", url: "https://huggingface.co/Lightricks/LTX-2.3/resolve/main/ltx-2.3-spatial-upscaler-x2-1.1.safetensors" },
    },
    {
      id: "turbo", label: "Distilled LoRA (for a model that is not distilled)", folder: "loras", detect: ["ltx.?2[._]?3.*distilled.*lora"], optional: true,
      hint: "Only for the full (dev) model: it makes it work in 8 steps. A distilled model, and most fine-tunes, need none. Put ltx_2.3_22b_distilled_*_lora_*.safetensors in ComfyUI's models/loras folder.",
      get: { file: "ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors", url: "https://huggingface.co/Comfy-Org/ltx-2.3/resolve/main/split_files/loras/ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors" },
    },
    {
      id: "tinyVae", label: "Tiny VAE (live preview)", folder: "vae_approx", detect: ["tae.?ltx.?2.?3", "tae.?ltx"], optional: true,
      hint: "Optional, 24 MB: with taeltx2_3.safetensors in ComfyUI's models/vae_approx folder, the animated live preview shows the real picture. Without it, it is a few blurred patches of colour (LTX's latent is 32 times smaller than the clip).",
      get: { file: "taeltx2_3.safetensors", url: "https://huggingface.co/Kijai/LTX2.3_comfy/resolve/main/vae/taeltx2_3.safetensors" },
    },
    {
      id: "rife", label: "Frame interpolation model (RIFE)", folder: "frame_interpolation", detect: ["rife"], optional: true,
      hint: "Without it, clips stay at 25 pictures a second. Put a RIFE model in ComfyUI's models/frame_interpolation folder.",
    },
  ],
  loraMatch: ["ltx"],
  guide: `LTX 2.3 makes the picture AND the sound (voices, effects, ambience) together.
A GOOD LTX PROMPT
- ONE flowing paragraph of natural sentences in the present tense, not tags and not a list. It reads like a shot being described as it plays, in the order things happen.
- Start with the shot: the framing and the camera ("A medium close-up, the camera slowly pushing in"), then who and where, then the action beat by beat with timing words ("at first", "then", "as she…").
- People: what they look like and wear, what their body and face do, where they look.
- Speech: write the exact words in quotes, with who says them and how ("She says quietly, in English: "What a view.""). Keep the user's words as they wrote them, never translate.
- Sound: say what is heard (footsteps on gravel, wind, a door closing, the room's ambience, music if there is any). What is not written is not reliably there.
- The light and the look: time of day, colour, lens, film or video look.
- When the clip opens on a picture, do not describe again what the picture already shows: describe what happens from there.
More detail does not mean more actions: a few actions, described precisely.`,
});

export const LTX_FPS = 25;
/** The largest canvas offered: a little over 1080p on the short edge is far more than a home card takes. Edges are multiples of 64. */
export const LTX_MAX_PIXELS = 1920 * 1088;

/** How many frames make `seconds` at 25 a second, on a count the model takes (8k + 1). */
export function ltxFrames(seconds: number): number {
  const n = Math.max(9, Math.round(seconds * LTX_FPS));
  return Math.round((n - 1) / 8) * 8 + 1;
}

/**
 * The canvas for a shape: `short` pixels on the short edge, the shape's proportions. Edges are
 * multiples of 64, so that the first pass can be made at half that size (the model's grid is 32).
 */
export function ltxCanvas(width: number, height: number, short: number): { width: number; height: number } {
  return frameOf({ width, height }, short, { grid: 64, maxPixels: LTX_MAX_PIXELS });
}
