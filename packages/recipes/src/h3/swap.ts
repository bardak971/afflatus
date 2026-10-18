import { defineRecipe, gridAtOrBefore, upstream, type BuildContext, type ClipValue, type GraphBuilder, type InputSpec, type Ref, type StartRule, type Variant } from "@afflatus/core";
import { H3_FPS, H3_GRID, H3_HYBRIDS, SWAP_MODELS } from "./family";
import { modelOf, namedFor } from "./model";
import { h3Inputs, type H3Video } from "./inputs";
import { buildH3, h3Video, type H3Extra } from "./video";
import { saveVideo } from "../shared/out";
import { partBounds } from "../motion/driving";

/**
 * MiniMax H3 · Swap character: a person in a video replaced by someone of the cast, the rest of the video kept. The
 * source video's part is H3's reference video (<Video 1>), the cast's pictures its reference pictures, and the model
 * carries akatz-ai's Character-Swap LoRA (trained on the reference model). The prompt starts as the LoRA's own short
 * caption: a long "preserve everything" prompt broke 2 of 3 swaps, the caption made 3 of 3 (report §5, S1, 2026-10-12). The
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
  /** The reference model the swap runs on, when not the swapUnet slot's: a fine-tune of it, or a distilled one (few steps). */
  swapModel?: string;
  /** The Character-Swap LoRA, when not the swapLora slot's: its V1.5, or another of its versions. */
  swapLora?: string;
  source?: ClipValue;
  sourceStart: number;
  sourceSeconds: number;
  who: string;
  swapStrength: number;
  keepSound: boolean;
  soundGuide: boolean;
  swapSize: string;
  veda: boolean;
  /** Show the mask: the window's masks alone, drawn over its frames, H3 not run (set by the app, not the form). */
  maskPreview: boolean;
  /** The Mask card (the owner, 2026-10-18: every setting of the nodes the user's, with good defaults). Off: no SAM, the whole frame redrawn. */
  maskOn: boolean;
  /** What SAM 3 is told to track (its text prompt). */
  track: string;
  grow: number;
  pasteGrow: number;
  pasteBlur: number;
  pasteReach: number;
  /** How the render goes back over the source: by the person's mask, by difference (AfflatusSwapPaste), or not at all. */
  paste: string;
  pasteThreshold: number;
  detectionThreshold: number;
  maxObjects: number;
  detectInterval: number;
  /** ColorTransfer's strength, a window after the first matched to the window before. */
  matchStrength: number;
  denoise: number;
  vedaGenerated: number;
  vedaReference: number;
}

/** The sizes a swap renders at: the source's own (its short side), or a set height. */
const SWAP_SIZES = ["Source", "480p", "576p", "768p"] as const;

/** The longest window one swap makes, in frames (17k + 5): 5.9 s. */
export const SWAP_FRAMES = 141;
/** The shortest: 90 frames, 3.75 s. H3 was trained on clips of 124 frames and more; the LoRA's author found 4-5 s safest. */
const SWAP_LEAST = 90;
/**
 * Frames of the window before a window carries on from: its last 22, H3's own run-up for a clip continued in its latent
 * (the window before's exact tokens, decoded as one piece with it), dropped from what it shows.
 */
const SWAP_CARRIED = 22;
/** What the Source: length field takes, in seconds. */
const SWAP_PART = (({ least, most }) => ({ min: least, max: most }))(partBounds({ fps: H3_FPS, most: SWAP_FRAMES, least: SWAP_LEAST }));

/** H3's inputs a swap does not take: its prompt is the caption, its length the source's part, its shape the source's. */
const NOT_TAKEN = new Set([
  // the model is a reference model, as the LoRA was trained on (swapModel, else the swapUnet slot): a hybrid fine-tune
  // redrew the room. Whether it is distilled is read from its name, as H3's own
  "model", "hybrid", "turboIn",
  // the size is the swap's own choice (swapSize): the source's, or a height a small phone clip is enlarged to
  "short",
  "description", "soundscape", "music", "start", "end", "mid", "midAt", "handover", "context", "joinFrom", "next", "landing",
  "refVideos", "voice", "voiceStart", "voiceSeconds", "voiceEven", "subject", "seconds", "shape",
  // H3's colour match pulls towards a start picture, which a swap has not
  "colourMatch", "colourStrength",
]);

/**
 * How the designer writes a swap's prompt: what worked on the LoRA's card, its users' reports and the owner's takes
 * (2026-10-18). It cannot see the video or the picture: it takes them from the user's words.
 */
