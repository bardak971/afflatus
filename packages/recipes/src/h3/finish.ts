import type { BuildContext, BuiltGraph, GraphBuilder, Ref } from "@afflatus/core";
import { UPSCALE } from "../video/upscale";
import { colourMatched, finishFrames } from "../shared/finish";
import { saveVideo } from "../shared/out";
import { H3_FPS } from "./family";
import type { H3Video } from "./inputs";

/** The clip's own sampled window kept beside it, its audio rounded to its frame boundary, for the clips that continue it or land on it. */
export const H3_SAVE_LATENT = ["AfflatusNormalizeH3Latent", "AfflatusSaveH3Latent"];

/**
 * From the finished latent to the files: the frames and the sound decoded, the pixel upscale and the frame
 * interpolation, the result saved (and the model's own frames beside it when they differ), and the sampled
 * latent kept for the clips that continue this one.
 */
export function finish(g: GraphBuilder, ctx: BuildContext, input: H3Video, made: { finished: Ref; sampled: string; fine?: Ref | null; vae: Ref; audioVae: Ref; width: number; height: number }): { outputs: BuiltGraph["outputs"]; loads: string[] } {
  const { finished, sampled, fine, vae, audioVae, width, height } = made;
  const upscaling = input.upscale === UPSCALE.latent;
  g.phase("decoding");
  // the enlarged latent is decoded in tiles and stretches: whole, a doubled 7-second clip asks for tens of GB and falls back to the processor
  const images = input.upscale === UPSCALE.latent
    ? g.out("VAEDecodeTiled", { samples: finished, vae, tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 })
    : g.out("VAEDecode", { samples: finished, vae });
  const audio = g.out("VAEDecodeAudio", { samples: finished, vae: audioVae });
  // the frames as the model made them, before anything changes them: a clip that carries on from this
  // one is guided by these, not by the enlarged or interpolated ones (saved beside the result when they differ)
  const native: Ref = upscaling ? g.out("VAEDecode", { samples: [sampled, 0], vae }) : images;
  const done = finishFrames(g, ctx, colourMatched(g, ctx, images, input), input, { frame: { width, height }, rife: input.smooth, fps: H3_FPS, audio });
  const raw = done.images !== native ? saveVideo(g, ctx, { images: native, audio, fps: H3_FPS, crf: 16 }) : null;
  // the clip's own sampled window, kept beside it for the clips that continue it or land on it: its audio
  // rounded to its own frame boundary first, so that it is a valid clip to continue from
  const kept = H3_SAVE_LATENT.every((n) => ctx.has(n)) ? g.add("AfflatusSaveH3Latent", { samples: g.out("AfflatusNormalizeH3Latent", { samples: [sampled, 0] }), filename_prefix: "Afflatus/h3" }) : null;
  // the latent re-sample's own result, kept for the finish of the clip after (its join decoded as one piece with this)
  const keptFine = kept && fine ? g.add("AfflatusSaveH3Latent", { samples: g.out("AfflatusNormalizeH3Latent", { samples: fine }), filename_prefix: "Afflatus/h3fine" }) : null;
  return {
    outputs: [
      { node: done.out, kind: "video", role: "result" },
      ...(raw ? [{ node: raw, kind: "video" as const, role: "raw" as const }] : []),
      ...(kept ? [{ node: kept, kind: "video" as const, role: "latent" as const }] : []),
      ...(keptFine ? [{ node: keptFine, kind: "video" as const, role: "fine" as const }] : []),
    ],
    loads: done.loads,
  };
}
