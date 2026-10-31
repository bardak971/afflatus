import { catalogKey, filesIn, type Scan } from "@afflatus/comfy";
import { choicesOf, graphFiles, isBeyondPack, isMissingSlotFile, missingSlotFile, packOfNode, parseInput, sameFile, TOOLS_FAMILY, type Family, type GraphFile, type NodeCatalog, type Recipe, type Wanted } from "@afflatus/core";
import { ANY_PACKS, cannotWhy, lookAhead, skipWhy, type PackFacts, type PacksSaid } from "./jobPacks";
import type { Comfy } from "./comfy";
import { readJson, type JobRow, type QueueCore } from "./queueModel";
import { builtOf, withTexts } from "./queueSubmit";
import { FACE_REFINE_MASK, RIFE_GET } from "@afflatus/recipes";
import { pickRife, toolNeeds } from "./queueTools";
import { CUT_JOB } from "./timelineModel";
import { refusedSaid, setFindings } from "./modelSetCheck";

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
 * dialog and the pod's own check both name the slots so, so a slot is never fetched under two names. `own`: a machine of the
 * user's own, never asked a file its build does without there (Recipe.needsWith's `own`).
 */
export function podSlotFiles(
  recipe: Pick<Recipe<any>, "needs" | "needsWith">, input: Record<string, unknown>, slots: readonly ModelSlot[],
  there: readonly SlotStatus[] | null, here: readonly SlotStatus[] | null, own = false,
): Record<string, string> {
  const at = (list: readonly SlotStatus[] | null, id: string) => list?.find((x) => x.id === id)?.file ?? null;
  const fill = (s: ModelSlot) => at(there, s.id) ?? s.get?.file ?? at(here, s.id) ?? missingSlotFile(s.id);
  const out: Record<string, string> = {};
  for (const s of slots) {
    if (!s.optional || recipe.needs?.includes(s.id)) out[s.id] = fill(s);
    else if (at(there, s.id)) out[s.id] = at(there, s.id)!;
  }
  // what this input asks for, read against the files it is built with (a model made for few steps asks no turbo LoRA)
  for (const id of recipe.needsWith?.(input, out, { own }) ?? []) {
    const s = slots.find((x) => x.id === id);
    if (s && !out[id]) out[id] = fill(s);
  }
  return out;
}

/**
 * Whether a machine has a graph's file: in its model folder's listing (`listed`, read at its last scan, as the scan reads
 * its folders: the node list is kept longer, and still named a file gone since) and among its loader's choices in its node
 * list, which its submit checks the graph against (core checkGraph); else in its node list where the graph names it, else,
 * for a family file, as its scan found it. Nothing to tell by: there. A file listed and not yet offered is not there: a Wan
 * clip went to a pod on the listing's word, SVI's LoRAs just landed, and its submit refused it on the node list's (card #107).
 */
export function offeredOn(catalog: NodeCatalog, f: GraphFile, there: readonly SlotStatus[] | null, listed: readonly string[] | null = null): boolean {
  const choices = nodeChoices(catalog, f);
  if (listed) return Boolean(sameFile([...listed], f.file)) && (!choices?.length || Boolean(sameFile(choices, f.file)));
  if (choices?.length) return Boolean(sameFile(choices, f.file));
  return f.slot ? there?.find((x) => x.id === f.slot)?.file === f.file : true;
}

/**
 * The files of a graph a machine does not have (offeredOn). One its folders list and its node list does not offer came after
 * that list was read: the list is read again (Comfy.catalogBehind), and the job waits for it rather than go and be refused.
 */
