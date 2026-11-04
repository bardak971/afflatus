import { gridAtOrBefore, OWN_MODEL, typedInto, upstream, type BuildContext, type ClipValue, type GraphBuilder, type InputSpec, type Ref, type StartRule, type Variant } from "@afflatus/core";
import { H3_FPS, H3_GRID, H3_HYBRIDS, SWAP_MODELS } from "./family";
import { modelOf, REF_TURBO_4_STEPS, REF_TURBO_4_VALUES } from "./model";
import { SOURCE_SOUND_INPUTS, SOURCE_START, type H3Video } from "./inputs";
import { SWAP_MODEL_TURBO, SWAP_TURBO_ROW } from "./turboRow";
/** Said in the "?" of a swap's parts (card #49): the tags are written for them. */
const PART_NO_TAGS = "No <Video 1> or <Picture 1> to type: Afflatus adds them";
import { H3_PRESETS, refinesOnly, SHOT_WORDS, type H3Extra } from "./clip";
import { h3Form, sourceSound, sourceSoundNodes } from "./form";
import { saveVideo } from "../shared/out";
import { partBounds } from "../motion/driving";
import { H3_LANDINGS } from "./join";
import { FACE_REFINE_SLOTS, faceRefineNeeds } from "./faceRefine";
import { SAM_FILE, samModel } from "../shared/sam";

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
  /** The prompt's parts (card #34): who the source shows (by look), how the one who goes in looks, what happens in this window. */
  inSource: string;
  look: string;
  happens: string;
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
  pasteSpread: number;
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
 * Frames of the window before a window carries on from: its last 22 unless the form says 5 or 39 ("Frames from the clip
 * before", as H3's own clips: the owner, 2026-10-20), H3's run-up for a clip continued in its latent (the window before's
 * exact tokens, decoded as one piece with it), dropped from what it shows.
 */
const SWAP_CARRIED = 22;
/** The run-ups a window takes, and the input that sets it: H3's own (the server cuts the source's windows for it). */
export const SWAP_RUN_UP = { input: "context", counts: H3_LANDINGS.map(Number) };
/**
 * What each window of a source keeps its own: its prompt (the owner, 2026-10-20: clip 6 can show something else than clip 2),
 * and its sound cues, which land at a moment of that window alone.
 */
export const SWAP_OWN = ["who", "happens", "cues"];
/** What the Source: length field takes, in seconds. */
const SWAP_PART = (({ least, most }) => ({ min: least, max: most }))(partBounds({ fps: H3_FPS, most: SWAP_FRAMES, least: SWAP_LEAST }));

/** H3's inputs a swap does not take, each with why: its prompt is the caption, its length the source's part, its shape the source's. */
const SOURCE_KEPT = "the source video is the scene: its own place, light, frames and length";
const SOURCE_VOICE = "the file's sound is the source's own, or the one H3 makes";
const SWAP_FACE = "not tested yet, card #224: the swap is drawn from the person's picture on every window (Face refine in its place is Video with audio's and Lip sync's, card #223)";
const SWAP_DROP: Record<string, string> = {
  // the model is a reference model, as the LoRA was trained on (swapModel, else the swapUnet slot): a hybrid fine-tune
  // redrew the room. Hybrid stays off the form: the swap runs its own model as a hybrid would, whatever its references, and
  // "No" would hand the clip to the reference slot. Distilled model is the form's, as on every H3 form (card #170)
  model: "the swap's own Model (swapModel): a reference model, as the swap LoRA was trained on",
  hybrid: "the swap runs its own model as a hybrid would, whatever its references: \"No\" would hand the clip to the reference slot",
  // the size is the swap's own choice (swapSize): the source's, or a height a small phone clip is enlarged to
  short: "the swap's own Resolution (swapSize): the source's size, or a height a small phone clip is enlarged to",
  description: "its own Prompt as sent (who), written from its parts, the swap LoRA's caption first",
  soundscape: "the source's own sound is the scene's", music: "the source's own sound is the scene's",
  start: SOURCE_KEPT, end: SOURCE_KEPT, mid: SOURCE_KEPT, midAt: SOURCE_KEPT,
  // the frozen tail is never skipped on a source's windows: the window after would no longer start where its part does
  handover: "the frozen tail is never skipped on a source's windows: the window after would no longer start where its part does",
  next: "a window carries on from the one before, and lands on none", landing: "a window carries on from the one before, and lands on none",
  faceCarried: SWAP_FACE, holdFace: SWAP_FACE,
  refVideos: "the source's part is its one reference video (<Video 1>)",
  voice: SOURCE_VOICE, voiceStart: SOURCE_VOICE, voiceSeconds: SOURCE_VOICE, voiceEven: SOURCE_VOICE,
  subject: "how the one who goes in looks is the form's own How they look (look)",
  seconds: "the source's part is its length", shape: "the source's shape",
  // H3's colour match pulls towards a start picture, which a swap has not
  colourMatch: "H3's colour match pulls towards a start picture, which a swap has not",
  colourStrength: "H3's colour match pulls towards a start picture, which a swap has not",
};

/**
 * How the designer writes a swap's prompt: what worked on the LoRA's card, its users' reports and the owner's takes
 * (2026-10-18). It cannot see the video or the picture: it takes them from the user's words.
 */
