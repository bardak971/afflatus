import { ListOrdered, MemoryStick, Play } from "lucide-react";
import { useLocation } from "wouter";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { useQueue } from "./data";
import { useLoadChoices, type LoadChoice, type LoadForm } from "./loadChoices";
import { machineLabel, machineUnloadBlock, severalMachines } from "./machines";
import { useQueueOps } from "./queueOps";
import { unloadBlock } from "./queueRules";

/**
 * The model's menu (ModelLoad.tsx ModelMenu), on a click of its name or a right-click anywhere on it: free the VRAM now,
 * load a model ahead (a load job: one step, nothing saved; the render with it then starts at once), the Queue. What can
 * be loaded is the form's model first, then the recent drafts' models (loadChoices.ts). With several ComfyUIs: the form's
 * model on a machine of your choosing, and unload one machine or every idle one.
 */
export function ModelMenuBody({ at, onClose, form }: { at: Parameters<typeof ContextMenu>[0]["at"]; onClose(): void; form?: LoadForm }) {
  const queue = useQueue();
  const several = severalMachines(queue.data);
  const [, go] = useLocation();
  const ops = useQueueOps();
  const why = unloadBlock(queue.data);
  const { choices, load, lacksOn, reading } = useLoadChoices(form);
  const own = choices.find((c) => c.ofForm);
  const recent = choices.filter((c) => !c.ofForm);
  const item = (c: LoadChoice): MenuItem => ({ label: c.label, note: c.note, run: () => void load(c) });
  const none: MenuItem = { label: reading ? "Reading…" : "No draft yet", disabled: true };

  /** With several ComfyUIs: each machine for the form's model; one without its files cannot be picked. */
  const machinesFor = (c: LoadChoice): MenuItem[] => several.map((m) => {
    const lacks = lacksOn(m.id);
    return {
      label: machineLabel(m),
      note: m.online === false ? "offline" : lacks ? "lacks its files" : m.paused ? "paused: when it resumes" : m.running ? "after its render" : undefined,
      disabled: m.online === false || lacks,
      run: () => void load(c, m.id),
    };
  });
  const loads: MenuItem[] = several.length
    ? [
        ...(own ? [{ label: "Load this form's model on", icon: <Play size={14} />, note: own.label, items: machinesFor(own) } satisfies MenuItem] : []),
        { label: own ? "Load another model" : "Load", icon: <Play size={14} />, note: "a recent draft's, where it renders first", disabled: !recent.length && !reading, items: recent.length ? recent.map(item) : [none] },
      ]
    : [{
        label: "Load", icon: <Play size={14} />, note: own ? "this form's model first" : "a recent draft's model", disabled: !choices.length && !reading,
        items: choices.length ? [...(own ? [item(own), ...(recent.length ? ["—" as const] : [])] : []), ...recent.map(item)] : [none],
      }];
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
  const items: MenuItem[] = [...loads, unloadItem, "—", { label: "Open the Queue", icon: <ListOrdered size={14} />, run: () => go("/queue") }];
  // with several, what each one holds is on its chip: the head says how many there are
  const head = several.length ? { title: `${several.length} ComfyUIs`, sub: "what each one holds: its chip" } : { title: queue.data?.model ?? "No model loaded", sub: "what ComfyUI holds" };
  return <ContextMenu at={at} label="Model" head={head} items={items} onClose={onClose} />;
}
