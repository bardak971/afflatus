import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Services } from "./services";

/**
 * Render forecasts for many forms at once (forecast.ts works them out): the timeline editor's clips, and the command bar's
 * estimate of a timeline or a draft (commandIndex.ts). One form alone, with its words, is asked of POST /api/advice.
 */

/** A form asked for: its recipe and its settings, and the timeline clip it is the form of, when it is one. */
export interface Asked {
  recipe: string;
  input: Record<string, unknown>;
  /** The clip it renders: built as its render will be, with what its timeline gives it (its frame, the clip it carries on from). */
  clip?: string;
}

/**
 * Each form's forecast (queue.forecast) for one render, with what loading its model adds and that model, and with several
 * machines what it takes on each (`on`); null for one with no learned figure. The same form twice is worked out once. A
 * clip's form is planned as its render will be: asked alone, a Motion transfer window was built at its picture's shape
 * (576 × 1024 where the timeline renders 480 × 864) and said 6 min for what took 3.5.
 */
export async function forecastsOf(s: Services, forms: Asked[]): Promise<Array<{ ms: number; loadMs: number; model: string; samples: number; on: Record<string, number> | null } | null>> {
  const seen = new Map<string, Promise<Awaited<ReturnType<Services["queue"]["forecast"]>>>>();
  const fits = await fitsOf(s, forms);
  return Promise.all(forms.map(async (f) => {
    const key = `${f.recipe}\n${f.clip ?? ""}\n${JSON.stringify(f.input)}`;
    if (!seen.has(key)) seen.set(key, s.queue.forecast(f.recipe, f.input, f.clip ? { clip: { id: f.clip, fit: fits.get(f.clip) ?? false } } : {}).catch(() => null));
    const got = await seen.get(key)!;
    if (!got) return null;
    const on = got.on ? Object.fromEntries(Object.entries(got.on).map(([m, g]) => [m, g.ms])) : null;
    return { ms: got.forecast.ms, loadMs: got.forecast.loadMs, model: got.model, samples: got.forecast.samples, on };
  }));
}

/** Whether each asked clip lands on the clip after it (its Fit to next), as its render would be planned alone. */
async function fitsOf(s: Services, forms: Asked[]): Promise<Map<string, boolean>> {
  const ids = [...new Set(forms.flatMap((f) => (f.clip ? [f.clip] : [])))];
  if (!ids.length) return new Map();
  const rows = await s.db.selectFrom("clips").select(["id", "fit_next"]).where("id", "in", ids).execute();
  return new Map(rows.map((r) => [r.id, Boolean(r.fit_next)]));
}

const forecastsBody = z.strictObject({
  forms: z.array(z.strictObject({ recipe: z.string().min(1).max(200), input: z.record(z.string(), z.unknown()), clip: z.string().min(1).max(64).optional() })).max(400),
});

/**
 * What each of these forms would take to render once, as the timeline editor sends them (a clip's whole form, its texts
 * left out, with the clip it is): the same forecast as the command bar's and the timeline card's, per form, and with
 * several machines on each (`on`). Null where nothing like it was rendered here yet.
 */
async function forecasts(s: Services, raw: unknown): Promise<{ ms: Array<number | null>; on: Array<Record<string, number> | null> }> {
  const b = forecastsBody.parse(raw);
  const got = await forecastsOf(s, b.forms);
  return { ms: got.map((g) => g?.ms ?? null), on: got.map((g) => g?.on ?? null) };
}

export function registerForecasts(app: FastifyInstance, s: Services): void {
  /** What each of the editor's clips would take to render (forecasts). */
  app.post("/api/forecasts", async (req) => forecasts(s, req.body));
}
