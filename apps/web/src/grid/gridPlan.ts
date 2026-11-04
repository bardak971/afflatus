import { gridAxes, gridCount, gridCountSaid, usdFor, type GridAxisValues, type GridSetup } from "@afflatus/core";
import type { Advice, MachineState, RecipeInfo, RecipeStatus } from "../api";
import { batchMs, useAdvice } from "../advice";
import { useQueue } from "../data";
import { usePickedMachine } from "../GenerateOn";
import { severalMachines } from "../machines";

/**
 * What a grid will take before it is queued (card #21), said on its card and its button always: the count, the time from
 * the user's own renders (render_stats, through the form's forecast), and on a rented pod the money at its rate. Read
 * here once for the card, the button and the guard.
 */
export interface GridPlan {
  /** The axes in use, worked out; empty when none has a field and values yet. */
  axes: GridAxisValues[];
  /** The first axis that cannot be read and why (its index, X = 0). */
  error: { axis: number; text: string } | null;
  count: number;
  /** "3 × 4 × 2 = 24 renders". */
  said: string;
  /** All of it, on the machine it goes to (on Auto, shared as the queue shares it); null without a forecast. */
  ms: number | null;
  /** On a rented pod it may go to: the time there and the money, at worst (all of it on the dearest); null off pods. */
  pod: { ms: number | null; usd: number | null } | null;
}

/**
 * The plan of a grid from its axes and the form's forecast for one render. A steps axis scales the sampling by its values
 * against the form's own steps (time goes with steps); a model axis loads each of its models once more.
 */
export function planOf(axes: readonly GridAxisValues[], estimate: Pick<Advice, "ms" | "loadMs" | "on" | "loadOn" | "auto"> | null | undefined, opts: { picked?: MachineState | null; machines: readonly MachineState[]; steps?: { id: string; base: number }; models?: readonly string[] }): Pick<GridPlan, "count" | "said" | "ms" | "pod"> {
  const count = gridCount(axes);
  const said = gridCountSaid(axes);
  const stepsAxis = opts.steps ? axes.find((a) => a.field === opts.steps!.id) : undefined;
  // the share of the sampling the steps axis makes, its values' mean against the form's steps
  const factor = stepsAxis && opts.steps!.base > 0 ? stepsAxis.values.reduce<number>((n, v) => n + Number(v), 0) / stepsAxis.values.length / opts.steps!.base : 1;
  const modelAxis = axes.find((a) => opts.models?.includes(a.field));
  const extraLoads = modelAxis ? modelAxis.values.length - 1 : 0;
  const total = (m: MachineState | null) => {
    if (!estimate || !count) return null;
    const all = batchMs(estimate, count, m);
    if (all === null) return null;
    const load = m && estimate.loadOn?.[m.id] !== undefined ? estimate.loadOn[m.id]! : estimate.loadMs;
    return Math.round((all - load) * factor + load * (1 + extraLoads));
  };
  const ms = total(opts.picked ?? null);
  // the pods it may go to: the one picked, else those Auto may give it to (the server's list), else every pod set up
  const pods = (opts.picked ? [opts.picked] : opts.machines.filter((m) => !estimate?.auto || estimate.auto.includes(m.id))).filter((m) => m.rented);
  if (!pods.length) return { count, said, ms, pod: null };
  const each = pods.map((p) => {
    const t = total(p);
    return { ms: t, usd: t === null || p.rented?.rate == null ? null : usdFor(t, p.rented.rate) };
  });
  // money is said at its worst: an amount not known on any of them is not known
  const usd = each.some((e) => e.usd === null) ? null : Math.max(...each.map((e) => e.usd!));
  const podMs = each.some((e) => e.ms === null) ? null : Math.max(...each.map((e) => e.ms!));
  return { count, said, ms, pod: { ms: podMs, usd } };
}

/** The grid of the form as it stands, worked out and planned (see GridPlan). */
export function useGridPlan(recipe: RecipeInfo | undefined, whole: Record<string, unknown>, setup: GridSetup | null | undefined, status: RecipeStatus | undefined, draftId: string | undefined): GridPlan {
  const queue = useQueue();
  const picked = usePickedMachine(draftId);
  const estimate = useAdvice(recipe, whole).data?.estimate;
  const read = recipe && setup?.axes.some((a) => a.field) ? gridAxes(recipe.inputs, whole, setup, gridOptions(status)) : { axes: [] };
  const axes = "axes" in read ? read.axes : [];
  const error = "error" in read ? { axis: read.axis, text: read.error } : null;
  const stepsSpec = recipe?.inputs.find((i) => i.type === "number" && i.id === "steps");
  const plan = planOf(axes, estimate, {
    picked: picked ?? null,
    machines: severalMachines(queue.data),
    steps: stepsSpec ? { id: stepsSpec.id, base: Number(whole[stepsSpec.id]) || 0 } : undefined,
    models: recipe?.inputs.filter((i) => i.type === "model").map((i) => i.id),
  });
  return { axes, error, ...plan };
}

/** The lists the form offers (a model's files, a sampler's names) by input id: where a typed value is found. */
export const gridOptions = (status: RecipeStatus | undefined): Record<string, string[]> => status?.options ?? {};
