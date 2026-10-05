import type { BuildContext, MediaFacts } from "@afflatus/core";
import { H3_FORM_PIXELS, H3_FPS, H3_MAX_FRAMES, h3Canvas, h3Frames } from "./family";
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
/**
 * The tail guide Auto uses: the clip before's last frames re-encoded for the picture, its exact latent for the
 * sound and the run-up. Measured on chains (2026-10-05): a window guided by the exact sampled latent copies the
 * tail 2–4 % wider in every channel at every hop, nothing re-anchors it to real pixels, and the chain gets softer
 * and darker clip after clip; frames encoded by the VAE have no such direction. The sound does not drift.
 */
export const H3_TAIL_GUIDE = "AfflatusH3TailGuide";
/** The clip after's first tokens anchored at the window's end: a clip put between two others lands exactly on the next (the same pack). */
export const H3_HEAD_GUIDE = "AfflatusH3LatentHeadGuide";
/** How many frames of the next clip a join can land on: a position only (5), the motion too (22), a long run-in (39). Guide clips are 17k + 5 frames. */
export const H3_LANDINGS = ["5", "22", "39"] as const;

const guideFrames = (m: MediaFacts | undefined) => {
  const n = m?.frames ?? 0;
  if (n % 17 !== 5 || n > 39) throw new Error(`a join takes 5, 22 or 39 frames of the other clip, not ${n}`);
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
  /** Whether the run-up and the sound come from that latent but the picture guide from the clip's re-encoded frames. */
  hybrid: boolean;
  /** Whether the clip lands on the clip after's own latent. */
  latentLanding: boolean;
  /** The frame of the clip after's latent where its playing part starts. */
  nextAt: number;
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
  const canLatent = Boolean(prevLatent && prevFrames >= head && H3_CONTINUATION_NODES.every((n) => ctx.has(n)));
  // Auto: the run-up and the sound from the latent, the picture guide from the clip's re-encoded frames (a chain
  // stays anchored to real pixels). The exact latent only when asked. An older pack without that guide, or
  // none: the frames, as ComfyUI alone does it, rather than a chain that drifts
  const hybrid = canLatent && input.joinFrom === "Auto" && ctx.has(H3_TAIL_GUIDE);
  const latentJoin = hybrid || (canLatent && input.joinFrom === "Latent");
  // the clip after's own latent: the clip lands on its first tokens (after that clip's own overlap, when it has one)
  const nextLatent = input.next ? uploads["next.latent"] : undefined;
  const nextAt = media.next?.latentAt ?? 0;
  const latentLanding = Boolean(nextLatent && (media.next?.latentFrames ?? 0) >= nextAt + tail && (nextAt === 0 || nextAt % 17 === 5) && ctx.has(H3_HEAD_GUIDE));
  return { head, tail, frames, seconds, ownSeconds, latentJoin, hybrid, latentLanding, nextAt, prevLatent, nextLatent };
}

/** The frame: a timeline's canvas, else the clip it joins, else the picture it opens or ends on, else the shape picked. */
export function frameFor(input: H3Video, ctx: BuildContext, how: H3Uses, latentJoin: boolean): { width: number; height: number } {
  const { media } = ctx;
  const like = input.previous ? media.previous : input.next ? media.next : how.start ? media.start : how.end ? media.end : undefined;
  // (continued in the latent: the size is the latent's, which is the clip before's own). A canvas or a neighbour
  // is taken at its own size, within what a form may ask for, never the model's trained canvas: a 768 × 1376 clip
  // before, allowed by the form, must not be continued at 768 × 1344 with its guide squashed to fit (seen 2026-10-05)
  return ctx.canvas && !latentJoin
    ? h3Canvas(ctx.canvas.width, ctx.canvas.height, Math.min(ctx.canvas.width, ctx.canvas.height), H3_FORM_PIXELS)
    : like && (input.previous || input.next)
      ? h3Canvas(like.width, like.height, Math.min(like.width, like.height), H3_FORM_PIXELS)
      : like
        ? h3Canvas(like.width, like.height, input.short, H3_FORM_PIXELS)
        : h3Canvas(input.shape.width, input.shape.height, input.short, H3_FORM_PIXELS);
}
