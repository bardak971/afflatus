import type { Services } from "./services";
import type { Machine } from "./settings";

/**
 * What work may cost on rented pods, read the one way for every check before it is queued: each pod's rate and whether it
 * is up, a form's forecast for pricing (read once per form), and what each cell of a grid takes on a machine. MCP's spend
 * cap (mcpRender.ts mayQueueAll) and the grid card's figure and its ask (grids.ts planGrid) both price from here, so that
 * what the user is asked about is what a token is held to.
 */

/** A pod in these states takes no job now (stopped, terminated, gone from the account, failed): only a render pinned there may wait for it. */
const IDLE_POD = new Set(["EXITED", "TERMINATED", "GONE", "ERROR"]);

/**
 * Each rented pod's hourly rate (its RunPod price; null while it is not known), and whether it may take a job now, as the
 * pods are watched (rented.ts view, in memory: never the queue's last status, which may predate a pod just started). A pod
 * not read yet counts as up with no known price: a render that may land there is refused rather than counted as free.
 */
export function podsOf(s: Services, machines: readonly Machine[]): Map<string, { rate: number | null; up: boolean }> {
  return new Map(machines.flatMap((machine) => {
    if (!machine.rented) return [];
    const v = s.rented.view(machine);
    return [[machine.id, { rate: v?.rate ?? null, up: !v || !IDLE_POD.has(v.status) }] as const];
  }));
}

/** The forecasts read for one count of work, by form: renders of one form are forecast once. */
export type Prices = Map<string, Promise<Awaited<ReturnType<Services["queue"]["forecastToPrice"]>> | null>>;
export const priced = (s: Services, prices: Prices, recipe: string, input: unknown) => {
  const key = `${recipe}\u0001${JSON.stringify(input)}`;
  let got = prices.get(key);
  if (!got) prices.set(key, (got = s.queue.forecastToPrice(recipe, input).catch(() => null)));
  return got;
};

/** What one cell of a grid takes on a machine (ms), null when nothing like it was rendered; `sure`: from 3 renders or more. */
export interface CellTime {
  ms: number | null;
  sure: boolean;
}

/**
 * What each cell of a grid takes on a machine (`machine`; null: the machine the forecast picks), in the order they are
 * queued: each cell's own forecast, so a steps, size, hires or model axis is priced at what it renders, not at the base
 * form's cost times the count (the 2026-11-05 review: a steps 20-150 axis priced at 20 steps). A model is loaded where a
 * cell's model is not the one before it, at worst as the queue takes them in order, and not again for a run of cells with it.
 */
export async function cellTimes(s: Services, recipe: string, inputs: readonly unknown[], machine: string | null, prices: Prices = new Map()): Promise<CellTime[]> {
  const got = await Promise.all(inputs.map((input) => priced(s, prices, recipe, input)));
  let held: string | null = null;
  return got.map((g) => {
    const f = g ? (machine ? g.on?.[machine] ?? g.forecast : g.forecast) : null;
    if (!g || !f) {
      held = null;
      return { ms: null, sure: false };
    }
    const loads = g.model !== held;
    held = g.model;
    return { ms: loads ? f.ms : Math.max(0, f.ms - f.loadMs), sure: f.samples >= 3 };
  });
}

/** The cells' times added up, null when one of them is not known. */
export const cellsTotal = (times: readonly CellTime[]): number | null => (times.some((t) => t.ms === null) ? null : times.reduce((n, t) => n + t.ms!, 0));
