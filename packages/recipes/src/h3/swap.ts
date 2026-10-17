import { defineRecipe, gridAtOrBefore, type BuildContext, type ClipValue, type InputSpec, type Ref, type Variant } from "@afflatus/core";
import { H3_FPS, H3_GRID } from "./family";
import { h3Inputs, type H3Video } from "./inputs";
import { buildH3, h3Video, type H3Extra } from "./video";
import { partBounds } from "../motion/driving";

/**
 * MiniMax H3 · Swap character: a person in a video replaced by someone of the cast, the rest of the video kept. The
 * source video's part is H3's reference video (<Video 1>), the cast's pictures its reference pictures, and the model
 * carries akatz-ai's Character-Swap LoRA (trained on the reference model) with its own short caption as the whole prompt:
 * a long "preserve everything" prompt broke 2 of 3 swaps, the caption made 3 of 3 (report §5, S1, 2026-10-12). The
 * file's sound is the source's own. One swap holds a window of up to 141 frames (5.9 s at 24): the LoRA's author found
 * 4-5 s windows the safest. A longer video goes on a timeline's source lane, window by window, each window's swap pinned
 * on the last 5 frames of the window before (its own last frames and their sound, a guide at frame 0): the joins came out
 * at 1.2 to 1.6 that way against 3.1 cut (HANDOVER-swap-lipsync-report.md §8, 2026-10-13).
 *
 * Masked (HANDOVER-swap-lipsync-plan.md §9.9, 2026-10-16): SAM 3.1 tracks the people of the part, the Afflatus node
 * pack's Swap Mask takes the most prominent one, and the clip is sampled from the source's own latent with only that
 * person's tokens redrawn; the source's pixels are pasted back outside them. On the Bulin 47 meme the room changed by
 * 1.6 out of 255 against 15 unmasked, the swap as often, the face the same. The whole person is redrawn: with the head
 * alone open, H3 rebuilt the source's own person. Without the pack's node (an older pack) the swap runs unmasked, and the
 * job says so.
 */
export interface H3Swap extends H3Video {
  source?: ClipValue;
  sourceStart: number;
  sourceSeconds: number;
  who: string;
  swapStrength: number;
  keepSound: boolean;
  swapSize: string;
}

/** The sizes a swap renders at: the source's own (its short side), or a set height. */
const SWAP_SIZES = ["Source", "480p", "576p", "768p"] as const;

/** The longest window one swap makes, in frames (17k + 5): 5.9 s. */
export const SWAP_FRAMES = 141;
/** The shortest: 90 frames, 3.75 s. H3 was trained on clips of 124 frames and more; the LoRA's author found 4-5 s safest. */
const SWAP_LEAST = 90;
/** Frames of the window before a window carries on from: pinned at its start, dropped from what it shows. */
const SWAP_CARRIED = 5;
/** What the Source: length field takes, in seconds. */
const SWAP_PART = (({ least, most }) => ({ min: least, max: most }))(partBounds({ fps: H3_FPS, most: SWAP_FRAMES, least: SWAP_LEAST }));

/** H3's inputs a swap does not take: its prompt is the caption, its length the source's part, its shape the source's. */
const NOT_TAKEN = new Set([
  // the model is the reference model the LoRA was trained on (the swapUnet slot): a hybrid fine-tune redrew the room
  "model", "hybrid", "turboIn",
  // the size is the swap's own choice (swapSize): the source's, or a height a small phone clip is enlarged to
  "short",
  "description", "soundscape", "music", "start", "end", "mid", "midAt", "handover", "context", "joinFrom", "next", "landing",
  "refVideos", "voice", "voiceStart", "voiceSeconds", "voiceEven", "subject", "seconds", "shape",
  // H3's colour match pulls towards a start picture, which a swap has not
  "colourMatch", "colourStrength",
]);

