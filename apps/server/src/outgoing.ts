import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { fromRender } from "./aiMark";
import { markedVideoFile } from "./cut";
import type { Tables } from "./db";
import { extOf } from "./media";
import { WORDED_PICTURES } from "./pictureWords";
import { outgoingOwn, outgoingRender, type OutgoingReads } from "./pngInfo";
import type { Services } from "./services";
import { sourceOf } from "./storage";

/** What a file goes out as: its bytes as a stream, how many, and what to clear once they are sent (a marked copy on the disk). */
export interface Outgoing {
  stream: Readable;
  size: number;
  done(): Promise<void>;
}

type Asset = Pick<Tables["assets"], "file_key" | "kind" | "mime" | "origin" | "source_id" | "generation_id" | "width" | "height">;

/**
 * A file of the library as it leaves Afflatus, the same for a Download, a selection's zip and a timeline's project zip: a
 * render (or a frame, cut or edit of one) marked as made by a model (aiMark.ts), a video from a marked copy on the disk, never
 * whole in memory; a rendered PNG, JPEG or WebP with how it was made (pngInfo.ts); one brought in without its texts (EXIF,
 * XMP) when Settings says a download carries none. Null for any other file, which goes as it is stored (the caller streams it its own way: a Download
 * answers ranges). Throws when the file cannot be read. `reads`: shared by the files of one zip (OutgoingReads).
 */
export async function outgoingFile(s: Pick<Services, "db" | "registry" | "storage">, a: Asset, reads: OutgoingReads = {}): Promise<Outgoing | null> {
  const nothing = async () => {};
  const bytes = (b: Uint8Array): Outgoing => ({ stream: Readable.from([Buffer.from(b.buffer, b.byteOffset, b.byteLength)]), size: b.length, done: nothing });
  if (a.kind !== "video" && !WORDED_PICTURES.has(a.mime)) return null;
  const render = await fromRender(s.db, a);
  if (render && a.kind === "video") {
    const marked = await markedVideoFile(await sourceOf(s.storage, a.file_key), extOf(a.mime));
    return { stream: createReadStream(marked.file), size: marked.size, done: marked.done };
  }
  if (!WORDED_PICTURES.has(a.mime)) return null;
  const stored = await s.storage.get(a.file_key);
  return bytes(render ? await outgoingRender(s, a, stored, reads) : await outgoingOwn(s, stored));
}
