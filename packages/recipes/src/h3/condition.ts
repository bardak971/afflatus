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

/**
 * What the clip is sampled from: the conditioning (the prompt, the references or the first and last frame,
 * then the neighbouring clips and the keyframe pinned at their frames) and the latent to fill (the clip's
 * own, or the window that continues the clip before).
 */
export function conditionFor(g: GraphBuilder, ctx: BuildContext, input: H3Video, how: H3Uses, join: H3Join, frame: { width: number; height: number; vae: Ref; audioVae: Ref }): { positive: Ref; latent: Ref; previous: Ref | null; plain: Ref } {
  const { uploads, media } = ctx;
  const { width, height, vae, audioVae } = frame;
  const { head, tail, frames, seconds, ownSeconds, latentJoin, latentLanding, nextAt, landingAt, prevLatent, nextLatent } = join;
  const clip = g.out("CLIPLoader", { clip_name: ctx.slots.clip, type: "minimax", device: "default" });
  // continued in the latent: the previous latent, and the window to sample (its hidden overlap, then the new frames)
  const loaded = latentJoin ? g.out("AfflatusLoadH3Latent", { latent: prevLatent }) : null;
  // handed over before its end (a frozen tail): the clip before is continued from the frame it stops on
  const cut = media.previous?.latentCut;
  const prev = loaded && cut ? g.out(H3_TRIM, { samples: loaded, frames: cut }) : loaded;
  const window = latentJoin ? g.add("MiniMaxH3GuidedContinuationWindow", { previous_av_latent: prev, overlap_frames: head, extension_frames: frames - head }) : null;
  const length: number | Ref = window ? [window, 1] : frames;
  let start: string;
  let positive: Ref;
  // the prompt alone, without the pictures pinned at frames (made for the sampled frame): what the latent re-sample is guided by
  let plain: Ref | null = null;
  if (how.reference) {
    // a voice with a picture to open on and nothing else: that picture is who speaks, not a frame
    const voiceOnly = input.references.length === 0 && input.refVideos.length === 0;
    // videos of the person: their frames, and their sound as the voice when no voice sample is given
    const videos = input.refVideos.map((_, i) => ({
      parts: g.add("GetVideoComponents", { video: g.out("LoadVideo", { file: uploads[`refVideos.${i}`] }) }),
      sound: Boolean(media[`refVideos.${i}`]?.hasSound) && !input.voice,
    }));
    const pictures = voiceOnly ? (how.start ? [{ file: uploads.start, role: "person" }] : []) : input.references.map((r, i) => ({ file: uploads[`references.${i}`], role: r.role }));
    // with references, the clip can still open on its picture: it is given as one more picture and pinned at the first frame
    const opening = !voiceOnly && how.start;
    const files = [...pictures.map((p) => p.file), ...(opening ? [uploads.start] : [])];
    const prompt = h3ReferencePrompt(input, { roles: pictures.map((p) => p.role), videos: videos.map((v) => v.sound), voice: Boolean(input.voice), continues: Boolean(input.previous), opening, voiceOnly });
    start = g.add("MiniMaxH3ReferenceToVideo", {
      clip, vae, audio_vae: audioVae, prompt, width, height, length, ref_image_size: input.sharpRefs ? "max" : "match",
      // inputs of a group that grows are named "<group>.<prefix><n>", counting from 0
      ...Object.fromEntries(files.map((file, i) => [`ref_images.ref_image_${i}`, g.out("LoadImage", { image: file })])),
      ...Object.fromEntries(videos.map((v, i) => [`ref_videos.ref_video_${i}`, [v.parts, 0]])),
      // the sound goes with the video of the same number
      ...Object.fromEntries(videos.flatMap((v, i) => (v.sound ? [[`ref_video_audios.ref_video_audio_${i}`, [v.parts, 1]]] : []))),
      ...(input.voice ? { "ref_audios.ref_audio_0": g.out("LoadAudio", { audio: uploads.voice }) } : {}),
    });
    positive = [start, 0];
    // one frame only: a longer still freezes the opening and the model then jumps to another scene
    if (opening) positive = g.out("MiniMaxH3AddGuide", { positive, vae, audio_vae: audioVae, latent: [start, 1], image: g.out("LoadImage", { image: uploads.start }), frame_idx: 0 });
  } else {
    const mode: H3Mode = how.start ? (how.end ? "both" : "start") : how.end ? "land" : "free";
    const prompt = h3Prompt(mode, seconds, input, input.previous ? { overlap: head / H3_FPS, seconds: ownSeconds, lands: Boolean(input.next) } : undefined);
    start = g.add("MiniMaxH3ImageToVideo", {
      clip, vae, prompt, width, height, length,
      ...(how.start ? { first_frame: g.out("LoadImage", { image: uploads.start }) } : {}),
      ...(how.end ? { last_frame: g.out("LoadImage", { image: uploads.end }) } : {}),
    });
    positive = [start, 0];
    if ((how.start || how.end) && input.upscale === UPSCALE.latent) plain = [g.add("MiniMaxH3ImageToVideo", { clip, vae, prompt, width, height, length }), 0];
  }
  const latent: Ref = window ? [window, 0] : [start, 1];
  // a join: the neighbour's frames and their sound are pinned in place, at the very start or the very end
  const pin = (file: string | undefined, facts: MediaFacts | undefined, at: number) => {
    const parts = g.add("GetVideoComponents", { video: g.out("LoadVideo", { file }) });
    positive = g.out("MiniMaxH3AddGuide", {
      positive, vae, audio_vae: audioVae, latent, image: [parts, 0], frame_idx: at,
      ...(facts?.hasSound === false ? {} : { audio: [parts, 1] }),
    });
  };
  if (window && prev) {
    const tail = { positive, previous_av_latent: prev, target_av_latent: latent, overlap_video_tokens: [window, 2] as Ref, overlap_audio_tokens: [window, 3] as Ref };
    positive = g.out("MiniMaxH3LatentTailGuide", tail);
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
  return { positive, latent, previous: window ? prev : null, plain: plain ?? (how.reference ? positive : [start, 0]) };
}
