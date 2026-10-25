import { defineFamily } from "@afflatus/core";
import { LTX_SHARED_SLOTS, ltxGuide, ltxLint } from "../ltx/family";
import { LTX25_WRONG, LTX_VERSIONS } from "../ltx/versions";

/** Where Lightricks keeps LTX 2.5's files: a gated repository (the licence accepted on its page, a Hugging Face token in Settings › Models). */
const HF = "https://huggingface.co/Lightricks/LTX-2.5/resolve/main";
const GATED = "Lightricks gates the files: accept the licence on huggingface.co/Lightricks/LTX-2.5 and put a Hugging Face token in Settings › Models, then Download works";

/**
 * LTX 2.5 (Lightricks, 2026-08-11): video with sound as LTX 2.3, on a new latent space and VAE, with a Gemma 4 text
 * encoder that carries the text projection inside its file, 24 frames a second, `euler_ancestral` in both passes and a
 * guider that scales the picture and the sound apart. Its files are the ones ComfyUI's own template loads (the int8
 * convrot distilled transformer), always as split files: there is no one-file checkpoint.
 */
export const ltx25 = defineFamily({
  id: "ltx25",
  name: "LTX 2.5",
  summary: "Video with audio, LTX's newer model: t2v, i2v from a first frame, or from a first to a last frame, through a keyframe if wanted; several shots in one prompt.",
  help: {
    what: "Video with sound, from words or pictures, from a first to a last frame through a keyframe; two to four shots in one prompt.",
    best: "several shots in one clip, cuts named in the prompt; the same two-pass render as LTX 2.3",
    weak: "newer, less measured here than 2.3: compare them on the same prompts; its files are gated on Hugging Face",
  },
  promptStyle: "sentences",
  slots: [
    {
      // the distilled one before the full one: it needs no LoRA and is the one made for 8 steps
      id: "unet", label: "Diffusion model", folder: "diffusion_models", detect: ["ltx.?2[._]?5.*distilled.*transformer", "ltx.?2[._]?5.*transformer", "ltx.?2[._]?5"],
      hint: `Put ltx-2.5-22b-distilled-transformer-*.safetensors in ComfyUI's models/diffusion_models folder. ${GATED}.`,
      get: { file: "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors", url: `${HF}/diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors` },
    },
    {
      id: "clip", label: "Text encoder (Gemma 4 12B, with the projection)", folder: "text_encoders", detect: ["gemma.?4.*ltx.?2[._]?5", "gemma.?4.*with.?proj"],
      hint: `Put gemma4-12b-with-proj-ltx-2.5-*.safetensors in ComfyUI's models/text_encoders folder (LTX 2.5's text projection is inside it). ${GATED}.`,
      get: { file: "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors", url: `${HF}/text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors` },
    },
    {
      // the full VAE before the lighter conv one
      id: "videoVae", label: "Video VAE", folder: "vae", detect: ["ltx.?2[._]?5.*video.?vae(?!.*conv)", "ltx.?2[._]?5.*video.?vae"],
      hint: `Put ltx-2.5-video-vae-*.safetensors in ComfyUI's models/vae folder. ${GATED}.`,
      get: { file: "ltx-2.5-video-vae-bf16.safetensors", url: `${HF}/vae/ltx-2.5-video-vae-bf16.safetensors` },
    },
    {
      id: "audioVae", label: "Audio VAE", folder: "vae", detect: ["ltx.?2[._]?5.*audio.?vae"],
      hint: `Put ltx-2.5-audio-vae-*.safetensors in ComfyUI's models/vae folder. ${GATED}.`,
      get: { file: "ltx-2.5-audio-vae-bf16.safetensors", url: `${HF}/vae/ltx-2.5-audio-vae-bf16.safetensors` },
    },
    {
      id: "upscaler", label: "Latent upscaler (×2)", folder: "latent_upscale_models", detect: ["ltx.?2[._]?5.*spatial.?upscaler.?x2"], optional: true,
      hint: "Without it, clips are generated in one pass at full resolution, which is slower and softer. Put ltx-2.5-latent-spatial-upscaler-x2-*.safetensors in ComfyUI's models/latent_upscale_models folder.",
      get: { file: "ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors", url: `${HF}/latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors` },
    },
    {
      id: "temporal", label: "Temporal upscaler (×2 frame rate, latent)", folder: "latent_upscale_models", detect: ["ltx.?2[._]?5.*temporal.?upscaler"], optional: true,
      hint: "Optional: with ltx-2.5-latent-temporal-upscaler-x2-*.safetensors in ComfyUI's models/latent_upscale_models folder, Frame interpolation can double the frame rate in latent space with LTX's own model (motion-aware) instead of RIFE on the pixels.",
      get: { file: "ltx-2.5-latent-temporal-upscaler-x2-bf16-1.0.safetensors", url: `${HF}/latent_upscale_models/ltx-2.5-latent-temporal-upscaler-x2-bf16-1.0.safetensors` },
    },
    {
      id: "turbo", label: "Distilled LoRA (for the dev model)", folder: "loras", detect: ["ltx.?2[._]?5.*distilled.*lora"], optional: true,
      hint: "Only for the full (dev) transformer: it makes it work in 8 steps. The distilled transformer needs none. Put ltx-2.5-22b-distilled-lora-*.safetensors in ComfyUI's models/loras folder.",
      get: { file: "ltx-2.5-22b-distilled-lora-450-bf16.safetensors", url: `${HF}/loras/ltx-2.5-22b-distilled-lora-450-bf16.safetensors` },
    },
    {
      // Licon Studio's MSR V2 (Apache-2.0, not gated): each reference picture in a slot of its own, and a voice for the first
      // two; its slot embeddings are inside the file, read by its own pack's loader (a plain LoRA loader drops them)
      id: "msr", label: "Reference LoRA (MSR)", folder: "loras", detect: ["licon.?msr", "ltx.?2[._]?5.*msr"], optional: true,
      hint: "Without it, LTX 2.5 leaves the cast's pictures and voice out: the clip is made from the words and LoRAs alone. Put LTX-2.5-Licon-MSR-V2.safetensors in ComfyUI's models/loras folder, with the ComfyUI-LTX2.5-MSR node pack (its loader reads the pictures' slots from the file).",
      get: { file: "LTX-2.5-Licon-MSR-V2.safetensors", url: "https://huggingface.co/LiconStudio/LTX-2.5-Multiple-Subject-Reference/resolve/main/LTX-2.5-Licon-MSR-V2.safetensors" },
    },
    {
      id: "tinyVae", label: "Tiny VAE (live preview)", folder: "vae_approx", detect: ["tae.?ltx.?2.?5"], optional: true,
      hint: "Optional: with a taeltx2_5 tiny VAE in ComfyUI's models/vae_approx folder, the animated live preview shows the real frames. Without it, it is a few blurred patches of colour.",
    },
    ...LTX_SHARED_SLOTS,
  ],
  loraMatch: ["ltx"],
  line: { own: "LTX 2.5", versions: LTX_VERSIONS },
  wrong: LTX25_WRONG,
  guide: ltxGuide("LTX 2.5", [
    "Several shots (2.5 only): two to four in one clip, each cut named in the prose as it happens (\"Cut to a wide shot of the harbour at dusk.\"), each shot a sentence or two in order; one clip of one shot needs none of this.",
  ]),
  lint: ltxLint,
});

export const LTX25_FPS = 24;
