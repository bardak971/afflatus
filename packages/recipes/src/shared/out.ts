import type { BuildContext, GraphBuilder, Ref } from "@afflatus/core";

/** The node the video families write their clip with when the VideoHelperSuite pack is there. */
export const VHS = "VHS_VideoCombine";
/** ComfyUI's own two: always there. */
export const CORE_VIDEO_OUT = ["CreateVideo", "SaveVideo"];

/**
 * The finished frames (and sound) written as an H.264 MP4. With the VideoHelperSuite pack: into
 * ComfyUI's temp folder, which it clears itself, so nothing piles up in output/. Without it, ComfyUI's
 * own CreateVideo + SaveVideo, which only write to output/ (under Afflatus/): the file is kept there too.
 */
export function saveVideo(g: GraphBuilder, ctx: BuildContext, v: { images: Ref; audio?: Ref; fps: number; crf: number }): string {
  if (ctx.has(VHS)) {
    return g.add(VHS, {
      images: v.images, ...(v.audio ? { audio: v.audio } : {}), frame_rate: v.fps, loop_count: 0, filename_prefix: "Afflatus/video", format: "video/h264-mp4",
      pingpong: false, save_output: false, pix_fmt: "yuv420p", crf: v.crf, save_metadata: false, trim_to_audio: false,
    });
  }
  const video = g.out("CreateVideo", { images: v.images, fps: v.fps, ...(v.audio ? { audio: v.audio } : {}) });
  // a choice that brings its own inputs is sent as "<choice>.<input>", nested as deep as it goes
  return g.add("SaveVideo", { video, filename_prefix: "Afflatus/video", format: "mp4", "format.codec": "h264", "format.codec.encoding": "re-encode", "format.codec.encoding.crf": v.crf });
}
