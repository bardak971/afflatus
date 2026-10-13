import { defineRecipe, gridAtOrBefore, type BuildContext, type ClipValue, type InputSpec, type Variant } from "@afflatus/core";
import { H3_FPS, H3_GRID } from "./family";
import { h3Inputs, type H3Video } from "./inputs";
import { buildH3, h3Video } from "./video";

/**
 * MiniMax H3 · Swap character: a person in a video replaced by someone of the cast, the rest of the video kept. The
 * source video's part is H3's reference video (<Video 1>), the cast's pictures its reference pictures, and the model
 * carries akatz-ai's Character-Swap LoRA (trained on the reference model) with its own short caption as the whole prompt:
 * a long "preserve everything" prompt broke 2 of 3 swaps, the caption made 3 of 3 (report §5, S1, 2026-10-12). The
 * file's sound is the source's own. One swap holds a window of up to 141 frames (5.9 s at 24): the LoRA's author found
 * 4-5 s windows the safest; longer videos are swapped window by window on a timeline.
 */
export interface H3Swap extends H3Video {
  source?: ClipValue;
  sourceStart: number;
  sourceSeconds: number;
  who: string;
  swapStrength: number;
  keepSound: boolean;
}

/** The longest window one swap makes, in frames (17k + 5): 5.9 s. */
export const SWAP_FRAMES = 141;
/** The shortest: 39 frames, 1.6 s. */
const SWAP_LEAST = 39;

/** H3's inputs a swap does not take: its prompt is the caption, its length the source's part, its shape the source's. */
const NOT_TAKEN = new Set([
  "description", "soundscape", "music", "start", "end", "mid", "midAt", "previous", "handover", "context", "joinFrom", "next", "landing",
  "refVideos", "voice", "voiceStart", "voiceSeconds", "voiceEven", "subject", "seconds", "shape",
  // H3's colour match pulls towards a start picture, which a swap has not
  "colourMatch", "colourStrength",
]);

const swapInputs: InputSpec[] = [
  {
    id: "who", type: "prompt", weights: false, label: "Who to replace", style: "sentences", noCast: true,
    placeholder: "the man in the grey t-shirt",
    note: "a few words that pick the person out of the video. The prompt is the swap LoRA's own short caption built from them: a longer prompt broke the swap",
  },
  {
    id: "source", type: "clip", role: "source", label: "Source video", frames: [SWAP_FRAMES], fps: H3_FPS, whole: true,
    window: { start: "sourceStart", seconds: "sourceSeconds", fits: { frames: SWAP_FRAMES, fps: H3_FPS, pad: 0, min: SWAP_LEAST / H3_FPS, grid: H3_GRID } },
    note: "the video whose person is replaced. One swap holds 5.9 s of it; a longer one is swapped window by window on a timeline",
  },
  { id: "sourceStart", type: "number", label: "Source: start", min: 0, max: 3600, step: 0.1, default: 0, unit: " s", showWhen: "source" },
  // (from 1.675 s, whole tenths below the 5.875 s of 141 frames for the slider's steps: still the 39 frames of the shortest window)
  { id: "sourceSeconds", type: "number", label: "Source: length", min: 1.675, max: SWAP_FRAMES / H3_FPS, step: 0.1, default: SWAP_FRAMES / H3_FPS, unit: " s", showWhen: "source" },
  ...h3Inputs.flatMap((spec): InputSpec[] => {
    if (NOT_TAKEN.has(spec.id)) return [];
    if (spec.id === "references" && spec.type === "references") {
      return [{ ...spec, label: "Who goes in", max: 3, roles: ["person"], note: "pictures of the person who takes their place: the cast fills it. One clear picture of the face is enough" }];
    }
    return [spec];
  }),
  { id: "swapStrength", type: "number", label: "Swap LoRA strength", min: 0, max: 2, step: 0.05, default: 1, advanced: true, note: "its author's 1.0" },
  { id: "keepSound", type: "toggle", label: "Keep the source's sound", default: true, advanced: true, note: "the file carries the source video's own sound; off, the sound H3 makes" },
];

/** The frames of the window: the part handed over (or asked for), floored to H3's 17k + 5, 39 to 141. */
function framesOf(input: H3Swap, ctx: Pick<BuildContext, "media">): number {
  const have = ctx.media.source?.frames ?? Math.round(input.sourceSeconds * H3_FPS);
  return Math.max(SWAP_LEAST, gridAtOrBefore(Math.min(SWAP_FRAMES, have), H3_GRID));
}

/** The person picked out in the LoRA's trained caption: the user's few words, without a closing full stop. */
const whoOf = (input: H3Swap) => input.who.trim().replace(/[.!\s]+$/, "") || "the person";

/** "<Picture 1>", "<Picture 1> and <Picture 2>", "<Picture 1>, <Picture 2> and <Picture 3>". */
const picturesSaid = (n: number) => {
  const all = Array.from({ length: Math.max(1, n) }, (_, i) => `<Picture ${i + 1}>`);
  return all.length === 1 ? all[0]! : `${all.slice(0, -1).join(", ")} and ${all.at(-1)}`;
};

