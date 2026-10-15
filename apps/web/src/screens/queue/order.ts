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

/**
 * When the waiting jobs are all done, in ms from now, as "about N in all" says it: the server's plan's last end
 * (`plannedEnd`, QueueStatus.waitingEndsInMs) when it gives one, else the latest a waiting job ends where the plan said
 * when each starts, else (nothing planned: the queue paused) the jobs shared between the `machines` up (their ids; left
 * out: one machine of one's own), each job to the one free first of those it can run on, after the running one. Summed
 * with several machines, 40 jobs on 4 machines said "5 min" for what took 75 s, and 47 paused on 3 said 23 min for 11.
 * A job none of them can take adds nothing; none up: 0, nothing said.
 */
export function waitingEnds(waiting: ReadonlyArray<Pick<Job, "estimateMs" | "startsInMs"> & Partial<Pick<Job, "runsOn" | "pinned">>>, running: { eta: number | null } | null, plannedEnd?: number | null, machines?: readonly string[]): number {
  if (typeof plannedEnd === "number") return plannedEnd;
  const left = (running?.eta ?? 0) * 1000;
  if (waiting.some((w) => w.startsInMs !== null && w.startsInMs !== undefined)) {
    return waiting.reduce((end, w) => Math.max(end, (w.startsInMs ?? 0) + (w.estimateMs ?? 0)), left);
  }
  if (!machines) return waiting.reduce((sum, w) => sum + (w.estimateMs ?? 0), 0) + left;
  if (!machines.length) return 0;
  const free = new Map(machines.map((id, i) => [id, i === 0 ? left : 0]));
  for (const w of waiting) {
    const can = (w.pinned ? [w.pinned] : w.runsOn ?? machines).filter((id) => free.has(id));
    const at = can.reduce<string | null>((best, id) => (best === null || free.get(id)! < free.get(best)! ? id : best), null);
    if (at !== null) free.set(at, free.get(at)! + (w.estimateMs ?? 0));
  }
  return Math.max(...free.values());
}
