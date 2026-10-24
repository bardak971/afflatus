import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type { Db, Tables } from "./db";
import type { Storage } from "./storage";
import { picturePixels } from "./thumbs";

/**
 * A file brought in that the library already holds, found by what it holds rather than by its name or its bytes alone:
 * a picture copied with Copy the picture comes back from the clipboard as a PNG the browser drew again (other bytes, the
 * same pixels), a video or a sound as the very same file. Items take their digest (0090_asset_digest) when they are
 * uploaded; an older one works its own out the first time a file of its size comes in, and keeps it.
 */

/** How many older items without a digest one lookup works out at most, newest first: a picture is read whole for it. */
const LOOKED_AT = 100;

/** Items that are not in the library (a painted mask, a Prompt kit's picture) are never what a file is found to be. */
const HIDDEN = ["mask", "kit"] as const;

/** Of a picture: its pixels as seen and its size. Null when it cannot be read. */
export async function pictureDigest(bytes: Uint8Array): Promise<string | null> {
  const p = await picturePixels(bytes);
  return p ? `px:${createHash("sha256").update(`${p.width}x${p.height}:`).update(p.data).digest("hex")}` : null;
}

/** Of a video or a sound: its bytes, read as they come. */
export async function fileDigest(stream: Readable): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return `file:${hash.digest("hex")}`;
}

type Row = Pick<Tables["assets"], "id" | "kind" | "file_key">;

/** An older item's digest, worked out from its file and kept; null when its file cannot be read (gone, damaged). */
async function digestOf(db: Db, storage: Storage, row: Row): Promise<string | null> {
  try {
    const digest = row.kind === "image" ? await pictureDigest(await storage.get(row.file_key)) : await fileDigest((await storage.open(row.file_key)).stream);
    if (digest) await db.updateTable("assets").set({ digest }).where("id", "=", row.id).execute();
    return digest;
  } catch {
    return null;
  }
}

/**
 * The library item that holds what a file holds, or null. `size`: a picture's width and height, else the file's bytes,
 * which an item must share to be worked out at all.
 */
export async function findSame(db: Db, storage: Storage, wanted: { kind: Tables["assets"]["kind"]; digest: string; width?: number | null; height?: number | null; bytes: number }): Promise<string | null> {
  const known = await db.selectFrom("assets").select("id")
    .where("digest", "=", wanted.digest).where("kind", "=", wanted.kind).where("deleted_at", "is", null).where("origin", "not in", HIDDEN)
    .orderBy("created_at", "desc").executeTakeFirst();
  if (known) return known.id;
  let older = db.selectFrom("assets").select(["id", "kind", "file_key"])
    .where("digest", "is", null).where("kind", "=", wanted.kind).where("deleted_at", "is", null).where("origin", "not in", HIDDEN);
  older = wanted.kind === "image" ? older.where("width", "=", wanted.width ?? -1).where("height", "=", wanted.height ?? -1) : older.where("bytes", "=", wanted.bytes);
  for (const row of await older.orderBy("created_at", "desc").limit(LOOKED_AT).execute()) {
    if ((await digestOf(db, storage, row)) === wanted.digest) return row.id;
  }
  return null;
}
