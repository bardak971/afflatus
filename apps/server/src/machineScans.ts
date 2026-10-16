import type { RecipeStatus, Scan } from "@afflatus/comfy";
import { folderOfFileInput, isShown, packOfNode, type LoraValue, type Recipe } from "@afflatus/core";
import type { Machine, Settings } from "./settings";

/**
 * Whether a family is on for one machine: switched there by hand, else by the switch of every machine, else by its files
 * there (`found`: one of its recipes is ready on it). The same rule as the page's (web machines.ts familyOnFor).
 */
export function familyOn(settings: Pick<Settings, "families">, machine: Pick<Machine, "families">, family: string, found: boolean): boolean {
  return machine.families[family] ?? settings.families[family] ?? found;
}

/** Whether a family has a recipe ready in a machine's scan. */
const foundIn = (scan: Scan, family: string, recipeFamily: (id: string) => string | undefined) =>
  scan.recipes.some((r) => r.ready && recipeFamily(r.id) === family);

/** A list of what the inputs offer, each file once, in the order the machines list them. */
function union(lists: Array<Record<string, string[]>>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const list of lists) for (const [k, v] of Object.entries(list)) out[k] = [...new Set([...(out[k] ?? []), ...v])];
  return out;
}

/**
 * What every machine together can do, for the lists to choose from (Studio, a clip's model): a recipe is ready when it is
 * ready on a machine where its family is on, and offers the files of all of those machines; one ready nowhere says what the
 * first machine where it is on lacks. A family's files are those of the first machine that has them all. ComfyUI's state is
 * the first machine's that answers. One machine: its own scan, unchanged.
 */
export function mergeScans(scans: Array<{ machine: Machine; scan: Scan }>, settings: Pick<Settings, "families">, recipeFamily: (id: string) => string | undefined): Scan {
  const online = scans.filter((x) => x.scan.comfy.online);
  if (scans.length === 1 || online.length === 0) return scans[0]!.scan;
  if (online.length === 1) return online[0]!.scan;
  const base = online[0]!.scan;
  const onFor = (family: string) => online.filter((x) => familyOn(settings, x.machine, family, foundIn(x.scan, family, recipeFamily)));
  const recipes = base.recipes.map((r): RecipeStatus => {
    const family = recipeFamily(r.id);
    const where = family ? onFor(family) : online;
    const statuses = where.map((x) => x.scan.recipes.find((y) => y.id === r.id)).filter((y): y is RecipeStatus => Boolean(y));
    const ready = statuses.filter((y) => y.ready);
    if (!ready.length) return statuses[0] ?? r;
    return { ...ready[0]!, options: union(ready.map((y) => y.options)) };
  });
  const families = base.families.map((f) => {
    const whole = onFor(f.id).map((x) => x.scan.families.find((y) => y.id === f.id)).find((y) => y && y.slots.every((s) => s.optional || s.file));
    return whole ?? f;
  });
  return { ...base, recipes, families };
}

/**
 * The model files and LoRAs a job asks for, by input, with the folder each goes in: what a machine must list for the job to
 * run there. A choice among a model folder's files (a hires upscaler, a detector, a ControlNet: its options read from a
 * loader node's file input) asks for the file chosen, while that choice is in play: a pod planned for an SDXL job with hires
 * fix fetched its checkpoint, text encoder and VAE, and every render then failed for the upscaler it was never sent. Its
 * own options (`extra`: "Latent", "Same as the first pass") name no file.
 */
export function filesAsked(recipe: Pick<Recipe<any>, "inputs">, input: Record<string, unknown>): Array<{ input: string; file: string; folder: string }> {
  return recipe.inputs.flatMap((i) => {
    const v = input[i.id];
    if (i.type === "model" && typeof v === "string" && v) return [{ input: i.id, file: v, folder: i.folder }];
    if (i.type === "loras" && Array.isArray(v)) return (v as LoraValue[]).filter((l) => l?.file).map((l) => ({ input: i.id, file: l.file, folder: "loras" }));
    if (i.type === "choice" && !Array.isArray(i.options) && typeof v === "string" && v && !i.extra?.includes(v) && isShown(i, input, recipe.inputs)) {
      const folder = folderOfFileInput(i.options.node, i.options.input);
      if (folder) return [{ input: i.id, file: v, folder }];
    }
    return [];
  });
}

/**
 * Whether a family file (a slot) is the job's own pick: an input that stands for it names a file, or, for an input that
 * names no slot (SDXL's checkpoint, picked per render), the slot is the family's only required one in that input's folder.
 * Such a slot is filled by the file the job asks for, never by the family's usual file.
 */
