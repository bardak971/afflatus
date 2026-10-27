import { defineRecipe, gridAtOrBefore, GraphBuilder, plural, sameFile, type BuildContext, type ClipValue, type CueValue, type InputSpec, type LoraValue, type MediaFacts, type Recipe, type ReferenceRole, type ReferenceValue, type Ref, type SizeValue, type Variant } from "@afflatus/core";
import { LTX_CANVAS_SHORT, LTX_MAX_PIXELS, ltxCanvas, ltxFramesAt, MSR_DETECT } from "./family";
import { UPSCALE, UPSCALE_OPTIONAL, upscaleInputs, upscaleNeeds, upscaleNodes } from "../video/upscale";
import { faster, SPEED_INPUTS, speedNodes, type SpeedSettings } from "../shared/speed";
import { loadUnet, unetNodes } from "../shared/unet";
import { CORE_VIDEO_OUT, VHS } from "../shared/out";
import { colourCarried, colourMatched, COLOUR_MATCH_INPUTS, COLOUR_MATCH_NODES, finishFrames, openingStart, rifeNeeds, rifeSkippedSaid, type ColourMatch } from "../shared/finish";
import { applyLoras, livePreview, loraLoads } from "../shared/model";
import { recordingInputs, recordingNodes, recordingOnClip, type Recording, type RecordingFrames } from "../shared/recording";
import { CUE_SOUND, cuesFor, H3_CUES, layCues } from "../h3/cue";
import { FACE_PHOTO, FACE_NODE, facePhotos, faceScore } from "../shared/face";
import { FACE_REFINE_H3, FACE_REFINE_OPTIONAL, FACE_REFINE_TAKE_INPUTS, faceRefined, faceRefineNeeds, faceRefineSkipped } from "../h3/faceRefine";

/**
 * The LTX video recipe, made for a version of the model: LTX 2.3 and LTX 2.5 are the same two-pass graph (half the size
 * first, enlarged ×2 in the latent, refined in a few steps) with the same schedules, and differ in their files (2.5's Gemma 4
 * encoder carries the text projection inside it, and it has no one-file checkpoint), their frame rate (25 against 24),
 * their sampler (`euler` against `euler_ancestral`), their guider (CFG against 2.5's dual CFG, video and audio apart) and
 * their decoder's tiles. What differs is the spec; the rest is here once.
 */
export interface LtxSpec {
  id: string;
  family: string;
  /** The family's name in what is said ("LTX 2.3"). */
  name: string;
  title: string;
  summary: string;
  fps: number;
  /**
   * How the model's files are loaded: "checkpoint", LTX 2.3's one checkpoint (or its split files with a text projection
   * of their own); "split", LTX 2.5's split files, the projection inside its Gemma 4 file.
   */
  loader: "checkpoint" | "split";
  /** The guider: ComfyUI's CFGGuider, or 2.5's LTXVDualCFGGuider (video and audio alike at the form's CFG). */
  guider: "cfg" | "dual";
  /** The sampler the model's own template runs. */
  sampler: string;
  /** The decoder's tiles, as the template sets them. */
  decode: { tile: number; frames: number; overlap: number };
  /** What the Model choice lists (file name patterns). */
  modelMatch: string[];
  /** KJNodes' LTX2_NAG offered: tried on 2.3; not on 2.5's new blocks. */
  nag: boolean;
  /** The temporal upscaler's file, as the error names it. */
  temporalFile: string;
  /** The cast's pictures and a voice taken through Licon Studio's MSR LoRA (made for 2.5 alone). */
  references?: boolean;
  /** What is said when the model is not found, and when its split files lack a part. */
  missing: { model: string; parts: string };
  /**
   * The form is Lip sync (card #2): a new shot made around a recording, its part the clip's sound from the first step,
   * pinned, so that the picture (the mouth first) is made to it. Else Video with audio, which a recording may play over.
   */
  lipSync?: boolean;
  /**
   * H3's Face refine on the take's own frames (2.5: at H3's 24 a second, its 8n + 1 frames padded to H3's grid and cut back,
   * as SCAIL-2's at 24 fps). Not on 2.3: at 25 a second the sound held under the redrawn faces would not keep their time.
   */
  faceRefine?: boolean;
  /**
   * The stretches of digital silence in a sound the model is pinned to filled with a faint noise first (Afflatus: Room
   * Tone): 2.3 faded a sung clip to black over the song's pause, exact silence, and the clip after carried the fade on (#85).
   * 2.5, its own audio VAE, did not with the same recording.
   */
  roomTone?: boolean;
  /**
   * A seam's first own frames brought to the clip before's last as filed, then let go over a second (seamColour): 2.5's decoder.
   * A landing's last shown second likewise brought to the clip after's first frame (landColour).
   */
  seamColour?: boolean;
  variants: Variant<LtxVideo>[];
}

const SMOOTH_AUTO = "Auto";
const SMOOTH_RIFE = "RIFE (pixels)";
const SMOOTH_LTX = "LTX temporal (latent)";

/** The schedule LTX's authors give for the distilled model: 8 steps, written out (2.3 and 2.5 alike). */
export const LTX_SIGMAS = "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0";
/** The schedule of the second pass, over the enlarged clip: 3 steps that only refine. */
export const LTX_REFINE_SIGMAS = "0.85, 0.7250, 0.4219, 0.0";
/** How the refining pass comes down from where it starts, in three steps, as LTX's authors wrote it: shares of its first value. */
const REFINE_SHAPE = LTX_REFINE_SIGMAS.split(",").map((x) => Number(x) / 0.85);
/**
 * The schedule of the refining pass: it starts at `from` (how much of the enlarged clip is redrawn) and
 * comes down to nothing in `steps` steps. At 0.85 in 3 steps it is LTX's own, to the digit; other
 * figures follow the same curve.
 */
function refineSigmas(from: number, steps: number): string {
  const shares = steps === 3 ? REFINE_SHAPE : Array.from({ length: steps + 1 }, (_x, i) => 1 - (i / steps) ** 1.75);
  return shares.map((x, i) => (i === shares.length - 1 ? "0.0" : String(Number((from * x).toFixed(4))))).join(", ");
}
const OWN_SCHEDULE = "LTX's own (8 steps)";
const BY_STEPS = "By steps";

/**
 * How many frames of the clip before open a clip that carries on from it: its last second (25 frames, on the model's 8n + 1)
 * as a video guide at frame 0, the way LTX's own extension works from a clip's tail (its authors' pipelines carry 25 to 73
 * frames; 25 is what a short clip can give). A clip too short for that gives 9. Hidden on a timeline as H3's run-up is.
 * Also the frames of the clip after a clip lands on.
 */
export const LTX_JOIN_FRAMES = [25, 9];
/**
 * The run-ups the form offers (Frames from the clip before, card #87): H3's 5, 22 and 39 on LTX's grid of whole tokens (8k - 7),
 * 2, 4 and 6 tokens of the clip before. 41 frames (1.6 to 1.7 s) give the model more of a turn or a walk to read its direction
 * from; a clip before too short for the count asked gives the next one down. 41 is the default: in the 0.7.0 series (card #85)
 * the head's sound followed the clip before's best with it on both versions (r 0.92 and 0.99, against 0.81 to 0.88 at 25), for
 * about 8 % more render time.
 */
export const LTX_RUN_UPS = ["9", "25", "41"] as const;
/**
 * The counts a clip before can come handed over with: the run-up asked, else a shorter one of LTX_JOIN_FRAMES for a clip before
 * too short for it (the server puts the count asked ahead of those, as for H3's 39).
 */
const LTX_RUN_UP_FRAMES = LTX_RUN_UPS.map(Number).sort((a, b) => b - a);
/** The guide's strength on those frames: they are the clip before's own and are not shown, so they are held exactly. */
const CARRY_STRENGTH = 1;
/**
 * The core nodes that pin the clip before's sound under its frames: its sound encoded, laid at the start of the clip's
 * silence, and a noise mask that keeps it as it is (ComfyUI's own audio-to-video templates pin a whole sound the same way).
 */
const HEAD_SOUND_NODES = ["LTXVAudioVAEEncode", "LatentCompositeMasked", "SolidMask", "MaskComposite", "SetLatentNoiseMask"];
/** The Afflatus node pack (0.37.0) that keeps an LTX clip's latent, beside its video, for the clips that carry on from it. */
export const LTX_SAVE_LATENT = "AfflatusSaveLTXLatent";
/**
 * The pack's nodes a clip carries on from the clip before's own latent with: that latent loaded, its last tokens pinned at
 * frame 0 with its sound under them (as LTX's own extend sampler pins them), and the join decoded as one piece with it.
 */
export const LTX_CONTINUATION_NODES = ["AfflatusLoadLTXLatent", "AfflatusLTXContinuation", "AfflatusLTXSeamLatent"];
/** The pack's node that cuts a latent to its first frames: a clip handed over before its end is continued from there. */
export const LTX_TRIM = "AfflatusTrimLTXLatent";
/** ComfyUI's own nodes the latent route takes besides: the latent guide, and the frames of the seam decode the clip keeps. */
const LTX_LATENT_CORE = ["LTXVAddLatentGuide", "ImageFromBatch"];
/** Tokens of the clip before the seam decode starts on, before the run-up: its 8 × 4 frames are decoded, then dropped. */
const SEAM_CONTEXT = 4;
/** The longest clip the model takes, in seconds: the frames shared with the clip before count in it. */
const LTX_MAX_SECONDS = 20;
/** The core nodes that pin a whole sound under a clip: Lip sync's recording, encoded, laid into the silence and held there. */
const PINNED_SOUND_NODES = ["LTXVAudioVAEEncode", "LatentCompositeMasked", "SolidMask", "SetLatentNoiseMask"];

/**
 * The node pack's Room Tone (0.41.0): a sound's stretches of exact digital silence filled with a white noise at -50 dBFS,
 * the rest left as it is, before it is encoded to be pinned. Exact silence is the floor of the audio VAE's spectrogram:
 * LTX 2.3's encodes it to latents of RMS 2.1 to 2.3, against 1.0 to 1.3 for the voice and the song around it, and 1.1 once
 * filled (measured on the CPU on #85's takes, 2026-10-25). Only the copy the model is given: the take keeps the sound as it is.
 */
export const ROOM_TONE = "AfflatusRoomTone";
const ROOM_TONE_DB = -50;

/**
 * What an LTX clip holds of a recording (card #2): its part at the model's rate, on its 8n + 1 frames, 1 to 15 s (a recording
 * is cut into parts of up to 15 s, as for H3's clips; LTX takes 20 s, the frames of the clips it joins among them). Its pad
 * outlasts one step of the grid, which a clip's frames are brought down to.
 */
export const ltxRecording = (fps: number): RecordingFrames => ({ fps, frames: Math.round((15 * fps - 1) / 8) * 8 + 1, min: 1, most: 15, grid: { step: 8, offset: 1 }, pad: Math.ceil((8 / fps) * 100) / 100 });


/** The MSR LoRA's own pack: its loader reads the pictures' slot embeddings from the file, its guide lays each picture in its slot. */
const MSR_NODES = ["ComfyUILTX25MSRICLoRALoader", "ComfyUILTX25MSRMultiReferenceGuide"];
/** The pictures MSR numbers (pic1 to pic4); a place goes in the one background slot after them. */
const MSR_NUMBERED = 4;
/** What each picture is, as the prompt says it before the user's words (the LoRA's authors: label them "Image 1", "Image 2"...). */
const MSR_SAYS: Record<ReferenceRole, string> = { person: "a person", clothing: "the clothes worn", object: "an object", place: "the place, the background of the scene", style: "the look" };
/** A person's picture cut to a square around their face (afflatus-nodes 0.38, with insightface): MSR's guide fits the whole picture in its slot. */
export const FACE_CROP = "AfflatusFaceCrop";
/**
 * The same cut to the clip's frame shape and brought to its size (afflatus-nodes 0.39). MSR's guide cover-crops a picture of
 * its slot's shape family only, and fits any other whole on a white canvas: FACE_CROP's square in a 16:9 clip was laid between
 * white bars, which a clip that did not carry on from the one before copied into its frames (Timeline 10, card #91).
 */
export const FACE_FRAME = "AfflatusFaceFrame";
/**
 * What is around a person's head and shoulders in their picture, blurred or a plain grey (afflatus-nodes 0.40). MSR follows
 * all a picture shows: in the 0.7.0 series (card #85) every reference clip redid the photo's own setting (a stone arch, a
 * slicker) rather than the scene asked, and with an opening picture went there within a second.
 */
export const FACE_BACKDROP = "AfflatusFaceBackdrop";
/** Around the face, as the form says it; and as Face Backdrop's `backdrop` takes it. */
export const BACKDROPS = ["Blurred", "Grey", "As in the picture"] as const;
const BACKDROP_OF: Record<string, string> = { Blurred: "blur", Grey: "grey" };
/**
 * The prompt's line after the pictures' when a person is among them and no place is: the scene comes from the words (card
 * #81). Said as what to do, never as what not to: a prompt reads a thing it names, even after "not", as asked.
 */
const SCENE_FROM_WORDS = "The scene, its place, light and framing, is the one written below.";
/** MSR's guide's shape families (`aspect_family` in its _resize_reference): a picture of another family than its slot goes between white bars. */
const msrFamily = (width: number, height: number): string => (width / height >= 1.25 ? "landscape" : width / height <= 0.8 ? "portrait" : "square");

