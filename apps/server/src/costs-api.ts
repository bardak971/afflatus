import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { costs, type CostsView } from "./costs";
import { csvName, sendCsv } from "./csv";
import { costsCsv } from "./csvExports";
import type { Spending } from "./rented";
import { readSettings } from "./settings";
import type { Services } from "./services";

/** A window's figures are kept this long: the tab and its window bar ask again as they move, and the figures move slowly. */
const FRESH_MS = 10_000;
/** The windows kept at once. */
const KEPT = 8;

type Worked = { view: CostsView; spending: Spending | null };

/** The Queue's Costs tab (costs.ts): everything it shows for a window, in one call; and the same window as a CSV file. */
export function registerCosts(app: FastifyInstance, s: Services): void {
  const kept = new Map<string, { at: number; value: Promise<Worked> }>();
  const windowAsked = z.object({ from: z.coerce.number().int().optional(), to: z.coerce.number().int().optional() });
  /** A window's figures, with RunPod's spending they were worked out with (the CSV's volumes row): kept a moment, as above. */
  const workedOut = (q: z.infer<typeof windowAsked>): Promise<Worked> => {
    // a preset's window ends now and moves on each call: kept by its ends rounded to the time it is kept
    const key = q.from !== undefined && q.to !== undefined ? `${Math.round(q.from / FRESH_MS)}-${Math.round(q.to / FRESH_MS)}` : "all";
    const hit = kept.get(key);
    if (hit && Date.now() - hit.at < FRESH_MS) return hit.value;
    const value = (async () => {
      const settings = await readSettings(s.db);
      // RunPod is read only with a key or a pod: its bill, balance and storage as the Rented GPUs card has them (cached there),
      // and its GPUs for the guesses, asked together: one wait for RunPod at most, not one after the other
      const [spending, offers] = await Promise.all([
        settings.runpodKey || settings.machines.some((m) => m.rented) ? s.rented.spending().catch(() => null) : null,
        settings.runpodKey ? s.hunt.offersNow().catch(() => null) : null,
      ]);
      const view = await costs({
        db: s.db, registry: s.registry, settings, spending, billReadAt: s.rented.billRead?.ok ? s.rented.billRead.at : null,
        costBetween: (from, to) => s.rented.costBetween(from, to),
        billedIn: (times, step) => s.rented.billedIn(times, step),
        offers: async () => offers,
      }, q);
      return { view, spending };
    })();
    kept.set(key, { at: Date.now(), value });
    value.catch(() => kept.delete(key));
    for (const k of [...kept.keys()].slice(0, Math.max(0, kept.size - KEPT))) kept.delete(k);
    return value;
  };

  app.get("/api/costs", async (req) => (await workedOut(windowAsked.parse(req.query))).view);

  /** The window's pod sessions and storage as a CSV file (csvExports.ts costsCsv): the tab has just read the same figures, kept above. */
  app.get("/api/costs.csv", async (req, reply) => {
    const q = windowAsked.parse(req.query);
    const { view, spending } = await workedOut(q);
    return sendCsv(reply, csvName("costs", q.from !== undefined && q.to !== undefined ? { from: view.from, to: view.to } : {}), costsCsv(view, spending, await readSettings(s.db)));
  });
}
