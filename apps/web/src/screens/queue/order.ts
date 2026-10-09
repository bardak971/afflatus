import type { Job } from "../../api";

/** The waiting jobs' order, worked out apart from the screen. */

/** The ids with `id` moved to place `to` (counted without it). */
export function moved(ids: string[], id: string, to: number): string[] {
  const next = ids.filter((x) => x !== id);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, id);
  return next;
}

/** The waiting ids with `ids` first, in the order they wait in (one that no longer waits is left out). */
export function atTop(waiting: string[], ids: string[]): string[] {
  const up = new Set(ids);
  return [...waiting.filter((x) => up.has(x)), ...waiting.filter((x) => !up.has(x))];
}

/** The ids with `dragged` dropped before the job at `index` (the one after the last: at the end). */
export function dropped(ids: string[], dragged: string, index: number): string[] {
  const from = ids.indexOf(dragged);
  return moved(ids, dragged, from >= 0 && index > from ? index - 1 : index);
}

/**
 * Which waiting jobs load another model first, in their order: the recipe it loads, or null (same model, or not a render).
 * `from`: the running job, whose model is the one loaded first. What modelSwitches counts, so the rows' chips and the count agree.
 */
export function loadsAt(waiting: Array<Pick<Job, "kind" | "recipe">>, from?: Pick<Job, "kind" | "recipe"> | null): (string | null)[] {
  let last: string | null = from && (from.kind === "render" || from.kind === "load") ? from.recipe : null;
  return waiting.map((w) => {
    if (w.kind !== "render") return null;
    const loads = last && w.recipe !== last ? w.recipe : null;
    last = w.recipe;
    return loads;
  });
}

/** How many times the model changes down the line of renders: each change costs a model load. `from`: the running job, whose model is the one loaded first. */
export function modelSwitches(waiting: Array<Pick<Job, "kind" | "recipe">>, from?: Pick<Job, "kind" | "recipe"> | null): number {
  return loadsAt(waiting, from).filter((r) => r !== null).length;
}

/**
 * The waiting jobs grouped by model, so that each model loads once: the models in the order they first come,
 * the jobs of one model in the order they wait in. A load goes with its model; an export or a cut is a group of its own.
 * `from`: the running job, whose model is loaded already: its group goes first.
 */
export function byModel(waiting: Array<Pick<Job, "id" | "kind" | "recipe">>, from?: Pick<Job, "kind" | "recipe"> | null): string[] {
  const groups = new Map<string, string[]>();
  if (from && (from.kind === "render" || from.kind === "load") && waiting.some((w) => (w.kind === "render" || w.kind === "load") && w.recipe === from.recipe)) groups.set(`model:${from.recipe}`, []);
  for (const w of waiting) {
    const key = w.kind === "render" || w.kind === "load" ? `model:${w.recipe}` : `job:${w.id}`;
    groups.set(key, [...(groups.get(key) ?? []), w.id]);
  }
  return [...groups.values()].flat();
}

/** How many model loads grouping the waiting jobs by model saves (0: none), counted from the running job's model. */
export function groupingSaves(waiting: Array<Pick<Job, "id" | "kind" | "recipe">>, from?: Pick<Job, "kind" | "recipe"> | null): number {
  const byId = new Map(waiting.map((w) => [w.id, w]));
  return modelSwitches(waiting, from) - modelSwitches(byModel(waiting, from).map((id) => byId.get(id)!), from);
}

/**
 * Where one waiting job saves the most model loads (a picture between two video clips: after the video jobs), as its
 * menu offers it: the place, the job it then comes after, and how many loads that saves. Null when no place saves one.
 * The top is left to "Run next"; of two places that save as much, the nearer one.
 */
export function betterPlace<T extends Pick<Job, "id" | "kind" | "recipe">>(waiting: T[], id: string, from?: Pick<Job, "kind" | "recipe"> | null): { to: number; after: T; saves: number } | null {
  const ids = waiting.map((w) => w.id);
  const at = ids.indexOf(id);
  if (at < 0 || waiting[at]!.kind !== "render") return null;
  const byId = new Map(waiting.map((w) => [w.id, w]));
  const now = modelSwitches(waiting, from);
  let best: { to: number; after: T; saves: number } | null = null;
  for (let to = 1; to < ids.length; to++) {
    if (to === at) continue;
    const order = moved(ids, id, to);
    const saves = now - modelSwitches(order.map((x) => byId.get(x)!), from);
    if (saves <= 0) continue;
    if (!best || saves > best.saves || (saves === best.saves && Math.abs(to - at) < Math.abs(best.to - at))) best = { to, after: byId.get(order[to - 1]!)!, saves };
  }
  return best;
}
