import { frameOf, gridAtOrBefore, type BuildContext, type ClipValue, type FrameGrid, type GraphBuilder, type InputSpec, type LoraValue, type Ref } from "@afflatus/core";
import { finishFrames } from "../shared/finish";
import { UPSCALE } from "../video/upscale";

/**
 * Motion transfer, whatever model makes it: a picture made to move like a driving video. Everything seen comes from the
 * picture (its room, its light, its people); only the motion comes from the video. What every model's form shares is
 * here: the picture, the driving video's part, the prompt, the size, and how the clip is finished (RIFE, matched to the
 * driving video, its sound). The meme test (2026-10-14, HANDOVER-swap-lipsync-plan.md §9.2) is where these come from.
 */
export interface MotionValues {
  picture?: string;
  driving?: ClipValue;
  drivingStart: number;
  drivingSeconds: number;
  prompt: string;
  short: number;
  smooth: boolean;
  matchDriving: boolean;
  keepSound: boolean;
  crf: number;
  loras: LoraValue[];
}

/** Every Wan-made chunk is 4k + 1 frames long, and so is a clip of chunks joined over their carried frames. */
export const MOTION_GRID: FrameGrid = { step: 4, offset: 1 };

/** How a model takes the driving video: at what speed, how much of it one job makes (all its chunks), the shortest part. */
export interface MotionShape {
  fps: number;
  most: number;
  least: number;
}

/** The inputs every Motion transfer form opens with: the picture, the driving video and its part, the prompt, the size. */
export function motionInputs(shape: MotionShape): InputSpec[] {
  const most = shape.most / shape.fps;
  return [
    {
      id: "picture", type: "image", role: "source", label: "Picture",
      note: "what moves. Its room, its light and its people are kept: only the motion comes from the video. Front-facing works best",
    },
    {
      id: "driving", type: "clip", role: "source", label: "Driving video", frames: [shape.most], fps: shape.fps, whole: true,
      window: { start: "drivingStart", seconds: "drivingSeconds", fits: { frames: shape.most, fps: shape.fps, pad: 0, min: shape.least / shape.fps, grid: MOTION_GRID } },
      note: `how it moves: the body, the hands, the face. One job takes ${Math.floor(most)} s of it; a longer video goes on a timeline, part by part`,
    },
    { id: "drivingStart", type: "number", label: "Driving video: start", min: 0, max: 3600, step: 0.1, default: 0, unit: " s", showWhen: "driving" },
    { id: "drivingSeconds", type: "number", label: "Driving video: length", min: 1, max: Math.floor(most * 10) / 10, step: 0.1, default: 5, unit: " s", showWhen: "driving" },
    {
      id: "prompt", type: "prompt", label: "Prompt", style: "sentences", optional: true,
      placeholder: "A man in a black t-shirt raps to the camera in a crowded room lit by red light, moving his hands to the beat.",
      note: "what the picture shows, in sentences: optional, it helps the model keep what is there",
    },
    {
      id: "short", type: "number", label: "Resolution", min: 320, max: 1088, step: 32, default: 576, unit: "p", picks: [480, 576, 720],
      note: "the short side of the clip, in the picture's shape. 576p held the face better than 480p on the meme test, at nearly twice the time",
    },
  ];
}

/** How a Motion transfer clip is finished, on every model's form. */
export const MOTION_OUT_INPUTS: InputSpec[] = [
  { id: "smooth", type: "toggle", label: "RIFE ×2", default: true, advanced: true, note: "frame interpolation: frames interpolated with RIFE, 32 a second in place of 16" },
  {
    id: "matchDriving", type: "toggle", label: "Match the driving video", default: true, advanced: true,
    note: "the clip brought to the driving video's look: its colours and brightness (ComfyUI's ColorTransfer), its size, and a touch of its softness and grain. What makes a phone video's copy look like a phone video and not like a render. Not an upscale: the timeline's Finish is one",
  },
  { id: "keepSound", type: "toggle", label: "Keep the driving video's sound", default: true, advanced: true, note: "the file carries the driving video's own sound over its part" },
  { id: "crf", type: "number", label: "CRF", min: 0, max: 40, step: 1, default: 19, advanced: true, note: "how hard the video file is compressed: lower is better and larger" },
  { id: "loras", type: "loras", label: "LoRAs", max: 4 },
  { id: "seed", type: "seed", label: "Seed" },
];

/** The node classes the shared part needs, and those it uses only when there. */
export const MOTION_NODES = ["LoadImage", "LoadVideo", "GetVideoComponents", "ImageScale"];
export const MOTION_OPTIONAL = ["ColorTransfer", "ImageBlur", "ImageAddNoise", "TrimAudioDuration", "FrameInterpolationModelLoader", "FrameInterpolate"];

