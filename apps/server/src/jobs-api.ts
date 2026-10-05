import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { compose, lookSchema } from "./entities";
import { notFound } from "./errors";
import type { Services } from "./services";

/** The queue: jobs sent to it, models loaded ahead, and the queue's own controls (pause, order, retry, cancel, previews). */

const jobBody = z.strictObject({
  recipe: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  label: z.string().max(200).optional(),
  /** "Make 4 pictures": the same job this many times. Each draws its own seed when the seed is random. */
  count: z.number().int().min(1).max(8).default(1),
  /** A typed seed that moves: each copy takes the next seed up or down from the one sent (the form's "+1" / "−1"). */
  seedMode: z.enum(["up", "down"]).optional(),
  /** Who is in it and how it looks: worked into the form before it is queued. */
  look: lookSchema.optional(),
  /** The draft it is sent from, and the folder that is open: its results are filed there. */
  draft: z.string().max(64).optional(),
  folder: z.string().max(64).optional(),
});
/** A form as it stands, to load its models ahead or to ask whether they are loaded. */
const warmBody = z.strictObject({ recipe: z.string().min(1), input: z.record(z.string(), z.unknown()), look: lookSchema.optional() });

export function registerJobs(app: FastifyInstance, s: Services): void {
  app.post("/api/jobs", async (req) => {
    const body = jobBody.parse(req.body);
    const recipe = s.registry.recipe(body.recipe);
    const input = recipe && body.look ? (await compose(s.db, recipe, body.input, body.look)).input : body.input;
    const ids: string[] = [];
    const seed = typeof input.seed === "number" && input.seed >= 0 ? input.seed : null;
    const range = 4294967296;
    for (let i = 0; i < body.count; i++) {
      const each = body.seedMode && seed !== null ? { ...input, seed: (((seed + (body.seedMode === "up" ? i : -i)) % range) + range) % range } : input;
      ids.push(await s.queue.enqueue(body.recipe, each, { label: body.label, draft: body.draft, folder: body.folder, look: body.look }));
    }
    return { ids };
  });

  /**
   * Load the models a form would render with, ahead of the render: a job in the queue like any other,
   * that makes nothing. Asked for while the prompt is still being written.
   */
  // the cast is worked in as for a render: a person with reference pictures can call for another model
  const withCast = async (body: z.infer<typeof warmBody>) => {
    const recipe = s.registry.recipe(body.recipe);
    return recipe && body.look ? (await compose(s.db, recipe, body.input, body.look).catch(() => null))?.input ?? body.input : body.input;
  };
  app.post("/api/jobs/warm", async (req) => {
    const body = warmBody.parse(req.body);
    return { id: await s.queue.enqueue(body.recipe, await withCast(body), { label: `Load the model: ${s.registry.recipe(body.recipe)?.title ?? body.recipe}`, warm: true }) };
  });

  /** Whether the models a form would render with are the ones ComfyUI was last asked to load. */
  app.post("/api/comfy/loaded", async (req) => {
    const body = warmBody.parse(req.body);
    return { loaded: await s.queue.isLoaded(body.recipe, await withCast(body)) };
  });

  app.get("/api/queue", async () => s.queue.status());
  /** The finished jobs with what they made: the queue's history, filtered and paged. */
  app.get("/api/jobs", async (req) => {
    const q = z.object({
      status: z.enum(["done", "failed", "cancelled"]).optional(),
      q: z.string().max(200).optional(),
      model: z.string().max(300).optional(),
      offset: z.coerce.number().int().min(0).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }).parse(req.query);
    return s.queue.history(q);
  });
  app.post("/api/queue/pause", async () => {
    await s.queue.setPaused(true);
    return s.queue.status();
  });
  app.post("/api/queue/resume", async () => {
    await s.queue.setPaused(false);
    return s.queue.status();
  });

  /** Unload ComfyUI's models now: the GPU's memory is wanted for something else. */
  app.post("/api/comfy/free", async () => {
    await s.queue.freeMemory();
    return { ok: true };
  });

  /** The waiting jobs, in the order they should run. */
  app.post("/api/queue/order", async (req) => {
    await s.queue.reorder(z.strictObject({ ids: z.array(z.string()).max(500) }).parse(req.body).ids);
    return s.queue.status();
  });
  /** A finished job again, with some of its inputs changed when `input` is given. */
  app.post<{ Params: { id: string } }>("/api/jobs/:id/retry", async (req) => {
    const body = z.strictObject({ input: z.record(z.string(), z.unknown()).optional() }).parse(req.body ?? {});
    return { id: await s.queue.again(req.params.id, body.input) };
  });
  app.delete<{ Params: { id: string } }>("/api/jobs/:id", async (req) => {
    if (!(await s.queue.dismiss(req.params.id))) throw notFound("a finished job");
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/cancel", async (req) => {
    if (!(await s.queue.cancel(req.params.id))) throw notFound("a job to cancel");
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/jobs/:id/preview", async (req, reply) => {
    const p = await s.queue.preview(req.params.id);
    if (!p) throw notFound("a preview");
    return reply.header("Content-Type", p.mime).header("Cache-Control", "no-store").send(Buffer.from(p.bytes));
  });
}