export const SWAP_GUIDE = `A SWAP PROMPT is for akatz-ai's Character-Swap LoRA on MiniMax H3's reference model. It is not a scene: the video and the picture give the place, the light, the camera and the motion.
- THE PARTS come first: write "In the source" (who the source shows and is replaced, by how they look: "the young woman in the blue and black jersey"), "How they look" (the one who goes in: what of them the picture does not say, clothes, hair) and "What happens" (in this clip, present tense, a short sentence). Leave "Prompt as sent" empty: Afflatus writes it from the parts, the LoRA's sentence first. Write "Prompt as sent" only when the user asks for a whole prompt of their own; then the rules below are its rules.
- A Prompt kit person may be named "@Name" in a part: keep it as written, Afflatus casts them and says how they look.
- Start with the LoRA's sentence, the person to replace named by what is visible in <Video 1>: "Replace the young woman with long brown hair in the blue and black jersey in <Video 1> with the man in <Picture 1>." Hair, clothes and place in the frame are what pick them out.
- Say man, woman, boy or girl. Never "character" (it turns the result into a cartoon), never "the person" alone (it often swaps nothing).
- Then a few short sentences: what of <Picture 1> is kept (the face and hair; the clothes of <Video 1> unless the user wants the picture's); "Match the position, scale, pose and movement in <Video 1>."; "Keep the room of <Video 1> exactly as it is."
- Name the person replaced once, in the first sentence: a later mention ("the woman's position") names them to the model again, as a negation names what it denies.
- Say only what to keep, in positive words. Never a negation and never a mention of what is unwanted: the model reads "do not add people" or "the other people" as people, and drew some (the owner's take, 2026-10-18). Name no one but the person replaced and the one who goes in.
- No strong expression words (they stopped the swap), no camera, light, style or quality words.
- Keep <Video 1> and <Picture 1> exactly as written, with their angle brackets.
- You cannot see the video or the picture: take what they show from the user's words, never invent a look. When you do not know who is replaced or who goes in, ask ONE question.
- The Track box is what SAM 3 looks for in the video: one to three words, the kind of person replaced (woman, man, girl, dancer, man in black), never a sentence.`;

/** The swap LoRA's trained caption, the prompt a swap starts from. */
export const SWAP_CAPTION = "Swap the person in <Video 1> with the character in <Picture 1>.";
/** The fused turbo's: the caption, then the person's motion and the room kept as the source has them. */
// Positive words only: "Do not add any people or objects…" drew people at the table behind him (the owner's Timeline 19
// take, 2026-10-18); the text encoder reads a negation as what it names
const SWAP_TURBO_PROMPT = `${SWAP_CAPTION} Keep the motion, the gestures and the lip movements of <Video 1>. Keep the room of <Video 1> exactly as it is.`;

