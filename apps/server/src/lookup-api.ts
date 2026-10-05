import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { findOnCivitai } from "./civitai";
import { modelIndex } from "./comfy";
import { readEmbedded } from "./embedded";
import { httpError, notFound } from "./errors";
import { beginDownload, downloadBody } from "./fetchFile";
import { resolveLink } from "./fromLink";
import { fill, targetsFor } from "./fromPicture";
import { findOnHuggingFace } from "./huggingface";
import type { Services } from "./services";
import { readSettings } from "./settings";
import { isUpload } from "./uploadBody";

/** Looking things up: where a model file can be had, what a file carries about how it was made, and the downloads into ComfyUI. */

export function registerLookup(app: FastifyInstance, s: Services): void {
  /**
   * Where a missing model file can be had: asked of Civitai by the file's name. Only when the user
   * turned this on in Settings; the file name is all that is sent.
   */
  app.get<{ Querystring: { file?: string; folder?: string; hints?: string } }>("/api/civitai/find", async (req) => {
    const settings = await readSettings(s.db);
    if (!settings.civitaiLookups) throw httpError("Civitai lookups are turned off. Turn them on in Settings.");
    const file = String(req.query.file ?? "").split(/[\\/]/).pop() ?? "";
    if (!file.replace(/\.(safetensors|ckpt|pt|pth|bin|gguf|sft|onnx)$/i, "")) throw httpError("no filename given");
    // Hugging Face is asked for the file itself, by its exact name; Civitai for models whose names are close
    const hints = String(req.query.hints ?? "").split("|").map((h) => h.trim()).filter(Boolean).slice(0, 3);
    const [exact, civitai] = await Promise.all([
      findOnHuggingFace(file, hints).catch(() => ({ items: [], answered: false })),
      findOnCivitai(file, req.query.folder ? String(req.query.folder) : null, settings.civitaiKey).catch((err: Error) => err),
    ]);
    if (civitai instanceof Error && !exact.answered) throw civitai;
    const found = civitai instanceof Error ? { items: [], asked: [] as string[], silent: ["civitai.com"] } : civitai;
    const answer = { ...found, exact: exact.items, asked: [...(exact.answered ? ["huggingface.co"] : []), ...found.asked] };
    // a model already on this ComfyUI under the name Civitai gives it is no download: it only has to be picked, or moved
    // (the folder the loader looks in first: a file that is there too is simply picked)
    const index = await modelIndex(await s.comfy());
    for (const item of found.items) {
      if (!item.file) continue;
      const here = index.find(item.file, req.query.folder ? String(req.query.folder) : undefined)[0];
      if (here) item.have = here;
    }
    return answer;
  });

  /**
   * What a file from the computer says about how it was made: settings worked into a form (the one
   * that uses the model it was made with, or the one asked for with ?recipe=), and the workflow it carries.
   * The file is read and forgotten: nothing is stored.
   */
  const embeddedIn = async (bytes: Uint8Array, wanted: string | undefined) => {
    const found = await readEmbedded(bytes);
    if (!found.settings) return { settings: null, workflow: found.workflow, why: found.why ?? null };
    const scan = await (await s.comfy()).scan().catch(() => null);
    const optionsOf = (id: string) => scan?.recipes.find((r) => r.id === id)?.options ?? {};
    // which form: the one asked for, else the one that uses the model the picture was made with
    const targets = targetsFor(found.settings, s.registry.recipes(), optionsOf);
    const recipe = s.registry.recipe(targets.find((t) => t.id === wanted)?.id ?? targets[0]?.id ?? "sdxl.text-to-picture");
    if (!recipe) throw httpError("no model takes these generation parameters");
    return { settings: { ...fill(found.settings, recipe, optionsOf(recipe.id), Boolean(scan?.comfy.online)), targets }, workflow: found.workflow, why: null };
  };
  app.post<{ Querystring: { recipe?: string } }>("/api/embedded", async (req) => {
    if (!isUpload(req.body)) throw httpError("send the file itself");
    return embeddedIn(new Uint8Array(await readFile(req.body.path)), req.query.recipe);
  });
  /** The same for a picture or a video already in the library: what its file carries. */
  app.get<{ Params: { id: string }; Querystring: { recipe?: string } }>("/api/assets/:id/embedded", async (req) => {
    const a = await s.db.selectFrom("assets").select(["file_key"]).where("id", "=", req.params.id).executeTakeFirst();
    if (!a) throw notFound("that item");
    return embeddedIn(await s.storage.get(a.file_key), req.query.recipe);
  });

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
