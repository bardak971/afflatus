import { defineRecipe, type BuildContext, type BuiltGraph, type GraphBuilder, type Ref, type Variant } from "@afflatus/core";
import { H3_FPS } from "./family";
import { buildH3, h3Video } from "./video";
import { asClip, carriedOf, framesOf, h3Swap, SWAP_FRAMES, SWAP_GUIDE, SWAP_OWN, type H3Swap } from "./swap";
import { controlled, frameBefore, MOTION_CHAPTER, motionControlInputs, motionNeeds, motionNodes, poseVideo, POSE_SDPOSE, type H3Motion } from "./motion";

/**
 * MiniMax H3 · Swap motion (the owner's, 2026-10-18; built 2026-10-20): Swap character's first window, then motion. A
 * window that opens a shot (the source's first, or one after a scene cut) is a swap, made exactly as Swap character
 * makes it; every window that carries on is H3 driven by the pose of its part of the source, the window before's last
 * frames carried in (its latent, as rendered: no finished take needed) and the cast's picture as <Picture 1>. The person
 * replaced is never in those windows' input, so they cannot come back: a swap continued deep into a source kept her long
 * hair on his head (Timeline 19, clip 3), where a pose carries her arms and head, not her hair.
 */
export interface H3SwapMotion extends H3Swap, H3Motion {}

/**
 * The prompt a window that carries on starts on when clip 1's names no one to take it from (motionPromptFrom): no picture
 * tags, which H3's own layout adds (a window after the first is written as H3's clips are, not as the swap's caption).
 * The person and the room as they are, in positive words only.
 */
// Nothing of the room: H3 follows every word, and "Keep the room and the light…" drew a lamp into it (the owner, 2026-10-20).
// H3's layout already says the setting comes from the frames carried in
export const SWAP_MOTION_PROMPT = "The person carries on moving as in the clip before, with the same face, hair and clothes.";

/** The reference tags a swap's prompt names, with the word before them ("in <Picture 1>"): H3's layout says which picture is whom. */
const TAGS = /\s*\b(?:in|from|of)?\s*<(?:Picture|Video) \d+>/gi;
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The prompt of a window that carries on, from clip 1's swap prompt: who goes in, as it names them ("... with the man with
 * short brown hair in <Picture 1>"), carrying on as in the clip before, then its sentences that describe them (build,
 * clothes), without those that name <Video 1> or a picture (the swap's "Keep the man's face and hair from <Picture 1>"
 * would take the photo's hair, long, over the clip's), or the swap's own rules (Match, Preserve, Keep). Deterministic: the
 * designer can write each clip's own.
 */
export function motionPromptFrom(swap: string): string {
  const text = swap.trim();
  const who = /\bwith\s+(.+?)\s+in\s+<Picture 1>/i.exec(text)?.[1]?.trim();
  // the LoRA's caption names no one ("the character")
  if (!who || /^(?:the|a)\s+(?:character|person)$/i.test(who)) return SWAP_MOTION_PROMPT;
  const told = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s && !/<(?:Video|Picture) \d+>/i.test(s) && !/^(?:match|preserve|keep|replace|swap)\b/i.test(s));
  return [`${sentence(who)} carries on moving as in the clip before.`, ...told.map(sentence)].join(" ");
}

const SWAP_MOTION_GUIDE = `${SWAP_GUIDE}
A WINDOW THAT CARRIES ON (clip 2 on, joined to the one before) is not a swap: H3 is moved by the pose of the source's part, from the window before's last frames, with the cast's picture and the clip before's last frame. Afflatus says which picture is whom: its prompt names no picture or video tag, and never the person replaced:
- Name the person by how they look in the clip before (man or woman, hair, build, clothes), and what they do in this part, in the present tense: "The man with short brown hair, in a white shirt and jeans, dances, turning on the spot and raising his arms."
- Nothing of the room or the light: H3 draws what is named (a "light" became a lamp), and the setting comes from the clip before. No camera, light, style or quality words; positive words only.
- Each clip has its own prompt: write the one of the clip you are in.`;

/**
 * The motion's settings, shown under their own chapter after the swap's. Not the masked swap's colour match to the window
 * before: only a window that carries on has one before, and here it is moved by its pose, not swapped.
 */
const inputs = [...h3Swap.inputs.filter((i) => i.id !== "matchStrength"), ...motionControlInputs];

/**
 * A window that carries on, driven by its pose: the swap's model and form, without its LoRA and its source video (no
 * <Video 1>); the cast's picture and the clip before's last frame its references; its prompt H3's own layout around the
 * clip's words (as H3 · Video with audio writes it: which picture is whom said by Afflatus, any tag typed taken out); the
 * source's sound kept as the swap keeps it.
 */
