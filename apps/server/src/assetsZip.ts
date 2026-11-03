import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { fromRender, markPng } from "./aiMark";
import { stamp } from "./backup";
import { markedVideoFile } from "./cut";
import { httpError } from "./errors";
import { extOf } from "./media";
import type { Services } from "./services";
import { sourceOf } from "./storage";
import { ZipStream } from "./zipStream";

/**
 * Items of the library as one zip, a library selection downloaded at once. Asked in two steps: the ids are posted (a
 * selection of hundreds does not fit in an address), and the answer is an address the browser follows as a plain link,
 * so the zip goes straight to the disk as it is written, never whole in the page's memory nor the server's.
 */

/** How long the address of a zip asked for stays good: the browser follows it at once. */
const ASKED_MS = 60_000;
/** The most items one zip is asked for: a whole library is a backup (Settings › Storage), not a selection. */
const MOST = 2000;

/** A file name no system refuses, as the web's downloadName makes it: the item's own name, else its id, with its extension. */
export function zipName(a: { id: string; name: string; mime: string }): string {
  const ext = extOf(a.mime);
  const name = (a.name.trim() || a.id).replace(/[\\/:*?"<>|\u0000-\u001f]/g, ".");
  return name.toLowerCase().endsWith(`.${ext}`) ? name : `${name}.${ext}`;
}

/** Two items of the same name both go in: the second "name (2).png", as a file manager does. */
export function uniqueNames(names: string[]): string[] {
  const taken = new Set<string>();
  return names.map((n) => {
    let out = n;
    for (let i = 2; taken.has(out.toLowerCase()); i++) {
      const dot = n.lastIndexOf(".");
      out = dot > 0 ? `${n.slice(0, dot)} (${i})${n.slice(dot)}` : `${n} (${i})`;
    }
    taken.add(out.toLowerCase());
    return out;
  });
}

export function registerAssetsZip(app: FastifyInstance, s: Services): void {
  // the zips asked for, by their one-time key: which items, and until when the address is good
  const asked = new Map<string, { ids: string[]; until: number }>();

  app.post("/api/assets/zip", async (req) => {
    const { ids } = z.strictObject({ ids: z.array(z.string().min(1)).min(1).max(MOST) }).parse(req.body ?? {});
    const at = Date.now();
    for (const [k, v] of asked) if (v.until < at) asked.delete(k);
    const key = randomBytes(18).toString("base64url");
    asked.set(key, { ids: [...new Set(ids)], until: at + ASKED_MS });
    return { href: `/api/assets/zip/${key}` };
  });

  app.get<{ Params: { key: string } }>("/api/assets/zip/:key", async (req, reply) => {
    const ask = asked.get(req.params.key);
    if (!ask || ask.until < Date.now()) throw httpError("This download was asked for too long ago: ask for it again.", 404);
    asked.delete(req.params.key);
    // in the order they were ticked, those still there (one erased meanwhile is left out rather than the zip refused)
    const rows = await s.db.selectFrom("assets").selectAll().where("id", "in", ask.ids).execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const items = ask.ids.flatMap((id) => byId.get(id) ?? []);
    if (!items.length) throw httpError("None of these items is in the library any more.", 404);
    const names = uniqueNames(items.map(zipName));
    const zip = new ZipStream();
    reply.header("Content-Type", "application/zip").header("Content-Disposition", `attachment; filename="afflatus-${items.length}-items-${stamp()}.zip"`).header("Cache-Control", "no-store");
    // what is written runs beside the reply, which takes the stream now; a write fails once the browser has gone (zipStream.ts)
    void (async () => {
      try {
        for (const [i, a] of items.entries()) {
          if (req.raw.destroyed) break;
          const path = names[i]!;
          const at = new Date(a.created_at);
          // a render goes in marked as made by a model, as the item's own Download gives it (aiMark.ts)
          if ((a.kind === "video" || a.mime === "image/png") && (await fromRender(s.db, a))) {
            if (a.kind === "video") {
              // read from the marked copy on the disk as it goes in, then removed: one video in memory at a time would be too much
              const marked = await markedVideoFile(await sourceOf(s.storage, a.file_key), extOf(a.mime));
              try {
                await zip.add(path, createReadStream(marked.file), at, marked.size);
              } finally {
                await marked.done();
              }
              continue;
            }
            const marked = markPng(await s.storage.get(a.file_key));
            await zip.add(path, Readable.from([Buffer.from(marked.buffer, marked.byteOffset, marked.byteLength)]), at, marked.length);
            continue;
          }
          const f = await s.storage.open(a.file_key).catch(() => null);
          // its file gone from the disk (a linked folder's, moved away): left out, not the whole zip given up
          if (!f) continue;
          await zip.add(path, f.stream, at, f.size);
        }
        await zip.finish();
      } catch (err) {
        // the browser going away is the usual way out and no news; anything else is said, the user only sees a download that stopped
        if (!req.raw.destroyed) console.warn(`[zip] given up: ${(err as Error).message}`);
        zip.abort(err as Error);
      }
    })();
    return reply.send(zip.out);
  });
}
