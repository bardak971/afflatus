import type { BuildContext, GraphBuilder, InputSpec, Ref } from "@afflatus/core";
import { pixelUpscale, sharpened, UPSCALE, type UpscaleValues } from "../video/upscale";
import { saveVideo } from "./out";

/**
 * Where RIFE is had: rife_v4.26 repackaged for ComfyUI's own frame interpolation (models/frame_interpolation), byte for byte
 * the file the owner's ComfyUI runs (SHA-256 1518745…317c94, 2026-10-18), under its originals' MIT and Apache 2.0 licences.
 * Every video offers "RIFE ×2": a pod had no way to get it, and rendered at half the rate without a word.
 */
export const RIFE_GET = { file: "rife_v4.26.safetensors", url: "https://huggingface.co/sisniha/frame_interpolation/resolve/main/frame_interpolation/rife_v4.26.safetensors" };

/** RIFE, for a render that interpolates with it (Recipe.needsWith): a pod is sent it for that job only, never for one with it off. */
export const rifeNeeds = (wanted: boolean | undefined): string[] => (wanted ? ["rife"] : []);

/** What a render that asked for RIFE and could not run it says on its job (it stays at the model's rate); null otherwise. */
/** Whether RIFE runs for a form that asks for it: its model and its nodes on this ComfyUI (finishFrames, rifeSkippedSaid). */
export const rifeRuns = (wanted: boolean | undefined, ctx: Pick<BuildContext, "slots" | "has">) => Boolean(wanted) && Boolean(ctx.slots.rife) && ctx.has("FrameInterpolate") && ctx.has("FrameInterpolationModelLoader");

export function rifeSkippedSaid(wanted: boolean | undefined, ctx: Pick<BuildContext, "slots" | "has">): string | null {
  if (!wanted) return null;
  if (!ctx.slots.rife) return "Not interpolated: no RIFE model on this ComfyUI (models/frame_interpolation; Settings › Models has it).";
  if (!ctx.has("FrameInterpolate") || !ctx.has("FrameInterpolationModelLoader")) return "Not interpolated: this ComfyUI has no frame interpolation nodes (a newer ComfyUI has them).";
  return null;
}

/** The colour match to the start picture, on the forms of the families that take one. */
export interface ColourMatch {
  colourMatch: boolean;
  colourStrength: number;
}
export const COLOUR_MATCH_INPUTS: InputSpec[] = [
  {
    id: "colourMatch", type: "toggle", label: "Colour match to the first frame", default: false, showWhen: "start", advanced: true, section: "out",
    note: "pulls the clip's colours back to the start picture's when they drift (ComfyUI's ColorTransfer, Reinhard in Lab, one transform for the whole clip so nothing pumps). Off by default: it also damps a grade or a light change the clip means to make",
  },
  { id: "colourStrength", type: "number", label: "Colour match strength", min: 0.1, max: 1, step: 0.05, default: 0.75, showWhen: "colourMatch", advanced: true, section: "out" },
];
/** A form's colour match with its start picture only when the clip opens on it: not when it carries on from a previous clip. */
export const openingStart = <T extends Partial<ColourMatch> & { start?: string; previous?: unknown }>(input: T): Partial<ColourMatch> & { start?: string } =>
  ({ colourMatch: input.colourMatch, colourStrength: input.colourStrength, start: input.previous ? undefined : input.start });
/** The node the colour match brings in: ComfyUI's own, optional on older ComfyUIs. */
export const COLOUR_MATCH_NODES = ["ColorTransfer"];

/**
 * The frames' colours pulled towards the start picture's: one transform pooled over every frame (`uniform`),
 * so a clip does not flicker the way a per-frame match does, and nothing when it is off, there is no start
 * picture, or this ComfyUI has no ColorTransfer. `start` is the picture the clip opens on: a clip carrying on from a
 * previous one does not (H3 and LTX leave it out then, see `openingStart`), and matched to it would jump in colour at the join.
 */
export function colourMatched(g: GraphBuilder, ctx: BuildContext, images: Ref, input: Partial<ColourMatch> & { start?: string }): Ref {
  const start = input.start ? ctx.uploads.start : undefined;
  if (!input.colourMatch || !start || !ctx.has("ColorTransfer")) return images;
  const ref = g.out("LoadImage", { image: start });
  return g.out("ColorTransfer", { image_target: images, image_ref: ref, method: "reinhard_lab", source_stats: "uniform", strength: input.colourStrength ?? 0.75 });
}

/**
 * From a video family's decoded frames to its saved clip, the same in each: SeedVR2 and an upscale model go
 * before the frame interpolation (their cost grows with the frame count, and an upscale model would enlarge
 * RIFE's made-up frames too), RIFE ×2 when it is asked for and there, the other pixel routes after it, on the
 * final frames; the RCAS sharpen when one was asked for after a pixel route; then the clip is saved, at twice the rate when its frames were doubled (by RIFE here, or
 * already by the family: `doubled`). What comes out: the final frames, the saver, what was loaded, and whether
 * RIFE ran.
 */
export function finishFrames(
  g: GraphBuilder, ctx: BuildContext, images: Ref, input: UpscaleValues & { crf: number },
  opts: {
    frame: { width: number; height: number }; rife: boolean; fps: number; audio?: Ref; doubled?: boolean;
    /** What is done to the final frames before they are saved (Motion transfer's grain). */
    last?: (images: Ref) => Ref;
  },
): { images: Ref; out: string; loads: string[]; smooth: boolean } {
  const { slots } = ctx;
  const early = input.upscale === UPSCALE.seedvr || input.upscale === UPSCALE.model;
  const pixel = early ? pixelUpscale(g, images, input, opts.frame, ctx) : null;
  if (pixel) images = pixel.images;
  const smooth = rifeRuns(opts.rife, ctx);
  if (smooth) {
    g.phase("interpolating");
    images = g.out("FrameInterpolate", { interp_model: g.out("FrameInterpolationModelLoader", { model_name: slots.rife }), images, multiplier: 2 });
  }
  const late = pixel ?? pixelUpscale(g, images, input, opts.frame, ctx);
  // the route ran before the interpolation already: its frames were interpolated above (taken again here, the interpolation was
  // lost and the file, saved at twice the rate, played twice as fast)
  if (!pixel) images = late.images;
  // once, on the final frames, whichever side of the interpolation the route ran: RIFE's made-up frames are sharpened as their neighbours are
  images = sharpened(g, ctx, images, input);
  if (opts.last) images = opts.last(images);
  g.phase("encoding");
  const out = saveVideo(g, ctx, { images, ...(opts.audio ? { audio: opts.audio } : {}), fps: smooth || opts.doubled ? opts.fps * 2 : opts.fps, crf: input.crf });
  return { images, out, loads: late.loads, smooth };
}
