import type { FastifyInstance } from "fastify";
import type { Readable } from "node:stream";
import { z } from "zod";
import { httpError } from "./errors";
import { addFile, deleteFiles, emptyAway, folderOfHeader, library, putBack } from "./modelLibrary";
import { usedKey } from "./modelUses";
import type { Services } from "./services";

/** A dropped model file's body: sent as it is, streamed into its folder (no size limit of the uploads': a model is often bigger). */
export const MODEL_BODY = "application/x-afflatus-model";

const fileRef = z.object({ folder: z.string().regex(/^[\w-]{1,64}$/), file: z.string().min(1).max(500) });
const deleteBody = z.strictObject({ files: z.array(fileRef).min(1).max(5000), to: z.enum(["bin", "aside"]).default("bin"), anyway: z.boolean().default(false) });
const backBody = z.strictObject({ ids: z.array(z.string().max(64)).max(5000).optional(), batch: z.string().max(64).optional() });
const kindBody = z.strictObject({ name: z.string().min(1).max(300), header: z.record(z.string(), z.unknown()).nullable() });

/** Settings › Model files' routes (modelLibrary.ts). None of them is an MCP tool: Delete and Empty are on its never-list. */
export function registerModelLibrary(app: FastifyInstance, s: Services): void {
  app.addContentTypeParser(MODEL_BODY, (_req, payload, done) => done(null, payload));

  app.get<{ Querystring: { machine?: string } }>("/api/model-files", async (req) => library(s, req.query.machine));

  /** The takes and pictures made with a file, the newest first: its detail's "Made with it". */
  app.get<{ Querystring: { folder?: string; file?: string; machine?: string } }>("/api/model-files/takes", async (req) => {
    const { folder, file } = fileRef.parse(req.query);
    const lib = await library(s, req.query.machine);
    const f = lib.files.find((x) => !x.removed && usedKey(x) === usedKey({ folder, file }));
    if (!f) throw httpError("That file is not in the list.", 404);
    const gens = (await s.db.selectFrom("model_uses").select("generation_id").distinct().where("name_key", "=", usedKey(f)).where("generation_id", "is not", null).execute()).map((r) => r.generation_id!);
    const ids = gens.length ? (await s.db.selectFrom("assets").select(["id", "kind"]).where("generation_id", "in", gens.slice(0, 5000)).where("deleted_at", "is", null).orderBy("created_at", "desc").limit(8).execute()) : [];
    return { count: f.takes, items: ids };
  });

  app.post("/api/model-files/delete", async (req) => deleteFiles(s, deleteBody.parse(req.body)));
  app.post("/api/model-files/put-back", async (req) => putBack(s, backBody.parse(req.body)));
  // the only erase for good: asked first on the page, never through MCP
  app.post("/api/model-files/empty", async () => emptyAway(s));

  /** The folder a dropped file goes to, from its header as the page read it; null: the page asks. */
  app.post("/api/model-files/kind", async (req) => {
    const { header } = kindBody.parse(req.body);
    return { folder: folderOfHeader(header) };
  });

  app.put<{ Querystring: { folder?: string; name?: string } }>("/api/model-files/add", async (req) => {
    if (!req.headers["content-type"]?.startsWith(MODEL_BODY)) throw httpError(`Send the file as ${MODEL_BODY}.`, 415);
    const { folder, name } = z.object({ folder: z.string().regex(/^[\w-]{1,64}$/), name: z.string().min(1).max(300) }).parse(req.query);
    return addFile(s, folder, name, req.body as Readable);
  });
}
