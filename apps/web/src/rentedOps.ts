import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type QueueStatus, type RentedState, type Settings } from "./api";
import { ask } from "./Confirm";
import { usd } from "./format";
import { idleEndSaid, machineLabel, machineName, rateSaid } from "./machines";
import { failedBanner } from "./sayFailed";
import { useBanners } from "./store";
import { queryKeys } from "./queryKeys";

/** A pod's page on RunPod's site, where the user made it: its own settings, its logs, its terminal. */
export const RUNPOD_CONSOLE = "https://www.runpod.io/console/pods";

/** A rented machine as the places that start or stop one have it (the queue's row, the command bar's). */
interface Pod {
  id: string;
  name: string;
  url: string;
  running: unknown;
  rented: RentedState | null;
}

/**
 * A rented machine's Start and Stop, the one body each wherever they are asked from (its card in Settings, its menu, the
 * command bar). Start is always the user's: Afflatus never starts a pod on its own. A failure is said in a banner that
 * names the pod, one per pod (Stop all pods stops several: each refused one must be told apart, since it still bills);
 * the queue and the spending are read again after.
 *
 * `askStart` and `askStop` ask first, as the card's Start… and Stop… do: the rate and how it ends before a Start, and
 * before a Stop that a render on it is lost (its minutes paid for nothing). The menu and the command bar use them.
 */
export function useRentedOps() {
  const client = useQueryClient();
  const say = useBanners((b) => b.push);
  const settle = () => {
    // a Terminate takes the machine out of the settings too
    for (const queryKey of [queryKeys.queue(), queryKeys.rentedSpending(), queryKeys.runpodPods(), queryKeys.settings(), queryKeys.machines()]) void client.invalidateQueries({ queryKey });
  };
  // its name as the queue last said it: the failure may come after the menu or the bar that asked is gone
  const nameOf = (id: string) => machineName(client.getQueryData<QueueStatus>(queryKeys.queue()), id) ?? id;
  const failed = (what: string, id: string, err: unknown) =>
    say(failedBanner({ id: `rented-${what}:${id}`, once: true, href: `/settings?machine=${encodeURIComponent(id)}`, go: "Open its card" }, `Could not ${what} ${nameOf(id)}`, err));
  const start = useMutation({ mutationFn: (machine: string) => api.startMachine(machine), onSuccess: settle, onError: (err, machine) => failed("start", machine, err) });
  const stop = useMutation({ mutationFn: (v: { machine: string; how: "stop" | "terminate" }) => api.stopMachine(v.machine, v.how), onSuccess: settle, onError: (err, v) => failed(v.how, v.machine, err) });
  const askStart = async (m: Pod) => {
    const r = m.rented;
    if (!r) return;
    const own = client.getQueryData<Settings>(queryKeys.settings())?.machines.find((x) => x.id === m.id)?.rented;
    if (!(await ask({ title: `Start ${machineLabel(m)}?`, text: `${rateSaid(r)}${own ? ` · ${idleEndSaid(own)}` : ""}.`, yes: "Start" }))) return;
    start.mutate(m.id);
  };
  const askStop = async (m: Pod) => {
    const r = m.rented;
    if (!r) return;
    const text = `${m.running ? "The render on it is lost. " : ""}${r.diskPerDay > 0.005 ? `The GPU stops billing; the disk keeps billing ${usd(r.diskPerDay)}/day.` : "The GPU stops billing."}`;
    if (!(await ask({ title: `Stop ${machineLabel(m)}?`, text, yes: "Stop" }))) return;
    stop.mutate({ machine: m.id, how: "stop" });
  };
  return { start, stop, askStart, askStop };
}
