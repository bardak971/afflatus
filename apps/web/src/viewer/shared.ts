/** A file's size as a person reads it. */
export const mb = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
export const FORMATS: Record<string, string> = { "image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WebP", "video/mp4": "MP4", "video/webm": "WebM", "audio/wav": "WAV", "audio/mpeg": "MP3", "audio/flac": "FLAC", "audio/mp4": "M4A", "audio/ogg": "OGG" };

/** The operations that have a key, by how their recipes are named. */
export const OPS: Record<string, { ends: string[]; label: string }> = {
  u: { ends: [".sharper"], label: "Upscale 2x" },
  f: { ends: [".fix-face"], label: "Face detailer" },
  b: { ends: ["tools.remove-background"], label: "Remove background" },
  i: { ends: [".paint-over"], label: "Inpaint" },
  e: { ends: [".edit", ".redraw"], label: "Edit" },
  r: { ends: [".change-shape"], label: "Outpaint" },
};

/**
 * What a new draft made from a result starts from. Handed its cast again (`withLook`): the person's own form, from before the
 * server worked the cast into it, so that the cast's words are not carried in the prompt and given again beside it.
 */
export const ownInputs = (g: { inputs: Record<string, unknown>; asked?: Record<string, unknown> }, withLook: boolean): Record<string, unknown> => (withLook && g.asked ? g.asked : g.inputs);
