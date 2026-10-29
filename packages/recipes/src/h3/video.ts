import { FACE_NODE } from "../shared/face";
import { defineRecipe, GraphBuilder, latentUpscaleSize, OWN_MODEL, type BuildContext, type BuiltGraph, type Ref, type Variant } from "@afflatus/core";
import { H3_FPS, H3_GRID } from "./family";
import { UPSCALE, UPSCALE_OPTIONAL, upscaleNeeds, upscaleNodes } from "../video/upscale";
import { unetNodes } from "../shared/unet";
import { CORE_VIDEO_OUT, VHS } from "../shared/out";
import { COLOUR_MATCH_NODES, rifeNeeds, rifeSkippedSaid } from "../shared/finish";
import { conditionFor, type MorePicture } from "./condition";
import { cueMixNodes, cueNodes, cueOwnSoundSaid, cuesFor, guideCues, layCues, laysCues } from "./cue";
import { finish, H3_SAVE_LATENT } from "./finish";
import { FACE_REFINE_OPTIONAL, FACE_REFINE_PACK_NEEDED, FACE_REFINE_SLOTS, clipModelOf, faceRefineNeeds, faceRefineSkipped, openingPicture, type ClipModel } from "./faceRefine";
import { h3Inputs, type H3Video } from "./inputs";
import { recordingInputs, recordingNodes, recordingOnClip, type Recording } from "../shared/recording";
import { isH3Layout } from "./prompt";
import { H3_CONTINUATION_NODES, H3_HEAD_GUIDE, H3_LANDING, H3_SEAM, H3_TRIM, resolveJoin } from "./join";
import { H3_LATENT_ENLARGE_NODES, H3_LATENT_UPSCALE_NODES, latentUpscaleNeeds, latentUpscalePass, latentUpscaleRounds, plainResizeSaid } from "./latent-upscale";
import { AUTO_SAMPLER, H3_STARTS, loadH3Model, modelOf, namedFor, referenceNeeds, turboNeeds, uses, vedaNeeds } from "./model";

// the recipe's parts live beside it (inputs, join, condition, latent-upscale, finish); its input type is still had from here
export type { H3Video } from "./inputs";

