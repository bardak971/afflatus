import { frameOf, gridAtOrBefore, type BuildContext, type ClipValue, type FrameGrid, type GraphBuilder, type InputSpec, type LoraValue, type Ref } from "@afflatus/core";
import { finishFrames } from "../shared/finish";
import { saveVideo } from "../shared/out";
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
  /** The clip this one carries on from (on a timeline, the window before): its last frames start this one. */
  previous?: ClipValue;
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
  /** The frame counts a job makes (MOTION_GRID when left out); SCAIL-2 at 24 fps: the counts on both its grid and H3's. */
  grid?: FrameGrid;
  /** The part's length a form starts on (5 s when left out): on a sparse grid, a length it makes whole (5 s at 24 fps on H3's grid makes 3). */
  seconds?: number;
}

/**
 * The lengths a window-by-window form's part field takes, in seconds on steps of 0.01: from the fewest frames a job makes
 * (a timeline's last window, or one ended by a scene cut, can be short) to the most and the half frame a timeline's windows
 * add (sourceWindows.ts), so that every window it makes is taken. Floored to a tenth the most refused every window of a
 * model of 81 frames at 24 fps (3.3958 s against 3.3) and never reached its 81 frames. The most is on the field's steps
 * from the least, so that the slider's end reaches it.
 */
export function partBounds(shape: MotionShape): { least: number; most: number } {
  const hundredths = (s: number) => Math.round(s * 100) / 100;
  const least = Math.ceil((shape.least / shape.fps) * 100) / 100;
  return { least, most: hundredths(least + Math.ceil(((shape.most + 0.5) / shape.fps - least) * 100 - 1e-6) / 100) };
}

/** The inputs every Motion transfer form opens with: the picture, the driving video and its part, the prompt, the size. */
export function motionInputs(shape: MotionShape, placeholder = "A man in a black t-shirt and a silver watch stands in a crowded room lit by red light. He raps to the camera, moving his hands to the beat."): InputSpec[] {
  // the most one job takes, in tenths of a second as the note says it
  const said = Math.floor((shape.most / shape.fps) * 10) / 10;
  const { least, most } = partBounds(shape);
  return [
    // the driving video first: it says where the clip starts, and which of its frames a picture is made from
    {
      id: "driving", type: "clip", role: "source", label: "Driving video", frames: [shape.most], fps: shape.fps, whole: true,
      window: { start: "drivingStart", seconds: "drivingSeconds", fits: { frames: shape.most, fps: shape.fps, pad: 0, min: shape.least / shape.fps, grid: shape.grid ?? MOTION_GRID } },
      note: `how it moves: the body, the hands, the face. One job takes ${said} s of it; a longer video goes on a timeline, part by part`,
    },
    { id: "drivingStart", type: "number", label: "Driving video: start", min: 0, max: 3600, step: 0.1, default: 0, unit: " s", showWhen: "driving" },
    { id: "drivingSeconds", type: "number", label: "Driving video: length", min: least, max: most, step: 0.01, default: Math.min(shape.seconds ?? 5, said), unit: " s", showWhen: "driving" },
    {
      id: "picture", type: "image", role: "source", label: "Picture",
      note: "what moves. Its room, its light and its people are kept: only the motion comes from the video. Front-facing works best, in the driving video's own shape: the video is cut to the picture's shape from the centre, and a video of another shape loses its edges",
    },
    {
      // the cast is not written into it: on this form the cast is who goes into a picture made from the video (motionPicture.tsx)
      id: "prompt", type: "prompt", label: "Prompt", style: "sentences", optional: true, noCast: true, designed: true,
      placeholder,
      note: "what the picture shows, in sentences: optional, it helps the model keep what is there",
    },
    {
      id: "short", type: "number", label: "Resolution", min: 320, max: 1088, step: 32, default: 576, unit: "p", picks: [480, 576, 704],
      note: "the short side of the clip, in the picture's shape, on the 32 px grid (704p is SCAIL-2's own high setting). 576p held the face better than 480p on the meme test, at nearly twice the time",
    },
  ];
}

/**
 * How a Motion transfer clip is finished, on every model's form. `fps`: the model's own rate, which RIFE doubles; at 16 it
 * is on by default, at a video's own 24 off (the clip already plays as smoothly as the driving video).
 */
