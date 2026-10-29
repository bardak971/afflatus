import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SourceMarks } from "@afflatus/core";
import { api, type Timeline } from "../api";
import { queryKeys } from "../queryKeys";

/**
 * What a timeline's source is cut at besides its length, as the server reads them (Timelines.sourceMarksOf): its scene
 * cuts, the pauses in its speech and its loudness (the voice band's, else the whole sound's), each read once. Undefined
 * while they are read, or for a source cut at its length alone (± 0): its windows are then drawn at the length.
 */
export function useSourceMarks(source: Timeline["source"] | null | undefined): SourceMarks | undefined {
  const asset = source && source.withinMs > 0 ? source.asset : null;
  const opts = { enabled: Boolean(asset), staleTime: Infinity, retry: 0 } as const;
  const scenes = useQuery({ queryKey: queryKeys.scenes(asset ?? ""), queryFn: () => api.scenes(asset!), ...opts });
  const pauses = useQuery({ queryKey: queryKeys.pauses(asset ?? ""), queryFn: () => api.pauses(asset!), ...opts });
  const motion = useQuery({ queryKey: queryKeys.motion(asset), queryFn: () => api.motion(asset!), ...opts });
  // a sound that could not be read has no pauses nor loudness: the cuts alone
  const settled = (q: { isPending: boolean; isError: boolean }) => !q.isPending || q.isError;
  const ready = Boolean(asset) && scenes.isSuccess && settled(pauses) && settled(motion);
  const { data: s } = scenes;
  const { data: p } = pauses;
  const { data: m } = motion;
  return useMemo(() => {
    if (!ready || !s) return undefined;
    const db = m?.speech ?? m?.sound;
    return { cutsMs: s.cuts, pauses: p?.pauses ?? [], levels: db?.length ? { rate: m!.rate, db } : null };
  }, [ready, s, p, m]);
}