/** The clip's frame: the picture's shape at `short` on its short side, on the grid the model takes. */
export function motionCanvas(input: MotionValues, ctx: BuildContext, grid: number): { width: number; height: number } {
  const picture = ctx.media.picture;
  const shape = picture?.width && picture.height ? picture : { width: 576, height: 1024 };
  return frameOf(shape, input.short, { grid, maxPixels: 1088 * 1920 });
}

/** How many frames the job makes: the part handed over (or asked for), floored to the model's grid, within its limits. */
export function motionFrames(input: MotionValues, ctx: Pick<BuildContext, "media">, shape: MotionShape): number {
  const have = ctx.media.driving?.frames ?? Math.round(input.drivingSeconds * shape.fps);
  return Math.max(shape.least, gridAtOrBefore(Math.min(shape.most, have), MOTION_GRID));
}

/**
 * The chunks a job is made in: `chunk` frames each, every one after the first carrying `carried` frames of the one before
 * (they are dropped when the chunks are joined), the last one shorter when the part ends sooner. Their new frames add up
 * to `total` (a tail of fewer than 4 new frames is left out: a chunk is at least 9 frames).
 */
export function chunkLengths(total: number, chunk: number, carried: number): number[] {
  const floored = (n: number) => Math.floor((n - 1) / 4) * 4 + 1;
  const out = [Math.min(chunk, floored(Math.max(5, total)))];
  let left = total - out[0]!;
  while (left >= 4) {
    const length = Math.min(chunk, floored(left + carried));
    out.push(length);
    left -= length - carried;
  }
  return out;
}

/** The driving video's part, as frames of the clip's own size (cut to its shape from the centre), and its components (frames, sound). */
export function drivingFrames(g: GraphBuilder, ctx: BuildContext, frame: { width: number; height: number }): { frames: Ref; parts: string } {
  const parts = g.add("GetVideoComponents", { video: g.out("LoadVideo", { file: ctx.uploads.driving }) });
  return { parts, frames: g.out("ImageScale", { image: [parts, 0], upscale_method: "area", width: frame.width, height: frame.height, crop: "center" }) };
}

/**
 * The clip brought to the driving video's look, when asked and the nodes are there: its colours and brightness pooled over the
 * whole clip (one transform, nothing pumps), a touch of its softness and grain, and its size on the clip's short side. On the
 * meme test the render was darker and cleaner than the phone video it copied, which read as a render (YAVG 50 against 69).
 */
export function matchedToDriving(g: GraphBuilder, ctx: BuildContext, images: Ref, driving: Ref, input: MotionValues, frame: { width: number; height: number }): Ref {
  if (!input.matchDriving) return images;
  if (ctx.has("ColorTransfer")) images = g.out("ColorTransfer", { image_target: images, image_ref: driving, method: "reinhard_lab", source_stats: "uniform", strength: 1 });
  if (ctx.has("ImageBlur")) images = g.out("ImageBlur", { image: images, blur_radius: 1, sigma: 0.6 });
  if (ctx.has("ImageAddNoise")) images = g.out("ImageAddNoise", { image: images, seed: ctx.seed, strength: 0.02 });
  // a small phone video's size: the clip is not made larger than it was made, only smaller
  const own = ctx.media.driving;
  const short = own?.width && own.height ? Math.min(own.width, own.height) : 0;
  if (short && short < Math.min(frame.width, frame.height)) {
    const to = frameOf(frame, short, { grid: 2, maxPixels: frame.width * frame.height });
    images = g.out("ImageScale", { image: images, upscale_method: "lanczos", width: to.width, height: to.height, crop: "disabled" });
  }
  return images;
}

/** The clip saved: RIFE ×2 when asked, with the driving video's own sound over its part when kept and it has some. */
export function motionSaved(g: GraphBuilder, ctx: BuildContext, images: Ref, input: MotionValues, at: { frame: { width: number; height: number }; fps: number; frames: number; parts: string }) {
  const sound = input.keepSound && Boolean(ctx.media.driving?.hasSound) && ctx.has("TrimAudioDuration")
    ? g.out("TrimAudioDuration", { audio: [at.parts, 1], start_index: 0, duration: at.frames / at.fps })
    : undefined;
  return finishFrames(g, ctx, images, { upscale: UPSCALE.off, upscaleBy: 1, upscaleModel: "", crf: input.crf }, { frame: at.frame, rife: input.smooth, fps: at.fps, ...(sound ? { audio: sound } : {}) });
}
