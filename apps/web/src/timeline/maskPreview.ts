import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { queryKeys } from "../queryKeys";

/** A Show the mask asked for a clip: its job, and whether its video is drawn over the source on the stage. */
export type ClipMask = { job: string; shown: boolean };

/** How a Show the mask stands: asked every second and a half until its job ends (done, failed or cancelled). */
export function useMaskPreview(clipId: string | undefined, job: string | undefined) {
  return useQuery({
    queryKey: queryKeys.maskPreview(job ?? ""),
    queryFn: () => api.maskPreviewOf(clipId!, job!),
    enabled: Boolean(clipId && job),
    refetchInterval: (q) => (q.state.data && ["done", "failed", "cancelled"].includes(q.state.data.status) ? false : 1500),
  });
}