const SWAP_GUIDE = `A SWAP PROMPT is for akatz-ai's Character-Swap LoRA on MiniMax H3's reference model. It is not a scene: the video and the picture give the place, the light, the camera and the motion.
- Start with the LoRA's sentence, the person to replace named by what is visible in <Video 1>: "Replace the young woman with long brown hair in the blue and black jersey in <Video 1> with the man in <Picture 1>." Hair, clothes and place in the frame are what pick them out.
- Say man, woman, boy or girl. Never "character" (it turns the result into a cartoon), never "the person" alone (it often swaps nothing).
- Then a few short sentences: what of <Picture 1> is kept (the face and hair; the clothes of <Video 1> unless the user wants the picture's); "Match the woman's position, scale, pose and movement in <Video 1>."; "Preserve the scene and the other people."; "Do not add any people or objects that are not in <Video 1>."
- No strong expression words (they stopped the swap), no camera, light, style or quality words.
- Keep <Video 1> and <Picture 1> exactly as written, with their angle brackets.
- You cannot see the video or the picture: take what they show from the user's words, never invent a look. When you do not know who is replaced or who goes in, ask ONE question.
- The Track box is what SAM 3 looks for in the video: one to three words, the kind of person replaced (woman, man, girl, dancer, man in black), never a sentence.`;

/** The swap LoRA's trained caption, the prompt a swap starts from. */
export const SWAP_CAPTION = "Swap the person in <Video 1> with the character in <Picture 1>.";
/** The fused turbo's: the caption, then the person kept as the source has them and nothing added (her workflow's sentence). */
const SWAP_TURBO_PROMPT = `${SWAP_CAPTION} Keep the motion, the gestures and the lip movements of <Video 1>. Do not add any people or objects that are not in <Video 1>.`;

