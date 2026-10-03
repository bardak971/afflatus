import { secondsOf, type Recipe } from "@afflatus/core";
import type { Db } from "./db";

/**
 * How long things take, learned from what was rendered before: per recipe, the usual time of one job
 * and, for videos, the usual time per second of video. Used for "about 2 min" on buttons and in the
 * queue. An estimate, said as one: the first render after a model change is slower (the model loads).
 */
export interface Rate {
  /** The usual time of one job, in milliseconds. */
  perJobMs: number;
  /** Of a video recipe: the usual time for one second of video. */
  perSecondMs: number | null;
  /** How many past renders this rests on. */
  samples: number;
}

const middle = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
};

/** How many past renders are looked at: the recent ones say more about the machine as it is now. */
const LOOK_BACK = 400;

export async function rates(db: Db): Promise<Record<string, Rate>> {
  const rows = await db
    .selectFrom("generations")
    .innerJoin("assets", "assets.generation_id", "generations.id")
    .select(["generations.id", "generations.recipe_id", "generations.gen_ms", "assets.kind", "assets.duration_ms"])
    .orderBy("generations.created_at", "desc")
    .limit(LOOK_BACK)
    .execute();
  const seen = new Set<string>();
  const byRecipe = new Map<string, { jobs: number[]; perSecond: number[] }>();
  for (const r of rows) {
    // a job that gave several results is one render
    if (seen.has(r.id) || r.gen_ms <= 0) continue;
    seen.add(r.id);
    const at = byRecipe.get(r.recipe_id) ?? { jobs: [], perSecond: [] };
    at.jobs.push(r.gen_ms);
    if (r.kind === "video" && r.duration_ms && r.duration_ms > 0) at.perSecond.push(r.gen_ms / (r.duration_ms / 1000));
    byRecipe.set(r.recipe_id, at);
  }
  return Object.fromEntries([...byRecipe].map(([id, v]) => [id, { perJobMs: Math.round(middle(v.jobs)), perSecondMs: v.perSecond.length ? Math.round(middle(v.perSecond)) : null, samples: v.jobs.length }]));
}

/** About how long one job of this recipe with these inputs takes; null when nothing like it was rendered yet. */
export function estimateMs(all: Record<string, Rate>, recipe: Recipe<any>, input: Record<string, unknown>): number | null {
  const rate = all[recipe.id];
  if (!rate) return null;
  const seconds = secondsOf(recipe.inputs, input);
  return rate.perSecondMs && seconds ? Math.round(rate.perSecondMs * seconds) : rate.perJobMs;
}
