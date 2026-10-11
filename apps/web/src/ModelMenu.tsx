import { useQueryClient } from "@tanstack/react-query";
import { ListOrdered, MemoryStick, Play } from "lucide-react";
import { useLocation } from "wouter";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { api } from "./api";
import { useDrafts, useQueue, useRecipes } from "./data";
import { useQueueOps } from "./queueOps";
import { unloadBlock } from "./queueRules";
import { failedBanner } from "./sayFailed";
import { useBanners } from "./store";
import { queryKeys } from "./queryKeys";

/**
 * The model's menu (ModelLoad.tsx ModelMenu), on a click of its name or a right-click anywhere on it: free the VRAM now, load the model of a
 * recent draft ahead (a load job: one step, nothing saved; the render with it then starts at once), the Queue. The
 * strip was the one place that says what is loaded, and the only way to change it was through the Queue or a form.
 */
export function ModelMenuBody({ at, onClose }: { at: Parameters<typeof ContextMenu>[0]["at"]; onClose(): void }) {
  const queue = useQueue();
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
  const items: MenuItem[] = [
    {
      label: "Unload models", icon: <MemoryStick size={14} />, disabled: Boolean(why), note: why ?? "free VRAM",
      run: () => ops.unload.mutate(),
    },
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
  return <ContextMenu at={at} label="Model" head={{ title: queue.data?.model ?? "No model loaded", sub: "what ComfyUI holds" }} items={items} onClose={onClose} />;
}
