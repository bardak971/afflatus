import type { HistoryJob } from "../../api";

/**
 * Which failures the history pins on top, worked out apart from the screen: only the ones since the last render
 * that went well (or since the page opened, when none did). They are what is wrong now; an older failure was
 * followed by a render that worked, and stays in time order with the rest.
 */

/** When this page was opened: with no render done in what is loaded, failures since then are the ones pinned. */
export const SESSION_START = Date.now();

const at = (j: Pick<HistoryJob, "finishedAt" | "createdAt">) => new Date(j.finishedAt ?? j.createdAt).getTime();

/** The failures to pin, newest first, and since when (the last render done, or the page opening). `items`: newest first, as the history lists them. */
export function pinnedFailures<T extends Pick<HistoryJob, "status" | "kind" | "finishedAt" | "createdAt">>(items: T[], sessionStart = SESSION_START): { pinned: T[]; since: number } {
  const lastDone = items.find((j) => j.status === "done" && j.kind === "render");
  const since = lastDone ? at(lastDone) : sessionStart;
  return { pinned: items.filter((j) => j.status === "failed" && at(j) > since), since };
}

/** A failure's reason in a few words, for the strip that lists several: the error's first sentence, short. */
export function reasonOf(error: string | null): string {
  const first = (error ?? "failed").split(/(?<=[.!?])\s|\n/)[0]!.replace(/[.!?]$/, "").trim();
  return first.length > 48 ? `${first.slice(0, 47)}…` : first;
}

/** The different reasons of several failures, the most frequent first: at most `max`, then "+N". */
export function reasonsOf(jobs: Array<Pick<HistoryJob, "error">>, max = 3): string {
  const counts = new Map<string, number>();
  for (const j of jobs) counts.set(reasonOf(j.error), (counts.get(reasonOf(j.error)) ?? 0) + 1);
  const all = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => (n > 1 ? `${r} ×${n}` : r));
  return [...all.slice(0, max), all.length > max ? `+${all.length - max}` : ""].filter(Boolean).join(" · ");
}

/** The local day a job finished on, as a key ("2026-10-09"). */
export function dayOf(j: Pick<HistoryJob, "finishedAt" | "createdAt">): string {
  const d = new Date(at(j));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** A day's heading: "Today", "Yesterday", else "01/10" (and the year when it is not this one). */
export function dayLabel(key: string, now = new Date()): string {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  const day = new Date(y, m - 1, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const back = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (back === 0) return "Today";
  if (back === 1) return "Yesterday";
  return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}${y === now.getFullYear() ? "" : `/${y}`}`;
}

/** "14:02": the hour a strip counts from. */
export const hourOf = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