/** The caption it was trained on: "Swap the man in the purple shirt in <Video 1> with the character in <Picture 1>." */
export const swapCaption = (who: string, pictures: number) => `Swap ${who} in <Video 1> with the character in ${picturesSaid(pictures)}.`;

/** The swap as an H3 clip: the source's part as its one reference video, the swap LoRA first among the LoRAs, its size and length the part's. */
function asClip(input: H3Swap, swapLora: string, frames: number, size?: { width: number; height: number }): H3Video {
  return {
    ...input,
    description: "", soundscape: "", music: "", subject: "", midAt: 0,
    start: undefined, end: undefined, mid: undefined, previous: undefined, next: undefined, voice: undefined,
    colourMatch: false, handover: false, context: "22", joinFrom: "Latent", landing: "22", voiceStart: 0, voiceSeconds: 15, voiceEven: false,
    refVideos: input.source ? [{ asset: input.source.asset, role: "person" }] : [],
    loras: [{ file: swapLora, weight: input.swapStrength }, ...input.loras],
    seconds: frames / H3_FPS,
    shape: size ?? { width: 1024, height: 576 },
  };
}

export const h3Swap = defineRecipe<H3Swap>({
  id: "h3.swap",
  family: "h3",
  version: 1,
  title: "Swap character",
  summary: "A person in a video replaced by someone of the cast; the scene, the motion and the sound kept.",
  output: "video",
  // a video of its own, made from another: no join with the clips around it
  traits: { startFrame: false, endFrame: false, midFrames: false, continues: false, endAnchor: false, sound: true, fps: H3_FPS, frameGrid: H3_GRID },
  inputs: swapInputs,
  presets: h3Video.presets,
  needs: ["swapLora"],
  nodes: (input) => [...new Set([...h3Video.nodes(asClip(input, "swap.safetensors", SWAP_FRAMES)), "LoraLoaderModelOnly", ...(input.keepSound ? ["TrimAudioDuration"] : [])])],
  optionalNodes: h3Video.optionalNodes,
  finishing: (input) => h3Video.finishing!(asClip(input, "swap.safetensors", SWAP_FRAMES)),

  build(input, ctx) {
    if (!input.source || !ctx.uploads.source) throw new Error("A swap needs its source video.");
    const swapLora = ctx.slots.swapLora;
    if (!swapLora) throw new Error("The swap needs the Character-Swap LoRA: h3_character_swap_pro4500_1000.safetensors in ComfyUI's models/loras folder (Settings › Models has it).");
    const frames = framesOf(input, ctx);
    const source = ctx.media.source;
    // the source's part is the reference video; its own sound is kept out of the references when the file gets it anyway
    const keep = input.keepSound && Boolean(source?.hasSound);
    const asRef = { ...ctx, uploads: { ...ctx.uploads, "refVideos.0": ctx.uploads.source }, media: { ...ctx.media, "refVideos.0": { ...(source ?? { width: 0, height: 0 }), hasSound: Boolean(source?.hasSound) && !keep } } };
    const size = source?.width && source.height ? { width: source.width, height: source.height } : undefined;
    return buildH3(asClip(input, swapLora, frames, size), asRef, {
      prompt: (pictures) => swapCaption(whoOf(input), pictures),
      // the file's sound: the source's own over the window, cut to the clip's length
      ...(keep ? {
        sound: (g, _decoded, at) => g.out("TrimAudioDuration", { audio: [g.add("GetVideoComponents", { video: g.out("LoadVideo", { file: ctx.uploads.source }) }), 1], start_index: 0, duration: at.frames / H3_FPS }),
      } : {}),
    });
  },

  variants: ((): Variant<H3Swap>[] => {
    const all = {
      unet: "minimax_h3_fl2va.safetensors", clip: "qwen3vl_minimax_h3.safetensors", videoVae: "minimax_h3_video_vae.safetensors", audioVae: "minimax_h3_audio_vae.safetensors",
      turbo: "minimax_h3_turbo.safetensors", rife: "rife49.pth", refUnet: "minimax_h3_ref2va.safetensors", refTurbo: "minimax_h3_ref2v_turbo.safetensors",
      swapLora: "h3_character_swap_pro4500_1000.safetensors",
    };
    const part = { width: 864, height: 480, frames: 141, fps: H3_FPS, hasSound: true };
    return [
      {
        name: "a person of the cast swapped in, the source's sound kept",
        input: { who: "the man in the grey t-shirt", source: { asset: "v1" }, references: [{ asset: "r1", role: "person" }], fast: false },
        slots: all, uploads: { source: "v.mp4", "references.0": "r1.png" }, media: { source: part },
      },
      {
        name: "three pictures, a short part, Turbo, the sound H3 makes",
        input: { who: "the woman on the left.", source: { asset: "v1" }, references: [{ asset: "r1", role: "person" }, { asset: "r2", role: "person" }, { asset: "r3", role: "person" }], keepSound: false },
        slots: all, uploads: { source: "v.mp4", "references.0": "r1.png", "references.1": "r2.png", "references.2": "r3.png" }, media: { source: { ...part, frames: 90, hasSound: false } },
      },
    ];
  })(),
});
