import { defineFamily } from "@studai/core";

/**
 * MiniMax H3: video with sound, from text, from a first and a last picture, or carrying on from another
 * clip. Its files are found by name; any of them can be set by hand on the setup page.
 */
export const h3 = defineFamily({
  id: "h3",
  name: "MiniMax H3",
  summary: "Video with sound. Opens on a picture, ends on one, or continues another clip.",
  promptStyle: "sections",
  slots: [
    {
      id: "unet", label: "Video model", folder: "diffusion_models", detect: ["minimax_h3.*fl2va"],
      hint: "Put minimax_h3_fl2va_*.safetensors in ComfyUI's models/diffusion_models folder.",
    },
    {
      id: "clip", label: "Text reader", folder: "text_encoders", detect: ["qwen3vl.*minimax", "minimax.*h3"],
      hint: "Put qwen3vl_32b_minimax_h3_*.safetensors in ComfyUI's models/text_encoders folder.",
    },
    {
      id: "videoVae", label: "Picture decoder", folder: "vae", detect: ["minimax_h3_video_vae.*fp16", "minimax_h3_video_vae"],
      hint: "Put minimax_h3_video_vae_*.safetensors in ComfyUI's models/vae folder.",
    },
    {
      id: "audioVae", label: "Sound decoder", folder: "vae", detect: ["minimax_h3_audio_vae"],
      hint: "Put minimax_h3_audio_vae_*.safetensors in ComfyUI's models/vae folder.",
    },
    {
      // the turbo LoRA of the reference model is another file and does not fit this one
      id: "turbo", label: "Fast mode (turbo LoRA)", folder: "loras", detect: ["^(?!.*ref2v).*minimax_h3.*turbo"], optional: true,
      hint: "Without it, Fast is off and clips take the full number of steps. Put the MiniMax H3 turbo LoRA in ComfyUI's models/loras folder.",
    },
    {
      id: "refUnet", label: "Reference model (people, places, voices)", folder: "diffusion_models", detect: ["minimax_h3.*ref2va"], optional: true,
      hint: "Without it, clips cannot follow reference pictures or a voice. Put minimax_h3_ref2va_*.safetensors in ComfyUI's models/diffusion_models folder.",
    },
    {
      id: "refTurbo", label: "Fast mode for the reference model", folder: "loras", detect: ["minimax_h3.*ref2v.*turbo"], optional: true,
      hint: "Optional: a turbo LoRA made for the reference model. Without it, the usual turbo LoRA is used for clips with references too.",
    },
    {
      id: "rife", label: "Smooth motion (RIFE)", folder: "frame_interpolation", detect: ["rife"], optional: true,
      hint: "Without it, clips stay at 24 pictures a second. Put a RIFE model in ComfyUI's models/frame_interpolation folder.",
    },
  ],
  loraMatch: ["minimax", "\\bh3\\b"],
  guide: `MiniMax H3 makes the picture AND the sound (voices, effects, music) together.
A GOOD H3 PROMPT
- What happens: ONE continuous shot, present tense, natural sentences (not tags). The motion over time inline ("at first", "then", "as she…"), the facial expression, at most one camera move written plainly ("The camera pushes in slowly toward her face."). Only add a cut when asked or when the clip is 9 seconds or longer: "[Shot 2] At 00:0X.XXX, …". Do not write "[Shot 1]" yourself: it is added.
- Dialogue: only the exact spoken words go inside <d>…</d>, prefixed with their language: <d>[English] …</d>, <d>[French] …</d>. Keep the user's words as they wrote them, never translate. Who speaks, their ID (S1) and HOW they say it (tone, emotion, volume) go outside the tags: The woman with a soft, husky voice (S1) says: <d>[English] Come here.</d> in a warm, teasing tone. Speakers on screen lip-sync on their own: do not describe lip movement. Speech runs about 2.5 words a second: keep it short enough to fit the clip with room for the action.
- Sounds: what is heard in the scene: ambience, effects, breathing, the qualities of the voice.
- Music: background music, or N/A.
DETAIL: write what happens like the best H3 prompts, rich and specific:
- open with the look and the shot: the style ("Cinematic live-action video with realistic movement"), the framing and the lens (close-up, medium shot, low angle, shallow depth of field)
- who: hair, eyes, build, the clothing with colour, material and fit, anything they hold
- the action beat by beat with timing words: the body (hands, hips, shoulders, head), the physics (hair swaying, fabric shifting), the gaze and how the expression changes
- the camera: one move, its direction and speed
More detail does not mean more actions: describe the same few actions precisely.`,
});

export const H3_FPS = 24;
/** H3's largest canvas: 768 × 1344 pixels. Both edges are multiples of 32. */
const H3_MAX_PIXELS = 768 * 1344;

/** How many frames make `seconds` at 24 a second, rounded up to a count the model takes (17k + 5). */
export function h3Frames(seconds: number): number {
  let n = Math.max(5, Math.round(seconds * H3_FPS));
  while (n % 17 !== 5) n++;
  return n;
}

/** The canvas for a shape: `short` pixels on the short edge, the shape's proportions, within what the model takes. */
export function h3Canvas(width: number, height: number, short: number): { width: number; height: number } {
  const r = width / height;
  let w = r >= 1 ? short * r : short;
  let h = r >= 1 ? short : short / r;
  if (w * h > H3_MAX_PIXELS) {
    const k = Math.sqrt(H3_MAX_PIXELS / (w * h));
    w *= k;
    h *= k;
  }
  const r32 = (n: number) => Math.max(32, Math.round(n / 32) * 32);
  let W = r32(w);
  let H = r32(h);
  // rounding can land just over the largest the model takes: the long edge gives way (both, for a square)
  while (W * H > H3_MAX_PIXELS) {
    if (W >= H) W -= 32;
    if (H > W || W + 32 === H) H -= 32;
  }
  return { width: W, height: H };
}
