import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { downloadName, plural } from "@afflatus/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { stamp } from "./backup";
import { httpError } from "./errors";
import { outgoingFile } from "./outgoing";
import type { Services } from "./services";
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
    const { ids } = z.strictObject({ ids: z.array(z.string().min(1).max(64)).min(1).max(MOST) }).parse(req.body ?? {});
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
    const names = uniqueNames(items.map(downloadName));
    const zip = new ZipStream();
    reply.header("Content-Type", "application/zip").header("Content-Disposition", `attachment; filename="afflatus-${items.length}-items-${stamp()}.zip"`).header("Cache-Control", "no-store");
    // what is written runs beside the reply, which takes the stream now; a write fails once the browser has gone (zipStream.ts)
    void (async () => {
      try {
        // the items whose file could not be read (gone from the disk, a linked folder's moved away): left out, not the whole
        // zip given up, and named in a note at its end, the only place a download followed as a link can say it
        const missed: string[] = [];
        // the model hashes read once for the whole zip, not once a picture
        const reads = {};
        for (const [i, a] of items.entries()) {
          if (req.raw.destroyed) break;
          const path = names[i]!;
          const at = new Date(a.created_at);
          // a render goes in as the item's own Download gives it, a PNG brought in as well (outgoing.ts); any other file as it is
          const f = await outgoingFile(s, a, reads).then((out) => out ?? s.storage.open(a.file_key).then((o) => ({ ...o, done: async () => {} }))).catch(() => null);
          if (!f) {
            missed.push(path);
            continue;
          }
          try {
            await zip.add(path, f.stream, at, f.size);
          } finally {
            // a video's marked copy, read as it goes in, then removed: one video in memory at a time would be too much
            await f.done();
          }
        }
        if (missed.length && !req.raw.destroyed) {
          // Windows line ends: the note is opened by whatever the user's system has, Notepad included
          const note = Buffer.from(`Not found on the disk, so not in this zip (${plural(missed.length, "item")}):\r\n${missed.join("\r\n")}\r\n`, "utf8");
          await zip.add(uniqueNames([...names, "Not in this zip.txt"]).at(-1)!, Readable.from([note]), new Date(), note.length);
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
