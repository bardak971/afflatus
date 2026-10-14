import { defineFamily, type Family } from "@afflatus/core";
import { wan } from "../wan/family";

const HF = "https://huggingface.co/Comfy-Org/SCAIL-2/resolve/main";

/** Wan's own files SCAIL-2 loads as they are (it is a Wan 2.1 14B model): the text encoder and the VAE, found the same way. */
const fromWan = (id: string): Family["slots"][number] => wan.slots.find((s) => s.id === id)!;

/**
 * SCAIL-2 (zai-org, on Wan 2.1 14B): a picture's people moved like a driving video's, the whole body, the hands and the
 * mouth, by their pose and a coloured mask of who is who (SAM 3 finds them). The files are the ones ComfyUI's own template
 * loads: the int8 model, its DPO LoRA and Wan 2.1's lightx2v step-distill LoRA (6 steps at CFG 1).
 */
export const scail = defineFamily({
  id: "scail",
  name: "SCAIL-2",
  summary: "Motion transfer: a picture moved like a driving video, body, hands and mouth. On Wan 2.1 14B, 16 fps.",
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
  ],
  loraMatch: ["wan", "scail"],
});

export const SCAIL_FPS = 16;
/** One chunk as SCAIL-2 was trained: 81 frames, each after the first anchored on the last 5 of the one before (a 76-frame step). */
export const SCAIL_CHUNK = 81;
export const SCAIL_CARRIED = 5;