const swapInputs: InputSpec[] = [
  {
    // MiniMax's reference model and what is made from it: a fine-tune, or a distilled merge such as the fused reference turbo
    // (4 steps er_sde / beta in her workflow, 3.5 times quicker than ref2va's 20 steps, a little less like the person: §9.10).
    // A hybrid fine-tune too (DaSiWa's): unmasked, one redrew the room 3 times of 3 (2026-10-13); the mask now keeps the room
    id: "swapModel", type: "model", label: "Model", folder: "diffusion_models", slot: "swapUnet", match: [SWAP_MODELS, H3_HYBRIDS],
    note: "MiniMax's reference model (ref2va), the one the swap LoRA was trained on, a model made from it, or a hybrid fine-tune (DaSiWa's: not tried with the swap LoRA yet). A distilled one (its name says turbo or a step count) takes no turbo LoRA: turn Turbo on for its few steps",
  },
  {
    // shown, not only a file of Settings › Models (the owner, 2026-10-18: nothing hidden): V1.5 by default, as its author recommends
    // and as it swapped where V1 (pro4500) did not; V1 still a choice
    id: "swapLora", type: "model", label: "Swap LoRA", folder: "loras", slot: "swapLora", match: ["character.?swap"],
    note: "akatz-ai's Character-Swap LoRA, put first among the LoRAs: V1.5 by default, as its card recommends for new swaps; V1 (pro4500) is its first version",
  },
  { id: "swapStrength", type: "number", label: "Swap LoRA strength", min: 0, max: 2, step: 0.05, default: 1, note: "its author's 1.0; 2 gave artifacts" },
  {
    // The whole prompt, shown as it is sent (the owner, 2026-10-18: nothing hidden). It starts as the swap LoRA's caption; a
    // longer one broke 2 swaps of 3 on ref2va (2026-10-12), and the fused turbo needs the person described (§9.10), so it
    // is the user's. Words with no <Video 1> or <Picture 1> in them (a clip made before) are the person in the caption.
    // SAM's own words missed the man in a crowd ("man in black t-shirt"); the most prominent person tracked found him (§9.9)
    // the designer writes it, by the swap's own guide: from what the user says of the video and the picture (owner, 2026-10-18)
    id: "who", type: "prompt", weights: false, label: "Prompt", style: "sentences", noCast: true, designed: true,
    default: SWAP_CAPTION, placeholder: SWAP_CAPTION,
    note: "the whole prompt. The swap LoRA was trained on its first sentence: keep it first and change only who it names. A distilled model (the fused turbo) wants the person described after it. The words do not choose who is replaced: the click on the stage does, else the largest face",
  },
  {
    id: "source", type: "clip", role: "source", label: "Source video", frames: [SWAP_FRAMES], fps: H3_FPS, whole: true, pick: true,
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
    // the window before, on a timeline's source lane: continued in its latent, its last 22 frames the run-up
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
  { id: "keepSound", type: "toggle", label: "Keep the source's sound", default: true, advanced: true, note: "the file carries the source video's own sound; off, the sound H3 makes" },
  {
    // H3 moves the mouth to the sound it makes with the frames; without the source's, it drew lips to a sound then thrown
    // away for the source's own (the owner, 2026-10-17: "how his lips move are really awkward"). With it, the new mouth
    // followed the source person's 0.57 against 0.46 over the owner's Bulin 47 window, 0.51 against 0.39 on another mask (§9.11)
    id: "soundGuide", type: "toggle", label: "Lips follow the source's sound", default: true, advanced: true, showWhen: "keepSound",
    note: "the source's own sound given to H3 as a guide, as Lip sync gives its recording, so that the mouth is drawn to the words heard",
  },
  // ---- the Mask card: who is replaced is clicked on the stage (the source's pick); these are the nodes' own inputs, at the
  // values the swaps were tested with
  {
    id: "maskOn", type: "toggle", label: "Mask", default: true, chapter: "mask",
    note: "SAM 3 tracks the person and H3 redraws only them, the rest of the source kept as it is. Off: the whole frame is redrawn, nothing of the person's new shape is cut, the room may drift",
  },
  {
    // "person" on every frame kept him where a mask of him from frame 1 lost his head mid-clip (§9.11)
    id: "track", type: "prompt", weights: false, style: "sentences", noCast: true, line: true, label: "Track", default: "person", chapter: "mask", showWhen: "maskOn",
    note: "what SAM 3 looks for (its text prompt): person by default; man, woman or dancer when it misses the one to replace or catches someone else",
  },
  { id: "grow", type: "number", label: "Grow", min: 0, max: 400, step: 4, default: 100, unit: " px", chapter: "mask", showWhen: "maskOn", note: "Swap Mask's grow: how far past the person H3 may redraw. Wider for a new person of another build, fast limbs or long hair" },
  {
    // Difference: the wall H3 redrew close to the source's is the source's again, so it does not waver around the person
    // (the owner's Timeline 19 "aura", 2026-10-18); Mask as tested since 2026-10-16
    id: "paste", type: "choice", label: "Paste", options: ["Mask", "Difference", "Off"], default: "Mask", chapter: "mask", showWhen: "maskOn",
    note: "how the render goes back over the source. Mask: the source's pixels past the person and Paste grow. Difference: the render kept where it clearly differs from the source inside the zone H3 redrew (a new limb), the source's own pixels where H3 only redrew the wall, so no wavering band shows around the person. Off: the render in the whole zone",
  },
  { id: "pasteThreshold", type: "number", label: "Difference threshold", min: 0.01, max: 0.3, step: 0.01, default: 0.06, chapter: "mask", showWhen: { input: "paste", in: ["Difference"] }, note: "AfflatusSwapPaste's threshold: how much the render has to differ from the source to be kept. Higher gives back more of the wall, lower keeps more of what H3 drew" },
  { id: "pasteGrow", type: "number", label: "Paste grow", min: 0, max: 200, step: 2, default: 30, unit: " px", chapter: "mask", showWhen: "maskOn", note: "Swap Mask's paste_grow: how far past the person the render is kept; past it the source's own pixels come back" },
  { id: "pasteBlur", type: "number", label: "Paste blur", min: 0, max: 32, step: 0.5, default: 5, unit: " px", chapter: "mask", showWhen: "maskOn", note: "Swap Mask's paste_blur: the paste-back edge's blur" },
  // ±3: an arm SAM lost for a frame of a fast gesture stays the render's (the owner's Bulin 47 take, §9.11)
  { id: "pasteReach", type: "number", label: "Paste reach", min: 0, max: 12, step: 1, default: 3, unit: " frames", chapter: "mask", showWhen: "maskOn", note: "Swap Mask's paste_reach: the person of this many frames either side is kept too, so a limb SAM loses for a moment is not pasted over" },
  { id: "detectionThreshold", type: "number", label: "Detection threshold", min: 0.05, max: 0.95, step: 0.05, default: 0.3, chapter: "mask", showWhen: "maskOn", note: "SAM3_VideoTrack's detection_threshold: lower finds people it missed, higher drops the ones it should not track" },
  { id: "maxObjects", type: "number", label: "Max objects", min: 1, max: 64, step: 1, default: 8, chapter: "mask", showWhen: "maskOn", note: "SAM3_VideoTrack's max_objects: in a crowd, the one to replace may be past the eighth" },
  { id: "detectInterval", type: "number", label: "Detect interval", min: 1, max: 8, step: 1, default: 1, unit: " frames", chapter: "mask", showWhen: "maskOn", note: "SAM3_VideoTrack's detect_interval: looks for people every this many frames; above 1 faster, less sure in fast motion" },
  // the sampler: below 1 the render keeps more of the source's shapes and motion, the swap weaker
  { id: "denoise", type: "number", label: "Denoise", min: 0.5, max: 1, step: 0.05, default: 1, note: "BasicScheduler's denoise: below 1 the render stays closer to the source's shapes and motion (fewer limbs drawn past the mask), the swap weaker" },
  { id: "matchStrength", type: "number", label: "Colour match strength", min: 0, max: 2, step: 0.05, default: 1, advanced: true, note: "ColorTransfer's strength, a window after the first matched to the window before; lower when its colours drift oddly" },
  { id: "vedaGenerated", type: "number", label: "Veda generated sparsity", min: 8, max: 64, step: 8, default: 32, section: "speed", showWhen: "veda", note: "VedaSparseAttention's generated_sparsity: key tiles kept of each query tile, of the clip's own tokens; fewer is faster" },
  { id: "vedaReference", type: "number", label: "Veda reference sparsity", min: 8, max: 64, step: 8, default: 32, section: "speed", showWhen: "veda", note: "VedaSparseAttention's reference_sparsity: the same of the reference tokens (the source video, the picture)" },
  // Show the mask (the owner's mock, 2026-10-18): the same build, kept to the tracking, the masks and their picture
  { id: "maskPreview", type: "toggle", label: "Mask preview", default: false, internal: true },
  {
    // the tested character-swap workflow runs it at 32 / 32; its makers trained it at 768p on 8-step turbo, other sizes and steps work
    id: "veda", type: "toggle", label: "Veda sparse attention", default: false, advanced: true, section: "speed",
    note: "faster on long windows: a small predictor picks the attention that matters and the rest is skipped, the steps unchanged. Needs the veda-sparse-attention node pack and its predictor for the reference model, both in Settings › Models; without them the full attention runs",
  },
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

/** The prompt sent: as written when it names H3's references, else the caption with its words as the person (a clip made before). */
export function swapPrompt(text: string, pictures: number): string {
  const t = text.trim();
  return /<(Video|Picture) \d+>/i.test(t) ? t : swapCaption(t.replace(/[.!\s]+$/, "") || "the person", pictures);
}

/** What a prompt that names references lacks: the source video, or the cast's picture when there is one. */
export function swapPromptLacks(text: string, pictures: number): string[] {
  if (!/<(Video|Picture) \d+>/i.test(text)) return [];
  return [...(/<Video 1>/i.test(text) ? [] : ["<Video 1>"]), ...(pictures > 0 && !/<Picture 1>/i.test(text) ? ["<Picture 1>"] : [])];
}

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
    // "hybrid" so that the clip takes this file whatever its references; a distilled one is known by its name
    model: unet, hybrid: "Yes", turboIn: "From the name",
    short: shortOf(input.swapSize, size),
    description: "", soundscape: "", music: "", subject: "", midAt: 0,
    start: undefined, end: undefined, mid: undefined, next: undefined, voice: undefined,
    // the window before continued in its latent, as H3's own clips, decoded as one piece with it: carried on by its frames,
    // each window drew the person in its own way and the join showed (softer, darker; the meme, 2026-10-17). Its frames
    // when its latent was not kept or this ComfyUI lacks the continuation nodes
    colourMatch: false, handover: false, context: String(SWAP_CARRIED), joinFrom: "Latent", landing: "22", voiceStart: 0, voiceSeconds: 15, voiceEven: false,
    refVideos: input.source ? [{ asset: input.source.asset, role: "person" }] : [],
    loras: [{ file: swapLora, weight: input.swapStrength }, ...input.loras],
    // the clip's own part: the window less the frames it shares with the window before (buildH3 adds them back)
    seconds: (frames - carried) / H3_FPS,
    shape: size ?? { width: 1024, height: 576 },
  };
}

