import type { BuildContext, GraphBuilder, Ref } from "@afflatus/core";
import { pixelUpscale, UPSCALE, type UpscaleValues } from "../video/upscale";
import { saveVideo } from "./out";

/**
 * From a video family's decoded frames to its saved clip, the same in each: SeedVR2 and an upscale model go
 * before the frame interpolation (their cost grows with the frame count, and an upscale model would enlarge
 * RIFE's made-up frames too), RIFE ×2 when it is asked for and there, the other pixel routes after it, on the
 * final frames; then the clip is saved, at twice the rate when its frames were doubled (by RIFE here, or
 * already by the family: `doubled`). What comes out: the final frames, the saver, what was loaded, and whether
 * RIFE ran.
 */
export function finishFrames(
  g: GraphBuilder, ctx: BuildContext, images: Ref, input: UpscaleValues & { crf: number },
  opts: { frame: { width: number; height: number }; rife: boolean; fps: number; audio?: Ref; doubled?: boolean },
): { images: Ref; out: string; loads: string[]; smooth: boolean } {
  const { slots } = ctx;
  const early = input.upscale === UPSCALE.seedvr || input.upscale === UPSCALE.model;
  const pixel = early ? pixelUpscale(g, images, input, opts.frame, ctx) : null;
  if (pixel) images = pixel.images;
  const smooth = opts.rife && Boolean(slots.rife) && ctx.has("FrameInterpolate") && ctx.has("FrameInterpolationModelLoader");
  if (smooth) {
    g.phase("interpolating");
    images = g.out("FrameInterpolate", { interp_model: g.out("FrameInterpolationModelLoader", { model_name: slots.rife }), images, multiplier: 2 });
  }
  const late = pixel ?? pixelUpscale(g, images, input, opts.frame, ctx);
  // the route ran before the interpolation already: its frames were interpolated above (taken again here, the interpolation was
  // lost and the file, saved at twice the rate, played twice as fast)
  if (!pixel) images = late.images;
  g.phase("encoding");
  const out = saveVideo(g, ctx, { images, ...(opts.audio ? { audio: opts.audio } : {}), fps: smooth || opts.doubled ? opts.fps * 2 : opts.fps, crf: input.crf });
  return { images, out, loads: late.loads, smooth };
}
