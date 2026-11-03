import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type Clip } from "../api";
import { queryKeys } from "../queryKeys";

/**
 * The clip the inspector shows, each take with what it was made with (`Take.made`, card #89). The timeline's answer leaves
 * it out (card #242: with every read of the timeline it was a third of it), so it is read here for this clip alone, once
 * per set of takes: a take's never changes. A take that already says (the answer of an older server, a test's) is kept.
 */
export function useClipMade(clip: Clip): Clip {
  const lacks = clip.takes.some((t) => t.made === undefined);
  const read = useQuery({ queryKey: queryKeys.clipMade(clip), queryFn: ({ signal }) => api.clipMade(clip.id, { signal }), enabled: lacks, staleTime: Infinity });
  const got = read.data?.takes;
  return useMemo(() => {
    if (!lacks || !got) return clip;
    const takes = clip.takes.map((t) => (t.made === undefined && t.id in got ? { ...t, made: got[t.id] } : t));
    return { ...clip, takes, take: clip.take ? (takes.find((t) => t.id === clip.take!.id) ?? clip.take) : null };
  }, [clip, got, lacks]);
}