/**
 * The turbo the swap's model takes, by its file (the form starts on it, Recipe.presets): the fused reference turbo (…refdelta…) as
 * its character-swap workflow runs it (4 steps, er_sde / beta, the model's own shifts 12 / 3: it swapped at 3.5 times
 * ref2va's speed, §9.10), then H3's own (DaSiWa's distilled files: Turbo, 8 steps without a LoRA).
 */
const SWAP_PRESETS = [
  // the person described, nothing added: with the caption alone it took a cartoon on a TV for the person for 3 s (§9.10)
  { match: "refdelta", values: { fast: true, turboSteps: 4, sampler: "er_sde", scheduler: "beta", shiftVideo: 12, shiftAudio: 3, who: SWAP_TURBO_PROMPT }, note: "a fused reference turbo: Turbo, 4 steps, er_sde / beta and the person described, as its swap workflow runs it" },
  ...(h3Video.presets ?? []),
];

/**
 * MiniMax's reference model with Turbo on takes MiniMax's 4-step reference turbo LoRA when it is there (the one made for
 * it, not the frames model's 8-step one): Turbo starts on its 4 steps at 6 / 3. A distilled model takes no LoRA.
 */
const SWAP_STARTS: StartRule[] = [{
  when: {
    all: [
      { input: "fast", is: true },
      { not: { name: { input: "swapModel", slot: "swapUnet" }, match: namedFor.turbo.source } },
      { name: { slot: "refTurbo" }, match: "(^|[^0-9])4[ _-]?steps?([^a-z]|$)" },
    ],
  },
  values: { turboSteps: 4, shiftVideo: 6, shiftAudio: 3 },
}];