function motionWindow(input: H3SwapMotion, ctx: BuildContext): BuiltGraph {
  if (!input.source || !ctx.uploads.source) throw new Error("Swap motion needs its source video.");
  const unet = input.swapModel ?? ctx.slots.swapUnet;
  if (!unet) throw new Error("Swap motion needs MiniMax H3's reference model: minimax_h3_ref2va_*.safetensors in ComfyUI's models/diffusion_models folder (Settings › Models has it).");
  const frames = framesOf(input, ctx);
  const carried = carriedOf(input, ctx);
  const source = ctx.media.source;
  const keep = input.keepSound && Boolean(source?.hasSound);
  const size = source?.width && source.height ? { width: source.width, height: source.height } : undefined;
  // as the swap runs: without H3's fp16 accumulation patch
  const asRef = { ...ctx, has: (cls: string) => cls !== "ModelPatchTorchSettings" && ctx.has(cls) };
  const written = input.who.trim() || SWAP_MOTION_PROMPT;
  const who = written.replace(TAGS, "").replace(/\s+([.,])/g, "$1").trim();
  let heard: Ref | null = null;
  const sourceSound = (g: GraphBuilder, n: number) =>
    (heard ??= g.out("TrimAudioDuration", { audio: [g.add("GetVideoComponents", { video: g.out("LoadVideo", { file: ctx.uploads.source }) }), 1], start_index: 0, duration: n / H3_FPS }));
  const clip = { ...asClip(input, null, frames, carried, unet, size), description: who };
  const built = buildH3(clip, asRef, {
    pictures: (g) => frameBefore(g, ctx),
    ...(keep ? { sound: (g, _decoded, at) => sourceSound(g, at.frames) } : {}),
    ...(keep && input.soundGuide ? {
      guide: (g, at) => g.out("MiniMaxH3AddGuide", { positive: at.positive, latent: at.latent, vae: at.vae, audio_vae: at.audioVae, audio: sourceSound(g, at.frames), frame_idx: 0 }),
    } : {}),
    model: (g, model, at) => {
      const pose = poseVideo(g, ctx, input, ctx.uploads.source!, at);
      const made = controlled(g, ctx, input, model, at.vae, pose);
      const sd = input.poseFrom === POSE_SDPOSE ? [`checkpoints/${ctx.slots.sdpose}`, `diffusion_models/${ctx.slots.rtdetr}`] : [];
      return { model: made.model, loads: [`model_patches/${made.file}`, ...sd] };
    },
    vedaFor: "reference",
    ...(ctx.slots.refTurbo ?? ctx.slots.turbo ? { turbo: ctx.slots.refTurbo ?? ctx.slots.turbo } : {}),
  });
  // said on the job, the window rendered all the same
  const notes = [
    ...(/<Video \d+>|^\s*(?:replace|swap)\b/i.test(written) ? ["This window carries on from the one before, moved by its pose: its prompt is still a swap's. Write its own: who is in it, as they look in the clip before, and what they do."] : []),
    ...(input.maskOn ? ["The Mask is the first window's: this one carries on, redrawn whole and moved by its pose."] : []),
    ...(input.references.length === 0 ? ["No picture of who goes in: the window carries on from the clip before's frames alone, and the face may drift."] : []),
  ];
  return notes.length ? { ...built, warnings: [...(built.warnings ?? []), ...notes] } : built;
}

