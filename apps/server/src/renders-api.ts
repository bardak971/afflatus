import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { rates } from "./estimates";
import { clear, known, list, size, summary, toolPace } from "./renders";
import { readSettings } from "./settings";
import type { Services } from "./services";

/** The "Render times" tab, what the buttons guess from, and the figures as Prometheus reads them. */
export function registerRenders(app: FastifyInstance, s: Services): void {
  /** How long things usually take on this machine: for "about 2 min" on buttons. `rates` is what was known before each render was put on record. */
  app.get("/api/estimates", async () => ({ rates: await rates(s.db), known: await known(s.db) }));

  /** The figures over a named period, or over a window (`from` and `to`, ms since the epoch). */
  app.get("/api/renders/summary", async (req) => {
    const q = z.object({ period: z.enum(["day", "week", "month", "all"]).default("week"), from: z.coerce.number().int().optional(), to: z.coerce.number().int().optional() }).parse(req.query);
    const keep = (await readSettings(s.db)).renderHistoryDays;
    return summary(s.db, s.registry, q.from !== undefined && q.to !== undefined && q.to > q.from ? { from: q.from, to: q.to } : q.period, keep);
  });

  app.get("/api/renders", async (req) => {
    const q = z.object({
      recipe: z.string().max(200).optional(), only: z.enum(["trouble"]).optional(), before: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(500).optional(),
      from: z.coerce.number().int().optional(), to: z.coerce.number().int().optional(),
    }).parse(req.query);
    return list(s.db, s.registry, { recipe: q.recipe, trouble: q.only === "trouble", before: q.before, limit: q.limit, from: q.from, to: q.to });
  });

  /** A tool's usual pace from its own record (milliseconds per pixel × frame made): for the Finish dialog's "about N min a clip". */
  app.get("/api/renders/pace", async (req) => {
    const q = z.object({ tool: z.enum(["tool.finish.seedvr", "tool.finish.rtx", "tool.finish.model", "tool.slow"]) }).parse(req.query);
    return { msPerWork: await toolPace(s.db, q.tool) };
  });

  /** How much of it there is, for the storage card. */
  app.get("/api/renders/size", async () => size(s.db));

  /** Forget every time that was measured. The estimates start again from nothing. */
  app.delete("/api/renders", async () => {
    await clear(s.db);
    return { ok: true };
  });
}