/** What the masked swap adds to H3's graph: core's SAM 3 track, noise mask and AV latent nodes, the node pack's Swap Mask. */
const MASK_NODES = ["CheckpointLoaderSimple", "CLIPTextEncode", "SAM3_VideoTrack", "AfflatusSwapMask", "ImageFromBatch", "ImageScale", "VAEEncode", "SetLatentNoiseMask", "LTXVSeparateAVLatent", "LTXVConcatAVLatent", "ImageCompositeMasked", "ColorTransfer"];

/**
 * The masked swap (see the note at the top): the part's frames at the clip's size are tracked by SAM 3.1 ("person", as
 * the most prominent is taken), encoded as the latent the clip is sampled from with the Swap Mask's noise mask, H3's own
 * audio latent beside them; the decoded frames are pasted onto the part's outside the person. The Swap Mask sees the
 * part's frames (their faces pick the person) and, on a window carrying on from the one before, that window's handed-over
 * frames (`before`): where they differ from the part's first frames is the person it replaced, followed here. A first
 * window takes the user's click on its first frame (`click`, shares of the frame) instead: the person under it. `node` is the
 * Swap Mask's id once the graph has it: its notes (no one found, the person before lost) are said on the job.
 */
/** The Mask card's settings, as the nodes take them. */
type MaskSettings = Pick<H3Swap, "track" | "grow" | "pasteGrow" | "pasteBlur" | "pasteReach" | "detectionThreshold" | "maxObjects" | "detectInterval" | "matchStrength" | "paste" | "pasteThreshold">;

