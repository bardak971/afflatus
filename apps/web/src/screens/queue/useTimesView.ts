import { useState } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import { useRenderTimes } from "../../data";

export const HOUR = 3_600_000;
export const DAY = 86_400_000;
/** The windows a click gives, each ending now; "All" reaches back to the first render. */
export const PRESETS: Array<{ label: string; ms: number | null }> = [
  { label: "1H", ms: HOUR }, { label: "3H", ms: 3 * HOUR }, { label: "6H", ms: 6 * HOUR }, { label: "12H", ms: 12 * HOUR }, { label: "24H", ms: 24 * HOUR },
  { label: "2D", ms: 2 * 24 * HOUR }, { label: "7D", ms: 7 * 24 * HOUR }, { label: "30D", ms: 30 * 24 * HOUR }, { label: "All", ms: null },
];
/**
 * What is looked at: a preset (a window that ends now, worked out each time it is read, so that new renders
 * come into it), or a window of its own (typed, or dragged on a chart).
 */
export type View = { preset: string } | { preset: "custom"; from: number; to: number };
export const presetOf = (label: string) => PRESETS.find((x) => x.label === label) ?? PRESETS[6]!;

/** A moment as a datetime-local input writes it (local time, to the minute). */
export const toLocalInput = (ms: number) => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** A typed window, when it is one: both ends read, the end after the start. */
export function typedWindow(typed: { from: string; to: string } | null): { from: number; to: number } | null {
  if (!typed) return null;
  // typed as the box shows it, "2026-10-01 09:00": read as local time
  const read = (s: string) => (/^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}$/.test(s.trim()) ? Date.parse(s.trim().replace(" ", "T")) : NaN);
  const from = read(typed.from);
  const to = read(typed.to);
  return Number.isFinite(from) && Number.isFinite(to) && to > from ? { from, to } : null;
}

/**
 * The Render times tab's state and what it reads: the window looked at, the model picked, the list's
 * filter, and the three queries (the summary, the list a page at a time, every render for the lanes).
 */
export function useTimesView() {
  const [view, setView] = useState<View>({ preset: "24H" });
  const [typed, setTyped] = useState<{ from: string; to: string } | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [only, setOnly] = useState<"all" | "trouble">("all");
  const times = useRenderTimes("from" in view ? { from: view.from, to: view.to } : { preset: view.preset, ms: presetOf(view.preset).ms });
  // the list and the lanes are keyed on the preset (or the typed or dragged window), not on the window the figures
  // were read with: a preset's window moves on each read, and a new key read everything twice and blanked the list.
  // A preset's window is worked out when each is read, as the figures' is (windowOf); "All" asks for no bounds
  const key = "from" in view ? `${Math.round(view.from)}-${Math.round(view.to)}` : view.preset;
  const bounds = (): { from?: number; to?: number } => {
    if ("from" in view) return { from: view.from, to: view.to };
    const ms = presetOf(view.preset).ms;
    const now = Date.now();
    return ms === null ? {} : { from: now - ms, to: now };
  };
  const renders = useInfiniteQuery({
    queryKey: ["renders", "list", model, only, key],
    queryFn: ({ pageParam, signal }) => api.renders({ recipe: model ?? undefined, trouble: only === "trouble", before: pageParam, limit: 30, ...bounds() }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.more ? last.items.at(-1)?.at : undefined),
    placeholderData: keepPreviousData,
  });
  // every render of the window, for the lanes (up to five hundred: the longest keep their place in the chart either way)
  const lanes = useQuery({
    queryKey: ["renders", "lanes", key],
    queryFn: ({ signal }) => api.renders({ ...bounds(), limit: 500 }, { signal }),
    placeholderData: keepPreviousData,
  });
  const zoom = (from: number, to: number) => {
    setTyped(null);
    setView({ preset: "custom", from, to });
  };
  const pick = (preset: string) => {
    setTyped(null);
    setView({ preset });
  };
  return { view, typed, setTyped, model, setModel, only, setOnly, times, renders, lanes, zoom, pick };
}
