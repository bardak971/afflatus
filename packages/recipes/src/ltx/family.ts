import { frameOf, type PromptLine, LIST_LINE, wordCount } from "@afflatus/core";
import { defineFamily } from "@afflatus/core";
import { SEEDVR_SLOTS } from "../video/upscale";

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
  summary: "Video with audio. t2v, i2v from a first frame, or from a first to a last frame, through a keyframe if wanted.",
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
      get: { file: "LTX23_video_vae_bf16.safetensors", url: "https://huggingface.co/Kijai/LTX2.3_comfy/resolve/main/vae/LTX23_video_vae_bf16.safetensors" },
    },
    {
      id: "audioVae", label: "Audio VAE (split files)", folder: "vae", detect: ["ltx.?2?[._]?3.*audio.?vae"], unless: "checkpoint",
      hint: "Only when the model is not one checkpoint: put LTX 2.3's audio VAE (LTX23_audio_vae_*.safetensors) in ComfyUI's models/vae folder.",
      get: { file: "LTX23_audio_vae_bf16.safetensors", url: "https://huggingface.co/Kijai/LTX2.3_comfy/resolve/main/vae/LTX23_audio_vae_bf16.safetensors" },
    },
    {
      id: "projection", label: "Text projection (split files)", folder: "text_encoders", detect: ["ltx.?2[._]?3.*text.?projection"], unless: "checkpoint",
      hint: "Only when the model is not one checkpoint: put ltx-2.3_text_projection_*.safetensors in ComfyUI's models/text_encoders folder.",
      get: { file: "ltx-2.3_text_projection_bf16.safetensors", url: "https://huggingface.co/Kijai/LTX2.3_comfy/resolve/main/text_encoders/ltx-2.3_text_projection_bf16.safetensors" },
    },
    {
      id: "clip", label: "Text encoder (Gemma 3 12B)", folder: "text_encoders", detect: ["gemma.?3.?12b"],
      hint: "Put gemma_3_12B_it_*.safetensors in ComfyUI's models/text_encoders folder.",
      get: { file: "gemma_3_12B_it_fp4_mixed.safetensors", url: "https://huggingface.co/Comfy-Org/ltx-2/resolve/main/split_files/text_encoders/gemma_3_12B_it_fp4_mixed.safetensors" },
    },
    {
      id: "upscaler", label: "Latent upscaler (×2)", folder: "latent_upscale_models", detect: ["ltx.?2[._]?3.*spatial.?upscaler.?x2"], optional: true,
      hint: "Without it, clips are generated in one pass at full resolution, which is slower and softer. Put ltx-2.3-spatial-upscaler-x2-*.safetensors in ComfyUI's models/latent_upscale_models folder.",
      get: { file: "ltx-2.3-spatial-upscaler-x2-1.1.safetensors", url: "https://huggingface.co/Lightricks/LTX-2.3/resolve/main/ltx-2.3-spatial-upscaler-x2-1.1.safetensors" },
    },
    {
      id: "temporal", label: "Temporal upscaler (×2 frame rate, latent)", folder: "latent_upscale_models", detect: ["ltx.?2[._]?3.*temporal.?upscaler"], optional: true,
      hint: "Optional: with ltx-2.3-temporal-upscaler-x2-*.safetensors in ComfyUI's models/latent_upscale_models folder, Frame interpolation can double the frame rate in latent space with LTX's own model (motion-aware) instead of RIFE on the pixels.",
      get: { file: "ltx-2.3-temporal-upscaler-x2-1.0.safetensors", url: "https://huggingface.co/Lightricks/LTX-2.3/resolve/main/ltx-2.3-temporal-upscaler-x2-1.0.safetensors" },
    },
    {
      id: "turbo", label: "Distilled LoRA (for a model that is not distilled)", folder: "loras", detect: ["ltx.?2[._]?3.*distilled.*lora"], optional: true,
      hint: "Only for the full (dev) model: it makes it work in 8 steps. A distilled model, and most fine-tunes, need none. Put ltx_2.3_22b_distilled_*_lora_*.safetensors in ComfyUI's models/loras folder.",
      get: { file: "ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors", url: "https://huggingface.co/Comfy-Org/ltx-2.3/resolve/main/split_files/loras/ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors" },
    },
    {
      id: "tinyVae", label: "Tiny VAE (live preview)", folder: "vae_approx", detect: ["tae.?ltx.?2.?3", "tae.?ltx"], optional: true,
      hint: "Optional, 24 MB: with taeltx2_3.safetensors (tiny VAE) in ComfyUI's models/vae_approx folder, the animated live preview shows the real frames. Without it, it is a few blurred patches of colour (LTX's latent is 32 times smaller than the clip).",
      get: { file: "taeltx2_3.safetensors", url: "https://huggingface.co/Kijai/LTX2.3_comfy/resolve/main/vae/taeltx2_3.safetensors" },
    },
    {
      id: "rife", label: "Frame interpolation model (RIFE)", folder: "frame_interpolation", detect: ["rife"], optional: true,
      hint: "Without it (and without the temporal upscaler), no frame interpolation: clips stay at 25 fps. Put a RIFE model in ComfyUI's models/frame_interpolation folder.",
    },
    ...SEEDVR_SLOTS,
  ],
  loraMatch: ["ltx"],
  guide: `LTX 2.3 makes the picture AND the sound together, and reads the prompt literally: what is written happens, in that order. ONE flowing paragraph in the present tense, chronological, 60 to 200 words, about a sentence per second of clip; no headers, lists or tags.
RULES
- Start with the main action, as a cinematographer describing a shot as it plays.
- In order: shot size, camera move and where it ends; setting, time of day, light; the subject (age, clothing, features); the actions as they happen; the look (palette, film stock, grain); and LAST the audio.
- The audio sentence is mandatory: "The audio is …" with ambience, effects and any music; "no music" said plainly when wanted. What is not written is not reliably heard.
- Speech in quotation marks inside the paragraph, with who says it and how ("She says quietly, in English: "What a view.""); the voice described physically (low and resonant, a whisper, an accent). One speaker at a time. The user's words stay as written, never translated.
- A talking face needs small motion between phrases (an eyebrow lifts, the eyes move) or it freezes. Camera still or slow while someone speaks.
- Say the layout outright: left and right, foreground and background, who faces where.
- Physical cues instead of feelings: "her jaw tightens", not "she is angry".
- One or two actions per clip; no readable text or logos, no crowds, no many-body physics.
- A first-frame picture: write only what moves and how the camera moves, never the picture again.
- A keyframe picture: the clip passes through it at its moment; write the action that leads into it and on from it, in order, never the picture again.
- The "Negative prompt" part only acts above CFG 1 (the distilled models run at 1): leave it alone unless asked. No weights, no quality words.
EXAMPLE, for the form only (its subject, place and words are not to be reused):
A saxophone player in a wrinkled suit plays a slow melody with his eyes closed, swaying gently, in a dimly lit 1950s New York jazz club. Smoke curls through amber spotlights behind him; a few patrons at small tables to the left cradle drinks in blue shadow. Medium shot from a slightly low angle, the camera pushing in slowly and settling on his face as he opens his eyes mid-phrase. Warm amber light on him, deep blue shadows, a film noir palette with soft grain. The audio is the slow saxophone line over the clink of glasses and low murmured conversation, no other music.`,
  /** What the designer wrote, against LTX's guide: one flowing paragraph, an audio sentence, at most 200 words. */
  lint({ text, main }) {
    if (!text?.trim()) return [];
    const out: PromptLine[] = [];
    const n = wordCount(text);
    if (!/\b(audio|sound|hear|heard|ambien|music|silen)/i.test(text)) out.push({ part: main, text: "No audio sentence: LTX makes the sound too, and what is not written is not reliably heard. End with \"The audio is …\"." });
    if (n > 220) out.push({ part: main, text: `${n} words; the model's guide stops at 200.` });
    if (LIST_LINE.test(text)) out.push({ part: main, text: "A list: LTX wants one flowing paragraph." });
    return out;
  },
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