const swapInputs: InputSpec[] = [
  {
    id: "who", type: "prompt", weights: false, label: "Who to replace", style: "sentences", noCast: true,
    placeholder: "the man in the grey t-shirt",
    // SAM's own words missed the man in a crowd ("man in black t-shirt"); the most prominent person tracked found him (§9.9)
    note: "a few words that say who is replaced. The person redrawn is the most prominent one in the video (SAM 3.1 tracks them, the rest of the video is kept); the words go into the swap LoRA's own short caption, the whole prompt: a longer prompt broke the swap",
  },
  {
    id: "source", type: "clip", role: "source", label: "Source video", frames: [SWAP_FRAMES], fps: H3_FPS, whole: true,
    window: { start: "sourceStart", seconds: "sourceSeconds", fits: { frames: SWAP_FRAMES, fps: H3_FPS, pad: 0, min: SWAP_LEAST / H3_FPS, grid: H3_GRID } },
    note: "the video whose person is replaced. One swap holds 5.9 s of it; a longer one goes on a timeline's source lane, swapped window by window",
  },
  { id: "sourceStart", type: "number", label: "Source: start", min: 0, max: 3600, step: 0.1, default: 0, unit: " s", showWhen: "source" },
  // the bounds a Motion transfer form's part has, so that every window a timeline makes is taken (its 141 frames and the half
  // frame windows add: 5.875 s refused them). 5.175 s by default: 124 frames, the length the swap held 3 times of 3 at,
  // within the 4-5 s its LoRA's author found safest
  { id: "sourceSeconds", type: "number", label: "Source: length", ...SWAP_PART, step: 0.01, default: 5.175, unit: " s", showWhen: "source" },
  ...h3Inputs.flatMap((spec): InputSpec[] => {
    if (NOT_TAKEN.has(spec.id)) return [];
    // the model's own shifts (MiniMaxH3SigmaShift's defaults), as the swap was tested, not H3's full-step 11 / 4
    if (spec.id === "shiftVideo" && spec.type === "number") return [{ ...spec, default: 12, note: "12, the model's own, as the swaps were tested. Higher gives the first steps more weight (the whole picture and the motion), lower the last ones (detail)" }];
    if (spec.id === "shiftAudio" && spec.type === "number") return [{ ...spec, default: 3, note: "3, the model's own, as the swaps were tested" }];
    if (spec.id === "fast" && spec.type === "toggle") return [{ ...spec, note: "8 steps with the turbo LoRA: not tested with the swap LoRA, whose author ran full steps" }];
    // the window before, on a timeline's source lane: its last 5 frames pinned at the start (the measured join), not its latent
    if (spec.id === "previous" && spec.type === "clip") {
      return [{ ...spec, frames: [SWAP_CARRIED], advanced: true, note: "on a timeline's source lane, the window before: its last frames and their sound start this one, so that the person does not jump at the join" }];
    }
    if (spec.id === "references" && spec.type === "references") {
      // one: the LoRA was trained on one <Picture 1>, and with three of the cast's photos H3 took one's room for the scene (2026-10-13)
      return [{ ...spec, label: "Who goes in", max: 1, roles: ["person"], note: "a picture of the person who takes their place: the cast's first (the face). The scene stays the video's: a second photo brought its own room in" }];
    }
    return [spec];
  }),
  {
    // 576p: small phone clips swapped at their own 352 px held 0 of 4, at 576p 2 of 4 (a tester's clips, 2026-10-13)
    id: "swapSize", type: "choice", label: "Size", options: [...SWAP_SIZES], default: "576p",
    note: "the height it renders at, in the source's shape: 576p by default (a small phone clip swapped better made larger), or the source's own size",
  },
  { id: "swapStrength", type: "number", label: "Swap LoRA strength", min: 0, max: 2, step: 0.05, default: 1, advanced: true, note: "its author's 1.0" },
  { id: "keepSound", type: "toggle", label: "Keep the source's sound", default: true, advanced: true, note: "the file carries the source video's own sound; off, the sound H3 makes" },
];

