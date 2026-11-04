import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Asset, type AssetDetail, type RecipeInfo } from "./api";
import { useFamilies, useRecipes, useSetup } from "./data";
import { plural } from "./format";
import { ACTIONS, PASS_KEYS, SELECTION_PASSES, type ActionId, type SelectionPass } from "./itemActions";
import { useSendJob, type QueuedJob } from "./queueVariation";
import { queryKeys } from "./queryKeys";
import { failedBanner } from "./sayFailed";
import { useBanners } from "./store";
import { carried, handsInput, NO_HAND_DETECTOR, OPS, renderOf, toolOf } from "./viewer/shared";

/** Where a pass is picked from: the recipes on, the families, which are ready and what ComfyUI offers for each. */
export interface PassPlace {
  all: RecipeInfo[];
  families: Array<{ id: string; name: string; summary: string }>;
  ready(r: RecipeInfo): boolean;
  options(r: RecipeInfo): Record<string, string[]> | undefined;
  online: boolean;
}

/**
 * The job a quick pass is queued as for one picture, as its own button queues it (useItemActions): the recipe of the
 * model it was made with when that model has the pass, what the picture was made with carried, the picture as the
 * source; Hand refine on the hand detector. Throws the reason when it cannot be queued.
 */
export function passJob(pass: SelectionPass, d: AssetDetail, place: PassPlace): QueuedJob {
  const key = PASS_KEYS[pass]!;
  const made = renderOf(d);
  const madeWith = place.all.find((r) => r.id === made?.recipe);
  const tool = toolOf(key, place.all, place.families, madeWith?.id, place.ready);
  if (!tool) throw new Error("No model is installed for it.");
  const slot = tool.inputs.find((i) => i.type === "image" && i.role === "source")!;
  const stored: Record<string, unknown> = { ...carried(made, madeWith, tool, false), [slot.id]: d.id };
  if (pass === "hand") {
    const way = handsInput(tool, place.options(tool), place.online);
    if (!way) throw new Error("No model is installed for it.");
    if (way.missing) throw new Error(NO_HAND_DETECTOR);
    Object.assign(stored, way.values);
  }
  return { recipe: tool, stored, label: OPS[key]!.label, from: d.id };
}

/**
 * A quick pass (Upscale, Face, Hand, Remove background) queued on every picture of a library selection: one job each, sent
 * the one way an item's own pass is (useSendJob), each with its own parameters read; one banner for all of them, with how
 * many could not be queued and why.
 */
export function useSelectionPasses() {
  const recipes = useRecipes();
  const setup = useSetup();
  const { offers } = useFamilies();
  const client = useQueryClient();
  const send = useSendJob();
  const say = useBanners((b) => b.push);
  const place: PassPlace = {
    all: (recipes.data?.recipes ?? []).filter(offers),
    families: recipes.data?.families ?? [],
    ready: (r) => Boolean(setup.data?.recipes.find((x) => x.id === r.id)?.ready),
    options: (r) => setup.data?.recipes.find((x) => x.id === r.id)?.options,
    online: Boolean(setup.data?.comfy.online),
  };
  /** The recipe each pass would use at all (a picture's own model may have its own), by its title: what is off has none. */
  const passes = Object.fromEntries(SELECTION_PASSES.flatMap((id) => {
    const tool = toolOf(PASS_KEYS[id]!, place.all, place.families, undefined, place.ready);
    return tool ? [[id, tool.title]] : [];
  })) as Partial<Record<ActionId, string>>;
  const run = useMutation({
    mutationFn: async ({ pass, items }: { pass: SelectionPass; items: Asset[] }) => {
      const pictures = items.filter((a) => a.kind === "image" && !a.inBin);
      let queued = 0;
      const failed: unknown[] = [];
      // one after the other: each picture's parameters are read, then its job sent, as its own button would
      for (const a of pictures) {
        try {
          const d = await client.fetchQuery({ queryKey: queryKeys.assets.one(a.id), queryFn: ({ signal }) => api.asset(a.id, { signal }) });
          await send(passJob(pass, d, place));
          queued++;
        } catch (err) {
          failed.push(err);
        }
      }
      return { pass, queued, failed };
    },
    onSuccess: ({ pass, queued, failed }) => {
      const label = ACTIONS[pass].label;
      if (queued) {
        void client.invalidateQueries({ queryKey: queryKeys.queue() });
        say({ id: `queued:${Date.now()}`, tone: "good", title: `${label} queued on ${plural(queued, "picture")}`, href: "/queue", go: "Open the Queue" });
      }
      if (failed.length) say(failedBanner({ id: `queued-many:${pass}`, href: "/settings", go: "Open Settings" }, `${label} could not be queued on ${plural(failed.length, "picture")}`, failed[0]));
    },
  });
  return { passes, run };
}
