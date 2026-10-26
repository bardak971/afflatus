import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { open as openFile, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AssetLookup } from "./assets-api";
import { FfmpegMissing, probeMediaFile, recordingWav } from "./cut";
import { newId, now } from "./db";
import type { LibraryChange } from "./events";
import { httpError } from "./errors";
import { assetView, extOf, looksLikePicture, newAssetRow, PICTURE_MOST, pictureTooLarge } from "./media";
import { rootFolderOf } from "./projects";
import { fileDigest, findSame, pictureDigest } from "./sameContent";
import type { Services } from "./services";
import { makeThumb, readPicture, thumbKey } from "./thumbs";
import { isUpload } from "./uploadBody";
import { firstFrame } from "./video";

/** A file brought into the library from the user's computer. */

/** A moment of a take, in seconds. */
const seconds = z.coerce.number().finite().min(0).optional();

/** What an upload's address may say. A name given twice comes as a list, which is refused here rather than used as a name. */
/** `same=use`: a file the library already holds kept in the folder it goes to (sameContent.ts) is answered with that item, `found: true`, and not added again. */
/** `take=wav`: a take recorded from the microphone (the browser's webm/opus), kept as the WAV the models are given, cut to `from`–`to` (seconds) when the silence at its ends was trimmed off. */
const uploadQuery = z.object({ name: z.string().optional(), as: z.string().optional(), folder: z.string().optional(), project: z.string().optional(), same: z.literal("use").optional(), take: z.literal("wav").optional(), from: seconds, to: seconds })
  .refine((q) => (q.from === undefined) === (q.to === undefined) && (q.from === undefined || q.to! > q.from), "a trim needs both from and to, to after from");

/** The take sent, as a WAV in the upload's own temporary folder (removed with it). */
async function asWav(sent: { path: string; dir: string; bytes: number }, trim?: { from: number; to: number }) {
  const path = join(sent.dir, "take.wav");
  await recordingWav(sent.path, path, trim);
  return { ...sent, path, bytes: (await stat(path)).size };
}

export function registerAssetUpload(app: FastifyInstance, s: Services, { asset }: AssetLookup): void {
  /**
   * A picture, a video or a sound from the user's computer, sent as the request body. It is theirs, so
   * it is kept from the start and never goes to the bin on its own.
   */
  app.post<{ Querystring: { name?: string; as?: string; folder?: string; project?: string; same?: "use"; take?: "wav"; from?: string; to?: string } }>("/api/assets", async (req) => {
    const asked = uploadQuery.parse(req.query);
    const sent = isUpload(req.body) ? req.body : null;
    const unreadable = () => httpError("This file is not an image, a video or an audio file Afflatus can read. Images: PNG, JPEG, WebP. Video and audio are read with ffmpeg, which has to be installed where Afflatus runs.");
    if (!sent) throw unreadable();
    // a take from the microphone becomes a WAV before anything else reads it: the webm the browser records is no sound
    // file the library takes as it is, and the models are given WAV. Written in the upload's own folder, removed with it
    const up = asked.take === "wav" ? await asWav(sent, asked.from !== undefined ? { from: asked.from, to: asked.to! } : undefined).catch((err: unknown) => {
      throw err instanceof FfmpegMissing ? err : httpError("This take could not be made into a WAV: ffmpeg did not read it as a sound.");
    }) : sent;
    // what the file is comes from its bytes, not from what the browser says it is. A picture is read whole (its size and
    // its thumbnail come from its bytes); a video or a sound stays on the disk and is probed there, once
    const head = await openFile(up.path, "r").then(async (f) => {
      const b = new Uint8Array(12);
      const { bytesRead } = await f.read(b, 0, 12, 0).finally(() => f.close());
      return b.subarray(0, bytesRead);
    });
    // up to PICTURE_MOST: a larger one in memory (the upload takes 4 GB) would weigh on everything the server runs
    if (looksLikePicture(head) && up.bytes > PICTURE_MOST) throw pictureTooLarge();
    const bytes = looksLikePicture(head) ? await readFile(up.path) : null;
    const picture = bytes && (await readPicture(bytes));
    const media = picture ? null : await probeMediaFile(up.path);
    if (!picture && !media) throw unreadable();
    // the part of a picture painted over to redo it: kept, but it is not something to look at in the library. A picture
    // or a voice sample uploaded for a person or a place of the Prompt kit: kept with them, not in the library either
    const mask = req.query.as === "mask";
    const kit = req.query.as === "kit";
    if (kit && !picture && media?.kind !== "audio") throw httpError("a file of the Prompt kit has to be a picture or a sound");
    if (mask && !picture) throw httpError("the mask has to be an image");
    const id = newId();
    const mime = picture?.mime ?? media!.mime;
    // into the folder named (a whole folder brought in from the computer: the folder made for each file; a drop: the folder open), else the project's root
    const named = req.query.folder && !mask && !kit ? (await s.db.selectFrom("folders").selectAll().where("id", "=", req.query.folder).executeTakeFirst()) ?? null : null;
    const rootId = !named && !mask && !kit && req.query.project ? await rootFolderOf(s.db, req.query.project) : null;
    const into = named ?? (rootId ? (await s.db.selectFrom("folders").selectAll().where("id", "=", rootId).executeTakeFirst()) ?? null : null);
    // what it holds, worked out only when it is asked to be found (a picture is decoded whole for it) and kept on the item.
    // Found kept in the folder it goes to: that item as it is, and nothing added
    const reuse = req.query.same === "use" && !mask && !kit;
    const digest = !reuse ? null : bytes ? await pictureDigest(bytes) : await fileDigest(createReadStream(up.path));
    if (reuse && digest) {
      const same = await findSame(s.db, s.storage, { kind: picture ? "image" : media!.kind, digest, bytes: up.bytes, folder: into?.id ?? null });
      if (same) return { ...assetView(await asset(same)), found: true };
    }
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
          folder_id: into?.id ?? null, generation_id: null, kept_at: at, linked_path: null, created_at: onDisk?.created_at ?? at, digest,
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
    if (!mask && !kit) s.queue.events.emit("library", { change: "added", items: [id], folders: [into?.id ?? null] } satisfies LibraryChange);
    return assetView(await asset(id));
  });
}
