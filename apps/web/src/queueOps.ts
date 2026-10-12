import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type QueueStatus } from "./api";
import { useSayFailed } from "./sayFailed";
import { useBanners } from "./store";
import { queryKeys } from "./queryKeys";

/**
 * The queue's own actions, the one body each wherever they are asked from (the Queue screen, the status bar, the
 * model's menu, the command bar, a machine's card): pause and resume (all, or one machine), use only one machine, unload
 * the models (of one machine, or every idle one), and ask ComfyUI again (reconnect). Each says in one banner what
 * failed; Unload and Reconnect say what they did too.
 */
export function useQueueOps() {
  const client = useQueryClient();
  const say = useBanners((b) => b.push);
  const failed = useSayFailed({ id: "queue", href: "/queue", go: "Open queue" });
  const settle = (q: QueueStatus) => client.setQueryData(queryKeys.queue(), q);
  const pause = useMutation({ mutationFn: (machine?: string) => api.pause(machine), onSuccess: settle, onError: failed("Could not pause the queue") });
  const resume = useMutation({ mutationFn: (machine?: string) => api.resume(machine), onSuccess: settle, onError: failed("Could not resume the queue") });
  const useOnly = useMutation({ mutationFn: (machine: string) => api.useOnly(machine), onSuccess: settle, onError: failed("Could not send the queue to that machine") });
  const unload = useMutation({
    mutationFn: (machine?: string) => api.freeMemory(machine),
    onSuccess: () => {
      say({ id: `free:${Date.now()}`, tone: "good", title: "Models unloaded", text: "The next render loads what it needs again.", href: "/queue", go: "Open queue" });
      void client.invalidateQueries({ queryKey: queryKeys.queue() });
    },
    onError: failed("Could not unload the models"),
  });
  const reconnect = useMutation({
    // Settings' Test again, then the queue asked to look now rather than at its next try (a paused queue stays paused)
    mutationFn: async () => {
      const scan = await api.rescanSetup();
      client.setQueryData(queryKeys.setup(), scan);
      const q = client.getQueryData<QueueStatus>(queryKeys.queue());
      if (scan.comfy.online && q && !q.paused) settle(await api.resume());
      return scan;
    },
    onSuccess: (scan) => {
      if (scan.comfy.online) say({ id: `comfy:${Date.now()}`, tone: "good", title: "ComfyUI answers", text: scan.comfy.url, href: "/queue", go: "Open queue" });
      else say({ id: `comfy:${Date.now()}`, tone: "bad", title: "ComfyUI does not answer", text: scan.comfy.error, href: "/settings", go: "Open settings" });
    },
    onError: failed("Could not reach ComfyUI"),
    onSettled: () => {
      for (const queryKey of [queryKeys.settings(), queryKeys.queue()]) void client.invalidateQueries({ queryKey });
    },
  });
  return { pause, resume, useOnly, unload, reconnect };
}
