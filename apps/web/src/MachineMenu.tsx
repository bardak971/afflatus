import { ExternalLink, ListOrdered, MemoryStick, Pause, Play, Power, PowerOff, Settings as Gear, Target, Trash2 } from "lucide-react";
import { useOpenComfyUI } from "./actions";
import { useLocation } from "wouter";
import { ContextMenu, groups, headLine, type MenuItem } from "./ContextMenu";
import type { MachineState } from "./api";
import { useQueue } from "./data";
import { openLoadPanel } from "./loadPanelHost";
import { usd } from "./format";
import { machineLabel, machineState, machineUnloadBlock, outsideSaid, rateSaid, rentedSaid } from "./machines";
import { RUNPOD_CONSOLE, useRentedOps } from "./rentedOps";
import { useQueueOps } from "./queueOps";

/** A machine's state in a few words: what the status bar's summary and a menu's head say of it. */
export function machineSaid(m: MachineState): string {
  if (m.rented && m.rented.status !== "RUNNING") return rentedSaid(m.rented);
  const word = machineState(m);
  // busy outside Afflatus: that work, rather than a model it may no longer hold
  if (word === "busy outside Afflatus") return `${word} · ${outsideSaid(m)}`;
  const state = word === "rendering" && m.running ? `rendering ${Math.round(m.running.progress * 100)} %` : word;
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
  /**
   * One machine's own items: what it does first, then its pod's (Stop…, its page on RunPod), then the place's own
   * (`extra`, its card's), what goes to the Queue and Settings, and what removes it last, alone (Terminate…, the card's
   * Remove…). A row that would change nothing is not drawn: Use only on the one already used alone.
   */
  const itemsOf = (m: MachineState, place: MenuItem[] = [], tail: MenuItem[] = []): MenuItem[] => {
    const name = machineLabel(m);
    // a rented pod that is not running: Start (the user's, its rate asked about first, as its card's Start…), Terminate (asked
    // in its card), its page on RunPod; nothing else applies
    const r = m.rented;
    const onRunpod: MenuItem = { label: "Open on RunPod", icon: <ExternalLink size={14} />, run: () => void window.open(RUNPOD_CONSOLE, "_blank", "noopener") };
    const terminate: MenuItem[] = r && r.status !== "GONE" && r.status !== "TERMINATED" ? [{ label: "Terminate…", icon: <Trash2 size={14} />, danger: true, note: "asked in its card", run: () => go(`/settings?machine=${encodeURIComponent(m.id)}`) }] : [];
    const removing = [...terminate, ...place.filter((it) => it !== "—" && it.danger)];
    const own = place.filter((it) => it === "—" || !it.danger);
    if (r && r.status !== "RUNNING") {
      const stopped = r.status === "EXITED" || r.status === "ERROR";
      return groups(
        [
          ...(stopped ? [{ label: `Start ${name}…`, icon: <Power size={14} />, note: r.capped ? "a spending cap is reached" : rateSaid(r), disabled: r.capped, run: () => void rented.askStart(m) }] : []),
          ...(r.status === "STARTING" || r.status === "PROVISIONING" ? [{ label: `Stop ${name}…`, icon: <PowerOff size={14} />, note: "before it is up", run: () => void rented.askStop(m) }] : []),
          onRunpod,
        ],
        own,
        tail,
        removing,
      );
    }
    const why = machineUnloadBlock(m);
    const onlyAlready = !m.paused && all.every((x) => x.id === m.id || x.paused);
    return groups(
      [
        ...(onlyAlready ? [] : [{ label: `Use only ${name}`, icon: <Target size={14} />, note: "pauses the others", run: () => ops.useOnly.mutate(m.id) }]),
        m.paused
          ? { label: `Resume ${name}`, icon: <Play size={14} />, run: () => ops.resume.mutate(m.id) }
          : { label: `Pause ${name}`, icon: <Pause size={14} />, note: "finishes what it runs", run: () => ops.pause.mutate(m.id) },
        { label: `Unload ${name}`, icon: <MemoryStick size={14} />, disabled: Boolean(why), note: why ?? "free its VRAM", run: () => ops.unload.mutate(m.id) },
        // a panel by the status bar (LoadPanel.tsx), that machine picked: a submenu of a submenu cut every name
        { label: `Load a model on ${name}…`, icon: <Play size={14} />, disabled: m.online === false, note: m.online === false ? "it does not answer" : undefined, run: () => openLoadPanel(m.id) },
        // its own page; locked, the tab lands logged in (lock-api.ts pageUrl)
        { label: "Open ComfyUI", icon: <ExternalLink size={14} />, disabled: m.online === false && !m.locked, note: m.online === false && !m.locked ? "it does not answer" : undefined, run: () => openComfy.mutate(m.id) },
      ],
      // Stop asks first, as its card's Stop… does: a render on it is lost, its minutes paid for nothing
      r && [
        { label: `Stop ${name}…`, icon: <PowerOff size={14} />, note: m.running ? "its render is lost" : r.diskPerDay > 0.005 ? `the disk keeps billing ${usd(r.diskPerDay)}/day` : "the GPU stops billing", run: () => void rented.askStop(m) },
        onRunpod,
      ],
      own,
      tail,
      removing,
    );
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
  if (one) return <ContextMenu at={at} label={machineLabel(one)} head={{ title: machineLabel(one), sub: headLine(one.rented ? "Pod" : "Machine", machineSaid(one)) }} items={itemsOf(one, extra, shared)} onClose={onClose} />;
  return (
    <ContextMenu
      at={at} label="Machines" head={{ title: `${all.length} machines`, sub: `${all.filter((m) => m.running).length} rendering` }} onClose={onClose}
      items={[...all.map((m): MenuItem => ({ label: machineLabel(m), note: machineSaid(m), items: itemsOf(m) })), "—", ...shared]}
    />
  );
}