/**
 * The cast's pictures and voice, laid in MSR's slots: up to four pictures numbered in their order, the first place as the
 * background, a voice with the first picture when that one is a person (the guide pairs audio_ref1 with pic1). Null when
 * there is nothing to lay in, or when the LoRA or its pack is not here: the clip is then made from the words and LoRAs
 * alone, and the job says why. `voices`: the form takes a voice sample (Lip sync's voice is its recording).
 */
interface MsrRefs {
  numbered: Array<{ upload: string; role: ReferenceRole; size?: { width: number; height: number } }>;
  background: { upload: string; size?: { width: number; height: number } } | null;
  voice: string | null;
  /** The prompt's first lines: what each picture is, by its number. */
  legend: string;
  /** How the people's pictures are cut to their face: to the clip's frame (FACE_FRAME), to a square (FACE_CROP), or not. */
  faceCrop: typeof FACE_FRAME | typeof FACE_CROP | null;
  /** What becomes of what is around the people (Face Backdrop's `backdrop`), or null: their pictures as they are. */
  backdrop: string | null;
}
function msrOf(input: LtxVideo, ctx: Pick<BuildContext, "slots" | "uploads" | "media" | "has">, warnings: string[], voices: boolean, frame: { width: number; height: number }): MsrRefs | null {
  const given = (input.references ?? []).flatMap((r, i) => {
    const upload = ctx.uploads[`references.${i}`];
    const size = ctx.media[`references.${i}`];
    return upload ? [{ upload, role: r.role, ...(size?.width && size.height ? { size: { width: size.width, height: size.height } } : {}) }] : [];
  });
  const voiced = voices && Boolean(input.voice && ctx.uploads.voice);
  if (!given.length && !voiced) return null;
  const what = given.length && voiced ? "The reference pictures and the voice sample are" : given.length ? `The reference ${given.length > 1 ? "pictures are" : "picture is"}` : "The voice sample is";
  if (!ctx.slots.msr) {
    warnings.push(`${what} left out: LTX 2.5's MSR reference LoRA is not on this ComfyUI (models/loras; Settings › Models has it).`);
    return null;
  }
  if (!MSR_NODES.every((n) => ctx.has(n))) {
    warnings.push(`${what} left out: this ComfyUI lacks the ComfyUI-LTX2.5-MSR node pack, which reads the MSR LoRA's slots.`);
    return null;
  }
  const places = given.filter((r) => r.role === "place");
  const numbered = given.filter((r) => r.role !== "place");
  if (numbered.length > MSR_NUMBERED) warnings.push(`${plural(numbered.length - MSR_NUMBERED, "reference picture")} left out: LTX 2.5 takes ${MSR_NUMBERED}, and a place.`);
  if (places.length > 1) warnings.push(`${plural(places.length - 1, "place picture")} left out: LTX 2.5 takes one place, as the background.`);
  numbered.splice(MSR_NUMBERED);
  // the guide needs a first picture: a place given alone is that one
  const background = numbered.length && places[0] ? { upload: places[0].upload, ...(places[0].size ? { size: places[0].size } : {}) } : null;
  if (!numbered.length && places[0]) numbered.push(places[0]);
  let voice: string | null = null;
  if (voiced) {
    if (numbered[0]?.role === "person") voice = ctx.uploads.voice!;
    else warnings.push(`The voice sample is left out: LTX 2.5 gives a voice to the person in the first picture, and ${numbered.length ? "the first picture is not a person" : "there is no picture"}.`);
  }
  if (!numbered.length) return null;
  const roles: ReferenceRole[] = [...numbered.map((r) => r.role), ...(background ? (["place"] as const) : [])];
  const people = numbered.some((r) => r.role === "person");
  const cut = people && input.refFaceCrop !== false;
  const faceCrop = !cut ? null : ctx.has(FACE_FRAME) ? FACE_FRAME : ctx.has(FACE_CROP) ? FACE_CROP : null;
  if (cut && !faceCrop) warnings.push("The people's pictures go in whole, not cut to the face: this ComfyUI lacks Afflatus's Face Crop (node pack 0.38, with insightface).");
  if (faceCrop === FACE_CROP && msrFamily(frame.width, frame.height) !== "square") {
    warnings.push("The people's pictures are cut to a square around the face, which MSR lays between white bars in this clip's frame (node pack 0.39 cuts them to the frame's shape): a clip that does not carry on from the one before can copy the bars.");
  }
  const asked = BACKDROP_OF[input.refBackdrop ?? BACKDROPS[0]] ?? null;
  const backdrop = people && asked && ctx.has(FACE_BACKDROP) ? asked : null;
  if (people && asked && !backdrop) warnings.push("What is around the people in their pictures is kept as it is: this ComfyUI lacks Afflatus's Face Backdrop (node pack 0.40, with insightface).");
  const legend = [...roles.map((role, i) => `Image ${i + 1}: ${MSR_SAYS[role]}.`), ...(people && !background ? [SCENE_FROM_WORDS] : [])].join("\n");
  return { numbered, background, voice, legend, faceCrop, backdrop };
}

/**
 * A picture that is not a person's, cut to the frame's shape in its middle and brought to its size (ComfyUI's ImageScale)
 * when its shape is of another family than the frame's: MSR's guide would fit it whole between white bars, which a clip
 * can copy into its frames (card #91). A person's picture is cut around the face (FACE_FRAME); one of the frame's family,
 * or of a size not known, goes in as it is (the guide cover-crops it).
 */
function toFrame(g: GraphBuilder, pic: Ref, size: { width: number; height: number } | undefined, frame: { width: number; height: number }): Ref {
  if (!size || msrFamily(size.width, size.height) === msrFamily(frame.width, frame.height)) return pic;
  return g.out("ImageScale", { image: pic, upscale_method: "lanczos", width: frame.width, height: frame.height, crop: "center" });
}

/** Whether a LoRA of the list is the MSR LoRA: the file of its slot (under any folder), or a file named as it is. */
const isMsr = (file: string, slot: string | undefined): boolean => {
  const name = (f: string) => f.split(/[\\/]/).pop()!.toLowerCase();
  return (slot !== undefined && name(file) === name(slot)) || MSR_DETECT.some((d) => new RegExp(d, "i").test(name(file)));
};

/**
 * The LoRA list and the MSR LoRA's strength when the pictures go through it: the MSR LoRA put in the list by hand is taken
 * out of it, as its own loader already puts it on (Timeline 10, 2026-10-25: added at 0.8, it was loaded twice, the second
 * time by a plain loader that drops its slots). Its strength in the list, when it is on, is the one used.
 */
function msrHeld(input: LtxVideo, slot: string | undefined, warnings: string[]): { loras: LoraValue[]; strength: number } {
  const byHand = input.loras.filter((l) => isMsr(l.file, slot));
  const set = byHand.find((l) => l.weight !== 0);
  const strength = set?.weight ?? input.refLoraStrength ?? 1;
  if (byHand.length) warnings.push(`The MSR LoRA of the LoRA list is loaded once, by the references' own loader, at ${strength}${set ? " (its strength in the list)" : ""}.`);
  return { loras: input.loras.filter((l) => !isMsr(l.file, slot)), strength };
}

/** The pictures and the voice, where H3's forms have theirs and in their words; the cast fills them (compose). */
const MSR_INPUTS: InputSpec[] = [
  {
    id: "references", type: "references", label: "Reference images", max: MSR_NUMBERED + 1, roles: ["person", "clothing", "object", "place"], subjects: true,
    note: "pictures of a person, clothes, an object or a place: they are followed, they are not frames of the clip. Each picture is a subject of its own (two people: a picture of each), four at most, and one place, the scene's background. A clip that opens on a picture (a start frame, or carried on from the clip before) takes the face from that frame rather than from the reference. Through the MSR reference LoRA (Settings › Models has it) and its node pack; without them, left out",
  },
  {
    id: "voice", type: "audio", role: "voice", label: "Voice sample", optional: true, window: { start: "voiceStart", seconds: "voiceSeconds", even: "voiceEven" },
    // the MSR pack puts it ahead of the clip as a reference (its own time slot, at timestep 0) and takes it out of the
    // model's output: a voice to speak in, never laid into the take as H3 lays a lone sound reference (card #79)
    note: "someone speaking: a voice to speak in, not a sound of the take. The person in the first reference image says the prompt's line (in quotation marks) in that voice, the mouth on the model's own sound; the sample itself is not heard. The model hears the first 5 seconds of the part. Under a recording, the recording is heard instead. The LoRA's authors find the clip's other sounds come out only when the sample has music under the voice",
  },
  { id: "voiceStart", type: "number", label: "Voice sample: start", min: 0, max: 600, step: 0.5, default: 0, unit: " s", showWhen: "voice" },
  // the MSR LoRA's voice slot is 5 s (its metadata); a person's own part, up to H3's 15 s, is taken and cut there by the guide
  { id: "voiceSeconds", type: "number", label: "Voice sample: length", min: 2, max: 15, step: 0.5, default: 5, unit: " s", showWhen: "voice" },
  {
    id: "voiceEven", type: "toggle", label: "Even out the voice's loudness", default: true, showWhen: "voice", advanced: true,
    note: "the part is brought to a usual speaking level (-16 LUFS, measured as EBU R128) before it is used: a quiet sample carries a voice weakly",
  },
];

/** How the pictures are held: the LoRA's authors' values (their V2 workflow: 1, 1, 33 frames). */
const MSR_STRENGTHS: InputSpec[] = [
  {
    id: "refLoraStrength", type: "number", label: "Reference LoRA strength", min: 0, max: 1.5, step: 0.05, default: 1, showWhen: "references", advanced: true, perModel: true,
    note: "how strongly the MSR LoRA is put on the model: 1 is its authors', on the distilled model",
  },
  {
    id: "refFaceCrop", type: "toggle", label: "Crop people's pictures to the face", default: true, showWhen: "references", advanced: true,
    note: "a picture of a person is cut around the face to the clip's frame shape, its short side 2.5 face heights, and brought to the frame's size: MSR fits the whole picture in a slot the size of the clip's frame, where the face of a large or far portrait comes out a few latent cells, and a picture of another shape (a square in a 16:9 clip) goes between white bars, which a clip that does not carry on from the one before can copy. Off: the picture whole (to follow the clothes or the figure from it), with those bars when its shape is not the clip's",
  },
  {
    id: "refFaceSize", type: "number", label: "Face crop size", min: 1.5, max: 4, step: 0.25, default: 2.5, unit: " face heights", showWhen: "refFaceCrop", advanced: true,
    note: "the cut's short side, in face heights: 2.5 keeps the hair, the neck and some of the room behind; smaller is closer on the face, with less of the photo's setting for the clip to take",
  },
  {
    id: "refBackdrop", type: "choice", label: "Around the face", options: [...BACKDROPS], default: BACKDROPS[0], showWhen: "references", advanced: true,
    note: "what becomes of a person's picture around their head and shoulders. MSR follows all a picture shows: given a photo's room, light and clothes, a clip redoes that setting rather than the prompt's. Blurred keeps its colours, Grey nothing of it. As in the picture: the photo whole, its setting with it",
  },
  { id: "refStrength", type: "number", label: "Reference strength", min: 0, max: 1, step: 0.05, default: 1, showWhen: "references", advanced: true, note: "how closely the pictures are followed: 1 is the LoRA's authors'" },
  {
    id: "refFrames", type: "choice", label: "Reference frames", options: ["33", "25"], default: "33", showWhen: "references", advanced: true,
    note: "each picture is given to the model as a still this many frames long: 33 is the authors' default, 25 a little lighter. Its authors leave the choice to a test",
  },
];

export interface LtxVideo extends ColourMatch, Partial<Recording> {
  model?: string;
  /** Lip sync: a moment of the clip before the words begin, in seconds after the frames of the clip before. */
  speechAt?: number;
  /** Sounds pinned in the clip's sound at moments of it: on Lip sync with the recording, on Video with audio on their own. */
  cues?: CueValue[];
  /** Video with audio: whose sound the take carries at a cue, the file's part (the first) or the model's. */
  cueSound?: string;
  turboIn: string;
  prompt: string;
  negative: string;
  nag: boolean;
  nagScale: number;
  start?: string;
  previous?: ClipValue;
  /** The run-up asked, in frames (LTX_RUN_UPS): the server hands the clip before over with that many, or fewer for a short one. */
  context: string;
  next?: ClipValue;
  end?: string;
  mid?: string;
  midAt: number;
  midStrength: number;
  seconds: number;
  shape: SizeValue;
  short: number;
  twoPass: boolean;
  refineStrength: number;
  refineSteps: number;
  loraStrength: number;
  tile: number;
  tileFrames: number;
  crf: number;
  schedule: string;
  steps: number;
  maxShift: number;
  baseShift: number;
  terminal: number;
  stretch: boolean;
  cfg: number;
  sampler: string;
  startStrength: number;
  endStrength: number;
  compression: number;
  smooth: boolean;
  smoothWith: string;
  /** Set by a timeline (traits.latentAfter): the clip after carries on in this clip's latent, so it is doubled with RIFE. */
  latentAfter?: boolean;
  upscale: string;
  upscaleBy: number;
  upscaleModel: string;
  upscaleColour?: string;
  livePreview: boolean;
  sage: SpeedSettings["sage"];
  sageKernel: SpeedSettings["sageKernel"];
  compile: SpeedSettings["compile"];
  loras: LoraValue[];
  seed: number;
  /** The reference pictures and the voice (2.5): absent on a version that takes none. */
  references?: ReferenceValue[];
  voice?: string;
  refStrength?: number;
  refFrames?: string;
  refLoraStrength?: number;
  refFaceCrop?: boolean;
  refFaceSize?: number;
  refBackdrop?: string;
  /** The cast person's picture the take is scored against (2.3: no reference pictures of its own). */
  facePhoto?: string;
  faceRefine?: boolean;
  faceRefineDenoise?: number;
  faceRefineSteps?: number;
}

