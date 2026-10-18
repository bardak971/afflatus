import { catalogKey, type Scan } from "@afflatus/comfy";
import { choicesOf, graphFiles, isMissingSlotFile, missingSlotFile, parseInput, sameFile, TOOLS_FAMILY, type Family, type GraphFile, type NodeCatalog, type Recipe } from "@afflatus/core";
import type { Comfy } from "./comfy";
import { readJson, type JobRow, type QueueCore } from "./queueModel";
import { builtOf, withTexts } from "./queueSubmit";
import { RIFE_GET } from "@afflatus/recipes";
import { toolNeeds } from "./queueTools";
import { CUT_JOB } from "./timelineModel";

/**
 * What a rented pod is sent for a waiting job is what that job's graph loads: not every file its family has, not two names
 * for one of them. A pod deployed for one swap got 9 files for the 5 it loads (2026-10-18): the family's video model it
 * never reads, and one VAE twice, this PC's file named by the Deploy dialog and the family's download by the pod's own check.
 */

type SlotStatus = Scan["families"][number]["slots"][number];
type ModelSlot = Pick<Family["slots"][number], "id" | "folder" | "optional" | "get">;

/** The files a job's graph loads on a machine, and those of them that machine does not have (all of them, for a pod to come). */
export interface Loaded {
  files: GraphFile[];
  absent: GraphFile[];
  /** A finish's or a RIFE slow-motion's node types the machine lacks (a render's are in its scan: RecipeStatus.missingNodes). */
  missingNodes?: string[];
}

/**
 * The family's files a job is built with on a machine, one name per slot: the machine's own file, else the family's
 * download, else this PC's (sent up from here); a required one with none of those is named by missingSlotFile, and only a
 * graph that reads it says so. An optional slot is there only as the machine has it, unless the recipe or this input asks
 * for it (`needs`, `needsWith`: Turbo's LoRAs, SAM with the Mask on), when it comes as a required one does. The Deploy
 * dialog and the pod's own check both name the slots so, so a slot is never fetched under two names.
 */
export function podSlotFiles(
  recipe: Pick<Recipe<any>, "needs" | "needsWith">, input: Record<string, unknown>, slots: readonly ModelSlot[],
  there: readonly SlotStatus[] | null, here: readonly SlotStatus[] | null,
): Record<string, string> {
  const at = (list: readonly SlotStatus[] | null, id: string) => list?.find((x) => x.id === id)?.file ?? null;
  const fill = (s: ModelSlot) => at(there, s.id) ?? s.get?.file ?? at(here, s.id) ?? missingSlotFile(s.id);
  const out: Record<string, string> = {};
  for (const s of slots) {
    if (!s.optional || recipe.needs?.includes(s.id)) out[s.id] = fill(s);
    else if (at(there, s.id)) out[s.id] = at(there, s.id)!;
  }
  // what this input asks for, read against the files it is built with (a model made for few steps asks no turbo LoRA)
  for (const id of recipe.needsWith?.(input, out) ?? []) {
    const s = slots.find((x) => x.id === id);
    if (s && !out[id]) out[id] = fill(s);
  }
  return out;
}

/**
 * Whether a machine has a graph's file: in its model folder's listing (`listed`, read at its last scan, as the scan reads
 * its folders: the node list is kept longer, and still named a file gone since), else in its node list where the graph
 * names it, else, for a family file, as its scan found it. Nothing to tell by: there.
 */
export function offeredOn(catalog: NodeCatalog, f: GraphFile, there: readonly SlotStatus[] | null, listed: readonly string[] | null = null): boolean {
  if (listed) return Boolean(sameFile([...listed], f.file));
  const choices = nodeChoices(catalog, f);
  if (choices?.length) return Boolean(sameFile(choices, f.file));
  return f.slot ? there?.find((x) => x.id === f.slot)?.file === f.file : true;
}

