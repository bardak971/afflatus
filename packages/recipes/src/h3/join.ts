import { isChunkStart, onGrid, type BuildContext, type MediaFacts } from "@afflatus/core";
import { H3_FORM_PIXELS, H3_FPS, H3_GRID, H3_MAX_FRAMES, h3Canvas, h3Frames } from "./family";
import type { H3Video } from "./inputs";
import type { H3Uses } from "./model";

/**
 * How much of a neighbouring clip is handed over at a join: 22 frames (almost a second) carry the motion
 * and the voices over, not just the pose. A clip too short for that gives 5. The model takes guide clips
 * of 17k + 5 frames only.
 */
export const H3_JOIN_FRAMES = [22, 5];
/**
 * The Afflatus node pack: a clip continues from the latent of the clip before — the window (a hidden overlap,
 * then the new frames), a tail guide at frame zero, the window sampled and decoded as the clip.
 */
export const H3_CONTINUATION_NODES = ["AfflatusLoadH3Latent", "MiniMaxH3GuidedContinuationWindow", "MiniMaxH3LatentTailGuide"];
/** Afflatus's node (pack 0.5.0) that cuts a latent to its first frames: a clip handed over before its end is continued from there. */
export const H3_TRIM = "AfflatusTrimH3Latent";
/** The pack's node (0.7.0) that puts the clip before's own last tokens in front of a window's new ones, to decode them as one piece. */
export const H3_SEAM = "AfflatusH3SeamLatent";
/** The clip after's first tokens anchored at the window's end: a clip put between two others lands exactly on the next (the same pack). */
export const H3_HEAD_GUIDE = "AfflatusH3LatentHeadGuide";
/**
 * The same from anywhere in the clip after, where one of its 17-frame chunks begins (pack 0.6.0). H3 packs its latent
 * in chunks of five tokens, one frame then four of four, and lays a guide out as a sequence of its own: sliced at a
 * chunk's start its tokens keep their time spans, sliced elsewhere (the Head Guide's 17k + 5) they did not, and a
 * landing 56 frames in came out 6 frames late (measured 2026-10-07).
 */
export const H3_LANDING = "AfflatusH3LatentLanding";
/** How many frames of the next clip a join can land on: a position only (5), the motion too (22), a long run-in (39). Guide clips are 17k + 5 frames. */
export const H3_LANDINGS = ["5", "22", "39"] as const;

const guideFrames = (m: MediaFacts | undefined) => {
  const n = m?.frames ?? 0;
  if (!onGrid(n, H3_GRID) || n > 39) throw new Error(`a join takes 5, 22 or 39 frames of the other clip, not ${n}`);
  return n;
};

/** How the clip joins its neighbours, and how long that makes it. */
export interface H3Join {
  /** Frames of the clip before pinned at the start. */
  head: number;
  /** Frames of the clip after the join lands on. */
  tail: number;
  /** The whole clip in frames, the shared ones included. */
  frames: number;
  /** The whole clip in seconds. */
  seconds: number;
  /** The clip's own part, in seconds. */
  ownSeconds: number;
  /** Whether the clip is continued from the clip before's own latent rather than from its frames. */
  latentJoin: boolean;
  /** Whether the clip lands on the clip after's own latent. */
  latentLanding: boolean;
  /** The frame of the clip after's latent where its playing part starts. */
  nextAt: number;
  /** Landed on with the aligned landing (anywhere a chunk begins) rather than the head guide (its first frame only). */
  landingAt: boolean;
  /** The clip before's saved latent, when it was uploaded. */
  prevLatent: string | undefined;
  /** The clip after's saved latent, when it was uploaded. */
  nextLatent: string | undefined;
}

export function resolveJoin(input: H3Video, ctx: BuildContext): H3Join {
  const { uploads, media } = ctx;
  const head = input.previous ? guideFrames(media.previous) : 0;
  const tail = input.next ? guideFrames(media.next) : 0;
  // the frames shared with a neighbour are that neighbour's: the clip is made that much longer, so its own
  // part keeps the length asked for, within the 362 frames (15 s) the model was trained up to
  const ownSeconds = Math.min(input.seconds, (H3_MAX_FRAMES - head - tail) / H3_FPS);
  const seconds = ownSeconds + (head + tail) / H3_FPS;
  const frames = h3Frames(seconds);
  // the clip before's own latent, when it was kept and ComfyUI has the Afflatus node pack: the clip is
  // continued from it (the motion, the look and the voice carry on as they are) instead of from its frames
  const prevLatent = input.previous ? uploads["previous.latent"] : undefined;
  const prevFrames = media.previous?.latentFrames ?? 0;
  const cut = media.previous?.latentCut;
  const canLatent = Boolean(prevLatent && prevFrames >= head && H3_CONTINUATION_NODES.every((n) => ctx.has(n)) && (!cut || ctx.has(H3_TRIM)));
  // Auto (and "Latent", an older saved value): the exact latent whenever there is one; "Frames" asks for the frames
  const latentJoin = canLatent && input.joinFrom !== "Frames";
  // the clip after's own latent: the clip lands on its first tokens (after that clip's own overlap, when it has one)
  const nextLatent = input.next ? uploads["next.latent"] : undefined;
  const nextAt = media.next?.latentAt ?? 0;
  // where one of its chunks begins (frame 17j), with the aligned landing; its very first frame with the head guide of an older
  // pack. Anywhere else the tokens would be placed off their time (see H3_LANDING): its frames
  const room = nextLatent !== undefined && (media.next?.latentFrames ?? 0) >= nextAt + tail;
  const landingAt = room && isChunkStart(nextAt, H3_GRID) && ctx.has(H3_LANDING);
  const latentLanding = landingAt || (room && nextAt === 0 && ctx.has(H3_HEAD_GUIDE));
  return { head, tail, frames, seconds, ownSeconds, latentJoin, latentLanding, nextAt, landingAt, prevLatent, nextLatent };
}

/** The frame: a timeline's canvas, else the clip it joins, else the picture it opens or ends on, else the shape picked. */
export function frameFor(input: H3Video, ctx: BuildContext, how: H3Uses, latentJoin: boolean): { width: number; height: number } {
  const { media } = ctx;
  const like = input.previous ? media.previous : input.next ? media.next : how.start ? media.start : how.end ? media.end : undefined;
  // (continued in the latent: the size is the latent's, which is the clip before's own). A canvas or a neighbour
  // is taken at its own size, within what a form may ask for, never the model's trained canvas: a 768 × 1376 clip
  // before, allowed by the form, must not be continued at 768 × 1344 with its guide squashed to fit (seen 2026-10-05)
  // A canvas gives the shape, not the size: a timeline whose first clip was enlarged ×2 in its render has a canvas
  // four times the model's pixels, and a clip rendered at it never got past its guides on a 12 GB card (seen
  // 2026-10-07, 1152 × 1472 × 141 frames). The size is the neighbour's own (its raw frames), else the form's
  const short = like ? Math.min(like.width, like.height) : input.short;
  return ctx.canvas && !latentJoin
    ? h3Canvas(ctx.canvas.width, ctx.canvas.height, Math.min(ctx.canvas.width, ctx.canvas.height, short), H3_FORM_PIXELS)
    : like && (input.previous || input.next)
      ? h3Canvas(like.width, like.height, Math.min(like.width, like.height), H3_FORM_PIXELS)
      : like
        ? h3Canvas(like.width, like.height, input.short, H3_FORM_PIXELS)
        : h3Canvas(input.shape.width, input.shape.height, input.short, H3_FORM_PIXELS);
}
