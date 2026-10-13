import { useQueries, useQueryClient } from "@tanstack/react-query";
import { ListOrdered, MemoryStick, Play } from "lucide-react";
import { useLocation } from "wouter";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { api, type RecipeInfo } from "./api";
import { useDrafts, useQueue, useRecipes } from "./data";
import { machineLabel, machineUnloadBlock, severalMachines } from "./machines";
import { useQueueOps } from "./queueOps";
import { unloadBlock } from "./queueRules";
import { failedBanner } from "./sayFailed";
import { useBanners } from "./store";
import { queryKeys } from "./queryKeys";

type Look = Parameters<typeof api.warm>[2];

/**
 * The model's menu (ModelLoad.tsx ModelMenu), on a click of its name or a right-click anywhere on it: free the VRAM now, load the model of a
 * recent draft ahead (a load job: one step, nothing saved; the render with it then starts at once), the Queue. The
 * strip was the one place that says what is loaded, and the only way to change it was through the Queue or a form.
 */
export function ModelMenuBody({ at, onClose, form }: { at: Parameters<typeof ContextMenu>[0]["at"]; onClose(): void; form?: { recipe: RecipeInfo; input: Record<string, unknown>; look: Look } }) {
  const queue = useQueue();
  const several = severalMachines(queue.data);
  const setups = useQueries({ queries: several.map((m) => ({ queryKey: queryKeys.setup(m.id), queryFn: ({ signal }: { signal: AbortSignal }) => api.setup({ signal }, m.id), staleTime: 60_000 })) });
  const drafts = useDrafts(true);
  const recipes = useRecipes();
  const client = useQueryClient();
  const say = useBanners((b) => b.push);
  const [, go] = useLocation();
  const ops = useQueueOps();
  const why = unloadBlock(queue.data);
  // the last drafts' models, once each: a draft is what holds a model choice whole (its form, its cast)
  const recent = (drafts.data?.items ?? []).filter((d, i, all) => all.findIndex((x) => x.recipe === d.recipe) === i).slice(0, 6);
  const titleOf = (id: string) => {
    const r = recipes.data?.recipes.find((x) => x.id === id);
    const family = recipes.data?.families.find((f) => f.id === r?.family)?.name;
    return r ? (family && !r.title.startsWith(family) ? `${family} · ${r.title}` : r.title) : id;
  };
  const loadFrom = async (draftId: string, label: string) => {
    try {
      const d = await api.draft(draftId);
      await api.warm(d.recipe, d.forms[d.recipe] ?? {}, d.look);
      say({ id: `load:${Date.now()}`, tone: "good", title: `Loading ${label}`, text: "Queued: the next render with it starts at once.", href: "/queue", go: "Open queue" });
    } catch (err) {
      say(failedBanner({ id: "load", href: "/queue", go: "Open queue" }, `Could not load ${label}`, err));
    } finally {
      void client.invalidateQueries({ queryKey: queryKeys.queue() });
    }
  };
  /** The form's model loaded on one machine (a load job pinned there). */
  const loadOn = async (machine: string, name: string) => {
    if (!form) return;
    const has = new Set(form.recipe.inputs.map((i) => i.id));
    const whole = Object.fromEntries(Object.entries(form.input).filter(([k, v]) => has.has(k) && v !== undefined));
    try {
      await api.warm(form.recipe.id, whole, form.look, machine);
      say({ id: `load:${Date.now()}`, tone: "good", title: `Loading on ${name}`, text: "Queued: the next render with it there starts at once.", href: "/queue", go: "Open queue" });
    } catch (err) {
      say(failedBanner({ id: "load", href: "/queue", go: "Open queue" }, `Could not load it on ${name}`, err));
    } finally {
      void client.invalidateQueries({ queryKey: queryKeys.queue() });
    }
  };
  /** With several ComfyUIs: each machine for the form's model, one without its files (the recipe's, or the model the form picks) not to be picked. */
  const machinesFor = (): MenuItem[] => several.map((m, i) => {
    const status = form ? setups[i]?.data?.recipes.find((r) => r.id === form.recipe.id) : undefined;
    const picked = (x: RecipeInfo["inputs"][number]) => (x.type === "model" && typeof form?.input[x.id] === "string" ? (form.input[x.id] as string) : "");
    const lacks = status && (!status.ready || form!.recipe.inputs.some((x) => picked(x) && status.options[x.id] && !status.options[x.id]!.includes(picked(x))));
    return {
      label: machineLabel(m),
      note: m.online === false ? "offline" : lacks ? "lacks its files" : m.paused ? "paused: when it resumes" : m.running ? "after its render" : undefined,
      disabled: m.online === false || Boolean(lacks),
      run: () => void loadOn(m.id, machineLabel(m)),
    };
  });
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
    ...(form && several.length ? [{ label: "Load this form's model on", icon: <Play size={14} />, items: machinesFor() } satisfies MenuItem] : []),
    unloadItem,
    {
      label: "Load", icon: <Play size={14} />, note: "a recent draft's model",
      disabled: !recent.length && drafts.isSuccess,
      items: recent.length
        ? recent.map((d): MenuItem => ({ label: titleOf(d.recipe), note: d.name || d.title || undefined, run: () => void loadFrom(d.id, titleOf(d.recipe)) }))
        : [{ label: drafts.isSuccess ? "No draft yet" : "Reading…", disabled: true }],
    },
    "—",
    { label: "Open the Queue", icon: <ListOrdered size={14} />, run: () => go("/queue") },
  ];
  // with several, what each one holds is on its chip: the head says how many there are
  const head = several.length ? { title: `${several.length} ComfyUIs`, sub: "what each one holds: its chip" } : { title: queue.data?.model ?? "No model loaded", sub: "what ComfyUI holds" };
  return <ContextMenu at={at} label="Model" head={head} items={items} onClose={onClose} />;
}
