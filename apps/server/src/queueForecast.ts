import type { BuiltGraph, Recipe } from "@afflatus/core";
import type { Db } from "./db";
import { familyReads, machinePaces, rates, statRows, type FamilyReads, type StatRows } from "./forecast";
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

/** What is kept while the record of render times stays as it is (see `kept`). */
interface Kept {
  mark: string;
  at: number;
  by: Map<string, Promise<Expected>>;
  usual: Promise<Usual> | null;
  rows: Map<string, Promise<StatRows>>;
  /** The family reads (familyReads), by what each is and its arguments. */
  family: Map<string, Promise<unknown>>;
}
const keptAt = (mark: string, at: number): Kept => ({ mark, at, by: new Map(), usual: null, rows: new Map(), family: new Map() });

/** A read kept under its key; one that failed is read again at the next ask. */
function keptRead<T>(kept: Map<string, Promise<unknown>>, key: string, read: () => Promise<T>): Promise<T> {
  let got = kept.get(key) as Promise<T> | undefined;
  if (!got) {
    const value = read();
    got = value;
    kept.set(key, value);
    value.catch(() => {
      if (kept.get(key) === value) kept.delete(key);
    });
  }
  return got;
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

  /** While `heldIf` runs: the forecasts kept are read as they are, the record moved or not. */
  private held = false;

  /**
   * `work` with the forecasts kept read as they are, when `hold` (a render just put on the record: the queue plans the next
   * job of the machine it freed on them, and the next pass on the new record), unless they are older than FORECASTS_MS.
   */
  async heldIf<T>(hold: boolean, work: () => Promise<T>): Promise<T> {
    if (!hold) return work();
    this.held = true;
    try {
      return await work();
    } finally {
      this.held = false;
    }
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
  private kept: Kept = keptAt("", 0);
  private async forecasts() {
    if (this.held && this.kept.at && Date.now() - this.kept.at <= FORECASTS_MS) return this.kept;
    const mark = await this.mark();
    if (mark !== this.kept.mark || Date.now() - this.kept.at > FORECASTS_MS) this.kept = keptAt(mark, Date.now());
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
    return keptRead((await this.forecasts()).rows, modelFile, () => statRows(this.deps.db, modelFile));
  }

  /**
   * A model's family's renders and loads (forecast.ts familyReads), read once while the record stays as it is, as `statRows`
   * are: every waiting job of a model with few renders of its own asked them again, on every machine, 190 times a pass.
   */
  readonly familyReads: FamilyReads = {
    rows: async (family, modelFile) => keptRead((await this.forecasts()).family, ["rows", family, modelFile].join("\u0001"), () => familyReads(this.deps.db).rows(family, modelFile)),
    warmLoads: async (family, machine) => keptRead((await this.forecasts()).family, ["warm", family, machine ?? ""].join("\u0001"), () => familyReads(this.deps.db).warmLoads(family, machine)),
    coldLoads: async (family, machine) => keptRead((await this.forecasts()).family, ["cold", family ?? "", machine ?? ""].join("\u0001"), () => familyReads(this.deps.db).coldLoads(family, machine)),
  };

  /**
   * The waiting forms' graphs, kept FORECASTS_MS whatever the record does: a render that ends changes the forecasts, not the
   * graphs, and each one rebuilt every waiting job's graph (402 builds at 380 waiting, the 2026-10-22 review, N-1). Dropped
   * after FORECASTS_MS for what else moves a graph (a ComfyUI back with other nodes or files).
   */
  private graphs: { at: number; by: Map<string, Promise<BuiltGraph | null>> } = { at: 0, by: new Map() };
  private builds(): Map<string, Promise<BuiltGraph | null>> {
    if (Date.now() - this.graphs.at > FORECASTS_MS) this.graphs = { at: Date.now(), by: new Map() };
    return this.graphs.by;
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
      got = this.deps.forecastOf(recipe.id, input, { cold, finishedFrom: job?.finished_from, clip: job?.clip_id ? { id: job.clip_id, fit: Boolean(job.clip_fit) } : null, machines, builds: this.builds() })
        .then((f) => ({ ms: f?.forecast.ms ?? null, on: new Map(Object.entries(f?.on ?? {}).map(([m, g]) => [m, g.ms])), model: f?.model || null, samples: f?.forecast.samples ?? 0 }), () => ({ ms: null, on: new Map<string, number>(), model: null, samples: 0 }));
      kept.by.set(key, got);
    }
    return got;
  }
}
