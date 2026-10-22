import { catalogKey, filesIn, type Scan } from "@afflatus/comfy";
import { choicesOf, graphFiles, isMissingSlotFile, missingSlotFile, parseInput, sameFile, TOOLS_FAMILY, type Family, type GraphFile, type NodeCatalog, type Recipe, type Wanted } from "@afflatus/core";
import { ANY_PACKS, lookAhead, skipWhy, type PackFacts, type PacksSaid } from "./jobPacks";
import type { Comfy } from "./comfy";
import { readJson, type JobRow, type QueueCore } from "./queueModel";
import { builtOf, withTexts } from "./queueSubmit";
import { FACE_REFINE_MASK, RIFE_GET } from "@afflatus/recipes";
import { pickRife, toolNeeds } from "./queueTools";
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
  /**
   * The node types the graph uses that the machine lacks. A render's, read on a machine, are its own graph's (an option's
   * pack too: SeedVR2's, the GGUF loader), not its plain form's (RecipeStatus.missingNodes), which said nothing of them, and
   * the job went to a pod without the pack, refused at its submit.
   */
  missingNodes?: string[];
  /**
   * The options it asks for whose nodes the machine lacks (BuildContext.wants), their packs to come there: their nodes are
   * among `missingNodes`. It could run without them (jobPacks.ts packsLacked: its Queue row offers Run without).
   */
  wanted?: Wanted[];
  /**
   * Its graph cannot be built on that machine, though it can be for a pod that has nothing yet: why, in the build's words.
   * The job is kept off that machine (fell back to the plain form's files, it went to a fresh pod, refused once its boot
   * and fetch were paid).
   */
  refused?: string;
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

/**
 * A machine's model folder as listed once per scan of it, its .gguf files too (GGUF_LISTS: ComfyUI leaves them out of its
 * own list, and a GGUF job was taken for one lacking its model on the machine that had it, sent to a pod and the file
 * uploaded there); null when it cannot be listed.
 */
