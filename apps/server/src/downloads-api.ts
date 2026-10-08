import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { modelIndex } from "./comfy";
import { httpError, notFound } from "./errors";
import { beginDownload, downloadBody } from "./fetchFile";
import { resolveLink } from "./fromLink";
import type { Services } from "./services";
import { readSettings } from "./settings";

/** The downloads of model files into ComfyUI (downloads.ts, fetchFile.ts), and reading a link to a model. */
export function registerDownloads(app: FastifyInstance, s: Services): void {
  /** Model files being fetched into ComfyUI, whether that is turned on, and whether this ComfyUI can do it. */
  app.get("/api/downloads", async () => {
    const settings = await readSettings(s.db);
    return { on: settings.downloadModels, items: s.downloads.list(), manager: settings.downloadModels ? await s.downloads.manager(await s.comfy()) : { found: false } };
  });

  /** Fetch a missing model file into ComfyUI (see fetchFile.ts). Only when the user turned this on in Settings. */
  app.post("/api/downloads", async (req) => beginDownload(s, req, downloadBody.parse(req.body)));

  /**
   * What a link leads to (a model's page on Civitai, a file on Hugging Face): its files and sizes, the
   * folder it most likely belongs in, ComfyUI's folders to choose from, and whether ComfyUI has it already.
   */
  app.post("/api/downloads/resolve", async (req) => {
    const { link } = z.strictObject({ link: z.string().min(8).max(2000) }).parse(req.body);
    const settings = await readSettings(s.db);
    if (!settings.downloadModels) throw httpError("Downloading into ComfyUI is turned off. Turn it on in Settings.");
    // "Lookups off" means Afflatus never contacts Civitai or Hugging Face: a link is read on those sites
    if (!settings.civitaiLookups) throw httpError("Looking up models online is turned off. Turn on Civitai lookups in Settings to read a link.");
    const found = await resolveLink(link, settings.civitaiKey);
    const index = await modelIndex(await s.comfy());
    const have = Object.fromEntries(found.files.flatMap((f) => {
      const where = index.find(f.name)[0];
      return where ? [[f.name, where.folder]] : [];
    }));
    return { ...found, folders: [...index.folders].sort(), have };
  });

  /** Stop a download that is under way (nothing is left behind), or take a finished one off the list. */
  app.delete<{ Params: { id: string } }>("/api/downloads/:id", async (req) => {
    const stopped = s.downloads.stop(req.params.id);
    if (stopped === false) throw notFound("that download");
    if (stopped === "late") throw httpError("Download complete: ComfyUI is saving the file now.", 409);
    return { ok: true };
  });

  /** The one-time address ComfyUI-Manager fetches a file from. It works once, for the download it was made for. */
  app.get<{ Params: { id: string }; Querystring: { t?: string } }>("/api/downloads/fetch/:id", async (req, reply) => {
    const got = await s.downloads.serve(req.params.id, String(req.query.t ?? ""));
    if (!got) return reply.code(404).send({ error: "this address is no longer good" });
    if ("error" in got) return reply.code(502).send({ error: got.error });
    req.raw.on("close", () => {
      if (!reply.raw.writableEnded) s.downloads.dropped(req.params.id);
    });
    reply.header("Content-Type", "application/octet-stream");
    if (got.size) reply.header("Content-Length", got.size);
    return reply.send(got.stream);
  });
}
