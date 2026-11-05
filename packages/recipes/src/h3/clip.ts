import { FACE_NODE } from "../shared/face";
import { GraphBuilder, latentUpscaleSize, type BuildContext, type BuiltGraph, type Ref } from "@afflatus/core";
import { H3_FPS } from "./family";
import { UPSCALE, UPSCALE_OPTIONAL, upscaleNodes } from "../video/upscale";
import { unetNodes } from "../shared/unet";
import { CORE_VIDEO_OUT, VHS } from "../shared/out";
import { COLOUR_MATCH_NODES, rifeSkippedSaid } from "../shared/finish";
import { conditionFor, FREE_TEXT_ENCODER, type MorePicture } from "./condition";
import { cueMixNodes, cueNodes, cueOwnSoundSaid, cuesFor, guideCues, layCues, laysCues } from "./cue";
import { finish, H3_SAVE_LATENT } from "./finish";
import { FACE_REFINE_OPTIONAL, FACE_REFINE_PACK_NEEDED, clipModelOf, faceHoldLacks, faceRefineSkipped, openingPicture, withFacePass, type ClipModel } from "./faceRefine";
import type { H3Video } from "./inputs";
import { recordingNodes, type Recording } from "../shared/recording";
import { isH3Layout } from "./prompt";
import { H3_CONTINUATION_NODES, H3_HEAD_GUIDE, H3_LANDING, H3_RUN_ANCHOR, H3_RUNUP_MATCH, H3_SEAM, H3_TRIM, resolveJoin } from "./join";
import { H3_LATENT_ENLARGE_NODES, H3_LATENT_UPSCALE_NODES, latentUpscalePass, latentUpscaleRounds, plainResizeSaid } from "./latent-upscale";
import { AUTO_SAMPLER, loadH3Model, modelOf, namedFor, uses } from "./model";

/**
 * MiniMax H3's clip, shared by every H3 form (h3Form, form.ts): its graph (buildH3), the nodes it is read to need before it
 * is built, the ones it does without when they are missing, and when it is a finish of a take's own latent.
 */

/** The nodes of an H3 clip, read before it is built: what every H3 form asks of a machine for the clip it makes. */
export function h3ClipNodes(input: H3Video & Partial<Recording>): string[] {
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
}

/** The nodes an H3 clip uses where they are there, and does without (each said) where they are not. */
export const H3_OPTIONAL_NODES: string[] = [FACE_NODE, ...UPSCALE_OPTIONAL, VHS, ...CORE_VIDEO_OUT, ...COLOUR_MATCH_NODES, ...H3_CONTINUATION_NODES, H3_SEAM, H3_HEAD_GUIDE, H3_LANDING, H3_TRIM, ...H3_SAVE_LATENT,
  // a continuation held at the clip before's sharpness (pack 0.45.0): an older pack continues as before
  H3_RUNUP_MATCH,
  // and held to its run's first clip (pack 0.46.0): an older pack holds it to the clip before only
  H3_RUN_ANCHOR,
  // the text encoder let go before sampling (pack 0.43.0): an older pack samples with it still loaded, as before
  FREE_TEXT_ENCODER,
  "MiniMaxH3Cache", "VedaSparseAttention", "ModelPatchTorchSettings", "FrameInterpolationModelLoader", "FrameInterpolate", "ModelPreviewOverrideKJ",
  // one of the two enlargers is used, by whether the latent upscaler's file is there: neither can be required by nodes()
  ...H3_LATENT_ENLARGE_NODES,
  // Face refine's: done without when they are missing, and said on the job (its pack is installed for it where the job runs)
  ...FACE_REFINE_OPTIONAL,
];

// a finish by the latent re-sample samples the draft's own kept latent again (rendered again, the frames would differ); a
// finish by Face refine decodes it as it is and redraws its faces only
export const h3Finishing = (input: Pick<H3Video, "upscale" | "faceRefineOnly">) => (input.upscale === UPSCALE.latent || input.faceRefineOnly ? { latent: "own" as const } : null);