export const h3SwapMotion = defineRecipe<H3SwapMotion>({
  ...h3Swap,
  id: "h3.swapMotion",
  title: "Swap motion",
  summary: "Swap character's first window, then H3 moved by the source's pose from the window before: the person replaced never comes back.",
  // each window keeps its own prompt; one that carries on starts on clip 1's person, carrying on (Make puts it there)
  traits: { ...h3Swap.traits!, windows: { ...h3Swap.traits!.windows!, own: SWAP_OWN } },
  windowCarryOn: (form) => ({ who: motionPromptFrom(String(form.who ?? "")) }),
  inputs,
  guide: SWAP_MOTION_GUIDE,
  chapters: [...(h3Swap.chapters ?? []), MOTION_CHAPTER],
  needs: [...(h3Swap.needs ?? [])],
  // the ControlNet (and SDPose's models) are the windows' that carry on: the first is a swap, made without them
  needsWith: (input, slots) => [...(h3Swap.needsWith?.(input, slots) ?? []), ...(input.previous ? motionNeeds(input) : [])],
  // a swap's nodes for a window that opens a shot; for one that carries on, H3's with no swap LoRA, the source's sound, the
  // pose's and the ControlNet's (core's ImageScale and CheckpointLoaderSimple are among the swap's optional ones)
  nodes: (input) => {
    const optional = new Set([...(h3Swap.optionalNodes ?? []), "LoraLoaderModelOnly"]);
    if (!input.previous || input.maskPreview) return h3Swap.nodes!(input).filter((n) => !optional.has(n));
    return [...new Set([
      // the clip before's last frame is one more reference picture: the reference route, a cast photo or not
      ...h3Video.nodes({ ...asClip(input, null, SWAP_FRAMES, 22), description: "a", references: [...input.references, { asset: "frame", role: "person" }] }),
      ...(input.keepSound ? ["TrimAudioDuration"] : []), ...(input.keepSound && input.soundGuide ? ["MiniMaxH3AddGuide"] : []),
      ...motionNodes(input),
      // (with no cast photo, the frame is the only picture: nothing loaded from a file)
    ])].filter((n) => !optional.has(n) && !(n === "LoadImage" && input.references.length === 0));
  },
  // core's LoRA loader: a window that carries on takes it only for a turbo LoRA (a model that is not distilled, known by the
  // file the slot gives, which nodes() does not see) or the user's LoRAs
  optionalNodes: [...(h3Swap.optionalNodes ?? []), "LoraLoaderModelOnly"],
  build: (input, ctx) => (input.previous ? motionWindow(input, ctx) : h3Swap.build(input, ctx)),
  variants: ((): Variant<H3SwapMotion>[] => {
    const all = {
      unet: "minimax_h3_fl2va.safetensors", clip: "qwen3vl_minimax_h3.safetensors", videoVae: "minimax_h3_video_vae.safetensors", audioVae: "minimax_h3_audio_vae.safetensors",
      turbo: "minimax_h3_turbo.safetensors", refUnet: "minimax_h3_ref2va.safetensors", refTurbo: "minimax_h3_ref2v_turbo.safetensors",
      swapLora: "h3_character_swap_v1.5.safetensors", swapUnet: "minimax_h3_fused_refdelta_r1024_turbo8_mystic07_int8_convrot.safetensors", swapSam: "sam3.1_multiplex_fp16.safetensors",
      h3Control: "minimax_h3_fun_controlnet_union_2.0_pruned_int8_convrot.safetensors", sdpose: "sdpose_wholebody_fp16.safetensors", rtdetr: "rt_detr_v4-x-hgnet_fp16.safetensors",
    };
    const part = { width: 576, height: 1024, frames: 141, fps: H3_FPS, hasSound: true };
    const before = { width: 576, height: 1024, frames: 22, fps: H3_FPS, hasSound: true };
    const who = "The man with short brown hair in <Picture 1>, in a white shirt and jeans, dances.";
    return [
      // every one of Swap character's, its first window being one
      ...h3Swap.variants.map((v) => ({ ...v, name: `as Swap character: ${v.name}`, slots: { ...v.slots, h3Control: all.h3Control } }) as Variant<H3SwapMotion>),
      {
        name: "the first window: a swap, as Swap character makes it",
        input: { who: "Replace the woman in <Video 1> with the man in <Picture 1>.", source: { asset: "v1" }, references: [{ asset: "r1", role: "person" }], fast: false },
        slots: all, uploads: { source: "v.mp4", "references.0": "r1.png" }, media: { source: part },
      },
      {
        name: "a window that carries on: moved by its pose (DWPose), the cast's picture in, the source's sound kept",
        input: { who, source: { asset: "v1", at: 5 }, previous: { asset: "w1" }, references: [{ asset: "r1", role: "person" }], fast: true },
        slots: all, uploads: { source: "v.mp4", previous: "w.mp4", "references.0": "r1.png" }, media: { source: part, previous: before },
      },
      {
        name: "a window that carries on with a long run-up, its pose from SDPose, a weaker control ending early",
        input: { who, source: { asset: "v1", at: 5 }, previous: { asset: "w1" }, context: "39", references: [{ asset: "r1", role: "person" }], poseFrom: POSE_SDPOSE, controlStrength: 0.8, controlEnd: 0.75, poseFace: false },
        slots: all, uploads: { source: "v.mp4", previous: "w.mp4", "references.0": "r1.png" }, media: { source: part, previous: { ...before, frames: 39 } },
      },
      {
        name: "a window that carries on with no picture of who goes in, from the window before's frames",
        input: { who, source: { asset: "v1", at: 5 }, previous: { asset: "w1" }, joinFrom: "Frames", references: [], keepSound: false },
        slots: all, uploads: { source: "v.mp4", previous: "w.mp4" }, media: { source: part, previous: before },
      },
    ];
  })(),
});
