import { defineRecipe, type BuildContext, type BuiltGraph, type Chapter, type GraphBuilder, type InputSpec, type Preset, type Recipe, type Ref, type StartRule, type VideoTraits } from "@afflatus/core";
import { H3_FPS, H3_GRID } from "./family";
import { upscaleNeeds } from "../video/upscale";
import { rifeNeeds } from "../shared/finish";
import { buildH3, h3ClipNodes, h3Finishing, H3_OPTIONAL_NODES, H3_PRESETS, type H3Extra } from "./clip";
import { cueMixNodes } from "./cue";
import { clipModelOf, faceRefineNeeds, withFacePass } from "./faceRefine";
import { H3_SOUND_CHAPTER, h3Inputs, withFaceCarried, type H3Video } from "./inputs";
import { H3_CONTINUATION_NODES, H3_SEAM, H3_TRIM } from "./join";
import { latentUpscaleNeeds } from "./latent-upscale";
import { H3_STARTS, referenceNeeds, turboNeeds, vedaNeeds } from "./model";

/**
 * Every H3 form made by one factory (card #227), as ltxRecipe makes LTX's: the owner's rule is every H3 form alike (the same
 * H3 options, in the same order and words; a form only adds or drops what its job needs). Each form used to write its needs,
 * nodes, traits and H3's inputs around buildH3 by hand, and they drifted apart (card #191, a fix on two forms only). Here
 * they are written once; a form says what it adds, and what of H3's it drops, with why.
 */

/** The parts of the needs list every H3 form shares, in its order: the files its clip is read to need before it is built. */
export type H3NeedPart = "turbo" | "reference" | "veda" | "latentUpscale" | "upscale" | "rife" | "faceRefine";

/** What a part of the needs list reads: the form's input, its clip as read before the build, and the machine's files. */
export interface H3NeedRead<In> {
  input: In;
  clip: H3Video;
  slots: Record<string, string>;
  where: { own?: boolean };
}

/**
 * The needs every H3 clip has: Turbo's LoRA, the reference model for a clip with references, Veda's predictor, H3's latent
 * upscaler for an upscale with it, the pixel upscale's files, RIFE with "RIFE ×2" on, Face refine's files with it on (or
 * forced on, a continuation that carries the face on). What a form adds comes before Face refine's.
 */
const H3_NEEDS: Record<H3NeedPart, (r: H3NeedRead<H3Video>) => string[]> = {
  turbo: ({ clip, slots }) => turboNeeds(clip, slots),
  reference: ({ clip, slots }) => referenceNeeds(clip, slots),
  veda: ({ clip, slots }) => vedaNeeds(clip, slots),
  latentUpscale: ({ input }) => latentUpscaleNeeds(input),
  upscale: ({ input }) => upscaleNeeds(input),
  rife: ({ input }) => rifeNeeds(input.smooth),
  faceRefine: ({ input, clip, slots }) => faceRefineNeeds(withFacePass(input), { picture: Boolean(clip.start && !input.previous), clip: clipModelOf(clip, slots) }),
};
const NEED_ORDER: H3NeedPart[] = ["turbo", "reference", "veda", "latentUpscale", "upscale", "rife"];

/**
 * The traits of an H3 clip. The ones that name an input (faceCarried, holdFace) are left out of a form that drops that input,
 * and the frames a form cannot be given (no First frame, Last frame, mid pictures or Next clip) are said false.
 */
const H3_TRAITS: VideoTraits = {
  startFrame: true, endFrame: true, midFrames: true, continues: "clip", endAnchor: true, sound: true,
  fps: H3_FPS, frameGrid: H3_GRID, latentTrim: H3_TRIM, latentNodes: [...H3_CONTINUATION_NODES, H3_SEAM], faceRefine: "faceRefine", faceCarried: "faceCarried", holdFace: "holdFace",
};
/** The traits that say what a form can be given, each by the H3 input that gives it: false where the form drops it. */
const TRAIT_INPUTS = { startFrame: "start", endFrame: "end", midFrames: "mid", endAnchor: "next" } as const;

