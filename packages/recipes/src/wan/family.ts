import { defineFamily } from "@studai/core";

/** Where ComfyUI's own templates fetch Wan 2.2's files from. */
const HF = "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files";

/**
 * Wan 2.2 (the 14B models): video without sound, from a picture, from a first and a last picture, or
 * from words. It comes as two models that share a clip: one for the first, noisy steps (where the
 * motion and the composition are decided) and one for the last ones (the detail). The files are the
 * ones ComfyUI's own templates use; fine-tunes are found by name the same way.
 */
export const wan = defineFamily({
  id: "wan",
  name: "Wan 2.2",
  summary: "Video without sound. Opens on a picture, ends on one, or is made from words alone.",
  promptStyle: "sentences",
  slots: [
    {
      // the official files before a fine-tune, which is named any way its author liked
      id: "i2vHigh", label: "Picture to video: high-noise model", folder: "diffusion_models", detect: ["wan2[._]2_i2v_high_noise_14b", "wan.?2[._]?2.*i2v.*high"],
      hint: "Put wan2.2_i2v_high_noise_14B_*.safetensors, or a Wan 2.2 I2V fine-tune's high-noise file, in ComfyUI's models/diffusion_models folder.",
      get: { file: "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors", url: `${HF}/diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors` },
    },
    {
      id: "i2vLow", label: "Picture to video: low-noise model", folder: "diffusion_models", detect: ["wan2[._]2_i2v_low_noise_14b", "wan.?2[._]?2.*i2v.*low"],
      hint: "Put wan2.2_i2v_low_noise_14B_*.safetensors, or a Wan 2.2 I2V fine-tune's low-noise file, in ComfyUI's models/diffusion_models folder.",
      get: { file: "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors", url: `${HF}/diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors` },
    },
    {
      id: "clip", label: "Text encoder", folder: "text_encoders", detect: ["umt5.?xxl"],
      hint: "Put umt5_xxl_fp8_e4m3fn_scaled.safetensors in ComfyUI's models/text_encoders folder.",
      get: { file: "umt5_xxl_fp8_e4m3fn_scaled.safetensors", url: "https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors" },
    },
    {
      id: "vae", label: "VAE", folder: "vae", detect: ["wan.?2[._]?1.?vae"],
      hint: "Put wan_2.1_vae.safetensors in ComfyUI's models/vae folder (the 14B models use Wan 2.1's VAE).",
      get: { file: "wan_2.1_vae.safetensors", url: `${HF}/vae/wan_2.1_vae.safetensors` },
    },
    {
      id: "t2vHigh", label: "Words to video: high-noise model", folder: "diffusion_models", detect: ["wan2[._]2_t2v_high_noise_14b", "wan.?2[._]?2.*t2v.*high"], optional: true,
      hint: "Without the two words-to-video models, a clip needs a start image. Put wan2.2_t2v_high_noise_14B_*.safetensors in ComfyUI's models/diffusion_models folder.",
      get: { file: "wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors", url: `${HF}/diffusion_models/wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors` },
    },
    {
      id: "t2vLow", label: "Words to video: low-noise model", folder: "diffusion_models", detect: ["wan2[._]2_t2v_low_noise_14b", "wan.?2[._]?2.*t2v.*low"], optional: true,
      hint: "Without the two words-to-video models, a clip needs a start image. Put wan2.2_t2v_low_noise_14B_*.safetensors in ComfyUI's models/diffusion_models folder.",
      get: { file: "wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors", url: `${HF}/diffusion_models/wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors` },
    },
    {
      id: "i2vTurboHigh", label: "Turbo LoRA, picture to video, high noise", folder: "loras", detect: ["wan.?2[._]?2.*i2v.*lightx2v.*high", "lightx2v.*i2v.*high"], optional: true,
      hint: "Without the two turbo LoRAs, Turbo is off for a model that is not distilled itself, and clips take the full number of steps. Put the lightx2v 4-step LoRAs for Wan 2.2 I2V in ComfyUI's models/loras folder.",
      get: { file: "wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors", url: `${HF}/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors` },
    },
    {
      id: "i2vTurboLow", label: "Turbo LoRA, picture to video, low noise", folder: "loras", detect: ["wan.?2[._]?2.*i2v.*lightx2v.*low", "lightx2v.*i2v.*low"], optional: true,
      hint: "The low-noise half of the turbo LoRAs for picture to video.",
      get: { file: "wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors", url: `${HF}/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors` },
    },
    {
      id: "t2vTurboHigh", label: "Turbo LoRA, words to video, high noise", folder: "loras", detect: ["wan.?2[._]?2.*t2v.*lightx2v.*high", "lightx2v.*t2v.*high"], optional: true,
      hint: "The turbo LoRAs for words to video: without them those clips take the full number of steps.",
      get: { file: "wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors", url: `${HF}/loras/wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors` },
    },
    {
      id: "t2vTurboLow", label: "Turbo LoRA, words to video, low noise", folder: "loras", detect: ["wan.?2[._]?2.*t2v.*lightx2v.*low", "lightx2v.*t2v.*low"], optional: true,
      hint: "The low-noise half of the turbo LoRAs for words to video.",
      get: { file: "wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors", url: `${HF}/loras/wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors` },
    },
    {
      id: "rife", label: "Smooth motion (RIFE)", folder: "frame_interpolation", detect: ["rife"], optional: true,
      hint: "Without it, clips stay at 16 pictures a second. Put a RIFE model in ComfyUI's models/frame_interpolation folder.",
    },
  ],
  loraMatch: ["wan"],
  guide: `Wan 2.2 makes video WITHOUT sound: nobody is heard, so write no dialogue.
A GOOD WAN PROMPT
- Natural sentences in the present tense, not tags. One continuous shot of a few seconds: a few actions, in the order they happen ("she turns, then smiles").
- Say what MOVES and how: the body (hands, head, hips, steps), the physics (hair, fabric, water, smoke), the speed ("slowly", "suddenly").
- The camera, when it moves: one move, named plainly ("the camera pushes in slowly", "the camera orbits to the left", "static shot").
- The look: the light, the time of day, the lens or the style ("cinematic, shallow depth of field", "handheld").
- When the clip opens on a picture, do not describe again what the picture already shows: describe what happens from there.
More detail does not mean more actions: describe the same few actions precisely.`,
});

export const WAN_FPS = 16;
/** The 14B models' largest canvas: 720p. Both edges are multiples of 16. */
const WAN_MAX_PIXELS = 1280 * 720;

/** How many frames make `seconds` at 16 a second, on a count the model takes (4k + 1). */
export function wanFrames(seconds: number): number {
  const n = Math.max(5, Math.round(seconds * WAN_FPS));
  return Math.ceil((n - 1) / 4) * 4 + 1;
}

/** The canvas for a shape: `short` pixels on the short edge, the shape's proportions, within what the model takes. */
export function wanCanvas(width: number, height: number, short: number): { width: number; height: number } {
  const r = width / height;
  let w = r >= 1 ? short * r : short;
  let h = r >= 1 ? short : short / r;
  if (w * h > WAN_MAX_PIXELS) {
    const k = Math.sqrt(WAN_MAX_PIXELS / (w * h));
    w *= k;
    h *= k;
  }
  const r16 = (n: number) => Math.max(16, Math.round(n / 16) * 16);
  let W = r16(w);
  let H = r16(h);
  // rounding can land just over the largest the model takes: the long edge gives way (both, for a square)
  while (W * H > WAN_MAX_PIXELS) {
    if (W >= H) W -= 16;
    if (H > W || W + 16 === H) H -= 16;
  }
  return { width: W, height: H };
}
