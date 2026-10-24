import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { modelIndex } from "./comfy";
import { httpError, notFound } from "./errors";
import { familyPlaces } from "./browse";
import type { DownloadView } from "./downloads";
import { beginDownload, downloadBody, downloadTarget } from "./fetchFile";
import { resolveLink } from "./fromLink";
import { comfyFolderPaths, folderPlaces, listedFor, NOT_MODELS, samePath } from "./modelDownload";
import type { Services } from "./services";
import { readSettings, updateSettings, type Settings } from "./settings";

/** The query or body naming one ComfyUI by its id (settings.ts machines); left out: the first. */
const onMachine = z.object({ machine: z.string().max(40).optional() });

/** The downloads of one ComfyUI, by its id: one asked without a machine went to the first. */
const mineOf = (settings: Settings, machine: string) => (d: DownloadView) => (d.machine ?? settings.machines[0]?.id) === machine;

/** The downloads of model files into ComfyUI (downloads.ts, fetchFile.ts), and reading a link to a model. */
export function registerDownloads(app: FastifyInstance, s: Services): void {
  // the downloads still waiting their turn when Afflatus last stopped are asked again, in their order, once it is up
  app.addHook("onReady", async () => {
    void s.downloads.resume((ask, from) => beginDownload(s, from, downloadBody.parse(ask)));
  });

  /** Model files being fetched into ComfyUI, whether that is turned on, and whether this ComfyUI can do it. */
  app.get("/api/downloads", async (req) => {
    const settings = await readSettings(s.db);
    const on = settings.downloadModels;
    // no machine at all (a rented-only start, none added yet): nothing to download into, nothing to ask
    if (!settings.machines.length) return { on, items: s.downloads.list(), manager: { found: false as const }, via: "none" as const };
    // `machine`: asked of that ComfyUI (Settings › Models, its tab); the first one otherwise
    const { comfy, dir } = await downloadTarget(s, settings, z.object({ machine: z.string().max(40).optional() }).parse(req.query).machine);
    // whether ComfyUI-Manager is there is said with downloads off too: node packs are installed with it all the same. Said
    // "not found" then, a pod's Models tab greyed its Install button, the Manager running there (2026-10-18)
    const manager = await s.downloads.manager(comfy);
    // who would download: Afflatus itself (it can write ComfyUI's model folders), the node pack, ComfyUI-Manager, or nobody.
    // Said with downloads off too: a family's official file is downloaded on a press all the same (fetchFile.ts)
    return { on, items: s.downloads.list(), manager, via: await s.downloads.route(comfy, dir) };
  });

  /** Fetch a missing model file into ComfyUI (see fetchFile.ts). Only when the user turned this on in Settings. */
  app.post("/api/downloads", async (req) => {
    return beginDownload(s, req, downloadBody.parse(req.body));
  });

  /** A failed or stopped download asked for again as it was first asked: its line is taken off, a new one starts. */
  app.post<{ Params: { id: string } }>("/api/downloads/:id/again", async (req) => {
    const was = s.downloads.list().find((d) => d.id === req.params.id);
    if (!was) throw notFound("that download");
    if (was.status !== "error" && was.status !== "stopped") throw httpError("That download has not failed or been stopped.", 409);
    const kept = s.downloads.askOf(req.params.id);
    if (!kept) throw httpError("It was not asked from a page of Afflatus: download it again from where it was found.", 409);
    const started = await beginDownload(s, req, downloadBody.parse(kept.ask));
    s.downloads.stop(req.params.id);
    return started;
  });

  /** A waiting download moved in its machine's line: before another waiting one, or to the end (`before` null). */
  app.post<{ Params: { id: string } }>("/api/downloads/:id/move", async (req) => {
    const { before } = z.strictObject({ before: z.string().max(80).nullable() }).parse(req.body);
    if (!s.downloads.move(req.params.id, before)) throw httpError("Only a download still waiting its turn moves, before another one waiting on the same ComfyUI.", 409);
    return { ok: true };
  });

  /** Every download still waiting its turn taken out of the line: one ComfyUI's (`machine`), or all of them. */
  app.post("/api/downloads/cancel-waiting", async (req) => {
    const { machine } = onMachine.strict().parse(req.body ?? {});
    const settings = await readSettings(s.db);
    return { cancelled: s.downloads.cancelWaiting(machine ? mineOf(settings, machine) : undefined) };
  });

  /** The finished downloads taken off the list (done, failed, stopped): one ComfyUI's (`machine`), or all of them. */
  app.post("/api/downloads/clear", async (req) => {
    const { machine } = onMachine.strict().parse(req.body ?? {});
    const settings = await readSettings(s.db);
    return { cleared: s.downloads.clearDone(machine ? mineOf(settings, machine) : undefined) };
  });

  /**
   * Where each model folder's downloads go on a ComfyUI (card #59): the paths ComfyUI reads it from, ComfyUI's own
   * models/<folder> first, whether each can be written from here (ComfyUI on this machine), the one chosen, and the one a
   * download takes now. Empty for a ComfyUI that does not say its folders.
   */
  app.get("/api/downloads/places", async (req) => {
    const settings = await readSettings(s.db);
    if (!settings.machines.length) return { machine: null, folders: {} };
    const { comfy, dir, machine } = await downloadTarget(s, settings, onMachine.parse(req.query).machine);
    const id = machine ?? settings.machines[0]!.id;
    const paths = await comfyFolderPaths(comfy.client);
    return { machine: id, folders: paths ? await folderPlaces(paths, comfy.client.baseUrl, dir, settings.downloadPlaces[id] ?? {}) : {} };
  });

  /** The place chosen for a model folder's downloads on a ComfyUI, or forgotten (`path` null): only one ComfyUI lists for it. */
  app.put("/api/downloads/places", async (req) => {
    const { machine, folder, path } = z.strictObject({ machine: z.string().max(40).optional(), folder: z.string().min(1).max(120), path: z.string().max(1000).nullable() }).parse(req.body);
    if (NOT_MODELS.has(folder)) throw httpError("that is not a models folder");
    const settings = await readSettings(s.db);
    if (!settings.machines.length) throw httpError("There is no ComfyUI to download into: add yours in Settings › ComfyUI.", 409);
    const { comfy, machine: asked } = await downloadTarget(s, settings, machine);
    const id = asked ?? settings.machines[0]!.id;
    let keep: string | null = null;
    if (path !== null) {
      const paths = await comfyFolderPaths(comfy.client);
      if (!paths) throw httpError("This ComfyUI does not say where it reads its models from: it is too old to choose a place.", 409);
      keep = listedFor(paths, folder).find((p) => samePath(p, path)) ?? null;
      if (!keep) throw httpError(`ComfyUI does not read ${folder} from ${path}.`);
    }
    await updateSettings(s.db, (current) => {
      const mine = { ...(current.downloadPlaces[id] ?? {}) };
      if (keep) mine[folder] = keep;
      else delete mine[folder];
      const all = { ...current.downloadPlaces, [id]: mine };
      if (!Object.keys(mine).length) delete all[id];
      return { downloadPlaces: all };
    });
    return { ok: true };
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
    const found = await resolveLink(link, settings.civitaiKey, familyPlaces(s));
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
