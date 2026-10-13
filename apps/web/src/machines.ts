import type { MachineState, QueueStatus, RentedState } from "./api";
import { long, usd } from "./format";

/** Several ComfyUIs (Settings › ComfyUI): how a machine is named on screen, and what the screens read of them. */

/** A machine as the screens name it: its own name, else its address's host and port ("127.0.0.1:8189"). */
export function machineLabel(m: { name: string; url: string }): string {
  if (m.name.trim()) return m.name.trim();
  try {
    return new URL(m.url).host;
  } catch {
    return m.url;
  }
}

/** The machines of the queue, when there are several; empty with one (the screens then stay as they were). */
export const severalMachines = (q: QueueStatus | undefined): MachineState[] => (q?.machines && q.machines.length > 1 ? q.machines : []);

/** A machine of the queue by id, as the screens name it; the id itself when the queue does not have it (one removed since). */
export function machineName(q: QueueStatus | undefined, id: string | null | undefined): string | null {
  if (!id) return null;
  const m = q?.machines?.find((x) => x.id === id);
  return m ? machineLabel(m) : id;
}

/** A machine named as typed (the command bar's "pause studio pc"): its id or its name, case not minding, else the one whose name starts so. */
export function machineByName<M extends { id: string; name: string; url: string }>(machines: readonly M[] | undefined, typed: string): M | undefined {
  const want = typed.trim().toLowerCase();
  const all = machines ?? [];
  return all.find((m) => m.id === want || machineLabel(m).toLowerCase() === want) ?? all.find((m) => machineLabel(m).toLowerCase().startsWith(want));
}

/**
 * Whether a machine's models can be unloaded now, and the few words why not: the rule unloadBlock (queueRules.ts) has
 * for one ComfyUI, for one of several: not while it is away, nor while it runs a job.
 */
export function machineUnloadBlock(m: { online: boolean | null; running: unknown }): string | null {
  if (m.online === false) return "it is offline";
  if (m.running) return "not while it renders";
  return null;
}

/**
 * Whether a family is on for one machine: switched there by hand, else by the switch of every machine, else by its files
 * there. The server's rule (machineScans.ts familyOn): what the queue sends a machine is what this says.
 */
export function familyOnFor(own: Readonly<Record<string, boolean>>, said: Readonly<Record<string, boolean>>, family: string, found: boolean): boolean {
  return own[family] ?? said[family] ?? found;
}

/**
 * A rented pod's state in a few words, for its row, the pill and the menus: "starting", "stopped · disk $0.33/day",
 * "running · $0.83". What it costs is Afflatus's figure (its time × its rate), said as it is: RunPod's bill is the reference.
 */
export function rentedSaid(r: RentedState): string {
  switch (r.status) {
    case "RUNNING": return r.since ? `running ${long(Date.now() - r.since)} · ${usd(r.spent)}` : "running";
    case "STARTING": case "PROVISIONING": return "starting";
    case "EXITED": return r.diskPerDay > 0.005 ? `stopped · disk ${usd(r.diskPerDay)}/day` : "stopped";
    case "GONE": case "TERMINATED": return "deleted on RunPod";
    case "ERROR": return "in error on RunPod";
    default: return r.error ? "RunPod not answering" : "…";
  }
}

/** Whether a rented pod takes work now: only while it runs. A machine of one's own always may. */
export const rentedUp = (m: { rented?: RentedState | null }) => !m.rented || m.rented.status === "RUNNING";