export const h3Video = defineRecipe<H3Video & Partial<Recording>>({
  // Turbo's LoRA, the reference model for a clip with references, H3's latent upscaler for an upscale with it, RIFE with
  // "RIFE ×2" on, Face refine's files with it on
  needsWith: (input, slots) => [...turboNeeds(input, slots), ...referenceNeeds(input, slots), ...vedaNeeds(input, slots), ...latentUpscaleNeeds(input), ...upscaleNeeds(input), ...rifeNeeds(input.smooth), ...faceRefineNeeds(input, { picture: Boolean(input.start && !input.previous), clip: clipModelOf(input, slots) })],
  id: "h3.video",
  family: "h3",
  version: 2,
  title: "Video with audio",
  summary: "t2v, or i2v from a first and last frame, with reference images, or extending a previous clip. Audio included.",
  output: "video",
  traits: {
    startFrame: true, endFrame: true, midFrames: true, continues: "clip", endAnchor: true, sound: true,
    fps: H3_FPS, frameGrid: H3_GRID, latentTrim: H3_TRIM, latentNodes: [...H3_CONTINUATION_NODES, H3_SEAM], faceRefine: "faceRefine",
  },
  // a clip under a recording it plays over (card #72): its place in the recording, set by the timeline, never drawn
  inputs: [...h3Inputs, ...recordingInputs({ shown: false })],
  starts: H3_STARTS,
  // a distilled file (DaSiWa's …TurboV3) is made for few steps: it starts on Turbo, which runs them without a LoRA
  presets: [
    { match: "(^|[^0-9])4[ _-]?steps?([^a-z]|$)", values: { turboSteps: 4, shiftVideo: 6, shiftAudio: 3 }, note: "a 4-step file: 4 steps, shift 6 / 3" },
    // 8 / 4: what DaSiWa gives for his 8-step Turbo files (MiniMax's 12 / 3 are its LoRA's)
    { match: namedFor.turbo.source, values: { fast: true, turboSteps: 8, shiftVideo: 8, shiftAudio: 4 }, note: "a distilled file: Turbo, 8 steps without a LoRA, shift 8 / 4" },
  ],

  nodes(input) {
    const how = uses(input);
    const routeNodes = upscaleNodes(input);
    // (a picture to open on is pinned on the reference route: with references, or with a voice alone, B20)
    const guided = Boolean(input.previous || input.next || input.mid) || (how.start && how.reference);
    const picked = modelOf(input, {});
    // a turbo model that makes the clip itself takes no turbo LoRA; a Finish › Face refine loads no model of the clip's
    const turboLora = input.fast && !(picked.turbo && (!how.reference || picked.hybrid)) && !refinesOnly(input);
    return [
      ...routeNodes,
      ...(refinesOnly(input) ? ["UNETLoader"] : unetNodes(input.model)), "CLIPLoader", "VAELoader", "MiniMaxH3SigmaShift", how.reference ? "MiniMaxH3ReferenceToVideo" : "MiniMaxH3ImageToVideo", "RandomNoise", "KSamplerSelect",
      // the latent route runs on the third-party H3 nodes (so a ComfyUI without them is refused up front, not quietly left at the
      // original size), eases its noise down on a karras curve, decodes the enlarged latent in tiles, and the model's own frames
      // plainly for the raw side file
      "BasicScheduler", "BasicGuider", "SamplerCustomAdvanced", ...(input.upscale === UPSCALE.latent ? [...H3_LATENT_UPSCALE_NODES, "KarrasScheduler", "VAEDecodeTiled", "VAEDecode"] : ["VAEDecode"]), "VAEDecodeAudio",
      ...(input.quick ? ["ModelAttentionBackend"] : []),
      ...(turboLora || input.loras.some((l) => l.weight !== 0) ? ["LoraLoaderModelOnly"] : []),
      ...(how.start || how.end || input.mid || input.references.length ? ["LoadImage"] : []),
      ...(input.voice ? ["LoadAudio"] : []),
      ...(input.previous || input.next || input.refVideos.length ? ["LoadVideo", "GetVideoComponents"] : []),
      ...(guided ? ["MiniMaxH3AddGuide"] : []),
      ...(input.recording ? recordingNodes({ joined: Boolean(input.previous) && !input.recordingLeadIn }) : []),
      ...cueNodes(input),
      // a cue over a recording laid in as the take's sound is mixed with it
      ...(input.recording ? cueMixNodes(input) : []),
    ];
  },
  optionalNodes: [FACE_NODE, ...UPSCALE_OPTIONAL, VHS, ...CORE_VIDEO_OUT, ...COLOUR_MATCH_NODES, ...H3_CONTINUATION_NODES, H3_SEAM, H3_HEAD_GUIDE, H3_LANDING, H3_TRIM, ...H3_SAVE_LATENT,
    "MiniMaxH3Cache", "VedaSparseAttention", "ModelPatchTorchSettings", "FrameInterpolationModelLoader", "FrameInterpolate", "ModelPreviewOverrideKJ",
    // one of the two enlargers is used, by whether the latent upscaler's file is there: neither can be required by nodes()
    ...H3_LATENT_ENLARGE_NODES,
    // Face refine's: done without when they are missing, and said on the job (its pack is installed for it where the job runs)
    ...FACE_REFINE_OPTIONAL,
  ],

  // a finish by the latent re-sample samples the draft's own kept latent again (rendered again, the frames would differ); a
  // finish by Face refine decodes it as it is and redraws its faces only
  finishing: (input) => (input.upscale === UPSCALE.latent || input.faceRefineOnly ? { latent: "own" } : null),

  // under a recording it plays over (card #72): the clip lasts as long as its part, as a Lip sync clip does, and its files
  // carry the part in place of H3's own sound, so that the recording plays on across it unchanged. No guide: the mouth
  // does what What happens says (#79: "listens, mouth closed" kept it as still as a silent Lip sync guide)
  build(input, ctx) {
    if (!input.recording) return buildH3(input, ctx);
    // (its form always has the part's length: the recording's inputs are its own, with their defaults)
    const laid = recordingOnClip({ recordingSeconds: input.recordingSeconds ?? 0, recordingGoesOn: input.recordingGoesOn }, ctx, 0);
    return buildH3({ ...input, seconds: laid.seconds }, ctx, { sound: laid.sound });
  },


  variants: ((): Variant<H3Video & Partial<Recording>>[] => {
    const slots = { unet: "minimax_h3_fl2va.safetensors", clip: "qwen3vl_minimax_h3.safetensors", videoVae: "minimax_h3_video_vae.safetensors", audioVae: "minimax_h3_audio_vae.safetensors" };
    const all = { ...slots, turbo: "minimax_h3_turbo.safetensors", rife: "rife49.pth", refUnet: "minimax_h3_ref2va.safetensors", refTurbo: "minimax_h3_ref2v_turbo.safetensors" };
    const joined = { width: 576, height: 1024, frames: 22, fps: H3_FPS, hasSound: true };
    const picture = { width: 832, height: 1216 };
    const faceSlots = FACE_REFINE_SLOTS;
    return [
      { name: "words only, plain", input: { description: "a", fast: false, smooth: false, quick: false }, slots },
      { name: "fast, smooth, quick", input: { description: "a", cache: true }, slots: all },
      { name: "full steps with the step cache", input: { description: "a", fast: false, cache: true }, slots: all },
      // Veda on, its two predictors there: the text-and-frames one taken (no references), sparsity 24 / 40
      { name: "Veda's sparse attention, its text-and-frames predictor", input: { description: "a", veda: true, vedaGenerated: 24, vedaReference: 40, shot: "Medium" }, slots: { ...all, ...{ veda: "minimax_h3_r2va_veda_preview_fp8.safetensors", vedaT2va: "minimax_h3_t2va_veda_8nfe_600step_preview_fp8.safetensors" } } },
      {
        name: "opens on a picture and ends on another, a LoRA",
        input: { description: "a", start: "p1", end: "p2", loras: [{ file: "l.safetensors", weight: 0.8 }, { file: "off.safetensors", weight: 0 }], fast: false },
        slots, uploads: { start: "a.png", end: "b.png" }, media: { start: picture, end: picture },
      },
      {
        name: "carries on from a clip",
        input: { description: "a", previous: { asset: "c1" }, start: "ignored" },
        slots: all, uploads: { previous: "a.mp4", start: "a.png" }, media: { previous: joined },
      },
      // (the latent routes are not variants: nodes() declares the pixel route, which is always possible; the
      // recipe tests build them and check them against the catalog)
      {
        name: "between two clips, the next one silent and short",
        input: { description: "a", previous: { asset: "c1", at: 3000 }, next: { asset: "c2" }, end: "ignored" },
        slots: all, uploads: { previous: "a.mp4", next: "b.mp4", end: "b.png" },
        media: { previous: joined, next: { ...joined, frames: 5, hasSound: false } }, canvas: { width: 1024, height: 576 },
      },
      {
        name: "a person and a place from reference pictures, a voice, opening on a picture",
        input: {
          description: "a", subject: "brown hair", start: "p1", end: "ignored", voice: "v1", sharpRefs: true,
          references: [{ asset: "r1", role: "person" }, { asset: "r2", role: "person" }, { asset: "r3", role: "place" }],
        },
        slots: all, uploads: { start: "a.png", end: "b.png", voice: "v.wav", "references.0": "r1.png", "references.1": "r2.png", "references.2": "r3.png" },
        media: { start: picture },
      },
      {
        name: "references, carrying on from a clip",
        input: { description: "a", previous: { asset: "c1" }, references: [{ asset: "r1", role: "clothing" }], fast: false },
        slots: all, uploads: { previous: "a.mp4", "references.0": "r1.png" }, media: { previous: joined },
      },
      {
        // one file that is all three: no reference model, no turbo LoRA
        name: "a hybrid turbo fine-tune, with a reference picture",
        input: { description: "a", model: "SomeoneH3_hybridTurboV3.safetensors", references: [{ asset: "r1", role: "person" }] },
        slots: { ...slots, turbo: all.turbo }, uploads: { "references.0": "r1.png" },
      },
      {
        name: "a video of the person with its sound, and a picture of the place",
        input: { description: "a", refVideos: [{ asset: "v1", role: "person" }, { asset: "v2", role: "person" }], references: [{ asset: "r1", role: "place" }] },
        slots: all, uploads: { "refVideos.0": "a.mp4", "refVideos.1": "b.mp4", "references.0": "r1.png" },
        media: { "refVideos.0": { width: 384, height: 682, frames: 72, fps: 24, hasSound: true }, "refVideos.1": { width: 384, height: 682, frames: 72, fps: 24, hasSound: false } },
      },
      {
        // a place's and a look's videos: their own subjects, and their sound left out
        name: "a video of a place and a video of a look, both with sound",
        input: { description: "a", refVideos: [{ asset: "v1", role: "place" }, { asset: "v2", role: "style" }] },
        slots: all, uploads: { "refVideos.0": "a.mp4", "refVideos.1": "b.mp4" },
        media: { "refVideos.0": { width: 384, height: 682, frames: 72, fps: 24, hasSound: true }, "refVideos.1": { width: 384, height: 682, frames: 72, fps: 24, hasSound: true } },
      },
      {
        name: "passes through a picture half way",
        input: { description: "a", start: "p1", mid: "p2", midAt: 2.5 },
        slots: all, uploads: { start: "a.png", mid: "m.png" }, media: { start: picture },
      },
      { name: "latent upscale, plain resize", input: { description: "a", upscale: UPSCALE.latent }, slots: all },
      { name: "latent upscale, H3's upscaler", input: { description: "a", upscale: UPSCALE.latent, upscaleBy: 1.5, fast: false }, slots: { ...all, latentUpscaler: "minimax_h3_latent_upscaler_3d_fp16.safetensors" } },
      { name: "pixel upscale with a model", input: { description: "a", upscale: UPSCALE.model, upscaleModel: "4x-UltraSharp.pth" }, slots: all },
      { name: "pixel upscale with RTX VSR", input: { description: "a", upscale: UPSCALE.rtx, upscaleBy: 2 }, slots: all },
      { name: "pixel upscale with the other RTX node, NVIDIA's absent", input: { description: "a", upscale: UPSCALE.rtx, upscaleBy: 2 }, slots: all, has: (n: string) => n !== "RTXVideoSuperResolution" },
      { name: "SeedVR2 upscale", input: { description: "a", upscale: UPSCALE.seedvr, upscaleBy: 2, upscaleColour: "wavelet" }, slots: { ...all, seedvr: "seedvr2_3b_int8_convrot.safetensors", seedvrVae: "seedvr2_ema_vae_fp16.safetensors" } },
      {
        // one loader: the face pass on the clip's own reference model (card #159)
        name: "Face refine on the clip's own model",
        input: { description: "a", faceRefine: true, faceRefineModel: OWN_MODEL, references: [{ asset: "r1", role: "person" }] },
        slots: { ...all, ...faceSlots }, uploads: { "references.0": "r1.png" },
      },
      { name: "SeedVR2 upscale with the model picked", input: { description: "a", upscale: UPSCALE.seedvr, seedvrModel: "seedvr2_7b_int8_convrot.safetensors" }, slots: { ...all, seedvr: "seedvr2_3b_int8_convrot.safetensors", seedvrVae: "seedvr2_ema_vae_fp16.safetensors" } },
      { name: "latent upscale, the upscaler picked", input: { description: "a", upscale: UPSCALE.latent, upscaleLatentModel: "minimax_h3_latent_upscaler_3d_v2.safetensors" }, slots: all },
      {
        name: "Face refine, towards the cast person's picture",
        input: { description: "a", subject: "short dark hair, round glasses", faceRefine: true, references: [{ asset: "r1", role: "person" }, { asset: "r2", role: "place" }] },
        slots: { ...all, ...faceSlots }, uploads: { "references.0": "r1.png", "references.1": "r2.png" },
      },
      {
        name: "Finish › Face refine: the take's own latent, nothing sampled, no SAM",
        input: { description: "a", faceRefine: true, faceRefineOnly: true, references: [{ asset: "r1", role: "person" }] },
        slots: { ...all, faceRefineUnet: faceSlots.faceRefineUnet, faceDetector: faceSlots.faceDetector }, uploads: { "references.0": "r1.png", "self.latent": "own.safetensors" },
      },
      {
        // the cues pinned after the run-up (frames 22 + 2.4 s and 22 + 0), their parts laid into the file's sound over H3's
        name: "two sound cues laid in, carrying on from a clip",
        input: { description: "a", previous: { asset: "c1" }, cues: [{ asset: "s1", start: 0.1, seconds: 0.6, at: 2.4 }, { asset: "s2", start: 3, seconds: 1.5, at: 0 }] },
        slots: all, uploads: { previous: "a.mp4", "cues.0": "door.wav", "cues.1": "cheer.wav" }, media: { previous: joined, "cues.0": { width: 0, height: 0, seconds: 0.6 }, "cues.1": { width: 0, height: 0, seconds: 1.5 } },
      },
      {
        name: "a sound cue that H3 makes its own sound for",
        input: { description: "a", cues: [{ asset: "s1", start: 0, seconds: 0.5, at: 2.4 }], cueSound: "H3's own" },
        slots: all, uploads: { "cues.0": "clap.wav" }, media: { "cues.0": { width: 0, height: 0, seconds: 0.5 } },
      },
      {
        name: "a voice only, with the picture of who speaks",
        input: { description: "a", start: "p1", voice: "v1" },
        slots: all, uploads: { start: "a.png", voice: "v.wav" }, media: { start: picture },
      },
      // under a recording it plays over (card #72): its part laid in as the sound, nothing guided with it
      {
        name: "under a recording it plays over",
        input: { description: "She listens, her mouth closed, swaying gently to the music.", recording: "a1" },
        slots: all, uploads: { recording: "rec.wav" }, media: { recording: { width: 0, height: 0, seconds: 5.9, after: 4 } },
      },
      {
        name: "under a recording, carrying on from a clip that sang up to its part",
        input: { description: "a", previous: { asset: "c1" }, recording: "a1", recordingLeadIn: true, recordingGoesOn: true },
        slots: all, uploads: { previous: "a.mp4", recording: "rec.wav" }, media: { previous: joined, recording: { width: 0, height: 0, seconds: 7.3, after: 4, before: 2 } },
      },
      {
        // added over the recording, which plays on under it (card #71)
        name: "under a recording, a sound cue over it",
        input: { description: "She listens and claps once.", recording: "a1", cues: [{ asset: "s1", start: 0, seconds: 0.6, at: 2.4 }] },
        slots: all, uploads: { recording: "rec.wav", "cues.0": "clap.wav" }, media: { recording: { width: 0, height: 0, seconds: 5.9, after: 4 }, "cues.0": { width: 0, height: 0, seconds: 0.6 } },
      },
    ];
  })(),
});

