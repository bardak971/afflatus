import { defineRecipe, gridAtOrBefore, type BuildContext, type BuiltGraph, type ClipValue, type GraphBuilder, type InputSpec, type Ref, type Variant } from "@afflatus/core";
import { H3_MOTION_GUIDE } from "./guide";
import { H3_FPS, H3_GRID } from "./family";
import { H3_NO_TAGS, H3_SOUND_CHAPTER, h3Inputs, SOURCE_SOUND_INPUTS, SOURCE_START, type H3Video } from "./inputs";
import { MOTION_STARTS, MOTION_TURBO_ROW, withTurboRow } from "./turboRow";
import { buildH3, h3Video, SHOT_WORDS } from "./video";
import { H3_CONTINUATION_NODES, H3_SEAM, H3_TRIM } from "./join";
import { modelOf, referenceNeeds, turboNeeds, vedaNeeds } from "./model";
import { latentUpscaleNeeds } from "./latent-upscale";
import { upscaleNeeds } from "../video/upscale";
import { rifeNeeds } from "../shared/finish";
import { partBounds } from "../motion/driving";
import { asClip as swapClip, h3Swap, SWAP_FRAMES, SWAP_RUN_UP, type H3Swap } from "./swap";
import { controlled, frameBefore, MOTION_CHAPTER, motionControlInputs, motionNeeds, motionNodes, poseVideo, POSE_SDPOSE, type H3Motion } from "./motion";
import { clipModelOf, FACE_REFINE_SLOTS, faceRefineNeeds } from "./faceRefine";
import { cueMixNodes } from "./cue";

/**
 * MiniMax H3 · Motion transfer (the owner's, 2026-10-18; built 2026-10-20): a picture made to move like a driving video,
 * as SCAIL-2 · Motion transfer, by H3 held to the video's pose (the Fun ControlNet, motion.ts). The picture opens the
 * clip as its first frame (given, or made with Make the picture from the source's frame); on a timeline's source lane each
 * window after the first carries on from the one before, every one moved by its own part's pose. The cast's pictures can
 * be added as references (H3's reference model, or a hybrid), the face then held to them along the windows.
 *
 * A window with no Picture of its own that carries on from the one before is the motion after a swap (card #42: H3 · Swap
 * motion retired, each window of a source its own form): it runs as Swap motion's windows did, on the swap's model, with
 * the cast's picture and the clip before's last frame as references. The person replaced is never in its input, so they
 * cannot come back: a swap continued deep into a source kept her long hair on his head (Timeline 19, clip 3), where a pose
 * carries her arms and head, not her hair.
 */
export interface H3MotionTransfer extends H3Video, H3Motion {
  /** The prompt's parts (card #34): how the person of the picture looks, what happens in this part. */
  look: string;
  happens: string;
  picture?: string;
  /** The video it moves like (the swap's ids, card #42: a source's windows of either form read their part alike). */
  source?: ClipValue;
  sourceStart: number;
  sourceSeconds: number;
  keepSound: boolean;
  soundGuide: boolean;
  /** The model a window after a swap runs on (the swap's own input, shared by a source's windows): else the swapUnet slot. */
  swapModel?: string;
  /** Carries on from a swap (afterSwap): set where it was given this form from one. */
  afterSwap: boolean;
}

/** The sampling a window after a swap keeps of the swap's form (windowFrom): the model's own shifts. */
const SAMPLING = new Set(["shiftVideo", "shiftAudio"]);

/**
 * A window that carries on from a swap (card #42): set so where it was given this form from a swap (windowFrom), and
 * carrying on from the window before. It has no Picture of its own and runs on the swap's model.
 */
export const afterSwap = (input: Pick<H3MotionTransfer, "previous" | "afterSwap">) => Boolean(input.afterSwap) && Boolean(input.previous);

/** H3's own Model shows on a Motion transfer of its own; a window after a swap shows the swap's (SWAP_MODEL) in its place. */
const OWN_MODEL = { input: "afterSwap", in: [false, undefined] };
const SWAP_MODEL = {
  // the swap's own input (its id shared): a source's swaps and the windows after them run on the one model
  ...h3Swap.inputs.find((i) => i.id === "swapModel")!,
  showWhen: "afterSwap",
  note: "the swap's model: this window carries on from a swap and runs on the model it was made with, so that the join stays one model's",
} as InputSpec;