export function motionOutInputs(fps: number): InputSpec[] {
  return [
  { id: "smooth", type: "toggle", label: "RIFE ×2", default: fps < 20, advanced: true, note: `frame interpolation: frames interpolated with RIFE, ${fps * 2} a second in place of ${fps}` },
  {
    id: "matchDriving", type: "toggle", label: "Match the driving video", default: true, advanced: true,
    note: "the clip brought to the driving video's look: its colours and brightness (ComfyUI's ColorTransfer), its size, and a touch of its softness and grain. What makes a phone video's copy look like a phone video and not like a render. Not an upscale: the timeline's Finish is one",
  },
  { id: "keepSound", type: "toggle", label: "Keep the driving video's sound", default: true, advanced: true, note: "the file carries the driving video's own sound over its part" },
  { id: "crf", type: "number", label: "CRF", min: 0, max: 40, step: 1, default: 19, advanced: true, note: "how hard the video file is compressed: lower is better and larger" },
  { id: "loras", type: "loras", label: "LoRAs", max: 4 },
  { id: "seed", type: "seed", label: "Seed" },
  ];
}

/**
 * The clip before, which this one carries on from: its last `carried` frames, handed over at the model's speed, start it, and
 * are dropped from what it makes. Its driving video's part then starts where that clip's ended (the carried frames overlap).
 */
export function previousInput(fps: number, carried: number): InputSpec {
  return {
    id: "previous", type: "clip", role: "previous", label: "Previous clip", optional: true, frames: [carried], fps, advanced: true, look: true,
    note: `a clip this one carries on from, from its last frame${carried > 1 ? "s" : ""}: on a timeline, the window before. Start the driving video's part where that clip's ended`,
  };
}

/** The clip before's frames as handed over, or null without one. */
export function previousFrames(g: GraphBuilder, ctx: BuildContext): Ref | null {
  if (!ctx.uploads.previous) return null;
  return [g.add("GetVideoComponents", { video: g.out("LoadVideo", { file: ctx.uploads.previous }) }), 0];
}

/** The node classes the shared part needs, and those it uses only when there. */
export const MOTION_NODES = ["LoadImage", "LoadVideo", "GetVideoComponents", "ImageScale"];
export const MOTION_OPTIONAL = ["ColorTransfer", "ImageBlur", "ImageAddNoise", "TrimAudioDuration", "FrameInterpolationModelLoader", "FrameInterpolate"];
/** The batch nodes RIFE's last frame held takes (motionSaved), and the match to the clip before's look (matchedToDriving). */
export const motionBatchNodes = (input: Pick<MotionValues, "smooth" | "previous" | "matchDriving">) =>
  input.smooth || (input.previous && input.matchDriving) ? ["ImageBatch", "ImageFromBatch"] : [];

/** The clip's frame: a timeline's (its clips share one frame), else the picture's shape at `short` on its short side; on the grid the model takes. */
export function motionCanvas(input: MotionValues, ctx: BuildContext, grid: number): { width: number; height: number } {
  if (ctx.canvas) return frameOf(ctx.canvas, Math.min(ctx.canvas.width, ctx.canvas.height, input.short), { grid, maxPixels: 1088 * 1920 });
  const picture = ctx.media.picture;
  const shape = picture?.width && picture.height ? picture : { width: 576, height: 1024 };
  return frameOf(shape, input.short, { grid, maxPixels: 1088 * 1920 });
}

