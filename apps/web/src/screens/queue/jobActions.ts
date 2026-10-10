import { useLocation } from "wouter";
import { useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { api, type HistoryPage } from "../../api";
import { HISTORY } from "../../data";
import { useBanners, useOpenDraft } from "../../store";
import { withoutJobs } from "./historyHead";

/**
 * The columns of the history: thumbnail · name · model · took · when (the header and every row line up on them). The
 * model takes up to 260 px before the name grows: "MiniMax H3 · Video with audio" reads whole on a wide window, while
 * the name has room to spare there. Every row is its own grid, so the width is fixed, not sized to each row's text.
 */
export const ROW = "grid grid-cols-[64px_minmax(0,1fr)_minmax(150px,260px)_110px_90px] items-center gap-x-3.5 px-3";

/** What is done with a finished job: again, back to its draft, out of the list. What fails is said in a banner. */
export function useJobActions() {
  const client = useQueryClient();
  const say = useBanners((b) => b.push);
  const failed = (title: string) => (err: Error) => say({ id: `history:${Date.now()}`, tone: "bad", title, text: err.message, href: "/queue", go: "Open queue" });
  const again = useMutation({ mutationFn: (v: { id: string; input?: Record<string, unknown> }) => api.retryJob(v.id, v.input), onSuccess: () => client.invalidateQueries({ queryKey: ["queue"] }), onError: failed("Could not queue it again") });
  // one job or a batch's row: one request, and the jobs taken out of the history as loaded (as the end of a job puts
  // them in, readHistoryHead) rather than every loaded page read again
  const dismiss = useMutation({
    mutationFn: (ids: string | string[]) => api.dismissJobs(typeof ids === "string" ? [ids] : ids),
    onSuccess: (_r, ids) => client.setQueriesData<InfiniteData<HistoryPage, string | null>>({ queryKey: HISTORY }, (was) => was && { ...was, pages: withoutJobs(was.pages, typeof ids === "string" ? [ids] : ids) }),
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