/** The prompt a window after a swap starts on when its parts say nothing: the person and the room as they are, in positive words only. */
// Nothing of the room: H3 follows every word, and "Keep the room and the light…" drew a lamp into it (the owner, 2026-10-20).
// H3's layout already says the setting comes from the frames carried in
export const CARRY_ON_PROMPT = "The person carries on moving as in the clip before, with the same face, hair and clothes.";

/**
 * A window after a swap, written from the parts (card #34): the person by how they look, carrying on as in the clip
 * before, then what happens in this window. Nothing of the room or the light: H3 draws what is named.
 */
export function motionFromParts(input: Pick<H3MotionTransfer, "look" | "happens" | "shot">): string {
  const look = (input.look ?? "").trim().replace(/\s+/g, " ").replace(/[.!\s]+$/, "");
  const happens = (input.happens ?? "").trim().replace(/\s+/g, " ");
  const first = `The person${look ? `, ${look},` : ""} carries on moving as in the clip before.`;
  const said = happens ? `${first} ${happens.charAt(0).toUpperCase()}${happens.slice(1)}${/[.!?]$/.test(happens) ? "" : "."}` : look ? first : CARRY_ON_PROMPT;
  // the shot's words first (card #27), as the render had them and the prompt as sent did not
  return [SHOT_WORDS[input.shot ?? ""] ?? "", said].filter(Boolean).join(" ");
}

/** The reference tags a prompt names, with the word before them ("in <Picture 1>"): H3's layout says which picture is whom. */
const TAGS = /\s*\b(?:in|from|of)?\s*<(?:Picture|Video) \d+>/gi;

/** A window of H3: the swap's, 90 to 141 frames (5.9 s at 24). */
const MOTION_LEAST = 90;
/** Frames of the window before a window carries on from, unless the form says otherwise (H3's own 22). */
const MOTION_CARRIED = 22;
const MOTION_PART = partBounds({ fps: H3_FPS, most: SWAP_FRAMES, least: MOTION_LEAST });

/**
 * H3's inputs this form does not take: the picture is its first frame, the driving video its length and shape, its sound the
 * video's; how the person looks is the form's own `look` (H3's `subject` was a second "How they look", landing elsewhere).
 */
const NOT_TAKEN = new Set([
  "description", "start", "end", "mid", "midAt", "handover", "next", "landing",
  "voice", "voiceStart", "voiceSeconds", "voiceEven", "subject", "seconds", "shape",
]);

/**
 * H3's inputs as this form shows them, every H3 form alike (card #170): Sound effects and Music only while the take makes its
 * own sound (Keep the source's sound off), the reference videos on a Motion transfer of its own (a window after a swap is the
 * swap's references).
 */
const MOTION_SHOWS: Record<string, InputSpec["showWhen"]> = {
  soundscape: { input: "keepSound", in: [false] },
  music: { input: "keepSound", in: [false] },
  refVideos: OWN_MODEL,
};

/** H3's two sound texts, drawn with this form's prompt rather than where H3's inputs come. */
const SOUND_TEXTS = new Set(["soundscape", "music"]);

