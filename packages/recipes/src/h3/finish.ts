import type { BuildContext, BuiltGraph, GraphBuilder, Ref } from "@afflatus/core";
import { UPSCALE } from "../video/upscale";
import { colourCarried, colourMatched, finishFrames, openingStart } from "../shared/finish";
import { saveVideo } from "../shared/out";
import { facePhotos, faceScore } from "../shared/face";
import { H3_FPS } from "./family";
import { H3_RUN_ANCHOR } from "./join";
import type { H3Video } from "./inputs";
import { faceRefined, holdsFace, INJECT_REGION, openingPicture, type ClipModel } from "./faceRefine";

/** The clip's own sampled window kept beside it, its audio rounded to its frame boundary, for the clips that continue it or land on it. */
export const H3_SAVE_LATENT = ["AfflatusNormalizeH3Latent", "AfflatusSaveH3Latent"];

/**
 * From the finished latent to the files: the frames and the sound decoded, the pixel upscale and the frame
 * interpolation, the result saved (and the model's own frames beside it when they differ), and the sampled
 * latent kept for the clips that continue this one (`sampledWindow`: held at the clip before's contrast when it continues one).
 */
export function finish(g: GraphBuilder, ctx: BuildContext, input: H3Video, made: { finished: Ref; sampledWindow: Ref; fine?: Ref | null; vae: Ref; audioVae: Ref; clip?: Ref; free?: string | null; model?: ClipModel; width: number; height: number; head?: number; sound?: (decoded: Ref) => Ref; frames?: (images: Ref) => Ref }): { outputs: BuiltGraph["outputs"]; loads: string[]; refine: { node: string; steps: number } | null; said: string | null } {
  const { finished, sampledWindow, fine, vae, audioVae, width, height } = made;
  const upscaling = input.upscale === UPSCALE.latent;
  g.phase("decoding");
  // the enlarged latent is decoded in tiles and stretches: whole, a doubled 7-second clip asks for tens of GB and falls back to the processor
  // a swap's paste-back works on the frames at the size they were sampled: after the latent re-sample (larger, every pixel
  // redrawn again) there is nothing of the source left to paste, and its mask would not fit
  const decodedImages = input.upscale === UPSCALE.latent
    ? g.out("VAEDecodeTiled", { samples: finished, vae, tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 })
    : (made.frames ?? ((decodedFrames: Ref) => decodedFrames))(g.out("VAEDecode", { samples: finished, vae }));
  const decoded = g.out("VAEDecodeAudio", { samples: finished, vae: audioVae });
  // a lip sync's files carry the recording itself, not the model's decoding of it (the latent kept for the clips after stays the model's)
  const audio = made.sound ? made.sound(decoded) : decoded;
  // Face refine, on the frames as the clip keeps them (a swap's after its paste-back), before anything enlarges or interpolates them:
  // the faces redrawn at their own size, and RIFE then makes its in-between frames from the refined ones. Without a cast person,
  // towards the picture the clip opens on (a Motion transfer's Picture, a First frame), as on the LTX and SCAIL forms (R1)
  const opening = openingPicture(input, ctx);
  const faces = made.clip ? faceRefined(g, ctx, input, decodedImages, { audio, vae, audioVae, clip: made.clip, free: made.free, model: made.model, picture: opening, only: Boolean(input.faceRefineOnly) && !upscaling, carried: holdsFace(input) }) : { images: decodedImages, pass: null, loads: [], said: null };
  const { images } = faces;
  const refined = Boolean(faces.pass);
  // the frames as the model made them, before anything changes them: a clip that carries on from this
  // one is guided by these, not by the enlarged or interpolated ones (saved beside the result when they differ)
  const native: Ref = upscaling ? g.out("VAEDecode", { samples: sampledWindow, vae }) : images;
  // matched to the first frame (a clip that opens a chain), or carrying that match on (one that continues it: its run-up's last
  // frame is the clip before's last moment)
  const looked = colourCarried(g, ctx, colourMatched(g, ctx, images, openingStart(input), H3_FPS), (made.head ?? 0) - 1, H3_FPS);
  const done = finishFrames(g, ctx, looked, input, { frame: { width, height }, rife: input.smooth, fps: H3_FPS, audio });
  const raw = done.images !== native ? saveVideo(g, ctx, { images: native, audio, fps: H3_FPS, crf: 16 }) : null;
  // the clip's own sampled window, kept beside it for the clips that continue it or land on it: its audio
  // rounded to its own frame boundary first, so that it is a valid clip to continue from
  // with its faces refined, the kept latent is the refined frames encoded, the sampled sound kept as it is: the clip after
  // carries on from the faces this clip shows (after the latent re-sample, the frames are larger than the sampled latent,
  // which is kept as it was)
  // (the face's region alone where the pack has it, card #225: the rest of the frame is the sampled window's own tokens, not
  // decoded and encoded again, and the whole re-encode took ~17 s of a 720p continuation on the owner's PC)
  const keptFrom: Ref = !refined || upscaling ? sampledWindow
    : ctx.has(INJECT_REGION) ? g.out(INJECT_REGION, { av_latent: sampledWindow, base_images: decodedImages, images, vae, margin: 64 })
    : g.out("H3InjectVideoLatent", { av_latent: sampledWindow, images, vae });
  // the re-encode hands on its samples alone: the run's look and the run-up width are taken from the window it was made from
  // (pack 0.46.0, which brings Run Anchor), so that the clip after is still held to the run's first clip
  const figuresFrom = keptFrom !== sampledWindow && ctx.has(H3_RUN_ANCHOR) ? { figures_from: sampledWindow } : {};
  const kept = H3_SAVE_LATENT.every((n) => ctx.has(n)) ? g.add("AfflatusSaveH3Latent", { samples: g.out("AfflatusNormalizeH3Latent", { samples: keptFrom, ...figuresFrom }), filename_prefix: "Afflatus/h3" }) : null;
  // the latent re-sample's own result, kept for the finish of the clip after (its join decoded as one piece with this)
  const keptFine = kept && fine ? g.add("AfflatusSaveH3Latent", { samples: g.out("AfflatusNormalizeH3Latent", { samples: fine }), filename_prefix: "Afflatus/h3fine" }) : null;
  return {
    outputs: [
      { node: done.out, kind: "video", role: "result" },
      ...(raw ? [{ node: raw, kind: "video" as const, role: "raw" as const }] : []),
      ...(kept ? [{ node: kept, kind: "video" as const, role: "latent" as const }] : []),
      ...(keptFine ? [{ node: keptFine, kind: "video" as const, role: "fine" as const }] : []),
      // the face along the clip against its people's pictures (the cast's, else the picture it opens on, as Face refine's): drift
      // along a run of clips is flagged on the timeline
      ...faceScore(g, ctx, native, facePhotos(g, ctx, { references: input.references, opens: Boolean(opening) })),
    ],
    loads: [...done.loads, ...faces.loads],
    refine: faces.pass,
    said: faces.said,
  };
}
