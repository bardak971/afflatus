import { defineFamily, wordCount, type Family, type FrameGrid } from "@afflatus/core";
import { wan } from "../wan/family";
import { h3 } from "../h3/family";

const HF = "https://huggingface.co/Comfy-Org/SCAIL-2/resolve/main";

/** Wan's own files SCAIL-2 loads as they are (it is a Wan 2.1 14B model): the text encoder and the VAE, found the same way. */
const fromWan = (id: string): Family["slots"][number] => wan.slots.find((s) => s.id === id)!;

/**
 * Face refine's files, for SCAIL-2 at 24 fps (the pass is H3's, run on SCAIL's own frames): H3's own, found the same way and
 * offered only while that recipe is shown; H3's text encoder and VAEs under ids of their own, beside SCAIL's (Wan's) two.
 */
const forFaceRefine = (id: string, as?: { id: string; label: string }): Family["slots"][number] => {
  const slot = h3.slots.find((s) => s.id === id)!;
  return { ...slot, ...(as ?? {}), optional: true, onlyFor: ["scail.motion24"] };
};

/**
 * SCAIL-2 (zai-org, on Wan 2.1 14B): a picture's people moved like a driving video's, the whole body, the hands and the
 * mouth, by their pose and a coloured mask of who is who (SAM 3 finds them). The files are the ones ComfyUI's own template
 * loads: the int8 model, its DPO LoRA and Wan 2.1's lightx2v step-distill LoRA (6 steps at CFG 1).
 */
export const scail = defineFamily({
  id: "scail",
  name: "SCAIL-2",
  summary: "Motion transfer: a picture moved like a driving video, body, hands and mouth. On Wan 2.1 14B, 16 fps.",
  help: {
    what: "A picture moved like a driving video, its room, its light and its people kept.",
    best: "several people, each paired with who drives them; holding the face",
    weak: "16 frames a second (RIFE doubles them), no sound of its own; complex motion and long clips can lose quality",
  },
  promptStyle: "sentences",
  slots: [
    {
      id: "unet", label: "Diffusion model", folder: "diffusion_models", detect: ["scail.?2", "scail"],
      hint: "Put wan2.1_14B_SCAIL_2_*.safetensors in ComfyUI's models/diffusion_models folder.",
      get: { file: "wan2.1_14B_SCAIL_2_int8_convrot.safetensors", url: `${HF}/diffusion_models/wan2.1_14B_SCAIL_2_int8_convrot.safetensors` },
    },
    {
      id: "dpo", label: "DPO LoRA", folder: "loras", detect: ["scail.*dpo"],
      hint: "Put wan2.1_SCAIL_2_DPO_lora_bf16.safetensors in ComfyUI's models/loras folder: ComfyUI's template runs SCAIL-2 with it.",
      get: { file: "wan2.1_SCAIL_2_DPO_lora_bf16.safetensors", url: `${HF}/loras/wan2.1_SCAIL_2_DPO_lora_bf16.safetensors` },
    },
    {
      // Wan 2.1's own, not Wan 2.2's two-file 4-step LoRAs (the "wan" family's turbo slots)
      id: "turbo", label: "Step-distill LoRA (lightx2v, Wan 2.1)", folder: "loras", detect: ["lightx2v.*i2v.*14b.*480p", "lightx2v.*i2v.*14b"],
      hint: "Put lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors in ComfyUI's models/loras folder: 6 steps at CFG 1, as ComfyUI's template.",
      get: { file: "lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors", url: "https://huggingface.co/Kijai/WanVideo_comfy/resolve/main/Lightx2v/lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors" },
    },
    fromWan("clip"),
    fromWan("vae"),
    {
      id: "clipVision", label: "CLIP vision", folder: "clip_vision", detect: ["clip.?vision.?h"],
      hint: "Put clip_vision_h.safetensors in ComfyUI's models/clip_vision folder.",
      get: { file: "clip_vision_h.safetensors", url: "https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/clip_vision/clip_vision_h.safetensors" },
    },
    {
      id: "sam", label: "SAM 3 (finds the people)", folder: "checkpoints", detect: ["sam3"],
      hint: "Put sam3.1_multiplex_fp16.safetensors in ComfyUI's models/checkpoints folder.",
      get: { file: "sam3.1_multiplex_fp16.safetensors", url: "https://huggingface.co/Comfy-Org/sam3.1/resolve/main/checkpoints/sam3.1_multiplex_fp16.safetensors" },
    },
    fromWan("tinyVae"),
    fromWan("rife"),
    forFaceRefine("faceRefineUnet"),
    forFaceRefine("faceDetector"),
    forFaceRefine("faceSeg"),
    forFaceRefine("faceSam"),
    forFaceRefine("clip", { id: "faceClip", label: "MiniMax H3 text encoder (Face refine)" }),
    forFaceRefine("videoVae", { id: "faceVideoVae", label: "MiniMax H3 VAE, image (Face refine)" }),
    forFaceRefine("audioVae", { id: "faceAudioVae", label: "MiniMax H3 VAE, audio (Face refine)" }),
  ],
  loraMatch: ["wan", "scail"],
  guide: `SCAIL-2 moves the people of a PICTURE the way the people of a DRIVING VIDEO move: the motion, the gestures, the mouth and the camera all come from the video, everything seen comes from the picture. The prompt only describes the picture, so that the model keeps what is in it. It is optional, and short is best.
RULES
- 25 to 60 words, plain sentences, present tense.
- Who is in the picture, each with 2 or 3 things that can be seen (hair, beard, clothing with its colour), in the order they stand from left to right. Several people: a sentence each.
- The place in a few concrete things, and its light ("deep red stage light", "daylight from a window").
- The action in a few words at most, the way the video has it ("raps to the camera, moving his hands"). Never a sequence of moves, never a camera move, never timing: the video gives those.
- Nothing that is not in the picture: no new person, object or place.
- No names of real people, no weights, no quality words, no tags.
EXAMPLE, for the form only (its subject, place and words are not to be reused):
A young woman with short black hair, a yellow raincoat and white sneakers stands on a wet city sidewalk at night, lit by shop windows and a blue neon sign. She dances, swinging her arms.`,
  lint({ text, main }) {
    if (!text?.trim()) return [];
    const n = wordCount(text);
    return n > 80 ? [{ part: main, text: `${n} words: SCAIL-2 only needs the picture described, 25 to 60 words.` }] : [];
  },
});

export const SCAIL_FPS = 16;
/** One chunk as SCAIL-2 was trained: 81 frames, each after the first anchored on the last 5 of the one before (a 76-frame step). */
export const SCAIL_CHUNK = 81;
export const SCAIL_CARRIED = 5;
/**
 * The frame counts on both Wan's grid (4k + 1, every SCAIL-2 job) and H3's (17k + 5): 5, 73, 141, 209, 277…, every 68 frames
 * (2.83 s at 24 fps). SCAIL-2 at 24 fps makes these, so that a clip of it is as long as an H3 clip can be.
 */
export const SCAIL_H3_GRID: FrameGrid = { step: 68, offset: 5 };