/** What an H3 form starts on for its model's file: a distilled file (DaSiWa's …TurboV3) is made for few steps, and starts on Turbo, which runs them without a LoRA. */
export const H3_PRESETS = [
  { match: "(^|[^0-9])4[ _-]?steps?([^a-z]|$)", values: { turboSteps: 4, shiftVideo: 6, shiftAudio: 3 }, note: "a 4-step file: 4 steps, shift 6 / 3" },
  // 8 / 4: what DaSiWa gives for his 8-step Turbo files (MiniMax's 12 / 3 are its LoRA's)
  { match: namedFor.turbo.source, values: { fast: true, turboSteps: 8, shiftVideo: 8, shiftAudio: 4 }, note: "a distilled file: Turbo, 8 steps without a LoRA, shift 8 / 4" },
];

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
function withShot<T extends { shot?: string; description: string }>(input: T): T {
  const words = SHOT_WORDS[input.shot ?? ""];
  return words && !input.description.trim().startsWith(words) && !isH3Layout(input.description) ? { ...input, description: `${words} ${input.description}`.trim() } : input;
}

/** A Finish › Face refine: the take's own latent decoded as it is and only its faces redrawn, nothing of the clip sampled. */
export const refinesOnly = (input: Pick<H3Video, "faceRefineOnly" | "upscale">) => Boolean(input.faceRefineOnly) && input.upscale !== UPSCALE.latent;
/** The model chain of a build that samples nothing (refinesOnly): nothing loaded, and nothing reads it. */
const NO_MODEL: ReturnType<typeof loadH3Model> = { model: ["", 0], turbo: false, steps: 0, lora: undefined, loraWeight: 1, distilled: false, unet: undefined, vedaMissing: null };