function masked(file: string, sam: string, m: MaskSettings, differs: boolean, before?: { file: string; frames: number }, click?: { x: number; y: number }, preview?: (g: GraphBuilder, images: Ref) => string): { extra: Pick<H3Extra, "latent" | "frames">; node: () => string | null; preview: () => string | null } {
  let part: Ref | null = null;
  let masks: string | null = null;
  let handed: Ref | null = null;
  let shown: string | null = null;
  return {
    extra: {
      latent: (g, at) => {
        // asked for inside the sampling phase: the tracking and the mask are processing, not steps of the bar (SAM's 107
        // tracked frames counted as sampling steps, the bar at 4 of 4 while H3 was at 2: the owner, 2026-10-18)
        const sampling = g.at;
        g.phase("processing");
        part = g.out("ImageScale", {
          image: g.out("ImageFromBatch", { image: [g.add("GetVideoComponents", { video: g.out("LoadVideo", { file }) }), 0], batch_index: 0, length: at.frames }),
          upscale_method: "lanczos", width: at.width, height: at.height, crop: "disabled",
        });
        const model = g.add("CheckpointLoaderSimple", { ckpt_name: sam });
        // SAM's own words missed the man in a crowd test; "man" with 8 tracks found him, the largest (§9.9)
        const people = g.out("CLIPTextEncode", { clip: [model, 1], text: m.track.trim() || "person" });
        const track = g.out("SAM3_VideoTrack", { images: part, model: [model, 0], detection_threshold: m.detectionThreshold, max_objects: m.maxObjects, detect_interval: m.detectInterval, conditioning: people });
        handed = before ? g.out("ImageScale", { image: [g.add("GetVideoComponents", { video: g.out("LoadVideo", { file: before.file }) }), 0], upscale_method: "lanczos", width: at.width, height: at.height, crop: "disabled" }) : null;
        // the render kept 30 px past the person (was 10): his edges and a hand SAM lost no longer stop at the source's
        // pixels (the owner's Bulin 47 take, 2026-10-17, §9.11); the node pack keeps it over the frames around each, from 0.24.0
        // paste_reach only when not the node's own 3: a pack before 0.27.0 has no such input
        masks = g.add("AfflatusSwapMask", { track_data: track, frames: at.frames, width: at.width, height: at.height, grow: m.grow, paste_grow: m.pasteGrow, paste_blur: m.pasteBlur, ...(m.pasteReach !== 3 ? { paste_reach: m.pasteReach } : {}), images: part, ...(handed ? { previous: handed } : {}), ...(click && !handed ? { pick_x: click.x, pick_y: click.y } : {}) });
        // Show the mask: the masks drawn over the frames they were made from, saved as a short video of their own
        if (preview) shown = preview(g, g.out("AfflatusSwapMaskPreview", { images: part, noise_mask: [masks, 0], paste_mask: [masks, 1] }));
        const video = g.out("SetLatentNoiseMask", { samples: g.out("VAEEncode", { pixels: part, vae: at.vae }), mask: [masks, 0] });
        const joined = g.out("LTXVConcatAVLatent", { video_latent: video, audio_latent: [g.add("LTXVSeparateAVLatent", { av_latent: at.latent }), 1] });
        g.phase(sampling);
        return joined;
      },
      frames: (g, images) => {
        if (!part || !masks) return images;
        // carrying on: the colours of the window before, its last handed-over frame against this window's frame at the same
        // moment (the last one carried), the one transform on every frame, so its own changes along the window are kept
        const matched = handed && before
          ? g.out("ColorTransfer", {
            image_target: images, image_ref: g.out("ImageFromBatch", { image: handed, batch_index: -1, length: 1 }),
            method: "reinhard_lab", source_stats: "target_frame", "source_stats.target_index": before.frames - 1, strength: m.matchStrength,
          })
          : images;
        if (m.paste === "Off") return matched;
        if (m.paste === "Difference" && differs) {
          return g.out("AfflatusSwapPaste", { render: matched, source: part, noise_mask: [masks, 0], paste_mask: [masks, 1], threshold: m.pasteThreshold, grow: 8, blur: m.pasteBlur, reach: 1 });
        }
        return g.out("ImageCompositeMasked", { destination: part, source: matched, x: 0, y: 0, resize_source: false, mask: [masks, 1] });
      },
    },
    node: () => masks,
    preview: () => shown,
  };
}