/** The frames of the window: the part handed over (or asked for), floored to H3's 17k + 5, 90 to 141 (the carried frames among them). */
function framesOf(input: H3Swap, ctx: Pick<BuildContext, "media">): number {
  const have = ctx.media.source?.frames ?? Math.round(input.sourceSeconds * H3_FPS);
  return Math.max(SWAP_LEAST, gridAtOrBefore(Math.min(SWAP_FRAMES, have), H3_GRID));
}
/** The frames of the window before pinned at the start, when there is one: as handed over (5), none without. */
const carriedOf = (input: H3Swap, ctx: Pick<BuildContext, "media">) => (input.previous ? ctx.media.previous?.frames ?? SWAP_CARRIED : 0);

/** The short side a swap renders at: the source's own (within H3's 384 to 1088), or the height asked for. */
function shortOf(choice: string, size?: { width: number; height: number }): number {
  const asked = Number.parseInt(choice, 10);
  if (Number.isFinite(asked)) return asked;
  return size ? Math.max(384, Math.min(1088, Math.min(size.width, size.height))) : 576;
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

/**
 * The swap as an H3 clip: MiniMax's reference model as it is (`unet`), the source's part as its one reference video, the
 * swap LoRA first among the LoRAs, its length the part's, its shape the source's and its size the one picked (576p
 * by default, see swapSize): with the hybrid Turbo fine-tune at 1024 × 576 the room was redrawn 3 times of 3, with ref2va
 * at the source's 864 × 480 it was kept as it was (2026-10-13).
 */
function asClip(input: H3Swap, swapLora: string, frames: number, carried: number, unet?: string, size?: { width: number; height: number }): H3Video {
  return {
    ...input,
    model: unet, hybrid: "Yes", turboIn: "No",
    short: shortOf(input.swapSize, size),
    description: "", soundscape: "", music: "", subject: "", midAt: 0,
    start: undefined, end: undefined, mid: undefined, next: undefined, voice: undefined,
    // the window before's frames are pinned as frames (the measured join), never continued in its latent
    colourMatch: false, handover: false, context: String(SWAP_CARRIED), joinFrom: "Frames", landing: "22", voiceStart: 0, voiceSeconds: 15, voiceEven: false,
    refVideos: input.source ? [{ asset: input.source.asset, role: "person" }] : [],
    loras: [{ file: swapLora, weight: input.swapStrength }, ...input.loras],
    // the clip's own part: the window less the frames it shares with the window before (buildH3 adds them back)
    seconds: (frames - carried) / H3_FPS,
    shape: size ?? { width: 1024, height: 576 },
  };
}

/** What the masked swap adds to H3's graph: core's SAM 3 track, noise mask and AV latent nodes, the node pack's Swap Mask. */
const MASK_NODES = ["CheckpointLoaderSimple", "CLIPTextEncode", "SAM3_VideoTrack", "AfflatusSwapMask", "ImageFromBatch", "ImageScale", "VAEEncode", "SetLatentNoiseMask", "LTXVSeparateAVLatent", "LTXVConcatAVLatent", "ImageCompositeMasked"];

/**
 * The masked swap (see the note at the top): the part's frames at the clip's size are tracked by SAM 3.1 ("person", as
 * the most prominent is taken), encoded as the latent the clip is sampled from with the Swap Mask's noise mask, H3's own
 * audio latent beside them; the decoded frames are pasted onto the part's outside the person. `node` is the Swap Mask's
 * id once the graph has it: its note (no one found) is said on the job.
 */
function masked(file: string, sam: string): { extra: Pick<H3Extra, "latent" | "frames">; node: () => string | null } {
  let part: Ref | null = null;
  let masks: string | null = null;
  return {
    extra: {
      latent: (g, at) => {
        part = g.out("ImageScale", {
          image: g.out("ImageFromBatch", { image: [g.add("GetVideoComponents", { video: g.out("LoadVideo", { file }) }), 0], batch_index: 0, length: at.frames }),
          upscale_method: "lanczos", width: at.width, height: at.height, crop: "disabled",
        });
        const model = g.add("CheckpointLoaderSimple", { ckpt_name: sam });
        // SAM's own words missed the man in a crowd test; "man" with 8 tracks found him, the largest (§9.9)
        const people = g.out("CLIPTextEncode", { clip: [model, 1], text: "person" });
        const track = g.out("SAM3_VideoTrack", { images: part, model: [model, 0], detection_threshold: 0.3, max_objects: 8, detect_interval: 1, conditioning: people });
        masks = g.add("AfflatusSwapMask", { track_data: track, frames: at.frames, width: at.width, height: at.height, grow: 100, paste_grow: 10, paste_blur: 5 });
        const video = g.out("SetLatentNoiseMask", { samples: g.out("VAEEncode", { pixels: part, vae: at.vae }), mask: [masks, 0] });
        return g.out("LTXVConcatAVLatent", { video_latent: video, audio_latent: [g.add("LTXVSeparateAVLatent", { av_latent: at.latent }), 1] });
      },
      frames: (g, images) => (part && masks ? g.out("ImageCompositeMasked", { destination: part, source: images, x: 0, y: 0, resize_source: false, mask: [masks, 1] }) : images),
    },
    node: () => masks,
  };
}

export const h3Swap = defineRecipe<H3Swap>({
  id: "h3.swap",
  family: "h3",
  // hidden for now (the owner's call for 0.5.0: still experimental): not offered anywhere, what was made with it still opens
  hidden: true,
  version: 1,
  title: "Swap character",
  summary: "A person in a video replaced by someone of the cast; the scene, the motion and the sound kept.",
  output: "video",
  // a video of its own, made from another: on a timeline's source lane, a window of a long source carrying on from the window
  // before (its last 5 frames pinned at the start), otherwise no join with the clips around it
  traits: { startFrame: false, endFrame: false, midFrames: false, continues: "clip", endAnchor: false, sound: true, fps: H3_FPS, frameGrid: H3_GRID, windows: { most: SWAP_FRAMES, least: SWAP_LEAST, carried: SWAP_CARRIED } },
  inputs: swapInputs,
  presets: h3Video.presets,
  needs: ["swapLora", "swapUnet", "swapSam"],
  nodes: (input) => [...new Set([...h3Video.nodes(asClip(input, "swap.safetensors", SWAP_FRAMES, 0, "minimax_h3_ref2va.safetensors")), "LoraLoaderModelOnly", ...(input.keepSound ? ["TrimAudioDuration"] : [])])],
  // the mask's nodes are not asked of a machine: one without them (an older node pack) swaps unmasked, and the job says so
  optionalNodes: [...(h3Video.optionalNodes ?? []), ...MASK_NODES],
  finishing: (input) => h3Video.finishing!(asClip(input, "swap.safetensors", SWAP_FRAMES, 0, "minimax_h3_ref2va.safetensors")),

  build(input, ctx) {
    if (!input.source || !ctx.uploads.source) throw new Error("A swap needs its source video.");
    const swapLora = ctx.slots.swapLora;
    if (!swapLora) throw new Error("The swap needs the Character-Swap LoRA: h3_character_swap_pro4500_1000.safetensors in ComfyUI's models/loras folder (Settings › Models has it).");
    const unet = ctx.slots.swapUnet;
    if (!unet) throw new Error("The swap needs MiniMax H3's reference model, the one its LoRA was trained on: minimax_h3_ref2va_*.safetensors in ComfyUI's models/diffusion_models folder (Settings › Models has it).");
    const frames = framesOf(input, ctx);
    const carried = carriedOf(input, ctx);
    const source = ctx.media.source;
    // the source's part is the reference video; its own sound is kept out of the references when the file gets it anyway
    const keep = input.keepSound && Boolean(source?.hasSound);
    // as the research graph that swapped 3 times of 3 (S1): without H3's fp16 accumulation patch, which trades precision for speed
    const asRef = { ...ctx, has: (cls: string) => cls !== "ModelPatchTorchSettings" && ctx.has(cls), uploads: { ...ctx.uploads, "refVideos.0": ctx.uploads.source }, media: { ...ctx.media, "refVideos.0": { ...(source ?? { width: 0, height: 0 }), hasSound: Boolean(source?.hasSound) && !keep } } };
    const size = source?.width && source.height ? { width: source.width, height: source.height } : undefined;
    const sam = ctx.slots.swapSam;
    const mask = sam && MASK_NODES.every((n) => ctx.has(n)) ? masked(ctx.uploads.source, sam) : null;
    const built = buildH3(asClip(input, swapLora, frames, carried, unet, size), asRef, {
      prompt: (pictures) => swapCaption(whoOf(input), pictures),
      // the file's sound: the source's own over the window, cut to the clip's length
      ...(keep ? {
        sound: (g, _decoded, at) => g.out("TrimAudioDuration", { audio: [g.add("GetVideoComponents", { video: g.out("LoadVideo", { file: ctx.uploads.source }) }), 1], start_index: 0, duration: at.frames / H3_FPS }),
      } : {}),
      ...(mask?.extra ?? {}),
    });
    const said = mask?.node();
    if (said) return { ...built, outputs: [...built.outputs, { node: said, kind: "image", role: "note" }] };
    const why = sam ? "this ComfyUI's Afflatus node pack has no Swap Mask yet (0.22.0 on; ComfyUI loads a newer pack when it restarts)" : "SAM 3.1 is not on this ComfyUI (Settings › Models has it)";
    return { ...built, warnings: [...(built.warnings ?? []), `Swapped without a mask, the whole frame redrawn: ${why}.`] };
  },

  variants: ((): Variant<H3Swap>[] => {
    const all = {
      unet: "minimax_h3_fl2va.safetensors", clip: "qwen3vl_minimax_h3.safetensors", videoVae: "minimax_h3_video_vae.safetensors", audioVae: "minimax_h3_audio_vae.safetensors",
      turbo: "minimax_h3_turbo.safetensors", rife: "rife49.pth", refUnet: "minimax_h3_ref2va.safetensors", refTurbo: "minimax_h3_ref2v_turbo.safetensors",
      swapLora: "h3_character_swap_pro4500_1000.safetensors", swapUnet: "minimax_h3_ref2va_pruned.safetensors", swapSam: "sam3.1_multiplex_fp16.safetensors",
    };
    const part = { width: 864, height: 480, frames: 141, fps: H3_FPS, hasSound: true };
    return [
      {
        name: "a person of the cast swapped in, the source's sound kept",
        input: { who: "the man in the grey t-shirt", source: { asset: "v1" }, references: [{ asset: "r1", role: "person" }], fast: false },
        slots: all, uploads: { source: "v.mp4", "references.0": "r1.png" }, media: { source: part },
      },
      {
        name: "a window of a long source, carrying on from the window before",
        input: { who: "the man", source: { asset: "v1", at: 5 }, previous: { asset: "w1" }, references: [{ asset: "r1", role: "person" }], fast: false },
        slots: all, uploads: { source: "v.mp4", previous: "w.mp4", "references.0": "r1.png" }, media: { source: { ...part, frames: 124 }, previous: { width: 864, height: 480, frames: 5, fps: H3_FPS, hasSound: true } },
      },
      {
        name: "a short part, Turbo, the sound H3 makes",
        input: { who: "the woman on the left.", source: { asset: "v1" }, references: [{ asset: "r1", role: "person" }], keepSound: false, fast: true },
        slots: all, uploads: { source: "v.mp4", "references.0": "r1.png" }, media: { source: { ...part, frames: 90, hasSound: false } },
      },
      {
        name: "an older node pack, with no Swap Mask: swapped unmasked",
        input: { who: "the man", source: { asset: "v1" }, references: [{ asset: "r1", role: "person" }], fast: false },
        slots: all, uploads: { source: "v.mp4", "references.0": "r1.png" }, media: { source: part }, has: (cls) => cls !== "AfflatusSwapMask",
      },
    ];
  })(),
});