const inputs: InputSpec[] = [
  {
    id: "source", type: "clip", role: "source", label: "Source video", frames: [SWAP_FRAMES], fps: H3_FPS, whole: true,
    window: { start: "sourceStart", seconds: "sourceSeconds", fits: { frames: SWAP_FRAMES, fps: H3_FPS, pad: 0, min: MOTION_LEAST / H3_FPS, grid: H3_GRID } },
    note: "how it moves: the body, the hands, the face, drawn as skeletons. One job takes 5.9 s of it; a longer video goes on a timeline's source lane, window by window",
  },
  SOURCE_START,
  { id: "sourceSeconds", type: "number", label: "Source: length", min: MOTION_PART.least, max: MOTION_PART.most, step: 0.01, default: 5.175, unit: " s", showWhen: "source" },
  {
    // not for a window that carries on from a swap, which has none (afterSwap): any other one needs it (build)
    id: "picture", type: "image", role: "source", label: "Picture", opensOnly: true, showWhen: OWN_MODEL,
    note: "what moves, its first frame: its room, its light and its people are kept, only the motion comes from the video. In the source video's shape: the video is cut to the picture's from the centre. A window after a swap needs none: it carries on from it",
  },
  // Sound effects and Music, H3's prompt text: in the Prompt card first under What happens, as on every H3 form (card #210)
  ...h3Inputs.filter((spec) => SOUND_TEXTS.has(spec.id)).map((spec) => ({ ...spec, showWhen: MOTION_SHOWS[spec.id] }) as InputSpec),
  // the prompt's parts (card #34): the prompt as sent written from them while it is left empty (motionFromParts)
  { id: "look", type: "prompt", weights: false, label: "How they look", style: "sentences", line: true, optional: true, noCast: true, designed: true, holds: "subject", placeholder: "short brown hair, a white shirt and jeans", note: `the person of the picture, in a few words: what H3 keeps of them. Shared by a source's windows. ${H3_NO_TAGS}` },
  { id: "happens", type: "prompt", weights: false, label: "What happens", style: "sentences", optional: true, noCast: true, designed: true, main: true, placeholder: "He dances in the living room, turning on the spot and raising his arms.", note: `in this part, in the present tense. Each window of a source keeps its own. ${H3_NO_TAGS}` },
  {
    // each window keeps its own (traits.windows.own): clip 6 of a source can show something else than clip 2
    id: "description", type: "prompt", weights: false, label: "Prompt as sent", style: "sentences", optional: true, designed: true, noCast: true,
    placeholder: "The man with short brown hair, in a white shirt and jeans, dances in the living room, turning on the spot and raising his arms.",
    note: `who is in the picture and what they do in this part, in the present tense: optional, it helps H3 keep what is there. Left empty, it is written from the parts above; typed, it is sent as it is and the parts wait. Each clip of a source keeps its own. ${H3_NO_TAGS} After a swap, tags typed are taken out`,
  },
  // the Sound card's rows
  ...SOURCE_SOUND_INPUTS,
  // H3's colour match pulls towards the first frame: here the picture
  // H3's Model is this form's own: a window after a swap shows the swap's in its place (the one it runs on)
  // (Turbo's row in the LoRA list on whichever model the window runs on, card #160)
  ...withTurboRow(h3Inputs, MOTION_TURBO_ROW).filter((spec) => !NOT_TAKEN.has(spec.id) && !SOUND_TEXTS.has(spec.id)).flatMap((spec): InputSpec[] => (spec.showWhen === "start" ? [{ ...spec, showWhen: "picture" }] : spec.id === "model" ? [{ ...spec, showWhen: OWN_MODEL }, SWAP_MODEL] : MOTION_SHOWS[spec.id] ? [{ ...spec, showWhen: MOTION_SHOWS[spec.id] } as InputSpec] : [spec])),
  ...motionControlInputs,
  {
    // set where a source's window comes from a swap (windowFrom, the migration of Swap motion): not a choice made up front
    id: "afterSwap", type: "toggle", label: "Carries on from a swap", default: false, advanced: true, section: "rare",
    note: "this window carries on from a swap, on the swap's model and with no Picture of its own; off, it is a Motion transfer of its own and needs its Picture",
  },
];

/** The frames of the window: the part handed over (or asked for), floored to H3's 17k + 5, 90 to 141 (the carried frames among them). */
function framesOf(input: H3MotionTransfer, ctx: Pick<BuildContext, "media">): number {
  const have = ctx.media.source?.frames ?? Math.round(input.sourceSeconds * H3_FPS);
  return Math.max(MOTION_LEAST, gridAtOrBefore(Math.min(SWAP_FRAMES, have), H3_GRID));
}

/**
 * The window as an H3 clip: opening on the picture (none once it carries on from the window before, whose last frames
 * start it), its own part the window less the frames carried, the cast's pictures as references.
 */
/**
 * Motion transfer's prompt written from its parts (card #34): the shot's words (card #27), how the person looks, then what
 * happens. Empty when all are: the prompt is optional, H3 then follows the picture alone.
 */
