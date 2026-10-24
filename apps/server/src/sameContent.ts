import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type { Db, Tables } from "./db";
import type { Storage } from "./storage";
import { picturePixels } from "./thumbs";

/**
 * A file brought in that the library already holds, found by what it holds rather than by its name or its bytes alone:
 * a picture copied with Copy the picture comes back from the clipboard as a PNG the browser drew again (other bytes, the
 * same pixels), a video or a sound as the very same file. Only a file asked to be found (a paste) takes its digest
 * (0090_asset_digest): working a picture's out decodes it whole, which a folder of 2 000 photos brought in must not pay.
 * A picture is found by a digest kept already, never by reading older pictures again (renders have none, and decoding a
 * hundred of them on a paste would take the threads the thumbnails need); an older video or sound of the very same
 * bytes works its own out, as only a file of that exact size is read.
 */

/** How many older videos or sounds without a digest one lookup works out at most, newest first. */
const LOOKED_AT = 20;

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
 * The library item that holds what a file holds, or null. Only an item kept and already in the folder the file goes to
 * (`folder`, null for no folder) is the file: one not kept would take a paste with it to the bin, and one elsewhere (another
 * folder, another project) would leave the folder pasted into without it. `bytes`: the file's, which an older video or
 * sound must share to be worked out at all.
 */
export async function findSame(db: Db, storage: Storage, wanted: { kind: Tables["assets"]["kind"]; digest: string; bytes: number; folder: string | null }): Promise<string | null> {
  const mine = () => {
    const q = db.selectFrom("assets").select(["id", "kind", "file_key"])
      .where("kind", "=", wanted.kind).where("deleted_at", "is", null).where("origin", "not in", HIDDEN).where("kept_at", "is not", null);
    return wanted.folder ? q.where("folder_id", "=", wanted.folder) : q.where("folder_id", "is", null);
  };
  const known = await mine().where("digest", "=", wanted.digest).orderBy("created_at", "desc").executeTakeFirst();
  if (known) return known.id;
  if (wanted.kind === "image") return null;
  for (const row of await mine().where("digest", "is", null).where("bytes", "=", wanted.bytes).orderBy("created_at", "desc").limit(LOOKED_AT).execute()) {
    if ((await digestOf(db, storage, row)) === wanted.digest) return row.id;
  }
  return null;
}
