import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { costs, type CostsView } from "./costs";
import { readSettings } from "./settings";
import type { Services } from "./services";

/** A window's figures are kept this long: the tab and its window bar ask again as they move, and the figures move slowly. */
const FRESH_MS = 10_000;
/** The windows kept at once. */
const KEPT = 8;

/** The Queue's Costs tab (costs.ts): everything it shows for a window, in one call. */
export function registerCosts(app: FastifyInstance, s: Services): void {
  const kept = new Map<string, { at: number; value: Promise<CostsView> }>();
  app.get("/api/costs", async (req) => {
    const q = z.object({ from: z.coerce.number().int().optional(), to: z.coerce.number().int().optional() }).parse(req.query);
    // a preset's window ends now and moves on each call: kept by its ends rounded to the time it is kept
    const key = q.from !== undefined && q.to !== undefined ? `${Math.round(q.from / FRESH_MS)}-${Math.round(q.to / FRESH_MS)}` : "all";
    const hit = kept.get(key);
    if (hit && Date.now() - hit.at < FRESH_MS) return hit.value;
    const value = (async () => {
      const settings = await readSettings(s.db);
      // RunPod is read only with a key or a pod: its bill, balance and storage as the Rented GPUs card has them (cached there)
      const spending = settings.runpodKey || settings.machines.some((m) => m.rented) ? await s.rented.spending().catch(() => null) : null;
      return costs({
        db: s.db, registry: s.registry, settings, spending, billReadAt: s.rented.billRead?.ok ? s.rented.billRead.at : null,
        costBetween: (from, to) => s.rented.costBetween(from, to),
        billedIn: (times, step) => s.rented.billedIn(times, step),
        offers: async () => (settings.runpodKey ? s.hunt.offersNow().catch(() => null) : null),
      }, q);
    })();
    kept.set(key, { at: Date.now(), value });
    value.catch(() => kept.delete(key));
    for (const k of [...kept.keys()].slice(0, Math.max(0, kept.size - KEPT))) kept.delete(k);
    return value;
  });
}
