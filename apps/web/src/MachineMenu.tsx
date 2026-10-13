import { ListOrdered, MemoryStick, Pause, Play, Settings as Gear, Target } from "lucide-react";
import { useLocation } from "wouter";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import type { MachineState } from "./api";
import { useQueue } from "./data";
import { openLoadPanel } from "./LoadPanel";
import { machineLabel, machineUnloadBlock } from "./machines";
import { useQueueOps } from "./queueOps";

/** A machine's state in a few words: what the status bar's summary and a menu's head say of it. */
export function machineSaid(m: MachineState): string {
  const state = m.paused ? "paused" : m.online === false ? "offline" : m.running ? `rendering ${Math.round(m.running.progress * 100)} %` : "idle";
  return m.model ? `${state} · holds ${m.model}` : state;
}

/**
 * One machine's menu, when there are several ComfyUIs (its chip in the status bar, its card in Settings, its lane in the
 * Queue): Use only it, Pause or Resume it, Unload it, load a model on it (LoadPanel.tsx), the Queue and its settings.
 * Without `machine`, every machine with its own items as a submenu (the status bar's summary chip on a narrow window).
 * Each item mirrors a button that exists elsewhere (the Queue's lanes, Settings' cards).
 */
export function MachineMenuBody({ at, machine, onClose }: { at: Parameters<typeof ContextMenu>[0]["at"]; machine?: string; onClose(): void }) {
  const queue = useQueue();
  const [, go] = useLocation();
  const ops = useQueueOps();
  const all = queue.data?.machines ?? [];
  /** One machine's own items. */
  const itemsOf = (m: MachineState): MenuItem[] => {
    const name = machineLabel(m);
    const why = machineUnloadBlock(m);
    const onlyAlready = !m.paused && all.every((x) => x.id === m.id || x.paused);
    return [
      { label: `Use only ${name}`, icon: <Target size={14} />, note: onlyAlready ? "already" : "pauses the others", disabled: onlyAlready, run: () => ops.useOnly.mutate(m.id) },
      m.paused
        ? { label: `Resume ${name}`, icon: <Play size={14} />, run: () => ops.resume.mutate(m.id) }
        : { label: `Pause ${name}`, icon: <Pause size={14} />, note: "finishes what it runs", run: () => ops.pause.mutate(m.id) },
      { label: `Unload ${name}`, icon: <MemoryStick size={14} />, disabled: Boolean(why), note: why ?? "free its VRAM", run: () => ops.unload.mutate(m.id) },
      // a panel by the status bar (LoadPanel.tsx), that machine picked: a submenu of a submenu cut every name
      { label: `Load a model on ${name}…`, icon: <Play size={14} />, disabled: m.online === false, run: () => openLoadPanel(m.id) },
    ];
  };
  const shared: MenuItem[] = [
    queue.data?.paused
      ? { label: "Resume all", icon: <Play size={14} />, run: () => ops.resume.mutate(undefined) }
      : { label: "Pause all", icon: <Pause size={14} />, note: "every machine", run: () => ops.pause.mutate(undefined) },
    "—",
    { label: "Open the Queue", icon: <ListOrdered size={14} />, run: () => go("/queue") },
    { label: "ComfyUI settings", icon: <Gear size={14} />, run: () => go("/settings") },
  ];
  const one = machine ? all.find((x) => x.id === machine) : undefined;
  if (machine && !one) return null;
  if (one) return <ContextMenu at={at} label={machineLabel(one)} head={{ title: machineLabel(one), sub: machineSaid(one) }} items={[...itemsOf(one), "—", ...shared]} onClose={onClose} />;
  return (
    <ContextMenu
      at={at} label="ComfyUIs" head={{ title: `${all.length} ComfyUIs`, sub: `${all.filter((m) => m.running).length} rendering` }} onClose={onClose}
      items={[...all.map((m): MenuItem => ({ label: machineLabel(m), note: machineSaid(m), items: itemsOf(m) })), "—", ...shared]}
    />
  );
}
