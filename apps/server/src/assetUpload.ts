import type { FastifyInstance } from "fastify";
import { open as openFile, readFile, rm } from "node:fs/promises";
import { z } from "zod";
import type { AssetLookup } from "./assets-api";
import { probeMediaFile } from "./cut";
import { newId, now } from "./db";
import { httpError } from "./errors";
import { assetView, extOf, looksLikePicture, newAssetRow } from "./media";
import { rootFolderOf } from "./projects";
import type { Services } from "./services";
import { makeThumb, readPicture, thumbKey } from "./thumbs";
import { isUpload } from "./uploadBody";
import { firstFrame } from "./video";

/** A file brought into the library from the user's computer. */

/** What an upload's address may say. A name given twice comes as a list, which is refused here rather than used as a name. */
const uploadQuery = z.object({ name: z.string().optional(), as: z.string().optional(), folder: z.string().optional(), project: z.string().optional() });

export function registerAssetUpload(app: FastifyInstance, s: Services, { asset }: AssetLookup): void {
  /**
   * A picture, a video or a sound from the user's computer, sent as the request body. It is theirs, so
   * it is kept from the start and never goes to the bin on its own.
   */
  app.post<{ Querystring: { name?: string; as?: string; folder?: string; project?: string } }>("/api/assets", async (req) => {
    uploadQuery.parse(req.query);
    const up = isUpload(req.body) ? req.body : null;
    const unreadable = () => httpError("This file is not an image, a video or an audio file Afflatus can read. Images: PNG, JPEG, WebP. Video and audio are read with ffmpeg, which has to be installed where Afflatus runs.");
    if (!up) throw unreadable();
    // what the file is comes from its bytes, not from what the browser says it is. A picture is read whole (its size and
    // its thumbnail come from its bytes); a video or a sound stays on the disk and is probed there, once
    const head = await openFile(up.path, "r").then(async (f) => {
      const b = new Uint8Array(12);
      const { bytesRead } = await f.read(b, 0, 12, 0).finally(() => f.close());
      return b.subarray(0, bytesRead);
    });
    const bytes = looksLikePicture(head) ? new Uint8Array(await readFile(up.path)) : null;
    const picture = bytes && (await readPicture(bytes));
    const media = picture ? null : await probeMediaFile(up.path);
    if (!picture && !media) throw unreadable();
    // the part of a picture painted over to redo it: kept, but it is not something to look at in the library. A picture
    // uploaded for a person or a place of the Prompt kit: kept with them, not in the library either
    const mask = req.query.as === "mask";
    const kit = req.query.as === "kit";
    if (kit && !picture) throw httpError("a picture of the Prompt kit has to be an image");
    if (mask && !picture) throw httpError("the mask has to be an image");
    const id = newId();
    const mime = picture?.mime ?? media!.mime;
    // into the folder named (a whole folder brought in from the computer: the folder made for each file; a drop: the folder open), else the project's root
    const named = req.query.folder && !mask && !kit ? (await s.db.selectFrom("folders").selectAll().where("id", "=", req.query.folder).executeTakeFirst()) ?? null : null;
    const rootId = !named && !mask && !kit && req.query.project ? await rootFolderOf(s.db, req.query.project) : null;
    const into = named ?? (rootId ? (await s.db.selectFrom("folders").selectAll().where("id", "=", rootId).executeTakeFirst()) ?? null : null);
    // into a linked folder: written into its directory first (a folder gone, read-only or full refuses it, and nothing is
    // imported), and registered as a reading of that directory would register it; else into Afflatus's own storage
    const onDisk = into?.path ? await s.linked.importFile(into, up.path, String(req.query.name ?? ""), mime) : null;
    const key = onDisk?.file_key ?? `assets/${id.slice(0, 2)}/${id}.${extOf(mime)}`;
    try {
      if (!onDisk && picture && bytes) await s.storage.put(key, bytes);
      else if (!onDisk) await s.storage.putFile(key, up.path);
      const facts = media?.facts ?? null;
      const frame = media?.kind === "video" ? await firstFrame(up.path) : null;
      const thumb = picture && bytes ? await makeThumb(bytes) : frame ? await makeThumb(frame) : null;
      if (thumb) await s.storage.put(thumbKey(id), thumb);
      const at = now();
      await s.db
        .insertInto("assets")
        .values(newAssetRow({
          id, kind: picture ? "image" : media!.kind, origin: mask ? "mask" : kit ? "kit" : "uploaded", name: onDisk?.name ?? String(req.query.name ?? "").slice(0, 200), file_key: key,
          thumb_key: thumb ? thumbKey(id) : null, mime, bytes: onDisk?.bytes ?? up.bytes, width: picture?.width ?? facts?.width ?? null, height: picture?.height ?? facts?.height ?? null,
          duration_ms: media?.durationMs ?? null, fps: facts?.fps ?? null, has_sound: media?.kind === "audio" || facts?.hasSound ? 1 : 0,
          folder_id: into?.id ?? null, generation_id: null, kept_at: at, linked_path: null, created_at: onDisk?.created_at ?? at,
        }))
        .execute();
    } catch (err) {
      // the file written into the folder is not left there for a reading to pick up as an item this upload did not make; nor
      // are the files put into Afflatus's storage left there with no item to name them
      if (onDisk) await rm(onDisk.path, { force: true }).catch(() => {});
      else await s.storage.delete(key).catch(() => {});
      await s.storage.delete(thumbKey(id)).catch(() => {});
      throw err;
    }
    if (!mask && !kit) s.queue.events.emit("library");
    return assetView(await asset(id));
  });
}
