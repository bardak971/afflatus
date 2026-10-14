import { defineFamily, wordCount, type Family, type PromptLine } from "@afflatus/core";
import { scail } from "../scail/family";
import { wan } from "../wan/family";

const HF = "https://huggingface.co/Comfy-Org/Wan-Animate-2/resolve/main";

/** Files Wan Animate 2 loads as the families it is made from do: Wan's text encoder, VAE and RIFE, SCAIL-2's lightx2v and CLIP vision. */
const from = (family: Family, id: string): Family["slots"][number] => family.slots.find((s) => s.id === id)!;

/**
 * Wan Animate 2 (on Wan 2.1 14B): a picture moved like a driving video, which it reads as it is (no pose skeleton made
 * first, the way Wan 2.2 Animate needed a preprocessing pack), at the video's own frame rate. As ComfyUI's own template
 * (video_wan_animate2): the int8 model, lightx2v's Wan 2.1 step-distill LoRA, 6 steps at CFG 1, one 81-frame window a job.
 */
export const wanAnimate = defineFamily({
  id: "wananimate",
  name: "Wan Animate 2",
  summary: "Motion transfer: a picture moved like a driving video, at the video's own frame rate. On Wan 2.1 14B.",
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
  guide: `Wan Animate 2 moves the person of a PICTURE the way the person of a DRIVING VIDEO moves, at the video's own pace: the motion, the face (mouth, eyes, expressions) and the camera come from the video, everything seen comes from the picture. Its own template writes the prompt in two labelled parts, the way it was trained, and so do you:
Character Description: the one person who moves, as the picture shows them.
Background description: what is behind them, and the light.
RULES
- Both labels, each on its own line, a sentence or two after each: 30 to 70 words in all, plain present tense.
- Character: age, hair, beard, clothing with its colour and material, anything they hold or wear that can be seen. Only what the picture shows.
- Background: the place in a few concrete things, the people behind if any, the light and its colour.
- No motion and no camera in these two: the video gives them. When the form has a Motion box, it takes one short sentence of what the person does, the way the video has it ("He raps to the camera, moving his hands to the beat."), nothing about who they are.
- No names of real people, no weights, no quality words, no tags.
EXAMPLE, for the form only (its subject, place and words are not to be reused):
Character Description: A woman in her twenties with long red hair in a braid, a green wool sweater and small gold earrings.
Background description: A small kitchen in warm morning light, white tiles, a window with plants on the sill.`,
  lint({ text, main }) {
    if (!text?.trim()) return [];
    const out: PromptLine[] = [];
    if (!/character description\s*:/i.test(text) || !/background description\s*:/i.test(text)) out.push({ part: main, text: "Wan Animate 2's prompt has two labelled parts, Character Description: and Background description:, as its template writes it." });
    const n = wordCount(text);
    if (n > 90) out.push({ part: main, text: `${n} words: 30 to 70 are enough, the picture and the video give the rest.` });
    return out;
  },
});

/** It moves at the driving video's pace, frame for frame: the part is handed over at H3's 24 a second, so its clips sit with H3's on a timeline. */
export const WAN_ANIMATE_FPS = 24;
/** One window as the template makes it: 81 frames. */
export const WAN_ANIMATE_WINDOW = 81;
