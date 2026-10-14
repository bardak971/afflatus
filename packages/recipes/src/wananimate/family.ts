import { defineFamily, type Family } from "@afflatus/core";
import { scail } from "../scail/family";
import { wan } from "../wan/family";

const HF = "https://huggingface.co/Comfy-Org/Wan-Animate-2/resolve/main";

/** Files Wan Animate 2 loads as the families it is made from do: Wan's text encoder, VAE and RIFE, SCAIL-2's lightx2v and CLIP vision. */
const from = (family: Family, id: string): Family["slots"][number] => family.slots.find((s) => s.id === id)!;

/**
 * Wan Animate 2 (on Wan 2.1 14B): a picture moved like a driving video, which it reads as it is (no pose skeleton made
 * first, the way Wan 2.2 Animate needed a preprocessing pack), at the video's own frame rate. As ComfyUI's own template
 * (video_wan_animate2): the int8 model, lightx2v's Wan 2.1 step-distill LoRA, 6 steps at CFG 1, and context windows for a
 * part longer than 81 frames, sampled in one pass.
 */
export const wanAnimate = defineFamily({
  id: "wananimate",
  name: "Wan Animate 2",
  summary: "Motion transfer: a picture moved like a driving video, at the video's own frame rate. On Wan 2.1 14B.",
  help: {
    what: "A picture moved like a driving video, at the video's own pace: 24 frames a second, as H3.",
    best: "the face and its expressions; clips that sit with H3's on a timeline; the camera angle set from the prompt",
    weak: "no pairing of who moves like whom in Afflatus; slower for a second of video",
  },
  promptStyle: "sentences",
  slots: [
    {
      id: "unet", label: "Diffusion model", folder: "diffusion_models", detect: ["wan.?animate.?2(?!.*distill)", "wan.?animate.?2"],
      hint: "Put wan_animate_2_int8_convrot.safetensors in ComfyUI's models/diffusion_models folder.",
      get: { file: "wan_animate_2_int8_convrot.safetensors", url: `${HF}/diffusion_models/wan_animate_2_int8_convrot.safetensors` },
    },
    from(scail, "turbo"),
    from(wan, "clip"),
    from(wan, "vae"),
    from(scail, "clipVision"),
    from(wan, "tinyVae"),
    from(wan, "rife"),
  ],
  loraMatch: ["wan"],
});

/** It moves at the driving video's pace, frame for frame: the part is handed over at H3's 24 a second, so its clips sit with H3's on a timeline. */
export const WAN_ANIMATE_FPS = 24;
/** One context window as the template has it: 81 frames (21 latent frames), 8 latent frames shared with the next. */
export const WAN_ANIMATE_WINDOW = 81;
