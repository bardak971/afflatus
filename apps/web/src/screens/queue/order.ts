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

/** How many times the model changes down the line of renders: each change costs a model load. */
export function modelSwitches(waiting: Array<Pick<Job, "kind" | "recipe">>): number {
  let n = 0;
  let last: string | null = null;
  for (const w of waiting) {
    if (w.kind !== "render") continue;
    if (last && w.recipe !== last) n++;
    last = w.recipe;
  }
  return n;
}