/** What a model is, as far as its file name says: the distilled one, or a merge known to be made for a few steps. */
// The fine-tune lines are named: DragonLeap and SolsticeCoin are distilled (DMD, 8 to 12 steps at CFG 1), GoldenLace is not
const namedDistilled = /distill|turbo|lightning|lightspeed|dmd|dragonleap|solsticecoin|(^|[^a-z0-9])\d+[ _-]?steps?/i;

/**
 * How the model is loaded. In separate files when a diffusion model is picked or found; otherwise (LTX 2.3) from
 * the one checkpoint. Whether it is distilled decides if the distilled LoRA goes on top of it.
 *
 * A picked model that is the one checkpoint's file (the checkpoint slot's, by name) is that checkpoint, unless this
 * ComfyUI offers it as a diffusion model (`offered`: a PC that keeps a copy in diffusion_models, where UNETLoader reads
 * it). Taken as a diffusion model, a fresh pod was sent it into checkpoints and the split files counted as not needed,
 * its audio VAE never fetched, and the job refused at its submit for both (card #103, 2026-10-26).
 */
const modelOf = (spec: LtxSpec, input: LtxVideo, slots: Record<string, string>, offered?: string[] | null) => {
  const whole = spec.loader === "checkpoint" && Boolean(input.model && slots.checkpoint && sameFile([slots.checkpoint], input.model) && !(offered && sameFile(offered, input.model)));
  const unet = whole ? undefined : (input.model ?? slots.unet);
  const checkpoint = spec.loader === "checkpoint" && !unet ? slots.checkpoint : undefined;
  const name = (unet ?? checkpoint)?.split(/[\\/]/).pop() ?? "";
  return { unet, checkpoint, distilled: input.turboIn === "Yes" || (input.turboIn !== "No" && namedDistilled.test(name)) };
};

/**
 * Which way the clip is made. In two passes when it can be: a first pass at half the size, enlarged in
 * latent space, then a short second pass that refines it. That needs the latent upscaler, and it is how
 * a clip is made from words or from an opening picture. A clip that ends on a picture is made in one
 * pass at full size, its pictures given as guides: the way ComfyUI's own first-and-last-frame template does it.
 */
const uses = (input: LtxVideo, slots: Record<string, string>) => ({ twoPass: input.twoPass && Boolean(slots.upscaler) && !input.end });

/**
 * The frame a keyframe is pinned at: its moment at the model's frame rate, counted after the frames shared with the clip
 * before (`head`), kept off the first frame and off the last one, which belong to the first and the last picture.
 */
const midFrame = (input: LtxVideo, fps: number, frames: number, head = 0) => {
  // on the model's 8-frame steps (the node rounds a guide's index down to one by itself, so 2.5 s typed landed at 2.24 s),
  // off the first frame and the last, which belong to the first and the last picture
  const step = 8;
  const at = head + Math.round((input.midAt * fps) / step) * step;
  return Math.max(step, Math.min(frames - 1 - step, at));
};

/**
 * The frames of the clip before a clip opens on (a run-up: 41, 25 or 9), or of the clip after it lands on (25 or 9), as they
 * were handed over, on the model's 8n + 1.
 */
function joinFramesOf(m: MediaFacts | undefined, side: "previous" | "next"): number {
  const n = m?.frames ?? 0;
  const [does, which, counts] = side === "previous" ? ["carries on from", "before", LTX_RUN_UP_FRAMES] : ["lands on", "after", LTX_JOIN_FRAMES];
  if (!counts.includes(n)) throw new Error(`a clip ${does} ${counts.join(", ").replace(/, (\d+)$/, " or $1")} frames of the clip ${which}, not ${n}`);
  return n;
}
/**
 * How many steps the refining pass takes: the form's, and one more than LTX's own 3 on a clip past 241 frames (9.6 s),
 * where users find the ×2 upscaler needs it (Lightricks discussion #13, 2026-03). A count typed other than 3 is taken as typed.
 */
const refineStepsOf = (input: LtxVideo, frames: number) => (input.refineSteps === 3 && frames > 241 ? 4 : input.refineSteps);

/** Frames as the model likes them: at the clip's size, and roughened like frames of video. */
function ltxGuideFrames(g: GraphBuilder, input: LtxVideo, images: Ref, w: number, h: number): Ref {
  const sized = g.out("ImageScale", { image: images, upscale_method: "lanczos", width: w, height: h, crop: "center" });
  return g.out("LTXVPreprocess", { image: sized, img_compression: input.compression });
}
/** A picture the same way. */
const ltxFrame = (g: GraphBuilder, input: LtxVideo, upload: string | undefined, w: number, h: number): Ref => ltxGuideFrames(g, input, g.out("LoadImage", { image: upload }), w, h);

/**
 * The model, its text encoder and its two VAEs: from files of their own or from the one checkpoint, the LoRAs and the
 * speed-ups on it, then the distilled LoRA and the live preview. `model` samples every pass; `first` the first one.
 * `msr`: the MSR LoRA's strength and the LoRA list without it (msrHeld), when the pictures go through it.
 */
function ltxLoad(spec: LtxSpec, g: GraphBuilder, ctx: BuildContext, input: LtxVideo, picked: ReturnType<typeof modelOf>, msr: ReturnType<typeof msrHeld> | null) {
  const { slots } = ctx;
  let model: Ref;
  let clip: Ref;
  let vae: Ref;
  let audioVae: Ref;
  if (picked.unet) {
    model = loadUnet(g, ctx, picked.unet);
    // 2.3's split files: the text encoder and its projection are two files; 2.5's Gemma 4 file carries the projection
    clip = spec.loader === "checkpoint"
      ? g.out("DualCLIPLoader", { clip_name1: slots.clip, clip_name2: slots.projection, type: "ltxv", device: "default" })
      : g.out("CLIPLoader", { clip_name: slots.clip, type: "ltxv", device: "default" });
    vae = g.out("VAELoader", { vae_name: slots.videoVae });
    audioVae = g.out("VAELoader", { vae_name: slots.audioVae });
  } else {
    const loaded = g.add("CheckpointLoaderSimple", { ckpt_name: picked.checkpoint });
    model = [loaded, 0];
    vae = [loaded, 2];
    audioVae = g.out("LTXVAudioVAELoader", { ckpt_name: picked.checkpoint });
    clip = g.out("LTXAVTextEncoderLoader", { text_encoder: slots.clip, ckpt_name: picked.checkpoint, device: "default" });
  }
  model = applyLoras(g, model, msr?.loras ?? input.loras);
  // the MSR LoRA through its own loader, which hands its slot embeddings on to the guide (a plain LoRA loader drops them)
  let msrParams: Ref | null = null;
  if (msr) {
    const loader = g.add("ComfyUILTX25MSRICLoRALoader", { model, lora_name: ctx.slots.msr, strength_model: msr.strength });
    model = [loader, 0];
    msrParams = [loader, 1];
  }
  model = faster(g, model, input, ctx);
  const byHand = input.schedule !== BY_STEPS;
  // the live preview, without sound: the node plays it for H3 alone (seen on a real render: an audio VAE given here is not used)
  const previewed = (m: Ref): Ref => livePreview(g, ctx, m, input.livePreview);
  // the full model: with LTX's own 8 steps the distilled LoRA goes on the whole render at half strength, as
  // ComfyUI's template has it; with By steps the dev model samples on its own schedule and the LoRA refines only
  const lora = !picked.distilled && slots.turbo ? slots.turbo : undefined;
  // the model without the LoRA is only sampled with when there is no LoRA, or By steps is off (the first pass runs on it)
  const plain = lora && byHand ? null : previewed(model);
  const boosted = lora ? previewed(g.out("LoraLoaderModelOnly", { model, lora_name: lora, strength_model: input.loraStrength })) : plain!;
  return { model: boosted, first: byHand ? boosted : plain!, clip, vae, audioVae, lora, msrParams };
}

/** What every pass of a render takes: the model, the conditioning, the sampler, the empty sound, the schedule of the first pass, and the passes so far. */
interface LtxRun {
  spec: LtxSpec;
  g: GraphBuilder;
  ctx: BuildContext;
  input: LtxVideo;
  loaded: ReturnType<typeof ltxLoad>;
  cond: string;
  sampler: Ref;
  sound: Ref;
  sigmas: (latent: Ref) => Ref;
  steps: number;
  frame: { width: number; height: number; frames: number };
  passes: Array<{ node: string; steps: number }>;
  /** The clip before's last frames, as handed over, and how many: the clip opens on them. Null when it starts on its own. */
  previous: Ref | null;
  head: number;
  /** The clip after's first frames, as handed over, and how many: the clip ends on them. Null when it lands on nothing. */
  next: Ref | null;
  tail: number;
  /** The sound as a pass is given it again: with the clip before's sound pinned at the head, that pin put back (headSound). */
  pin: (audio: Ref) => Ref;
  /**
   * Carried on in the latent: the clip before's last tokens (AfflatusLTXContinuation's video guide), pinned in the passes at
   * the clip's full size; the first pass, at half the size, is guided by its frames. Null on frames.
   */
  latentGuide: Ref | null;
  /** The clip opens on its first-frame picture (not when it carries on from a clip: that one's frames open it). */
  opens: boolean;
  /** The reference pictures, loaded once, and the voice, encoded once: given to every pass's guide, as the LoRA's authors do. */
  msr: { pics: Record<string, Ref>; voice: Ref | null } | null;
}

/** The guider of a pass: CFG on the conditioning, or 2.5's dual CFG with the video and the sound at the same scale. */
function guiderOf(run: LtxRun, model: Ref, positive: Ref, negative: Ref): Ref {
  const { spec, g, input } = run;
  return spec.guider === "dual"
    ? g.out("LTXVDualCFGGuider", { model, positive, negative, video_cfg: input.cfg, audio_cfg: input.cfg })
    : g.out("CFGGuider", { model, positive, negative, cfg: input.cfg });
}

/**
 * The guides on a pass's latent, at that pass's size: the clip before's frames at frame 0, then the keyframe at its moment.
 * Frames added to the clip, taken out again once the pass is sampled (LTXVCropGuides), so that they are neither enlarged as
 * part of the clip nor decoded with it.
 */
function guided(run: LtxRun, on: Ref, wide: number, high: number, opening?: string, full = true): { positive: Ref; negative: Ref; latent: Ref; any: boolean } {
  const { spec, g, ctx, input, cond, loaded } = run;
  let positive: Ref = [cond, 0];
  let negative: Ref = [cond, 1];
  let latent = on;
  const add = (image: Ref, at: number, strength: number) => {
    const added = g.add("LTXVAddGuide", { positive, negative, vae: loaded.vae, latent, image, frame_idx: at, strength });
    positive = [added, 0];
    negative = [added, 1];
    latent = [added, 2];
  };
  // the reference pictures first, each in its slot ahead of the clip's frames, the voice with the first; the guide sizes them to the pass
  if (run.msr && loaded.msrParams) {
    const refs = g.add("ComfyUILTX25MSRMultiReferenceGuide", {
      positive, negative, vae: loaded.vae, latent, ...run.msr.pics, msr_parameters: loaded.msrParams, ...(run.msr.voice ? { audio_ref1: run.msr.voice } : {}),
      strength: input.refStrength ?? 1, reference_frames: input.refFrames ?? "33", use_tiled_encode: false, tile_size: 256, tile_overlap: 64,
    });
    positive = [refs, 0];
    negative = [refs, 1];
    latent = [refs, 2];
  }
  // the clip before's own tokens at frame 0 at the clip's full size (latent_idx 0, as LTX's extend sampler pins them), else its frames
  if (run.latentGuide && full) {
    const added = g.add("LTXVAddLatentGuide", { positive, negative, vae: loaded.vae, latent, guiding_latent: run.latentGuide, latent_idx: 0, strength: CARRY_STRENGTH });
    positive = [added, 0];
    negative = [added, 1];
    latent = [added, 2];
  } else if (run.previous) add(ltxGuideFrames(g, input, run.previous, wide, high), 0, CARRY_STRENGTH);
  // the first picture as a guide (the one-pass route; the two-pass one puts it in the latent itself)
  else if (opening) add(ltxFrame(g, input, opening, wide, high), 0, input.startStrength);
  if (input.mid) add(ltxFrame(g, input, ctx.uploads.mid, wide, high), midFrame(input, spec.fps, run.frame.frames, run.head), input.midStrength);
  // the clip after's first frames at the clip's end, held as exactly as the clip before's: the clip lands on them. ComfyUI keeps
  // 8n of the 8n + 1 handed over and puts a guide of several frames on 8k + 1 (it moves one at 8k back 7 frames): the tail
  // counts the 8n kept, so that it starts on 8k + 1 of a clip of 8m + 1 and ends on the clip's last frame
  if (run.next) add(ltxGuideFrames(g, input, run.next, wide, high), run.frame.frames - run.tail, CARRY_STRENGTH);
  return { positive, negative, latent, any: Boolean(run.msr || run.previous || opening || input.mid || run.next) };
}