/** What one build of a form makes of its input: the H3 clip, the context it is built in, what it adds, and what it does after. */
export interface H3Built {
  clip: H3Video;
  ctx?: BuildContext;
  extra?: H3Extra;
  after?(built: BuiltGraph): BuiltGraph;
}

/** An H3 form: what it adds to H3's clip and what of it it drops, with why. */
export interface H3FormSpec<In extends H3Video> extends Omit<Recipe<In>, "family" | "output" | "inputs" | "traits" | "needsWith" | "nodes" | "optionalNodes" | "finishing" | "build" | "chapters" | "starts" | "presets"> {
  inputs: {
    /** H3's inputs this form does not take, each with why (the parity test reads them: every other one is on the form). */
    drop?: Record<string, string>;
    /** The form's inputs, laid around H3's shared ones (those it takes, in H3's order): left out, H3's alone. */
    lay?(shared: InputSpec[]): InputSpec[];
  };
  /** Traits of the form's own (a source's windows), over H3's. */
  traits?: Partial<VideoTraits>;
  /** The form's own chapters, before H3's Sound (every H3 form keeps the same tabs, card #170). */
  chapters?: Chapter[];
  starts?: StartRule[];
  presets?: Preset[];
  /** The form's input as H3's clip, read before it is built (its nodes, its finishing, its needs): left out, the input itself. */
  asClip?(input: In): H3Video;
  /** The clip its needs are read on, where it is not asClip's (one the machine decides). */
  needsClip?(input: In, slots: Record<string, string>, where: { own?: boolean }): H3Video;
  /** A part of H3's needs the form reads its own way: each says why where it is given. */
  needParts?: Partial<Record<H3NeedPart, (r: H3NeedRead<In>) => string[]>>;
  /** The files the form adds to its clip's (before Face refine's). */
  moreNeeds?(r: H3NeedRead<In>): string[];
  /** The needs of a build that is not this form's H3 clip (a window after a swap, Show the mask): null for the clip's. */
  needsInstead?(input: In, slots: Record<string, string>, where: { own?: boolean }): string[] | null;
  /** The nodes the form adds to its clip's. */
  moreNodes?(input: In): string[];
  /** The clip's nodes this form's build never uses. */
  lessNodes?(input: In): string[];
  /** The nodes of a build that is not this form's H3 clip: null for the clip's. */
  nodesInstead?(input: In): string[] | null;
  /** The optional nodes the form adds to its clip's. */
  moreOptional?: string[];
  /** The form's build: its clip, and what it adds to it. */
  built(input: In, ctx: BuildContext): H3Built;
}

/** The ids of H3's shared inputs. */
export const H3_INPUT_IDS: readonly string[] = h3Inputs.map((i) => i.id);
/** What each H3 form drops of H3's inputs, with why, by its id (read by the parity test). */
export const H3_DROPS = new Map<string, Readonly<Record<string, string>>>();

