import type { RenderItem, TimesSummary } from "../../api";

/**
 * What the Render times tab flags, worked out from the period's figures apart from the screen so that it
 * can be tested: a model slower than its own p50, the time lost to model swaps, the failures of a model,
 * the VRAM at its ceiling.
 */

type Line = Array<number | null>;
type Model = TimesSummary["models"][number];

/** How far over its own p50 a model's s/it has to run, in percent, to be flagged. */
export const SLOW = 15;
/** The share of the GPU time model loads have to take to be flagged. */
const SWAPS = 0.1;
/** The VRAM peak, in percent, from which the card is at its ceiling. */
export const VRAM_FULL = 95;

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

/**
 * A model's s/it against its own p50 (`pace`: 100 is as usual, per stretch), in percent over (+18) or under (−4).
 * A run of slow stretches at the end, two at least and the first of them slow, is said with when it began (`since`);
 * else the later half of the window says it.
 */
export function paceDrift(pace: Line, times: number[]): { pct: number; since: number | null } | null {
  const points = pace.flatMap((v, i) => (v === null ? [] : [{ i, v }]));
  if (!points.length) return null;
  for (let k = 0; k < points.length - 1; k++) {
    const run = points.slice(k).map((p) => p.v);
    const m = mean(run);
    if (points[k]!.v >= 100 + SLOW && m >= 100 + SLOW) return { pct: Math.round(m - 100), since: times[points[k]!.i] ?? null };
  }
  const later = points.filter((p) => p.i >= Math.floor(pace.length / 2));
  return { pct: Math.round(mean((later.length ? later : points.slice(-1)).map((p) => p.v)) - 100), since: null };
}

/** The change from `before` to `now`, in percent; null when there is nothing before to set it against. */
export function change(now: number, before: number | undefined | null): number | null {
  if (before === undefined || before === null || before <= 0) return null;
  return Math.round(((now - before) / before) * 100);
}

export type Flag =
  | { kind: "slow"; model: string; name: string; pct: number; since: number }
  | { kind: "swaps"; loads: number; loadMs: number; share: number }
  | { kind: "failures"; model: string; name: string; failed: number; oom: number; lostMs: number }
  | { kind: "vram"; peak: number; spills: number; spillLostMs: number; where: string | null };

/**
 * The flags of a period, most worth acting on first within each kind. `items`: the period's renders as the lanes have
 * them, to say which render hit the VRAM peak.
 */
export function flagsOf(d: TimesSummary, items: RenderItem[] = []): Flag[] {
  const t = d.tiles;
  const flags: Flag[] = [];
  for (const m of d.models) {
    const drift = paceDrift(m.pace, d.times);
    if (drift?.since !== null && drift?.since !== undefined) flags.push({ kind: "slow", model: m.key, name: short(m), pct: drift.pct, since: drift.since });
  }
  if (t.gpuMs > 0 && t.loads > 0 && t.loadMs / t.gpuMs >= SWAPS) flags.push({ kind: "swaps", loads: t.loads, loadMs: t.loadMs, share: t.loadMs / t.gpuMs });
  // a model's failures: an OOM always, else two or more that are one render in twenty or more of its own; the costliest first
  const failing = d.models
    .filter((m) => (m.oom ?? 0) > 0 || ((m.failed ?? 0) >= 2 && (m.failed ?? 0) / Math.max(1, m.renders) >= 0.05))
    .sort((a, b) => (b.lostMs ?? 0) - (a.lostMs ?? 0))
    .slice(0, 3);
  for (const m of failing) flags.push({ kind: "failures", model: m.key, name: short(m), failed: m.failed ?? 0, oom: m.oom ?? 0, lostMs: m.lostMs ?? 0 });
  if (t.vramPeak !== null && t.vramPeak >= VRAM_FULL) {
    const top = items.filter((r) => r.vram !== null).sort((a, b) => b.vram! - a.vram!)[0];
    const where = top ? [top.name.split(" · ")[0], top.width && top.height ? `${top.width}×${top.height}` : ""].filter(Boolean).join(" @ ") : null;
    flags.push({ kind: "vram", peak: Math.round(t.vramPeak), spills: t.spills ?? 0, spillLostMs: t.spillLostMs ?? 0, where });
  }
  return flags;
}

/** A model's name without its route ("LTX 2.3 · Video" → "LTX 2.3"), unless the route is all it has. */
const short = (m: Pick<Model, "name">) => m.name.split(" · ")[0] || m.name;
