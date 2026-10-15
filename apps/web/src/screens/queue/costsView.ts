import type { CostPart, CostsView, PartMs, PodSession } from "../../api";
import { gb, long, plural, usd } from "../../format";

/**
 * What the Costs tab works out apart from drawing it: its windows, the parts of a pod's time as said, a session's bar, how
 * long the balance lasts. The figures themselves come from the server (costs.ts).
 */

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** The chart's series for what RunPod billed beyond Afflatus's count of the pods' time (the server's costs.ts NOT_SPLIT). */
export const NOT_SPLIT = "Not split";

/** The windows a click gives, each ending now; "Month" from the 1st, "All" from the first session or render. */
export const COST_PRESETS: ReadonlyArray<{ label: string; ms: number | null | "month" }> = [
  { label: "1H", ms: HOUR }, { label: "6H", ms: 6 * HOUR }, { label: "24H", ms: DAY }, { label: "7D", ms: 7 * DAY }, { label: "30D", ms: 30 * DAY }, { label: "Month", ms: "month" }, { label: "All", ms: null },
];

/** A preset's window as asked now: null for "All" (the server reaches back to the first). */
export function presetWindow(label: string, now = Date.now()): { from: number; to: number } | null {
  const p = COST_PRESETS.find((x) => x.label === label) ?? COST_PRESETS[4]!;
  if (p.ms === null) return null;
  if (p.ms === "month") {
    const d = new Date(now);
    return { from: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), to: now };
  }
  return { from: now - p.ms, to: now };
}

/** The parts in the order they are drawn and said, with their names and colours (theme tokens). */
export const PART_SAID: ReadonlyArray<{ part: CostPart; name: string; color: string }> = [
  { part: "render", name: "Rendering", color: "var(--color-accent)" },
  { part: "boot", name: "Booting", color: "var(--color-ink-3)" },
  { part: "fetch", name: "Fetching files", color: "var(--color-picture)" },
  { part: "idle", name: "Idle", color: "color-mix(in srgb, var(--color-warn) 45%, var(--color-ink-2))" },
  { part: "failed", name: "Failed renders", color: "var(--color-warn)" },
];

/** Of the pods' money, the share that made nothing: all but the renders that finished (0 to 1). */
export function nothingShare(usd: Record<CostPart, number>): number {
  const total = Object.values(usd).reduce((n, v) => n + v, 0);
  return total > 0 ? 1 - usd.render / total : 0;
}

export const totalMs = (ms: PartMs) => Object.values(ms).reduce((n, v) => n + v, 0);

/** How long something lasts, as said: "about 4 months", "about 12 days", "about 9 h", "about 40 min". */
function lastsSaid(days: number): string {
  if (days >= 60) return `about ${Math.round(days / 30)} months`;
  if (days >= 2) return `about ${Math.round(days)} days`;
  if (days * 24 >= 1) return `about ${Math.round(days * 24)} h`;
  return `about ${Math.max(1, Math.round(days * 24 * 60))} min`;
}

/** How long the balance lasts at this pace, as said: "about 4 months at this pace". */
export function runwaySaid(days: number | null): string {
  if (days === null) return "nothing spent in the last 7 days, no storage";
  return `${lastsSaid(days)} at this pace`;
}

/**
 * How long the balance lasts at what the account spends an hour now, beside the runway at this pace: "11 h at $0.60/h now".
 * Said only while that spend runs half again faster than the pace's day (a pod running): else the pace's runway says it
 * well enough, and two figures a few days apart would only puzzle.
 */
export function runwayNowSaid(r: { spendPerHr: number | null; runwayNowMs: number | null; perDay: number }): string | null {
  if (r.spendPerHr === null || r.runwayNowMs === null || r.spendPerHr * 24 <= r.perDay * 1.5) return null;
  return `${lastsSaid(r.runwayNowMs / DAY)} at ${usd(r.spendPerHr)}/h now`;
}

/** What the runways rest on, for their "?": the same words in Settings and Queue › Costs. */
export function runwayWhy(perDay: { pods: number; storage: number }): string {
  return `At this pace: the balance over ${usd(perDay.pods + perDay.storage)} a day, the pods' last 7 days (${usd(perDay.pods)} a day, Afflatus's count) and storage as it stands (${usd(perDay.storage)} a day: network volumes, stopped pods' disks). Now: at what RunPod says the account spends an hour, said while a pod runs; a render that would end after it is not sent to a rented pod. At $0 RunPod stops every pod.`;
}

/** A session's bar: each part's share of the longest session's length (0 to 1), and its tip; parts it did not have left out. */
export function sessionBits(s: PodSession, longest: number): Array<{ part: CostPart; share: number; color: string; tip: string }> {
  const guessed = (part: CostPart) => (s.estimated.some((e) => (part === "boot" ? e.startsWith("its boot") : part === "fetch" ? e.startsWith("its files") : false)) ? " (estimated)" : "");
  const done = s.renders.filter((r) => r.status === "done").length;
  const failed = s.renders.length - done;
  const tip = (part: CostPart, ms: number) =>
    part === "boot" ? `Booting · ${long(ms)}${guessed("boot")}`
    : part === "fetch" ? `Fetching ${s.fetched.files ? `${plural(s.fetched.files, "file")}, ${gb(s.fetched.bytes)}` : "files"} · ${long(ms)}${guessed("fetch")}`
    : part === "render" ? `${plural(done, "render")} · ${long(ms)}`
    : part === "failed" ? `${plural(failed, "failed render")} · ${long(ms)}`
    : `Idle · ${long(ms)}`;
  return PART_SAID.filter((p) => s.parts[p.part] > 0).map((p) => ({ part: p.part, share: longest > 0 ? s.parts[p.part] / longest : 0, color: p.color, tip: tip(p.part, s.parts[p.part]) }));
}

/** The top note: where the totals come from, and how old RunPod's bill is. */
export function totalsSaid(d: Pick<CostsView, "billed" | "billReadAt" | "runpod">, now = Date.now()): string {
  if (!d.runpod) return "No RunPod key: only this PC's renders are counted, at its electricity.";
  const split = "What each part and each render cost is Afflatus's own split of the pods' time, at their rates.";
  if (!d.billed || d.billReadAt === null) return `Totals are Afflatus's own count of the pods' time at their rates (RunPod's bill not read). ${split}`;
  const ago = Math.max(0, now - d.billReadAt);
  return `Totals from RunPod's bill (read ${ago < 60_000 ? "just now" : `${long(ago)} ago`}; it is written some hours late, Afflatus's own count fills the gap). ${split}`;
}