/**
 * What another H3 recipe adds to the clip (a lip sync): a guide on the conditioning the clip is sampled with (not the
 * latent re-sample's, which follows the prompt alone), and the sound its files carry in place of the decoded one.
 * `head` is how many frames of the clip before open the clip.
 */
export interface H3Extra {
  /** The reference model's whole prompt, for the number of pictures it is given, in place of the one written from the form (a swap's caption). */
  prompt?(pictures: number): string;
  guide?(g: GraphBuilder, at: { positive: Ref; latent: Ref; vae: Ref; audioVae: Ref; head: number; frames: number }): Ref;
  sound?(g: GraphBuilder, decoded: Ref, at: { head: number; frames: number }): Ref;
  /** What the clip is sampled from, in place of the empty latent (a swap's: the source's own, the person masked to be redrawn). */
  latent?(g: GraphBuilder, at: { latent: Ref; vae: Ref; width: number; height: number; frames: number }): Ref;
  /**
   * The decoded frames as the clip keeps them (a swap's: the source's own pixels pasted back outside the person), at the
   * clip's size and length: a Finish › Face refine samples nothing, and what the paste-back reads is made here then.
   */
  frames?(g: GraphBuilder, images: Ref, at: { width: number; height: number; frames: number }): Ref;
  /**
   * How the person looks, for Face refine's prompt, when the form says it in a field of its own (a swap's, a Motion
   * transfer's "How they look") rather than H3's `subject`: a swap's clip takes no subject, and its look never reached the pass.
   */
  faceLook?: string;
  /** Veda's predictor for MiniMax's reference model, whatever the clip's file (a swap's: it runs the reference model as its own). */
  vedaFor?: "reference";
  /** The sampler's denoise, below 1 to keep more of what the latent starts from (a swap: the source's shapes). */
  denoise?: number;
  /** The turbo LoRA Turbo adds, when the recipe knows which suits its model (a swap's reference model: the reference one). */
  turbo?: string;
  /**
   * The model the clip is sampled with, patched (a motion's Fun ControlNet, held to the pose of its window), and the files the
   * patch loads. The latent re-sample of a finish keeps the model as loaded: it follows the prompt alone.
   */
  model?(g: GraphBuilder, model: Ref, at: { vae: Ref; width: number; height: number; frames: number }): { model: Ref; loads: string[] };
  /**
   * Reference pictures made in the graph, given after the form's (a motion window: the clip before's last frame, how the
   * person looks on this timeline, its clothes and hair, which a cast photo alone does not say). With any, the clip is made
   * by the reference route, as with a reference picture of the form.
   */
  pictures?(g: GraphBuilder): MorePicture[];
}

