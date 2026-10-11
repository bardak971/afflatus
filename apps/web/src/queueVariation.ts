import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type RecipeInfo } from "./api";
import { useModelSettings, useSetup } from "./data";
import { formDefaults } from "./form";
import { notReady } from "./format";
import { useBanners } from "./store";
import { passFrom } from "./viewer/ask";
import { queryKeys } from "./queryKeys";

// Apart from actions.ts: the Studio's header uses that file as it opens, and this one alone needs the forms' defaults
// (form.ts), which the first load then carried for a menu's Variation.
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
    mutationFn: async (job: { recipe: RecipeInfo; stored: Record<string, unknown>; label: string; /** A pass of this item: its banner offers Compare when done. */ from?: string }) => {
      const status = setup.data?.recipes.find((x) => x.id === job.recipe.id);
      const why = setup.isSuccess ? notReady(status, setup.data.comfy.online) : null;
      if (why) throw new Error(why);
      const input: Record<string, unknown> = { ...formDefaults(job.recipe, status?.options, modelSettings.data?.items ?? [], job.stored).defaults, ...job.stored };
      const has = new Set(job.recipe.inputs.map((i) => i.id));
      for (const id of Object.keys(input)) if (input[id] === undefined || !has.has(id)) delete input[id];
      const queued = await api.enqueue(job.recipe.id, input, 1, null, into);
      if (job.from) for (const id of queued.ids) passFrom.set(id, job.from);
      return job.label;
    },
    onSuccess: (label) => {
      void client.invalidateQueries({ queryKey: queryKeys.queue() });
      say({ id: `queued:${Date.now()}`, tone: "good", title: `${label} queued`, href: "/queue", go: "Open queue" });
    },
    onError: (err, job) => say({ id: `queued:${Date.now()}`, tone: "bad", title: `${job.label} could not be queued`, text: err.message, href: "/settings", go: "Open settings" }),
  });
}
