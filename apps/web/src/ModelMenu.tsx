import { ListOrdered, MemoryStick, Play } from "lucide-react";
import { useLocation } from "wouter";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { useQueue } from "./data";
import { openLoadPanel } from "./LoadPanel";
import { machineLabel, machineUnloadBlock, severalMachines } from "./machines";
import { useQueueOps } from "./queueOps";
import { unloadBlock } from "./queueRules";

/**
 * The model's menu (ModelLoad.tsx ModelMenu), on a click of its name or a right-click anywhere on it: free the VRAM now,
 * load a model ahead (a load job: one step, nothing saved; the render with it then starts at once) from a panel of its
 * own (LoadPanel.tsx: the form's model first, the recent drafts', any model by name), the Queue. With several ComfyUIs,
 * unload one machine or every idle one.
 */
export function ModelMenuBody({ at, onClose }: { at: Parameters<typeof ContextMenu>[0]["at"]; onClose(): void }) {
  const queue = useQueue();
  const several = severalMachines(queue.data);
  const [, go] = useLocation();
  const ops = useQueueOps();
  const why = unloadBlock(queue.data);
  const unloadItem: MenuItem = several.length
    ? {
        label: "Unload models", icon: <MemoryStick size={14} />, note: "free VRAM",
        items: [
          { label: "Every idle machine", disabled: !several.some((m) => !machineUnloadBlock(m)), run: () => ops.unload.mutate(undefined) },
          "—",
          ...several.map((m): MenuItem => ({ label: machineLabel(m), note: machineUnloadBlock(m) ?? undefined, disabled: Boolean(machineUnloadBlock(m)), run: () => ops.unload.mutate(m.id) })),
        ],
      }
    : { label: "Unload models", icon: <MemoryStick size={14} />, disabled: Boolean(why), note: why ?? "free VRAM", run: () => ops.unload.mutate() };
  const items: MenuItem[] = [
    { label: "Load a model…", icon: <Play size={14} />, note: "this form's, a draft's, any", run: () => openLoadPanel() },
    unloadItem,
    "—",
    { label: "Open the Queue", icon: <ListOrdered size={14} />, run: () => go("/queue") },
  ];
  // with several, what each one holds is on their pill: the head says how many there are
  const head = several.length ? { title: `${several.length} ComfyUIs`, sub: "what each one holds: their pill" } : { title: queue.data?.model ?? "No model loaded", sub: "what ComfyUI holds" };
  return <ContextMenu at={at} label="Model" head={head} items={items} onClose={onClose} />;
}