/** The H3 clip's graph, shared by the recipes made on it. */
export function buildH3(asked: H3Video, ctx: BuildContext, extra: H3Extra = {}): BuiltGraph {
  // the shot's words open what happens (card #27), every H3 form alike; a recipe that writes its own prompt from parts says
  // them there, and leaves a typed one as it is (its clip's shot "Any")
  // (a continuation that carries the face on is face-refined whatever the toggle says: withFacePass)
  let input = withShot(withFacePass(asked));
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
  const { model, turbo, steps, lora, loraWeight, unet, loader, vedaMissing } = modelless ? NO_MODEL : loadH3Model(g, ctx, input, picked, how, audioVae, extra.vedaFor, extra.turbo);
  // the clip's model as Face refine may run on it (OWN_MODEL): its loader where the clip loads it, else its file alone (a
  // Finish › Face refine, which samples nothing, loads only that)
  // (and its turbo LoRA, the one the clip ran with, which Face refine keeps on it)
  const asPicked = clipModelOf(input, slots, how, extra.turbo);
  const clipModel: ClipModel = loader ? { follows: asPicked.follows, file: unet, loader, ...(lora ? { turbo: lora, turboWeight: loraWeight } : {}) } : asPicked;
  // a continuation holding the face on whose pass cannot run here is sampled with the person's pictures after all, its Face
  // refine as the form has it: left out for a pass that is skipped, the clip had neither (card #231)
  const lacks = faceHoldLacks(input, ctx, clipModel);
  if (lacks) input = withShot({ ...asked, faceCarried: false });
  const { positive, latent, previous, plain, clip, free } = conditionFor(g, ctx, input, how, join, { width, height, vae, audioVae }, extra.prompt, more, !own);

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
  // continued in the latent: the sampled window brought back to the clip before's contrast first (card #212). Its run-up copies
  // the clip before's tail but a few per cent wider in every channel, and the clip after continues from this window: a chain
  // got sharper and more contrasty clip after clip (×2 sharpness over five). Matched from the run-up alone, the run-up stays
  // the clip before's tail and the join seamless. Everything after reads it: the seam, the re-sample, the kept latent, the
  // model's own frames. Not for a finish (own), which re-samples a draft's kept latent as it was approved
  // A window that ends on frames of its own (landed on the clip after's tokens, or an End frame picture) has the correction
  // faded out over them (pack 0.49.3): divided there too, a landing's end came out 2 to 3 % softer than the clip after's first
  // frames, as sampled (card #234). An older pack's node takes no such input, and corrects the whole window as before
  const pinnedEnd = join.tail || (how.end ? join.head : 0);
  const fades = pinnedEnd > 0 && Boolean(ctx.inputs?.(H3_RUNUP_MATCH)?.includes("end_frames"));
  const matched: Ref = previous && !own && ctx.has(H3_RUNUP_MATCH) ? g.out(H3_RUNUP_MATCH, { previous_av_latent: previous, sampled_window: [sampled, 0], overlap_frames: join.head, ...(fades ? { end_frames: pinnedEnd } : {}) }) : [sampled, 0];
  // then held to the run's first clip (card #215): matched to the clip before alone, the small drift each continuation adds
  // (the channel means one way, the fine detail up) still built up, and a six-clip chain still came out ×1.4 sharper and off
  // colour. The run's look rides in the kept latents (the clip before's, else read on it: a clip that continues none starts
  // a run); a window far from it (a new look asked for, a cut the model made) is left as sampled and starts a new run. Not
  // for a clip that lands on the clip after: the anchor holds a window's end, and there the end is the clip after's own
  // frames (pinned), which no clip continues from; moved, the landing would no longer be seamless. Nor for a clip that ends on
  // its End frame picture: the anchor moved that pinned last frame away from the picture (card #234). Such a window's kept
  // latent carries the run's look on all the same, from the clip before (Run-up Match, pack 0.49.3)
  const sampledWindow: Ref = previous && !own && !join.tail && !how.end && ctx.has(H3_RUN_ANCHOR) ? g.out(H3_RUN_ANCHOR, { previous_av_latent: previous, sampled_window: matched, overlap_frames: join.head }) : matched;
  // decoded as one piece with the clip before (its own last tokens, then the new ones), so that the join is the whole chain's
  // decoded at once and plays as a plain cut. The latent saved for the clips after stays the (matched) sampled window
  const resample = input.upscale === UPSCALE.latent;
  const seamed: Ref | null = previous && ctx.has(H3_SEAM) ? g.out(H3_SEAM, { previous_av_latent: previous, sampled_window: sampledWindow, overlap_frames: join.head }) : null;
  let finished: Ref = seamed ?? sampledWindow;
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
  // a Finish › Face refine's pass has its prompt encoded on its own: the free node there is fed by the clip's start (its prompt
  // alone, or on the reference route the clip's own encode), which nothing else of a finish reads. Read by the pass, it made
  // ComfyUI run that start again, a Qwen3-VL encode with every reference picture and their VAE encodes (the 0.9.0 B8 fix
  // undone on pack 0.49, card #234). The latent re-sample reads it anyway, and the pass's prompt is encoded there too
  const made = finish(g, ctx, extra.faceLook === undefined ? input : { ...input, subject: extra.faceLook }, { finished, sampledWindow, fine, vae, audioVae, clip, free: modelless ? null : free, model: clipModel, width, height, head: join.head, sound, frames });

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
  // (why the pass cannot run is said once: in the line saying the pictures were sampled after all)
  const unheld = lacks ? `Sampled with the person's pictures, not carried on by Face refine: ${lacks.replace(/^Not face-refined: /, "").replace(/\.$/, "")}.` : null;
  const said = [join.sizeSaid, cueSaid, fine ? plainResizeSaid(input, ctx) : null, rifeSkippedSaid(input.smooth, ctx), unheld, lacks ? null : skipped, made.said, vedaSaid].filter((x): x is string => Boolean(x));
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
