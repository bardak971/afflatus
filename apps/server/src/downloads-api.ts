import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { modelIndex } from "./comfy";
import { httpError, notFound } from "./errors";
import { beginDownload, downloadBody, downloadTarget, type DownloadBody } from "./fetchFile";
import { resolveLink } from "./fromLink";
import type { Services } from "./services";
import { readSettings } from "./settings";

/** The downloads of model files into ComfyUI (downloads.ts, fetchFile.ts), and reading a link to a model. */
export function registerDownloads(app: FastifyInstance, s: Services): void {
  // what each download of this run was asked with, so that a failed or stopped one can be asked again as it was (the
  // command bar's "Download again"); one of an earlier run is listed without it, and is downloaded again where it was found
  const asked = new Map<string, DownloadBody>();
  const withAgain = <T extends { id: string; status: string }>(d: T) => (asked.has(d.id) && (d.status === "error" || d.status === "stopped") ? { ...d, again: true as const } : d);

  /** Model files being fetched into ComfyUI, whether that is turned on, and whether this ComfyUI can do it. */
  app.get("/api/downloads", async (req) => {
    const settings = await readSettings(s.db);
    // `machine`: asked of that ComfyUI (Settings › Models, its tab); the first one otherwise
    const { comfy, dir } = await downloadTarget(s, settings, z.object({ machine: z.string().max(40).optional() }).parse(req.query).machine);
    // whether ComfyUI-Manager is there is said with downloads off too: node packs are installed with it all the same. Said
    // "not found" then, a pod's Models tab greyed its Install button, the Manager running there (2026-10-18)
    const manager = await s.downloads.manager(comfy);
    if (!settings.downloadModels) return { on: false, items: s.downloads.list().map(withAgain), manager, via: "none" };
    // who would download: Afflatus itself (it can write ComfyUI's model folders), the node pack, ComfyUI-Manager, or nobody
    return { on: true, items: s.downloads.list().map(withAgain), manager, via: await s.downloads.route(comfy, dir) };
  });

  /** Fetch a missing model file into ComfyUI (see fetchFile.ts). Only when the user turned this on in Settings. */
  app.post("/api/downloads", async (req) => {
    const body = downloadBody.parse(req.body);
    const started = await beginDownload(s, req, body);
    asked.set(started.id, body);
    return started;
  });

  /** A failed or stopped download asked for again as it was first asked: its line is taken off, a new one starts. */
  app.post<{ Params: { id: string } }>("/api/downloads/:id/again", async (req) => {
    const body = asked.get(req.params.id);
    const was = s.downloads.list().find((d) => d.id === req.params.id);
    if (!was) throw notFound("that download");
    if (was.status !== "error" && was.status !== "stopped") throw httpError("That download has not failed or been stopped.", 409);
    if (!body) throw httpError("Afflatus was restarted since: download it again from where it was found.", 409);
    const started = await beginDownload(s, req, body);
    asked.delete(req.params.id);
    asked.set(started.id, body);
    s.downloads.stop(req.params.id);
    return started;
  });

  /**
   * What a link leads to (a model's page on Civitai, a file on Hugging Face): its files and sizes, the
   * folder it most likely belongs in, ComfyUI's folders to choose from, and whether ComfyUI has it already.
   */
  app.post("/api/downloads/resolve", async (req) => {
    const { link } = z.strictObject({ link: z.string().min(8).max(2000) }).parse(req.body);
    const settings = await readSettings(s.db);
    if (!settings.downloadModels) throw httpError("Downloading into ComfyUI is turned off. Turn it on in Settings.");
    // "Lookups off" means Afflatus never contacts Civitai or Hugging Face: a link is read on those sites
    if (!settings.civitaiLookups) throw httpError("Looking up models online is turned off. Turn on “Search Hugging Face and Civitai” in Settings › Models to read a link.");
    const found = await resolveLink(link, settings.civitaiKey);
    const index = await modelIndex(await s.comfy());
    const have = Object.fromEntries(found.files.flatMap((f) => {
      const where = index.find(f.name)[0];
      return where ? [[f.name, where.folder]] : [];
    }));
    return { ...found, folders: [...index.folders].sort(), have };
  });

  /** A failure was read (its banner dismissed): pages opened later do not announce it again, on any device. */
  app.post<{ Params: { id: string } }>("/api/downloads/:id/seen", async (req) => {
    if (!s.downloads.seen(req.params.id)) throw notFound("that download");
    return { ok: true };
  });

  /** Stop a download that is under way (nothing is left behind), or take a finished one off the list. */
  app.delete<{ Params: { id: string } }>("/api/downloads/:id", async (req) => {
    const stopped = s.downloads.stop(req.params.id);
    if (stopped === false) throw notFound("that download");
    if (stopped === "late") throw httpError("Download complete: ComfyUI is saving the file now.", 409);
    if (stopped === "manager") throw httpError("ComfyUI-Manager downloads this one on its own: it cannot be stopped from Afflatus.", 409);
    return { ok: true };
  });

  /**
   * The one-time address ComfyUI fetches a file from (the node pack, or ComfyUI-Manager), for the download it
   * was made for: once for Manager; for the pack as long as its download runs, from where it asks (a Range).
   */
  app.get<{ Params: { id: string }; Querystring: { t?: string } }>("/api/downloads/fetch/:id", async (req, reply) => {
    const got = await s.downloads.serve(req.params.id, z.object({ t: z.string().default("") }).parse(req.query).t, req.headers.range);
    if (!got) return reply.code(404).send({ error: "this address is no longer good" });
    // the source's own refusal (a 4xx) goes on as one, so that the pack stops; what may pass (a 5xx) is a 502 it asks again after
    if ("error" in got) return reply.code(got.status).send({ error: got.error });
    req.raw.on("close", () => {
      if (!reply.raw.writableEnded) s.downloads.dropped(req.params.id);
    });
    reply.header("Content-Type", "application/octet-stream");
    if (got.size) reply.header("Content-Length", got.size);
    if (got.partial) reply.code(206).header("Content-Range", got.partial);
    return reply.send(got.stream);
  });
}