/** An H3 form's recipe, from its spec. */
export function h3Form<In extends H3Video>(spec: H3FormSpec<In>): Recipe<In> {
  const { inputs: laid, traits: ownTraits, chapters, starts, presets, asClip: toClip, needsClip, needParts, moreNeeds, needsInstead, moreNodes, lessNodes, nodesInstead, moreOptional, built, ...rest } = spec;
  const drop = laid.drop ?? {};
  const stale = Object.keys(drop).filter((id) => !H3_INPUT_IDS.includes(id));
  if (stale.length) throw new Error(`${spec.id} drops ${stale.join(", ")}, which H3's inputs do not have`);
  // the pictures of the take before carried on (card #223) are said in the "?" of a form that takes them
  const shared = (drop.faceCarried === undefined ? withFaceCarried(h3Inputs) : h3Inputs).filter((i) => drop[i.id] === undefined);
  const inputs = laid.lay ? laid.lay(shared) : shared;
  const lost = H3_INPUT_IDS.filter((id) => drop[id] === undefined && !inputs.some((i) => i.id === id));
  if (lost.length) throw new Error(`${spec.id} leaves out H3's ${lost.join(", ")} without saying why (inputs.drop)`);
  H3_DROPS.set(spec.id, drop);

  const traits = {
    ...Object.fromEntries(Object.entries(H3_TRAITS).filter(([, v]) => !(typeof v === "string" && H3_INPUT_IDS.includes(v) && drop[v] !== undefined))),
    ...Object.fromEntries(Object.entries(TRAIT_INPUTS).map(([trait, id]) => [trait, drop[id] === undefined])),
    ...ownTraits,
  } as VideoTraits;
  const clipOf = (input: In) => (toClip ? toClip(input) : input);

  return defineRecipe<In>({
    ...rest,
    family: "h3",
    output: "video",
    traits,
    inputs,
    chapters: [...(chapters ?? []), H3_SOUND_CHAPTER],
    starts: starts ?? H3_STARTS,
    presets: presets ?? H3_PRESETS,
    needsWith: (input, slots = {}, where = {}) => {
      const instead = needsInstead?.(input, slots, where);
      if (instead) return instead;
      // the clip is made only when a part reads it: a form whose parts are all its own (a swap's) reads its input alone, and
      // so is still read on a job whose form cannot be parsed (machineScans' filesUsed falls back to the family's slots)
      let clip: H3Video | undefined;
      const read: H3NeedRead<In> = { input, get clip() { return (clip ??= needsClip ? needsClip(input, slots, where) : clipOf(input)); }, slots, where };
      const part = (p: H3NeedPart) => (needParts?.[p] ?? (H3_NEEDS[p] as (r: H3NeedRead<In>) => string[]))(read);
      return [...NEED_ORDER.flatMap(part), ...(moreNeeds?.(read) ?? []), ...part("faceRefine")];
    },
    nodes: (input) => {
      const instead = nodesInstead?.(input);
      if (instead) return instead;
      const nodes = new Set([...h3ClipNodes(clipOf(input)), ...(moreNodes?.(input) ?? [])]);
      const less = new Set(lessNodes?.(input) ?? []);
      return [...nodes].filter((n) => !less.has(n));
    },
    optionalNodes: [...H3_OPTIONAL_NODES, ...(moreOptional ?? [])],
    // (a finish reads the Upscale and Finish › Face refine of the form, which every form hands its clip as they are)
    finishing: (input) => h3Finishing(input),
    build(input, ctx) {
      const made = built(input, ctx);
      const graph = buildH3(made.clip, made.ctx ?? ctx, made.extra);
      return made.after ? made.after(graph) : graph;
    },
  });
}

/**
 * The source's own sound (a swap's, a Motion transfer's) as the take's file and, asked for, as an audio guide anchored from
 * the window's first frame, as Lip sync anchors its recording: one loader, cut to the clip's length, read by both.
 */
export function sourceSound(ctx: BuildContext, keep: boolean, guide: boolean): Pick<H3Extra, "sound" | "guide"> {
  let heard: Ref | null = null;
  const sound = (g: GraphBuilder, frames: number) =>
    (heard ??= g.out("TrimAudioDuration", { audio: [g.add("GetVideoComponents", { video: g.out("LoadVideo", { file: ctx.uploads.source }) }), 1], start_index: 0, duration: frames / H3_FPS }));
  return {
    ...(keep ? { sound: (g: GraphBuilder, _decoded: Ref, at: { frames: number }) => sound(g, at.frames) } : {}),
    ...(keep && guide ? {
      guide: (g: GraphBuilder, at: { positive: Ref; latent: Ref; vae: Ref; audioVae: Ref; frames: number }) => g.out("MiniMaxH3AddGuide", { positive: at.positive, latent: at.latent, vae: at.vae, audio_vae: at.audioVae, audio: sound(g, at.frames), frame_idx: 0 }),
    } : {}),
  };
}

/** The nodes of the source's sound kept (sourceSound): its cut, a cue over it mixed in, and its guide. */
export const sourceSoundNodes = (input: { keepSound: boolean; soundGuide: boolean } & Pick<H3Video, "cues" | "cueSound">): string[] => [
  ...(input.keepSound ? ["TrimAudioDuration", ...cueMixNodes(input)] : []), ...(input.keepSound && input.soundGuide ? ["MiniMaxH3AddGuide"] : []),
];
