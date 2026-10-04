import { frameOf } from "@afflatus/core";
import { defineFamily } from "@afflatus/core";

/** Where ComfyUI's own templates fetch Wan 2.2's files from. */
const HF = "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files";
/** lightx2v's own 4-step LoRAs, the newer ones (Oct and Dec 2025): better motion than the v1 files ComfyUI's templates link. */
const LIGHTX2V = "https://huggingface.co/lightx2v/Wan2.2-Distill-Loras/resolve/main";

/**
 * Wan 2.2 (the 14B models): video without sound, from a picture, from a first and a last picture, or
 * from words. It comes as two models that share a clip: one for the first, noisy steps (where the
 * motion and the composition are decided) and one for the last ones (the detail). The files are the
 * ones ComfyUI's own templates use; fine-tunes are found by name the same way.
 */
export const wan = defineFamily({
  id: "wan",
  name: "Wan 2.2",
  summary: "Video without audio. i2v from a first frame, first and last frame, or t2v.",
  promptStyle: "sentences",
  slots: [
    {
      // the official files before a fine-tune, which is named any way its author liked
      id: "i2vHigh", label: "i2v high-noise model", folder: "diffusion_models", detect: ["wan2[._]2_i2v_high_noise_14b", "wan.?2[._]?2.*i2v.*high"],
      hint: "Put wan2.2_i2v_high_noise_14B_*.safetensors, or a Wan 2.2 I2V fine-tune's high-noise file, in ComfyUI's models/diffusion_models folder.",
      get: { file: "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors", url: `${HF}/diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors` },
    },
    {
      id: "i2vLow", label: "i2v low-noise model", folder: "diffusion_models", detect: ["wan2[._]2_i2v_low_noise_14b", "wan.?2[._]?2.*i2v.*low"],
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
      id: "t2vHigh", label: "t2v high-noise model", folder: "diffusion_models", detect: ["wan2[._]2_t2v_high_noise_14b", "wan.?2[._]?2.*t2v.*high"], optional: true,
      hint: "Without the two t2v models, a clip needs a first frame. Put wan2.2_t2v_high_noise_14B_*.safetensors in ComfyUI's models/diffusion_models folder.",
      get: { file: "wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors", url: `${HF}/diffusion_models/wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors` },
    },
    {
      id: "t2vLow", label: "t2v low-noise model", folder: "diffusion_models", detect: ["wan2[._]2_t2v_low_noise_14b", "wan.?2[._]?2.*t2v.*low"], optional: true,
      hint: "Without the two t2v models, a clip needs a first frame. Put wan2.2_t2v_low_noise_14B_*.safetensors in ComfyUI's models/diffusion_models folder.",
      get: { file: "wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors", url: `${HF}/diffusion_models/wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors` },
    },
    {
      // the words in any order: lightx2v names them "wan2.2_i2v_…_high_noise_lora_…_lightx2v_4step", Kijai "Wan22_…_I2V_HIGH_Lightning_4steps…"
      id: "i2vTurboHigh", label: "Turbo LoRA (i2v, high noise)", folder: "loras", detect: ["^(?=.*i2v)(?=.*(lightx2v|lightning))(?=.*high)"], optional: true,
      hint: "Without the two turbo LoRAs, Turbo is off for a model that is not distilled itself, and clips take the full step count. Put the lightx2v 4-step LoRAs for Wan 2.2 I2V in ComfyUI's models/loras folder.",
      get: { file: "wan2.2_i2v_A14b_high_noise_lora_rank64_lightx2v_4step_1022.safetensors", url: `${LIGHTX2V}/wan2.2_i2v_A14b_high_noise_lora_rank64_lightx2v_4step_1022.safetensors` },
    },
    {
      id: "i2vTurboLow", label: "Turbo LoRA (i2v, low noise)", folder: "loras", detect: ["^(?=.*i2v)(?=.*(lightx2v|lightning))(?=.*low)"], optional: true,
      hint: "The low-noise half of the turbo LoRAs for i2v.",
      get: { file: "wan2.2_i2v_A14b_low_noise_lora_rank64_lightx2v_4step_1022.safetensors", url: `${LIGHTX2V}/wan2.2_i2v_A14b_low_noise_lora_rank64_lightx2v_4step_1022.safetensors` },
    },
    {
      id: "t2vTurboHigh", label: "Turbo LoRA (t2v, high noise)", folder: "loras", detect: ["^(?=.*t2v)(?=.*(lightx2v|lightning))(?=.*high)"], optional: true,
      hint: "The turbo LoRAs for t2v: without them those clips take the full step count.",
      get: { file: "wan2.2_t2v_A14b_high_noise_lora_rank64_lightx2v_4step_1217.safetensors", url: `${LIGHTX2V}/wan2.2_t2v_A14b_high_noise_lora_rank64_lightx2v_4step_1217.safetensors` },
    },
    {
      id: "t2vTurboLow", label: "Turbo LoRA (t2v, low noise)", folder: "loras", detect: ["^(?=.*t2v)(?=.*(lightx2v|lightning))(?=.*low)"], optional: true,
      hint: "The low-noise half of the turbo LoRAs for t2v.",
      get: { file: "wan2.2_t2v_A14b_low_noise_lora_rank64_lightx2v_4step_1217.safetensors", url: `${LIGHTX2V}/wan2.2_t2v_A14b_low_noise_lora_rank64_lightx2v_4step_1217.safetensors` },
    },
    {
      id: "tinyVae", label: "Tiny VAE (live preview)", folder: "vae_approx", detect: ["tae.?w2[._]1"], optional: true,
      hint: "Optional, 23 MB: with taew2_1.safetensors (tiny VAE) in ComfyUI's models/vae_approx folder, the animated live preview shows the real frames. Without it, it is a small, rough colour preview.",
      get: { file: "taew2_1.safetensors", url: "https://huggingface.co/Kijai/WanVideo_comfy/resolve/main/taew2_1.safetensors" },
    },
    {
      id: "rife", label: "Frame interpolation model (RIFE)", folder: "frame_interpolation", detect: ["rife"], optional: true,
      hint: "Without it, no frame interpolation: clips stay at 16 fps. Put a RIFE model in ComfyUI's models/frame_interpolation folder.",
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
/** The 14B models' largest canvas as they were trained: 720p. Both edges are multiples of 16. */
export const WAN_MAX_PIXELS = 1280 * 720;
/** What a form may ask for: up to 1080p, past what the model was trained for, for cards that have the room. */
export const WAN_FORM_PIXELS = 1088 * 1920;

/** How many frames make `seconds` at 16 a second, on a count the model takes (4k + 1). */
export function wanFrames(seconds: number): number {
  const n = Math.max(5, Math.round(seconds * WAN_FPS));
  return Math.ceil((n - 1) / 4) * 4 + 1;
}

/** The canvas for a shape: `short` pixels on the short edge, the shape's proportions, within `maxPixels` (what the model takes, unless a form asks for more). */
export function wanCanvas(width: number, height: number, short: number, maxPixels = WAN_MAX_PIXELS): { width: number; height: number } {
  return frameOf({ width, height }, short, { grid: 16, maxPixels });
}