/** The swap's inputs, laid around H3's shared ones (those it takes). */
const swapInputs = (shared: InputSpec[]): InputSpec[] => [
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
  // the prompt's parts (card #34, the owner's mock of 2026-10-20): each a few words, the prompt written from them by rules
  // (swapFromParts); names mean nothing to H3, so the person in the source is said by how they look. What happens heads
  // the Prompt card, with the Designer and Snippets, as on every H3 form (card #170, 2026-10-30)
  { id: "happens", type: "prompt", weights: false, label: "What happens", style: "sentences", optional: true, noCast: true, designed: true, placeholder: "He dances and steps toward the camera.", note: `in this clip, in the present tense. Each window of a source keeps its own. ${PART_NO_TAGS}`, main: true },
  { id: "look", type: "prompt", weights: false, label: "How they look", style: "sentences", line: true, optional: true, noCast: true, designed: true, placeholder: "a black leather jacket over a white t-shirt", note: `the one who goes in: what of them the picture does not say, or says otherwise (clothes, hair). Shared by a source's windows. ${PART_NO_TAGS}` },
  { id: "inSource", type: "prompt", weights: false, label: "In the source", style: "sentences", line: true, optional: true, noCast: true, designed: true, placeholder: "the man in the grey hoodie", note: `who the source shows and is replaced, by how they look (a name means nothing to H3). ${PART_NO_TAGS}` },
  {
    // The whole prompt, shown as it is sent (the owner, 2026-10-18: nothing hidden). It starts as the swap LoRA's caption; a
    // longer one broke 2 swaps of 3 on ref2va (2026-10-12), and the fused turbo needs the person described (§9.10), so it
    // is the user's. Words with no <Video 1> or <Picture 1> in them (a clip made before) are the person in the caption.
    // SAM's own words missed the man in a crowd ("man in black t-shirt"); the most prominent person tracked found him (§9.9)
    // the designer writes it, by the swap's own guide: from what the user says of the video and the picture (owner, 2026-10-18)
    id: "who", type: "prompt", weights: false, label: "Prompt as sent", style: "sentences", noCast: true, designed: true, optional: true,
    default: "", placeholder: SWAP_CAPTION,
    // empty, the swap LoRA's caption comes first, as it was trained; typed without the tags, its words are who is replaced in it
    note: "empty: written from the parts above; typed with <Video 1> or <Picture 1>: sent as is; typed without them: its words name who is replaced, inside the swap LoRA's caption. <Video 1> is the source, <Picture 1> the person. The click on the stage picks who is replaced, not the words",
  },
  {
    id: "source", type: "clip", role: "source", label: "Source video", frames: [SWAP_FRAMES], fps: H3_FPS, whole: true, pick: true,
    window: { start: "sourceStart", seconds: "sourceSeconds", fits: { frames: SWAP_FRAMES, fps: H3_FPS, pad: 0, min: SWAP_LEAST / H3_FPS, grid: H3_GRID } },
    note: "the video whose person is replaced. One swap holds 5.9 s of it; a longer one goes on a timeline's source lane, swapped window by window",
  },
  SOURCE_START,
  // the bounds a Motion transfer form's part has, so that every window a timeline makes is taken (its 141 frames and the half
  // frame windows add: 5.875 s refused them). 5.175 s by default: 124 frames, the length the swap held 3 times of 3 at,
  // within the 4-5 s its LoRA's author found safest
  { id: "sourceSeconds", type: "number", label: "Source: length", ...SWAP_PART, step: 0.01, default: 5.175, unit: " s", showWhen: "source" },
  ...shared.flatMap((spec): InputSpec[] => {
    // the model's own shifts (MiniMaxH3SigmaShift's defaults), as the swap was tested, not H3's full-step 11 / 4
    if (spec.id === "shiftVideo" && spec.type === "number") return [{ ...spec, default: 12, note: "12, the model's own, as the swaps were tested. Higher gives the first steps more weight (the whole picture and the motion), lower the last ones (detail)" }];
    if (spec.id === "shiftAudio" && spec.type === "number") return [{ ...spec, default: 3, note: "3, the model's own, as the swaps were tested" }];
    // Turbo says what it says on every H3 form (card #191): its own note ("8 steps… not tested with the swap LoRA") was wrong
    // since the swaps ran Turbo (MiniMax's 4-step reference LoRA at 4 steps, SWAP_STARTS; the fused turbo model as it is)
    // the swap's own model (the owner, 2026-10-29, card #159): one model in memory, where the fused turbo beside it was a
    // second one every job loaded again
    if (spec.id === "faceRefineModel" && spec.type === "model") return [{ ...spec, default: OWN_MODEL }];
    // Turbo's row, on the swap's own model (card #160)
    if (spec.id === "loras" && spec.type === "loras") return [{ ...spec, added: [SWAP_TURBO_ROW] }];
    // the window before, on a timeline's source lane: continued in its latent, its last frames (Overlap frames) the run-up
    if (spec.id === "previous" && spec.type === "clip") {
      return [{ ...spec, advanced: true, note: "on a timeline's source lane, the window before: its last frames and their sound start this one, so that the person does not jump at the join" }];
    }
    if (spec.id === "references" && spec.type === "references") {
      // one: the LoRA was trained on one <Picture 1>, and with three of the cast's photos H3 took one's room for the scene (2026-10-13)
      return [{ ...spec, max: 1, roles: ["person"], note: "a picture of the person who takes their place: the cast's first (the face). The scene stays the video's: a second photo brought its own room in" }];
    }
    return [spec];
  }),
  {
    // 576p: small phone clips swapped at their own 352 px held 0 of 4, at 576p 2 of 4 (a tester's clips, 2026-10-13)
    id: "swapSize", type: "choice", label: "Resolution", options: [...SWAP_SIZES], default: "576p", section: "out",
    note: "the height it renders at, in the source's shape: 576p by default (a small phone clip swapped better made larger), or the source's own size",
  },
  ...SOURCE_SOUND_INPUTS,
  // ---- the Mask card: who is replaced is clicked on the stage (the source's pick); these are the nodes' own inputs, at the
  // values the swaps were tested with
  {
    // off by default (the owner, 2026-10-18): without it a selfie-like clip swapped whole from frame 0 with no edge, where
    // every masked take showed the redrawn zone around the person. Experimental (the owner, 2026-10-19): parked, kept for
    // whoever wants to take it further (HANDOVER-swap-motion.md and STATUS have what was tried and what is left)
    id: "maskOn", type: "toggle", label: "Mask (experimental)", default: false, chapter: "mask",
    note: "SAM 3 tracks the person and H3 redraws only them, the rest of the source kept as it is. Off: the whole frame is redrawn, nothing of the person's new shape is cut, the room may drift",
  },
  {
    // "person" on every frame kept him where a mask of him from frame 1 lost his head mid-clip (§9.11)
    id: "track", type: "prompt", weights: false, style: "sentences", noCast: true, line: true, label: "Track", default: "person", chapter: "mask", showWhen: "maskOn",
    note: "what SAM 3 looks for (its text prompt): person by default; man, woman or dancer when it misses the one to replace or catches someone else",
  },
  { id: "grow", type: "number", label: "Mask grow", min: 0, max: 400, step: 4, default: 100, unit: " px", chapter: "mask", showWhen: "maskOn", note: "Swap Mask's grow: how far past the person H3 may redraw. Wider for a new person of another build, fast limbs or long hair" },
  {
    // Difference: the wall H3 redrew close to the source's is the source's again, so it does not waver around the person
    // (the owner's Timeline 19 "aura", 2026-10-18); Mask as tested since 2026-10-16
    id: "paste", type: "choice", label: "Paste", options: ["Mask", "Difference", "Off"], default: "Mask", chapter: "mask", showWhen: "maskOn",
    note: "how the render goes back over the source. Mask: the source's pixels past the person and Paste grow. Difference: the render kept where it clearly differs from the source inside the zone H3 redrew (a new limb), the source's own pixels where H3 only redrew the wall, so no wavering band shows around the person. Off: the render in the whole zone",
  },
  { id: "pasteThreshold", type: "number", label: "Difference threshold", min: 0.01, max: 0.3, step: 0.01, default: 0.06, chapter: "mask", showWhen: { input: "paste", in: ["Difference"] }, note: "AfflatusSwapPaste's threshold: how much the render has to differ from the source to be kept. Higher gives back more of the wall, lower keeps more of what H3 drew" },
  // people H3 invents near the person (the table behind him, Grow 160: the owner, 2026-10-18) are not kept past it
  { id: "pasteSpread", type: "number", label: "Difference spread", min: 0, max: 200, step: 4, default: 40, unit: " px", chapter: "mask", showWhen: { input: "paste", in: ["Difference"] }, note: "AfflatusSwapPaste's spread: how far from the person what differs is kept. Wider keeps a limb that moves far, narrower drops someone H3 invented nearby" },
  { id: "pasteGrow", type: "number", label: "Paste grow", min: 0, max: 200, step: 2, default: 30, unit: " px", chapter: "mask", showWhen: "maskOn", note: "Swap Mask's paste_grow: how far past the person the render is kept; past it the source's own pixels come back" },
  { id: "pasteBlur", type: "number", label: "Paste blur", min: 0, max: 32, step: 0.5, default: 5, unit: " px", chapter: "mask", showWhen: "maskOn", note: "Swap Mask's paste_blur: the paste-back edge's blur" },
  // ±3: an arm SAM lost for a frame of a fast gesture stays the render's (the owner's Bulin 47 take, §9.11)
  { id: "pasteReach", type: "number", label: "Paste reach", min: 0, max: 12, step: 1, default: 3, unit: " frames", chapter: "mask", showWhen: "maskOn", note: "Swap Mask's paste_reach: the person of this many frames either side is kept too, so a limb SAM loses for a moment is not pasted over" },
  { id: "detectionThreshold", type: "number", label: "Detection threshold", min: 0.05, max: 0.95, step: 0.05, default: 0.3, chapter: "mask", showWhen: "maskOn", note: "SAM3_VideoTrack's detection_threshold: lower finds people it missed, higher drops the ones it should not track" },
  { id: "maxObjects", type: "number", label: "Max objects", min: 1, max: 64, step: 1, default: 8, chapter: "mask", showWhen: "maskOn", note: "SAM3_VideoTrack's max_objects: in a crowd, the one to replace may be past the eighth" },
  { id: "detectInterval", type: "number", label: "Detect interval", min: 1, max: 8, step: 1, default: 1, unit: " frames", chapter: "mask", showWhen: "maskOn", note: "SAM3_VideoTrack's detect_interval: looks for people every this many frames; above 1 faster, less sure in fast motion" },
  // the sampler: below 1 the render keeps more of the source's shapes and motion, the swap weaker
  { id: "denoise", type: "number", label: "Denoise", min: 0.5, max: 1, step: 0.05, default: 1, advanced: true, section: "speed", note: "BasicScheduler's denoise at H3's shift: with 4 or 8 steps, int(steps ÷ denoise) makes 0.9 the same as 1, and 0.6 to 1 all start from 0.93–1.00 of real noise; 0.5 from about 0.9. Below 1 the render stays a little closer to the source's shapes and motion (fewer limbs drawn past the mask), the swap weaker" },
  { id: "matchStrength", type: "number", label: "Colour match between windows", min: 0, max: 2, step: 0.05, default: 1, advanced: true, note: "ColorTransfer's strength, a window after the first matched to the window before; lower when its colours drift oddly" },
  // Show the mask (the owner's mock, 2026-10-18): the same build, kept to the tracking, the masks and their picture
  { id: "maskPreview", type: "toggle", label: "Mask preview", default: false, internal: true },
];