export function motionTransferFromParts(input: Pick<H3MotionTransfer, "look" | "happens" | "shot">): string {
  const look = (input.look ?? "").trim().replace(/\s+/g, " ").replace(/[.!\s]+$/, "");
  const happens = (input.happens ?? "").trim().replace(/\s+/g, " ");
  const said = [SHOT_WORDS[input.shot ?? ""] ?? "", look ? `The person: ${look}.` : "", happens ? `${happens.charAt(0).toUpperCase()}${happens.slice(1)}${/[.!?]$/.test(happens) ? "" : "."}` : ""];
  return said.filter(Boolean).join(" ");
}

function asClip(input: H3MotionTransfer, frames: number, carried: number): H3Video {
  return {
    ...input,
    // typed, the prompt is the user's, sent as it is; else written from the parts, the shot's words among them (shot "Any":
    // buildH3 adds none of its own)
    description: input.description.trim() || motionTransferFromParts(input), shot: "Any",
    start: input.previous ? undefined : input.picture,
    end: undefined, mid: undefined, next: undefined, voice: undefined, midAt: 0,
    // its sound effects and music only while the take makes its own sound; its reference videos as H3's clip takes them
    soundscape: input.keepSound ? "" : input.soundscape ?? "", music: input.keepSound ? "" : input.music ?? "", refVideos: input.refVideos ?? [], handover: false, landing: "22",
    context: input.context || String(MOTION_CARRIED), joinFrom: input.joinFrom || "Latent",
    seconds: (frames - carried) / H3_FPS,
    shape: { width: 576, height: 1024 },
  };
}

/**
 * The window as its nodes and files are read before it is built: carrying on, the clip before's last frame is one more
 * picture of who moves (the reference route, as the build takes it where it can).
 */
const asWindow = (input: H3MotionTransfer): H3Video =>
  ({ ...asClip(input, SWAP_FRAMES, input.previous ? MOTION_CARRIED : 0), ...(input.previous ? { references: [...input.references, { asset: "frame", role: "person" as const }] } : {}) });

/**
 * A window after a swap (afterSwap), moved by its pose: the swap's model and form, without its LoRA and its source video
 * (no <Video 1>); the cast's picture and the clip before's last frame its references; its prompt H3's own layout around the
 * window's words (which picture is whom said by Afflatus, any tag typed taken out); the source's sound kept as the swap
 * keeps it. Built as H3 · Swap motion built its windows that carried on, so that its sources migrated render alike.
 */
function windowAfterSwap(input: H3MotionTransfer, ctx: BuildContext): BuiltGraph {
  const unet = input.swapModel ?? ctx.slots.swapUnet;
  if (!unet) throw new Error("A window carrying on from a swap runs on the swap's model: MiniMax H3's reference model, minimax_h3_ref2va_*.safetensors in ComfyUI's models/diffusion_models folder (Settings › Models has it).");
  const frames = framesOf(input, ctx);
  const carried = ctx.media.previous?.frames ?? MOTION_CARRIED;
  const driving = ctx.media.source;
  const keep = input.keepSound && Boolean(driving?.hasSound);
  const size = driving?.width && driving.height ? { width: driving.width, height: driving.height } : undefined;
  // as the swap runs: without H3's fp16 accumulation patch
  const asRef = { ...ctx, has: (cls: string) => cls !== "ModelPatchTorchSettings" && ctx.has(cls) };
  // typed, the prompt is the user's; else written from the parts (card #34), else the plain carrying on
  const written = input.description.trim() || motionFromParts(input);
  const said = written.replace(TAGS, "").replace(/\s+([.,])/g, "$1").trim();
  let heard: Ref | null = null;
  const drivingSound = (g: GraphBuilder, n: number) =>
    (heard ??= g.out("TrimAudioDuration", { audio: [g.add("GetVideoComponents", { video: g.out("LoadVideo", { file: ctx.uploads.source }) }), 1], start_index: 0, duration: n / H3_FPS }));
  // (the shot's words are the parts' own: a prompt typed is sent as it is)
  const clip = { ...swapClip(asSwap(input), null, frames, carried, unet, size), description: said, shot: "Any" };
  const built = buildH3(clip, asRef, {
    pictures: (g) => frameBefore(g, ctx),
    ...(keep ? { sound: (g, _decoded, at) => drivingSound(g, at.frames) } : {}),
    ...(keep && input.soundGuide ? {
      guide: (g, at) => g.out("MiniMaxH3AddGuide", { positive: at.positive, latent: at.latent, vae: at.vae, audio_vae: at.audioVae, audio: drivingSound(g, at.frames), frame_idx: 0 }),
    } : {}),
    model: (g, model, at) => {
      const pose = poseVideo(g, ctx, input, ctx.uploads.source!, at);
      const made = controlled(g, ctx, input, model, at.vae, pose);
      const sd = input.poseFrom === POSE_SDPOSE ? [`checkpoints/${ctx.slots.sdpose}`, `diffusion_models/${ctx.slots.rtdetr}`] : [];
      return { model: made.model, loads: [`model_patches/${made.file}`, ...sd] };
    },
    vedaFor: "reference",
    faceLook: input.look,
    ...(ctx.slots.refTurbo ?? ctx.slots.turbo ? { turbo: ctx.slots.refTurbo ?? ctx.slots.turbo } : {}),
  });
  // said on the job, the window rendered all the same
  const notes = [
    ...(/<Video \d+>|^\s*(?:replace|swap)\b/i.test(written) ? ["This window carries on from the one before, moved by its pose: its prompt is still a swap's. Write its own: who is in it, as they look in the clip before, and what they do."] : []),
    ...(input.references.length === 0 ? ["No picture of who goes in: the window carries on from the clip before's frames alone, and the face may drift."] : []),
  ];
  return notes.length ? { ...built, warnings: [...(built.warnings ?? []), ...notes] } : built;
}