function pickedFor(recipe: Pick<Recipe<any>, "inputs" | "needs">, input: Record<string, unknown>, slot: { id: string; folder: string }, slots: Array<{ id: string; folder: string; optional?: boolean }>): boolean {
  const required = slots.filter((x) => x.folder === slot.folder && (!x.optional || recipe.needs?.includes(x.id)));
  return recipe.inputs.some((i) => i.type === "model" && Boolean(input[i.id]) && (i.slot === slot.id || (!i.slot && i.folder === slot.folder && required.length === 1 && required[0]!.id === slot.id)));
}

/** A family's files found on a machine, by slot: what a build reads for a model left out of the form. */
const slotFilesOf = (slots: Array<{ id: string; file?: string | null }>): Record<string, string> =>
  Object.fromEntries(slots.flatMap((x) => (x.file ? [[x.id, x.file]] : [])));

/**
 * Every model file a job uses, as a machine that has none of them would need them (a pod just deployed): the files its
 * inputs name and its family's files its recipe needs, as `scan` (this computer's) finds them, else the family's usual one.
 */
export function filesUsed(recipe: Pick<Recipe<any>, "family" | "inputs" | "needs" | "needsWith">, input: Record<string, unknown>, scan: Scan | null, slots: Array<{ id: string; folder: string; optional?: boolean; get?: { file: string; url: string } }>): Array<{ file: string; folder: string; url?: string }> {
  const out: Array<{ file: string; folder: string; url?: string }> = filesAsked(recipe, input).map(({ file, folder }) => ({ file, folder }));
  const found = scan?.families.find((f) => f.id === recipe.family)?.slots ?? [];
  const asks = recipe.needsWith?.(input, slotFilesOf(found)) ?? [];
  for (const slot of slots) {
    // a slot the job's own pick fills is that file, asked above
    if ((slot.optional && !recipe.needs?.includes(slot.id) && !asks.includes(slot.id)) || pickedFor(recipe, input, slot, slots)) continue;
    const file = found.find((x) => x.id === slot.id)?.file ?? slot.get?.file;
    if (file) out.push({ file, folder: slot.folder, ...(slot.get && slot.get.file === file ? { url: slot.get.url } : {}) });
  }
  return out.filter((f, i) => out.findIndex((g) => g.file === f.file && g.folder === f.folder) === i);
}

/** What keeps a job off a machine: its family switched off there, and the files it lacks there (with where to get each, when known). */
export interface Lack {
  off: boolean;
  files: Array<{ file: string; folder: string; url?: string }>;
  /**
   * What it lacks there can all be sent to it: its files, and the node packs (known ones, `packs`) of the node types it
   * lacks; with them there, it runs (nothing else refused, no other input with nothing to pick). A rented pod can be sent
   * them (podFiles.ts).
   */
  sendable: boolean;
  /** The node packs it lacks there, by their name in ComfyUI-Manager's list (core packs.ts), when every node it lacks is of one. */
  packs?: string[];
  /**
   * A rented pod whose RunPod balance runs out before this job would end there: how long it lasts, and what the job needs
   * of it (ms: its files still to come and its forecast, half again while the forecast rests on too little; rented.ts runwayNeed).
   */
  balance?: { leftMs: number; needMs: number };
  /** A rented pod its files cannot reach: why (one failed there, or was left out at its deploy). */
  failed?: string;
  /** Not sendable (and not off): what keeps it from being sent there, in a few words. */
  why?: string;
}

/**
 * What keeps a job off a machine, from that machine's scan, or null when it can run there: its recipe ready there, its
 * family on there, and the model files and LoRAs it asks for in that machine's lists (an input the scan does not list is
 * not held against it). A recipe not ready for another reason (a custom node missing) lacks no file but is kept off all the same.
 */