/**
 * Two passes: the first at half the size, where the whole clip is decided, picture and sound; then the clip
 * enlarged ×2 in latent space and refined in a few steps, the sound of the first pass kept.
 */
function ltxTwoPass(run: LtxRun): { video: Ref; audio: Ref } {
  const { g, ctx, input, loaded, sampler, sound, frame, passes } = run;
  const { vae } = loaded;
  const { width, height, frames } = frame;
  const w = width / 2;
  const h = height / 2;
  let latent: Ref = g.out("EmptyLTXVLatentVideo", { width: w, height: h, length: frames, batch_size: 1 });
  if (run.opens) latent = g.out("LTXVImgToVideoInplace", { vae, image: ltxFrame(g, input, ctx.uploads.start, w, h), latent, strength: input.startStrength, bypass: false });
  // the clip before's frames and the keyframe are guides in each pass, at that pass's size (see guided)
  const cropped = (by: { positive: Ref; negative: Ref; any: boolean }, sampled: Ref): Ref => (by.any ? [g.add("LTXVCropGuides", { positive: by.positive, negative: by.negative, latent: sampled }), 2] : sampled);
  const half = guided(run, latent, w, h, undefined, false);
  g.phase("sampling");
  const first = g.add("SamplerCustomAdvanced", {
    noise: g.out("RandomNoise", { noise_seed: ctx.seed }),
    guider: guiderOf(run, loaded.first, half.positive, half.negative),
    sampler, sigmas: run.sigmas(half.latent),
    latent_image: g.out("LTXVConcatAVLatent", { video_latent: half.latent, audio_latent: sound }),
  });
  passes.push({ node: first, steps: run.steps });
  const made = g.add("LTXVSeparateAVLatent", { av_latent: [first, 0] });
  const decided = cropped(half, [made, 0]);

  g.phase("upscaling");
  let large: Ref = g.out("LTXVLatentUpsampler", { samples: decided, upscale_model: g.out("LatentUpscaleModelLoader", { model_name: ctx.slots.upscaler }), vae });
  // the opening picture again, at full size and at full strength: the first frame is the picture itself
  if (run.opens) large = g.out("LTXVImgToVideoInplace", { vae, image: ltxFrame(g, input, ctx.uploads.start, width, height), latent: large, strength: 1, bypass: false });
  const full = guided(run, large, width, height);
  g.phase("refining");
  const refine = refineStepsOf(input, frames);
  const second = g.add("SamplerCustomAdvanced", {
    noise: g.out("RandomNoise", { noise_seed: ctx.seed + 1 }),
    guider: guiderOf(run, loaded.model, full.positive, full.negative),
    sampler, sigmas: g.out("ManualSigmas", { sigmas: refineSigmas(input.refineStrength, refine) }),
    latent_image: g.out("LTXVConcatAVLatent", { video_latent: full.latent, audio_latent: run.pin([made, 1]) }),
  });
  passes.push({ node: second, steps: refine });
  const done = g.add("LTXVSeparateAVLatent", { av_latent: [second, 0] });
  return { video: cropped(full, [done, 0]), audio: [done, 1] };
}

/** One pass at full size, the pictures given as guides at the first and the last frame, and the keyframe at its own. */
function ltxOnePass(run: LtxRun): { video: Ref; audio: Ref } {
  const { g, ctx, input, loaded, sampler, sound, frame, passes } = run;
  const { width, height, frames } = frame;
  // the clip before's frames at frame 0, else the first picture; then the keyframe; then the last picture
  let { positive, negative, latent, any } = guided(run, g.out("EmptyLTXVLatentVideo", { width, height, length: frames, batch_size: 1 }), width, height, run.opens ? ctx.uploads.start : undefined);
  const guide = (upload: string | undefined, at: number, strength: number) => {
    const added = g.add("LTXVAddGuide", { positive, negative, vae: loaded.vae, latent, image: ltxFrame(g, input, upload, width, height), frame_idx: at, strength });
    positive = [added, 0];
    negative = [added, 1];
    latent = [added, 2];
    any = true;
  };
  // -1 is still the clip's last frame after the keyframe's guide: ComfyUI counts back from the clip without the guide frames added to it
  if (input.end) guide(ctx.uploads.end, -1, input.endStrength);
  g.phase("sampling");
  const only = g.add("SamplerCustomAdvanced", {
    noise: g.out("RandomNoise", { noise_seed: ctx.seed }),
    guider: guiderOf(run, loaded.model, positive, negative),
    sampler, sigmas: run.sigmas(latent),
    latent_image: g.out("LTXVConcatAVLatent", { video_latent: latent, audio_latent: sound }),
  });
  passes.push({ node: only, steps: run.steps });
  const done = g.add("LTXVSeparateAVLatent", { av_latent: [only, 0] });
  // the guides are frames added to the clip: they are taken out again before it is decoded
  return { video: any ? [g.add("LTXVCropGuides", { positive, negative, latent: [done, 0] }), 2] : [done, 0], audio: [done, 1] };
}

/**
 * Whether LTX's temporal upscaler doubles the frames, as the build picks (`there`: its file, and in the build its nodes, are
 * there): Interpolate ×2 on, not with RIFE, and not Auto with SeedVR2 (RIFE after it: SeedVR2 would restore twice the frames).
 * The files and nodes are asked by the same rule, so that a pod is not sent Face refine's files for a pass left out.
 */
const doublesInLatent = (input: LtxVideo, there: boolean): boolean =>
  input.smooth && input.smoothWith !== SMOOTH_RIFE && there && !(input.smoothWith === SMOOTH_AUTO && input.upscale === UPSCALE.seedvr);

/**
 * A clip carried on in the clip before's latent is interpolated with RIFE, never with the temporal upscaler (card #40,
 * 2026-10-26): each clip is doubled on its own, its settle pass (fresh noise) remaking all its frames, the head too, so the
 * two clips' frames at the cut come from two different passes and the join jumps (a step ×10, ΔE 1.44), and the seam decode
 * cannot be had on doubled tokens. With RIFE the seam decode holds (ΔE 0.4 to 0.7). Auto takes RIFE there without a word;
 * the temporal upscaler asked for by name, this line on the job. Whether a clip carries on in the latent is only known in the
 * build (the clip before's kept latent, as sent): the files and nodes lists ask for RIFE's, and Face refine's, for any clip
 * that carries on from one.
 *
 * The clip before such a join takes RIFE too (card #108, 2026-10-26), so that a whole chain in the latent does: doubled by
 * the temporal upscaler, its last frames were the settle pass's, not the latent the clip after carries on in, and the join
 * still stepped (×7.6, ΔE 0.34). The timeline says so (`latentAfter`, set on every clip from the clip after); a clip nothing
 * carries on from keeps the temporal upscaler.
 */
const latentRifeSaid = (side: "before" | "after") => side === "before"
  ? "Interpolated with RIFE, not LTX's temporal upscaler: this clip carries on in the clip before's latent, where the upscaler's settle pass makes the frames at the join anew and the join jumps."
  : "Interpolated with RIFE, not LTX's temporal upscaler: the clip after carries on in this clip's latent, where the upscaler's settle pass makes the frames at the join anew and the join jumps.";

/** Whether a clip's frames are kept off the temporal upscaler for a join in the latent: on either side of one (latentRifeSaid). */
const inLatentChain = (input: LtxVideo, before: boolean): boolean => before || Boolean(input.latentAfter);

/** Twice the frames with LTX's temporal upscaler: the latent's frames doubled (the sound untouched), then a short pass settles them. */
function ltxTemporal(run: LtxRun, made: { video: Ref; audio: Ref }): { video: Ref; audio: Ref } {
  const { g, ctx, loaded, cond, sampler, passes } = run;
  g.phase("interpolating");
  const doubled = g.out("LTXVLatentUpsampler", { samples: made.video, upscale_model: g.out("LatentUpscaleModelLoader", { model_name: ctx.slots.temporal }), vae: loaded.vae });
  const settled = g.add("SamplerCustomAdvanced", {
    noise: g.out("RandomNoise", { noise_seed: ctx.seed + 2 }),
    guider: guiderOf(run, loaded.model, [cond, 0], [cond, 1]),
    sampler, sigmas: g.out("ManualSigmas", { sigmas: refineSigmas(0.5, 2) }),
    latent_image: g.out("LTXVConcatAVLatent", { video_latent: doubled, audio_latent: run.pin(made.audio) }),
  });
  passes.push({ node: settled, steps: 2 });
  const apart = g.add("LTXVSeparateAVLatent", { av_latent: [settled, 0] });
  return { video: [apart, 0], audio: [apart, 1] };
}

/** A sound as the model is given it to be pinned to: with Room Tone in its silences on 2.3, else as it is. */
type Toned = (wave: Ref) => Ref;
const tonedFor = (spec: LtxSpec, g: GraphBuilder, ctx: BuildContext): Toned =>
  spec.roomTone && ctx.has(ROOM_TONE) ? (wave) => g.out(ROOM_TONE, { audio: wave, level_db: ROOM_TONE_DB, seed: 0 }) : (wave) => wave;

/**
 * The sound the first pass starts from: silence for the model to fill, or, for a clip that carries on from one with sound, the
 * clip before's own sound under its frames at the head, pinned (a noise mask of 0 there) so that the model carries it on
 * rather than making up another over the same moments (r 0.13 to 0.14 against the clip before, measured on such heads on
 * 2026-10-21). Laid into the silence rather than joined to it, the clip keeps the silence's length whatever the encoder makes
 * of the head's. The mask is a column as tall as the clip's frames, stretched over the sound's own steps; its pinned part is a
 * frame short of the head, so that what is pinned is the head's sound, never the silence after it. `carried`: the head's
 * sound is the clip before's (the take's join says so, and the sound hands over early into it).
 */
function headSound(g: GraphBuilder, ctx: BuildContext, audioVae: Ref, previous: Ref | null, frames: number, head: number, fps: number, tone: Toned): { sound: Ref; pin: (audio: Ref) => Ref; carried: boolean } {
  const sound = g.out("LTXVEmptyLatentAudio", { frames_number: frames, frame_rate: fps, batch_size: 1, audio_vae: audioVae });
  if (!previous || head < 2 || ctx.media.previous?.hasSound === false || !HEAD_SOUND_NODES.every((n) => ctx.has(n))) return { sound, pin: (audio) => audio, carried: false };
  const heard = g.out("LTXVAudioVAEEncode", { audio: tone([previous[0], 1]), audio_vae: audioVae });
  const laid = g.out("LatentCompositeMasked", { destination: sound, source: heard, x: 0, y: 0, resize_source: false });
  const mask = g.out("MaskComposite", {
    destination: g.out("SolidMask", { value: 1, width: 1, height: frames }),
    source: g.out("SolidMask", { value: 0, width: 1, height: head - 1 }),
    x: 0, y: 0, operation: "multiply",
  });
  // given again to every pass after the first: the sound each one is handed is the pass before's, the head still the clip before's
  const pin = (audio: Ref): Ref => g.out("SetLatentNoiseMask", { samples: audio, mask });
  return { sound: pin(laid), pin, carried: true };
}

/**
 * Whether the clip carries on from the clip before's own latent, and what of it: the file the server sent, its frames (cut to
 * the hand-over frame when it was) and its size, which the clip is made at. Only with the node pack's nodes and ComfyUI's
 * latent guide, a run-up of whole tokens, and (two passes) a size the half-size pass can be made at. Else `why` the latent
 * sent is not taken, for the job to say: null when no latent was sent, or the server said so already (no node pack).
 */
function latentJoinOf(ctx: BuildContext, input: LtxVideo, head: number, twoPass: boolean): { file: string; frames: number; cut: number; size: { width: number; height: number } } | { why: string | null } {
  const facts = ctx.media.previous;
  const file = input.previous ? ctx.uploads["previous.latent"] : undefined;
  const size = facts?.latentSize;
  const frames = facts?.latentFrames ?? 0;
  const cut = facts?.latentCut ?? 0;
  if (!file) return { why: null };
  const onFrames = "The join with the clip before was made on frames";
  if (!size) return { why: `${onFrames}: its latent came without its size.` };
  if (frames < head || (head + 7) % 8 !== 0) return { why: `${onFrames}: a run-up of ${head} frames is not whole tokens of its latent (8 × n + 1 frames).` };
  // the pack's nodes missing: the server said so when it sent the latent (queueSubmit's finishLatent)
  if (![...LTX_CONTINUATION_NODES, ...(cut ? [LTX_TRIM] : [])].every((n) => ctx.has(n))) return { why: null };
  const core = LTX_LATENT_CORE.find((n) => !ctx.has(n));
  if (core) return { why: `${onFrames}: this ComfyUI lacks its own ${core}, which a join in the latent takes (ComfyUI from September 2026 has it). Update ComfyUI.` };
  if (size.width % (twoPass ? 64 : 32) || size.height % (twoPass ? 64 : 32)) return { why: `${onFrames}: its latent's ${size.width} × ${size.height} is not a size the half-size pass can be made at.` };
  return { file, frames, cut, size };
}

/**
 * Lip sync's sound (card #2): the clip's whole sound given from the first step and pinned (a noise mask of 0 over all of it),
 * so that the model makes the picture to it, the mouth first, as ComfyUI's own audio-to-video templates do; its later passes
 * are given the same pin again. `wave` is also the sound the take's files carry: the clip before's under the head, silence
 * for the moment before the words, then the recording's part. Laid into the silence rather than given alone, the clip keeps
 * the silence's length whatever the encoder makes of the file's.
 */
