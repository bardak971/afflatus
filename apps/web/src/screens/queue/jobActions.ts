import { useLocation } from "wouter";
import { useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { api, type HistoryPage } from "../../api";
import { useOpenDraft } from "../../store";
import { withoutJobs } from "./historyHead";
import { queryKeys } from "../../queryKeys";
import { useSayFailed } from "../../sayFailed";

/**
 * The columns of the history: thumbnail · name · model · took · when · menu (the header and every row line up on them;
 * a failed row's ··· has the last one, not the Took column it sat under, review 4 finding 16). The
 * model takes up to 260 px before the name grows: "MiniMax H3 · Video with audio" reads whole on a wide window, while
 * the name has room to spare there. Every row is its own grid, so the width is fixed, not sized to each row's text. On
 * a narrow list (its @container/history) the model goes, then the time it took: at 960 px the fixed columns left the
 * name none of the width.
 */
export const ROW = "grid grid-cols-[64px_minmax(0,1fr)_minmax(150px,260px)_80px_90px_32px] @max-[640px]/history:grid-cols-[64px_minmax(0,1fr)_64px_80px_32px] @max-[420px]/history:grid-cols-[48px_minmax(0,1fr)_72px_32px] items-center gap-x-3.5 px-3";
/** The model's cell of a history row: left out on a narrow list (ROW). */
export const MODEL_CELL = "@max-[640px]/history:hidden";
/** The time it took: left out on a list narrower still (ROW). */
export const TOOK_CELL = "@max-[420px]/history:hidden";

/** What is done with a finished job: again, back to its draft, out of the list. What fails is said in a banner. */
export function useJobActions() {
  const client = useQueryClient();
  const failed = useSayFailed({ id: "history", href: "/queue", go: "Open queue" });
  const again = useMutation({ mutationFn: (v: { id: string; input?: Record<string, unknown> }) => api.retryJob(v.id, v.input), onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.queue() }), onError: failed("Could not queue it again") });
  // one job or a batch's row: one request, and the jobs taken out of the history as loaded (as the end of a job puts
  // them in, readHistoryHead) rather than every loaded page read again
  const dismiss = useMutation({
    mutationFn: (ids: string | string[]) => api.dismissJobs(typeof ids === "string" ? [ids] : ids),
    onSuccess: (_r, ids) => client.setQueriesData<InfiniteData<HistoryPage, string | null>>({ queryKey: queryKeys.history.all() }, (was) => was && { ...was, pages: withoutJobs(was.pages, typeof ids === "string" ? [ids] : ids) }),
    onError: failed("Could not remove it from the history"),
  });
  const openDraft = useOpenDraft((s) => s.open);
  const [, go] = useLocation();
  const toDraft = (id: string) => {
    openDraft(id);
    go("/create");
  };
  return { again, dismiss, toDraft };
}