export const h3Swap = defineRecipe<H3Swap>({
  id: "h3.swap",
  family: "h3",
  version: 1,
  title: "Swap character",
  summary: "A person in a video replaced by someone of the cast; the scene, the motion and the sound kept.",
  output: "video",
  // a video of its own, made from another: on a timeline's source lane, a window of a long source carrying on from the window
  // before (its last 5 frames pinned at the start), otherwise no join with the clips around it
  traits: { startFrame: false, endFrame: false, midFrames: false, continues: "clip", endAnchor: false, sound: true, fps: H3_FPS, frameGrid: H3_GRID, windows: { most: SWAP_FRAMES, least: SWAP_LEAST, carried: SWAP_CARRIED } },
  inputs: swapInputs,
  guide: SWAP_GUIDE,
  // a character swap's form: the model, its takes, who is replaced and how, then the rest as any form (the owner, 2026-10-18)
  first: ["model", "takes", "mask"],
  // who is replaced and how, apart from the source (the owner, 2026-10-18): the click and Show the mask are the screen's, the
  // rest the nodes' own inputs
  chapters: [{ id: "mask", label: "Mask", help: "Who is replaced and what of the frame H3 redraws: SAM 3 tracks the person clicked on the stage, the Swap Mask grows the zone H3 redraws and the band the render is pasted back over. Show the mask draws them over the source before you render." }],
  presets: SWAP_PRESETS,
  starts: SWAP_STARTS,
  needs: ["swapLora", "swapUnet", "swapSam"],
  // as every other file and node: Veda's predictor when it is on, and a turbo LoRA when Turbo is on a model that is not
  // distilled (the reference one asked for, either taken)
  needsWith: (input, slots = {}) => [
    ...(input.veda ? ["veda"] : []),
    ...(input.fast && !modelOf({ ...input, model: input.swapModel ?? slots.swapUnet, turboIn: "From the name" }, slots).turbo && !slots.refTurbo && !slots.turbo ? ["refTurbo"] : []),
  ],
  // Show the mask runs the tracking and the masks alone (MASK_NODES, the preview node and the video out are optional)
  nodes: (input) => input.maskPreview ? ["LoadVideo", "GetVideoComponents"] : [...new Set([...h3Video.nodes(asClip(input, "swap.safetensors", SWAP_FRAMES, 0, "minimax_h3_ref2va.safetensors")), "LoraLoaderModelOnly", ...(input.keepSound ? ["TrimAudioDuration"] : []), ...(input.keepSound && input.soundGuide ? ["MiniMaxH3AddGuide"] : [])])],
  // the mask's nodes are not asked of a machine: one without them (an older node pack) swaps unmasked, and the job says so
  // Veda's node only serves its toggle, and without its pack the swap runs the full attention and says so on the job: an
  // optional node, so that it never stops a render and Settings › Models offers its pack among the optional ones
  optionalNodes: [...(h3Video.optionalNodes ?? []), ...MASK_NODES, "VedaSparseAttention", "AfflatusSwapMaskPreview", "AfflatusSwapPaste"],
  finishing: (input) => h3Video.finishing!(asClip(input, "swap.safetensors", SWAP_FRAMES, 0, "minimax_h3_ref2va.safetensors")),

  build(input, ctx) {
    if (!input.source || !ctx.uploads.source) throw new Error("A swap needs its source video.");
    const swapLora = input.swapLora ?? ctx.slots.swapLora;
    if (!swapLora) throw new Error("The swap needs the Character-Swap LoRA: h3_character_swap_v1.5.safetensors in ComfyUI's models/loras folder (Settings › Models has it).");
    const unet = input.swapModel ?? ctx.slots.swapUnet;
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
    const preview = input.maskPreview ? (g: GraphBuilder, images: Ref) => saveVideo(g, ctx, { images, fps: H3_FPS, crf: 23 }) : undefined;
    if (preview && !input.maskOn) throw new Error("Show the mask needs the Mask on.");
    if (preview && (!sam || !MASK_NODES.every((n) => ctx.has(n)) || !ctx.has("AfflatusSwapMaskPreview"))) {
      throw new Error(sam ? "Show the mask needs the Afflatus node pack 0.26.0 or newer: restart ComfyUI to load it." : "Show the mask needs SAM 3.1 (Settings › Models has it).");
    }
    const mask = input.maskOn && sam && MASK_NODES.every((n) => ctx.has(n)) ? masked(ctx.uploads.source, sam, input, ctx.has("AfflatusSwapPaste"), carried && ctx.uploads.previous ? { file: ctx.uploads.previous, frames: carried } : undefined, input.source.pick, preview) : null;
    // the source's own sound over the window, cut to the clip's length: one loader for the file's sound and the guide
    let heard: Ref | null = null;
    const sourceSound = (g: GraphBuilder, frames: number) =>
      (heard ??= g.out("TrimAudioDuration", { audio: [g.add("GetVideoComponents", { video: g.out("LoadVideo", { file: ctx.uploads.source }) }), 1], start_index: 0, duration: frames / H3_FPS }));
    const built = buildH3(asClip(input, swapLora, frames, carried, unet, size), asRef, {
      prompt: (pictures) => swapPrompt(input.who, pictures),
      // the file's sound: the source's own over the window
      ...(keep ? { sound: (g, _decoded, at) => sourceSound(g, at.frames) } : {}),
      // and, asked for, the same sound anchored from the window's first frame, as Lip sync anchors its recording
      ...(keep && input.soundGuide ? {
        guide: (g, at) => g.out("MiniMaxH3AddGuide", { positive: at.positive, latent: at.latent, vae: at.vae, audio_vae: at.audioVae, audio: sourceSound(g, at.frames), frame_idx: 0 }),
      } : {}),
      ...(mask?.extra ?? {}),
      ...(input.veda && ctx.slots.veda ? { veda: ctx.slots.veda, vedaSparsity: { generated: input.vedaGenerated, reference: input.vedaReference } } : {}),
      ...(input.denoise < 1 ? { denoise: input.denoise } : {}),
      // the reference model's own turbo LoRA, else the usual one (a distilled model takes neither)
      ...(ctx.slots.refTurbo ?? ctx.slots.turbo ? { turbo: ctx.slots.refTurbo ?? ctx.slots.turbo } : {}),
    });
    // Veda asked for and not there: the clip is made with the full attention, and the job says why
    const veda = input.veda && !ctx.has("VedaSparseAttention")
      ? ["Veda was on, but this ComfyUI has no veda-sparse-attention node pack (ComfyUI-Manager installs it): made with the full attention."]
      : input.veda && !ctx.slots.veda ? ["Veda was on, but its reference-model predictor is not in ComfyUI's models/veda folder (Settings › Models has it): made with the full attention."] : [];
    // a prompt that names neither the source nor the cast's picture still runs: H3 may then leave them out, and the job says so
    const lacks = swapPromptLacks(input.who, input.references.length).map((tag) => `The prompt has no ${tag}: H3 may not use ${tag === "<Video 1>" ? "the source video" : "the cast's picture"}.`);
    // Difference asked for and the pack not yet loaded: pasted by the mask, and said
    const pasted = input.maskOn && input.paste === "Difference" && !ctx.has("AfflatusSwapPaste") ? ["Paste by Difference needs the Afflatus node pack 0.28.0 (restart ComfyUI to load it): pasted by the mask."] : [];
    const notes = [...veda, ...lacks, ...pasted];
    const warned = notes.length ? { ...built, warnings: [...(built.warnings ?? []), ...notes] } : built;
    // Show the mask: only what the tracking, the masks and their picture need, the H3 model never loaded
    const shown = mask?.preview();
    if (shown) {
      const keep = upstream(built.graph, [shown]);
      const graph = Object.fromEntries(Object.entries(built.graph).filter(([id]) => keep.has(id)));
      return {
        ...built, graph, phases: Object.fromEntries(Object.entries(built.phases).filter(([id]) => keep.has(id))),
        outputs: [{ node: shown, kind: "video", role: "result" }], loads: [`checkpoints/${sam}`], light: true, warnings: [], passes: [],
      };
    }
    const said = mask?.node();
    if (said) return { ...warned, outputs: [...warned.outputs, { node: said, kind: "image", role: "note" }] };
    // the Mask turned off: the whole frame redrawn, as asked
    if (!input.maskOn) return warned;
    const why = sam ? "this ComfyUI's Afflatus node pack has no Swap Mask yet (0.22.0 on; ComfyUI loads a newer pack when it restarts)" : "SAM 3.1 is not on this ComfyUI (Settings › Models has it)";
    return { ...warned, warnings: [...(warned.warnings ?? []), `Swapped without a mask, the whole frame redrawn: ${why}.`] };
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
        name: "the lips drawn to the source's own sound, anchored from the first frame",
        input: { who: "the man", source: { asset: "v1" }, references: [{ asset: "r1", role: "person" }], fast: false, soundGuide: true },
        slots: all, uploads: { source: "v.mp4", "references.0": "r1.png" }, media: { source: part },
      },
      {
        name: "the person to replace clicked on the source's first frame",
        input: { who: "the man", source: { asset: "v1", pick: { x: 0.38, y: 0.46 } }, references: [{ asset: "r1", role: "person" }], fast: false },
        slots: all, uploads: { source: "v.mp4", "references.0": "r1.png" }, media: { source: part },
      },
      {
        name: "Veda's sparse attention on the model, its predictor in models/veda",
        input: { who: "the man", source: { asset: "v1" }, references: [{ asset: "r1", role: "person" }], fast: false, veda: true },
        slots: { ...all, veda: "minimax_h3_r2va_veda_preview_fp8.safetensors" }, uploads: { source: "v.mp4", "references.0": "r1.png" }, media: { source: part },
      },
      {
        name: "pasted back by difference: the wall H3 only redrew is the source's again",
        input: { who: "the man", source: { asset: "v1" }, references: [{ asset: "r1", role: "person" }], fast: false, paste: "Difference" },
        slots: all, uploads: { source: "v.mp4", "references.0": "r1.png" }, media: { source: part },
      },
      {
        name: "Show the mask: the window's tracking and masks drawn over its frames, H3 not run",
        input: { who: "the man", source: { asset: "v1", pick: { x: 0.4, y: 0.5 } }, references: [{ asset: "r1", role: "person" }], fast: false, maskPreview: true },
        slots: all, uploads: { source: "v.mp4", "references.0": "r1.png" }, media: { source: part },
      },
      {
        name: "an older node pack, with no Swap Mask: swapped unmasked",
        input: { who: "the man", source: { asset: "v1" }, references: [{ asset: "r1", role: "person" }], fast: false },
        slots: all, uploads: { source: "v.mp4", "references.0": "r1.png" }, media: { source: part }, has: (cls) => cls !== "AfflatusSwapMask",
      },
    ];
  })(),
});
