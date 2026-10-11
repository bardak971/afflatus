// What kind of node a node type is, by its name: read by inspect.ts when a workflow is imported and by recipe.ts when
// it is rendered. Here rather than in inspect.ts, which imports recipe.ts: the two would import each other.

/**
 * The nodes that load a video or a sound from a file, by type: the input that names the file, and whether
 * that input is a path on disk (ComfyUI's own loaders and the Video Helper Suite's upload ones take a file
 * of the input or temp folder; its "path" ones take a path). A path one names its upload twin, which takes the
 * same settings (`renamed`: under other names), for when the file is one Afflatus uploads.
 */
export const MEDIA_LOADERS: Record<string, { kind: "video" | "audio"; input: string; path?: true; upload?: { classType: string; renamed?: Record<string, string> } }> = {
  LoadVideo: { kind: "video", input: "file" },
  VHS_LoadVideo: { kind: "video", input: "video" },
  VHS_LoadVideoFFmpeg: { kind: "video", input: "video" },
  VHS_LoadVideoPath: { kind: "video", input: "video", path: true, upload: { classType: "VHS_LoadVideo" } },
  VHS_LoadVideoFFmpegPath: { kind: "video", input: "video", path: true, upload: { classType: "VHS_LoadVideoFFmpeg" } },
  LoadAudio: { kind: "audio", input: "audio" },
  VHS_LoadAudioUpload: { kind: "audio", input: "audio" },
  VHS_LoadAudio: { kind: "audio", input: "audio_file", path: true, upload: { classType: "VHS_LoadAudioUpload", renamed: { audio_file: "audio", seek_seconds: "start_time" } } },
};