function listingOf(on: { id: string; comfy: Comfy; scan: Scan }, folder: string): Promise<string[] | null> {
  const key = `${on.id}|${on.scan.at}|${folder}`;
  let got = listings.get(key);
  if (!got) {
    got = filesIn(on.comfy.client, folder).catch(() => null);
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

/** A Map that holds its `max` most recently used entries: one read goes to the end, the least recently used goes first. */
export class Recent<K, V> extends Map<K, V> {
  constructor(private readonly max: number) {
    super();
  }

  override get(key: K): V | undefined {
    if (!super.has(key)) return undefined;
    const value = super.get(key)!;
    super.delete(key);
    super.set(key, value);
    return value;
  }

  override set(key: K, value: V): this {
    super.delete(key);
    super.set(key, value);
    if (this.size > this.max) this.delete(this.keys().next().value!);
    return this;
  }
}

/**
 * What was worked out for a job on a machine, by what it depends on: the planner asks again at every pass, for every waiting
 * job on every machine. The least recently used goes first, with room for a long line on several machines: kept first in,
 * first out (512), a longer line cycled through it, each entry gone just before it was asked for again, and every graph was
 * built anew at every pass.
 */
const kept = new Recent<string, Loaded | null>(4096);
/** The folder listings kept, by machine and folder. */
const KEPT = 512;

/**
 * The files a waiting job's graph loads on a machine (`on`: its ComfyUI and its scan), or on a pod that has nothing yet
 * (`on` null: built against this PC's node list, nothing relocated). The job is built as the queue will build it there,
 * with stand-ins for its pictures and clips (builtOf); a timeline clip with what it joins onto as known now. Refused, with
 * no files, when it cannot be built even for a pod that has nothing yet. Null when it could not be built for another
 * reason (its recipe gone, a node list not read): the caller counts its files by its family's slots, and it is said in
 * the log, so that such jobs can be found and fixed.
 */
export async function loadedOn(
  core: QueueCore, row: Pick<JobRow, "id" | "recipe_id" | "inputs" | "finished_from" | "clip_id" | "clip_fit" | "clip_mirror">, on: { id: string; comfy: Comfy; scan: Scan } | null,
  packs: { facts?: PackFacts; said?: PacksSaid } = {},
): Promise<Loaded | null> {
  if (row.recipe_id === CUT_JOB) return toolLoadedOn(core, row, on, packs);
  const recipe = core.registry.recipe(row.recipe_id);
  const family = recipe ? core.registry.family(recipe.family) : undefined;
  if (!recipe || !family) return null;
  const raw = readJson<Record<string, unknown>>(row.inputs, {});
  const keys: { key: string } = { key: "" };
  try {
    const got = await graphOn(core, row, recipe, family, raw, on, keys, packs);
    if ("kept" in got) return got.kept;
    const { graph, files, catalog, there, wanted } = got;
    const absent: GraphFile[] = [];
    for (const f of on ? files : []) if (!offeredOn(catalog, f, there, await listingOf(on!, f.folder))) absent.push(f);
    const loaded: Loaded = { files, absent: on ? absent : files, ...(on ? { missingNodes: lackedNodes(graph, catalog), ...(wanted.length ? { wanted } : {}) } : {}) };
    keep(keys.key, loaded);
    return loaded;
  } catch (err) {
    const why = (err as Error).message;
    // on a machine: built as for a pod that has nothing yet (this PC's node list, the downloads), the failure is the
    // machine's own when that one builds. Its files and the node types it lacks there are then those of that graph (a
    // GGUF model on a pod without the GGUF pack: the pack is sent), and with none lacking, the job is kept off it, with why
    let freshWhy: string | null = null;
    if (on && keys.key && !kept.has(keys.key)) {
      const freshKeys = { key: "" };
      const fresh = await graphOn(core, row, recipe, family, raw, null, freshKeys, packs).catch((e: Error) => {
        // (a failure before its build, a node list not read, is not the job's)
        if (freshKeys.key) freshWhy = e.message;
        return null;
      });
      if (fresh && "kept" in fresh && fresh.kept?.refused) freshWhy = fresh.kept.refused;
      if (fresh && !("kept" in fresh)) {
        const catalog = await on.comfy.catalog();
        const there = on.scan.families.find((f) => f.id === recipe.family)?.slots ?? [];
        const absent: GraphFile[] = [];
        for (const f of fresh.files) if (!offeredOn(catalog, f, there, await listingOf(on, f.folder))) absent.push(f);
        const missingNodes = lackedNodes(fresh.graph, catalog);
        const wanted = fresh.wanted.filter((w) => !w.nodes.some((n) => n in catalog));
        const loaded: Loaded = { files: fresh.files, absent, missingNodes, ...(wanted.length ? { wanted } : {}), ...(missingNodes.length ? {} : { refused: why }) };
        keep(keys.key, loaded);
        return loaded;
      }
    }
    // its graph cannot be built even for a pod that has nothing yet, with every file its form asks for: kept off every
    // machine, with why, rather than counted by its family's slots. That fallback sent a fresh pod H3's frames model for a
    // reference clip it never loads, judged sendable, booted and fetched for, refused at its submit (2026-10-22)
    if (keys.key && (!on || freshWhy)) {
      if (!kept.has(keys.key)) console.warn(`[queue] job ${row.id}: its graph cannot be built, even for a pod that has nothing yet: kept off (${why.slice(0, 160)})`);
      const refused: Loaded = { files: [], absent: [], refused: why };
      keep(keys.key, refused);
      return refused;
    }
    if (!keys.key || !kept.has(keys.key)) console.warn(`[queue] job ${row.id}: its files are counted by its family's slots, its graph could not be built here (${why.slice(0, 160)})`);
    if (keys.key) keep(keys.key, null);
    return null;
  }
}

/** The node types a graph uses that a node list lacks. */
const lackedNodes = (graph: Record<string, { class_type: string }>, catalog: NodeCatalog): string[] =>
  [...new Set(Object.values(graph).map((n) => n.class_type))].filter((n) => !(n in catalog));

/**
 * A job's graph as the queue builds it on a machine (`on`, or a pod that has nothing yet), with the files it loads; what
 * was worked out before (`kept`) when its inputs, the machine's scan and node list are the same. `keys.key` is set as soon
 * as it is known, for the caller to keep what it makes of it.
 */
async function graphOn(
  core: QueueCore, row: Pick<JobRow, "id" | "inputs" | "finished_from" | "clip_id" | "clip_fit" | "clip_mirror">, recipe: Recipe<any>, family: Family,
  raw: Record<string, unknown>, on: { id: string; comfy: Comfy; scan: Scan } | null, keys: { key: string }, packs: { facts?: PackFacts; said?: PacksSaid } = {},
): Promise<{ kept: Loaded | null } | { graph: Record<string, { class_type: string }>; files: GraphFile[]; catalog: NodeCatalog; there: SlotStatus[] | null; wanted: Wanted[] }> {
  const comfy = on?.comfy ?? (await core.comfy());
  const catalog = await comfy.catalog();
  const slotsIn = (s: Scan | null) => s?.families.find((f) => f.id === recipe.family)?.slots ?? null;
  // this PC's files stand where no download is known: they are sent from here
  const here = slotsIn(await (await core.comfy()).scan().catch(() => null));
  const there = on ? (slotsIn(on.scan) ?? []) : null;
  const input = parseInput(recipe, withTexts(recipe, raw)) as Record<string, unknown>;
  const slots = podSlotFiles(recipe, input, family.slots, there, here);
  // what the machine has is as its last scan read it: a file come or gone since is a new scan, and worked out anew
  // what the options are given there is part of it: a pack that cannot come, or a Run without, builds them without
  const facts = packs.facts ?? ANY_PACKS;
  const packsKey = JSON.stringify([facts.nvidia, [...facts.cannot.keys()].sort(), packs.said ?? {}]);
  keys.key = [row.id, row.inputs, row.finished_from ?? "", row.clip_id ?? "", on?.id ?? "", on?.scan.at ?? "", catalogKey(catalog) ?? "", JSON.stringify(slots), packsKey].join("\u0001");
  if (kept.has(keys.key)) return { kept: kept.get(keys.key)! };
  const plan = row.clip_id && core.clips ? await core.clips.plan(row.clip_id, recipe, input, Boolean(row.clip_fit), row.finished_from, true, readJson<string[]>(row.clip_mirror, [])).catch(() => null) : null;
  // the options it asks for are given the node their pack brings when this ComfyUI lacks it: its graph then says the pack
  const ahead = lookAhead(catalog, facts, packs.said);
  const built = await builtOf(core, recipe.id, plan ? plan.input : raw, { finishedFrom: row.finished_from, canvas: plan?.canvas, slots, comfy, catalog, relocate: Boolean(on), wants: ahead.wants });
  if (!built) throw new Error("its form could not be read");
  const folders = Object.fromEntries(family.slots.map((s) => [s.id, s.folder]));
  return { graph: built.graph, files: graphFiles(built.graph, slots, folders), catalog, there, wanted: ahead.missing };
}

/** Where Face refine's files are read in its graph (faceRefined): the node and input each slot's file goes to. */
const FACE_LOADERS: Record<string, [classType: string, input: string]> = {
  faceRefineUnet: ["UNETLoader", "unet_name"], faceDetector: ["H3FaceTrackCrop", "detector"], faceSeg: ["H3FaceTrackCrop", "fallback_detector"],
  faceSam: ["SAMLoader", "model_name"], faceClip: ["CLIPLoader", "clip_name"], faceVideoVae: ["VAELoader", "vae_name"], faceAudioVae: ["VAELoader", "vae_name"],
};

/**
 * The files a finish or a RIFE slow-motion loads on a machine (toolNeeds): SeedVR2's two files for its SeedVR2 route, the
 * upscale model picked for the model route, a RIFE model for a slow-motion or the finish of an interpolated take. A pod
 * was never sent them (finishes are not recipes), and Timeline 19's finish failed there for want of RIFE (2026-10-18).
 * Each named as podSlotFiles names a slot: the machine's own, else the download, else this PC's (RIFE has no download:
 * this PC's is sent). Null for a cut that loads nothing.
 */
async function toolLoadedOn(core: QueueCore, row: Pick<JobRow, "id" | "recipe_id" | "inputs">, on: { id: string; comfy: Comfy; scan: Scan } | null, packs: { facts?: PackFacts; said?: PacksSaid } = {}): Promise<Loaded | null> {
  // kept as a render's is (the planner asks at every pass, of every machine); a finish whose take is not there yet is asked
  // again (the queue screen reads the finishes waiting for their clip too)
  const catalog = on ? await on.comfy.catalog().catch(() => null) : null;
  const facts = packs.facts ?? ANY_PACKS;
  const key = ["tool", row.id, row.inputs, on?.id ?? "", on?.scan.at ?? "", catalog ? (catalogKey(catalog) ?? "") : "", JSON.stringify([facts.nvidia, [...facts.cannot.keys()].sort(), packs.said ?? {}])].join("|");
  if (kept.has(key)) return kept.get(key)!;
  const needs = await toolNeeds(core, row).catch(() => null);
  if (!needs) return null;
  const mine = await core.comfy();
  const mineScan = await mine.scan().catch(() => null);
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
    const here = mineScan ? await listingOf({ id: "", comfy: mine, scan: mineScan }, "upscale_models") : null;
    const file = needs.upscaleModel || (there?.length ? null : here?.[0] ?? missingSlotFile("upscaleModel"));
    if (file) add(file, "upscale_models", "UpscaleModelLoader", "model_name", needs.upscaleModel ? undefined : "upscaleModel");
  }
  if (needs.rife) {
    // a RIFE model as rifeModelIn picks one: the machine's own, else the one RIFE is had as (RIFE_GET), as a slot is named
    // (podSlotFiles); this PC's only when the download is not wanted: a machine that has nothing yet gets the download
    const there = await listedOn("frame_interpolation");
    add((there ? pickRife(there) : null) ?? RIFE_GET.file, "frame_interpolation", "FrameInterpolationModelLoader", "model_name", "rife");
  }
  if (needs.face) {
    // Face refine's files of the take's family, each named as podSlotFiles names a slot; SAM only where its nodes are, as
    // the pass takes it (this PC's node list for a pod to come)
    const face = needs.face;
    const slotsIn = (s: Scan | null) => s?.families.find((f) => f.id === face.family)?.slots ?? null;
    const nodes = catalog ?? (await mine.catalog().catch(() => ({}) as NodeCatalog));
    const sam = FACE_REFINE_MASK.every((n) => n in nodes);
    const slots = (core.registry.family(face.family)?.slots ?? []).filter((x) => face.slots.includes(x.id) && FACE_LOADERS[x.id] && (x.id !== "faceSam" || sam));
    const named = podSlotFiles({ needs: slots.map((x) => x.id) }, {}, slots, on ? (slotsIn(on.scan) ?? []) : null, slotsIn(mineScan));
    for (const x of slots) add(named[x.id]!, x.folder, FACE_LOADERS[x.id]![0], FACE_LOADERS[x.id]![1], x.id);
  }
  if (!on) {
    keep(key, { files, absent: files });
    return { files, absent: files };
  }
  const nodes = catalog ?? ({} as NodeCatalog);
  const absent: GraphFile[] = [];
  for (const f of files) if (isMissingSlotFile(f.file) || !offeredOn(nodes, f, null, await listingOf(on, f.folder))) absent.push(f);
  // its nodes as the machine's node list has them: RTX VSR's drivers missing both are asked as the last of them (DaSiWa's
  // pack), as the option of a form is (jobPacks.ts), unless it is done without there (it then upscales with a model, or resizes)
  const rtx: Wanted | null = needs.anyNode?.length && !needs.anyNode.some((n) => n in nodes) ? { input: "upscale", nodes: needs.anyNode, without: "RTX VSR" } : null;
  const asked = rtx && !skipWhy(rtx, facts, packs.said ?? {}) ? rtx : null;
  const missingNodes = [...needs.nodes.filter((n) => !(n in nodes)), ...(asked ? [asked.nodes.at(-1)!] : [])];
  const loaded = { files, absent, ...(missingNodes.length ? { missingNodes } : {}), ...(asked ? { wanted: [asked] } : {}) };
  keep(key, loaded);
  return loaded;
}

function keep(key: string, value: Loaded | null) {
  kept.set(key, value);
}
