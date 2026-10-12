import { useQueryClient } from "@tanstack/react-query";
import { ListOrdered, MemoryStick, Pause, Play, Settings as Gear, Target } from "lucide-react";
import { useLocation } from "wouter";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { api, type MachineState } from "./api";
import { useDrafts, useQueue, useRecipes } from "./data";
import { machineLabel, machineUnloadBlock } from "./machines";
import { useQueueOps } from "./queueOps";
import { failedBanner } from "./sayFailed";
import { useBanners } from "./store";
import { queryKeys } from "./queryKeys";

/** A machine's state in a few words: what the status bar's summary and a menu's head say of it. */
export function machineSaid(m: MachineState): string {
  const state = m.paused ? "paused" : m.online === false ? "offline" : m.running ? `rendering ${Math.round(m.running.progress * 100)} %` : "idle";
  return m.model ? `${state} · holds ${m.model}` : state;
}

/**
 * One machine's menu, when there are several ComfyUIs (its chip in the status bar, its card in Settings, its lane in the
 * Queue): Use only it, Pause or Resume it, Unload it, load a recent draft's model on it, the Queue and its settings.
 * Without `machine`, every machine with its own items as a submenu (the status bar's summary chip on a narrow window).
 * Each item mirrors a button that exists elsewhere (the Queue's lanes, Settings' cards).
 */
export function MachineMenuBody({ at, machine, onClose }: { at: Parameters<typeof ContextMenu>[0]["at"]; machine?: string; onClose(): void }) {
  const queue = useQueue();
  const drafts = useDrafts(true);
  const recipes = useRecipes();
  const client = useQueryClient();
  const say = useBanners((b) => b.push);
  const [, go] = useLocation();
  const ops = useQueueOps();
  const all = queue.data?.machines ?? [];
  // the last drafts' models, once each: a draft is what holds a model choice whole (its form, its cast)
  const recent = (drafts.data?.items ?? []).filter((d, i, list) => list.findIndex((x) => x.recipe === d.recipe) === i).slice(0, 6);
  const titleOf = (id: string) => {
    const r = recipes.data?.recipes.find((x) => x.id === id);
    const family = recipes.data?.families.find((f) => f.id === r?.family)?.name;
    return r ? (family && !r.title.startsWith(family) ? `${family} · ${r.title}` : r.title) : id;
  };
  const loadFrom = async (m: MachineState, draftId: string, label: string) => {
    try {
      const d = await api.draft(draftId);
      await api.warm(d.recipe, d.forms[d.recipe] ?? {}, d.look, m.id);
      say({ id: `load:${Date.now()}`, tone: "good", title: `Loading ${label} on ${machineLabel(m)}`, text: "Queued: the next render with it there starts at once.", href: "/queue", go: "Open queue" });
    } catch (err) {
      say(failedBanner({ id: "load", href: "/queue", go: "Open queue" }, `Could not load ${label}`, err));
    } finally {
      void client.invalidateQueries({ queryKey: queryKeys.queue() });
    }
  };
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
      {
        label: `Load on ${name}`, icon: <Play size={14} />, note: "a recent draft's model",
        disabled: !recent.length && drafts.isSuccess,
        items: recent.length
          ? recent.map((d): MenuItem => ({ label: titleOf(d.recipe), note: d.name || d.title || undefined, run: () => void loadFrom(m, d.id, titleOf(d.recipe)) }))
          : [{ label: drafts.isSuccess ? "No draft yet" : "Reading…", disabled: true }],
      },
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