export function lackOn(recipe: Pick<Recipe<any>, "id" | "family" | "inputs" | "needs" | "needsWith">, input: Record<string, unknown>, scan: Scan, settings: Pick<Settings, "families">, machine: Pick<Machine, "families">, recipeFamily: (id: string) => string | undefined): Lack | null {
  const status = scan.recipes.find((r) => r.id === recipe.id);
  const on = familyOn(settings, machine, recipe.family, foundIn(scan, recipe.family, recipeFamily));
  // "off" is said only of a family switched off by hand (there, or on every machine): one off because its files are not
  // there is said by the files it lacks
  const off = !on && (machine.families[recipe.family] ?? settings.families[recipe.family]) === false;
  const wanted = filesAsked(recipe, input);
  const asked = wanted.filter(({ input: id, file }) => status?.options[id] && !status.options[id]!.includes(file));
  const slots = scan.families.find((f) => f.id === recipe.family)?.slots ?? [];
  // the family's files this input asks for (Turbo's LoRAs): without them it would run, but not as asked. A model left
  // out of the form is the family's file there, as the build loads it (a distilled one asks for no turbo LoRA)
  const asks = recipe.needsWith?.(input, slotFilesOf(slots)) ?? [];
  const lacking = slots.filter((x) => asks.includes(x.id) && !x.file);
  if (status?.ready && on && !asked.length && !lacking.length) return null;
  // a family file the job's own pick fills is not asked for as the family's usual file (a pod would fetch a model it never uses)
  const files = [
    ...slots.filter((x) => status?.missingSlots.includes(x.id) && x.get && !pickedFor(recipe, input, x, slots)).map((x) => ({ file: x.get!.file, folder: x.folder, url: x.get!.url })),
    ...(status?.missing ?? []).flatMap((m) => (m.folder ? [{ file: m.file, folder: m.folder, ...(m.url ? { url: m.url } : {}) }] : [])),
    ...asked.map(({ file, folder }) => ({ file, folder })),
    ...lacking.flatMap((x) => (x.get ? [{ file: x.get.file, folder: x.folder, url: x.get.url }] : [])),
  ];
  const unique = files.filter((f, i) => files.findIndex((g) => g.file === f.file && g.folder === f.folder) === i);
  // with these files there it runs: a family file missing is one of them (its usual file) or the file of an input that
  // stands for it, an input with nothing to pick is filled by a file it asks for (any other, a choice among files no job
  // names, is not), and nothing else keeps it from running. A family switched off by hand is never sent files.
  const filled = new Set(wanted.map((w) => w.input));
  const slotFilled = (id: string) => slots.some((x) => x.id === id && (x.get || pickedFor(recipe, input, x, slots))) || recipe.inputs.some((i) => i.type === "model" && i.slot === id && filled.has(i.id));
  // the node types it lacks, each of a pack Afflatus knows (its own pack is never missing on a pod: the image has it)
  const packs = [...new Set((status?.missingNodes ?? []).map((n) => packOfNode(n)))];
  const knownPacks = packs.every((p) => p && !p.own) ? packs.map((p) => p!.name) : null;
  // a file of its own (an imported workflow's) whose model folder is not known cannot be sent: it is not among the files
  const sendable = Boolean(status) && !off && (unique.length > 0 || Boolean(knownPacks?.length)) && knownPacks !== null && !status!.problems.length
    && status!.missing.every((m) => m.folder)
    && status!.emptyInputs.every((id) => filled.has(id)) && status!.missingSlots.every(slotFilled) && lacking.every((x) => x.get);
  const why = sendable || off ? null : lacking.find((x) => !x.get) ? `its ${lacking.find((x) => !x.get)!.label ?? "family"} file is not there, and no download is known for it` : unsendable(status, knownPacks, filled, slotFilled);
  return { off, files: unique, sendable, ...(knownPacks?.length ? { packs: knownPacks } : {}), ...(why ? { why } : {}) };
}

/**
 * Why a job cannot be sent to a machine to get what it lacks there, in a few words: the queue says it beside the job (a
 * pod that would not take one said only "waits for" the paused PC, and nobody could tell what kept it off the pod).
 */
function unsendable(status: RecipeStatus | undefined, knownPacks: string[] | null, filled: Set<string>, slotFilled: (id: string) => boolean): string {
  if (!status) return "its ComfyUI was not read yet";
  if (knownPacks === null) {
    const unknown = status.missingNodes.filter((n) => packOfNode(n)?.own !== false);
    return `its ComfyUI lacks ${unknown.slice(0, 3).join(", ")}${unknown.length > 3 ? "…" : ""}, of no node pack Afflatus can install`;
  }
  if (status.problems.length) return `its ComfyUI refuses it: ${status.problems[0]}`;
  const noFolder = status.missing.find((m) => !m.folder);
  if (noFolder) return `${noFolder.file} has no model folder Afflatus knows`;
  const empty = status.emptyInputs.find((id) => !filled.has(id));
  if (empty) return `nothing there to pick for its ${empty}`;
  const slot = status.missingSlots.find((id) => !slotFilled(id));
  if (slot) return `no download known for its ${slot} file`;
  return "nothing it lacks there can be sent";
}