/** The frames of the window: the part handed over (or asked for), floored to H3's 17k + 5, 90 to 141 (the carried frames among them). */
export function framesOf(input: H3Swap, ctx: Pick<BuildContext, "media">): number {
  const have = ctx.media.source?.frames ?? Math.round(input.sourceSeconds * H3_FPS);
  return Math.max(SWAP_LEAST, gridAtOrBefore(Math.min(SWAP_FRAMES, have), H3_GRID));
}
/** The frames of the window before pinned at the start, when there is one: as handed over (Overlap frames), none without. */
export const carriedOf = (input: H3Swap, ctx: Pick<BuildContext, "media">) => (input.previous ? ctx.media.previous?.frames ?? SWAP_CARRIED : 0);

/** The short side a swap renders at: the source's own (within H3's 384 to 1088), or the height asked for. */
export function shortOf(choice: string, size?: { width: number; height: number }): number {
  const asked = Number.parseInt(choice, 10);
  if (Number.isFinite(asked)) return asked;
  return size ? Math.max(384, Math.min(1088, Math.min(size.width, size.height))) : 576;
}

/** The prompt sent: as written when it names H3's references, else the caption with its words as the person (a clip made before). */
/** A part as a sentence: its first letter up, a full stop at its end. */
const asSentence = (s: string) => {
  const t = s.trim().replace(/\s+/g, " ");
  return t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? "" : "."}` : "";
};
/** A part as words inside a sentence: no full stop at its end. */
const asWords = (s: string) => s.trim().replace(/\s+/g, " ").replace(/[.!\s]+$/, "");

/**
 * The prompts a form may hold without the user having written them: the caption, the fused turbo's preset (which wrote it
 * into the field until 0.6.1, card #49). Read as empty, here and by the form (Recipe.partsStartOn).
 */
const SWAP_STARTED_ON = [SWAP_CAPTION, SWAP_TURBO_PROMPT] as const;
/** The prompt as sent was typed (edited by hand): it is sent as it is, the parts waiting. */
export const typedPrompt = (who: string) => typedInto({ partsStartOn: SWAP_STARTED_ON }, who);

/**
 * The swap's prompt written from its parts (card #34), by rules: the LoRA's caption first with the person the source shows
 * ("Swap the man in the grey hoodie in <Video 1> with the character in <Picture 1>."), how the one who goes in looks, what
 * happens; the fused reference turbo's own sentences last, as its preset had them. Positive words only (H3 draws what a
 * negation names). With every part empty it is the caption alone, as before.
 */
export function swapFromParts(input: Pick<H3Swap, "inSource" | "look" | "happens" | "swapModel" | "shot">, pictures: number): string {
  const who = asWords(input.inSource ?? "") || "the person";
  const look = asWords(input.look ?? "");
  const said = [swapCaption(who, pictures), SHOT_WORDS[input.shot ?? ""] ?? "", look ? `The character in <Picture 1>: ${look}.` : "", asSentence(input.happens ?? "")];
  if (/refdelta/i.test(input.swapModel ?? "")) said.push("Keep the motion, the gestures and the lip movements of <Video 1>. Keep the room of <Video 1> exactly as it is.");
  return said.filter(Boolean).join(" ");
}

/** What is sent: the prompt typed, else the one written from the parts. */
export const swapSent = (input: H3Swap, pictures: number) => (typedPrompt(input.who) ? input.who : swapFromParts(input, pictures));

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
export function asClip(input: H3Swap, swapLora: string | null, frames: number, carried: number, unet?: string, size?: { width: number; height: number }): H3Video {
  return {
    ...input,
    // "hybrid" so that the clip takes this file whatever its references; a distilled one is known by its name
    model: unet, hybrid: "Yes", turboIn: input.turboIn || "From the name",
    short: shortOf(input.swapSize, size),
    description: "", soundscape: "", music: "", subject: "", midAt: 0,
    start: undefined, end: undefined, mid: undefined, next: undefined, voice: undefined,
    // the window before continued in its latent, as H3's own clips, decoded as one piece with it: carried on by its frames,
    // each window drew the person in its own way and the join showed (softer, darker; the meme, 2026-10-17). Its frames
    // when its latent was not kept or this ComfyUI lacks the continuation nodes
    // The run-up as the form says (22 unless set), from the latent unless asked for its frames
    colourMatch: false, handover: false, context: input.context || String(SWAP_CARRIED), joinFrom: input.joinFrom || "Latent", landing: "22", voiceStart: 0, voiceSeconds: 15, voiceEven: false,
    // no swap LoRA (a Motion transfer window after a swap, driven by its pose): no source video either, the person replaced never in the input
    refVideos: input.source && swapLora ? [{ asset: input.source.asset, role: "person" }] : [],
    loras: swapLora ? [{ file: swapLora, weight: input.swapStrength }, ...input.loras] : input.loras,
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
export const SWAP_PRESETS = [
  // its sampling only: the person described and its own sentences come from the parts (swapFromParts adds them for a
  // refdelta model; with the caption alone it took a cartoon on a TV for the person for 3 s, §9.10). Written into the
  // prompt as sent, the preset hid what the parts write (card #49)
  { match: "refdelta", values: { fast: true, turboSteps: 4, sampler: "er_sde", scheduler: "beta", shiftVideo: 12, shiftAudio: 3 }, note: "a fused reference turbo: Turbo, 4 steps, er_sde / beta, as its swap workflow runs it" },
  // DaSiWa's hybrid turbo as it swapped and kept the video in 2 takes of 2, where the fused turbo did in 2 of 4 (the owner's cheese clip, 2026-10-29)
  { match: "dasiwa.*hybrid.*turbo", values: { fast: true, turboSteps: 8, sampler: "euler", scheduler: "simple", shiftVideo: 8, shiftAudio: 4 }, note: "DaSiWa's hybrid turbo: Turbo, 8 steps, euler / simple, shift 8 / 4, as its swaps were tested" },
  ...H3_PRESETS,
];

/**
 * MiniMax's reference model with Turbo on takes MiniMax's 4-step reference turbo LoRA when it is there (the one made for
 * it, not the frames model's 8-step one): Turbo starts on its 4 steps at 6 / 3. A distilled model takes no LoRA.
 */
export const SWAP_STARTS: StartRule[] = [{
  when: {
    all: [
      { input: "fast", is: true },
      { not: SWAP_MODEL_TURBO },
      REF_TURBO_4_STEPS,
    ],
  },
  values: REF_TURBO_4_VALUES,
}];

/** What the masked swap adds to H3's graph: core's SAM 3 track, noise mask and AV latent nodes, the node pack's Swap Mask. */
export const MASK_NODES = ["CheckpointLoaderSimple", "CLIPTextEncode", "SAM3_VideoTrack", "AfflatusSwapMask", "ImageFromBatch", "ImageScale", "VAEEncode", "SetLatentNoiseMask", "LTXVSeparateAVLatent", "LTXVConcatAVLatent", "ImageCompositeMasked", "ColorTransfer"];

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
type MaskSettings = Pick<H3Swap, "track" | "grow" | "pasteGrow" | "pasteBlur" | "pasteReach" | "detectionThreshold" | "maxObjects" | "detectInterval" | "matchStrength" | "paste" | "pasteThreshold" | "pasteSpread">;

function masked(file: string, sam: string, m: MaskSettings, has: (cls: string) => boolean, before?: { file: string; frames: number }, click?: { x: number; y: number }, preview?: (g: GraphBuilder, images: Ref) => string): { extra: Pick<H3Extra, "latent" | "frames">; node: () => string | null; preview: () => string | null } {
  let part: Ref | null = null;
  let masks: string | null = null;
  let handed: Ref | null = null;
  let shown: string | null = null;
  // the part's frames at the clip's size, SAM's tracking and the Swap Mask: what the latent is masked by and the paste-back reads
  const prepare = (g: GraphBuilder, at: { width: number; height: number; frames: number }) => {
    // asked for inside the sampling phase: the tracking and the mask are processing, not steps of the bar (SAM's 107
    // tracked frames counted as sampling steps, the bar at 4 of 4 while H3 was at 2: the owner, 2026-10-18)
    const was = g.at;
    g.phase("processing");
    part = g.out("ImageScale", {
      image: g.out("ImageFromBatch", { image: [g.add("GetVideoComponents", { video: g.out("LoadVideo", { file }) }), 0], batch_index: 0, length: at.frames }),
      upscale_method: "lanczos", width: at.width, height: at.height, crop: "disabled",
    });
    const model = samModel(g, sam);
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
    g.phase(was);
    return { part, masks };
  };
  return {
    extra: {
      latent: (g, at) => {
        const { part, masks } = prepare(g, at);
        const sampling = g.at;
        g.phase("processing");
        const video = g.out("SetLatentNoiseMask", { samples: g.out("VAEEncode", { pixels: part, vae: at.vae }), mask: [masks, 0] });
        const joined = g.out("LTXVConcatAVLatent", { video_latent: video, audio_latent: [g.add("LTXVSeparateAVLatent", { av_latent: at.latent }), 1] });
        g.phase(sampling);
        return joined;
      },
      // a Finish › Face refine samples nothing: the part and its masks are made for the paste-back alone, so that the take's
      // faces are redrawn over the frames it showed (the source's pixels outside the person), not its unpasted latent
      frames: (g, images, at) => {
        if (!part || !masks) prepare(g, at);
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
        if (m.paste === "Difference" && has("AfflatusSwapPaste")) {
          return g.out("AfflatusSwapPaste", { render: matched, source: part, noise_mask: [masks, 0], paste_mask: [masks, 1], threshold: m.pasteThreshold, grow: 8, blur: m.pasteBlur, reach: 1, ...(m.pasteSpread !== 40 ? { spread: m.pasteSpread } : {}) });
        }
        return g.out("ImageCompositeMasked", { destination: part, source: matched, x: 0, y: 0, resize_source: false, mask: [masks, 1] });
      },
    },
    node: () => masks,
    preview: () => shown,
  };
}

/** The swap as its nodes and needs read it before it is built: the LoRA and the reference model, whatever their files. */
const asRead = (input: H3Swap) => asClip(input, "swap.safetensors", SWAP_FRAMES, 0, "minimax_h3_ref2va.safetensors");

export const h3Swap = h3Form<H3Swap>({
  id: "h3.swap",
  version: 1,
  title: "Swap character",
  summary: "A person in a video replaced by someone of the cast; the scene, the motion and the sound kept.",
  // a video of its own, made from another: on a timeline's source lane, a window of a long source carrying on from the window
  // before (its last 5 frames pinned at the start), otherwise no join with the clips around it
  // the prompt as sent written from the parts while it is left empty (card #34)
  partsInto: "who",
  partsStartOn: SWAP_STARTED_ON,
  promptFromParts: (input) => swapFromParts(input, Math.max(1, input.references?.length ?? 0)),
  traits: {
    // every window a swap, those that carry on too (the owner, 2026-10-30: Motion transfer after a swap was Swap motion's
    // leftover); a window is given Motion transfer by hand where the swap drifts (card #42)
    windows: { most: SWAP_FRAMES, least: SWAP_LEAST, carried: SWAP_CARRIED, runUp: SWAP_RUN_UP, own: SWAP_OWN, sourceDefault: true },
  },
  inputs: { drop: SWAP_DROP, lay: swapInputs },
  guide: SWAP_GUIDE,
  // a character swap's form: the model, its takes, who is replaced and how, then the rest as any form (the owner, 2026-10-18)
  first: ["model", "takes"],
  // who is replaced and how, apart from the source (the owner, 2026-10-18): the click and Show the mask are the screen's, the
  // rest the nodes' own inputs
  // (under the Inputs tab, with Sound: every H3 form keeps the same six tabs, card #170)
  chapters: [{ id: "mask", label: "Mask", under: "inputs", help: "SAM 3 tracks the person clicked on the stage; the Swap Mask grows the zone H3 redraws and the paste-back band. Experimental: the edge can waver. Show the mask draws them first." }],
  presets: SWAP_PRESETS,
  starts: SWAP_STARTS,
  needs: ["swapLora", "swapUnet"],
  // Show the mask and a take's Face refine alone sample nothing: neither the LoRA nor the model is loaded (card #226: Show
  // the mask waited for some 20 GB on a pod, its RIFE too)
  unneeded: (input) => (input.maskPreview || refinesOnly(input) ? ["swapLora", "swapUnet"] : []),
  // Show the mask's video is a look at the masks, kept out of the library (a working file, gone after a day)
  scratch: (input) => input.maskPreview === true,
  asClip: asRead,
  // as every other file and node: SAM 3 with the Mask on (off, nothing tracks the person), Veda's predictor when it is on, and a turbo LoRA when Turbo is on a model that is not
  // distilled (the reference one asked for, either taken). Show the mask runs SAM 3 and the masks alone
  needsInstead: (input) => (input.maskPreview ? ["swapSam"] : null),
  needParts: {
    // the swap's model is MiniMax's reference model, or a model made from it, whatever its file (modelOf on the swap's own
    // model): it takes MiniMax's reference turbo LoRA, else the usual one, and none when the model is distilled
    turbo: ({ input, slots }) => (input.fast && !modelOf({ ...input, model: input.swapModel ?? slots.swapUnet, turboIn: input.turboIn || "From the name" }, slots).turbo && !slots.refTurbo && !slots.turbo ? ["refTurbo"] : []),
    // the reference model is the swap's own (needs: swapUnet), never the refUnet slot's
    reference: () => [],
    // Veda's predictor for the reference model (vedaFor), whatever the swap's file
    veda: ({ input }) => (input.veda ? ["veda"] : []),
    // Face refine's files with it on: a pod was never sent them, and a Finish › Face refine there decoded the take as it was
    // (the swap's model, the clip's own Face refine runs on, is a need of every swap)
    faceRefine: ({ input }) => faceRefineNeeds(input, { clip: { follows: true } }),
  },
  // (H3's latent upscaler for a finish that enlarges with it is H3's: the swap is built as a clip, buildH3, and a pod finishing
  // Timeline 19's swaps without it fell back to a plain resize, blurred, 2026-10-18)
  moreNeeds: ({ input }) => (input.maskOn || input.maskPreview ? ["swapSam"] : []),
  // Show the mask runs the tracking and the masks alone (MASK_NODES, the preview node and the video out are optional)
  nodesInstead: (input) => (input.maskPreview ? ["LoadVideo", "GetVideoComponents"] : null),
  moreNodes: (input) => [...(refinesOnly(input) ? [] : ["LoraLoaderModelOnly"]), ...sourceSoundNodes(input)],
  // the mask's nodes are not asked of a machine: one without them (an older node pack) swaps unmasked, and the job says so
  // Veda's node only serves its toggle, and without its pack the swap runs the full attention and says so on the job: an
  // optional node, so that it never stops a render and Settings › Models offers its pack among the optional ones
  moreOptional: [...MASK_NODES, "AfflatusSwapMaskPreview", "AfflatusSwapPaste"],

  built(input, ctx) {
    if (!input.source || !ctx.uploads.source) throw new Error("A swap needs its source video.");
    // a take's Face refine alone samples nothing: neither the LoRA nor the reference model is loaded, and a pod is not sent
    // them (model.ts), so their lack there is no reason to fail it (a pod's Face refine of a swap, 2026-10-23)
    const only = refinesOnly(input);
    const swapLora = input.swapLora ?? ctx.slots.swapLora ?? null;
    // nor for Show the mask, whose graph keeps the tracking and the masks alone (unneeded: a pod is not sent them either)
    const sampleless = only || input.maskPreview;
    if (!swapLora && !sampleless) throw new Error("The swap needs the Character-Swap LoRA: h3_character_swap_v1.5.safetensors in ComfyUI's models/loras folder (Settings › Models has it).");
    const unet = input.swapModel ?? ctx.slots.swapUnet;
    if (!unet && !sampleless) throw new Error("The swap needs MiniMax H3's reference model, the one its LoRA was trained on: minimax_h3_ref2va_*.safetensors in ComfyUI's models/diffusion_models folder (Settings › Models has it).");
    // the prompt written for the file that renders: the fused turbo's own sentences went with the form's Model only, and
    // were left out when the model was the slot's
    const asSent = { ...input, swapModel: unet };
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
    const mask = input.maskOn && sam && MASK_NODES.every((n) => ctx.has(n)) ? masked(ctx.uploads.source, sam, input, ctx.has, carried && ctx.uploads.previous ? { file: ctx.uploads.previous, frames: carried } : undefined, input.source.pick, preview) : null;
    return {
      clip: asClip(input, swapLora, frames, carried, unet, size),
      ctx: asRef,
      extra: {
        prompt: (pictures) => swapPrompt(swapSent(asSent, pictures), pictures),
        // the file's sound: the source's own over the window; and, asked for, the same sound anchored from the window's first
        // frame, as Lip sync anchors its recording
        ...sourceSound(ctx, keep, input.soundGuide),
        ...(mask?.extra ?? {}),
        // how the one who goes in looks, for Face refine's prompt
        faceLook: input.look,
        vedaFor: "reference",
        ...(input.denoise < 1 ? { denoise: input.denoise } : {}),
        // the reference model's own turbo LoRA, else the usual one (a distilled model takes neither)
        ...(ctx.slots.refTurbo ?? ctx.slots.turbo ? { turbo: ctx.slots.refTurbo ?? ctx.slots.turbo } : {}),
      },
      after: (built) => {
        // a prompt that names neither the source nor the cast's picture still runs: H3 may then leave them out, and the job says so
        const lacks = swapPromptLacks(swapSent(asSent, Math.max(1, input.references.length)), input.references.length).map((tag) => `The prompt has no ${tag}: H3 may not use ${tag === "<Video 1>" ? "the source video" : "the cast's picture"}.`);
        // Difference asked for and the pack not yet loaded: pasted by the mask, and said
        const pasted = input.maskOn && input.paste === "Difference" && !ctx.has("AfflatusSwapPaste") ? ["Paste by Difference needs the Afflatus node pack 0.29.0 (restart ComfyUI to load it): pasted by the mask."] : [];
        const notes = [...lacks, ...pasted];
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
        // the Mask turned off: the whole frame redrawn, as asked. Its nodes and SAM there but no mask made: a finish by the latent
        // re-sample, which redraws every pixel and pastes nothing back (finish.ts), not a pack without the Swap Mask
        if (!input.maskOn || mask) return warned;
        const why = sam ? "this ComfyUI's Afflatus node pack has no Swap Mask yet (0.22.0 on; ComfyUI loads a newer pack when it restarts)" : "SAM 3.1 is not on this ComfyUI (Settings › Models has it)";
        return { ...warned, warnings: [...(warned.warnings ?? []), `Swapped without a mask, the whole frame redrawn: ${why}.`] };
      },
    };
  },

  variants: ((): Variant<H3Swap>[] => {
    const all = {
      unet: "minimax_h3_fl2va.safetensors", clip: "qwen3vl_minimax_h3.safetensors", videoVae: "minimax_h3_video_vae.safetensors", audioVae: "minimax_h3_audio_vae.safetensors",
      turbo: "minimax_h3_turbo.safetensors", rife: "rife49.pth", refUnet: "minimax_h3_ref2va.safetensors", refTurbo: "minimax_h3_ref2v_turbo.safetensors",
      swapLora: "h3_character_swap_pro4500_1000.safetensors", swapUnet: "minimax_h3_ref2va_pruned.safetensors", swapSam: SAM_FILE,
    };
    const part = { width: 864, height: 480, frames: 141, fps: H3_FPS, hasSound: true };
    return [
      {
        name: "a person of the cast swapped in, the whole frame redrawn (the Mask off, as the form starts), the source's sound kept",
        input: { who: "the man in the grey t-shirt", source: { asset: "v1" }, references: [{ asset: "r1", role: "person" }], fast: false },
        slots: all, uploads: { source: "v.mp4", "references.0": "r1.png" }, media: { source: part },
      },
      {
        name: "Face refine of the person swapped in (a Finish of it loads its own latent)",
        input: { who: "the man in the grey t-shirt", source: { asset: "v1" }, references: [{ asset: "r1", role: "person" }], faceRefine: true },
        slots: { ...all, ...FACE_REFINE_SLOTS }, uploads: { source: "v.mp4", "references.0": "r1.png", "self.latent": "own.safetensors" }, media: { source: part },
      },
      {
        // as the form starts (card #159): the face pass on the swap's own model, one loader
        name: "Face refine on the swap's own model",
        input: { who: "the man in the grey t-shirt", source: { asset: "v1" }, references: [{ asset: "r1", role: "person" }], faceRefine: true, faceRefineModel: OWN_MODEL },
        slots: { ...all, ...FACE_REFINE_SLOTS }, uploads: { source: "v.mp4", "references.0": "r1.png" }, media: { source: part },
      },
      {
        name: "a window of a long source, masked, carrying on from the window before",
        input: { who: "the man", source: { asset: "v1", at: 5 }, previous: { asset: "w1" }, references: [{ asset: "r1", role: "person" }], fast: false, maskOn: true },
        slots: all, uploads: { source: "v.mp4", previous: "w.mp4", "references.0": "r1.png" }, media: { source: { ...part, frames: 124 }, previous: { width: 864, height: 480, frames: 5, fps: H3_FPS, hasSound: true } },
      },
      {
        // added over the source's own sound, which plays on under it
        name: "a sound cue over the source's sound kept",
        input: { who: "the man", source: { asset: "v1" }, references: [{ asset: "r1", role: "person" }], cues: [{ asset: "s1", start: 0, seconds: 0.6, at: 2.4 }] },
        slots: all, uploads: { source: "v.mp4", "references.0": "r1.png", "cues.0": "door.wav" }, media: { source: part, "cues.0": { width: 0, height: 0, seconds: 0.6 } },
      },
      {
        // (a cue there laid into H3's sound, or H3's own kept at it: In the take decides)
        name: "a short part, Turbo, the sound H3 makes, a sound cue in it",
        input: { who: "the woman on the left.", source: { asset: "v1" }, references: [{ asset: "r1", role: "person" }], keepSound: false, fast: true, cues: [{ asset: "s1", start: 0, seconds: 0.6, at: 1.5 }] },
        slots: all, uploads: { source: "v.mp4", "references.0": "r1.png", "cues.0": "door.wav" }, media: { source: { ...part, frames: 90, hasSound: false }, "cues.0": { width: 0, height: 0, seconds: 0.6 } },
      },
      {
        name: "the lips drawn to the source's own sound, anchored from the first frame",
        input: { who: "the man", source: { asset: "v1" }, references: [{ asset: "r1", role: "person" }], fast: false, soundGuide: true },
        slots: all, uploads: { source: "v.mp4", "references.0": "r1.png" }, media: { source: part },
      },
      {
        name: "the person to replace clicked on the source's first frame",
        input: { who: "the man", source: { asset: "v1", pick: { x: 0.38, y: 0.46 } }, references: [{ asset: "r1", role: "person" }], fast: false, maskOn: true },
        slots: all, uploads: { source: "v.mp4", "references.0": "r1.png" }, media: { source: part },
      },
      {
        name: "Veda's sparse attention on the model, its predictor in models/veda",
        input: { who: "", inSource: "the man", source: { asset: "v1" }, references: [{ asset: "r1", role: "person" }], fast: false, veda: true, shot: "Medium" },
        slots: { ...all, veda: "minimax_h3_r2va_veda_preview_fp8.safetensors" }, uploads: { source: "v.mp4", "references.0": "r1.png" }, media: { source: part },
      },
      {
        name: "pasted back by difference: the wall H3 only redrew is the source's again",
        input: { who: "the man", source: { asset: "v1" }, references: [{ asset: "r1", role: "person" }], fast: false, maskOn: true, paste: "Difference" },
        slots: all, uploads: { source: "v.mp4", "references.0": "r1.png" }, media: { source: part },
      },
      {
        name: "Show the mask: the window's tracking and masks drawn over its frames, H3 not run",
        input: { who: "the man", source: { asset: "v1", pick: { x: 0.4, y: 0.5 } }, references: [{ asset: "r1", role: "person" }], fast: false, maskOn: true, maskPreview: true },
        slots: all, uploads: { source: "v.mp4", "references.0": "r1.png" }, media: { source: part },
      },
      {
        name: "an older node pack, with no Swap Mask: swapped unmasked",
        input: { who: "the man", source: { asset: "v1" }, references: [{ asset: "r1", role: "person" }], fast: false, maskOn: true },
        slots: all, uploads: { source: "v.mp4", "references.0": "r1.png" }, media: { source: part }, has: (cls) => cls !== "AfflatusSwapMask",
      },
    ];
  })(),
});
