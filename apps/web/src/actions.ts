import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Asset, type Opened, type RecipeInfo } from "./api";
import { useModelSettings, useSetup, useTimelines } from "./data";
import { formDefaults } from "./form";
import { notReady } from "./format";
import { useBanners } from "./store";

/** What the viewer, a tile's menu and the workflows list do alike with an item: the one body each, the words their own. */

/**
 * Something opened in ComfyUI's editor: a result's graph built again, a workflow written into its
 * folder. The tab is opened before the request, or the browser would block it as a pop-up; it is
 * closed again when the request fails.
 */
export function useOpenInComfy<T>(request: (v: T) => Promise<Opened>, opts: { onSuccess?(r: Opened, v: T): void; onError?(err: Error, v: T): void } = {}) {
  return useMutation({
    mutationFn: async (v: T) => {
      const tab = window.open("", "_blank");
      try {
        const r = await request(v);
        if (tab) tab.location.href = r.url;
        return r;
      } catch (err) {
        tab?.close();
        throw err;
      }
    },
    onSuccess: opts.onSuccess,
    onError: opts.onError,
  });
}

/** An item put at the end of a timeline: one of the project's (by id), or a new one (null). Gives the timeline it went to. */
export function useAddToTimeline(asset: Asset, opts: { onSuccess?(target: { id: string; name: string }): void } = {}) {
  const timelines = useTimelines();
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (timeline: string | null) => {
      const target = timeline
        ? { id: timeline, name: timelines.data?.items.find((t) => t.id === timeline)?.name ?? "the timeline" }
        : await api.createTimeline().then((t) => ({ id: t.id, name: t.name }));
      await api.addClip(target.id, { asset: asset.id });
      return target;
    },
    onSuccess: (target) => {
      void client.invalidateQueries({ queryKey: ["timelines"] });
      opts.onSuccess?.(target);
    },
  });
}

/**
 * A job queued at once from an item, and said so in a banner: a variation (the same settings, a new
 * seed), or a tool run on a picture. The form is the recipe's defaults under what is given, trimmed to
 * what the recipe takes; a recipe that cannot run here is refused with the reason.
 */
export function useQueueVariation(into?: { draft?: string; folder?: string }) {
  const setup = useSetup();
  const modelSettings = useModelSettings();
  const client = useQueryClient();
  const say = useBanners((b) => b.push);
  return useMutation({
    mutationFn: async (job: { recipe: RecipeInfo; stored: Record<string, unknown>; label: string }) => {
      const status = setup.data?.recipes.find((x) => x.id === job.recipe.id);
      const why = setup.isSuccess ? notReady(status, setup.data.comfy.online) : null;
      if (why) throw new Error(why);
      const input: Record<string, unknown> = { ...formDefaults(job.recipe, status?.options, modelSettings.data?.items ?? [], job.stored).defaults, ...job.stored };
      const has = new Set(job.recipe.inputs.map((i) => i.id));
      for (const id of Object.keys(input)) if (input[id] === undefined || !has.has(id)) delete input[id];
      await api.enqueue(job.recipe.id, input, 1, null, into);
      return job.label;
    },
    onSuccess: (label) => {
      void client.invalidateQueries({ queryKey: ["queue"] });
      say({ id: `queued:${Date.now()}`, tone: "good", title: `${label} queued`, href: "/queue", go: "Open queue" });
    },
    onError: (err, job) => say({ id: `queued:${Date.now()}`, tone: "bad", title: `${job.label} could not be queued`, text: err.message, href: "/settings", go: "Open settings" }),
  });
}