/** The window as the swap's helpers read it, rendered at the swap's own default size. */
const asSwap = (input: H3MotionTransfer) => ({ ...input, swapSize: "576p" }) as unknown as H3Swap;

/**
 * Core's ImageFromBatch: the clip before's last frame, taken as a picture where the reference route runs (known by the
 * slots). Core's LoRA loader: a window after a swap takes it only for a turbo LoRA (a model that is not distilled, known by
 * the file the slot gives, which nodes() does not see) or the user's LoRAs.
 */
const MOTION_OPTIONAL = [...(h3Video.optionalNodes ?? []), "ImageFromBatch", "LoraLoaderModelOnly"];

/** The nodes of a window after a swap: H3's with no swap LoRA, the clip before's last frame a reference, the sound's, the pose's. */
function nodesAfterSwap(input: H3MotionTransfer): string[] {
  const optional = new Set(MOTION_OPTIONAL);
  return [...new Set([
    ...h3Video.nodes({ ...swapClip(asSwap(input), null, SWAP_FRAMES, MOTION_CARRIED), description: "a", references: [...input.references, { asset: "frame", role: "person" }] }),
    ...(input.keepSound ? ["TrimAudioDuration", ...cueMixNodes(input)] : []), ...(input.keepSound && input.soundGuide ? ["MiniMaxH3AddGuide"] : []),
    ...motionNodes(input),
  // (with no cast photo, the frame is the only picture: nothing loaded from a file)
  ])].filter((n) => !optional.has(n) && !(n === "LoadImage" && input.references.length === 0));
}