/** A machine's model folder as listed once per scan of it; null when it cannot be listed. */
function listingOf(on: { id: string; comfy: Comfy; scan: Scan }, folder: string): Promise<string[] | null> {
  const key = `${on.id}|${on.scan.at}|${folder}`;
  let got = listings.get(key);
  if (!got) {
    got = on.comfy.client.models(folder).catch(() => null);
    listings.set(key, got);
    if (listings.size > KEPT) listings.delete(listings.keys().next().value!);
  }
  return got;
}
const listings = new Map<string, Promise<string[] | null>>();

/** The files a node's input offers on a machine, as its node list says; null when it lists none. */
function nodeChoices(catalog: NodeCatalog, f: GraphFile): string[] | null {
  const def = catalog[f.classType];
  return def ? choicesOf(def.input.required?.[f.input] ?? def.input.optional?.[f.input]) : null;
}

/** What was worked out for a job on a machine, by what it depends on: the planner asks again at every pass. */
const kept = new Map<string, Loaded | null>();
const KEPT = 512;

/**
 * The files a waiting job's graph loads on a machine (`on`: its ComfyUI and its scan), or on a pod that has nothing yet
 * (`on` null: built against this PC's node list, nothing relocated). The job is built as the queue will build it there,
 * with stand-ins for its pictures and clips (builtOf); a timeline clip with what it joins onto as known now. Null when it
 * cannot be built without its real media: the caller counts its files by its family's slots, and it is said in the log,
 * so that such jobs can be found and fixed.
 */
export async function loadedOn(core: QueueCore, row: Pick<JobRow, "id" | "recipe_id" | "inputs" | "finished_from" | "clip_id" | "clip_fit" | "clip_mirror">, on: { id: string; comfy: Comfy; scan: Scan } | null): Promise<Loaded | null> {
  if (row.recipe_id === CUT_JOB) return toolLoadedOn(core, row, on);
  const recipe = core.registry.recipe(row.recipe_id);
  const family = recipe ? core.registry.family(recipe.family) : undefined;
  if (!recipe || !family) return null;
  const raw = readJson<Record<string, unknown>>(row.inputs, {});
  let key = "";
  try {
    const comfy = on?.comfy ?? (await core.comfy());
    const catalog = await comfy.catalog();
    const slotsIn = (s: Scan | null) => s?.families.find((f) => f.id === recipe.family)?.slots ?? null;
    // this PC's files stand where no download is known: they are sent from here
    const here = slotsIn(await (await core.comfy()).scan().catch(() => null));
    const there = on ? (slotsIn(on.scan) ?? []) : null;
    const input = parseInput(recipe, withTexts(recipe, raw)) as Record<string, unknown>;
    const slots = podSlotFiles(recipe, input, family.slots, there, here);
    // what the machine has is as its last scan read it: a file come or gone since is a new scan, and worked out anew
    key = [row.id, row.inputs, row.finished_from ?? "", row.clip_id ?? "", on?.id ?? "", on?.scan.at ?? "", catalogKey(catalog) ?? "", JSON.stringify(slots)].join("\u0001");
    if (kept.has(key)) return kept.get(key)!;
    const plan = row.clip_id && core.clips ? await core.clips.plan(row.clip_id, recipe, input, Boolean(row.clip_fit), row.finished_from, true, readJson<string[]>(row.clip_mirror, [])).catch(() => null) : null;
    const built = await builtOf(core, recipe.id, plan ? plan.input : raw, { finishedFrom: row.finished_from, canvas: plan?.canvas, slots, comfy, catalog, relocate: Boolean(on) });
    if (!built) throw new Error("its form could not be read");
    const folders = Object.fromEntries(family.slots.map((s) => [s.id, s.folder]));
    const files = graphFiles(built.graph, slots, folders);
    const absent: GraphFile[] = [];
    for (const f of on ? files : []) if (!offeredOn(catalog, f, there, await listingOf(on!, f.folder))) absent.push(f);
    const loaded = { files, absent: on ? absent : files };
    keep(key, loaded);
    return loaded;
  } catch (err) {
    if (!key || !kept.has(key)) console.warn(`[queue] job ${row.id}: its files are counted by its family's slots, its graph could not be built here (${(err as Error).message.slice(0, 160)})`);
    if (key) keep(key, null);
    return null;
  }
}

