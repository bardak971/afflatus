import { sql, type Insertable } from "kysely";
import { now, OWNER, type Db, type Tables } from "./db";
import { missingFiles } from "./missingFiles";
import type { Storage } from "./storage";

/** A library item as the browser gets it. */
export const assetView = (a: Tables["assets"]) => ({
  id: a.id, kind: a.kind, origin: a.origin, name: a.name, mime: a.mime, bytes: a.bytes, keptBytes: a.kept_bytes ?? 0, width: a.width, height: a.height,
  durationMs: a.duration_ms, fps: a.fps, hasSound: Boolean(a.has_sound), folderId: a.folder_id, generationId: a.generation_id,
  kept: a.kept_at !== null, inBin: a.deleted_at !== null, createdAt: a.created_at,
  // when the one-day countdown of an unkept item last started (it was unkept, or put back from the bin); null: it runs from createdAt
  countdownFrom: a.countdown_from ?? null,
  // a file of a linked folder: where it is on the disk (in the bin: where it was)
  path: a.file_key.startsWith("linked:") ? a.file_key.slice("linked:".length) : a.linked_path,
  // one gone from its directory, kept because something uses it: its file answers 404
  ...(missingFiles.has(a.file_key) ? { missing: true as const } : {}),
});

type AssetInsert = Insertable<Tables["assets"]>;
type Defaulted = "owner_id" | "kept_at" | "deleted_at" | "created_at" | "fine_latent_key";
/** A row for the assets table with what every new item shares filled in: the owner, not kept, not in the bin, made now. Any of those can be given. */
export function newAssetRow(fields: Omit<AssetInsert, Defaulted> & Partial<Pick<AssetInsert, Defaulted>>): AssetInsert {
  return { owner_id: OWNER, kept_at: null, deleted_at: null, created_at: now(), fine_latent_key: null, ...fields };
}

/**
 * What an item takes on the disk: its file, and what it keeps beside it (an H3 clip's latents, the model's own frames).
 * Every size shown counts this; `bytes` alone is the file's (what the browser is sent, and a file's version).
 */
export const spaceOf = (a: Pick<Tables["assets"], "bytes" | "kept_bytes">) => Number(a.bytes) + Number(a.kept_bytes ?? 0);
/** spaceOf in a query, of the assets table (`assets.` for a query that joins it): summed by the sizes of folders and projects. */
export const SPACE = sql<number>`bytes + kept_bytes`;
export const ASSETS_SPACE = sql<number>`assets.bytes + assets.kept_bytes`;

/**
 * What the items made before kept_bytes keep beside their file, read once from the disk at start (0075_kept_bytes): the
 * items with a latent or the model's own frames and nothing counted yet. One whose files are gone stays at 0. Returns
 * how many were filled.
 */
export async function fillKeptBytes(db: Db, storage: Pick<Storage, "size">): Promise<number> {
  const rows = await db.selectFrom("assets").select(["id", "raw_key", "latent_key", "fine_latent_key"]).where("kept_bytes", "=", 0)
    .where((eb) => eb.or([eb("raw_key", "is not", null), eb("latent_key", "is not", null), eb("fine_latent_key", "is not", null)])).execute();
  let filled = 0;
  for (const r of rows) {
    const sizes = await Promise.all([r.raw_key, r.latent_key, r.fine_latent_key].map((k) => (k ? storage.size(k).catch(() => 0) : 0)));
    const kept = sizes.reduce((n, b) => n + b, 0);
    if (!kept) continue;
    await db.updateTable("assets").set({ kept_bytes: kept }).where("id", "=", r.id).execute();
    filled++;
  }
  return filled;
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
/**
 * What a file of a linked folder is taken for by its extension: the library's own ones, and the other names the same
 * kinds go by on a disk, read as the probe reads their containers (a .mov is a video/mp4, a .mkv a video/webm). A dropped
 * file keeps any of these, and a reading lists it. No .gif: an upload is never one, and a GIF already there stays out.
 */
const DISK_MIME: Record<string, string> = {
  ...MIME_BY_EXT, jpeg: "image/jpeg", mov: "video/mp4", m4v: "video/mp4", avi: "video/mp4", mkv: "video/webm", opus: "audio/ogg", aac: "audio/mp4",
};
export const mimeOfDiskFile = (filename: string) => DISK_MIME[filename.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

/** The name of a file without its folders, lower-cased: how model files are compared, whichever folder and case ComfyUI lists them with. */
export const fileName = (path: string) => (path.split(/[\\/]/).pop() ?? path).toLowerCase();
