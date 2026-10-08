import type { FastifyInstance } from "fastify";
import { ComfyUnreachable, modelInfoFrom, type ModelInfo } from "@afflatus/comfy";
import { MODEL_INFO_VERSION } from "@afflatus/core";
import { now } from "./db";
import { httpError } from "./errors";
import { modelDirs, readLocalHeader } from "./modelFiles";
import type { Services } from "./services";
import { readSettings } from "./settings";

/**
 * What model files say about themselves (see ModelInfo), so that a search for a LoRA can find it by
 * what it does and not only by what its file is called. Each file's header is read once, through
 * ComfyUI (a read of the file's first bytes: nothing is loaded, the GPU is not touched), and kept.
 * Reading hundreds of files takes a moment, so it happens in the background: the answer says how many
 * are still to come, and a "models" event tells the page when to ask again.
 */

/** What is kept of a file: what it says, and which reading of its header that was. */
type Kept = ModelInfo & { v?: number };

/** How many headers are asked for at once: ComfyUI is busy with other things. */
const AT_ONCE = 4;
/** Tell the page about new arrivals this often while a folder is being read. */
const TELL_EVERY = 40;

export function registerModelInfo(app: FastifyInstance, s: Services): void {
  /** Folders being read right now. */
  const reading = new Map<string, Promise<void>>();

  async function read(folder: string, files: string[]): Promise<void> {
    const comfy = await s.comfy();
    // ComfyUI's folders on this computer, when they are: the whole header is read from the disk then (tensor names
    // and shapes, which say which model a file is for); otherwise ComfyUI gives the metadata alone
    const dirs = await modelDirs((await readSettings(s.db)).comfyDir, folder);
    const left = [...files];
    let done = 0;
    let stopped = false;
    await Promise.all(Array.from({ length: AT_ONCE }, async () => {
      for (let file = left.shift(); file !== undefined && !stopped; file = left.shift()) {
        // a request that looked just before an earlier reading ended can ask for what is already there
        const there = await s.db.selectFrom("model_info").select("info").where("folder", "=", folder).where("file", "=", file).executeTakeFirst();
        if (there && (JSON.parse(there.info) as Kept).v === MODEL_INFO_VERSION) continue;
        let info: ModelInfo;
        try {
          // the disk when ComfyUI's folders are here; else the node pack's route on ComfyUI (the whole header); else ComfyUI's metadata alone
          const local = dirs.length ? await readLocalHeader(dirs, file) : null;
          const header = local ?? (await comfy.client.header(folder, file).catch((err) => { if (err instanceof ComfyUnreachable) throw err; return null; })) ?? (await comfy.client.metadata(folder, file));
          // a file with no header is remembered as saying nothing, so it is not asked again
          info = header ? modelInfoFrom(header, file) : {};
        } catch (err) {
          // ComfyUI went away: what is left is read the next time someone asks
          if (err instanceof ComfyUnreachable) stopped = true;
          continue;
        }
        const json = JSON.stringify({ ...info, v: MODEL_INFO_VERSION } satisfies Kept);
        await s.db
          .insertInto("model_info")
          .values({ folder, file, info: json, read_at: now() })
          .onConflict((oc) => oc.columns(["folder", "file"]).doUpdateSet({ info: json, read_at: now() }))
          .execute();
        if (++done % TELL_EVERY === 0) s.queue.events.emit("models");
      }
    }));
    s.queue.events.emit("models");
  }

  app.get<{ Params: { folder: string } }>("/api/models/:folder/info", async (req) => {
    const folder = req.params.folder;
    if (!/^[\w-]{1,64}$/.test(folder)) throw httpError("there is no such model folder");
    // ComfyUI's list first, what is known second: nothing can be read between the second and the comparison
    let files: string[] | null = null;
    try {
      files = (await (await s.comfy()).client.models(folder)).filter((f) => /\.safetensors$/i.test(f));
    } catch {
      // ComfyUI is away or has no such folder: what is already known is still an answer
    }
    const rows = await s.db.selectFrom("model_info").select(["file", "info"]).where("folder", "=", folder).execute();
    const kept = rows.map((r) => ({ file: r.file, ...(JSON.parse(r.info) as Kept) }));
    const items: Record<string, ModelInfo> = Object.fromEntries(kept.map(({ file, v: _v, ...info }) => [file, info]));
    const current = new Set(kept.filter((k) => k.v === MODEL_INFO_VERSION).map((k) => k.file));
    let pending = 0;
    if (files) {
      // never read, or read before more was taken from the header (the fingerprint)
      const unread = files.filter((f) => !current.has(f));
      pending = unread.length;
      if (unread.length && !reading.has(folder)) {
        const job = read(folder, unread)
          .catch((err) => console.warn(`[models] reading ${folder} stopped: ${(err as Error).message}`))
          .finally(() => reading.delete(folder));
        reading.set(folder, job);
      }
    }
    return { items, pending };
  });

  // a server that is closing lets the reading end first, so nothing is written to a closed database
  app.addHook("onClose", async () => {
    await Promise.all(reading.values());
  });
}