function pinnedSound(g: GraphBuilder, audioVae: Ref, wave: Ref, frames: number, fps: number, tone: Toned): { sound: Ref; pin: (audio: Ref) => Ref } {
  const silence = g.out("LTXVEmptyLatentAudio", { frames_number: frames, frame_rate: fps, batch_size: 1, audio_vae: audioVae });
  const laid = g.out("LatentCompositeMasked", { destination: silence, source: g.out("LTXVAudioVAEEncode", { audio: tone(wave), audio_vae: audioVae }), x: 0, y: 0, resize_source: false });
  const mask = g.out("SolidMask", { value: 0, width: 1, height: frames });
  const pin = (audio: Ref): Ref => g.out("SetLatentNoiseMask", { samples: audio, mask });
  return { sound: pin(laid), pin };
}

/**
 * The sound cues (card #2), as H3's forms take them (card #71): each a part of a file at a moment of the clip's own time. On
 * Lip sync they are added into the sound the clip is made to, over the recording, and held there with it: the take carries
 * them as they are, so there is no "In the take" choice to make. On Video with audio each one's stretch of the clip's sound is
 * held as the file, the rest left to the model (cuedSound), and the take carries the file's part. The model's own sound at a
 * cue ("LTX's own", H3's other choice) is not offered (card #105, 2026-10-26): LTX made the action again and again around
 * the cue there (claps every fifth of a second, in the sound and the picture), where the file's sound was measured fine.
 */
function ltxCues(spec: LtxSpec): InputSpec[] {
  // the line every LTX cue's "?" ends on: what the model does around one
  const repeats = "LTX tends to repeat the action around a cue (a clap made several times over)";
  const cues: InputSpec = {
    id: "cues", type: "cues", label: "Sound cues", max: H3_CUES,
    note: spec.lipSync
      ? `sounds that land at moments of the clip: a door slam, a clap, a music hit. Each one is a part of its file and the moment it lands, in the clip's own time, added over the recording and held with it, so the take carries it as it is; the picture meets it when What happens names it at that moment ("she claps her hands once"). ${repeats}`
      : `sounds that land at moments of the clip: a door slam, a clap, a line, a music hit. Each one is a part of its file and the moment it lands, in the clip's own time. ${spec.name} hears it there as the clip's own sound and makes the rest around it, and the take carries the file's part there; the picture meets it when the prompt names it at that moment ("she claps her hands once"). ${repeats}`,
  };
  if (spec.lipSync) return [cues];
  // The file's sound only, never drawn: a clip or take saved with "<model>'s own" (0.7.0's test builds) still loads, read as
  // the file's sound when it is rendered again; the take made with it stays as it was made
  return [cues, {
    id: "cueSound", type: "choice", label: "In the take", options: [CUE_SOUND[0]], renamed: { [`${spec.name}'s own`]: CUE_SOUND[0] }, default: CUE_SOUND[0], internal: true,
    note: `each cue's part is laid into the take at its moment, over ${spec.name}'s own sound there (added over a recording that plays over the clip, which plays on unchanged under it)`,
  }];
}

/**
 * Video with audio's sound with its cues pinned in it (card #2): a sound as long as the clip, the clip before's under the head
 * (`before`, from its file: the latent's own head mask is at the latent's size, which a mask counted in frames cannot be laid
 * on), silence after it, each cue's part laid in at its moment; encoded, laid into the clip's silence, and held by a noise
 * mask of 0 over the head and each cue's stretch only. The mask is a column as tall as the clip's frames: ComfyUI stretches
 * it over the sound's own steps (reshape_mask, bilinear), so a row is a frame's moment of the sound, as headSound's is.
 */
function cuedSound(g: GraphBuilder, audioVae: Ref, before: Ref | null, cues: NonNullable<ReturnType<typeof cuesFor>>, frames: number, head: number, fps: number, tone: Toned): { sound: Ref; pin: (audio: Ref) => Ref; carried: boolean } {
  const quiet = (duration: number): Ref => g.out("EmptyAudio", { duration, sample_rate: 48000, channels: 2 });
  const base = before ? g.out("AudioConcat", { audio1: before, audio2: quiet((frames - head) / fps), direction: "after" }) : quiet(frames / fps);
  const wave = layCues(g, base, cues.placed, cues.parts, { frames, over: false, fps });
  const silence = g.out("LTXVEmptyLatentAudio", { frames_number: frames, frame_rate: fps, batch_size: 1, audio_vae: audioVae });
  const laid = g.out("LatentCompositeMasked", { destination: silence, source: g.out("LTXVAudioVAEEncode", { audio: tone(wave), audio_vae: audioVae }), x: 0, y: 0, resize_source: false });
  let mask: Ref = g.out("SolidMask", { value: 1, width: 1, height: frames });
  const hold = (from: number, rows: number) => {
    mask = g.out("MaskComposite", { destination: mask, source: g.out("SolidMask", { value: 0, width: 1, height: rows }), x: 0, y: from, operation: "multiply" });
  };
  // the head a frame short, as headSound pins it; each cue over its own frames, one at least
  if (before && head > 1) hold(0, head - 1);
  for (const p of cues.placed) hold(p.frame, Math.max(1, Math.round(p.seconds * fps)));
  const pin = (audio: Ref): Ref => g.out("SetLatentNoiseMask", { samples: audio, mask });
  return { sound: pin(laid), pin, carried: Boolean(before) };
}

/**
 * LTX 2.5's join decoded as one piece with the clip before (card #40): its first own frames brought to the colours the clip
 * before was last seen in, then let go over a second. Two decodes meet there and 2.5's decoder tells them apart where 2.3's
 * does not (#85's chains, 2026-10-25): the clip before's last token, decoded at its latent's end, drifted from the seam's view
 * of the same token (ΔE up to 0.5 on the last frame, the frames before it within 0.05); and the seam's own frames come from a
 * temporal tile (2.5's 64 frames, 16 shared) begun two tokens before them, still settling. A step of ΔE 1.1 to 1.9 at the
 * join against 0.16 to 0.8 inside a clip; 2.3's, decoded whole, 0.2. One transform (ColorTransfer, Lab mean and spread)
 * takes the first own frame to the clip before's last as filed (the run-up as handed over, its last frame); it is laid at
 * full strength on the first quarter second, then three quarters, half and a quarter. On #85's takes, done on the CPU,
 * the join's ΔE came to 0.35 to 0.61, no frame-to-frame change above 0.49; on 2.3's it went up a little (0.2 to 0.26), so
 * 2.3 does without. Not when the chain's colour match is carried on (`previous.look`: colourCarried brings every frame to
 * that frame already), nor without the nodes.
 */
function seamColour(g: GraphBuilder, ctx: BuildContext, images: Ref, previous: Ref, head: number, frames: number, fps: number): Ref {
  const own = frames - head;
  const chunk = Math.max(1, Math.round((SEAM_COLOUR_S * fps) / SEAM_COLOUR_STEPS));
  const span = chunk * SEAM_COLOUR_STEPS;
  if (head < 1 || own < span || ctx.uploads["previous.look"] || !SEAM_COLOUR_NODES.every((n) => ctx.has(n))) return images;
  const part = (from: Ref, at: number, length: number): Ref => g.out("ImageFromBatch", { image: from, batch_index: at, length });
  const brought = g.out("ColorTransfer", { image_target: part(images, head, span), image_ref: part(previous, head - 1, 1), method: "reinhard_lab", source_stats: "target_frame", "source_stats.target_index": 0, strength: 1 });
  let out = part(images, 0, head);
  for (let i = 0; i < SEAM_COLOUR_STEPS; i++) {
    const strength = (SEAM_COLOUR_STEPS - i) / SEAM_COLOUR_STEPS;
    const piece = strength === 1 ? part(brought, 0, chunk) : g.out("ImageBlend", { image1: part(images, head + i * chunk, chunk), image2: part(brought, i * chunk, chunk), blend_factor: strength, blend_mode: "normal" });
    out = g.out("ImageBatch", { image1: out, image2: piece });
  }
  return own > span ? g.out("ImageBatch", { image1: out, image2: part(images, head + span, own - span) }) : out;
}
/**
 * LTX 2.5's landing (card #115): the last second the clip shows brought to the colours the clip after opens on, the mirror
 * of seamColour. On the 0.7.1 pod check, a 2.5 clip landed on a 2.5 take ended about four grey levels darker than that take
 * began (ΔE 1.54 at the cut, its tail never taking the guide's colours); 2.3's, on 2.3's take, 0.6. One transform (ColorTransfer,
 * Lab mean and spread) takes the last shown frame to the clip after's first as handed over; it is laid at full strength on
 * the last quarter second before the cut, then three quarters, half and a quarter going back, and on the hidden tail, so
 * that the file has no step where the timeline cuts. Done on the CPU on that take: ΔE 1.54 to 0.15, no frame-to-frame
 * change larger than without it (0.51 against 0.50). `shown`: the frames the timeline plays, the tail after them.
 */
function landColour(g: GraphBuilder, ctx: BuildContext, images: Ref, next: Ref, shown: number, frames: number, fps: number): Ref {
  const chunk = Math.max(1, Math.round((SEAM_COLOUR_S * fps) / SEAM_COLOUR_STEPS));
  const span = chunk * SEAM_COLOUR_STEPS;
  const tail = frames - shown;
  if (tail < 1 || shown < span || !SEAM_COLOUR_NODES.every((n) => ctx.has(n))) return images;
  const part = (from: Ref, at: number, length: number): Ref => g.out("ImageFromBatch", { image: from, batch_index: at, length });
  const from = shown - span;
  const brought = g.out("ColorTransfer", { image_target: part(images, from, span + tail), image_ref: part(next, 0, 1), method: "reinhard_lab", source_stats: "target_frame", "source_stats.target_index": span - 1, strength: 1 });
  let out = part(images, 0, from);
  for (let i = 0; i < SEAM_COLOUR_STEPS; i++) {
    const strength = (i + 1) / SEAM_COLOUR_STEPS;
    // the last piece at full strength runs on through the hidden tail
    const piece = strength === 1 ? part(brought, i * chunk, chunk + tail) : g.out("ImageBlend", { image1: part(images, from + i * chunk, chunk), image2: part(brought, i * chunk, chunk), blend_factor: strength, blend_mode: "normal" });
    out = g.out("ImageBatch", { image1: out, image2: piece });
  }
  return out;
}
const SEAM_COLOUR_S = 1;
const SEAM_COLOUR_STEPS = 4;
const SEAM_COLOUR_NODES = ["ImageFromBatch", "ColorTransfer", "ImageBlend", "ImageBatch"];

/** The nodes Video with audio's cues add: the parts loaded and fitted, laid into a silence, encoded and pinned; mixed over a recording in the take. */
const CUED_SOUND_NODES = ["LoadAudio", "TrimAudioDuration", "EmptyAudio", "AudioConcat", "LTXVAudioVAEEncode", "LatentCompositeMasked", "SolidMask", "MaskComposite", "SetLatentNoiseMask"];

/** Said after the scene on Lip sync, as on H3's: what the recording is, so that the person in the picture says it. */
const SPEAKS = "The person speaks throughout, the lips moving with every word.";

/**
 * Said last on a clip that carries on from the one before: LTX 2.5 can cut to an insert shot right after the head, the
 * thing a line names in place of the person saying it (card #87: a flooded palace for 2 s after a line naming the tide).
 * Positive words only, as the text encoder reads a negation as the thing named. On the person of the reference pictures
 * by their number when there is one, else on the person speaking (Lip sync), else on the scene the head shows.
 */
const oneShot = (refs: MsrRefs | null, lipSync: boolean | undefined): string => {
  const person = refs ? refs.numbered.findIndex((r) => r.role === "person") : -1;
  const on = person >= 0 ? `the person in Image ${person + 1}` : lipSync ? "the person" : "the same scene";
  return `One continuous shot, the camera stays on ${on}.`;
};

/** Lip sync's moment before the words, as H3's Lip sync has it. */
const speechAt: InputSpec = {
  id: "speechAt", type: "number", label: "Speech starts at", min: 0, max: 3, step: 0.25, default: 0, unit: " s", showWhen: "recording", advanced: true,
  note: "a moment of the clip before the words begin, counted after the frames of the clip before",
};

/**
 * The form's inputs: Video with audio's, with the recording's inputs a timeline sets on a clip under a recording (internal:
 * the recording plays over it), after Duration; on Lip sync, the scene in place of the prompt, the recording drawn after it,
 * and no Duration: the part's length decides it.
 */
function formInputs(spec: LtxSpec, inputs: InputSpec[]): InputSpec[] {
  const fit = ltxRecording(spec.fps);
  return inputs.flatMap((i): InputSpec[] => {
    if (i.id === "seconds") return spec.lipSync ? [] : [i, ...recordingInputs({ shown: false, fit, note: `the recording the clip is under: its part is the clip's sound, laid over ${spec.name}'s own` })];
    // Lip sync's cues after the keyframe's moment, where H3's forms have theirs
    if (i.id === "midAt") return [i, ...ltxCues(spec)];
    if (i.id === "prompt" && spec.lipSync && i.type === "prompt") {
      return [
        { ...i, label: "What happens", placeholder: "A medium close-up. A man at a café terrace talks to the camera, calm and friendly, his eyebrows lifting between phrases.", note: "where they are and how they speak, without a dialogue line: the recording is what is said, and the clip's whole sound" },
        ...recordingInputs({
          shown: true, less: [speechAt], fit,
          note: `what is said: the clip is made around it, its sound from the first step, so the mouth follows it, and it is the clip's sound. One clip holds about ${(fit.frames / fit.fps - fit.pad!).toFixed(1)} seconds (less the moment before the words, and the frames of the clips it joins); the part's ends snap to the pauses so that no word is cut`,
        }),
      ];
    }
    return [i];
  });
}

