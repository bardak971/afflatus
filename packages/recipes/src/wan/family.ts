import { frameOf, type PromptLine, QUOTED_SPEECH, WEIGHT_SYNTAX, wordCount } from "@afflatus/core";
import { defineFamily } from "@afflatus/core";
import { SEEDVR_SLOTS } from "../video/upscale";
import { RIFE_GET } from "../shared/finish";
import { WAN_WRONG } from "./wrong";

/** Where ComfyUI's own templates fetch Wan 2.2's files from. */
const HF = "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files";
/** lightx2v's own 4-step LoRAs, the newer ones (Oct and Dec 2025): better motion than the v1 files ComfyUI's templates link. */
const LIGHTX2V = "https://huggingface.co/lightx2v/Wan2.2-Distill-Loras/resolve/main";
/** SVI 2.0 Pro's two LoRAs for Wan 2.2 I2V, as Kijai repacked them for ComfyUI. */
const SVI = "https://huggingface.co/Kijai/WanVideo_comfy/resolve/main/LoRAs/Stable-Video-Infinity/v2.0";

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
  help: {
    what: "Video without sound: from a first frame, a first and a last frame, or words.",
    best: "motion and camera moves from a picture",
    weak: "no sound; about 5 s a clip",
  },
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
      // SVI 2.0 Pro (Stable Video Infinity): a clip carries the motion of the clip before on, its last frames in the latent;
      // without the two LoRAs it opens on that clip's last frame, still. The words in any order, as the turbo LoRAs'
      id: "sviHigh", label: "SVI 2.0 Pro LoRA (high noise)", folder: "loras", detect: ["^(?=.*svi)(?=.*pro)(?=.*high)"], optional: true,
      hint: "Without the two SVI 2.0 Pro LoRAs, a clip that carries on from the clip before opens on its last frame, still: a cut. Put SVI_v2_PRO_Wan2.2-I2V-A14B_HIGH_lora and its LOW half in ComfyUI's models/loras folder.",
      get: { file: "SVI_v2_PRO_Wan2.2-I2V-A14B_HIGH_lora_rank_128_fp16.safetensors", url: `${SVI}/SVI_v2_PRO_Wan2.2-I2V-A14B_HIGH_lora_rank_128_fp16.safetensors` },
    },
    {
      id: "sviLow", label: "SVI 2.0 Pro LoRA (low noise)", folder: "loras", detect: ["^(?=.*svi)(?=.*pro)(?=.*low)"], optional: true,
      hint: "The low-noise half of SVI 2.0 Pro's LoRAs.",
      get: { file: "SVI_v2_PRO_Wan2.2-I2V-A14B_LOW_lora_rank_128_fp16.safetensors", url: `${SVI}/SVI_v2_PRO_Wan2.2-I2V-A14B_LOW_lora_rank_128_fp16.safetensors` },
    },
    {
      id: "tinyVae", label: "Tiny VAE (live preview)", folder: "vae_approx", detect: ["tae.?w2[._]1"], optional: true,
      hint: "Optional, 23 MB: with taew2_1.safetensors (tiny VAE) in ComfyUI's models/vae_approx folder, the animated live preview shows the real frames. Without it, it is a small, rough colour preview.",
      get: { file: "taew2_1.safetensors", url: "https://huggingface.co/Kijai/WanVideo_comfy/resolve/main/taew2_1.safetensors" },
    },
    {
      id: "rife", label: "Frame interpolation model (RIFE)", folder: "frame_interpolation", detect: ["rife"], optional: true,
      hint: "Without it, no frame interpolation: clips stay at 16 fps. Put a RIFE model in ComfyUI's models/frame_interpolation folder.",
      get: RIFE_GET,
    },
    ...SEEDVR_SLOTS,
  ],
  loraMatch: ["wan"],
  wrong: WAN_WRONG,
  guide: `Wan 2.2 makes video WITHOUT sound: no dialogue, no sounds. Its authors' formula is Subject → Scene → Motion → Camera → Atmosphere and style, as natural sentences in the present tense, 40 to 120 words, no tags.
RULES
- Subject with 2 or 3 descriptors (age, hair, clothing with colour and material). Several people: a label and a place for each ("the man in the red jacket on the left").
- Scene: the place with a few concrete things, the time of day, the weather.
- Motion matters most: the action, its amplitude and speed ("slowly raises her hand", "sprints across"), the physics (hair, fabric, water, smoke). A few actions in order; one continuous shot; never a cut, a scene change or a long choreography.
- Camera, one or two moves by their names: push-in, pull-out, tracking shot, orbit, pan, tilt, fixed camera.
- Atmosphere, 2 to 4 of the model's own words: light source (daylight, firelight, overcast light), lighting type (soft light, hard light, side light), time (dawn, night), shot size (close-up, medium shot, wide-angle), angle (over-the-shoulder, high-angle, aerial), colour tone (warm tones, cool tones, low saturation); a style when wanted (cinematic, pixel game, felt style). Keep the style words consistent with the subject.
- No real people by name, no readable text.
- A first-frame picture already gives subject, scene and style: write ONLY the motion and the camera, and a change of light or weather if any.
- The "Negative prompt" part holds the authors' own Chinese list, which keeps the clip from freezing: leave it; add an item only when something keeps appearing.
- No weights, no quality words. More detail is not more actions.
EXAMPLE, for the form only (its subject, place and words are not to be reused):
An elderly fisherman in a grey wool sweater and a flat cap mends a net on a stone quay at dawn. He pulls the twine tight with slow, deliberate movements, pauses to shake out a tangle, then bends back to the knot, while gulls wheel over the grey water behind him. Tracking shot, slowly circling from his hands up to his weathered face. Overcast light, soft light, close shot, low saturation, cool tones.`,
  /** What the designer wrote, against Wan's guide: no sound, so no dialogue; 40 to 120 words; no weights. */
  lint({ text, main }) {
    if (!text?.trim()) return [];
    const out: PromptLine[] = [];
    const n = wordCount(text);
    if (/<d>|["“][^"”]{3,}["”]/.test(text) && QUOTED_SPEECH.test(text)) out.push({ part: main, text: "Dialogue in a Wan prompt: Wan makes no sound, nobody is heard." });
    if (n > 140) out.push({ part: main, text: `${n} words; the formula prompt works best at 40 to 120.` });
    if (WEIGHT_SYNTAX.test(text)) out.push({ part: main, text: "A (word:1.2) weight: Wan does not read weights." });
    return out;
  },
});

export const WAN_FPS = 16;
/** The 14B models' largest canvas as they were trained: 720p. Both edges are multiples of 16. */
const WAN_MAX_PIXELS = 1280 * 720;
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
