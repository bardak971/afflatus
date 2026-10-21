import type { BuildContext, BuiltGraph, GraphBuilder, Ref } from "@afflatus/core";
import { UPSCALE } from "../video/upscale";
import { colourCarried, colourMatched, finishFrames, openingStart } from "../shared/finish";
import { saveVideo } from "../shared/out";
import { faceScore } from "../shared/face";
import { H3_FPS } from "./family";
import type { H3Video } from "./inputs";
import { faceRefined } from "./faceRefine";

/** The clip's own sampled window kept beside it, its audio rounded to its frame boundary, for the clips that continue it or land on it. */
export const H3_SAVE_LATENT = ["AfflatusNormalizeH3Latent", "AfflatusSaveH3Latent"];

/**
 * From the finished latent to the files: the frames and the sound decoded, the pixel upscale and the frame
 * interpolation, the result saved (and the model's own frames beside it when they differ), and the sampled
 * latent kept for the clips that continue this one.
 */
export function finish(g: GraphBuilder, ctx: BuildContext, input: H3Video, made: { finished: Ref; sampled: string; fine?: Ref | null; vae: Ref; audioVae: Ref; clip?: Ref; width: number; height: number; head?: number; sound?: (decoded: Ref) => Ref; frames?: (images: Ref) => Ref }): { outputs: BuiltGraph["outputs"]; loads: string[]; refine: { node: string; steps: number } | null } {
  const { finished, sampled, fine, vae, audioVae, width, height } = made;
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
  // the faces redrawn at their own size, and RIFE then makes its in-between frames from the refined ones
  const faces = made.clip ? faceRefined(g, ctx, input, decodedImages, { audio, vae, audioVae, clip: made.clip }) : { images: decodedImages, pass: null, loads: [] };
  const { images } = faces;
  const refined = Boolean(faces.pass);
  // the frames as the model made them, before anything changes them: a clip that carries on from this
  // one is guided by these, not by the enlarged or interpolated ones (saved beside the result when they differ)
  const native: Ref = upscaling ? g.out("VAEDecode", { samples: [sampled, 0], vae }) : images;
  // matched to the first frame (a clip that opens a chain), or carrying that match on (one that continues it: its run-up's last
  // frame is the clip before's last moment)
  const looked = colourCarried(g, ctx, colourMatched(g, ctx, images, openingStart(input)), (made.head ?? 0) - 1);
  const done = finishFrames(g, ctx, looked, input, { frame: { width, height }, rife: input.smooth, fps: H3_FPS, audio });
  const raw = done.images !== native ? saveVideo(g, ctx, { images: native, audio, fps: H3_FPS, crf: 16 }) : null;
  // the clip's own sampled window, kept beside it for the clips that continue it or land on it: its audio
  // rounded to its own frame boundary first, so that it is a valid clip to continue from
  // with its faces refined, the kept latent is the refined frames encoded, the sampled sound kept as it is: the clip after
  // carries on from the faces this clip shows (after the latent re-sample, the frames are larger than the sampled latent,
  // which is kept as it was)
  const keptFrom: Ref = refined && !upscaling ? g.out("H3InjectVideoLatent", { av_latent: [sampled, 0], images, vae }) : [sampled, 0];
  const kept = H3_SAVE_LATENT.every((n) => ctx.has(n)) ? g.add("AfflatusSaveH3Latent", { samples: g.out("AfflatusNormalizeH3Latent", { samples: keptFrom }), filename_prefix: "Afflatus/h3" }) : null;
  // the latent re-sample's own result, kept for the finish of the clip after (its join decoded as one piece with this)
  const keptFine = kept && fine ? g.add("AfflatusSaveH3Latent", { samples: g.out("AfflatusNormalizeH3Latent", { samples: fine }), filename_prefix: "Afflatus/h3fine" }) : null;
  return {
    outputs: [
      { node: done.out, kind: "video", role: "result" },
      ...(raw ? [{ node: raw, kind: "video" as const, role: "raw" as const }] : []),
      ...(kept ? [{ node: kept, kind: "video" as const, role: "latent" as const }] : []),
      ...(keptFine ? [{ node: keptFine, kind: "video" as const, role: "fine" as const }] : []),
      // the face along the clip against its people's pictures (the cast): drift along a run of clips is flagged on the timeline
      ...faceScore(g, ctx, native, (input.references ?? []).flatMap((r, i) => (r.role === "person" && ctx.uploads[`references.${i}`] ? [g.out("LoadImage", { image: ctx.uploads[`references.${i}`] })] : []))),
    ],
    loads: [...done.loads, ...faces.loads],
    refine: faces.pass,
  };
}
