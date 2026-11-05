import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Asset, type AssetDetail, type RecipeInfo } from "./api";
import { useFamilies, useRecipes, useSetup } from "./data";
import { plural } from "./format";
import { ACTIONS, PASS_KEYS, SELECTION_PASSES, VERSION_PASSES, type ActionId, type SelectionPass, type TuneAt } from "./itemActions";
import { TUNED_ROWS, tunedJob, useTune } from "./passTune";
import { useSendJob, type QueuedJob } from "./queueVariation";
import { askBeforeMany } from "./podAsk";
import { queryKeys } from "./queryKeys";
import { failedBanner } from "./sayFailed";
import { useBanners } from "./store";
import { carried, handsInput, NO_HAND_DETECTOR, OPS, renderOf, toolOf } from "./viewer/shared";
import { VARY, varyJob, varyTool } from "./vary";

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
  const made = renderOf(d);
  const madeWith = place.all.find((r) => r.id === made?.recipe);
  // a Vary runs on the picture's own model alone (vary.ts): one made elsewhere, or on a model with no img2img, has none
  const how = VARY[pass];
  if (how) {
    if (!made || !madeWith) throw new Error("It was not generated here, or its model is not here.");
    const tool = varyTool(place.all, place.families, madeWith.id);
    if (!tool) throw new Error("Its model has no img2img.");
    return varyJob(how, ACTIONS[pass].label, made, madeWith, tool, d.id);
  }
  const key = PASS_KEYS[pass]!;
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
  // Face and Hand refine of a grid's pictures land under each picture as versions, as from the picture itself
  return { recipe: tool, stored, label: OPS[key]!.label, from: d.id, ...(VERSION_PASSES.has(key) ? { versionOf: d.id } : {}) };
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
  // a Vary's img2img is each picture's own model's: offered while any model on has one
  const img2img = place.all.find((r) => r.output === "image" && r.id.endsWith(".redraw"));
  const passes = Object.fromEntries(SELECTION_PASSES.flatMap((id) => {
    const tool = VARY[id] ? img2img : toolOf(PASS_KEYS[id]!, place.all, place.families, undefined, place.ready);
    return tool ? [[id, tool.title]] : [];
  })) as Partial<Record<ActionId, string>>;
  const read = (a: Asset) => client.fetchQuery({ queryKey: queryKeys.assets.one(a.id), queryFn: ({ signal }) => api.asset(a.id, { signal }) });
  const pictures = (items: Asset[]) => items.filter((a) => a.kind === "image" && !a.inBin);
  const run = useMutation({
    /** `changed`: the rows set in the pass's popover, the same on every picture; `count`: copies of each (Vary). */
    mutationFn: async ({ pass, items, changed = {}, count = 1 }: { pass: SelectionPass; items: Asset[]; changed?: Record<string, unknown>; count?: number }) => {
      let queued = 0;
      const failed: unknown[] = [];
      const all = pictures(items);
      // asked first where a pod may take them, as a grid is: priced on the first picture's job, times every picture and copy
      for (const a of all) {
        let job: QueuedJob;
        try {
          job = tunedJob(passJob(pass, await read(a), place), changed, count);
        } catch {
          continue;
        }
        const total = all.length * count;
        if (!(await askBeforeMany(client, { recipe: job.recipe, input: send.inputOf(job), total, what: `${ACTIONS[pass].label}${count > 1 ? ` ×${count}` : ""} on ${plural(all.length, "picture")}` }))) return null;
        break;
      }
      // one after the other: each picture's parameters are read, then its job sent, as its own button would
      for (const a of all) {
        try {
          await send(tunedJob(passJob(pass, await read(a), place), changed, count));
          queued++;
        } catch (err) {
          failed.push(err);
        }
      }
      return { pass, queued, failed, count };
    },
    onSuccess: (done) => {
      // not asked to go on (the ask before queuing on a pod): nothing was sent, nothing to say
      if (!done) return;
      const { pass, queued, failed, count } = done;
      const label = ACTIONS[pass].label;
      if (queued) {
        void client.invalidateQueries({ queryKey: queryKeys.queue() });
        say({ id: `queued:${Date.now()}`, tone: "good", title: `${label}${count > 1 ? ` ×${count}` : ""} queued on ${plural(queued, "picture")}`, ...(VERSION_PASSES.has(PASS_KEYS[pass] ?? "") ? { text: "Each comes back as a version under its picture, not as a new item: K keeps it." } : {}), href: "/queue", go: "Open the Queue" });
      }
      if (failed.length) say(failedBanner({ id: `queued-many:${pass}`, href: "/settings", go: "Open Settings" }, `${label} could not be queued on ${plural(failed.length, "picture")}`, failed[0]));
    },
  });
  const openTune = useTune((t) => t.open);
  /**
   * A pass's popover for the selection (TunePopover.tsx): its rows start on the first picture it can be queued on; the rows
   * changed there go to every picture, the others stay each picture's own.
   */
  const tune = async (pass: SelectionPass, items: Asset[], at: TuneAt) => {
    const all = pictures(items);
    let first: unknown;
    for (const a of all) {
      try {
        const job = passJob(pass, await read(a), place);
        openTune(at, { action: pass, title: ACTIONS[pass].label, sub: `on ${plural(all.length, "picture")}`, job, queue: (changed, count) => run.mutate({ pass, items, changed, count }) });
        return;
      } catch (err) {
        first ??= err;
      }
    }
    say(failedBanner({ id: `queued-many:${pass}`, href: "/settings", go: "Open Settings" }, `${ACTIONS[pass].label} could not be queued on ${plural(all.length, "picture")}`, first));
  };
  /** The passes with settings, for the selection's Passes menu (selectionActions' `tunes`). */
  const tunes = (items: Asset[]) => Object.fromEntries(SELECTION_PASSES.filter((id) => TUNED_ROWS[id]).map((id) => [id, (at: TuneAt) => void tune(id, items, at)])) as Partial<Record<SelectionPass, (at: TuneAt) => void>>;
  return { passes, run, tunes };
}
