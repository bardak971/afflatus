import { frameOf, gridNearest, LATENT_GRID, type FrameGrid, type PromptLine, QUOTED_SPEECH, wordCount } from "@afflatus/core";
import { defineFamily } from "@afflatus/core";
import { SEEDVR_SLOTS } from "../video/upscale";

/** Where ComfyUI's own templates fetch MiniMax H3's files from. */
const HF = "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main";
/** H3's reference model and what is made from it, by name: ref2va (MiniMax's), r2v, or a merge with its reference delta (a fused turbo). */
export const SWAP_MODELS = "minimax.?h3.*(ref2va|r2va|r2v|refdelta)";
/** H3's hybrid fine-tunes (DaSiWa's), which follow references themselves: a swap can run on them, never picked for it by itself. */
export const H3_HYBRIDS = "minimax.?h3.*hybrid";

/**
 * MiniMax H3: video with sound, from text, from a first and a last picture, or carrying on from another
 * clip. Its files are found by name; any of them can be set by hand on the setup page.
 */
export const h3 = defineFamily({
  id: "h3",
  name: "MiniMax H3",
  summary: "Video with audio. i2v from a first frame, first and last frame, or extending a previous clip.",
  help: {
    what: "Video with its sound, made together: speech, voices, ambience.",
    best: "talking scenes, dialogue in many languages, the cast from pictures, clips that join on a timeline",
    weak: "4 to 15 s a clip; longer goes on a timeline",
  },
  promptStyle: "sections",
  slots: [
    {
      // MiniMax's own; without it a hybrid fine-tune (one file for both ways of making a clip), a full-step one before a turbo one
      id: "unet", label: "Video model", folder: "diffusion_models", detect: ["minimax_h3.*fl2va", "minimax.?h3.*hybrid(?!.*turbo)", "minimax.?h3.*hybrid"],
      hint: "Put minimax_h3_fl2va_*.safetensors, or a hybrid MiniMax H3 fine-tune, in ComfyUI's models/diffusion_models folder.",
      get: { file: "minimax_h3_fl2va_pruned_int8_convrot.safetensors", url: `${HF}/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors` },
    },
    {
      id: "clip", label: "Text encoder", folder: "text_encoders", detect: ["qwen3vl.*minimax", "minimax.*h3"],
      hint: "Put qwen3vl_32b_minimax_h3_*.safetensors in ComfyUI's models/text_encoders folder.",
      get: { file: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", url: `${HF}/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` },
    },
    {
      id: "videoVae", label: "VAE (image)", folder: "vae", detect: ["minimax_h3_video_vae.*fp16", "minimax_h3_video_vae"],
      hint: "Put minimax_h3_video_vae_*.safetensors in ComfyUI's models/vae folder.",
      get: { file: "minimax_h3_video_vae_int8_convrot.safetensors", url: `${HF}/vae/minimax_h3_video_vae_int8_convrot.safetensors` },
    },
    {
      id: "audioVae", label: "VAE (audio)", folder: "vae", detect: ["minimax_h3_audio_vae"],
      hint: "Put minimax_h3_audio_vae_*.safetensors in ComfyUI's models/vae folder.",
      get: { file: "minimax_h3_audio_vae_fp32.safetensors", url: `${HF}/vae/minimax_h3_audio_vae_fp32.safetensors` },
    },
    {
      // the turbo LoRA of the reference model is another file and does not fit this one
      id: "turbo", label: "Turbo LoRA", folder: "loras", detect: ["^(?!.*ref2v).*minimax_h3.*turbo"], optional: true,
      hint: "Without it, Turbo is off and clips take the full step count. Put the MiniMax H3 turbo LoRA (the 8-step one, or the 4-step 768p one) in ComfyUI's models/loras folder.",
      get: { file: "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors", url: "https://huggingface.co/lightx2v/Minimax-h3-Turbo/resolve/main/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors" },
    },
    {
      id: "refUnet", label: "Reference model (ref2va)", folder: "diffusion_models", detect: ["minimax_h3.*ref2va", "minimax.?h3.*hybrid(?!.*turbo)", "minimax.?h3.*hybrid"], optional: true,
      hint: "Without it, clips cannot follow reference images or a voice sample. Put minimax_h3_ref2va_*.safetensors, or a hybrid MiniMax H3 fine-tune, in ComfyUI's models/diffusion_models folder.",
      get: { file: "minimax_h3_ref2va_pruned_int8_convrot.safetensors", url: `${HF}/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors` },
    },
    {
      id: "refTurbo", label: "Turbo LoRA (reference model)", folder: "loras", detect: ["minimax_h3.*ref2v.*turbo"], optional: true,
      hint: "Optional: a turbo LoRA made for the reference model. Without it, the usual turbo LoRA is used for clips with references too.",
      get: { file: "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors", url: `${HF}/loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors` },
    },
    {
      id: "swapUnet", label: "Reference model for Swap (ref2va)", folder: "diffusion_models", detect: ["minimax_h3.*ref2va", SWAP_MODELS], optional: true, onlyFor: ["h3.swap"],
      hint: "For Swap character: MiniMax's own reference model, the one the Character-Swap LoRA was trained on (a hybrid fine-tune redrew the room), in ComfyUI's models/diffusion_models folder.",
      get: { file: "minimax_h3_ref2va_pruned_int8_convrot.safetensors", url: `${HF}/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors` },
    },
    {
      // V1.5 first, the one its author recommends for new swaps and the one that swapped the owner's Timeline 19 where V1 did
      // not (2026-10-18); V1 (pro4500) when it is the only one there
      id: "swapLora", label: "Character-Swap LoRA", folder: "loras", detect: ["character.?swap.?v1\\.5", "character.?swap"], optional: true, onlyFor: ["h3.swap"],
      hint: "For Swap character: akatz-ai's Character-Swap LoRA for the reference model (V1.5), in ComfyUI's models/loras folder.",
      get: { file: "h3_character_swap_v1.5.safetensors", url: "https://huggingface.co/akatz-ai/MiniMax-H3-Character-Swap-LoRA/resolve/main/h3_character_swap_v1.5.safetensors" },
    },
    {
      id: "swapSam", label: "SAM 3 for Swap (finds the person)", folder: "checkpoints", detect: ["sam3"], optional: true, onlyFor: ["h3.swap"],
      hint: "For Swap character: SAM 3.1 tracks the person to replace, so that only they are redrawn and the rest of the video is kept. Put sam3.1_multiplex_fp16.safetensors in ComfyUI's models/checkpoints folder.",
      get: { file: "sam3.1_multiplex_fp16.safetensors", url: "https://huggingface.co/Comfy-Org/sam3.1/resolve/main/checkpoints/sam3.1_multiplex_fp16.safetensors" },
    },
    {
      // models/veda is the Veda node pack's own folder: ComfyUI knows it once the pack is loaded
      id: "veda", label: "Veda predictor (reference model)", folder: "veda", detect: ["r2va.*veda", "veda.*r2va"], optional: true, onlyFor: ["h3.swap"],
      hint: "Optional, for Swap character's Veda sparse attention: the predictor made for H3's reference model, in ComfyUI's models/veda folder (the veda-sparse-attention node pack makes it).",
      get: { file: "minimax_h3_r2va_veda_preview_fp8.safetensors", url: "https://huggingface.co/Veda-Sparse/Minimax-H3-R2VA-Veda-Preview/resolve/main/minimax_h3_r2va_veda_preview_fp8.safetensors" },
    },
    {
      id: "latentUpscaler", label: "Latent upscaler (upscale pass)", folder: "latent_upscale_models", detect: ["minimax.?h3.?latent.?upscaler"], optional: true,
      get: { file: "minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors", url: "https://huggingface.co/LBH-123-AI/Minimax_h3_latent_Upscaler/resolve/main/minimax_h3_latent_upscaler_3d_conv_v1/minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors" },
      hint: "Optional: with minimax_h3_latent_upscaler_3d_*.safetensors in ComfyUI's models/latent_upscale_models folder, the refine pass uses H3's own latent upscaler. Without it, the clip is resized and re-sampled, which is still sharper than a pixel upscale.",
    },
    {
      id: "tinyVae", label: "Tiny VAE (live preview)", folder: "vae_approx", detect: ["^taeh3\\.safetensors$"], optional: true,
      hint: "Optional: with taeh3.safetensors (tiny VAE) in ComfyUI's models/vae_approx folder, the animated live preview is sharper. Without it, it is a rough colour preview.",
    },
    {
      id: "rife", label: "Frame interpolation model (RIFE)", folder: "frame_interpolation", detect: ["rife"], optional: true,
      hint: "Without it, no frame interpolation: clips stay at 24 fps. Put a RIFE model in ComfyUI's models/frame_interpolation folder.",
    },
    ...SEEDVR_SLOTS,
  ],
  loraMatch: ["minimax", "\\bh3\\b"],
  guide: `MiniMax H3 makes the picture AND the sound (voices, effects, music) together. Afflatus adds the model's layout itself (field labels, the [Shot 1] mark, the picture alignment lines): write only the content of each part, never a label.
RULES FOR THE PROMPT (the model's integrated description)
- One short sentence of visual style first ("Live-action, cinematic, handheld, warm tungsten light."), then ONE continuous shot in the present tense, in the order things happen. 100 to 150 words.
- Order inside the shot: framing, who is in it and how they look (hair, build, clothing with colour and material), the action beat by beat with timing words ("at first", "then", "as she…"), the camera, the words spoken, the sounds that happen in the shot.
- The camera as type + amplitude + speed: "The camera pushes in with small amplitude at slow speed toward her face." One move per shot.
- A cut only when asked or past 9 seconds: "[Shot 2] At 00:05.000, the camera cuts to …".
- Voices numbered (S1), (S2) in order of appearance; describe a voice the first time it speaks (age, timbre, accent). The exact words inside <d>…</d> with the language first: <d>[English] Come here.</d>. Who speaks, their number and HOW stay outside the tags: The woman with a soft, husky voice (S1) says, warm and teasing: <d>[English] Come here.</d>
- The user's words stay as written, never translated. A voice from off screen: "says in an off-screen voiceover", lips closed.
- Text that must appear on screen: English double quotes, word for word.
- Write what you WANT, never what you do not want: the model has no negative branch ("the street stays empty", not "no other people").
- A few actions, described precisely: more detail is not more actions.
THE OTHER PARTS
- "Sound effects": 1 to 4 sentences of ambience and physical sound, in order. Never dialogue, never music.
- "Music" (over the scene, unheard by the people in it): genre, tempo, instrumentation, dynamics. Never an artist or a song name. Leave it EMPTY for no music. A radio or singing in the scene goes in the Prompt.
PICTURES
- A first frame: one clause of what it preserves, then ONLY what moves from there.
- A first and a last frame: the motion between them, never two still descriptions.
- Carrying on from another clip: the action continues, nothing resets; one short clause keeps the people the same.
EXAMPLE, for the form only (its subject, place, lens and words are not to be reused):
Prompt: Live-action, cinematic. The young woman shown in the picture keeps her appearance, her clothing and her seat by the rain-covered train window. The camera trucks right with small amplitude at slow speed as she lifts her gaze from the folded letter toward the passing city lights. Her reflection slides across the glass while the quiet, breathy young woman (S1) says, almost to herself: <d>[English] I get off at the next station.</d> She folds the letter along its crease.
Sound effects: The train wheels keep a steady metallic rhythm under a low ventilation hum. Rain ticks against the window; paper rustles softly in her hands.
Music: Sustained cello notes at a slow tempo with widely spaced piano tones, slowly fading.`,
  /** What the designer wrote, against H3's layout: Afflatus writes the labels and marks, speech goes in <d>[Language] …</d>, sounds and music in their own parts. */
  lint({ text, main, changes }) {
    const out: PromptLine[] = [];
    const say = (part: string, line: string) => out.push({ part, text: line });
    if (text?.trim()) {
      const n = wordCount(text);
      if (/integrated_multimodal_description:|overall_soundscape:|non_diegetic_music:/i.test(text)) say(main, "It wrote the layout's field labels into the prompt; Afflatus adds those itself.");
      if (/<d>(?!\s*\[)/i.test(text)) say(main, "A spoken line without its language tag: it should read <d>[English] …</d>.");
      if (!/<d>/i.test(text) && QUOTED_SPEECH.test(text)) say(main, "Speech in plain quotes: H3 only speaks what is inside <d>[Language] …</d>.");
      if (/\[Shot 1\]/i.test(text) && !/\[Shot 2\]/i.test(text)) say(main, "It wrote [Shot 1] itself; that mark is added for it.");
      if (n > 200) say(main, `${n} words for one shot; the model's guide wants 100 to 150.`);
      if (/\b(no|not|never|without|don't)\b/i.test(text) && /\b(no|without) (other|extra|additional) (people|person|text|objects?)\b/i.test(text)) say(main, "A ban written as a negative: H3 has no negative branch, say the wanted state instead.");
    }
    // the other parts: dialogue or music where only sounds go
    const sound = changes.soundscape;
    if (sound && /<d>|\bmusic\b|\bsong\b|\bsoundtrack\b/i.test(sound)) say("soundscape", "Dialogue or music in Sound effects: that part is ambience and physical sound only.");
    const music = changes.music;
    if (music && /\bby\s+[A-Z][a-z]+(\s+[A-Z][a-z]+)?\b|\b(Hans Zimmer|Daft Punk|Beatles|Mozart|Beethoven|Taylor Swift)\b/.test(music)) say("music", "An artist or song name in Music: the model takes genre, tempo and instruments, never names.");
    return out;
  },
});

export const H3_FPS = 24;
/** H3's frame counts, 17k + 5, and its latent's 17-frame chunks: the grid the app keeps latents on (core's LATENT_GRID). */
export const H3_GRID: FrameGrid = LATENT_GRID;
/** The longest clip the model was trained on: 362 frames (15 s at 24), joins included. */
export const H3_MAX_FRAMES = 362;
/** H3's largest canvas in one pass as it was trained: 768 × 1344 pixels. Both edges are multiples of 32. */
const H3_MAX_PIXELS = 768 * 1344;
/** What a form may ask for: up to 1080p, past what the model was trained for, for cards that have the room. */
export const H3_FORM_PIXELS = 1088 * 1920;

/**
 * How many frames make `seconds` at 24 a second, as a count the model takes (17k + 5): the nearest one, unless
 * that falls more than four frames (a sixth of a second) short of what was typed, then the next one up. Rounding
 * up every time, as before 2026-10-05, made a 5 s continuation 158 frames (5.7 s of its own) where the nearest
 * count is 141 (5 s), a third more work on a card that is already full; other front-ends snap to the nearest.
 */
export function h3Frames(seconds: number): number {
  const wanted = Math.max(5, Math.round(seconds * H3_FPS));
  const nearest = gridNearest(wanted, H3_GRID);
  return wanted - nearest > 4 ? nearest + H3_GRID.step : nearest;
}

/** The canvas for a shape: `short` pixels on the short edge, the shape's proportions, within `maxPixels` (what the model takes, unless a form asks for more). */
export function h3Canvas(width: number, height: number, short: number, maxPixels = H3_MAX_PIXELS): { width: number; height: number } {
  return frameOf({ width, height }, short, { grid: 32, maxPixels });
}
