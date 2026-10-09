import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Services } from "./services";

/** The history's own writes: several finished jobs taken off the list in one request (a batch's Dismiss). */
export function registerHistory(app: FastifyInstance, s: Services): void {
  app.post("/api/jobs/dismiss", async (req) => {
    const { ids } = z.strictObject({ ids: z.array(z.string().min(1).max(64)).min(1).max(500) }).parse(req.body);
    return { dismissed: await s.queue.dismissAll(ids) };
  });
}
