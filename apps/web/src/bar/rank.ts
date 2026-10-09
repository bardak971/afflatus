/**
 * What the bar learns of what you use: each result opened counts, and counts less as the days go by. Kept in
 * this browser (localStorage `afflatus.bar.rank`), read and written in try/catch: a browser that keeps nothing
 * still has a bar, it only does not learn. Pure but for `load` and `save`.
 */

/** One result's use: its count (worn down to `t`) and when it was last used. */
export interface Use {
  n: number;
  t: number;
}
export type Ranks = Record<string, Use>;

export const RANK_KEY = "afflatus.bar.rank";
/** A use counts half as much a week later. */
export const HALF_LIFE_MS = 7 * 24 * 3_600_000;
/** The most results remembered: past that, the least used are forgotten. */
export const KEPT = 400;

/** A use's weight now. */
export const frecency = (u: Use | undefined, now: number): number => (u ? u.n * 0.5 ** (Math.max(0, now - u.t) / HALF_LIFE_MS) : 0);

/**
 * What a result's use adds to its match: enough to lift the one you open every day over one that matches
 * as well, never enough to put a result that barely matches over one that matches from its start.
 */
export const bonus = (u: Use | undefined, now: number): number => (u ? Math.min(260, 110 * Math.log2(1 + frecency(u, now))) : 0);

/** One more use of `key`, now; the least used are let go past KEPT. */
export function bumped(ranks: Ranks, key: string, now: number): Ranks {
  const next: Ranks = { ...ranks, [key]: { n: frecency(ranks[key], now) + 1, t: now } };
  const keys = Object.keys(next);
  if (keys.length <= KEPT) return next;
  const kept = keys.sort((a, b) => frecency(next[b], now) - frecency(next[a], now)).slice(0, KEPT);
  return Object.fromEntries(kept.map((k) => [k, next[k]!]));
}

/** The ranks with some keys renamed (a result whose key changed keeps what was learned of it); two that meet add up, the later use kept. */
export function renamed(ranks: Ranks, rename: (key: string) => string): Ranks {
  const out: Ranks = {};
  for (const [k, u] of Object.entries(ranks)) {
    const to = rename(k);
    const had = out[to];
    out[to] = had ? { n: had.n + u.n, t: Math.max(had.t, u.t) } : u;
  }
  return out;
}

/** The keys last used, newest first. */
export const recentKeys = (ranks: Ranks, n: number): string[] =>
  Object.entries(ranks)
    .sort((a, b) => b[1].t - a[1].t)
    .slice(0, n)
    .map(([k]) => k);

/** What this browser learned; nothing when it keeps nothing or what it kept is not ours. */
export function load(): Ranks {
  try {
    const raw = JSON.parse(localStorage.getItem(RANK_KEY) ?? "{}") as unknown;
    if (!raw || typeof raw !== "object") return {};
    const out: Ranks = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const u = v as Partial<Use> | null;
      if (u && typeof u.n === "number" && typeof u.t === "number" && Number.isFinite(u.n) && Number.isFinite(u.t)) out[k] = { n: u.n, t: u.t };
    }
    return out;
  } catch {
    return {};
  }
}

export function save(ranks: Ranks): void {
  try {
    localStorage.setItem(RANK_KEY, JSON.stringify(ranks));
  } catch {
    // a private window, a full storage: not kept, the bar still works
  }
}