/** The recipe of a version of LTX, from its spec. */
export function ltxRecipe(spec: LtxSpec): Recipe<LtxVideo> {
  const { fps } = spec;
  return defineRecipe<LtxVideo>({
    // RIFE when the frames are interpolated with it: asked for, or Auto without LTX's temporal upscaler (or with SeedVR2,
    // which takes RIFE after it), as the build below picks. The temporal upscaler when it is asked for by name (Auto does
    // without it), and SeedVR2's files for its upscale: the build refuses either missing. Asked by name, the temporal file is
    // there or the build refuses, so it counts as there
    needsWith: (input, slots = {}, where = {}) => {
      // a clip that carries on may do so in the latent, which takes RIFE (latentRifeSaid): its files too; and so does one the
      // clip after carries on in, which the timeline says. That one is known: it is sent no temporal file it would not use
      const temporal = doublesInLatent(input, input.smoothWith === SMOOTH_LTX || Boolean(slots.temporal)) && !inLatentChain(input, Boolean(input.previous));
      return [
        ...rifeNeeds(input.smooth && !temporal),
        ...(input.smooth && input.smoothWith === SMOOTH_LTX && !input.latentAfter ? ["temporal"] : []),
        ...upscaleNeeds(input),
        // the distilled LoRA for a model that is not distilled: a pod is sent it, a machine of the user's own renders without it
        // (said on the job). Asked as the build loads it: the form's model, else the family's found on that machine
        ...(where.own !== true && !modelOf(spec, input, slots).distilled ? ["turbo"] : []),
        // the MSR LoRA for the cast's pictures or voice: a pod is sent it, a machine of the user's own renders without (SOFT_SLOTS)
        ...(spec.references && (input.references?.length || (!spec.lipSync && input.voice)) ? ["msr"] : []),
        // Face refine's files (H3's, its text encoder and VAEs too), with a picture of the person to refine towards; none when
        // the temporal upscaler doubles the frames, which leaves the pass out (some 38 GB a pod would fetch for nothing)
        ...(spec.faceRefine && !temporal ? faceRefineNeeds(input, { own: true, picture: Boolean(input.start && !input.previous) }) : []),
      ];
    },
    id: spec.id,
    family: spec.family,
    version: 1,
    title: spec.title,
    summary: spec.summary,
    output: "video",
    traits: {
      startFrame: true, endFrame: true, midFrames: true, continues: "clip", endAnchor: true, sound: true,
      latentNodes: LTX_CONTINUATION_NODES, latentTrim: LTX_TRIM, latentAfter: "latentAfter",
      fps, frameGrid: { step: 8, offset: 1 },
      // H3's Face refine on its own frames: a finish of a take redraws the take's frames (its kept latent is LTX's, not H3's)
      ...(spec.faceRefine ? { faceRefine: "faceRefine" } : {}),
    },
    inputs: formInputs(spec, [
      {
        id: "model", type: "model", label: "Model", folder: "diffusion_models", slot: "unet", match: spec.modelMatch,
        note: spec.loader === "checkpoint" ? "a diffusion model in a file of its own (a fine-tune, usually). Left alone with none there, the one checkpoint is used" : "the diffusion model: the distilled one, or a fine-tune of it",
      },
      {
        id: "prompt", type: "prompt", label: "Prompt", style: "sentences",
        placeholder: "A medium close-up. She turns to the camera and says quietly: \"What a view.\" Wind, and waves far below.",
      },
      { id: "start", type: "image", role: "start", label: "First frame", note: "the first frame", optional: true },
      {
        id: "previous", type: "clip", role: "previous", label: "Previous clip", optional: true, frames: LTX_JOIN_FRAMES, framesFrom: "context", fps, advanced: true, look: "matched",
        note: "the clip this one carries on from: its last frames (a second, by default) open this clip as a guide, its sound under them, so that the motion and the sound carry over, not only the last picture. On a timeline those frames are hidden, the clip plays from its own. A first frame is not used with it",
      },
      {
        id: "context", type: "choice", label: "Frames from the clip before", options: [...LTX_RUN_UPS], default: "41", showWhen: "previous", advanced: true, section: "rare",
        note: "pinned at the start as the run-up: 9 is a position, 25 brings its motion and voice too, 41 a long run-in. When the join jumps, try another count",
      },
      {
        id: "next", type: "clip", role: "next", label: "Next clip", optional: true, frames: LTX_JOIN_FRAMES, fps, advanced: true, framesOnly: true,
        note: "this clip ends exactly where that one begins: its first second (25 frames) guides this clip's last ones. A clip after shorter than a second gives only 9: the landing is looser, and the cut can show a small reframe. Not used with a last frame",
      },
      { id: "end", type: "image", role: "end", label: "Last frame", note: "the last frame. With one, the clip is made in one pass at full size", optional: true },
      { id: "mid", type: "image", role: "mid", at: "midAt", label: "Keyframe", note: "a picture the clip passes through, at the time set below", optional: true, advanced: true },
      { id: "midAt", type: "number", label: "Keyframe at", min: 0.5, max: 19.5, step: 0.5, default: 2.5, unit: " s", showWhen: "mid", advanced: true, note: "snapped to the model's 8-frame steps (about a third of a second)" },
      // Lip sync takes the pictures, not a voice: the recording is the voice, as on H3's Lip sync
      ...(spec.references ? MSR_INPUTS.filter((i) => !spec.lipSync || !i.id.startsWith("voice")) : [FACE_PHOTO]),
      { id: "seconds", type: "number", label: "Duration", min: 1, max: 20, step: 0.5, default: 5, unit: " s" },
      {
        id: "shape", type: "size", label: "Aspect ratio", default: "wide", grid: 64, min: 256, max: 1920, ratioOnly: true,
        short: "short", maxPixels: LTX_MAX_PIXELS, decidedBy: ["start", "end", "mid"], scaledBy: { on: "upscale", by: "upscaleBy" },
        note: "a start image decides the shape instead",
        shapes: [
          { id: "tall", label: "Tall", width: 704, height: 1280 },
          { id: "square", label: "Square", width: 960, height: 960 },
          { id: "wide", label: "Wide", width: 1280, height: 704 },
        ],
      },
      { id: "short", type: "number", label: "Resolution", note: "the short side of the frame: 704 is about 720p, 1088 about 1080p. Larger is sharper and much slower", min: 384, max: 1088, step: 64, default: 704, unit: "p", picks: [512, 704, 832, 1088] },
      ...upscaleInputs(),
      ...COLOUR_MATCH_INPUTS,
      ...(spec.faceRefine ? FACE_REFINE_TAKE_INPUTS : []),
      {
        id: "twoPass", type: "toggle", label: "Two-pass (latent upscale)", default: true, advanced: true,
        note: "half the size first, enlarged with the latent upscaler, then 3 steps that refine: faster and sharper. Off, or without the upscaler, or with an end image: one pass at full size. A keyframe guides both passes",
      },
      {
        id: "refineStrength", type: "number", label: "Refine denoise", min: 0.3, max: 1, step: 0.05, default: 0.85, showWhen: "twoPass", advanced: true,
        note: "where the refining pass starts: 0.85 is LTX's own. Lower keeps the enlarged clip closer to the first pass, higher lets it change more",
      },
      { id: "refineSteps", type: "number", label: "Refine steps", note: "3 is LTX's own; left at 3, a clip past 241 frames (9.6 s) takes 4, which users find the enlarged clip needs. Another count is taken as typed", min: 1, max: 8, step: 1, default: 3, showWhen: "twoPass", advanced: true },
      {
        id: "turboIn", type: "choice", label: "Distilled model", options: ["From the name", "Yes", "No"], renamed: { Auto: "From the name" }, default: "From the name", advanced: true, section: "rare", perModel: true,
        note: "made for 8 steps as it is: no distilled LoRA is added. From the name: when it says distilled, turbo, lightning or a step count",
      },
      {
        id: "schedule", type: "choice", label: "Schedule", options: [OWN_SCHEDULE, BY_STEPS], default: OWN_SCHEDULE, advanced: true, perModel: true,
        note: "LTX's own is the 8 steps its authors give for the distilled model. By steps: LTX's scheduler at a number of steps, for the full (dev) model, which ComfyUI's template runs at 20 steps and CFG 4, the distilled LoRA refining only",
      },
      { id: "steps", type: "number", label: "Steps", note: "20 in ComfyUI's template for the dev model", min: 2, max: 50, step: 1, default: 20, showWhen: { input: "schedule", in: [BY_STEPS] }, advanced: true, perModel: true },
      {
        id: "maxShift", type: "number", label: "Max shift", min: 0, max: 10, step: 0.05, default: 2.05, showWhen: { input: "schedule", in: [BY_STEPS] }, advanced: true, perModel: true,
        note: "LTX's scheduler shifts its schedule by the size of the clip, between the base shift (small clips) and this (large ones): 2.05 and 0.95 are the model's own",
      },
      { id: "baseShift", type: "number", label: "Base shift", min: 0, max: 10, step: 0.05, default: 0.95, showWhen: { input: "schedule", in: [BY_STEPS] }, advanced: true, perModel: true },
      { id: "terminal", type: "number", label: "Terminal sigma", note: "where the schedule ends: 0.1 is the model's own; lower runs it further towards a clean clip", min: 0, max: 0.99, step: 0.01, default: 0.1, showWhen: { input: "schedule", in: [BY_STEPS] }, advanced: true, perModel: true },
      { id: "stretch", type: "toggle", label: "Stretch the schedule", note: "the schedule stretched so that it ends at the terminal sigma, as the model's own does", default: true, showWhen: { input: "schedule", in: [BY_STEPS] }, advanced: true, perModel: true },
      {
        id: "cfg", type: "number", label: "CFG scale", min: 1, max: 10, step: 0.5, default: 1, advanced: true, perModel: true,
        note: spec.guider === "dual"
          ? "1 for the distilled model and LTX's own schedule, on the picture and the sound alike (the model's dual guider); 3 to 4 with By steps on the dev model. Above 1 the negative prompt acts and every step takes twice as long"
          : "1 for a distilled model and LTX's own schedule; 3 to 4 with By steps on the dev model (ComfyUI's template: 4). Above 1 the negative prompt acts and every step takes twice as long",
      },
      { id: "sampler", type: "choice", label: "Sampler", options: { node: "KSamplerSelect", input: "sampler_name" }, default: spec.sampler, advanced: true, perModel: true, note: `${spec.sampler} is what ${spec.name}'s own template runs` },
      {
        id: "negative", type: "prompt", label: "Negative prompt", style: "sentences", optional: true, advanced: true, perModel: true,
        default: "blurry, out of focus, overexposed, underexposed, low contrast, washed out colors, pc game, console game, video game, cartoon, childish, ugly",
        note: spec.nag ? "acts with a CFG scale above 1, or at 1 through NAG" : "acts with a CFG scale above 1",
      },
      ...(spec.nag
        ? [
            {
              id: "nag", type: "toggle", label: "NAG", default: false, advanced: true, perModel: true,
              note: "Normalized Attention Guidance: the negative prompt acts at CFG 1, where it is otherwise ignored, at little cost. Needs KJNodes. Off by default: untried on LTX by its authors",
            } as const,
            { id: "nagScale", type: "number", label: "NAG scale", min: 1, max: 30, step: 0.5, default: 11, showWhen: "nag", advanced: true, perModel: true, note: "how hard the negative pushes: 11 is its authors' value" } as const,
          ]
        : []),
      ...(spec.references ? MSR_STRENGTHS : []),
      { id: "startStrength", type: "number", label: "First frame strength", min: 0.1, max: 1, step: 0.05, default: 0.7, showWhen: "start", advanced: true, note: "lower lets the first frames move away from the picture sooner" },
      { id: "endStrength", type: "number", label: "Last frame strength", min: 0.1, max: 1, step: 0.05, default: 0.7, showWhen: "end", advanced: true },
      {
        id: "midStrength", type: "number", label: "Keyframe strength", min: 0.1, max: 1, step: 0.05, default: 0.8, showWhen: "mid", advanced: true,
        note: "how closely the clip holds the keyframe at its moment: lower lets it pass near the picture rather than through it",
      },
      {
        id: "compression", type: "number", label: "Input CRF", min: 0, max: 50, step: 1, default: 18, advanced: true,
        note: "the start, keyframe and end pictures are compressed like a video frame before the model sees them: a picture that is too clean gives a clip that does not move. 0 leaves them as they are",
      },
      {
        id: "loraStrength", type: "number", label: "Distilled LoRA strength", min: 0, max: 1.5, step: 0.05, default: 0.5, advanced: true, perModel: true,
        note: "only for a model that is not distilled: how strongly the distilled LoRA is put on it. 0.5 is what ComfyUI's template uses with LTX's own schedule; with By steps the LoRA refines only, at 1 in the template",
      },
      { id: "tile", type: "number", label: "VAE decode tile size", note: `the clip is turned into pictures piece by piece: smaller pieces need less memory and take longer. ${spec.decode.tile} is the template's`, min: 256, max: 2048, step: 32, default: spec.decode.tile, unit: " px", advanced: true },
      { id: "tileFrames", type: "number", label: "VAE decode temporal tile", note: `fewer needs less memory. 4096 is all of them at once; ${spec.decode.frames} is the template's`, min: 16, max: 4096, step: 8, default: spec.decode.frames, advanced: true },
      { id: "crf", type: "number", label: "CRF", note: "how hard the video file is compressed: lower is better and larger. 19 looks lossless, 23 is the usual quality of the web", min: 0, max: 40, step: 1, default: 19, advanced: true },
      {
        id: "livePreview", type: "toggle", label: "Live preview (animated)", default: true, advanced: true,
        note: "while it renders, a short clip of what is forming, each step, without its sound. Without it the preview is one still frame: the start image. A small cost per step. Needs the KJNodes pack",
      },
      ...SPEED_INPUTS,
      { id: "smooth", type: "toggle", label: "Interpolate ×2", note: `frame interpolation, from ${fps} to ${fps * 2} frames a second: with LTX's own temporal upscaler in latent space when its file is there (motion-aware, then a short refine), else RIFE on the pixels`, default: false, advanced: true },
      {
        id: "smoothWith", type: "choice", label: "Interpolate with", options: [SMOOTH_AUTO, SMOOTH_LTX, SMOOTH_RIFE], default: SMOOTH_AUTO, showWhen: "smooth", advanced: true,
        note: "Auto takes LTX's temporal upscaler when its file is there, else RIFE. The temporal upscaler doubles the latent's frames and a 2-step pass settles them: experimental, the refine after it is not Lightricks' published setting. A clip that carries on in the clip before's latent always takes RIFE, and so does the clip before it: the settle pass remakes their frames at the join, which then jumps",
      },
      // set by a timeline on every clip, never drawn: whether the clip after carries on in this clip's latent (TimelinePlan.plan)
      { id: "latentAfter", type: "toggle", label: "The clip after carries on in this clip's latent", default: false, internal: true },
      { id: "loras", type: "loras", label: "LoRAs", max: 6 },
      { id: "seed", type: "seed", label: "Seed" },
    ]),

    nodes(input) {
      const routeNodes = upscaleNodes(input);
      return [
        ...routeNodes,
        "CLIPTextEncode", "LTXVConditioning", "EmptyLTXVLatentVideo", "LTXVEmptyLatentAudio", "LTXVConcatAVLatent", "LTXVSeparateAVLatent",
        "RandomNoise", "KSamplerSelect", spec.guider === "dual" ? "LTXVDualCFGGuider" : "CFGGuider", "SamplerCustomAdvanced", "VAEDecodeTiled", ...speedNodes(input),
        // Lip sync's sound is the recording, pinned from the first step: none is decoded. Under a recording, its part is cut
        ...(spec.lipSync ? PINNED_SOUND_NODES : ["LTXVAudioVAEDecode"]),
        ...(input.recording ? recordingNodes({ joined: false }) : []),
        // Lip sync's cues: each part loaded and fitted, then added over the recording on its own stretch
        ...(spec.lipSync && input.cues?.length ? ["LoadAudio", "TrimAudioDuration", "AudioMerge", "AudioConcat"] : []),
        // Video with audio's: pinned in the clip's own sound, mixed over a recording that plays over it in the take
        ...(!spec.lipSync && input.cues?.length ? [...CUED_SOUND_NODES, ...(input.recording ? ["AudioMerge"] : [])] : []),
        ...(input.model ? unetNodes(input.model).filter((n) => n !== "UNETLoader") : []),
        ...(spec.loader === "split" ? ["UNETLoader", "CLIPLoader", "VAELoader"] : []),
        ...(input.schedule === BY_STEPS ? ["LTXVScheduler"] : []),
        ...((input.start && !input.previous) || input.end || input.mid ? ["LoadImage", "ImageScale", "LTXVPreprocess"] : []),
        ...(input.previous || input.next ? ["LoadVideo", "GetVideoComponents", "ImageScale", "LTXVPreprocess"] : []),
        // Face refine: H3's nodes, the clip's 8n + 1 frames made up to H3's grid and cut back (not with the temporal upscaler
        // asked for by name: the pass is left out at 48 a second). Auto's choice hangs on files this list is not given: asked
        ...(spec.faceRefine && input.faceRefine && !(doublesInLatent(input, input.smoothWith === SMOOTH_LTX) && !inLatentChain(input, Boolean(input.previous))) ? [...FACE_REFINE_H3, "BasicScheduler", "VAEDecode", "CLIPLoader", "VAELoader", "ImageFromBatch", "ImageBatch", "RepeatImageBatch"] : []),
      ];
    },
    // which loaders, and which way the clip is made, depend on the files this ComfyUI has
    optionalNodes: [...UPSCALE_OPTIONAL, VHS, ...CORE_VIDEO_OUT, ...COLOUR_MATCH_NODES,
      // 2.3's loaders depend on which files are there (one checkpoint, or split files); 2.5's are always its split files' (nodes)
      ...(spec.loader === "checkpoint" ? ["UNETLoader", "DualCLIPLoader", "VAELoader", "CheckpointLoaderSimple", "LTXVAudioVAELoader", "LTXAVTextEncoderLoader"] : []),
      "LoraLoaderModelOnly",
      "LatentUpscaleModelLoader", "LTXVLatentUpsampler", "LTXVImgToVideoInplace", "LTXVAddGuide", "LTXVCropGuides", "ManualSigmas",
      "FrameInterpolationModelLoader", "FrameInterpolate", "ModelPreviewOverrideKJ", ...(spec.nag ? ["LTX2_NAG"] : []),
      // the head's sound pinned when the nodes are there (Lip sync needs them all: in its nodes); 2.3's silences filled first
      ...(spec.lipSync ? [] : HEAD_SOUND_NODES), ...(spec.roomTone ? [ROOM_TONE] : []),
      LTX_SAVE_LATENT, ...LTX_CONTINUATION_NODES, LTX_TRIM, ...LTX_LATENT_CORE,
      // the cast's pictures and voice, when the MSR LoRA and its pack are there (msrOf)
      ...(spec.references ? [...MSR_NODES, FACE_FRAME, FACE_CROP, FACE_BACKDROP, "ImageScale",...(spec.lipSync ? [] : ["LoadAudio"])] : []),
      // the clip before's last frame as it was filed, loaded when the server sends it (its chain was colour-matched: colourCarried)
      "LoadImage",
      // 2.5: a seam's first own frames brought to the clip before's last as filed, then let go (seamColour); a landing's last
      // shown second to the clip after's first frame (landColour)
      ...(spec.seamColour ? SEAM_COLOUR_NODES : []),
      // under a recording: what goes before its part (the clip before's sound under the head, silence before the words)
      "AudioConcat", "AudioAdjustVolume",
      // the face along the take against its person's picture; Face refine's pack, done without when missing
      FACE_NODE, ...(spec.faceRefine ? FACE_REFINE_OPTIONAL : []),
    ],

    build(input, ctx) {
      const { slots, media } = ctx;
      const picked = modelOf(spec, input, slots, ctx.options?.("UNETLoader", "unet_name"));
      const how = uses(input, slots);
      if (!picked.unet && !picked.checkpoint) throw new Error(spec.missing.model);
      if (picked.unet && (!slots.videoVae || !slots.audioVae || (spec.loader === "checkpoint" && !slots.projection))) throw new Error(spec.missing.parts);

      // the frame: a timeline's canvas, else the clip it carries on from, else the picture it opens or ends on (or its keyframe,
      // when it has no other), else the shape picked. A canvas is taken at its own size up to the model's 720p (LTX_CANVAS_SHORT),
      // as Wan's is up to its 720p: a clip at a 1080p timeline's size was 1088p, slower and no better (users put LTX's sweet spot
      // at 720p; the owner, 2026-10-15)
      const opens = Boolean(input.start) && !input.previous;
      // the clip after is landed on, unless the clip ends on a last picture of its own, which would guide the same frames
      const lands = Boolean(input.next) && !input.end;
      const like = input.previous ? media.previous : lands ? media.next : opens ? media.start : input.end ? media.end : input.mid ? media.mid : undefined;
      const head = input.previous ? joinFramesOf(media.previous, "previous") : 0;
      // carried on in the clip before's own latent: made at that latent's size, whatever the canvas (its tokens are pinned as they are)
      const joined = latentJoinOf(ctx, input, head, how.twoPass);
      const kept = "file" in joined ? joined : null;
      const { width, height } = kept
        ? kept.size
        : ctx.canvas
          ? ltxCanvas(ctx.canvas.width, ctx.canvas.height, Math.min(ctx.canvas.width, ctx.canvas.height, LTX_CANVAS_SHORT))
          : like?.width
            ? ltxCanvas(like.width, like.height, input.short)
            : ltxCanvas(input.shape.width, input.shape.height, input.short);
      // the frames shared with the clips before and after are theirs: the clip is made that much longer, within the 20 s the model takes
      // (the frames ComfyUI lands on: one fewer than handed over, see guided)
      const tail = lands ? joinFramesOf(media.next, "next") - 1 : 0;
      // under a recording (card #2): the clip lasts as long as its part (Lip sync's moment before the words and the pad after
      // them in it), brought down to the model's 8n + 1 frames with those of the clips it joins: the pad outlasts that step
      const lead = spec.lipSync ? Math.round((input.speechAt ?? 0) * fps) : 0;
      const laid = input.recording ? recordingOnClip({ recordingSeconds: input.recordingSeconds ?? 0 }, ctx, lead, ltxRecording(fps)) : null;
      const frames = laid
        ? gridAtOrBefore(Math.max(9, head + tail + Math.round(laid.seconds * fps)), { step: 8, offset: 1 })
        : ltxFramesAt(Math.min(input.seconds, LTX_MAX_SECONDS - (head + tail) / fps) + (head + tail) / fps, fps);

      const g = new GraphBuilder();
      // a latent sent and not taken: the join falls back to frames, a visible step, said on the job
      const warnings: string[] = "why" in joined && joined.why ? [joined.why] : [];
      const refs = spec.references ? msrOf(input, ctx, warnings, !spec.lipSync, { width, height }) : null;
      const held = refs ? msrHeld(input, slots.msr, warnings) : null;
      const loaded = ltxLoad(spec, g, ctx, input, picked, held);
      const byHand = input.schedule !== BY_STEPS;
      // a dev model without its distilled LoRA still renders, but less well than asked: said on the job, never silently
      if (!picked.distilled && !loaded.lora) warnings.push(`${spec.name}'s distilled LoRA is not on this ComfyUI: the dev model ${byHand ? "renders LTX's 8 steps" : "refines"} without it (models/loras; Settings › Models has it). A distilled model needs none: Distilled model › Yes.`);
      const steps = byHand ? LTX_SIGMAS.split(",").length - 1 : input.steps;
      // Lip sync: the scene, then that the person speaks (the recording is what is said); a clip that carries on: that the shot does
      const after = [spec.lipSync ? SPEAKS : "", input.previous ? oneShot(refs, spec.lipSync) : ""].filter(Boolean);
      const text = after.length ? [input.prompt.trim(), ...after].filter(Boolean).join(" ") : input.prompt;
      const cond = g.add("LTXVConditioning", {
        // what each reference picture is, by its number, before the user's words (the LoRA's authors' way of writing it)
        positive: g.out("CLIPTextEncode", { clip: loaded.clip, text: refs ? `${refs.legend}\n\n${text}` : text }),
        negative: g.out("CLIPTextEncode", { clip: loaded.clip, text: input.negative }),
        frame_rate: fps,
      });
      // At CFG 1 the negative prompt is never read. NAG (KJNodes' LTX2_NAG, its authors' alpha and tau) puts it back
      // inside the attention, on every model the passes sample with. Off by default: one tester found it still let
      // text overlays through on dialogue-heavy prompts, and nothing LTX-specific has been published for it.
      if (spec.nag && input.nag && input.cfg <= 1 && input.negative.trim() !== "" && ctx.has("LTX2_NAG")) {
        const nag = (model: Ref): Ref => g.out("LTX2_NAG", { model, nag_scale: input.nagScale, nag_alpha: 0.25, nag_tau: 2.5, nag_cond_video: [cond, 1], inplace: true });
        const same = loaded.first === loaded.model;
        loaded.model = nag(loaded.model);
        loaded.first = same ? loaded.model : nag(loaded.first);
      }
      // the clip before's last frames and the clip after's first, as handed over (cut by the server to LTX_JOIN_FRAMES at the model's rate)
      const clipOf = (upload: string | undefined): Ref => [g.add("GetVideoComponents", { video: g.out("LoadVideo", { file: upload }) }), 0];
      const previous = input.previous ? clipOf(ctx.uploads.previous) : null;
      // the clip before's own latent (cut to its hand-over frame), its last tokens and the sound under them (AfflatusLTXContinuation);
      // else its frames, its sound encoded from them (headSound)
      const loadedBefore: Ref | null = kept ? [g.add("AfflatusLoadLTXLatent", { latent: kept.file }), 0] : null;
      const before: Ref | null = kept && loadedBefore ? (kept.cut ? [g.add(LTX_TRIM, { samples: loadedBefore, frames: kept.cut }), 0] : loadedBefore) : null;
      const continued = before
        ? g.add("AfflatusLTXContinuation", {
            previous_av_latent: before,
            audio_latent: g.out("LTXVEmptyLatentAudio", { frames_number: frames, frame_rate: fps, batch_size: 1, audio_vae: loaded.audioVae }),
            overlap_frames: head,
          })
        : null;
      // Lip sync: the whole sound pinned, the recording's part after the head and the moment before the words (the clip
      // before's sound under the head, taken from its file even when its latent carries the picture on; silence before the
      // words; the recording through both where the clip before sang up to the part). Else the head's sound alone, when the
      // clip carries on from one with sound: from its latent, else encoded from its frames
      const at = { head, frames };
      // the cues, in the clip's own time after the head: Lip sync's added over the recording (card #71's way over a recording:
      // on each cue's own stretch) and held with it; Video with audio's held in a sound of their own (cuedSound)
      const cues = cuesFor(g, ctx, input.cues, { head, tail, frames, fps });
      const heardBefore = (spec.lipSync || cues) && previous && head > 0 && media.previous?.hasSound !== false ? g.out("TrimAudioDuration", { audio: [previous[0], 1], start_index: 0, duration: head / fps }) : null;
      const ahead = (): Ref | null => {
        if (!laid || laid.sungThrough(at) || !heardBefore) return null;
        if (lead <= 0) return heardBefore;
        const quiet = g.out("TrimAudioDuration", { audio: g.out("AudioAdjustVolume", { audio: laid.whole(g), volume: -100 }), start_index: 0, duration: lead / fps });
        return g.out("AudioConcat", { audio1: heardBefore, audio2: quiet, direction: "after" });
      };
      const recorded = spec.lipSync && laid ? laid.sound(g, ahead(), at) : null;
      const wave = recorded && cues ? layCues(g, recorded, cues.placed, cues.parts, { frames, over: true, fps }) : recorded;
      // 2.3's silences filled before they are pinned (a clip carried on in the latent pins the clip before's sound as it was
      // sampled: a Lip sync clip made since has it filled)
      const tone = tonedFor(spec, g, ctx);
      if (spec.roomTone && spec.lipSync && wave && !ctx.has(ROOM_TONE)) warnings.push(`Stretches of exact silence in the sound were pinned as they are: this ComfyUI's Afflatus node pack has no Room Tone (0.41.0), and ${spec.name} can fade the picture to black over them. Settings › ComfyUI updates the pack.`);
      const carry = wave
        ? { ...pinnedSound(g, loaded.audioVae, wave, frames, fps, tone), carried: head > 0 && Boolean(heardBefore || laid!.sungThrough(at)) }
        : cues
          ? cuedSound(g, loaded.audioVae, heardBefore, cues, frames, head, fps, tone)
          : continued
            ? { sound: [continued, 1] as Ref, pin: (audio: Ref): Ref => g.out("SetLatentNoiseMask", { samples: audio, mask: [continued, 2] }), carried: true }
            : headSound(g, ctx, loaded.audioVae, previous, frames, head, fps, tone);
      const run: LtxRun = {
        spec, g, ctx, input, loaded, cond, steps, frame: { width, height, frames }, passes: [], head, opens, previous, tail,
        next: lands ? clipOf(ctx.uploads.next) : null,
        pin: carry.pin,
        latentGuide: continued ? [continued, 0] : null,
        msr: refs
          ? {
              pics: {
                ...Object.fromEntries(refs.numbered.map((r, i) => {
                  const pic = g.out("LoadImage", { image: r.upload });
                  if (r.role !== "person") return [`pic${i + 1}`, toFrame(g, pic, r.size, { width, height })];
                  // the node's own 2.5 face heights unless another size is asked (the graph of a form left alone as it was)
                  const sized = input.refFaceSize !== undefined && input.refFaceSize !== 2.5 ? { factor: input.refFaceSize } : {};
                  const cut = !refs.faceCrop ? pic : refs.faceCrop === FACE_FRAME ? g.out(FACE_FRAME, { image: pic, width, height, ...sized }) : g.out(FACE_CROP, { image: pic, ...sized });
                  // the rest blurred or grey once the picture is cut: the oval is laid at the size MSR is given
                  return [`pic${i + 1}`, refs.backdrop ? g.out(FACE_BACKDROP, { image: cut, backdrop: refs.backdrop }) : cut];
                })),
                ...(refs.background ? { background: toFrame(g, g.out("LoadImage", { image: refs.background.upload }), refs.background.size, { width, height }) } : {}),
              },
              voice: refs.voice ? g.out("LTXVAudioVAEEncode", { audio: g.out("LoadAudio", { audio: refs.voice }), audio_vae: loaded.audioVae }) : null,
            }
          : null,
        sampler: g.out("KSamplerSelect", { sampler_name: input.sampler }),
        sound: carry.sound,
        // By steps: LTX's own scheduler, shifted by the size of the latent it is given
        sigmas: (latent) => (byHand ? g.out("ManualSigmas", { sigmas: LTX_SIGMAS }) : g.out("LTXVScheduler", { steps, max_shift: input.maxShift, base_shift: input.baseShift, stretch: input.stretch, terminal: input.terminal, latent })),
      };
      const sampled = how.twoPass ? ltxTwoPass(run) : ltxOnePass(run);
      let made = sampled;

      // twice the frames: LTX's temporal upscaler doubles the latent's frames; else RIFE on the decoded pictures, as for a
      // clip on either side of a join in the latent (latentRifeSaid)
      const canTemporal = Boolean(slots.temporal) && ctx.has("LTXVLatentUpsampler") && ctx.has("LatentUpscaleModelLoader");
      const askedTemporal = input.smooth && input.smoothWith === SMOOTH_LTX;
      const chained = inLatentChain(input, Boolean(before));
      if (askedTemporal && chained) warnings.push(latentRifeSaid(before ? "before" : "after"));
      else if (askedTemporal && !canTemporal) throw new Error(`LTX's temporal upscaler was not found: put ${spec.temporalFile} in ComfyUI's models/latent_upscale_models folder (one click in Settings → Models), or interpolate with RIFE.`);
      const temporal = doublesInLatent(input, canTemporal) && !chained;
      if (temporal) made = ltxTemporal(run, made);
      g.phase("decoding");
      const decode = (samples: Ref): Ref => g.out("VAEDecodeTiled", { samples, vae: loaded.vae, tile_size: input.tile, overlap: 64, temporal_size: input.tileFrames, temporal_overlap: spec.decode.overlap });
      // carried on in the latent, at the model's rate: decoded as one piece with the clip before's own last tokens (its run-up and
      // a few before it), the frames of those few dropped, so that the join is the whole chain's decoded at once and the head
      // shows the clip before's real frames. Never doubled by the temporal upscaler (latentRifeSaid): RIFE comes after
      const context = kept ? Math.max(0, Math.min(SEAM_CONTEXT, ((kept.cut || kept.frames) - 1) / 8 + 1 - (head + 7) / 8)) : 0;
      const seam = before ? g.add("AfflatusLTXSeamLatent", { previous_av_latent: before, sampled: made.video, overlap_frames: head, context }) : null;
      const decodedFrames = seam ? g.out("ImageFromBatch", { image: decode([seam, 0]), batch_index: 8 * context, length: frames }) : decode(made.video);
      const images = seam && previous && spec.seamColour ? seamColour(g, ctx, decodedFrames, previous, head, frames, fps) : decodedFrames;
      // the take's sound: Lip sync's is the sound it was made to; one a recording plays over carries its part after the head
      // (card #72's rule: the model's own sound there is dropped); else the model's
      const decoded = wave ? null : g.out("LTXVAudioVAEDecode", { samples: made.audio, audio_vae: loaded.audioVae });
      // Video with audio's cues laid into it as the files (the model's own sound there is no longer offered: ltxCues): in place
      // of it, or added over the recording it plays under
      const theirs = (): Ref => {
        const own = laid ? laid.sound(g, decoded, at) : decoded!;
        return cues ? layCues(g, own, cues.placed, cues.parts, { frames, over: Boolean(laid), fps }) : own;
      };
      const heard = wave ?? theirs();
      // Face refine (2.5): H3's pass on the frames as decoded, before the colour match, an upscale or RIFE (whose in-between
      // frames are then made from the refined faces), the take's own sound held under them; towards the person's reference
      // picture, else the picture the clip opens on. Doubled by the temporal upscaler, the frames are at 48 a second, which
      // the pass cannot hold its sound to: left out, and said. The kept latent stays the sampled one: the clip after carries
      // on from it, and has its own faces refined when it asks for it
      // (read only where the form has them: 2.3's has no Face refine)
      const refining = Boolean(spec.faceRefine && input.faceRefine);
      const towards = opens ? ctx.uploads.start : undefined;
      const refineValues = refining
        ? { faceRefine: !temporal, faceRefineDenoise: input.faceRefineDenoise ?? 0.45, faceRefineSteps: input.faceRefineSteps ?? 4, references: input.references ?? [], subject: "", quick: true }
        : { faceRefine: false, faceRefineDenoise: 0, faceRefineSteps: 0, references: [], subject: "", quick: true };
      const faces = faceRefined(g, ctx, refineValues, images, { audio: heard, picture: towards, frames });
      if (faces.pass) run.passes.push(faces.pass);
      const facesSaid = [
        refining && temporal ? "Not face-refined: LTX's temporal upscaler doubled the frames to 48 a second, and Face refine runs at 24 (interpolate with RIFE to have both)." : null,
        faceRefineSkipped(refineValues, ctx, { picture: towards, own: true, audio: true }),
        faces.said,
      ].filter((x): x is string => Boolean(x));
      warnings.push(...facesSaid);
      // matched to the first frame (a clip that opens a chain), or carrying that match on (one that continues it: its head's last
      // frame is the clip before's last moment, brought to how that clip was filed). Doubled by the temporal upscaler (T tokens
      // to 2T - 1, so frame i is frame 2i), that frame and Colour Follow's rate are twice the model's
      const rate = temporal ? 2 * fps : fps;
      const matched = colourCarried(g, ctx, colourMatched(g, ctx, faces.images, openingStart(input), rate), temporal ? 2 * (head - 1) : head - 1, rate);
      // 2.5: landed on the clip after, its last shown second brought to that clip's first frame, last of all so that what is
      // filed meets it (landColour). Doubled, the clip's last shown frame is 2 (frames - tail - 1) of 2 frames - 1
      const looked = run.next && spec.seamColour
        ? landColour(g, ctx, matched, run.next, temporal ? 2 * (frames - tail) - 1 : frames - tail, temporal ? 2 * frames - 1 : frames, rate)
        : matched;
      const done = finishFrames(g, ctx, looked, input, { frame: { width, height }, rife: input.smooth && !temporal, fps, audio: heard, doubled: temporal });
      const unsmoothed = rifeSkippedSaid(input.smooth && !temporal, ctx);
      if (unsmoothed) warnings.push(unsmoothed);
      const keptLatent = ctx.has(LTX_SAVE_LATENT)
        ? g.add(LTX_SAVE_LATENT, { samples: g.out("LTXVConcatAVLatent", { video_latent: sampled.video, audio_latent: sampled.audio }), fps, filename_prefix: "Afflatus/ltx" })
        : null;

      return {
        ...(warnings.length ? { warnings } : {}),
        graph: g.graph,
        phases: g.phases,
        outputs: [
          { node: done.out, kind: "video", role: "result" },
          // the clip's own latent at the model's rate, kept beside it for the clips that carry on from it
          ...(keptLatent ? [{ node: keptLatent, kind: "video" as const, role: "latent" as const }] : []),
          // the face along the take against its person's picture (the cast's, else the picture it opens on): drift along a run of
          // clips is flagged on the timeline, as on H3's
          ...faceScore(g, ctx, faces.images, facePhotos(g, ctx, spec.references ? { references: input.references, opens } : { facePhoto: input.facePhoto, opens })),
        ],
        totalSteps: run.passes.reduce((n, p) => n + p.steps, 0),
        passes: run.passes,
        // a continuation counts its frames as an extension and an overlap: hidden on a timeline, faded over the clip before (a
        // join on pixels, as joinKindOf reads it, "carried" with the clip before's sound pinned under them). A landing likewise
        frames,
        // carried on in the latent: "seamless" when its join was decoded as one piece with the clip before, "latent" when not
        ...(head || tail
          ? { overlap: { headMs: Math.round((head / fps) * 1000), tailMs: Math.round((tail / fps) * 1000), ...(before ? { latent: true, ...(seam ? { seam: true } : {}) } : carry.carried ? { sound: true } : {}) } }
          : {}),
        loads: [
          ...done.loads,
          ...(picked.unet
            ? [`diffusion_models/${picked.unet}`, `text_encoders/${slots.clip}`, ...(spec.loader === "checkpoint" ? [`text_encoders/${slots.projection}`] : []), `vae/${slots.videoVae}`, `vae/${slots.audioVae}`]
            : [`checkpoints/${picked.checkpoint}`, `text_encoders/${slots.clip}`]),
          ...(how.twoPass ? [`latent_upscale_models/${slots.upscaler}`] : []),
          ...(temporal ? [`latent_upscale_models/${slots.temporal}`] : []),
          ...(loaded.lora ? [`loras/${loaded.lora}`] : []),
          ...(refs ? [`loras/${slots.msr}`] : []),
          ...loraLoads(held?.loras ?? input.loras),
          ...faces.loads,
        ],
      };
    },

    variants: spec.variants,
  });
}
