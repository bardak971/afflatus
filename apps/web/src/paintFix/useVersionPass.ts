import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RecipeInfo } from "../api";
import { jobOfPass, PASSES, type StagePass } from "../passes";
import { useSendJob } from "../queueVariation";
import { queryKeys } from "../queryKeys";
import type { ViewerActions } from "../viewer/useViewerActions";
import { useVersionDrafts } from "./useStageMode";

/**
 * What a bar's ask makes of the recipe's inputs, worked out once the job is on its way (the mask's PNG is made then: the
 * bar is busy while it encodes, and a mask that cannot be made is said under the bar like any other failure).
 */
export interface VersionAsk {
  inputs(tool: RecipeInfo): Promise<Record<string, unknown>> | Record<string, unknown>;
  count?: number;
}

/**
 * A Stage pass's two ways from its bar (card #290): `send` queues the picture's recipe for it with the bar's inputs over
 * the stored ones, ×`count`, its results versions of the picture shown; `openForm` makes the same job a draft instead,
 * whose renders come back as versions too (useVersionDrafts). `tool`: the recipe the Stage drives for it (an outpaint the
 * frame cannot drive is none, and asked is "not installed").
 */
export function useVersionPass(acts: ViewerActions, key: StagePass, tool: RecipeInfo | undefined) {
  const { a, toolInput, openTool } = acts;
  const sendJob = useSendJob();
  const client = useQueryClient();
  const need = (): RecipeInfo => {
    if (!tool) throw new Error(`No ${PASSES[key].label.toLowerCase()} model is installed.`);
    return tool;
  };
  const send = useMutation({
    mutationFn: async ({ inputs, count }: VersionAsk) => {
      const t = need();
      const job = jobOfPass(key, t, toolInput(t), a.id);
      await sendJob({ ...job, stored: { ...job.stored, ...(await inputs(t)) }, ...(count ? { count } : {}) });
    },
    // the queue read again; why one failed is said in the bar it came from, not in a banner
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.queue() }),
  });
  // its renders are versions of the picture, marked as the draft opens, before the viewer (and this hook) goes
  const openForm = useMutation({
    mutationFn: async ({ inputs }: Omit<VersionAsk, "count">) => {
      const t = need();
      const picture = a.id;
      await openTool.mutateAsync({ id: t.id, with: await inputs(t), opened: (d) => useVersionDrafts.getState().mark(d.id, picture) });
    },
  });
  return { send, openForm };
}
