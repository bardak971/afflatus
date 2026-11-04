import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type RecipeInfo } from "./api";
import { useModelSettings, useSetup } from "./data";
import { wholeForm } from "./form";
import { notReady } from "./format";
import { useBanners } from "./store";
import { passFrom } from "./viewer/ask";
import { queryKeys } from "./queryKeys";
import { failedBanner } from "./sayFailed";

// Apart from actions.ts: the Studio's header uses that file as it opens, and this one alone needs the forms' defaults
// (form.ts), which the first load then carried for a menu's Variation.
/**
 * A job queued at once from an item, and said so in a banner: a variation (the same settings, a new
 * seed), or a tool run on a picture. The form is the recipe's defaults under what is given, trimmed to
 * what the recipe takes; a recipe that cannot run here is refused with the reason.
 */
export function useQueueVariation(into?: { draft?: string; folder?: string }) {
  const send = useSendJob(into);
  const client = useQueryClient();
  const say = useBanners((b) => b.push);
  return useMutation({
    mutationFn: async (job: QueuedJob) => {
      await send(job);
      return { label: job.count && job.count > 1 ? `${job.label} ×${job.count}` : job.label, version: Boolean(job.versionOf) };
    },
    onSuccess: ({ label, version }) => {
      void client.invalidateQueries({ queryKey: queryKeys.queue() });
      // a version lands under its picture, not in the library: said, since a Face refine from a grid tile showed nowhere else
      say({ id: `queued:${Date.now()}`, tone: "good", title: `${label} queued`, ...(version ? { text: VERSION_WORDS } : {}), href: "/queue", go: "Open the Queue" });
    },
    onError: (err, job) => say(failedBanner({ id: "queued", href: "/settings", go: "Open Settings" }, `${job.label} could not be queued`, err)),
  });
}

/** A job queued from an item: its recipe, what it is handed, its name in the banner. */
export interface QueuedJob {
  recipe: RecipeInfo;
  stored: Record<string, unknown>;
  label: string;
  /** A pass of this item: its banner offers Compare when done. */
  from?: string;
  /** How many copies, each on a new seed when its seed is random (a batch count); absent: one. */
  count?: number;
  /** What it makes comes back as versions of this picture (Inpaint, Face and Hand refine, Edit, Outpaint), not as new items. */
  versionOf?: string;
}

/** Where a version goes, as the banners say it. */
export const VERSION_WORDS = "It comes back as a version under the picture, not as a new item: K keeps it.";

/**
 * The one way a job queued from an item is sent, alone (useQueueVariation) or one per item of a selection (selectionPasses.ts):
 * the recipe's defaults under what is given, trimmed to what it takes; one that cannot run here is refused with the reason.
 */
export function useSendJob(into?: { draft?: string; folder?: string }) {
  const setup = useSetup();
  const modelSettings = useModelSettings();
  return async (job: QueuedJob) => {
    const status = setup.data?.recipes.find((x) => x.id === job.recipe.id);
    const why = setup.isSuccess ? notReady(status, setup.data.comfy.online) : null;
    if (why) throw new Error(why);
    const input = wholeForm(job.recipe, status, modelSettings.data?.items ?? [], job.stored);
    const has = new Set(job.recipe.inputs.map((i) => i.id));
    for (const id of Object.keys(input)) if (input[id] === undefined || !has.has(id)) delete input[id];
    const queued = await api.enqueue(job.recipe.id, input, job.count ?? 1, null, job.versionOf ? { ...into, versionOf: job.versionOf } : into);
    if (job.from) for (const id of queued.ids) passFrom.set(id, job.from);
  };
}
