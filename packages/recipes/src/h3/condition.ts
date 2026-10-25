import { UPSCALE } from "../video/upscale";
import type { BuildContext, GraphBuilder, MediaFacts, Ref } from "@afflatus/core";
import { H3_FPS } from "./family";
import type { H3Video } from "./inputs";
import { H3_HEAD_GUIDE, H3_LANDING, H3_TRIM, type H3Join } from "./join";
import type { H3Uses } from "./model";
import { h3Prompt, h3ReferencePrompt, type H3Mode } from "./prompt";

/** How many reference pictures the reference model is given at most (it takes 9; the opening picture is one of them). */
export const H3_REFERENCES = 6;
/** How many reference videos it takes. */
export const H3_REFERENCE_VIDEOS = 3;

type Frame = { width: number; height: number; vae: Ref; audioVae: Ref };

/**
 * Continued in the latent: the clip before's own latent (cut at the frame it stops on when it was handed over
 * before its end, a frozen tail) and the window to sample, its hidden overlap and then the new frames.
 */
function continuationWindow(g: GraphBuilder, ctx: BuildContext, join: H3Join): { prev: Ref | null; window: string | null } {
  if (!join.latentJoin) return { prev: null, window: null };
  const loaded = g.out("AfflatusLoadH3Latent", { latent: join.prevLatent });
  const cut = ctx.media.previous?.latentCut;
  const prev = cut ? g.out(H3_TRIM, { samples: loaded, frames: cut }) : loaded;
  return { prev, window: g.add("MiniMaxH3GuidedContinuationWindow", { previous_av_latent: prev, overlap_frames: join.head, extension_frames: join.frames - join.head }) };
}

/** A reference picture made in the graph, after the form's: what it shows (a reference role), and the image. */
export interface MorePicture {
  image: Ref;
  role: string;
}

/** The clip from the reference model: the pictures, the reference videos and the voice, and the opening picture pinned at the first frame when there is one. */
function referenceStart(g: GraphBuilder, ctx: BuildContext, input: H3Video, how: H3Uses, frame: Frame, clip: Ref, length: number | Ref, fixed?: (pictures: number) => string, more: MorePicture[] = []): { start: string; positive: Ref } {
  const { uploads, media } = ctx;
  const { width, height, vae, audioVae } = frame;
  // a voice with a picture to open on and nothing else: that picture is who speaks, not a frame
  const voiceOnly = input.references.length === 0 && input.refVideos.length === 0;
  // reference videos: their frames, and a person's sound as their voice when no voice sample is given. Another role's
  // sound is left out: H3 lays a lone sound reference into the take as it is and ignores it beside a voice (card #79)
  const videos = input.refVideos.map((r, i) => ({
    parts: g.add("GetVideoComponents", { video: g.out("LoadVideo", { file: uploads[`refVideos.${i}`] }) }),
    role: r.role,
    sound: r.role === "person" && Boolean(media[`refVideos.${i}`]?.hasSound) && !input.voice,
  }));
  // the form's pictures, then those the recipe makes in the graph (a motion window: the clip before's last frame)
  const pictures: Array<{ file?: string; image?: Ref; role: string }> = voiceOnly && !more.length
    ? (how.start ? [{ file: uploads.start, role: "person" }] : [])
    : [...input.references.map((r, i) => ({ file: uploads[`references.${i}`], role: r.role })), ...more];
  // with references, the clip can still open on its picture: it is given as one more picture and pinned at the first frame
  const opening = !voiceOnly && how.start;
  const files: Array<{ file?: string; image?: Ref }> = [...pictures, ...(opening ? [{ file: uploads.start }] : [])];
  // a recipe made on this one can say the prompt itself (a swap: its LoRA's short trained caption)
  const prompt = fixed ? fixed(files.length) : h3ReferencePrompt(input, { roles: pictures.map((p) => p.role), videos: videos.map(({ role, sound }) => ({ role, sound })), voice: Boolean(input.voice), continues: Boolean(input.previous), opening, voiceOnly });
  const start = g.add("MiniMaxH3ReferenceToVideo", {
    clip, vae, audio_vae: audioVae, prompt, width, height, length, ref_image_size: input.sharpRefs ? "max" : "match",
    // inputs of a group that grows are named "<group>.<prefix><n>", counting from 0
    ...Object.fromEntries(files.map((p, i) => [`ref_images.ref_image_${i}`, p.image ?? g.out("LoadImage", { image: p.file })])),
    ...Object.fromEntries(videos.map((v, i) => [`ref_videos.ref_video_${i}`, [v.parts, 0]])),
    // the sound goes with the video of the same number
    ...Object.fromEntries(videos.flatMap((v, i) => (v.sound ? [[`ref_video_audios.ref_video_audio_${i}`, [v.parts, 1]]] : []))),
    ...(input.voice ? { "ref_audios.ref_audio_0": g.out("LoadAudio", { audio: uploads.voice }) } : {}),
  });
  let positive: Ref = [start, 0];
  // one frame only: a longer still freezes the opening and the model then jumps to another scene
  if (opening) positive = g.out("MiniMaxH3AddGuide", { positive, vae, audio_vae: audioVae, latent: [start, 1], image: g.out("LoadImage", { image: uploads.start }), frame_idx: 0 });
  return { start, positive };
}

