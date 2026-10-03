import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { rates } from "./estimates";
import { clear, known, list, size, summary } from "./renders";
import { readSettings } from "./settings";
import type { Services } from "./services";

/** The "Render times" tab, what the buttons guess from, and the figures as Prometheus reads them. */
export function registerRenders(app: FastifyInstance, s: Services): void {
  /** How long things usually take on this machine: for "about 2 min" on buttons. `rates` is what was known before each render was put on record. */
  app.get("/api/estimates", async () => ({ rates: await rates(s.db), known: await known(s.db) }));

  app.get("/api/renders/summary", async (req) => {
    const { period } = z.object({ period: z.enum(["day", "week", "month", "all"]).default("week") }).parse(req.query);
    return summary(s.db, s.registry, period, (await readSettings(s.db)).renderHistoryDays);
  });

  app.get("/api/renders", async (req) => {
    const q = z.object({ recipe: z.string().max(200).optional(), only: z.enum(["trouble"]).optional(), before: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }).parse(req.query);
    return list(s.db, s.registry, { recipe: q.recipe, trouble: q.only === "trouble", before: q.before, limit: q.limit });
  });

  /** How much of it there is, for the storage card. */
  app.get("/api/renders/size", async () => size(s.db));

  /** Forget every time that was measured. The estimates start again from nothing. */
  app.delete("/api/renders", async () => {
    await clear(s.db);
    return { ok: true };
  });
}
