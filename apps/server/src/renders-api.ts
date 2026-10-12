import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { clear } from "./renders";
import { list, size, summary } from "./rendersRead";
import { readSettings } from "./settings";
import type { Services } from "./services";

/** The "Render times" tab and the figures as Prometheus reads them. What a form will take is asked of POST /api/advice (forecast.ts). */
export function registerRenders(app: FastifyInstance, s: Services): void {
  /** The figures over a named period, or over a window (`from` and `to`, ms since the epoch). */
  app.get("/api/renders/summary", async (req) => {
    const q = z.object({ period: z.enum(["day", "week", "month", "all"]).default("week"), from: z.coerce.number().int().optional(), to: z.coerce.number().int().optional(), machine: z.string().min(1).max(40).optional() }).parse(req.query);
    const keep = (await readSettings(s.db)).renderHistoryDays;
    return summary(s.db, s.registry, q.from !== undefined && q.to !== undefined && q.to > q.from ? { from: q.from, to: q.to } : q.period, keep, Date.now(), q.machine ?? null);
  });

  app.get("/api/renders", async (req) => {
    const q = z.object({
      recipe: z.string().max(200).optional(), only: z.enum(["trouble"]).optional(), before: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(500).optional(),
      from: z.coerce.number().int().optional(), to: z.coerce.number().int().optional(), machine: z.string().min(1).max(40).optional(),
    }).parse(req.query);
    return list(s.db, s.registry, { recipe: q.recipe, trouble: q.only === "trouble", before: q.before, limit: q.limit, from: q.from, to: q.to, machine: q.machine });
  });

  /** How much of it there is, for the storage card. */
  app.get("/api/renders/size", async () => size(s.db));

  /** Forget every time that was measured. The estimates start again from nothing. */
  app.delete("/api/renders", async () => {
    await clear(s.db);
    return { ok: true };
  });
}
