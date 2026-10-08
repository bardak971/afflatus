import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { findOnCivitai } from "./civitai";
import { modelIndex } from "./comfy";
import { registerDownloads } from "./downloads-api";
import { registerEmbedded } from "./embedded-api";
import { httpError } from "./errors";
import { findOnHuggingFace } from "./huggingface";
import type { Services } from "./services";
import { readSettings } from "./settings";

/** Looking things up: where a model file can be had, what a file carries about how it was made (embedded-api.ts), and the downloads into ComfyUI (downloads-api.ts). */

const findQuery = z.object({ file: z.string().max(400).default(""), folder: z.string().max(120).optional(), hints: z.string().max(2000).default("") });

export function registerLookup(app: FastifyInstance, s: Services): void {
  /**
   * Where a missing model file can be had: asked of Civitai by the file's name. Only when the user
   * turned this on in Settings; the file name is all that is sent.
   */
  app.get("/api/civitai/find", async (req) => {
    const query = findQuery.parse(req.query);
    const settings = await readSettings(s.db);
    if (!settings.civitaiLookups) throw httpError("Civitai lookups are turned off. Turn them on in Settings.");
    const file = query.file.split(/[\\/]/).pop() ?? "";
    if (!file.replace(/\.(safetensors|ckpt|pt|pth|bin|gguf|sft|onnx)$/i, "")) throw httpError("no filename given");
    // Hugging Face is asked for the file itself, by its exact name; Civitai for models whose names are close
    const hints = query.hints.split("|").map((h) => h.trim()).filter(Boolean).slice(0, 3);
    const [exact, civitai] = await Promise.all([
      findOnHuggingFace(file, hints).catch(() => ({ items: [], answered: false })),
      findOnCivitai(file, query.folder || null, settings.civitaiKey).catch((err: Error) => err),
    ]);
    if (civitai instanceof Error && !exact.answered) throw civitai;
    const found = civitai instanceof Error ? { items: [], asked: [] as string[], silent: ["civitai.com"] } : civitai;
    const answer = { ...found, exact: exact.items, asked: [...(exact.answered ? ["huggingface.co"] : []), ...found.asked] };
    // a model already on this ComfyUI under the name Civitai gives it is no download: it only has to be picked, or moved
    // (the folder the loader looks in first: a file that is there too is simply picked)
    const index = await modelIndex(await s.comfy());
    for (const item of found.items) {
      if (!item.file) continue;
      const here = index.find(item.file, query.folder || undefined)[0];
      if (here) item.have = here;
    }
    return answer;
  });

  registerEmbedded(app, s);
  registerDownloads(app, s);
}
