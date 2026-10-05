import type { Insertable } from "kysely";
import { now, OWNER, type Db, type Tables } from "./db";

/** A library item as the browser gets it. */
export const assetView = (a: Tables["assets"]) => ({
  id: a.id, kind: a.kind, origin: a.origin, name: a.name, mime: a.mime, bytes: a.bytes, width: a.width, height: a.height,
  durationMs: a.duration_ms, fps: a.fps, hasSound: Boolean(a.has_sound), folderId: a.folder_id, generationId: a.generation_id,
  kept: a.kept_at !== null, inBin: a.deleted_at !== null, createdAt: a.created_at,
  // when the one-day countdown of an unkept item last started (it was unkept, or put back from the bin); null: it runs from createdAt
  countdownFrom: a.countdown_from ?? null,
  // a file of a linked folder: where it is on the disk (in the bin: where it was)
  path: a.file_key.startsWith("linked:") ? a.file_key.slice("linked:".length) : a.linked_path,
});

type AssetInsert = Insertable<Tables["assets"]>;
type Defaulted = "owner_id" | "kept_at" | "deleted_at" | "created_at";
/** A row for the assets table with what every new item shares filled in: the owner, not kept, not in the bin, made now. Any of those can be given. */
export function newAssetRow(fields: Omit<AssetInsert, Defaulted> & Partial<Pick<AssetInsert, Defaulted>>): AssetInsert {
  return { owner_id: OWNER, kept_at: null, deleted_at: null, created_at: now(), ...fields };
}

/**
 * Start the one-day countdown of these items again, now: they were unkept, or put back from the bin,
 * and the sweep (sweep.ts) counts from this moment rather than from the day they were made.
 */
export async function resetCountdown(db: Db, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await db.updateTable("assets").set({ countdown_from: now() }).where("id", "in", ids).execute();
}

/** Width and height of a PNG, read from its header (ComfyUI's image outputs are PNG). */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  // 8-byte signature, then the IHDR chunk: 4 length, 4 "IHDR", 4 width, 4 height
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Whether the first bytes of a file are a PNG's, a JPEG's or a WebP's: what tells a picture from a video or a sound before anything decodes it. */
export function looksLikePicture(head: Uint8Array): boolean {
  if (head.length < 12) return false;
  const png = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  const webp = head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50;
  return png || jpeg || webp;
}

const EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm",
  "audio/wav": "wav", "audio/mpeg": "mp3", "audio/flac": "flac", "audio/mp4": "m4a", "audio/ogg": "ogg",
};
export const extOf = (mime: string) => EXT[mime] ?? "bin";

const MIME_BY_EXT: Record<string, string> = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));
export const mimeOfFile = (filename: string) => MIME_BY_EXT[filename.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

/** The name of a file without its folders, lower-cased: how model files are compared, whichever folder and case ComfyUI lists them with. */
export const fileName = (path: string) => (path.split(/[\\/]/).pop() ?? path).toLowerCase();
