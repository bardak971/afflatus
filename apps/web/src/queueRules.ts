import type { MachineState } from "./api";
import { busyOutside } from "./machines";

/**
 * Whether ComfyUI's models can be unloaded now, and the few words why not: one rule for the Queue's button, the
 * model's menu and the command bar (they had three). Not while ComfyUI is offline (there is nothing to ask), nor
 * while any job runs: a render would load its models again at once, and a load job's models are what it is for. Nor
 * while it runs work queued from outside Afflatus: those models are someone else's.
 * Pure, for the command bar's rows and their test.
 */
export function unloadBlock(q: { online: boolean; running: unknown; machines?: ReadonlyArray<{ outside?: MachineState["outside"] }> } | null | undefined): string | null {
  if (!q?.online) return "ComfyUI is offline";
  if (q.running) return "not while a job runs";
  // its models are in use by work queued from outside Afflatus (ComfyUI's own page): the server refuses it too
  if (q.machines?.some(busyOutside)) return "ComfyUI is busy outside Afflatus";
  return null;
}
