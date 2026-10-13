import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { useSayFailed } from "./sayFailed";
import { queryKeys } from "./queryKeys";

/** A pod's page on RunPod's site, where the user made it: its own settings, its logs, its terminal. */
export const RUNPOD_CONSOLE = "https://www.runpod.io/console/pods";

/**
 * A rented machine's Start and Stop, the one body each wherever they are asked from (its card in Settings, its menu, the
 * command bar). Start is always the user's: Afflatus never starts a pod on its own. Each says in one banner what failed
 * (a cap reached, RunPod refusing); the queue and the spending are read again after.
 */
export function useRentedOps() {
  const client = useQueryClient();
  const failed = useSayFailed({ id: "rented", href: "/settings", go: "Open settings" });
  const settle = () => {
    // a Terminate takes the machine out of the settings too
    for (const queryKey of [queryKeys.queue(), queryKeys.rentedSpending(), queryKeys.runpodPods(), queryKeys.settings(), queryKeys.machines()]) void client.invalidateQueries({ queryKey });
  };
  const start = useMutation({ mutationFn: (machine: string) => api.startMachine(machine), onSuccess: settle, onError: failed("Could not start the pod") });
  const stop = useMutation({ mutationFn: (v: { machine: string; how: "stop" | "terminate" }) => api.stopMachine(v.machine, v.how), onSuccess: settle, onError: failed("Could not stop the pod") });
  return { start, stop };
}
