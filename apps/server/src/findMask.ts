import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { FIND_MASK, pointsText } from "@afflatus/recipes";
import { httpError } from "./errors";
import { assetView } from "./media";
import type { Services } from "./services";
import { maskBox } from "./thumbs";

/**
 * The Stage's click to mask and find (card #274), on Show the mask's pattern (timelines-api.ts maskPreview): a short job of
 * the internal recipe tools.find-mask, sent ahead of the renders waiting (the user waits for it with the brush in hand), its
 * masks filed as working pictures (scratch: out of the library, gone after a day, the recipe says so). The page asks
 * after it until it is done, and adds the mask it picks to what is painted.
 */

const point = z.object({ x: z.number().finite().min(0), y: z.number().finite().min(0) });
/** A click (points in the picture's own pixels, on the thing and off it) or a find (what a detector looks for). */
const findBody = z.discriminatedUnion("way", [
  z.strictObject({ way: z.literal("points"), add: z.array(point).min(1).max(32), remove: z.array(point).max(32).default([]) }),
  z.strictObject({ way: z.literal("detect"), what: z.enum(["face", "hands", "person"]) }),
]);

/** A mask found on a picture (POST /api/assets/:id/find-mask): its job, queued at the front. */
export async function findMaskOf(s: Services, id: string, asked: unknown): Promise<{ job: string }> {
  const body = findBody.parse(asked);
  const a = await s.db.selectFrom("assets").select(["id", "kind", "name"]).where("id", "=", id).where("deleted_at", "is", null).executeTakeFirst();
  if (!a) throw httpError("this picture was not found", 404);
  if (a.kind !== "image") throw httpError("a mask is found on a picture only");
  const input = body.way === "points" ? { source: a.id, way: "points", add: pointsText(body.add), remove: pointsText(body.remove) } : { source: a.id, way: "detect", what: body.what };
  const what = body.way === "points" ? "click to mask" : `find ${body.what}`;
  const job = await s.queue.enqueue(FIND_MASK, input, { label: `${a.name.trim() || "Picture"} · ${what}`, front: true });
  return { job };
}

/**
 * Where a find stands, and once done its masks (GET /api/assets/:id/find-mask/:job): each a working picture, with the box
 * of what it holds in the picture's pixels (what the layer frames when it is picked). A mask that holds nothing (a detector
 * that found nothing answers an empty one) is left out.
 */
export async function foundMasks(s: Services, id: string, jobId: string) {
  const job = await s.db.selectFrom("jobs").select(["status", "error", "generation_id", "recipe_id", "inputs"]).where("id", "=", jobId).executeTakeFirst();
  // only a find of this picture: the route reads no other job
  if (!job || job.recipe_id !== FIND_MASK || (JSON.parse(job.inputs) as { source?: string }).source !== id) throw httpError("this mask was not found", 404);
  const rows = job.generation_id ? await s.db.selectFrom("assets").selectAll().where("generation_id", "=", job.generation_id).orderBy("created_at").orderBy("id").execute() : [];
  const masks = [];
  for (const r of rows) {
    const read = await maskBox(await s.storage.get(r.file_key), { room: false });
    if (read?.box) masks.push({ asset: assetView(r), box: read.box });
  }
  return { status: job.status, error: job.error, masks };
}

export function registerFindMask(app: FastifyInstance, s: Services): void {
  app.post<{ Params: { id: string } }>("/api/assets/:id/find-mask", async (req) => findMaskOf(s, req.params.id, req.body));
  app.get<{ Params: { id: string; job: string } }>("/api/assets/:id/find-mask/:job", async (req) => foundMasks(s, req.params.id, req.params.job));
}