/**
 * The files a finish or a RIFE slow-motion loads on a machine (toolNeeds): SeedVR2's two files for its SeedVR2 route, the
 * upscale model picked for the model route, a RIFE model for a slow-motion or the finish of an interpolated take. A pod
 * was never sent them (finishes are not recipes), and Timeline 19's finish failed there for want of RIFE (2026-10-18).
 * Each named as podSlotFiles names a slot: the machine's own, else the download, else this PC's (RIFE has no download:
 * this PC's is sent). Null for a cut that loads nothing.
 */
async function toolLoadedOn(core: QueueCore, row: Pick<JobRow, "id" | "recipe_id" | "inputs">, on: { id: string; comfy: Comfy; scan: Scan } | null): Promise<Loaded | null> {
  const needs = await toolNeeds(core, row).catch(() => null);
  if (!needs) return null;
  const mine = await core.comfy();
  const listedOn = (folder: string) => (on ? listingOf(on, folder) : Promise.resolve(null));
  const files: GraphFile[] = [];
  const add = (file: string, folder: string, classType: string, input: string, slot?: string) => files.push({ file, folder, node: "", classType, input, ...(slot ? { slot } : {}) });
  if (needs.seedvr) {
    const toolsIn = (s: Scan | null) => s?.families.find((f) => f.id === TOOLS_FAMILY)?.slots ?? null;
    const slots = (core.registry.family(TOOLS_FAMILY)?.slots ?? []).filter((x) => x.id === "seedvr" || x.id === "seedvrVae");
    const named = podSlotFiles({ needs: ["seedvr", "seedvrVae"] }, {}, slots, on ? (toolsIn(on.scan) ?? []) : null, toolsIn(await mine.scan().catch(() => null)));
    for (const x of slots) add(named[x.id]!, x.folder, x.id === "seedvr" ? "UNETLoader" : "VAELoader", x.id === "seedvr" ? "unet_name" : "vae_name", x.id);
  }
  if (needs.upscaleModel !== null) {
    // none picked: whichever the machine has, else the first of this PC's, sent from here
    const there = await listedOn("upscale_models");
    const file = needs.upscaleModel || (there?.length ? null : (await mine.client.models("upscale_models").catch(() => [] as string[]))[0] ?? missingSlotFile("upscaleModel"));
    if (file) add(file, "upscale_models", "UpscaleModelLoader", "model_name", needs.upscaleModel ? undefined : "upscaleModel");
  }
  if (needs.rife) {
    // a RIFE model as rifeModelIn picks one: the machine's own, else the one RIFE is had as (RIFE_GET), as a slot is named
    // (podSlotFiles); this PC's only when the download is not wanted: a machine that has nothing yet gets the download
    const rifeIn = (files: string[] | null) => (files ? (files.find((f) => /rife/i.test(f)) ?? files[0] ?? null) : null);
    add(rifeIn(await listedOn("frame_interpolation")) ?? RIFE_GET.file, "frame_interpolation", "FrameInterpolationModelLoader", "model_name", "rife");
  }
  if (!on) return { files, absent: files };
  const catalog = await on.comfy.catalog().catch(() => ({}) as NodeCatalog);
  const absent: GraphFile[] = [];
  for (const f of files) if (isMissingSlotFile(f.file) || !offeredOn(catalog, f, null, await listingOf(on, f.folder))) absent.push(f);
  // its nodes as the machine's node list has them: one of `anyNode` missing all is asked as the last of them (DaSiWa's
  // pack for RTX VSR, which Afflatus can install, where NVIDIA's own cannot be)
  const missingNodes = [...needs.nodes.filter((n) => !(n in catalog)), ...(needs.anyNode?.length && !needs.anyNode.some((n) => n in catalog) ? [needs.anyNode.at(-1)!] : [])];
  return { files, absent, ...(missingNodes.length ? { missingNodes } : {}) };
}

function keep(key: string, value: Loaded | null) {
  kept.set(key, value);
  if (kept.size > KEPT) kept.delete(kept.keys().next().value!);
}