/**
 * The clip from words and its first and last picture. With the latent re-sample and a picture, the same words
 * without the pictures too (`plain`): what the re-sample is guided by.
 */
function pictureStart(g: GraphBuilder, ctx: BuildContext, input: H3Video, how: H3Uses, join: H3Join, frame: Frame, clip: Ref, length: number | Ref): { start: string; plain: Ref | null } {
  const { uploads } = ctx;
  const { width, height, vae } = frame;
  const mode: H3Mode = how.start ? (how.end ? "both" : "start") : how.end ? "land" : "free";
  const prompt = h3Prompt(mode, join.seconds, input, input.previous ? { overlap: join.head / H3_FPS, seconds: join.ownSeconds, lands: Boolean(input.next) } : undefined);
  const start = g.add("MiniMaxH3ImageToVideo", {
    clip, vae, prompt, width, height, length,
    ...(how.start ? { first_frame: g.out("LoadImage", { image: uploads.start }) } : {}),
    ...(how.end ? { last_frame: g.out("LoadImage", { image: uploads.end }) } : {}),
  });
  const plain: Ref | null = (how.start || how.end) && input.upscale === UPSCALE.latent ? [g.add("MiniMaxH3ImageToVideo", { clip, vae, prompt, width, height, length }), 0] : null;
  return { start, plain };
}

/**
 * The neighbours pinned in place: the clip before's tail at the very start (its own latent, or its frames and
 * their sound), the clip after at the very end (landed on in its latent, or its frames), and a picture the clip
 * passes through, at its moment.
 */
function pinNeighbours(g: GraphBuilder, ctx: BuildContext, input: H3Video, join: H3Join, frame: Frame, positive: Ref, latent: Ref, continued: { prev: Ref | null; window: string | null }): Ref {
  const { uploads, media } = ctx;
  const { vae, audioVae } = frame;
  const { tail, frames, ownSeconds, latentLanding, nextAt, landingAt, nextLatent, head } = join;
  const { prev, window } = continued;
  const pin = (file: string | undefined, facts: MediaFacts | undefined, at: number) => {
    const parts = g.add("GetVideoComponents", { video: g.out("LoadVideo", { file }) });
    positive = g.out("MiniMaxH3AddGuide", {
      positive, vae, audio_vae: audioVae, latent, image: [parts, 0], frame_idx: at,
      ...(facts?.hasSound === false ? {} : { audio: [parts, 1] }),
    });
  };
  if (window && prev) {
    const tailGuide = { positive, previous_av_latent: prev, target_av_latent: latent, overlap_video_tokens: [window, 2] as Ref, overlap_audio_tokens: [window, 3] as Ref };
    positive = g.out("MiniMaxH3LatentTailGuide", tailGuide);
  } else if (input.previous) pin(uploads.previous, media.previous, 0);
  if (latentLanding) {
    const next_av_latent = g.out("AfflatusLoadH3Latent", { latent: nextLatent });
    positive = landingAt
      ? g.out(H3_LANDING, { positive, next_av_latent, target_av_latent: latent, guide_frames: tail, land_at: nextAt })
      : g.out(H3_HEAD_GUIDE, { positive, next_av_latent, target_av_latent: latent, guide_frames: tail, skip_frames: 0 });
  }
  else if (input.next) pin(uploads.next, media.next, -tail);
  // a picture the clip passes through: one frame pinned at its moment, counted after the frames shared with the clip before
  if (input.mid) {
    const at = Math.max(1, Math.min(frames - tail - 2, head + Math.round(Math.min(input.midAt, ownSeconds - 0.25) * H3_FPS)));
    positive = g.out("MiniMaxH3AddGuide", { positive, vae, audio_vae: audioVae, latent, image: g.out("LoadImage", { image: uploads.mid }), frame_idx: at });
  }
  return positive;
}

/**
 * What the clip is sampled from: the conditioning (the prompt, the references or the first and last frame,
 * then the neighbouring clips and the keyframe pinned at their frames) and the latent to fill (the clip's
 * own, or the window that continues the clip before).
 */
export function conditionFor(g: GraphBuilder, ctx: BuildContext, input: H3Video, how: H3Uses, join: H3Join, frame: Frame, prompt?: (pictures: number) => string, more: MorePicture[] = []): { positive: Ref; latent: Ref; previous: Ref | null; plain: Ref; clip: Ref } {
  const clip = g.out("CLIPLoader", { clip_name: ctx.slots.clip, type: "minimax", device: "default" });
  const continued = continuationWindow(g, ctx, join);
  const { window } = continued;
  const length: number | Ref = window ? [window, 1] : join.frames;
  let start: string;
  let positive: Ref;
  // the prompt alone, without the pictures pinned at frames (made for the sampled frame): what the latent re-sample is guided by
  let plain: Ref | null = null;
  if (how.reference) {
    ({ start, positive } = referenceStart(g, ctx, input, how, frame, clip, length, prompt, more));
  } else {
    ({ start, plain } = pictureStart(g, ctx, input, how, join, frame, clip, length));
    positive = [start, 0];
  }
  const latent: Ref = window ? [window, 0] : [start, 1];
  positive = pinNeighbours(g, ctx, input, join, frame, positive, latent, continued);
  return { positive, latent, previous: window ? continued.prev : null, plain: plain ?? (how.reference ? positive : [start, 0]), clip };
}
