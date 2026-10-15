import { ExternalLink, ListOrdered, MemoryStick, Pause, Play, Power, PowerOff, Settings as Gear, Target, Trash2 } from "lucide-react";
import { useOpenComfyUI } from "./actions";
import { useLocation } from "wouter";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import type { MachineState } from "./api";
import { useQueue } from "./data";
import { openLoadPanel } from "./loadPanelHost";
import { usd } from "./format";
import { machineLabel, machineUnloadBlock, rateSaid, rentedSaid } from "./machines";
import { RUNPOD_CONSOLE, useRentedOps } from "./rentedOps";
import { useQueueOps } from "./queueOps";

/** A machine's state in a few words: what the status bar's summary and a menu's head say of it. */
export function machineSaid(m: MachineState): string {
  if (m.rented && m.rented.status !== "RUNNING") return rentedSaid(m.rented);
  const state = m.paused ? "paused" : m.online === false ? (m.locked ? "locked" : "offline") : m.running ? `rendering ${Math.round(m.running.progress * 100)} %` : "idle";
  return m.model ? `${state} · holds ${m.model}` : state;
}

/**
 * One machine's menu, when there are several ComfyUIs (its chip in the status bar, its card in Settings, its lane in the
 * Queue): Use only it, Pause or Resume it, Unload it, load a model on it (LoadPanel.tsx), open its ComfyUI, the Queue and its settings.
 * Without `machine`, every machine with its own items as a submenu (the status bar's summary chip on a narrow window).
 * Each item mirrors a button that exists elsewhere (the Queue's lanes, Settings' cards).
 */
export function MachineMenuBody({ at, machine, extra = [], onClose }: { at: Parameters<typeof ContextMenu>[0]["at"]; machine?: string; /** With `machine`: items of the place it opens from, after the machine's own (its card's: the token, the order, Remove). */ extra?: MenuItem[]; onClose(): void }) {
  const queue = useQueue();
  const [, go] = useLocation();
  const ops = useQueueOps();
  const openComfy = useOpenComfyUI();
  const rented = useRentedOps();
  const all = queue.data?.machines ?? [];
  /** One machine's own items. */
  const itemsOf = (m: MachineState): MenuItem[] => {
    const name = machineLabel(m);
    // a rented pod that is not running: Start (the user's, its rate said), Terminate (asked in its card), its page on RunPod; nothing else applies
    const r = m.rented;
    const onRunpod: MenuItem = { label: "Open on RunPod", icon: <ExternalLink size={14} />, run: () => void window.open(RUNPOD_CONSOLE, "_blank", "noopener") };
    if (r && r.status !== "RUNNING") {
      const stopped = r.status === "EXITED" || r.status === "ERROR";
      return [
        ...(stopped ? [{ label: `Start ${name}`, icon: <Power size={14} />, note: r.capped ? "a spending cap is reached" : rateSaid(r), disabled: r.capped, run: () => rented.start.mutate(m.id) }] : []),
        ...(r.status === "STARTING" || r.status === "PROVISIONING" ? [{ label: `Stop ${name}`, icon: <PowerOff size={14} />, note: "before it is up", run: () => rented.stop.mutate({ machine: m.id, how: "stop" }) }] : []),
        ...(r.status !== "GONE" && r.status !== "TERMINATED" ? [{ label: "Terminate…", icon: <Trash2 size={14} />, note: "asked in its card", run: () => go(`/settings?machine=${encodeURIComponent(m.id)}`) }] : []),
        onRunpod,
      ];
    }
    const stopRented: MenuItem[] = r ? [
      { label: `Stop ${name}`, icon: <PowerOff size={14} />, note: r.diskPerDay > 0.005 ? `the disk keeps billing ${usd(r.diskPerDay)}/day` : "the GPU stops billing", run: () => rented.stop.mutate({ machine: m.id, how: "stop" }) },
      { label: "Terminate…", icon: <Trash2 size={14} />, note: "asked in its card", run: () => go(`/settings?machine=${encodeURIComponent(m.id)}`) },
      onRunpod,
    ] : [];
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
      // its own page; locked, the tab lands logged in (lock-api.ts pageUrl)
      { label: "Open ComfyUI", icon: <ExternalLink size={14} />, disabled: m.online === false && !m.locked, note: m.online === false && !m.locked ? "it does not answer" : undefined, run: () => openComfy.mutate(m.id) },
      ...(stopRented.length ? ["—" as const, ...stopRented] : []),
    ];
  };
  const shared: MenuItem[] = [
    queue.data?.paused
      ? { label: "Resume all", icon: <Play size={14} />, run: () => ops.resume.mutate(undefined) }
      : { label: "Pause all", icon: <Pause size={14} />, note: "every machine", run: () => ops.pause.mutate(undefined) },
    "—",
    { label: "Open the Queue", icon: <ListOrdered size={14} />, run: () => go("/queue") },
    // from its card (`extra`), Settings is where the menu is already
    ...(extra.length ? [] : [{ label: "ComfyUI settings", icon: <Gear size={14} />, run: () => go("/settings") }]),
  ];
  const one = machine ? all.find((x) => x.id === machine) : undefined;
  if (machine && !one) return null;
  if (one) return <ContextMenu at={at} label={machineLabel(one)} head={{ title: machineLabel(one), sub: machineSaid(one) }} items={[...itemsOf(one), ...(extra.length ? ["—" as const, ...extra] : []), "—", ...shared]} onClose={onClose} />;
  return (
    <ContextMenu
      at={at} label="ComfyUIs" head={{ title: `${all.length} ComfyUIs`, sub: `${all.filter((m) => m.running).length} rendering` }} onClose={onClose}
      items={[...all.map((m): MenuItem => ({ label: machineLabel(m), note: machineSaid(m), items: itemsOf(m) })), "—", ...shared]}
    />
  );
}