/** The words a shot opens the prompt with (card #27); none for Any. */
export const SHOT_WORDS: Record<string, string> = { Wide: "Wide shot.", Medium: "Medium shot.", "Close-up": "Close-up." };
/**
 * The form with its shot's words before what happens, unless they are there already, or the text is in H3's own layout,
 * sent as written (the words glued in front of it were sent with it).
 */
export function withShot<T extends { shot?: string; description: string }>(input: T): T {
  const words = SHOT_WORDS[input.shot ?? ""];
  return words && !input.description.trim().startsWith(words) && !isH3Layout(input.description) ? { ...input, description: `${words} ${input.description}`.trim() } : input;
}

/** A Finish › Face refine: the take's own latent decoded as it is and only its faces redrawn, nothing of the clip sampled. */
export const refinesOnly = (input: Pick<H3Video, "faceRefineOnly" | "upscale">) => Boolean(input.faceRefineOnly) && input.upscale !== UPSCALE.latent;
/** The model chain of a build that samples nothing (refinesOnly): nothing loaded, and nothing reads it. */
const NO_MODEL: ReturnType<typeof loadH3Model> = { model: ["", 0], turbo: false, steps: 0, lora: undefined, distilled: false, unet: undefined, vedaMissing: null };

/** The H3 clip's graph, shared by the recipes made on it. */
export function buildH3(asked: H3Video, ctx: BuildContext, extra: H3Extra = {}): BuiltGraph {
  // the shot's words open what happens (card #27), every H3 form alike; a recipe that writes its own prompt from parts says
  // them there, and leaves a typed one as it is (its clip's shot "Any")
  const input = withShot(asked);
  const { slots, media } = ctx;
  const g = new GraphBuilder();
  const more = extra.pictures ? extra.pictures(g) : [];
  const how = more.length ? { ...uses(input), reference: true } : uses(input);
  const picked = modelOf(input, slots);
  // a finish by the latent re-sample starts from the draft's own sampled latent (uploaded as "self.latent"): rendered again, even
  // with its seed, H3 does not make the same frames (measured 2026-10-08: 20 to 30 dB from the draft, the motion drifting)
  // Finish › Face refine loads it the same way, and samples nothing: the take's frames as they are, only its faces redrawn
  const own = input.upscale === UPSCALE.latent || input.faceRefineOnly ? ctx.uploads["self.latent"] : undefined;
  // the clip's model is then never loaded: its loaders, connected to nothing, still named its files, and a pod was sent the
  // model and the LoRA a Finish › Face refine never samples with
  const modelless = Boolean(own) && refinesOnly(input);
  if (how.reference && !picked.hybrid && !slots.refUnet && !modelless) {
    throw new Error("Reference pictures and voices need MiniMax H3's reference model (put minimax_h3_ref2va_*.safetensors in ComfyUI's models/diffusion_models folder) or a hybrid model picked under Model.");
  }
  const join = resolveJoin(input, ctx, how);
  const { width, height } = join;

  const audioVae = g.out("VAELoader", { vae_name: slots.audioVae });
  const vae = g.out("VAELoader", { vae_name: slots.videoVae });
  // (the model is read below only where something is sampled: the clip, the latent re-sample)
  const { model, turbo, steps, lora, unet, loader, vedaMissing } = modelless ? NO_MODEL : loadH3Model(g, ctx, input, picked, how, audioVae, extra.vedaFor, extra.turbo);
  // the clip's model as Face refine may run on it (OWN_MODEL): its loader where the clip loads it, else its file alone (a
  // Finish › Face refine, which samples nothing, loads only that)
  // (and its turbo LoRA, the one the clip ran with, which Face refine keeps on it)
  const asPicked = clipModelOf(input, slots, how, extra.turbo);
  const clipModel: ClipModel = loader ? { follows: asPicked.follows, file: unet, loader, ...(lora ? { turbo: lora } : {}) } : asPicked;
  const { positive, latent, previous, plain, clip } = conditionFor(g, ctx, input, how, join, { width, height, vae, audioVae }, extra.prompt, more);

  // a finish samples nothing: the patch (and the pose it reads) is left out of it
  const patched = extra.model && !own ? extra.model(g, model, { vae, width, height, frames: join.frames }) : null;
  const sampledWith = patched?.model ?? model;
  // what a recipe made on this one adds to the guides (a recording laid on the sound): the sampled clip follows it, the re-sample does not
  const recipeGuided = extra.guide ? extra.guide(g, { positive, latent, vae, audioVae, head: join.head, frames: join.frames }) : positive;
  // the sound cues, each pinned at its frame (a finish samples nothing, and keeps them only in its file's sound)
  const cues = cuesFor(g, ctx, input.cues, join);
  const guided = cues && !own ? guideCues(g, cues.placed, cues.parts, { positive: recipeGuided, latent, vae, audioVae }) : recipeGuided;
  g.phase(own ? "loading" : "sampling");
  const sampled = own
    ? g.add("AfflatusLoadH3Latent", { latent: own })
    : g.add("SamplerCustomAdvanced", {
        noise: g.out("RandomNoise", { noise_seed: ctx.seed }),
        guider: g.out("BasicGuider", { model: sampledWith, conditioning: guided }),
        sampler: g.out("KSamplerSelect", { sampler_name: input.sampler !== AUTO_SAMPLER ? input.sampler : turbo ? "euler" : "res_multistep" }),
        sigmas: g.out("BasicScheduler", { model: sampledWith, scheduler: input.scheduler, steps, denoise: extra.denoise ?? 1 }),
        latent_image: extra.latent ? extra.latent(g, { latent, vae, width, height, frames: join.frames }) : latent,
      });
  // continued in the latent: decoded as one piece with the clip before (its own last tokens, then the new ones), so that
  // the join is the whole chain's decoded at once and plays as a plain cut. The latent saved for the clips after stays the sampled window
  const resample = input.upscale === UPSCALE.latent;
  const seamed: Ref | null = previous && ctx.has(H3_SEAM) ? g.out(H3_SEAM, { previous_av_latent: previous, sampled_window: [sampled, 0], overlap_frames: join.head }) : null;
  let finished: Ref = seamed ?? [sampled, 0];
  let seam = Boolean(seamed) && !resample;
  let fine: Ref | null = null;
  if (resample) {
    // the latent re-sample (a finish): from the window with the clip before's own tokens in its overlap, so that the re-sample
    // starts there from what the clip before's did. Its result is kept (fine) for the clip after's finish, and the join is
    // decoded as one piece with the clip before's re-sampled latent when that one was finished the same way, at this size
    // guided by the prompt alone: a picture pinned at a frame was made for the sampled frame, and re-sampled larger it left the
    // clip's first frames hazy and soft (2026-10-08)
    fine = latentUpscalePass(g, ctx, input, { model, positive: plain, latent: finished, turbo, width, height });
    finished = fine;
    const big = latentUpscaleSize({ width, height }, input.upscaleBy);
    const before = media.previous?.fine;
    const prevFine = seamed && before && before.width === big.width && before.height === big.height ? ctx.uploads["previous.fine"] : undefined;
    if (prevFine) {
      const loaded = g.out("AfflatusLoadH3Latent", { latent: prevFine });
      const cut = media.previous?.latentCut;
      finished = g.out(H3_SEAM, { previous_av_latent: cut ? g.out(H3_TRIM, { samples: loaded, frames: cut }) : loaded, sampled_window: fine, overlap_frames: join.head });
      seam = true;
    }
  }
  // the file's sound: the recipe's (a recording, a source's sound) or the model's, then each cue's part laid in, unless the
  // form keeps H3's own sound at them. Over a recipe's sound H3's is not in the file: the parts are laid all the same, and
  // said, rather than the cues dropped without a word (B12)
  const laid = cues && (laysCues(input) || extra.sound) ? cues : null;
  const cueSaid = cues && extra.sound ? cueOwnSoundSaid(input) : null;
  const sound = extra.sound || laid
    ? (decoded: Ref) => {
        const base = extra.sound ? extra.sound(g, decoded, { head: join.head, frames: join.frames }) : decoded;
        return laid ? layCues(g, base, laid.placed, laid.parts, { frames: join.frames, over: Boolean(extra.sound) }) : base;
      }
    : undefined;
  const frames = extra.frames ? (images: Ref) => extra.frames!(g, images, { width, height, frames: join.frames }) : undefined;
  const made = finish(g, ctx, extra.faceLook === undefined ? input : { ...input, subject: extra.faceLook }, { finished, sampled, fine, vae, audioVae, clip, model: clipModel, width, height, head: join.head, sound, frames });

  const { head, tail, latentJoin } = join;
  const ms = (n: number) => Math.round((n / H3_FPS) * 1000);
  // the re-sample counts as a pass of its own: its steps again for every piece, after the clip's sampling. A finish is
  // the re-sample alone, and names no pass: what loads its models ahead is its loaders, not a step of the re-sample
  const resampled = fine ? input.upscaleSteps * latentUpscaleRounds(input, { width, height }, join.frames) : 0;
  // Veda asked for and its predictor not there: made with the full attention, and said (its node pack missing is said by the
  // queue, which knows why it is: ctx.wants)
  const vedaSaid = vedaMissing ? `Veda was on, but its predictor for ${vedaMissing === "reference" ? "the reference model" : "text and frames (T2VA)"} is not in ComfyUI's models/veda folder (Settings › Models has it): made with the full attention.` : null;
  const skipped = faceRefineSkipped(input, ctx, { audio: true, picture: openingPicture(input, ctx), clip: clipModel });
  // a Finish › Face refine that refines nothing would be the take made again, named a face pass: it fails, with why
  if (modelless && input.faceRefine && !made.refine) throw new Error(skipped ?? FACE_REFINE_PACK_NEEDED);
  const said = [join.sizeSaid, cueSaid, fine ? plainResizeSaid(input, ctx) : null, rifeSkippedSaid(input.smooth, ctx), skipped, made.said, vedaSaid].filter((x): x is string => Boolean(x));
  const refining = made.refine ? [made.refine] : [];
  return {
    graph: g.graph,
    phases: g.phases,
    outputs: made.outputs,
    totalSteps: (own ? resampled : steps + resampled) + (made.refine?.steps ?? 0),
    passes: [...(own ? [] : [{ node: sampled, steps }, ...(fine ? [{ node: fine[0], steps: resampled }] : [])]), ...refining],
    loads: [...(unet ? [`diffusion_models/${unet}`] : []), `text_encoders/${slots.clip}`, ...(lora ? [`loras/${lora}`] : []), ...(patched?.loads ?? []), ...made.loads],
    // a continuation window counts its frames as an extension and an overlap, and a finish loads its latent from a file:
    // neither says the clip's frames in an input the forecast reads, so they are said here (the shared ones included)
    frames: join.frames,
    ...(said.length ? { warnings: said } : {}),
    ...(head || tail ? { overlap: { headMs: ms(head), tailMs: ms(tail), ...(latentJoin ? { latent: true } : {}), ...(seam ? { seam: true } : {}) } } : {}),
  };
}
