import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { readEmbedded, readEmbeddedFile, type Embedded } from "./embedded";
import { httpError, notFound } from "./errors";
import { fill, targetsFor } from "./fromPicture";
import type { Services } from "./services";
import { isUpload } from "./uploadBody";

const recipeQuery = z.object({ recipe: z.string().max(120).optional() });

/** What a picture or a video of the library carries, its settings and its workflow (the route below, and MCP's import_workflow). */
export async function itemEmbedded(s: Services, id: string): Promise<Embedded> {
  const a = await s.db.selectFrom("assets").select(["file_key"]).where("id", "=", id).executeTakeFirst();
  if (!a) throw notFound("that item");
  // read where it is when it is on this machine's disk (a video is not read into memory), else fetched
  const path = s.storage.localPath?.(a.file_key);
  return path ? await readEmbeddedFile(path) : await readEmbedded(await s.storage.get(a.file_key));
}

/**
 * What a file from the computer says about how it was made: settings worked into a form (the one
 * that uses the model it was made with, or the one asked for with ?recipe=), and the workflow it carries.
 * The file is read and forgotten: nothing is stored.
 */
export function registerEmbedded(app: FastifyInstance, s: Services): void {
  const embeddedIn = async (found: Embedded, wanted: string | undefined) => {
    if (!found.settings) return { settings: null, workflow: found.workflow, why: found.why ?? null };
    const scan = await (await s.comfy()).scan().catch(() => null);
    const optionsOf = (id: string) => scan?.recipes.find((r) => r.id === id)?.options ?? {};
    // which form: the one asked for, else the one that uses the model the picture was made with
    const targets = targetsFor(found.settings, s.registry.recipes(), optionsOf);
    const recipe = s.registry.recipe(targets.find((t) => t.id === wanted)?.id ?? targets[0]?.id ?? "sdxl.text-to-picture");
    if (!recipe) throw httpError("no model takes these generation parameters");
    return { settings: { ...fill(found.settings, recipe, optionsOf(recipe.id), Boolean(scan?.comfy.online)), targets }, workflow: found.workflow, why: null };
  };
  app.post("/api/embedded", async (req) => {
    if (!isUpload(req.body)) throw httpError("send the file itself");
    return embeddedIn(await readEmbeddedFile(req.body.path), recipeQuery.parse(req.query).recipe);
  });
  /** The same for a picture or a video already in the library: what its file carries. */
  app.get<{ Params: { id: string } }>("/api/assets/:id/embedded", async (req) => embeddedIn(await itemEmbedded(s, req.params.id), recipeQuery.parse(req.query).recipe));
}
