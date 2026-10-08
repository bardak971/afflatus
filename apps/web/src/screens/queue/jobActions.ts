import { useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { HISTORY } from "../../data";
import { useBanners, useOpenDraft } from "../../store";

/** The columns of the history: thumbnail · name · model · took · when (the header and every row line up on them). */
export const ROW = "grid grid-cols-[64px_minmax(0,1fr)_150px_110px_90px] items-center gap-x-3.5 px-3";

/** What is done with a finished job: again, back to its draft, out of the list. What fails is said in a banner. */
export function useJobActions() {
  const client = useQueryClient();
  const say = useBanners((b) => b.push);
  const failed = (title: string) => (err: Error) => say({ id: `history:${Date.now()}`, tone: "bad", title, text: err.message, href: "/queue", go: "Open queue" });
  const again = useMutation({ mutationFn: (v: { id: string; input?: Record<string, unknown> }) => api.retryJob(v.id, v.input), onSuccess: () => client.invalidateQueries({ queryKey: ["queue"] }), onError: failed("Could not queue it again") });
  const dismiss = useMutation({ mutationFn: api.dismissJob, onSuccess: () => client.invalidateQueries({ queryKey: HISTORY }), onError: failed("Could not remove it from the history") });
  const openDraft = useOpenDraft((s) => s.open);
  const [, go] = useLocation();
  const toDraft = (id: string) => {
    openDraft(id);
    go("/create");
  };
  return { again, dismiss, toDraft };
}
