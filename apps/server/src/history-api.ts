import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Services } from "./services";

/** The history's own writes: several finished jobs taken off the list, or queued again, in one request (a batch's Dismiss, "Retry all"). */
export function registerHistory(app: FastifyInstance, s: Services): void {
  app.post("/api/jobs/dismiss", async (req) => {
    const { ids } = z.strictObject({ ids: z.array(z.string().min(1).max(64)).min(1).max(500) }).parse(req.body);
    return { dismissed: await s.queue.dismissAll(ids) };
  });
  /** Several finished jobs again in one request (a "Retry all failed"); with `dismiss`, the ones queued again leave the list. */
  app.post("/api/jobs/retry", async (req) => {
    const { ids, dismiss } = z.strictObject({ ids: z.array(z.string().min(1).max(64)).min(1).max(500), dismiss: z.boolean().optional() }).parse(req.body);
    return s.queue.againAll(ids, { dismiss });
  });
}
