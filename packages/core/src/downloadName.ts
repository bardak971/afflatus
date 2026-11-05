/** The extension each type of the library's files is saved with. */
export const MEDIA_EXT: Readonly<Record<string, string>> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm",
  "audio/wav": "wav", "audio/mpeg": "mp3", "audio/flac": "flac", "audio/mp4": "m4a", "audio/ogg": "ogg",
};

/**
 * The name an item is saved under, by the web's Download and in the server's zip alike: its own, else its id, with the
 * extension of its type when the name lacks it (a timeline's export is named after the timeline: saved bare, the file
 * opened with nothing). A sign no system takes in a file name (the times of an export's range, "0:05–0:10") becomes a dot.
 * A ".jpeg" is a JPEG's extension too, and a type it has no extension for (a .mov) keeps its name as it is.
 */
export function downloadName(asset: { id: string; name: string; mime: string }): string {
  const ext = MEDIA_EXT[asset.mime];
  const own = asset.name.trim();
  const name = (own || asset.id).replace(/[\\/:*?"<>|\u0000-\u001f]/g, ".");
  if (!own) return `${name}.${ext ?? "bin"}`;
  const said = name.toLowerCase();
  return !ext || said.endsWith(`.${ext}`) || (ext === "jpg" && said.endsWith(".jpeg")) ? name : `${name}.${ext}`;
}