/** How many frames the job makes: the part handed over (or asked for), floored to the model's grid, within its limits. */
export function motionFrames(input: MotionValues, ctx: Pick<BuildContext, "media">, shape: MotionShape): number {
  const have = ctx.media.driving?.frames ?? Math.round(input.drivingSeconds * shape.fps);
  return Math.max(shape.least, gridAtOrBefore(Math.min(shape.most, have), shape.grid ?? MOTION_GRID));
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

/** A touch of the driving video's softness. */
const softened = (g: GraphBuilder, ctx: BuildContext, images: Ref) => (ctx.has("ImageBlur") ? g.out("ImageBlur", { image: images, blur_radius: 1, sigma: 0.6 }) : images);
/** A touch of its grain: last, on the frames as they are filed (RIFE in between made it shimmer at half the rate). */
const grained = (g: GraphBuilder, ctx: BuildContext, images: Ref) => (ctx.has("ImageAddNoise") ? g.out("ImageAddNoise", { image: images, seed: ctx.seed, strength: 0.02 }) : images);

/**
 * The clip brought to the driving video's look, when asked and the nodes are there: its colours and brightness pooled over the
 * whole clip (one transform, nothing pumps), a touch of its softness, and its size on the clip's short side; its grain goes on
 * as it is filed (motionSaved). On the meme test the render was darker and cleaner than the phone video it copied, which read
 * as a render (YAVG 50 against 69).
 */
export function matchedToDriving(g: GraphBuilder, ctx: BuildContext, images: Ref, driving: Ref, input: MotionValues, frame: { width: number; height: number }): Ref {
  if (!input.matchDriving) return images;
  const look = ctx.uploads.previous ? ctx.uploads["previous.look"] : undefined;
  if (ctx.has("ColorTransfer") && look) {
    // carrying on, it takes the transform the clip before was filed with, not one of its own: pooled over each window's own
    // part, two windows got two transforms and each join stepped in colour. That transform is read where the two meet, from
    // this clip's first frame (softened and grained as the clip before's last was when filed) to that last frame as filed,
    // and applied to the whole clip as one; the model holds its first frame to the frames handed over, so it is the same
    // transform, window after window, and a window that opens a shot matches the driving video again
    const first = grained(g, ctx, softened(g, ctx, g.out("ImageFromBatch", { image: images, batch_index: 0, length: 1 })));
    const matched = g.out("ColorTransfer", {
      image_target: g.out("ImageBatch", { image1: first, image2: images }), image_ref: g.out("LoadImage", { image: look }),
      method: "reinhard_lab", source_stats: "target_frame", "source_stats.target_index": 0, strength: 1,
    });
    images = g.out("ImageFromBatch", { image: matched, batch_index: 1, length: 4096 });
  } else if (ctx.has("ColorTransfer")) {
    images = g.out("ColorTransfer", { image_target: images, image_ref: driving, method: "reinhard_lab", source_stats: "uniform", strength: 1 });
  }
  images = softened(g, ctx, images);
  // a small phone video's size: the clip is not made larger than it was made, only smaller
  const own = ctx.media.driving;
  const short = own?.width && own.height ? Math.min(own.width, own.height) : 0;
  if (short && short < Math.min(frame.width, frame.height)) {
    const to = frameOf(frame, short, { grid: 2, maxPixels: frame.width * frame.height });
    images = g.out("ImageScale", { image: images, upscale_method: "lanczos", width: to.width, height: to.height, crop: "disabled" });
  }
  return images;
}

/**
 * The driving video's own sound over the clip's frames, when kept and it has some: carrying on from a clip before, its first
 * `carried` frames are that clip's and are dropped, and the sound starts after them, so that windows of one source play its
 * sound end to end.
 */
export function motionSound(g: GraphBuilder, ctx: BuildContext, input: Pick<MotionValues, "keepSound">, at: { fps: number; frames: number; parts: string; carried?: number }): Ref | undefined {
  const skip = ctx.uploads.previous ? at.carried ?? 0 : 0;
  return input.keepSound && Boolean(ctx.media.driving?.hasSound) && ctx.has("TrimAudioDuration")
    ? g.out("TrimAudioDuration", { audio: [at.parts, 1], start_index: skip / at.fps, duration: (at.frames - skip) / at.fps })
    : undefined;
}

/**
 * The clip saved: RIFE ×2 when asked, with the driving video's own sound over its part when kept and it has some (`sound`:
 * that sound, when the recipe took it already, for its Face refine).
 */
export function motionSaved(g: GraphBuilder, ctx: BuildContext, images: Ref, input: MotionValues, at: { frame: { width: number; height: number }; fps: number; frames: number; parts: string; carried?: number; made?: Ref; sound?: Ref }) {
  const sound = at.sound ?? motionSound(g, ctx, input, at);
  // RIFE's n frames make 2n − 1: the last one again, so that the clip lasts what its part does (n / fps, the length its sound
  // and its draft have); 1/32 s short a window, the windows drifted from their sound. Its grain on the frames as filed
  const done = finishFrames(g, ctx, images, { upscale: UPSCALE.off, upscaleBy: 1, upscaleModel: "", crf: input.crf }, {
    frame: at.frame, rife: input.smooth, fps: at.fps, holdLast: true, ...(input.matchDriving ? { last: (x: Ref) => grained(g, ctx, x) } : {}), ...(sound ? { audio: sound } : {}),
  });
  // the model's own frames, kept beside the clip: the window after carries on from them, not from the finished ones (matched to
  // the driving video, softened, grained, interpolated and compressed: each join started softer than the clip before ended, the
  // loss stacking window after window, seen on the meme 2026-10-14). As H3 keeps its own (h3/finish.ts), nearly lossless
  const raw = at.made ? saveVideo(g, ctx, { images: at.made, fps: at.fps, crf: 10 }) : null;
  return { ...done, raw };
}