export const h3MotionTransfer = defineRecipe<H3MotionTransfer>({
  id: "h3.motion",
  // the prompt as sent written from the parts while it is left empty (card #34)
  partsInto: "description",
  // (the form's placeholder is read without the clip before: a window after a swap carries on by what it is)
  promptFromParts: (input) => (input.afterSwap ? motionFromParts(input) : motionTransferFromParts(input)),
  // a window given this form alone, from Swap character, carries on from a swap, on its model: the sampling it has not set
  // stays the swap's own (its shifts, 12 / 3). Every window given it (the source's form changed): each a Motion transfer of
  // its own
  windowFrom: (from, inputs, alone) => {
    if (!alone) return { ...inputs, afterSwap: false };
    if (from.id !== "h3.swap") return inputs;
    const theirs = Object.fromEntries(from.inputs.filter((i) => SAMPLING.has(i.id) && "default" in i && !(i.id in inputs)).map((i) => [i.id, (i as { default: unknown }).default]));
    return { ...theirs, ...inputs, afterSwap: true };
  },
  family: "h3",
  version: 1,
  title: "Motion transfer",
  // its boxes walked in its own guide over H3's shot guide (card #129): the video gives the motion and the camera
  guide: H3_MOTION_GUIDE,
  summary: "A picture moved like a source video, H3 held to its pose: the picture's room, light and people kept, the motion the video's. Audio included.",
  output: "video",
  // made from a picture and another video; on a timeline, a window of a long source carrying on from the window before (its
  // last frames, in its latent), each window with its own prompt
  traits: {
    startFrame: false, endFrame: false, midFrames: false, continues: "clip", endAnchor: false, sound: true, fps: H3_FPS, frameGrid: H3_GRID,
    latentTrim: H3_TRIM, latentNodes: [...H3_CONTINUATION_NODES, H3_SEAM], faceRefine: "faceRefine",
    windows: { most: SWAP_FRAMES, least: MOTION_LEAST, carried: MOTION_CARRIED, runUp: SWAP_RUN_UP, own: ["description", "happens", "cues"] },
  },
  inputs,
  // under the Inputs tab, with Sound: every H3 form keeps the same six tabs (card #170)
  chapters: [{ ...MOTION_CHAPTER, under: "inputs" }, H3_SOUND_CHAPTER],
  starts: MOTION_STARTS,
  presets: h3Video.presets,
  // a window after a swap needs what the swap's do (its model, unless picked), less its LoRA and SAM 3; any other is read
  // on the window as it is built (asWindow): a window carrying on asks for the reference model its frame before is given by
  // (a pod never had it, and rendered the window by the frames alone), and Veda's and Turbo's files for that model. On a
  // machine of the user's own without the reference model, a window with no cast picture is read as the build takes it
  // there, on the frames carried alone (canRefer), as before: it was held, waiting for a download of that model
  needsWith: (input, slots = {}, where = {}) => {
    if (afterSwap(input)) return [...(h3Swap.needsWith?.(asSwap(input), slots) ?? []).filter((n) => n !== "swapSam"), ...motionNeeds(input), ...(input.swapModel ? [] : ["swapUnet"])];
    const framesAlone = where.own && !slots.refUnet && !(input.references ?? []).length;
    const clip = framesAlone ? asClip(input, SWAP_FRAMES, input.previous ? MOTION_CARRIED : 0) : asWindow(input);
    return [...turboNeeds(clip, slots), ...referenceNeeds(clip, slots), ...vedaNeeds(clip, slots), ...latentUpscaleNeeds(input), ...upscaleNeeds(input), ...rifeNeeds(input.smooth), ...motionNeeds(input), ...faceRefineNeeds(input, { picture: Boolean(input.picture && !input.previous), clip: clipModelOf(clip, slots) })];
  },
  nodes: (input) => afterSwap(input) ? nodesAfterSwap(input) : [...new Set([
    // carrying on, the clip before's last frame is a picture of who moves: the reference route (with H3's reference model there)
    ...h3Video.nodes(asWindow(input)), ...motionNodes(input),
    ...(input.keepSound ? ["TrimAudioDuration", ...cueMixNodes(input)] : []), ...(input.keepSound && input.soundGuide ? ["MiniMaxH3AddGuide"] : []),
  // (carrying on with no cast photo, the frame is the only picture: nothing loaded from a file)
  ])].filter((n) => !(n === "LoadImage" && input.previous && input.references.length === 0)),
  optionalNodes: MOTION_OPTIONAL,
  finishing: (input) => h3Video.finishing!(asClip(input, SWAP_FRAMES, 0)),

  build(input, ctx) {
    if (!input.source || !ctx.uploads.source) throw new Error("Motion transfer needs a source video: how it moves.");
    if (afterSwap(input)) return windowAfterSwap(input, ctx);
    if (!input.picture || !ctx.uploads.picture) throw new Error("Motion transfer needs a picture: what moves.");
    const frames = framesOf(input, ctx);
    const carried = input.previous ? ctx.media.previous?.frames ?? MOTION_CARRIED : 0;
    const driving = ctx.media.source;
    const keep = input.keepSound && Boolean(driving?.hasSound);
    // the picture is H3's first frame: its upload and its size where H3 reads a start picture
    const asStart = {
      ...ctx,
      uploads: { ...ctx.uploads, ...(ctx.uploads.picture ? { start: ctx.uploads.picture } : {}) },
      media: { ...ctx.media, ...(ctx.media.picture ? { start: ctx.media.picture } : {}) },
    };
    let heard: Ref | null = null;
    const drivingSound = (g: GraphBuilder, n: number) =>
      (heard ??= g.out("TrimAudioDuration", { audio: [g.add("GetVideoComponents", { video: g.out("LoadVideo", { file: ctx.uploads.source }) }), 1], start_index: 0, duration: n / H3_FPS }));
    const clip = asClip(input, frames, carried);
    // a window carrying on is also given the clip before's last frame as a picture of who moves (how they look by now),
    // when H3's reference route can run here: a reference model there, or a hybrid picked (else the frames carried alone)
    const canRefer = input.references.length > 0 || Boolean(ctx.slots.refUnet) || modelOf(clip, ctx.slots).hybrid;
    const built = buildH3(clip, asStart, {
      // how the person looks, for Face refine's prompt (its one "How they look")
      faceLook: input.look,
      ...(input.previous && canRefer ? { pictures: (g: GraphBuilder) => frameBefore(g, ctx) } : {}),
      ...(keep ? { sound: (g, _decoded, at) => drivingSound(g, at.frames) } : {}),
      ...(keep && input.soundGuide ? {
        guide: (g, at) => g.out("MiniMaxH3AddGuide", { positive: at.positive, latent: at.latent, vae: at.vae, audio_vae: at.audioVae, audio: drivingSound(g, at.frames), frame_idx: 0 }),
      } : {}),
      model: (g, model, at) => {
        const pose = poseVideo(g, ctx, input, ctx.uploads.source!, at);
        const made = controlled(g, ctx, input, model, at.vae, pose);
        const sd = input.poseFrom === POSE_SDPOSE ? [`checkpoints/${ctx.slots.sdpose}`, `diffusion_models/${ctx.slots.rtdetr}`] : [];
        return { model: made.model, loads: [`model_patches/${made.file}`, ...sd] };
      },
    });
    return built;
  },

  variants: ((): Variant<H3MotionTransfer>[] => {
    const all = {
      unet: "minimax_h3_fl2va.safetensors", clip: "qwen3vl_minimax_h3.safetensors", videoVae: "minimax_h3_video_vae.safetensors", audioVae: "minimax_h3_audio_vae.safetensors",
      turbo: "minimax_h3_turbo.safetensors", refUnet: "minimax_h3_ref2va.safetensors", refTurbo: "minimax_h3_ref2v_turbo.safetensors",
      h3Control: "minimax_h3_fun_controlnet_union_2.0_pruned_int8_convrot.safetensors", sdpose: "sdpose_wholebody_fp16.safetensors", rtdetr: "rt_detr_v4-x-hgnet_fp16.safetensors", rife: "rife49.pth",
    };
    const part = { width: 720, height: 1280, frames: 141, fps: H3_FPS, hasSound: true };
    const picture = { width: 832, height: 1472 };
    const before = { width: 576, height: 1024, frames: 22, fps: H3_FPS, hasSound: true };
    return [
      {
        name: "a picture moved by the source video's pose (DWPose), its sound kept",
        input: { picture: "p1", source: { asset: "v1" }, description: "A man dances in a living room." },
        slots: all, uploads: { picture: "p.png", source: "v.mp4" }, media: { picture, source: part },
      },
      {
        name: "a picture moved by the source video, a sound cue over its sound",
        input: { picture: "p1", source: { asset: "v1" }, description: "A man dances in a living room and claps once.", cues: [{ asset: "s1", start: 0, seconds: 0.6, at: 2.4 }] },
        slots: all, uploads: { picture: "p.png", source: "v.mp4", "cues.0": "clap.wav" }, media: { picture, source: part, "cues.0": { width: 0, height: 0, seconds: 0.6 } },
      },
      {
        name: "Veda's sparse attention on a moved picture",
        input: { picture: "p1", source: { asset: "v1" }, description: "A man dances in a living room.", veda: true, vedaGenerated: 24, vedaReference: 40, shot: "Wide" },
        slots: { ...all, ...{ veda: "minimax_h3_r2va_veda_preview_fp8.safetensors", vedaT2va: "minimax_h3_t2va_veda_8nfe_600step_preview_fp8.safetensors" } }, uploads: { picture: "p.png", source: "v.mp4" }, media: { picture, source: part },
      },
      {
        name: "the cast's picture as a reference, the pose from SDPose, full steps",
        input: { picture: "p1", source: { asset: "v1" }, references: [{ asset: "r1", role: "person" }], poseFrom: POSE_SDPOSE, fast: false, poseHands: false },
        slots: all, uploads: { picture: "p.png", source: "v.mp4", "references.0": "r1.png" }, media: { picture, source: part },
      },
      {
        name: "Face refine of the cast person (a Finish of it loads its own latent)",
        input: { picture: "p1", source: { asset: "v1" }, references: [{ asset: "r1", role: "person" }], faceRefine: true },
        slots: { ...all, ...FACE_REFINE_SLOTS }, uploads: { picture: "p.png", source: "v.mp4", "references.0": "r1.png", "self.latent": "own.safetensors" }, media: { picture, source: part },
      },
      {
        // one file that is all three: no reference model, no turbo LoRA
        name: "a hybrid turbo fine-tune, the cast's picture as a reference, its colours matched to the picture, RIFE",
        input: { picture: "p1", source: { asset: "v1" }, model: "SomeoneH3_hybridTurboV3.safetensors", references: [{ asset: "r1", role: "person" }], colourMatch: true, smooth: true, fast: true },
        slots: all, uploads: { picture: "p.png", source: "v.mp4", "references.0": "r1.png" }, media: { picture, source: part },
      },
      {
        // (a cue there laid into H3's sound, or H3's own kept at it: In the take decides)
        name: "a window that carries on from the one before, a short run-up, the sound H3 makes, a sound cue in it",
        input: { picture: "p1", source: { asset: "v1", at: 5 }, previous: { asset: "w1" }, context: "5", keepSound: false, cues: [{ asset: "s1", start: 0, seconds: 0.6, at: 2.4 }] },
        slots: all, uploads: { picture: "p.png", source: "v.mp4", previous: "w.mp4", "cues.0": "clap.wav" }, media: { picture, source: { ...part, frames: 124 }, previous: { ...before, frames: 5 }, "cues.0": { width: 0, height: 0, seconds: 0.6 } },
      },
      // a window after a swap (Swap motion's that carried on, card #42): the swap's model, no Picture of its own
      ...((): Variant<H3MotionTransfer>[] => {
        const swap = { ...all, swapUnet: "minimax_h3_fused_refdelta_r1024_turbo8_mystic07_int8_convrot.safetensors" };
        const window = { width: 576, height: 1024, frames: 141, fps: H3_FPS, hasSound: true };
        const description = "The man with short brown hair in <Picture 1>, in a white shirt and jeans, dances.";
        return [
          {
            name: "a window after a swap: moved by its pose (DWPose), the cast's picture in, the source's sound kept",
            input: { afterSwap: true, description, source: { asset: "v1", at: 5 }, previous: { asset: "w1" }, references: [{ asset: "r1", role: "person" }], fast: true, shiftVideo: 12, shiftAudio: 3 },
            slots: swap, uploads: { source: "v.mp4", previous: "w.mp4", "references.0": "r1.png" }, media: { source: window, previous: before },
          },
          {
            name: "a window after a swap with a long run-up, its pose from SDPose, a weaker control ending early",
            input: { afterSwap: true, description, source: { asset: "v1", at: 5 }, previous: { asset: "w1" }, context: "39", references: [{ asset: "r1", role: "person" }], poseFrom: POSE_SDPOSE, controlStrength: 0.8, controlEnd: 0.75, poseFace: false },
            slots: swap, uploads: { source: "v.mp4", previous: "w.mp4", "references.0": "r1.png" }, media: { source: window, previous: { ...before, frames: 39 } },
          },
          {
            name: "a window after a swap with no picture of who goes in, written from its parts, from the window before's frames",
            input: { afterSwap: true, look: "short brown hair, a white shirt and jeans", happens: "he dances", source: { asset: "v1", at: 5 }, previous: { asset: "w1" }, joinFrom: "Frames", references: [], keepSound: false },
            slots: swap, uploads: { source: "v.mp4", previous: "w.mp4" }, media: { source: window, previous: before },
          },
        ];
      })(),
    ];
  })(),
});
