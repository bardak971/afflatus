import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Services } from "./services";

/**
 * Render forecasts for many forms at once (forecast.ts works them out): the timeline editor's clips, and the command bar's
 * estimate of a timeline or a draft (commandIndex.ts). One form alone, with its words, is asked of POST /api/advice.
 */

/** Each form's forecast (queue.forecast) for one render, with what loading its model adds and that model; null for one with no learned figure. The same form twice is worked out once. */
export async function forecastsOf(s: Services, forms: Array<{ recipe: string; input: Record<string, unknown> }>): Promise<Array<{ ms: number; loadMs: number; model: string; samples: number } | null>> {
  const seen = new Map<string, Promise<Awaited<ReturnType<Services["queue"]["forecast"]>>>>();
  return Promise.all(forms.map(async (f) => {
    const key = `${f.recipe}\n${JSON.stringify(f.input)}`;
    if (!seen.has(key)) seen.set(key, s.queue.forecast(f.recipe, f.input).catch(() => null));
    const got = await seen.get(key)!;
    return got ? { ms: got.forecast.ms, loadMs: got.forecast.loadMs, model: got.model, samples: got.forecast.samples } : null;
  }));
}

const forecastsBody = z.strictObject({
  forms: z.array(z.strictObject({ recipe: z.string().min(1).max(200), input: z.record(z.string(), z.unknown()) })).max(400),
});

/**
 * What each of these forms would take to render once, as the timeline editor sends them (a clip's whole form, its texts
 * left out): the same forecast as the command bar's and the timeline card's, per form. Null where nothing like it was
 * rendered here yet.
 */
async function forecasts(s: Services, raw: unknown): Promise<{ ms: Array<number | null> }> {
  const b = forecastsBody.parse(raw);
  const got = await forecastsOf(s, b.forms);
  return { ms: got.map((g) => g?.ms ?? null) };
}

export function registerForecasts(app: FastifyInstance, s: Services): void {
  /** What each of the editor's clips would take to render (forecasts). */
  app.post("/api/forecasts", async (req) => forecasts(s, req.body));
}
