import type { Recipe } from "@afflatus/core";
import type { Db } from "./db";
import { machinePaces, rates, statRows, type StatRows } from "./forecast";
import type { JobRow, Usual } from "./queueModel";
import type { forecastOf } from "./queueSubmit";

/**
 * The queue's forecasts, kept (queue.ts): the record of render times read as it stands, the waiting jobs' forecasts by form
 * and what they are worked out from, and each machine's learned pace. The queue's own `expected` (a machine's figure) is
 * worked out from these.
 */

/** The longest a waiting job's forecast is kept while the record of render times does not change (see `kept`). */
const FORECASTS_MS = 5 * 60_000;

/**
 * A form's forecast as the queue reads it (ms): on no machine in particular, and on each machine it was asked for.
 * `model`: the model file its renders are filed under (render_stats.model_file), also for a recipe that loads it from its
 * family's slot; null when it cannot be built. `samples`: how many past renders it rests on (0 when none).
 */
export type Expected = { ms: number | null; on: ReadonlyMap<string, number>; model: string | null; samples: number };

/** What the forecasts read through the queue: the database, the machines of now, and a form's forecast (queueSubmit.forecastOf on the first machine's lane). */
interface ForecastDeps {
  db: Db;
  machines(): string[];
  forecastOf(recipeId: string, input: Record<string, unknown>, opts: NonNullable<Parameters<typeof forecastOf>[3]>): ReturnType<typeof forecastOf>;
}

export class Forecasts {
  constructor(private readonly deps: ForecastDeps) {}

  /** The record of render times as it stands (how many rows, the newest), read at most once a second: what the forecasts are kept by. */
  private recordMark: { at: number; value: Promise<string> } | null = null;
  private mark(): Promise<string> {
    if (!this.recordMark || Date.now() - this.recordMark.at > 1_000) {
      const value = this.deps.db.selectFrom("render_stats").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.max("created_at").as("at")]).executeTakeFirstOrThrow()
        .then((r) => `${r.n}|${r.at ?? ""}`, () => `unread ${Date.now()}`);
      this.recordMark = { at: Date.now(), value };
    }
    return this.recordMark.value;
  }

  /** A render was put on the record: the mark is read again at the next forecast. */
  recorded(): void {
    this.recordMark = null;
  }

  /**
   * The waiting jobs' forecasts by form, and what they are worked out from (each model's renders, the recipes' usual times):
   * a job waits unchanged, so it is worked out once, and again when the record of render times changes (a render ended, the
   * hourly fold, the record forgotten), not every half minute; at the latest after FORECASTS_MS, for what else moves a forecast
   * (the clips a waiting clip joins onto, a ComfyUI back that builds the graphs it could not).
   */
  private kept: { mark: string; at: number; by: Map<string, Promise<Expected>>; usual: Promise<Usual> | null; rows: Map<string, Promise<StatRows>> } = { mark: "", at: 0, by: new Map(), usual: null, rows: new Map() };
  private async forecasts() {
    const mark = await this.mark();
    if (mark !== this.kept.mark || Date.now() - this.kept.at > FORECASTS_MS) this.kept = { mark, at: Date.now(), by: new Map(), usual: null, rows: new Map() };
    return this.kept;
  }

  /** What the forecast falls back on: read once while the record stays as it is, however many forms ask at once. */
  async usual(): Promise<Usual> {
    const kept = await this.forecasts();
    if (!kept.usual) {
      const usual = rates(this.deps.db).then((r) => ({ rates: r }));
      kept.usual = usual;
      usual.catch(() => {
        if (kept.usual === usual) kept.usual = null;
      });
    }
    return kept.usual;
  }

  /** A model's past renders (forecast.ts statRows), read once while the record stays as it is: every waiting job on every machine reads them. */
  async statRows(modelFile: string): Promise<StatRows> {
    const kept = await this.forecasts();
    let rows = kept.rows.get(modelFile);
    if (!rows) {
      const read = statRows(this.deps.db, modelFile);
      rows = read;
      kept.rows.set(modelFile, read);
      read.catch(() => {
        if (kept.rows.get(modelFile) === read) kept.rows.delete(modelFile);
      });
    }
    return rows;
  }

  private paceCache: { at: number; value: Promise<Map<string, number>> } | null = null;
  /** Each machine's learned pace (forecast.ts machinePaces), read again once a minute. */
  paces(): Promise<Map<string, number>> {
    if (!this.paceCache || Date.now() - this.paceCache.at > 60_000) this.paceCache = { at: Date.now(), value: machinePaces(this.deps.db).catch(() => new Map<string, number>()) };
    return this.paceCache.value;
  }

  /** The forecast of a form as `expected` reads it: on no machine in particular, and on each machine (one graph built for all). */
  async expectedAll(recipe: Recipe<any>, input: Record<string, unknown>, cold: boolean, job: Pick<JobRow, "finished_from" | "clip_id" | "clip_fit"> | null): Promise<Expected> {
    const kept = await this.forecasts();
    const machines = this.deps.machines();
    const key = `${recipe.id}
${cold}
${job?.finished_from}
${job?.clip_id}
${job?.clip_fit}
${machines.join(",")}
${JSON.stringify(input)}`;
    let got = kept.by.get(key);
    if (!got) {
      got = this.deps.forecastOf(recipe.id, input, { cold, finishedFrom: job?.finished_from, clip: job?.clip_id ? { id: job.clip_id, fit: Boolean(job.clip_fit) } : null, machines })
        .then((f) => ({ ms: f?.forecast.ms ?? null, on: new Map(Object.entries(f?.on ?? {}).map(([m, g]) => [m, g.ms])), model: f?.model || null, samples: f?.forecast.samples ?? 0 }), () => ({ ms: null, on: new Map<string, number>(), model: null, samples: 0 }));
      kept.by.set(key, got);
    }
    return got;
  }
}