async function absentOn(on: { id: string; comfy: Comfy; scan: Scan }, catalog: NodeCatalog, files: readonly GraphFile[], there: readonly SlotStatus[]): Promise<GraphFile[]> {
  const absent: GraphFile[] = [];
  let behind = false;
  for (const f of files) {
    const listed = await listingOf(on, f.folder);
    if (offeredOn(catalog, f, there, listed)) continue;
    absent.push(f);
    if (listed && sameFile([...listed], f.file)) behind = true;
  }
  if (behind) on.comfy.catalogBehind();
  return absent;
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
  constructor(public max: number) {
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

/** The least room the kept graphs have, and the most: a key holds a job's inputs, and the line may hold thousands. */
const KEPT_LEAST = 4096;
const KEPT_MOST = 65_536;

/**
 * What was worked out for a job on a machine, by what it depends on: the planner asks again at every pass, for every waiting
 * job on every machine. The least recently used goes first, with room for a long line on several machines: kept first in,
 * first out (512), a longer line cycled through it, each entry gone just before it was asked for again, and every graph was
 * built anew at every pass. Its room grows with the line (roomFor): at 4,096, 10 machines and 420 waiting jobs thrashed it
 * the same way, every graph built at every pass (the 2026-10-22 review, M-8).
 */
const kept = new Recent<string, Loaded | null>(KEPT_LEAST);

/**
 * The same, by what it depends on but the machine's scan time, for a job on a machine of now: a scan is made again every
 * minute, and with its time in the key every graph of the line was built anew each minute, a whole line's builds for files
 * that had not moved (M-9). What it lacks there is read again from that scan's folder listings (relisted); the graph itself
 * depends on the scan only through the family's files (`slots`, in the key). A clip's graph is left out (what it joins onto
 * moves without its scan), and an entry is built again after STABLE_MS, whatever else may move a graph.
 */
const stable = new Recent<string, { at: number; loaded: Loaded | null }>(KEPT_LEAST);
const STABLE_MS = 10 * 60_000;

/**
 * Each waiting job's form as parsed, by its recipe and its inputs: every pass parsed every job's form once per machine
 * before its kept graph was looked up (3,800 parses a warm pass at 10 machines, M-9). Parsed, a form is only read.
 */
const parsed = new Recent<string, Record<string, unknown>>(KEPT_LEAST);
/** Each recipe object's number, for the keys: a saved workflow changed is a new recipe under the same id. */
const recipeNumbers = new WeakMap<object, number>();
let recipesNumbered = 0;
const numberOf = (recipe: object) => recipeNumbers.get(recipe) ?? (recipeNumbers.set(recipe, ++recipesNumbered), recipesNumbered);

/**
 * Room for this many jobs × machines in what is kept (the planner says it at each pass): twice that, the entries of the scan
 * before beside those of the scan of now, between KEPT_LEAST and KEPT_MOST; that room.
 */
export function roomFor(entries: number): number {
  const room = Math.min(KEPT_MOST, Math.max(KEPT_LEAST, 2 * entries));
  kept.max = room;
  stable.max = room;
  parsed.max = room;
  return room;
}

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
  core: QueueCore, row: Pick<JobRow, "id" | "recipe_id" | "inputs" | "finished_from" | "clip_id" | "clip_fit" | "clip_mirror">, on: { id: string; comfy: Comfy; scan: Scan; own?: boolean } | null,
  packs: { facts?: PackFacts; said?: PacksSaid } = {},
): Promise<Loaded | null> {
  if (row.recipe_id === CUT_JOB) return toolLoadedOn(core, row, on, packs);
  const recipe = core.registry.recipe(row.recipe_id);
  const family = recipe ? core.registry.family(recipe.family) : undefined;
  if (!recipe || !family) return null;
  const raw = rawOf(row);
  const keys: Keys = { key: "", stable: "" };
  try {
    const got = on ? await graphOn(core, row, recipe, family, raw, on, keys, packs) : await freshGraph(core, row, recipe, family, raw, keys, packs);
    if ("kept" in got) return got.kept;
    const { graph, files, catalog, there, wanted } = got;
    const absent = on ? await absentOn(on, catalog, files, there ?? []) : [];
    const loaded: Loaded = { files, absent: on ? absent : files, ...(on ? { missingNodes: lackedNodes(graph, catalog), ...(wanted.length ? { wanted } : {}) } : {}) };
    keep(keys, loaded);
    return loaded;
  } catch (err) {
    const why = (err as Error).message;
    // on a machine: built as for a pod that has nothing yet (this PC's node list, the downloads), the failure is the
    // machine's own when that one builds. Its files and the node types it lacks there are then those of that graph (a
    // GGUF model on a pod without the GGUF pack: the pack is sent), and with none lacking, the job is kept off it, with why
    let freshWhy: string | null = null;
    if (on && keys.key && !kept.has(keys.key)) {
      const freshKeys: Keys = { key: "", stable: "" };
      // built anew: what was kept for a pod to come (the Deploy dialog's files) has no graph to read its nodes from. Only
      // a pod is built again with every node: that build takes every "use if present" route (KJNodes' patches, VHS's
      // output), and on a machine of the user's own they became packs it had to have, installed unasked under Always, the
      // render changed by them. A machine of the user's own is built on its own node list and files, with only the pack
      // its build threw for (ownGraph): built on this PC's instead, the PC that lacked the pack threw again and its job was
      // refused, never offered Install, and another ComfyUI of the user's took this PC's "use if present" routes as packs
      // to have and its files by their downloads.
      const built = on.own ? ownGraph(core, row, recipe, family, raw, on, freshKeys, packs) : freshGraph(core, row, recipe, family, raw, freshKeys, packs, true);
      const fresh = await built.catch((e: Error) => {
        // (a failure before its build, a node list not read, is not the job's)
        if (freshKeys.key) freshWhy = e.message;
        return null;
      });
      if (fresh && !("kept" in fresh)) {
        const catalog = await on.comfy.catalog();
        const there = on.scan.families.find((f) => f.id === recipe.family)?.slots ?? [];
        const absent = await absentOn(on, catalog, fresh.files, there);
        const missingNodes = lackedNodes(fresh.graph, catalog);
        const wanted = fresh.wanted.filter((w) => !w.nodes.some((n) => n in catalog));
        const loaded: Loaded = { files: fresh.files, absent, missingNodes, ...(wanted.length ? { wanted } : {}), ...(missingNodes.length ? {} : { refused: why }) };
        keep(keys, loaded);
        return loaded;
      }
    }
    // its graph cannot be built even for a pod that has nothing yet, with every file its form asks for: kept off every
    // machine, with why, rather than counted by its family's slots. That fallback sent a fresh pod H3's frames model for a
    // reference clip it never loads, judged sendable, booted and fetched for, refused at its submit (2026-10-22)
    if (keys.key && (!on || freshWhy)) {
      if (!kept.has(keys.key)) console.warn(`[queue] job ${row.id}: its graph cannot be built, even for a pod that has nothing yet: kept off (${why.slice(0, 160)})`);
      const refused: Loaded = { files: [], absent: [], refused: why };
      keep(keys, refused);
      return refused;
    }
    if (!keys.key || !kept.has(keys.key)) console.warn(`[queue] job ${row.id}: its files are counted by its family's slots, its graph could not be built here (${why.slice(0, 160)})`);
    if (keys.key) keep(keys, null);
    return null;
  }
}

/**
 * A job's graph as built for a pod that has nothing yet (graphOn with no machine). That build reads this PC's node list,
 * which says nothing of the pod's: where it throws for a node this PC lacks (a latent finish without the MMH3 pack here,
 * Face refine with an older Afflatus pack), it is built again with every node there, the pod image's packs and any pack
 * sent to a pod; its node types a machine lacks are then said as the packs to install. Only a job that cannot be built
 * even so is refused: every new pod was refused such a job, though the image has the pack (2026-10-22). The first
 * failure is the one thrown, and `keys.key` is the first build's, for the caller to keep what it makes of it. `anew`: built
 * whatever was kept for it.
 */
async function freshGraph(
  core: QueueCore, row: Parameters<typeof graphOn>[1], recipe: Recipe<any>, family: Family, raw: Record<string, unknown>, keys: Keys,
  packs: { facts?: PackFacts; said?: PacksSaid }, anew = false,
): ReturnType<typeof graphOn> {
  try {
    return await graphOn(core, row, recipe, family, raw, null, keys, packs, { anew });
  } catch (err) {
    // (a failure before its build, a node list not read, is not the nodes')
    if (!keys.key) throw err;
    return await graphOn(core, row, recipe, family, raw, null, { key: "", stable: "" }, packs, { everyNode: true, anew: true }).catch(() => {
      throw err;
    });
  }
}

/**
 * How many times ownGraph builds a job's graph on a machine of the user's own: as the machine is, then once more with each
 * pack a build threw for, so three packs at most.
 */
const OWN_TRIES = 4;

/**
 * A job's graph on a machine of the user's own that it cannot be built on as it is: built again on that machine's node
 * list and files, given the pack of the node its build threw for, as when that pack is installed (a .gguf model without
 * ComfyUI-GGUF, a latent finish without the MMH3 pack); a few times, for a job lacking several. Only a node the build asked
 * for last, found lacking, and named in its words (or its pack is) is one it cannot run without: a "use if present" check
 * says nothing when it fails, and a throw for a file or a value is the job's own, refused with why. Its graph then says the
 * packs it lacks there, and its Queue row offers Install and restart (jobPacks.ts); a node of no pack Afflatus can install
 * is not given, nor one whose pack alone does not make it run (core beyondPack: SageAttention), and the job is refused with
 * the build's words.
 */
async function ownGraph(
  core: QueueCore, row: Parameters<typeof graphOn>[1], recipe: Recipe<any>, family: Family, raw: Record<string, unknown>,
  on: { id: string; comfy: Comfy; scan: Scan; own?: boolean }, keys: Keys, packs: { facts?: PackFacts; said?: PacksSaid },
): ReturnType<typeof graphOn> {
  const catalog = await on.comfy.catalog();
  const given = new Set<string>();
  for (let tries = 1; ; tries++) {
    const last = { node: "", there: true };
    const has = (node: string) => {
      last.node = node;
      last.there = node in catalog || given.has(node);
      return last.there;
    };
    try {
      return await graphOn(core, row, recipe, family, raw, on, keys, packs, { anew: true, has });
    } catch (err) {
      const words = (err as Error).message.toLowerCase();
      const pack = last.there ? undefined : packOfNode(last.node);
      const named = pack && (words.includes(last.node.toLowerCase()) || words.includes(pack.name.toLowerCase()));
      if (!pack || pack.own || !named || isBeyondPack(err) || tries >= OWN_TRIES) throw err;
      for (const node of pack.nodes) given.add(node);
    }
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
  raw: Record<string, unknown>, on: { id: string; comfy: Comfy; scan: Scan; own?: boolean } | null, keys: Keys, packs: { facts?: PackFacts; said?: PacksSaid } = {},
  how: { everyNode?: boolean; anew?: boolean; has?: (node: string) => boolean } = {},
): Promise<{ kept: Loaded | null } | { graph: Record<string, { class_type: string }>; files: GraphFile[]; catalog: NodeCatalog; there: SlotStatus[] | null; wanted: Wanted[] }> {
  const comfy = on?.comfy ?? (await core.comfy());
  const catalog = await comfy.catalog();
  const slotsIn = (s: Scan | null) => s?.families.find((f) => f.id === recipe.family)?.slots ?? null;
  // this PC's files stand where no download is known: they are sent from here
  const here = slotsIn(await hereScan(core));
  const there = on ? (slotsIn(on.scan) ?? []) : null;
  const input = parsedOf(recipe, row, raw);
  const slots = podSlotFiles(recipe, input, family.slots, there, here, Boolean(on?.own));
  // what the machine has is as its last scan read it: a file come or gone since is a new scan, and worked out anew
  // what the options are given there is part of it: a pack that cannot come, or a Run without, builds them without
  const facts = packs.facts ?? ANY_PACKS;
  const packsKey = JSON.stringify([facts.nvidia, [...facts.cannot.keys()].sort(), packs.said ?? {}]);
  const parts = [row.id, row.inputs, row.finished_from ?? "", row.clip_id ?? "", on?.id ?? "", on?.scan.at ?? "", catalogKey(catalog) ?? "", JSON.stringify(slots), packsKey, how.everyNode ? "every node" : "", on?.own ? "own" : ""];
  keys.key = parts.join("\u0001");
  // the same but the scan's time, for a job on a machine of now that is no clip (see stable)
  keys.stable = on && !row.clip_id && !how.everyNode && !how.has ? [numberOf(recipe), ...parts.filter((_, i) => i !== 5)].join("\u0001") : "";
  const was = how.anew ? undefined : kept.get(keys.key);
  if (was !== undefined) return { kept: was };
  if (!how.anew && keys.stable) {
    const before = stable.get(keys.stable);
    if (before && Date.now() - before.at <= STABLE_MS) {
      const loaded = await relisted(before.loaded, on!, catalog, there ?? []);
      keep(keys, loaded);
      return { kept: loaded };
    }
  }
  // (a copy: the parsed form is kept, and read by every pass)
  const plan = row.clip_id && core.clips ? await core.clips.plan(row.clip_id, recipe, { ...input }, Boolean(row.clip_fit), row.finished_from, true, readJson<string[]>(row.clip_mirror, [])).catch(() => null) : null;
  // the options it asks for are given the node their pack brings when this ComfyUI lacks it: its graph then says the pack
  const ahead = lookAhead(catalog, facts, packs.said);
  // a pod (one to come, or a rented one) takes Face refine's paste-back over SAM's outline, its nodes counted as there: they
  // come as the pack of any node it lacks, as for a Finish › Face refine (built with every node). Read on this PC's node
  // list, a render with Face refine (H3's, SCAIL's) fetched no SAM for a fresh pod, and pasted the face over its box. Not
  // where their pack failed (samNodeComes)
  const has = how.everyNode ? () => true : (how.has ?? ((n: string) => n in catalog));
  const podHas = on?.own ? has : (n: string) => (FACE_REFINE_MASK.includes(n) ? samNodeComes(n, catalog, facts) : has(n));
  // a timeline clip asks for its files as the timeline makes it: the clip it carries on from is the plan's, not in its own
  // form. Asked on its form alone, a Wan clip that carries on asked for no SVI LoRA, a pod was never sent them, and the
  // clip there failed at its submit for want of them (card #82, 2026-10-25)
  const planned = plan ? podSlotFiles(recipe, parseInput(recipe, plan.input) as Record<string, unknown>, family.slots, there, here, Boolean(on?.own)) : slots;
  const built = await builtOf(core, recipe.id, plan ? plan.input : raw, { finishedFrom: row.finished_from, canvas: plan?.canvas, slots: planned, comfy, catalog, relocate: Boolean(on), wants: ahead.wants, has: podHas });
  if (!built) throw new Error("its form could not be read");
  // a mix of files known to give black frames is refused at its submit: a pod, rented or to come, is sent none of its files,
  // and the job is kept off it with why. Such a job is refused before it is queued (Queue.enqueue): one that gets here was
  // queued before that check, or while ComfyUI did not answer. A machine of the user's own takes it, and its submit says why
  if (!on?.own) {
    const found = await setFindings(core.db, family, recipe, plan ? parseInput(recipe, plan.input) as Record<string, unknown> : input, built, planned);
    if (found.some((f) => f.black)) throw new Error(refusedSaid(found));
  }
  const folders = Object.fromEntries(family.slots.map((s) => [s.id, s.folder]));
  return { graph: built.graph, files: graphFiles(built.graph, planned, folders), catalog, there, wanted: ahead.missing };
}

/**
 * Whether one of Face refine's SAM nodes is taken as there on a pod: listed there, or its pack can come (sent as any pack
 * a job lacks). Not when that pack failed there: the face is then pasted over its box, as its render will, rather than
 * the job waiting for a pack that cannot come, the pod billed idle until it stopped with the job unrun (2026-10-23).
 */
const samNodeComes = (node: string, catalog: NodeCatalog, facts: PackFacts): boolean => node in catalog || !cannotWhy(facts, packOfNode(node)?.name ?? "");

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
async function toolLoadedOn(core: QueueCore, row: Pick<JobRow, "id" | "recipe_id" | "inputs">, on: { id: string; comfy: Comfy; scan: Scan; own?: boolean } | null, packs: { facts?: PackFacts; said?: PacksSaid } = {}): Promise<Loaded | null> {
  // kept as a render's is (the planner asks at every pass, of every machine); a finish whose take is not there yet is asked
  // again (the queue screen reads the finishes waiting for their clip too)
  const catalog = on ? await on.comfy.catalog().catch(() => null) : null;
  const facts = packs.facts ?? ANY_PACKS;
  const key = ["tool", row.id, row.inputs, on?.id ?? "", on?.own ? "own" : "", on?.scan.at ?? "", catalog ? (catalogKey(catalog) ?? "") : "", JSON.stringify([facts.nvidia, [...facts.cannot.keys()].sort(), packs.said ?? {}])].join("|");
  if (kept.has(key)) return kept.get(key)!;
  const needs = await toolNeeds(core, row).catch(() => null);
  if (!needs) return null;
  const mine = await core.comfy();
  const mineScan = await hereScan(core);
  const listedOn = (folder: string) => (on ? listingOf(on, folder) : Promise.resolve(null));
  const files: GraphFile[] = [];
  const add = (file: string, folder: string, classType: string, input: string, slot?: string) => files.push({ file, folder, node: "", classType, input, ...(slot ? { slot } : {}) });
  if (needs.seedvr) {
    const toolsIn = (s: Scan | null) => s?.families.find((f) => f.id === TOOLS_FAMILY)?.slots ?? null;
    const slots = (core.registry.family(TOOLS_FAMILY)?.slots ?? []).filter((x) => x.id === "seedvr" || x.id === "seedvrVae");
    const named = podSlotFiles({ needs: ["seedvr", "seedvrVae"] }, {}, slots, on ? (toolsIn(on.scan) ?? []) : null, toolsIn(mineScan));
    // a model picked for the finish is sent as it is, the family's VAE beside it
    for (const x of slots) {
      if (x.id === "seedvr" && needs.seedvrModel) add(needs.seedvrModel, x.folder, "UNETLoader", "unet_name");
      else add(named[x.id]!, x.folder, x.id === "seedvr" ? "UNETLoader" : "VAELoader", x.id === "seedvr" ? "unet_name" : "vae_name", x.id);
    }
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
  const samNodes: string[] = [];
  if (needs.face) {
    // Face refine's files of the take's family, each named as podSlotFiles names a slot; SAM on a machine of the user's own
    // only where its nodes are, as the pass takes it, and always on a pod, its nodes asked for there as a render's are (graphOn)
    const face = needs.face;
    const slotsIn = (s: Scan | null) => s?.families.find((f) => f.id === face.family)?.slots ?? null;
    const nodes = catalog ?? (await mine.catalog().catch(() => ({}) as NodeCatalog));
    const sam = on?.own ? FACE_REFINE_MASK.every((n) => n in nodes) : FACE_REFINE_MASK.every((n) => samNodeComes(n, nodes, packs.facts ?? ANY_PACKS));
    if (!on?.own && sam && face.slots.includes("faceSam")) samNodes.push(...FACE_REFINE_MASK);
    const slots = (core.registry.family(face.family)?.slots ?? []).filter((x) => face.slots.includes(x.id) && FACE_LOADERS[x.id] && (x.id !== "faceSam" || sam));
    const named = podSlotFiles({ needs: slots.map((x) => x.id) }, {}, slots, on ? (slotsIn(on.scan) ?? []) : null, slotsIn(mineScan));
    for (const x of slots) add(named[x.id]!, x.folder, FACE_LOADERS[x.id]![0], FACE_LOADERS[x.id]![1], x.id);
    // the H3 model picked in Finish is sent as it is, in place of the fused turbo's slot (card #192)
    if (face.model) add(face.model, "diffusion_models", ...FACE_LOADERS.faceRefineUnet!);
  }
  if (!on) {
    keep({ key, stable: "" }, { files, absent: files });
    return { files, absent: files };
  }
  const nodes = catalog ?? ({} as NodeCatalog);
  const absent: GraphFile[] = [];
  for (const f of files) if (isMissingSlotFile(f.file) || !offeredOn(nodes, f, null, await listingOf(on, f.folder))) absent.push(f);
  // its nodes as the machine's node list has them: RTX VSR's drivers missing both are asked as the last of them (DaSiWa's
  // pack), as the option of a form is (jobPacks.ts), unless it is done without there (it then upscales with a model, or resizes)
  const rtx: Wanted | null = needs.anyNode?.length && !needs.anyNode.some((n) => n in nodes) ? { input: "upscale", nodes: needs.anyNode, without: "RTX VSR" } : null;
  const asked = rtx && !skipWhy(rtx, facts, packs.said ?? {}) ? rtx : null;
  const missingNodes = [...[...needs.nodes, ...samNodes].filter((n) => !(n in nodes)), ...(asked ? [asked.nodes.at(-1)!] : [])];
  const loaded = { files, absent, ...(missingNodes.length ? { missingNodes } : {}), ...(asked ? { wanted: [asked] } : {}) };
  keep({ key, stable: "" }, loaded);
  return loaded;
}

/**
 * What was kept for a job on a machine at another of its scans (stable), with what it lacks there read again from this scan's
 * folder listings, as loadedOn reads it after a build: the graph's files are the same, the machine's folders may not be.
 */
async function relisted(loaded: Loaded | null, on: { id: string; comfy: Comfy; scan: Scan }, catalog: NodeCatalog, there: readonly SlotStatus[]): Promise<Loaded | null> {
  if (!loaded?.files.length) return loaded;
  return { ...loaded, absent: await absentOn(on, catalog, loaded.files, there) };
}

/**
 * A form as parseInput gives it, kept by its recipe and its inputs (see parsed), and by its row for the pass that read it (a
 * key holds the whole form: one per machine was most of a warm pass). A form that does not parse throws each time.
 */
function parsedOf(recipe: Recipe<any>, row: Pick<JobRow, "inputs">, raw: Record<string, unknown>): Record<string, unknown> {
  const mine = parsedRows.get(row);
  if (mine?.recipe === recipe && mine.inputs === row.inputs) return mine.input;
  const key = `${numberOf(recipe)}\u0001${row.inputs}`;
  let input = parsed.get(key);
  if (!input) parsed.set(key, (input = parseInput(recipe, withTexts(recipe, raw)) as Record<string, unknown>));
  parsedRows.set(row, { recipe, inputs: row.inputs, input });
  return input;
}
const parsedRows = new WeakMap<object, { recipe: Recipe<any>; inputs: string; input: Record<string, unknown> }>();

/** A job's inputs as stored, read once per row read (the planner asks of each row on every machine). */
function rawOf(row: Pick<JobRow, "inputs">): Record<string, unknown> {
  const mine = raws.get(row);
  if (mine?.inputs === row.inputs) return mine.raw;
  const raw = readJson<Record<string, unknown>>(row.inputs, {});
  raws.set(row, { inputs: row.inputs, raw });
  return raw;
}
const raws = new WeakMap<object, { inputs: string; raw: Record<string, unknown> }>();

/** How long the first machine's scan is taken as away once it was (hereScan): as long as its node list is (comfy.ts). */
const HERE_AWAY_MS = 15_000;
const awayScans = new WeakMap<Comfy, number>();

/**
 * The first machine's scan, as a graph built for another machine reads it (this PC's files, sent from here). Away, it is not
 * asked again for HERE_AWAY_MS: a scan that found its ComfyUI away is not kept (comfy.ts), and each waiting job on each
 * machine asked it again, five seconds each for one that accepts and never answers.
 */
async function hereScan(core: QueueCore): Promise<Scan | null> {
  const comfy = await core.comfy();
  const away = awayScans.get(comfy);
  if (away !== undefined && Date.now() - away < HERE_AWAY_MS) return null;
  const got = await comfy.scan().catch(() => null);
  if (got?.comfy.online) awayScans.delete(comfy);
  else awayScans.set(comfy, Date.now());
  return got;
}

/** What a job's graph on a machine is kept by (graphOn): all it depends on, and the same but its machine's scan time (none: not kept so). */
interface Keys {
  key: string;
  stable: string;
}

function keep(keys: Keys, value: Loaded | null) {
  kept.set(keys.key, value);
  if (keys.stable) stable.set(keys.stable, { at: Date.now(), loaded: value });
}

