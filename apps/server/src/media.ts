import type { Tables } from "./db";

/** A library item as the browser gets it. */
export const assetView = (a: Tables["assets"]) => ({
  id: a.id, kind: a.kind, origin: a.origin, name: a.name, mime: a.mime, bytes: a.bytes, width: a.width, height: a.height,
  durationMs: a.duration_ms, fps: a.fps, hasSound: Boolean(a.has_sound), folderId: a.folder_id, generationId: a.generation_id,
  kept: a.kept_at !== null, inBin: a.deleted_at !== null, createdAt: a.created_at,
  // a file of a linked folder: where it is on the disk (in the bin: where it was)
  path: a.file_key.startsWith("linked:") ? a.file_key.slice("linked:".length) : a.linked_path,
});

/** Width and height of a PNG, read from its header (ComfyUI's image outputs are PNG). */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  // 8-byte signature, then the IHDR chunk: 4 length, 4 "IHDR", 4 width, 4 height
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm",
  "audio/wav": "wav", "audio/mpeg": "mp3", "audio/flac": "flac", "audio/mp4": "m4a", "audio/ogg": "ogg",
};
export const extOf = (mime: string) => EXT[mime] ?? "bin";

const MIME_BY_EXT: Record<string, string> = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));
export const mimeOfFile = (filename: string) => MIME_BY_EXT[filename.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
